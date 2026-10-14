//! topcoat candidate: server-rendered, filtered on the server, top of the list only.
//!
//! The list is a shard that owns the filter signals and a `limit`. A filter change or a scroll
//! near the bottom re-renders the shard on the server. Its rows sit in a `live!` region that stays
//! connected over topcoat's WebSocket and re-emits when a webhook or write lands. Detail is a
//! second shard keyed by the open issue id.

mod db;

use std::time::Duration;

use db::{Db, Filter};
use topcoat::{
    Result,
    asset::{AssetBundle, RouterBuilderAssetExt, asset},
    context::{Cx, app_context},
    router::{RouterBuilderDiscoverExt, Slot, StatusCode, content::Json, layout, module_router, page, request::headers, route},
    runtime::{Event, RouterBuilderRuntimeExt, Signal, connected, procedure, shard, signal},
    view::{View, emit, live, view},
};

const CHUNK: usize = 20;

struct Latency(Duration);

#[tokio::main]
async fn main() {
    let path = std::env::var("MIRROR_PATH").unwrap_or_else(|_| "/data/mirror.db".into());
    let latency = std::env::var("GITHUB_LATENCY_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(300);
    let router = module_router!()
        .discover()
        .app_context(Db::open(&path).expect("open mirror"))
        .app_context(Latency(Duration::from_millis(latency)))
        .assets(AssetBundle::load().unwrap())
        .runtime()
        .build();
    topcoat::start(router).await.unwrap();
}

#[layout]
async fn root_layout(slot: Slot<'_>) -> Result<impl View> {
    Ok(view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>"beghu bench: topcoat"</title>
                <link rel="stylesheet" href=(asset!("./app.css"))>
                topcoat::runtime::script()
            </head>
            <body>(slot)</body>
        </html>
    })
}

#[route(GET "/healthz")]
async fn healthz() -> Result<&'static str> {
    Ok("ok")
}

#[route(POST "/webhook")]
async fn webhook(cx: &Cx, Json(payload): Json<serde_json::Value>) -> Result<StatusCode> {
    let event = headers(cx).get("x-github-event").and_then(|v| v.to_str().ok()).unwrap_or_default();
    app_context::<Db>(cx).webhook(event, &payload)?;
    Ok(StatusCode::ACCEPTED)
}

#[page]
async fn home(cx: &Cx) -> Result<impl View> {
    let open = signal(cx, || None::<i64>);
    Ok(view! {
        <main class="app">
            issue_list(open: open.clone())
            issue_detail(id: $(open.get()))
        </main>
    })
}

#[shard("/shards/list")]
async fn issue_list(cx: &Cx, open: Signal<Option<i64>>) -> Result<impl View> {
    let db = app_context::<Db>(cx);
    let state = signal(cx, || "open".to_owned());
    let q = signal(cx, String::new);
    let limit = signal(cx, || CHUNK);
    // Flips to true in the browser once the runtime has hydrated the shard.
    let hydrated = signal(cx, || false);
    let labels: Vec<_> = db.labels.iter().map(|l| (l.clone(), signal(&cx.keyed(l.as_str()), || false))).collect();
    let assignees: Vec<_> = db.assignees.iter().map(|a| (a.clone(), signal(&cx.keyed(a.as_str()), || false))).collect();

    // Signal values come back from the browser: validate them.
    let filter = Filter {
        state: if state.get() == "closed" { "closed".into() } else { "open".into() },
        labels: labels.iter().filter(|(_, s)| s.get()).map(|(l, _)| l.clone()).collect(),
        assignees: assignees.iter().filter(|(_, s)| s.get()).map(|(a, _)| a.clone()).collect(),
        q: q.get().chars().take(200).collect(),
    };
    let limit_n = limit.get().clamp(CHUNK, 5_000);
    let q_value = filter.q.clone();
    let current_state = filter.state.clone();

    Ok(view! {
        <header class="filters">
            <div class="chips">
                for s in ["open", "closed"] {
                    <button
                        data-bench="filter-state"
                        data-value=(s)
                        aria-pressed=(if current_state == s { "true" } else { "false" })
                        @click=$(|_e| state.set(s.to_owned()))
                    >(s)</button>
                }
                <input
                    data-bench="search"
                    type="search"
                    placeholder="Search titles"
                    autocomplete="off"
                    value=(q_value)
                    @input=$(|e: Event| q.set(e.target.value))
                >
            </div>
            <div class="chips">
                for (name, on) in labels.iter().cloned() {
                    <button
                        data-bench="filter-label"
                        data-value=(name.clone())
                        aria-pressed=(if on.get_untracked() { "true" } else { "false" })
                        @click=$(|_e| on.toggle())
                    >(name)</button>
                }
            </div>
            <div class="chips">
                for (login, on) in assignees.iter().cloned() {
                    <button
                        data-bench="filter-assignee"
                        data-value=(login.clone())
                        aria-pressed=(if on.get_untracked() { "true" } else { "false" })
                        @click=$(|_e| on.toggle())
                    >"@" (login)</button>
                }
            </div>
        </header>
        <span hidden="" :data-hydrated=$({ let h = hydrated.get(); raw!("(${h}, true)", h) })></span>
        (live! {
            let mut changes = db.subscribe();
            loop {
                let page = db.list(&filter, limit_n)?;
                let total = page.total;
                let token = emit! {
                    <section class="list-pane">
                        <p class="count">
                            (page.rows.len().min(total)) " of " (total)
                        </p>
                        <ul
                            data-bench="list"
                            data-bench-empty=(total == 0)
                            data-limit=(limit_n)
                            data-total=(total)
                            :data-bench-ready=$({ let h = hydrated.get(); raw!("(${h}, true)", h) })
                            @scroll=$(|_e| {
                                // A plain JS boolean has no `dehydrate()`; `if` needs a runtime value.
                                if raw!("cx.hydrate((l => l.scrollTop + l.clientHeight > l.scrollHeight - 1500 && l.querySelectorAll('[data-bench=row]').length >= +l.dataset.limit && +l.dataset.limit < +l.dataset.total)(document.querySelector('[data-bench=list]')))", false) {
                                    limit.set(limit.get() + 20)
                                }
                            })
                        >
                            for row in page.rows {
                                let id = row.id;
                                <li id=(format!("i{id}")) data-bench="row" data-id=(id) @click=$(|_e| open.set(Some(id)))>
                                    <span class="repo">(row.repo) "#" (row.number)</span>
                                    <span data-bench="title">(row.title)</span>
                                    <span class="meta">
                                        for l in row.labels { <span class="label">(l)</span> }
                                        for a in row.assignees { " @" (a) }
                                        if row.comments > 0 { " 💬" (row.comments) }
                                    </span>
                                </li>
                            }
                        </ul>
                    </section>
                }?;
                if !connected(cx) {
                    break Ok(token);
                }
                // Lagged just means "something changed"; re-render either way.
                let _ = changes.recv().await;
            }
        })
    })
}

#[shard("/shards/detail")]
async fn issue_detail(cx: &Cx, id: Option<i64>) -> Result<impl View> {
    let db = app_context::<Db>(cx);
    let first = match id {
        Some(id) => db.detail(id)?,
        None => None,
    };
    let id = first.as_ref().map_or(0, |d| d.id);
    // One optimistic flag per label this issue can gain, keyed by issue and label so a flag
    // never carries over to another issue.
    let added: Vec<_> = first
        .iter()
        .flat_map(|d| d.repo_labels.iter().filter(|l| !d.labels.contains(l)))
        .map(|l| (l.clone(), signal(&cx.keyed((id, l.as_str())), || false)))
        .collect();

    Ok(view! {
        <aside class="detail-pane">
            if first.is_none() {
                <p class="empty">"Pick an issue."</p>
            } else {
            (live! {
                let mut changes = db.subscribe();
                let mut d = first;
                loop {
                    let Some(detail) = d.take().map_or_else(|| db.detail(id), |d| Ok(Some(d)))? else {
                        break emit! { <p>"Gone."</p> };
                    };
                    let token = emit! {
                        <article data-bench="detail" data-id=(id)>
                            <h2><span class="repo">(detail.repo) "#" (detail.number) " "</span>(detail.title)</h2>
                            <p class="meta">(detail.state)</p>
                            <div class="chips">
                                for l in detail.labels.iter() {
                                    <span class="label" data-bench="label" data-value=(l.clone())>(l.clone())</span>
                                }
                                // Optimistic chips: present but inert until their flag flips.
                                for (name, on) in added.iter().filter(|(n, _)| !detail.labels.contains(n)) {
                                    <span
                                        class="label pending"
                                        data-value=(name.clone())
                                        :data-bench=$(if on.get() { "label" } else { "label-hidden" })
                                        :hidden=$(!on.get())
                                    >(name.clone())</span>
                                }
                            </div>
                            <div class="chips add">
                                "Add: "
                                for (name, on) in added.iter().filter(|(n, _)| !detail.labels.contains(n)) {
                                    let name = name.clone();
                                    let on = on.clone();
                                    <button
                                        data-bench="add-label"
                                        data-value=(name.clone())
                                        :hidden=$(on.get())
                                        @click=$(async |_e| {
                                            on.set(true);
                                            let ok = add_label(id, name.clone()).await;
                                            if !ok {
                                                on.set(false);
                                            }
                                        })
                                    >(name.clone())</button>
                                }
                            </div>
                            <pre data-bench="body">(detail.body)</pre>
                            for c in detail.comments {
                                <div class="comment" data-bench="comment">
                                    <div class="meta">(c.author) " · " (c.created_at)</div>
                                    <pre>(c.body)</pre>
                                </div>
                            }
                        </article>
                    }?;
                    if !connected(cx) {
                        break Ok(token);
                    }
                    loop {
                        match changes.recv().await {
                            Ok(ids) if !ids.contains(&id) => continue,
                            _ => break,
                        }
                    }
                }
            })
            }
        </aside>
    })
}

/// Adds a label, after a pause that stands in for the GitHub API call.
#[procedure]
async fn add_label(cx: &Cx, id: i64, name: String) -> Result<bool> {
    tokio::time::sleep(app_context::<Latency>(cx).0).await;
    Ok(app_context::<Db>(cx).add_label(id, &name)?)
}

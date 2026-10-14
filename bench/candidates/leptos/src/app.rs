// The UI: a filter bar, the issue list and a nested route for the open issue's detail. Rendered on
// the server, hydrated in the browser; data comes through server functions in `api`.

use crate::api::*;
use leptos::prelude::*;
use leptos_meta::{MetaTags, Stylesheet, Title, provide_meta_context};
use leptos_router::{
    components::{Outlet, ParentRoute, Route, Router, Routes},
    hooks::use_params_map,
    path,
};

const PAGE: u32 = 100;

pub fn shell(options: LeptosOptions) -> impl IntoView {
    view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <AutoReload options=options.clone() />
                <HydrationScripts options />
                <MetaTags />
            </head>
            <body>
                <App />
            </body>
        </html>
    }
}

// Ids changed on the server, pushed over server-sent events. `tick` bumps once per message.
#[derive(Clone, Copy)]
struct Live {
    tick: RwSignal<u64>,
    ids: RwSignal<Vec<i64>>,
}

#[component]
pub fn App() -> impl IntoView {
    provide_meta_context();
    let live = Live { tick: RwSignal::new(0), ids: RwSignal::new(vec![]) };
    provide_context(live);

    #[cfg(feature = "hydrate")]
    Effect::new(move |_| {
        use wasm_bindgen::{JsCast, closure::Closure};
        let source = web_sys::EventSource::new("/events").expect("EventSource");
        let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |e: web_sys::MessageEvent| {
            let data = e.data().as_string().unwrap_or_default();
            let ids = data.trim_matches(['[', ']']).split(',').filter_map(|s| s.trim().parse().ok()).collect();
            live.ids.set(ids);
            live.tick.update(|n| *n += 1);
        });
        source.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
        on_message.forget();
    });

    view! {
        <Stylesheet id="leptos" href="/pkg/bench-leptos.css" />
        <Title text="beghu bench: Leptos" />
        <Router>
            <Routes fallback=|| "Not found.">
                <ParentRoute path=path!("") view=IssuesPage>
                    <Route path=path!("") view=|| view! { <p class="empty-detail">"Pick an issue."</p> } />
                    <Route path=path!("issues/:id") view=IssueDetail />
                </ParentRoute>
            </Routes>
        </Router>
    }
}

#[component]
fn IssuesPage() -> impl IntoView {
    let live = expect_context::<Live>();
    let filter = RwSignal::new(Filter::default());
    // Pages of rows loaded so far. Each page is its own resource, so scrolling only renders the
    // new page instead of rebuilding the whole list.
    let pages = RwSignal::new(1u32);
    // A new filter starts again from the first page.
    let set_filter = move |f: &dyn Fn(&mut Filter)| {
        filter.update(|v| f(v));
        pages.set(1);
    };

    let page = move |i: u32| Resource::new(move || (filter.get(), live.tick.get()), move |(f, _)| list_issues(f, i * PAGE, PAGE));
    let first = page(0);
    let facets = Resource::new(|| (), |_| get_facets());

    let hydrated = RwSignal::new(false);
    Effect::new(move |_| hydrated.set(true));

    let list_ref = NodeRef::<leptos::html::Div>::new();
    let on_scroll = move |_| {
        let Some(el) = list_ref.get() else { return };
        if el.scroll_top() + el.client_height() < el.scroll_height() - 1500 {
            return;
        }
        // Only ask for another page once the last one came back full.
        if el.child_element_count() >= pages.get_untracked() * PAGE {
            pages.update(|p| *p += 1);
        }
    };
    let empty = move || matches!(first.get(), Some(Ok(v)) if v.is_empty());

    let state_button = move |closed: bool| {
        let name = if closed { "closed" } else { "open" };
        view! {
            <button
                data-bench="filter-state"
                data-value=name
                aria-pressed=move || filter.with(|f| f.closed == closed).to_string()
                on:click=move |_| set_filter(&|f| f.closed = closed)
            >
                {name}
            </button>
        }
    };

    view! {
        <header>
            <div class="chips">{state_button(false)} {state_button(true)}</div>
            <input
                data-bench="search"
                type="search"
                placeholder="Search titles"
                autocomplete="off"
                prop:value=move || filter.with(|f| f.q.clone())
                on:input=move |ev| {
                    let q = event_target_value(&ev);
                    set_filter(&|f| f.q = q.clone())
                }
            />
            <Suspense>
                {move || Suspend::new(async move {
                    let facets = facets.await.ok()?;
                    let chip = move |value: String, assignee: bool| {
                        let on = {
                            let value = value.clone();
                            move || filter.with(|f| if assignee { &f.assignees } else { &f.labels }.contains(&value))
                        };
                        let toggle = {
                            let value = value.clone();
                            move |_| {
                                set_filter(&|f| {
                                    let set = if assignee { &mut f.assignees } else { &mut f.labels };
                                    if let Some(i) = set.iter().position(|v| *v == value) {
                                        set.remove(i);
                                    } else {
                                        set.push(value.clone());
                                    }
                                })
                            }
                        };
                        let text = if assignee { format!("@{value}") } else { value.clone() };
                        view! {
                            <button
                                data-bench=if assignee { "filter-assignee" } else { "filter-label" }
                                data-value=value
                                aria-pressed=move || on().to_string()
                                on:click=toggle
                            >
                                {text}
                            </button>
                        }
                    };
                    Some(view! {
                        <div class="chips">{facets.labels.into_iter().map(|l| chip(l, false)).collect_view()}</div>
                        <div class="chips">{facets.assignees.into_iter().map(|a| chip(a, true)).collect_view()}</div>
                    })
                })}
            </Suspense>
        </header>
        <main>
            <div
                class="list"
                data-bench="list"
                node_ref=list_ref
                on:scroll=on_scroll
                data-bench-ready=move || hydrated.get().then_some("")
                data-bench-empty=move || empty().then_some("")
            >
                <For
                    each=move || 0..pages.get()
                    key=|i| *i
                    children=move |i| view! { <Page rows=if i == 0 { first } else { page(i) } /> }
                />
            </div>
            <section class="detail">
                <Outlet />
            </section>
        </main>
    }
}

#[component]
fn Page(rows: Resource<Result<Vec<Row>, ServerFnError>>) -> impl IntoView {
    view! {
        <Transition>
            {move || Suspend::new(async move {
                let rows = rows.await.unwrap_or_default();
                view! {
                    // Keyed on updated_at too, so an edited row re-renders.
                    <For each=move || rows.clone() key=|r| (r.id, r.updated_at.clone()) children=row_view />
                }
            })}
        </Transition>
    }
}

fn row_view(r: Row) -> impl IntoView {
    view! {
        <a class="row" data-bench="row" data-id=r.id.to_string() href=format!("/issues/{}", r.id)>
            <span class="repo">{format!("{}#{}", r.repo, r.number)}</span>
            <span class="title" data-bench="title">{r.title}</span>
            <span class="row-labels">
                {r.labels.into_iter().map(|l| view! { <span class="chip">{l.name}</span> }).collect_view()}
            </span>
        </a>
    }
}

#[component]
fn IssueDetail() -> impl IntoView {
    let live = expect_context::<Live>();
    let params = use_params_map();
    let id = Memo::new(move |_| params.with(|p| p.get("id").and_then(|v| v.parse::<i64>().ok()).unwrap_or_default()));
    let detail = Resource::new(move || id.get(), get_detail);

    // Refetch when a live change touches the open issue.
    Effect::watch(
        move || live.tick.get(),
        move |_, _, _| {
            if live.ids.with_untracked(|ids| ids.contains(&id.get_untracked())) {
                detail.refetch();
            }
        },
        false,
    );

    // Labels added here but not yet confirmed by the server: shown at once, dropped on error.
    let add = ServerAction::<AddLabel>::new();
    let pending = RwSignal::new(Vec::<Label>::new());
    Effect::watch(move || id.get(), move |_, _, _| pending.set(vec![]), false);
    Effect::new(move |_| {
        if let Some(Err(_)) = add.value().get() {
            pending.set(vec![]);
        }
    });

    view! {
        <Transition fallback=|| view! { <p class="empty-detail">"Loading…"</p> }>
            {move || Suspend::new(async move {
                let Some(d) = detail.await.ok().flatten() else {
                    return view! { <p class="empty-detail">"Not found."</p> }.into_any();
                };
                let id = d.row.id;
                let server_labels = d.row.labels.clone();
                let labels = Memo::new(move |_| {
                    let mut v = server_labels.clone();
                    pending.with(|p| v.extend(p.iter().filter(|l| !server_labels.contains(l)).cloned()));
                    v
                });
                let repo_labels = d.repo_labels;
                view! {
                    <article data-bench="detail" data-id=id.to_string()>
                        <h2>
                            <span class="repo">{format!("{}#{} ", d.row.repo, d.row.number)}</span>
                            {d.row.title}
                        </h2>
                        <div class="chips">
                            <For
                                each=move || labels.get()
                                key=|l| l.name.clone()
                                children=|l| {
                                    let text = l.name.clone();
                                    view! { <span class="chip" data-bench="label" data-value=l.name>{text}</span> }
                                }
                            />
                        </div>
                        <div class="chips add">
                            "Add: "
                            {move || {
                                repo_labels
                                    .iter()
                                    .filter(|l| !labels.with(|have| have.contains(l)))
                                    .cloned()
                                    .map(|l| {
                                        let name = l.name.clone();
                                        let text = l.name.clone();
                                        view! {
                                            <button
                                                data-bench="add-label"
                                                data-value=name
                                                on:click=move |_| {
                                                    pending.update(|p| p.push(l.clone()));
                                                    add.dispatch(AddLabel { id, name: l.name.clone() });
                                                }
                                            >
                                                {text}
                                            </button>
                                        }
                                    })
                                    .collect_view()
                            }}
                        </div>
                        <pre data-bench="body">{d.body}</pre>
                        {d
                            .comments
                            .into_iter()
                            .map(|c| {
                                view! {
                                    <div class="comment" data-bench="comment">
                                        <div class="meta">{c.author.unwrap_or_default()} " · " {c.created_at}</div>
                                        <pre>{c.body}</pre>
                                    </div>
                                }
                            })
                            .collect_view()}
                    </article>
                }
                    .into_any()
            })}
        </Transition>
    }
}

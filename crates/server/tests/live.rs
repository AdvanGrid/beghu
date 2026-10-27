//! Webhooks in, live pushes out: a change on GitHub reaches the mirrors of the accounts that sync
//! its repo and their open streams, guarded by `updated_at`, deduped by delivery, and resumed
//! after a restart. Changes come from Fake GitHub's outside edits (with its real, signed
//! webhooks) or from deliveries the test signs and posts itself.

mod common;

use common::{Browser, Sse, Stack, WriteLock, ids_of, start, start_with};
use serde_json::{Value, json};
use std::time::Duration;

const SECS: Duration = Duration::from_secs(1);

/// The top row of `b`'s list.
async fn top(s: &Stack, b: &mut Browser) -> Value {
    let (_, page) = s.api(b, "/api/issues").await;
    page["rows"][0].clone()
}

fn row(page: &Value, id: i64) -> Option<&Value> {
    page["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == id)
}

/// The id of the synced repo called `name`.
async fn repo_id(s: &Stack, b: &mut Browser, name: &str) -> i64 {
    let (_, me) = s.api(b, "/api/me").await;
    me["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == name)
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

/// An `issues` delivery for `r` (a list row) as GitHub would send it, with `title` at `updated_at`.
fn issues_payload(action: &str, repo: i64, r: &Value, title: &str, updated_at: &str) -> Value {
    json!({
        "action": action,
        "issue": {
            "id": r["id"], "node_id": "I_test", "number": r["number"], "title": title,
            "body": "", "state": "open", "state_reason": null, "locked": false,
            "user": { "id": 1, "login": "someone", "avatar_url": null },
            "labels": [], "assignees": [], "milestone": null, "comments": 0,
            "created_at": "2025-01-01T00:00:00Z", "updated_at": updated_at, "closed_at": null,
        },
        "repository": { "id": repo, "name": r["repo"], "full_name": format!("acme/{}", r["repo"].as_str().unwrap()) },
        "installation": { "id": 41000001 },
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn an_outside_edit_reaches_the_list_and_the_streams_of_every_account_syncing_the_repo() {
    let s = start().await;
    let mut owner = s.sign_in("tomsj").await;
    let member = s.sign_in("ilze-k").await;
    // Sees `web` but syncs nothing (no mirror of its own yet).
    let outsider = s.sign_in("octo-ext").await;
    let mut streams = Vec::new();
    for b in [&owner, &member, &outsider] {
        let mut st = s.stream(b).await;
        // Every stream opens with a reset.
        st.reset().await;
        streams.push(st);
    }

    // The tenth row, so the edit visibly moves it to the top.
    let (_, page) = s.api(&mut owner, "/api/issues").await;
    let r = page["rows"][9].clone();
    let id = r["id"].as_i64().unwrap();
    s.edit(json!({
        "repo": r["repo"], "number": r["number"], "as": "ilze-k",
        "title": "Retitled by an agent with gh", "add_labels": ["bug"],
    }))
    .await;

    // One delivery per action (edited, labeled): one push per delivery, naming the issue.
    for st in &mut streams[..2] {
        let ev = st.event_within(4 * SECS).await.expect("an ids push");
        assert_eq!(ids_of(&ev), [id]);
    }
    let page = s
        .until_list(&mut owner, 3, |p| p["rows"][0]["id"] == id)
        .await;
    let now = &page["rows"][0];
    assert_eq!(now["title"], "Retitled by an agent with gh");
    assert!(
        now["labels"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l["name"] == "bug")
    );
    assert!(now["updated_at"].as_i64() > r["updated_at"].as_i64());

    // The account that doesn't sync the repo hears nothing.
    assert_eq!(streams[2].events_for(SECS).await, Vec::<Sse>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_comment_bumps_its_issues_count_and_pushes_the_issue() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let r = top(&s, &mut b).await;
    let id = r["id"].as_i64().unwrap();
    s.edit(json!({ "repo": r["repo"], "number": r["number"], "comment": "On it." }))
        .await;
    assert_eq!(ids_of(&st.event_within(4 * SECS).await.unwrap()), [id]);
    let page = s
        .until_list(&mut b, 3, |p| p["rows"][0]["comments"] != r["comments"])
        .await;
    assert_eq!(
        page["rows"][0]["comments"].as_i64(),
        Some(r["comments"].as_i64().unwrap() + 1)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_replayed_delivery_changes_nothing_and_pushes_nothing() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let r = top(&s, &mut b).await;
    let id = r["id"].as_i64().unwrap();
    let repo = repo_id(&s, &mut b, r["repo"].as_str().unwrap()).await;

    let first = issues_payload("edited", repo, &r, "first", "2030-01-01T00:00:00Z");
    assert_eq!(s.deliver("issues", "guid-1", &first).await, 202);
    assert_eq!(ids_of(&st.event_within(2 * SECS).await.unwrap()), [id]);
    let second = issues_payload("edited", repo, &r, "second", "2030-01-01T00:01:00Z");
    assert_eq!(s.deliver("issues", "guid-2", &second).await, 202);
    assert_eq!(ids_of(&st.event_within(2 * SECS).await.unwrap()), [id]);

    // GitHub redelivers both: each is acked as already seen and applies nothing.
    assert_eq!(s.deliver("issues", "guid-1", &first).await, 200);
    assert_eq!(s.deliver("issues", "guid-2", &second).await, 200);
    assert_eq!(st.events_for(SECS).await, Vec::<Sse>::new());
    assert_eq!(
        row(&s.api(&mut b, "/api/issues").await.1, id).unwrap()["title"],
        "second"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_duplicated_webhook_from_github_is_applied_and_pushed_once() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let r = top(&s, &mut b).await;
    s.fake("POST", "/faults/webhooks", json!({ "duplicate": 1 }))
        .await;
    s.edit(json!({ "repo": r["repo"], "number": r["number"], "title": "Sent twice" }))
        .await;
    let pushes = st.events_for(3 * SECS).await;
    assert_eq!(pushes.len(), 1, "{pushes:?}");
    assert_eq!(ids_of(&pushes[0]), [r["id"].as_i64().unwrap()]);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_older_updated_at_never_overwrites_a_newer_row() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let r = top(&s, &mut b).await;
    let id = r["id"].as_i64().unwrap();
    let repo = repo_id(&s, &mut b, r["repo"].as_str().unwrap()).await;

    let newer = issues_payload("edited", repo, &r, "newer", "2030-01-01T00:02:00Z");
    assert_eq!(s.deliver("issues", "newer", &newer).await, 202);
    assert_eq!(ids_of(&st.event_within(2 * SECS).await.unwrap()), [id]);
    // Delivered late, out of order: acked, but the mirror keeps the newer row.
    let older = issues_payload("edited", repo, &r, "older", "2030-01-01T00:01:00Z");
    assert_eq!(s.deliver("issues", "older", &older).await, 202);
    assert_eq!(st.events_for(SECS).await, Vec::<Sse>::new());
    assert_eq!(
        row(&s.api(&mut b, "/api/issues").await.1, id).unwrap()["title"],
        "newer"
    );

    // The same time saying something else can't be ordered: it isn't applied, and the issue is
    // read again from GitHub, whose answer (older than the deliveries' made-up time) changes
    // nothing either.
    let same = issues_payload("edited", repo, &r, "same time", "2030-01-01T00:02:00Z");
    assert_eq!(s.deliver("issues", "same", &same).await, 202);
    assert_eq!(st.events_for(3 * SECS).await, Vec::<Sse>::new());
    assert_eq!(
        row(&s.api(&mut b, "/api/issues").await.1, id).unwrap()["title"],
        "newer"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn label_and_milestone_changes_push_every_issue_they_touch() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let r = top(&s, &mut b).await;
    let id = r["id"].as_i64().unwrap();
    let repo = repo_id(&s, &mut b, r["repo"].as_str().unwrap()).await;

    let mut p = issues_payload("labeled", repo, &r, "Tagged", "2030-01-01T00:00:00Z");
    p["issue"]["labels"] = json!([{ "id": 77, "name": "triage-me", "color": "ededed" }]);
    p["issue"]["milestone"] =
        json!({ "id": 88, "number": 9, "title": "v9", "state": "open", "due_on": null });
    assert_eq!(s.deliver("issues", "g-labeled", &p).await, 202);
    assert_eq!(ids_of(&st.event_within(2 * SECS).await.unwrap()), [id]);

    // A rename bumps no issue on GitHub, but every row carrying the label reads differently.
    let label = |action: &str, name: &str| {
        json!({
            "action": action,
            "label": { "id": 77, "name": name, "color": "0e8a16", "description": null },
            "repository": { "id": repo },
        })
    };
    assert_eq!(
        s.deliver("label", "g-renamed", &label("edited", "triaged"))
            .await,
        202
    );
    assert_eq!(ids_of(&st.event_within(2 * SECS).await.unwrap()), [id]);
    let labels = row(&s.api(&mut b, "/api/issues").await.1, id).unwrap()["labels"].clone();
    assert_eq!(labels, json!([{ "name": "triaged", "color": "0e8a16" }]));
    assert_eq!(
        s.deliver("label", "g-deleted", &label("deleted", "triaged"))
            .await,
        202
    );
    assert_eq!(ids_of(&st.event_within(2 * SECS).await.unwrap()), [id]);
    let labels = row(&s.api(&mut b, "/api/issues").await.1, id).unwrap()["labels"].clone();
    assert_eq!(labels, json!([]));

    let milestone = json!({
        "action": "deleted",
        "milestone": { "id": 88, "number": 9, "title": "v9", "state": "open", "due_on": null },
        "repository": { "id": repo },
    });
    assert_eq!(s.deliver("milestone", "g-ms", &milestone).await, 202);
    assert_eq!(ids_of(&st.event_within(2 * SECS).await.unwrap()), [id]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deleted_issue_leaves_the_list() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let r = top(&s, &mut b).await;
    let id = r["id"].as_i64().unwrap();
    let repo = repo_id(&s, &mut b, r["repo"].as_str().unwrap()).await;
    let gone = issues_payload("deleted", repo, &r, "x", "2030-01-01T00:00:00Z");
    assert_eq!(s.deliver("issues", "g-del", &gone).await, 202);
    assert_eq!(ids_of(&st.event_within(2 * SECS).await.unwrap()), [id]);
    assert!(row(&s.api(&mut b, "/api/issues").await.1, id).is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_delivery_without_a_valid_signature_is_refused_and_applies_nothing() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let r = top(&s, &mut b).await;
    let repo = repo_id(&s, &mut b, r["repo"].as_str().unwrap()).await;
    let body = serde_json::to_vec(&issues_payload(
        "edited",
        repo,
        &r,
        "forged",
        "2030-01-01T00:00:00Z",
    ))
    .unwrap();
    let post = |sig: Option<String>| {
        let mut req = s
            .http
            .post(format!("{}/webhook", s.server))
            .header("x-github-event", "issues")
            .header("x-github-delivery", "forged")
            .body(body.clone());
        if let Some(sig) = sig {
            req = req.header("x-hub-signature-256", sig);
        }
        req.send()
    };
    assert_eq!(post(None).await.unwrap().status(), 401);
    let wrong = fake_github::sign_webhook("not-the-secret", &body);
    assert_eq!(post(Some(wrong)).await.unwrap().status(), 401);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(top(&s, &mut b).await["title"], r["title"]);

    // Signed, but missing which delivery it is.
    let res = s
        .http
        .post(format!("{}/webhook", s.server))
        .header(
            "x-hub-signature-256",
            fake_github::sign_webhook(common::WEBHOOK_SECRET, b"{}"),
        )
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_delivery_acked_but_not_applied_before_a_restart_is_applied_after_it() {
    let mut s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (_, me) = s.api(&mut b, "/api/me").await;
    let mirror = s
        .data
        .join("mirrors")
        .join(format!("{}.db", me["account"]["id"]));
    let r = top(&s, &mut b).await;
    let id = r["id"].as_i64().unwrap();
    let repo = repo_id(&s, &mut b, r["repo"].as_str().unwrap()).await;

    // Another writer holds the mirror, so the apply waits on it after the ack, and gives up
    // after SQLite's 5 s busy timeout: the stopped process never finishes it.
    let mut other = rusqlite::Connection::open(&mirror).unwrap();
    let lock = other
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let p = issues_payload(
        "edited",
        repo,
        &r,
        "applied after the restart",
        "2030-01-01T00:00:00Z",
    );
    assert_eq!(s.deliver("issues", "g-resume", &p).await, 202);
    let acked = std::time::Instant::now();
    // The process stops mid-apply; the new one starts while the mirror is still held.
    tokio::time::sleep(3 * SECS).await;
    s.restart_with(|_| {}).await;
    // Released once the old apply has given up, while the new one still waits.
    tokio::time::sleep(
        (acked + Duration::from_millis(5500)).saturating_duration_since(std::time::Instant::now()),
    )
    .await;
    drop(lock);

    let page = s
        .until_list(&mut b, 8, |p| {
            p["rows"][0]["title"] == "applied after the restart"
        })
        .await;
    assert_eq!(page["rows"][0]["id"], id);
    // Applied once: GitHub redelivering it now changes nothing.
    assert_eq!(s.deliver("issues", "g-resume", &p).await, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_stream_is_origin_checked_unbuffered_and_keeps_a_heartbeat() {
    let s = start_with(|c| c.stream_heartbeat = Duration::from_millis(200)).await;
    let b = s.sign_in("tomsj").await;
    let open = |origin: Option<String>| {
        let mut req = s
            .http
            .get(format!("{}/api/stream", s.server))
            .header("cookie", b.header());
        if let Some(o) = origin {
            req = req.header("origin", o);
        }
        req.send()
    };
    let res = open(Some("https://evil.example".into())).await.unwrap();
    assert_eq!(res.status(), 403);
    assert_eq!(res.json::<Value>().await.unwrap()["error"], "forbidden");
    // Signed out: no stream.
    let res = s
        .http
        .get(format!("{}/api/stream", s.server))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);

    // beghu's own origin, or none (a same-origin EventSource sends none).
    for origin in [Some(s.server.clone()), None] {
        let res = open(origin).await.unwrap();
        assert_eq!(res.status(), 200);
        let h = res.headers();
        assert_eq!(h["content-type"], "text/event-stream");
        assert_eq!(h["x-accel-buffering"], "no");
        assert_eq!(h["cache-control"], "no-store");
        assert_eq!(h["x-beghu-build"], common::BUILD);
        assert!(h.get("content-encoding").is_none());
        let mut st = common::Stream::new(res);
        assert_eq!(
            st.next_within(SECS).await,
            Some(Sse {
                event: "reset".into(),
                data: "{}".into()
            })
        );
        assert_eq!(st.next_within(SECS).await.unwrap().event, "status");
        // Then GitHub's state as it is now.
        assert_eq!(
            st.next_within(SECS).await,
            Some(Sse {
                event: "github".into(),
                data: r#"{"state":"up"}"#.into()
            })
        );
        assert_eq!(st.next_within(SECS).await.unwrap().event, ":");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_live_refetch_returns_the_list_from_the_top_through_the_last_loaded_row() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (_, p1) = s.api(&mut b, "/api/issues").await;
    let (_, p2) = s
        .api(
            &mut b,
            &format!("/api/issues?after={}", p1["next"].as_str().unwrap()),
        )
        .await;
    let loaded: Vec<Value> = [&p1, &p2]
        .iter()
        .flat_map(|p| p["rows"].as_array().unwrap().clone())
        .collect();
    let last = &loaded[149];
    let cursor = format!("updated.{}.{}", last["updated_at"], last["id"]);
    let (status, page) = s
        .api(&mut b, &format!("/api/issues?through={cursor}"))
        .await;
    assert_eq!(status, 200);
    assert_eq!(page["rows"].as_array().unwrap(), &loaded[..150]);
    // Paging on continues from where the refetch stopped.
    assert_eq!(page["next"], cursor);

    let (status, _) = s
        .api(
            &mut b,
            &format!("/api/issues?through={cursor}&after={cursor}"),
        )
        .await;
    assert_eq!(status, 400);
}

/// A view's page `url` (with `?q=` already on it), as the client asks for it.
fn with(url: &str, key: &str, cursor: &str) -> String {
    format!("{url}&{key}={cursor}")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_live_refetch_follows_the_views_filter_and_sort() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    // A filter, and a sort whose key can be NULL (uncommented rows go last both ways).
    let base = format!(
        "/api/issues?{}",
        serde_urlencoded::to_string([("q", "label:bug sort:commented-asc")]).unwrap()
    );
    let mut loaded: Vec<Value> = Vec::new();
    let mut lasts = Vec::new();
    let mut url = base.clone();
    loop {
        let (status, page) = s.api(&mut b, &url).await;
        assert_eq!(status, 200, "{page}");
        loaded.extend(page["rows"].as_array().unwrap().iter().cloned());
        lasts.push((loaded.len(), page["last"].as_str().unwrap().to_owned()));
        match page["next"].as_str() {
            // `next` is the page's last row while more follow.
            Some(next) => {
                assert_eq!(page["last"], next);
                url = with(&base, "after", next);
            }
            None => break,
        }
    }
    assert!(lasts.len() >= 2, "the view needs more than a page");
    assert!(loaded.iter().all(|r| {
        r["labels"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l["name"] == "bug")
    }));

    // Through the first page's last row: the same rows, and the list goes on after them.
    let (n, cursor) = &lasts[0];
    let (status, page) = s.api(&mut b, &with(&base, "through", cursor)).await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(page["rows"].as_array().unwrap(), &loaded[..*n]);
    assert_eq!(page["next"], *cursor);
    assert_eq!(page["last"], *cursor);

    // Through the view's last row: all of it in one request, with nothing after it.
    let (n, cursor) = lasts.last().unwrap();
    let (_, page) = s.api(&mut b, &with(&base, "through", cursor)).await;
    assert_eq!(page["rows"].as_array().unwrap(), &loaded[..*n]);
    assert_eq!(page["next"], Value::Null);

    // A change that moves a row within the sort shows in the refetch: a comment takes an
    // uncommented row (last in this sort) to just before the uncommented ones.
    let moved = loaded
        .iter()
        .find(|r| r["commented_at"].is_null())
        .expect("an uncommented bug")
        .clone();
    let mut st = s.stream(&b).await;
    st.reset().await;
    s.edit(json!({ "repo": moved["repo"], "number": moved["number"], "comment": "Seen." }))
        .await;
    assert_eq!(
        ids_of(&st.event_within(4 * SECS).await.unwrap()),
        [moved["id"].as_i64().unwrap()]
    );
    let (_, page) = s.api(&mut b, &with(&base, "through", cursor)).await;
    let rows = page["rows"].as_array().unwrap();
    let at = rows.iter().position(|r| r["id"] == moved["id"]).unwrap();
    assert!(!rows[at]["commented_at"].is_null());
    assert!(rows[at + 1..].iter().all(|r| r["commented_at"].is_null()));
    assert!(rows[..at].iter().all(|r| !r["commented_at"].is_null()));
}

/// The first page of `type:epic`.
async fn epics(s: &Stack, b: &mut Browser) -> Value {
    s.api(b, "/api/issues?q=type%3Aepic").await.1
}

#[tokio::test(flavor = "multi_thread")]
async fn a_webhook_sets_the_issue_type_and_type_filters_find_it() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    // No fixture issue has the type Epic.
    assert_eq!(epics(&s, &mut b).await["rows"], json!([]));

    // An outside edit types an issue: an `issues` `typed` delivery.
    let r = top(&s, &mut b).await;
    let id = r["id"].as_i64().unwrap();
    s.edit(json!({ "repo": r["repo"], "number": r["number"], "type": "Epic" }))
        .await;
    assert_eq!(ids_of(&st.event_within(4 * SECS).await.unwrap()), [id]);
    let page = epics(&s, &mut b).await;
    let rows = page["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{page}");
    assert_eq!(rows[0]["id"], id);
    assert_eq!(rows[0]["issue_type"], "Epic");
    // The bar offers the new type.
    let (_, facets) = s.api(&mut b, "/api/facets").await;
    assert!(
        facets["types"].as_array().unwrap().contains(&json!("Epic")),
        "{facets}"
    );

    // `untyped` clears it.
    s.edit(json!({ "repo": r["repo"], "number": r["number"], "type": null }))
        .await;
    assert_eq!(ids_of(&st.event_within(4 * SECS).await.unwrap()), [id]);
    assert_eq!(epics(&s, &mut b).await["rows"], json!([]));
    let (_, page) = s.api(&mut b, "/api/issues").await;
    assert_eq!(row(&page, id).unwrap()["issue_type"], Value::Null);

    // A payload with no `type` at all (an older one) is untyped too.
    let repo = repo_id(&s, &mut b, r["repo"].as_str().unwrap()).await;
    let mut p = issues_payload("typed", repo, &r, "Typed by hand", "2030-01-01T00:00:00Z");
    p["issue"]["type"] =
        json!({ "id": 7, "node_id": "IT_kw7", "name": "Epic", "description": null });
    assert_eq!(s.deliver("issues", "type-1", &p).await, 202);
    st.event_within(4 * SECS).await.expect("a push");
    assert_eq!(epics(&s, &mut b).await["rows"][0]["id"], id);
    let p = issues_payload("edited", repo, &r, "Edited by hand", "2030-01-01T00:00:01Z");
    assert_eq!(s.deliver("issues", "type-2", &p).await, 202);
    st.event_within(4 * SECS).await.expect("a push");
    assert_eq!(epics(&s, &mut b).await["rows"], json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_account_that_loses_access_to_a_repo_stops_getting_its_changes() {
    // Every `/api/me` re-reads the roles.
    let s = start_with(|c| c.repo_refresh_every = Duration::ZERO).await;
    let mut owner = s.sign_in("tomsj").await;
    let mut member = s.sign_in("ilze-k").await;
    let (mut owner_st, mut member_st) = (s.stream(&owner).await, s.stream(&member).await);
    owner_st.reset().await;
    member_st.reset().await;
    let r = top(&s, &mut owner).await;
    let id = r["id"].as_i64().unwrap();

    // An admin removes ilze-k from the repo on GitHub; beghu sees it at the next re-read.
    s.fake(
        "PUT",
        "/permissions",
        json!({ "login": "ilze-k", "repo": r["repo"], "role": null }),
    )
    .await;
    let (status, _) = s.api(&mut member, "/api/me").await;
    assert_eq!(status, 200);
    // The repo's rows leave ilze-k's mirror, and its tabs refetch what they show.
    member_st.reset().await;

    s.edit(json!({ "repo": r["repo"], "number": r["number"], "title": "Not for ilze-k" }))
        .await;
    assert_eq!(
        ids_of(&owner_st.event_within(4 * SECS).await.unwrap()),
        [id]
    );
    assert_eq!(member_st.events_for(SECS).await, Vec::<Sse>::new());
    // Nor is it in ilze-k's mirror any more.
    assert_eq!(row(&s.api(&mut member, "/api/issues").await.1, id), None);
}

/// The account's id, from `/api/me`.
async fn account_id(s: &Stack, b: &mut Browser) -> i64 {
    s.api(b, "/api/me").await.1["account"]["id"]
        .as_i64()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn one_accounts_failed_write_marks_it_for_resync_without_holding_up_the_others() {
    let s = start().await;
    let mut owner = s.sign_in("tomsj").await;
    let mut member = s.sign_in("ilze-k").await;
    let accounts = [
        (account_id(&s, &mut owner).await, s.stream(&owner).await),
        (account_id(&s, &mut member).await, s.stream(&member).await),
    ];
    // The failing account is the one the fan-out reaches first.
    let [(stuck_id, mut stuck), (_, mut other)] = {
        let mut a = accounts;
        a.sort_by_key(|(id, _)| *id);
        a
    };
    stuck.reset().await;
    other.reset().await;
    let mut b = owner.clone();
    let r = top(&s, &mut b).await;
    let id = r["id"].as_i64().unwrap();
    let repo = repo_id(&s, &mut b, r["repo"].as_str().unwrap()).await;

    let mirror = s.data.join("mirrors").join(format!("{stuck_id}.db"));
    let lock = WriteLock::take(&mirror);
    let first = issues_payload("edited", repo, &r, "first", "2030-01-01T00:00:00Z");
    assert_eq!(s.deliver("issues", "g-stuck-1", &first).await, 202);
    // The other account has it at once, while the stuck one waits on its mirror.
    assert_eq!(ids_of(&other.event_within(2 * SECS).await.unwrap()), [id]);
    // Its write gives up after the busy timeout, and its tabs hear that sync is degraded (the
    // account is marked for a sweep to repair); then the mirror is free again.
    let events = stuck.events_for(5 * SECS + SECS / 2).await;
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].event, "status");
    let status: Value = serde_json::from_str(&events[0].data).unwrap();
    assert_eq!(status["sync"]["degraded"], true, "{status}");
    drop(lock);

    // The stuck account's deliveries carry on.
    let second = issues_payload("edited", repo, &r, "second", "2030-01-01T00:01:00Z");
    assert_eq!(s.deliver("issues", "g-stuck-2", &second).await, 202);
    assert_eq!(ids_of(&stuck.event_within(2 * SECS).await.unwrap()), [id]);
    assert_eq!(ids_of(&other.event_within(2 * SECS).await.unwrap()), [id]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_delivery_whose_processed_mark_fails_is_marked_on_a_retry_not_reapplied_at_restart() {
    let mut s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let mirror = s
        .data
        .join("mirrors")
        .join(format!("{}.db", account_id(&s, &mut b).await));
    let r = top(&s, &mut b).await;
    let repo = repo_id(&s, &mut b, r["repo"].as_str().unwrap()).await;
    // A label delivery carries no `updated_at`: the last one applied wins, so one applied again
    // would show.
    let label = |name: &str| {
        json!({
            "action": "edited",
            "label": { "id": 9_990_001, "name": name, "color": "ededed", "description": null },
            "repository": { "id": repo },
        })
    };

    // The apply waits on the mirror until the control DB is held too, so marking the delivery
    // processed meets a busy control DB.
    let mirror_lock = WriteLock::take(&mirror);
    assert_eq!(s.deliver("label", "g-mark-1", &label("first")).await, 202);
    let control_lock = WriteLock::take(&s.control_db());
    tokio::time::sleep(Duration::from_millis(300)).await;
    drop(mirror_lock);
    assert!(st.event_within(3 * SECS).await.is_some());
    // Past the busy timeout: the first try to mark it fails.
    tokio::time::sleep(5 * SECS + SECS / 2).await;
    drop(control_lock);

    assert_eq!(s.deliver("label", "g-mark-2", &label("second")).await, 202);
    assert!(st.event_within(8 * SECS).await.is_some());
    s.restart_with(|_| {}).await;
    let (_, labels) = s.api(&mut b, &format!("/api/repos/{repo}/labels")).await;
    let names: Vec<&str> = labels
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|l| l["name"].as_str())
        .collect();
    assert!(
        names.contains(&"second") && !names.contains(&"first"),
        "{names:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn processed_deliveries_past_their_keep_are_pruned_at_startup() {
    let mut s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let r = top(&s, &mut b).await;
    let repo = repo_id(&s, &mut b, r["repo"].as_str().unwrap()).await;
    let first = issues_payload("edited", repo, &r, "first", "2030-01-01T00:00:00Z");
    let second = issues_payload("edited", repo, &r, "second", "2030-01-01T00:01:00Z");
    assert_eq!(s.deliver("issues", "g-prune-1", &first).await, 202);
    // The account's deliveries apply in order: once the second is pushed, the first is done.
    assert_eq!(s.deliver("issues", "g-prune-2", &second).await, 202);
    st.event_within(2 * SECS).await.unwrap();
    st.event_within(2 * SECS).await.unwrap();

    // Kept for the default four days, a restart still dedupes it.
    s.restart_with(|_| {}).await;
    assert_eq!(s.deliver("issues", "g-prune-1", &first).await, 200);
    // Kept for no time at all, the restart prunes it: GitHub redelivering it now is new.
    s.restart_with(|c| c.deliveries_kept_for = Duration::ZERO)
        .await;
    assert_eq!(s.deliver("issues", "g-prune-1", &first).await, 202);
}

#[tokio::test(flavor = "multi_thread")]
async fn every_open_tab_of_an_account_gets_its_pushes_as_tabs_come_and_go() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let r = top(&s, &mut b).await;
    let id = r["id"].as_i64().unwrap();
    let repo = repo_id(&s, &mut b, r["repo"].as_str().unwrap()).await;
    let mut n = 0;
    let mut change = || {
        n += 1;
        let at = format!("2030-01-01T00:{n:02}:00Z");
        (
            format!("g-tabs-{n}"),
            issues_payload("edited", repo, &r, &format!("change {n}"), &at),
        )
    };
    let open = || async {
        let mut st = s.stream(&b).await;
        st.reset().await;
        st
    };

    let (mut first, mut second) = (open().await, open().await);
    let (guid, p) = change();
    assert_eq!(s.deliver("issues", &guid, &p).await, 202);
    assert_eq!(ids_of(&first.event_within(2 * SECS).await.unwrap()), [id]);
    assert_eq!(ids_of(&second.event_within(2 * SECS).await.unwrap()), [id]);

    // One tab closes; the other still hears every change.
    drop(first);
    for _ in 0..2 {
        let (guid, p) = change();
        assert_eq!(s.deliver("issues", &guid, &p).await, 202);
        assert_eq!(ids_of(&second.event_within(2 * SECS).await.unwrap()), [id]);
    }

    // The last one closes, a change lands with no tab open, and a new tab hears the next.
    drop(second);
    let (guid, p) = change();
    assert_eq!(s.deliver("issues", &guid, &p).await, 202);
    let title = p["issue"]["title"].clone();
    s.until_list(&mut b.clone(), 3, |page| {
        row(page, id).is_some_and(|r| r["title"] == title)
    })
    .await;
    let mut third = open().await;
    assert_eq!(third.events_for(SECS / 2).await, Vec::<Sse>::new());
    let (guid, p) = change();
    assert_eq!(s.deliver("issues", &guid, &p).await, 202);
    assert_eq!(ids_of(&third.event_within(2 * SECS).await.unwrap()), [id]);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_older_edit_arriving_after_the_delete_never_brings_the_issue_back() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let r = top(&s, &mut b).await;
    let id = r["id"].as_i64().unwrap();
    let repo = repo_id(&s, &mut b, r["repo"].as_str().unwrap()).await;

    let gone = issues_payload("deleted", repo, &r, "x", "2030-01-01T00:02:00Z");
    assert_eq!(s.deliver("issues", "g-gone", &gone).await, 202);
    assert_eq!(ids_of(&st.event_within(2 * SECS).await.unwrap()), [id]);
    // Edits from before the delete, delivered late: newer than anything the mirror has left.
    let late = issues_payload("edited", repo, &r, "back again", "2030-01-01T00:01:00Z");
    assert_eq!(s.deliver("issues", "g-late-edit", &late).await, 202);
    let mut comment = late.clone();
    comment["action"] = json!("created");
    comment["comment"] = json!({
        "id": 9_900_001, "node_id": "IC_test", "user": { "id": 1, "login": "someone" },
        "body": "late", "created_at": "2030-01-01T00:01:00Z", "updated_at": "2030-01-01T00:01:00Z",
    });
    assert_eq!(
        s.deliver("issue_comment", "g-late-comment", &comment).await,
        202
    );
    assert_eq!(st.events_for(SECS).await, Vec::<Sse>::new());
    assert!(row(&s.api(&mut b, "/api/issues").await.1, id).is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_older_milestone_change_arriving_late_changes_nothing() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let r = top(&s, &mut b).await;
    let id = r["id"].as_i64().unwrap();
    let repo = repo_id(&s, &mut b, r["repo"].as_str().unwrap()).await;
    let milestone = |title: &str, updated_at: &str| {
        json!({
            "id": 88, "number": 9, "title": title, "state": "open", "due_on": null,
            "updated_at": updated_at,
        })
    };
    let mut p = issues_payload("milestoned", repo, &r, "Planned", "2030-01-01T00:00:00Z");
    p["issue"]["milestone"] = milestone("v9", "2030-01-01T00:00:00Z");
    assert_eq!(s.deliver("issues", "g-milestoned", &p).await, 202);
    assert_eq!(ids_of(&st.event_within(2 * SECS).await.unwrap()), [id]);
    let edited = |title: &str, updated_at: &str| {
        json!({
            "action": "edited",
            "milestone": milestone(title, updated_at),
            "repository": { "id": repo },
        })
    };

    let newer = edited("v9.1", "2030-01-01T00:02:00Z");
    assert_eq!(s.deliver("milestone", "g-ms-newer", &newer).await, 202);
    assert_eq!(ids_of(&st.event_within(2 * SECS).await.unwrap()), [id]);
    // Renamed before the rename above, delivered after it.
    let older = edited("v9-rc", "2030-01-01T00:01:00Z");
    assert_eq!(s.deliver("milestone", "g-ms-older", &older).await, 202);
    assert_eq!(st.events_for(SECS).await, Vec::<Sse>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_late_issue_payload_never_renames_a_label_or_brings_a_deleted_one_back() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let r = top(&s, &mut b).await;
    let id = r["id"].as_i64().unwrap();
    let repo = repo_id(&s, &mut b, r["repo"].as_str().unwrap()).await;
    let labels = |names: &[(i64, &str)]| -> Value {
        names
            .iter()
            .map(|(id, name)| json!({ "id": id, "name": name, "color": "ededed" }))
            .collect()
    };
    let label_event = |action: &str, id: i64, name: &str| {
        json!({
            "action": action,
            "label": { "id": id, "name": name, "color": "0e8a16", "description": null },
            "repository": { "id": repo },
        })
    };
    let listed = |page: &Value| row(page, id).unwrap()["labels"].clone();

    let mut p = issues_payload("labeled", repo, &r, "Tagged", "2030-01-01T00:00:00Z");
    p["issue"]["labels"] = labels(&[(77, "triage-me"), (78, "doomed")]);
    assert_eq!(s.deliver("issues", "g-two-labels", &p).await, 202);
    assert_eq!(ids_of(&st.event_within(2 * SECS).await.unwrap()), [id]);
    let renamed = label_event("edited", 77, "triaged");
    assert_eq!(s.deliver("label", "g-rename-77", &renamed).await, 202);
    st.event_within(2 * SECS).await.unwrap();
    let deleted = label_event("deleted", 78, "doomed");
    assert_eq!(s.deliver("label", "g-delete-78", &deleted).await, 202);
    st.event_within(2 * SECS).await.unwrap();

    // An edit made before the rename and the delete, newer than the mirror's row, delivered
    // after both: its title applies, its stale labels don't.
    let mut late = issues_payload("edited", repo, &r, "Late title", "2030-01-01T00:01:00Z");
    late["issue"]["labels"] = labels(&[(77, "triage-me"), (78, "doomed")]);
    assert_eq!(s.deliver("issues", "g-late-labels", &late).await, 202);
    assert_eq!(ids_of(&st.event_within(2 * SECS).await.unwrap()), [id]);
    let page = s.api(&mut b, "/api/issues").await.1;
    assert_eq!(row(&page, id).unwrap()["title"], "Late title");
    assert_eq!(
        listed(&page),
        json!([{ "name": "triaged", "color": "0e8a16" }])
    );

    // Nor does a late `label` edit bring the deleted one back.
    let late_edit = label_event("edited", 78, "doomed-renamed");
    assert_eq!(s.deliver("label", "g-late-78", &late_edit).await, 202);
    let mut relabel = issues_payload("labeled", repo, &r, "Late title", "2030-01-01T00:02:00Z");
    relabel["issue"]["labels"] = labels(&[(77, "triaged"), (78, "doomed-renamed")]);
    assert_eq!(s.deliver("issues", "g-relabel", &relabel).await, 202);
    st.event_within(2 * SECS).await.unwrap();
    let page = s.api(&mut b, "/api/issues").await.1;
    assert_eq!(
        listed(&page),
        json!([{ "name": "triaged", "color": "0e8a16" }])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn accounts_syncing_different_repos_each_hear_only_their_own_repos_changes() {
    // Every `/api/me` re-reads the roles.
    let s = start_with(|c| c.repo_refresh_every = Duration::ZERO).await;
    let mut owner = s.sign_in("tomsj").await;
    let mut member = s.sign_in("ilze-k").await;
    let (_, page) = s.api(&mut owner, "/api/issues").await;
    let rows = page["rows"].as_array().unwrap();
    let a = rows[0].clone();
    let b = rows
        .iter()
        .find(|r| r["repo"] != a["repo"])
        .unwrap()
        .clone();
    // Each loses the repo the other keeps: tomsj syncs A's repo and not B's, ilze-k the reverse.
    for (login, repo) in [("tomsj", &b["repo"]), ("ilze-k", &a["repo"])] {
        s.fake(
            "PUT",
            "/permissions",
            json!({ "login": login, "repo": repo, "role": null }),
        )
        .await;
    }
    for br in [&mut owner, &mut member] {
        assert_eq!(s.api(br, "/api/me").await.0, 200);
    }
    let (mut owner_st, mut member_st) = (s.stream(&owner).await, s.stream(&member).await);
    owner_st.reset().await;
    member_st.reset().await;

    s.edit(json!({ "repo": a["repo"], "number": a["number"], "title": "Only for tomsj" }))
        .await;
    assert_eq!(
        ids_of(&owner_st.event_within(4 * SECS).await.unwrap()),
        [a["id"].as_i64().unwrap()]
    );
    assert_eq!(member_st.events_for(SECS).await, Vec::<Sse>::new());

    s.edit(json!({ "repo": b["repo"], "number": b["number"], "title": "Only for ilze-k" }))
        .await;
    assert_eq!(
        ids_of(&member_st.event_within(4 * SECS).await.unwrap()),
        [b["id"].as_i64().unwrap()]
    );
    assert_eq!(owner_st.events_for(SECS).await, Vec::<Sse>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn every_stream_opens_with_a_reset_then_the_status_slot_even_when_nothing_is_importing() {
    // A tab that reconnects after an import ended must hear that it ended: the stream says what
    // the status slot holds as it opens, `null` included.
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    assert_eq!(st.event_within(SECS).await.unwrap().event, "reset");
    assert_eq!(
        st.event_within(SECS).await,
        Some(Sse {
            event: "status".into(),
            data: r#"{"import":null,"sync":null}"#.into()
        })
    );
}

/// Two label changes to each of two issues within one second, their four deliveries sent newest
/// first: on one issue a label put on and taken off again, on the other two labels put on. Picks
/// share an `updated_at` within a second, so the order can't come from it. The mirror ends as
/// GitHub has both issues.
#[tokio::test(flavor = "multi_thread")]
async fn same_second_label_deliveries_sent_in_reverse_leave_the_mirror_as_github_has_it() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (_, page) = s.api(&mut b, "/api/issues").await;
    let rows = page["rows"].as_array().unwrap();
    let (toggled, added) = (rows[0].clone(), rows[1].clone());
    let names = |r: &Value| -> Vec<String> {
        r["labels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l["name"].as_str().unwrap().to_owned())
            .collect()
    };
    let free = |r: &Value| -> Vec<&'static str> {
        ["p0", "p1", "p2", "ux", "question", "backend", "frontend"]
            .into_iter()
            .filter(|l| !names(r).iter().any(|h| h == l))
            .collect()
    };
    let x = free(&toggled)[0];
    let (a, z) = (free(&added)[0], free(&added)[1]);
    let edit = |r: &Value, key: &str, label: &str| json!({ "repo": r["repo"], "number": r["number"], key: [label] });
    let at = |v: &Value| v["issue"]["updated_at"].as_str().unwrap().to_owned();
    for tries in 1.. {
        s.fake("POST", "/faults/webhooks", json!({ "reorder": 4 }))
            .await;
        let on = s.edit(edit(&toggled, "add_labels", x)).await;
        let off = s.edit(edit(&toggled, "remove_labels", x)).await;
        let first = s.edit(edit(&added, "add_labels", a)).await;
        let second = s.edit(edit(&added, "add_labels", z)).await;
        if at(&on) == at(&off) && at(&first) == at(&second) {
            break;
        }
        // A second ticked over between them: put things back and try again.
        assert!(tries < 5, "no two edits fell within one second");
        tokio::time::sleep(2 * SECS).await;
        s.edit(edit(&added, "remove_labels", a)).await;
        s.edit(edit(&added, "remove_labels", z)).await;
        tokio::time::sleep(2 * SECS).await;
    }
    // The batch goes out about a second later; anything read back after it lands within a few.
    tokio::time::sleep(6 * SECS).await;
    let (_, page) = s.api(&mut b, "/api/issues").await;
    assert!(
        !names(row(&page, toggled["id"].as_i64().unwrap()).unwrap()).contains(&x.to_owned()),
        "{x} is still on the issue it was taken off"
    );
    let now = names(row(&page, added["id"].as_i64().unwrap()).unwrap());
    assert!(
        now.contains(&a.to_owned()) && now.contains(&z.to_owned()),
        "{a} and {z} should both be on, have {now:?}"
    );
}

/// Two comments on a pull request within one second, their deliveries sent newest first: the
/// older can't be ordered by `updated_at`, so the PR is read again, with the App's read-back
/// token. GitHub may refuse `GET /issues/{n}` for a PR to a token with only `issues: read`, so
/// that token holds `pull_requests: read` too. The mirror ends with both comments.
#[tokio::test(flavor = "multi_thread")]
async fn same_second_comments_on_a_pr_are_read_again_with_a_token_that_covers_prs() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (_, page) = s.api(&mut b, "/api/issues?q=is%3Apr").await;
    let pr = page["rows"][0].clone();
    assert_eq!(pr["kind"], "pr", "{pr}");
    let id = pr["id"].as_i64().unwrap();
    let at = |v: &Value| v["issue"]["updated_at"].as_str().unwrap().to_owned();
    let mut said = Vec::new();
    for tries in 1.. {
        s.fake("POST", "/faults/webhooks", json!({ "reorder": 2 }))
            .await;
        let comment = |n: usize| json!({ "repo": pr["repo"], "number": pr["number"], "comment": format!("same second {tries}.{n}") });
        let first = s.edit(comment(1)).await;
        let second = s.edit(comment(2)).await;
        said = vec![
            format!("same second {tries}.1"),
            format!("same second {tries}.2"),
        ];
        if at(&first) == at(&second) {
            break;
        }
        assert!(tries < 5, "no two comments fell within one second");
        tokio::time::sleep(2 * SECS).await;
    }
    // The batch goes out about a second later; the read-back follows its 2 s debounce.
    tokio::time::sleep(6 * SECS).await;
    let (_, d) = s.api(&mut b, &format!("/api/issues/{id}")).await;
    // Each body as the AST a one-line comment renders to.
    let bodies: Vec<&Value> = d["comments"]["comments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| &c["body"])
        .collect();
    for body in &said {
        assert!(
            bodies.contains(&&json!([["p", 0, body]])),
            "{body} missing: {bodies:?}"
        );
    }
    let state = s.fake("GET", "/state", json!({})).await;
    assert_eq!(
        state["installation_tokens"],
        json!([{
            "installation": 41000001,
            "permissions": { "issues": "read", "pull_requests": "read" },
        }]),
    );
}

/// The answers still to come from Fake GitHub's rewrite rules for `endpoint`.
async fn rewrites_left(s: &Stack, endpoint: &str) -> u64 {
    let state = s.fake("GET", "/state", json!({})).await;
    state["faults"]["rewrite"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|w| w["endpoint"] == endpoint)
        .map(|w| w["remaining"].as_u64().unwrap())
        .sum()
}

/// Whether the account is marked for a sweep to repair (the control DB: no HTTP seam shows it).
fn needs_resync(s: &Stack, account: i64) -> bool {
    let db = rusqlite::Connection::open(s.control_db()).unwrap();
    control_db::q::account(&db, account)
        .unwrap()
        .unwrap()
        .needs_resync
}

/// Polls `f` every 50 ms until it holds, for up to `secs`.
async fn until_holds<F, Fut>(secs: u64, what: &str, mut f: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = std::time::Instant::now() + Duration::from_secs(secs);
    while !f().await {
        assert!(
            std::time::Instant::now() < deadline,
            "{what} didn't happen within {secs} s"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// An issue the mirror has at `AT`, titled "Tagged", and the endpoint its read-back GETs.
async fn issue_at(s: &Stack, b: &mut Browser, labels: Value, milestone: Value) -> (Value, String) {
    let r = top(s, b).await;
    let id = r["id"].as_i64().unwrap();
    let repo = repo_id(s, b, r["repo"].as_str().unwrap()).await;
    let mut p = issues_payload("labeled", repo, &r, "Tagged", AT);
    p["issue"]["labels"] = labels;
    p["issue"]["milestone"] = milestone;
    assert_eq!(s.deliver("issues", &format!("g-at-{id}"), &p).await, 202);
    let deadline = std::time::Instant::now() + 5 * SECS;
    while !row(&s.api(b, "/api/issues").await.1, id).is_some_and(|r| r["title"] == "Tagged") {
        assert!(
            std::time::Instant::now() < deadline,
            "the issue never written"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let endpoint = format!(
        "GET /repos/acme/{}/issues/{}",
        r["repo"].as_str().unwrap(),
        r["number"]
    );
    (p, endpoint)
}

const AT: &str = "2030-01-01T00:00:00Z";

/// GitHub's answer still names a label and a milestone whose deletes the mirror already has.
/// The mirror never takes them back, so they're no difference to read the issue again for: one
/// read settles it.
#[tokio::test(flavor = "multi_thread")]
async fn a_read_back_naming_a_deleted_label_and_milestone_settles_at_once() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (p, endpoint) = issue_at(
        &s,
        &mut b,
        json!([{ "id": 77, "name": "triage-me", "color": "ededed" }]),
        json!({ "id": 88, "number": 9, "title": "v9", "state": "open", "due_on": null }),
    )
    .await;
    let id = p["issue"]["id"].as_i64().unwrap();
    let repo = &p["repository"];
    let label = json!({
        "action": "deleted",
        "label": { "id": 77, "name": "triage-me", "color": "ededed", "description": null },
        "repository": repo,
    });
    assert_eq!(s.deliver("label", "g-label-gone", &label).await, 202);
    let milestone =
        json!({ "action": "deleted", "milestone": p["issue"]["milestone"], "repository": repo });
    assert_eq!(
        s.deliver("milestone", "g-milestone-gone", &milestone).await,
        202
    );
    let deadline = std::time::Instant::now() + 5 * SECS;
    loop {
        let (_, d) = s.api(&mut b, &format!("/api/issues/{id}")).await;
        if d["labels"] == json!([]) && d["milestone"].is_null() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the label and milestone never went: {d}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Every read of the issue answers with both still on it, at the mirror's own `updated_at`.
    s.fake(
        "POST",
        "/faults/rewrite",
        json!({ "endpoint": endpoint, "count": 10, "raw": p["issue"].to_string() }),
    )
    .await;
    // A delivery of that second saying otherwise has the issue read again.
    let other = issues_payload(
        "edited",
        p["repository"]["id"].as_i64().unwrap(),
        &json!({ "id": id, "number": p["issue"]["number"], "repo": p["repository"]["name"] }),
        "Other",
        AT,
    );
    assert_eq!(s.deliver("issues", "g-other", &other).await, 202);
    until_holds(8, "the read-back", || async {
        rewrites_left(&s, &endpoint).await < 10
    })
    .await;
    // Two debounces later, still the one read.
    tokio::time::sleep(5 * SECS).await;
    assert_eq!(rewrites_left(&s, &endpoint).await, 9);
}

/// GitHub answers each read of an issue with another title at the same `updated_at`, so no
/// read finds the mirror as GitHub says: after five read-backs in a row the issue is left to a
/// sweep, its accounts marked for resync, rather than read forever.
#[tokio::test(flavor = "multi_thread")]
async fn an_issue_read_again_five_times_in_a_row_is_left_to_a_resync() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let account = s.api(&mut b, "/api/me").await.1["account"]["id"]
        .as_i64()
        .unwrap();
    let (p, endpoint) = issue_at(&s, &mut b, json!([]), Value::Null).await;
    let id = p["issue"]["id"].as_i64().unwrap();
    assert!(!needs_resync(&s, account));
    for n in 0..12 {
        let mut answer = p["issue"].clone();
        answer["title"] = json!(if n % 2 == 0 { "A" } else { "B" });
        s.fake(
            "POST",
            "/faults/rewrite",
            json!({ "endpoint": endpoint, "count": 1, "raw": answer.to_string() }),
        )
        .await;
    }
    let other = issues_payload(
        "edited",
        p["repository"]["id"].as_i64().unwrap(),
        &json!({ "id": id, "number": p["issue"]["number"], "repo": p["repository"]["name"] }),
        "Other",
        AT,
    );
    assert_eq!(s.deliver("issues", "g-other", &other).await, 202);
    until_holds(25, "the account marked for resync", || async {
        needs_resync(&s, account)
    })
    .await;
    assert_eq!(rewrites_left(&s, &endpoint).await, 7);
    // And no read after it.
    tokio::time::sleep(4 * SECS).await;
    assert_eq!(rewrites_left(&s, &endpoint).await, 7);
}

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
        assert_eq!(st.event_within(SECS).await.unwrap().event, "reset");
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
    st.event_within(SECS).await;
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
    st.event_within(SECS).await;
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
    st.event_within(SECS).await;
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
    st.event_within(SECS).await;
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

    // Equal wins: a second delivery at the same time is applied.
    let same = issues_payload("edited", repo, &r, "same time", "2030-01-01T00:02:00Z");
    assert_eq!(s.deliver("issues", "same", &same).await, 202);
    assert_eq!(ids_of(&st.event_within(2 * SECS).await.unwrap()), [id]);
    assert_eq!(
        row(&s.api(&mut b, "/api/issues").await.1, id).unwrap()["title"],
        "same time"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn label_and_milestone_changes_push_every_issue_they_touch() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.event_within(SECS).await;
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
    st.event_within(SECS).await;
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
    let cursor = format!("{}.{}", last["updated_at"], last["id"]);
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
    st.event_within(SECS).await;
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
    st.event_within(SECS).await;
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
    owner_st.event_within(SECS).await;
    member_st.event_within(SECS).await;
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

    s.edit(json!({ "repo": r["repo"], "number": r["number"], "title": "Not for ilze-k" }))
        .await;
    assert_eq!(
        ids_of(&owner_st.event_within(4 * SECS).await.unwrap()),
        [id]
    );
    assert_eq!(member_st.events_for(SECS).await, Vec::<Sse>::new());
    // Nor is it written to ilze-k's mirror.
    if let Some(row) = row(&s.api(&mut member, "/api/issues").await.1, id) {
        assert_eq!(row["title"], r["title"]);
    }
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
    stuck.event_within(SECS).await;
    other.event_within(SECS).await;
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
    // Its write gives up after the busy timeout; then the mirror is free again.
    assert_eq!(
        stuck.events_for(5 * SECS + SECS / 2).await,
        Vec::<Sse>::new()
    );
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
    st.event_within(SECS).await;
    let mirror = s
        .data
        .join("mirrors")
        .join(format!("{}.db", account_id(&s, &mut b).await));
    let r = top(&s, &mut b).await;
    let id = r["id"].as_i64().unwrap();
    let repo = repo_id(&s, &mut b, r["repo"].as_str().unwrap()).await;

    // The apply waits on the mirror until the control DB is held too, so marking the delivery
    // processed meets a busy control DB.
    let mirror_lock = WriteLock::take(&mirror);
    let at = "2030-01-01T00:00:00Z";
    let first = issues_payload("edited", repo, &r, "first", at);
    assert_eq!(s.deliver("issues", "g-mark-1", &first).await, 202);
    let control_lock = WriteLock::take(&s.control_db());
    tokio::time::sleep(Duration::from_millis(300)).await;
    drop(mirror_lock);
    assert_eq!(ids_of(&st.event_within(3 * SECS).await.unwrap()), [id]);
    // Past the busy timeout: the first try to mark it fails.
    tokio::time::sleep(5 * SECS + SECS / 2).await;
    drop(control_lock);

    // Same `updated_at`, so if the first were applied again it would win back.
    let second = issues_payload("edited", repo, &r, "second", at);
    assert_eq!(s.deliver("issues", "g-mark-2", &second).await, 202);
    assert_eq!(ids_of(&st.event_within(8 * SECS).await.unwrap()), [id]);
    s.restart_with(|_| {}).await;
    assert_eq!(
        row(&s.api(&mut b, "/api/issues").await.1, id).unwrap()["title"],
        "second"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn processed_deliveries_past_their_keep_are_pruned_at_startup() {
    let mut s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.event_within(SECS).await;
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
        assert_eq!(st.event_within(SECS).await.unwrap().event, "reset");
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
    st.event_within(SECS).await;
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
    st.event_within(SECS).await;
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
    st.event_within(SECS).await;
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
    owner_st.event_within(SECS).await;
    member_st.event_within(SECS).await;

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

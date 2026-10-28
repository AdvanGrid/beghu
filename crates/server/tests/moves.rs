//! The rare GitHub events the mirror must survive: an issue deleted, transferred (its deliveries
//! arriving in either order), or converted to a discussion; a label or milestone renamed; the App
//! uninstalled; a repo archived. Each is made on Fake GitHub, which sends GitHub's measured
//! deliveries (docs/research/issue-edge-cases.md), or delivered by the test as GitHub would.

mod common;

use common::{Browser, Stack, start, summary, until};
use serde_json::{Value, json};

/// A fixture issue with no relationships: `(repo, number, id)`. 8 in web, 4 in api, 2 in docs.
fn unlinked(repo: &str) -> Vec<(String, i64, i64)> {
    summary()["unlinked"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|u| u["repo"] == repo)
        .map(|u| {
            (
                repo.to_owned(),
                u["number"].as_i64().unwrap(),
                u["id"].as_i64().unwrap(),
            )
        })
        .collect()
}

fn reference(u: &(String, i64, i64)) -> String {
    format!("{}#{}", u.0, u.1)
}

/// An outside edit of `u` on GitHub.
async fn edit(s: &Stack, u: &(String, i64, i64), fields: Value) {
    let mut e = json!({ "repo": u.0, "number": u.1 });
    for (k, v) in fields.as_object().unwrap() {
        e[k] = v.clone();
    }
    s.edit(e).await;
}

/// An issue's relationships as its detail shows them: the ids at the other end, by kind; `None`
/// while the detail doesn't load.
async fn links(s: &Stack, b: &Browser, id: i64) -> Option<Value> {
    let (status, d) = s.api(&mut b.clone(), &format!("/api/issues/{id}")).await;
    if status != 200 {
        return None;
    }
    let r = &d["relationships"];
    let ids = |k: &str| -> Vec<i64> {
        r[k].as_array()
            .unwrap()
            .iter()
            .map(|x| x["id"].as_i64().unwrap())
            .collect()
    };
    Some(json!({
        "parent": r["parent"]["id"],
        "sub_issues": ids("sub_issues"),
        "blocked_by": ids("blocked_by"),
        "blocking": ids("blocking"),
        "relates_to": ids("relates_to"),
    }))
}

/// The detail's failure for `id`: its status and body.
async fn detail(s: &Stack, b: &Browser, id: i64) -> (u16, Value) {
    s.api(&mut b.clone(), &format!("/api/issues/{id}")).await
}

/// The id of the synced repo called `name`.
async fn repo_id(s: &Stack, b: &mut Browser, name: &str) -> i64 {
    let (_, me) = s.api(b, "/api/me").await;
    me["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == name)
        .unwrap_or_else(|| panic!("{name} isn't synced: {me}"))["id"]
        .as_i64()
        .unwrap()
}

/// Transfers `u` to `to` on GitHub: the new issue, and how many deliveries GitHub sends for it.
async fn transfer_counted(s: &Stack, u: &(String, i64, i64), to: &str) -> (Value, u64) {
    let res = s
        .fake(
            "POST",
            "/transfer",
            json!({ "repo": u.0, "number": u.1, "to": to }),
        )
        .await;
    (res["issue"].clone(), res["deliveries"].as_u64().unwrap())
}

/// Transfers `u` to `to` on GitHub; the new issue.
async fn transfer(s: &Stack, u: &(String, i64, i64), to: &str) -> Value {
    transfer_counted(s, u, to).await.0
}

/// How many delivery attempts the fake has logged.
async fn attempts(s: &Stack) -> u64 {
    s.fake("GET", "/state", json!({})).await["webhooks"]["deliveries"]["attempts"]
        .as_u64()
        .unwrap()
}

/// Waits until the fake has made `n` delivery attempts and the server has processed every
/// delivery it received, read-backs and all. No HTTP seam shows a delivery processed (redelivery
/// reads GitHub's log, not this), so this reads the control DB, as relationships.rs does.
async fn all_landed(s: &Stack, n: u64) {
    until(30.0, "every delivery sent", || async {
        (attempts(s).await >= n).then_some(())
    })
    .await;
    until(30.0, "every delivery processed", || async {
        let db = rusqlite::Connection::open(s.control_db()).unwrap();
        control_db::q::pending_delivery_guids(&db, i64::MAX)
            .unwrap()
            .is_empty()
            .then_some(())
    })
    .await;
}

/// How many full sweeps have read a repo's issues (`ImportIssues`, which only the import and a
/// sweep call).
async fn sweeps(s: &Stack) -> u64 {
    s.fake("GET", "/state", json!({})).await["graphql"]["operations"]["ImportIssues"]
        .as_u64()
        .unwrap_or(0)
}

/// An issue's comments as its detail shows them: `(id, the rendered body as JSON text)`.
async fn thread(s: &Stack, b: &Browser, id: i64) -> Option<Vec<(i64, String)>> {
    let (status, d) = detail(s, b, id).await;
    if status != 200 {
        return None;
    }
    Some(
        d["comments"]["comments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| (c["id"].as_i64().unwrap(), c["body"].to_string()))
            .collect(),
    )
}

/// How a transfer's deliveries reach beghu.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Arrival {
    /// As GitHub sends them: `issues.opened` first, `issues.transferred` last.
    InOrder,
    /// Newest first: `issues.transferred` before `issues.opened`.
    Reordered,
    /// `issues.transferred` is lost: only `issues.opened` (and the dependency re-sends) land.
    OnlyOpened,
    /// `issues.opened` is lost: only `issues.transferred` (and the dependency re-sends) land.
    OnlyTransferred,
    /// Each sent twice under one GUID, as a redelivery would.
    Duplicated,
}

/// An issue in web with every kind of link — a parent and a sub-issue in web, an issue in api
/// blocking it, one in api it blocks, and one in web it relates to — and comments, transferred
/// to docs, its deliveries arriving as `how` says. However they arrive, so long as one of
/// `issues.opened` and `issues.transferred` lands, the mirror ends the same: the old id gone and
/// saying where it went, every link on the new one on both ends (the sub-issue links too, which
/// no delivery re-sends: only the transfer itself puts them there), and the new issue's thread as
/// GitHub has it (read again after the transfer: a comment the mirror lacked arrives, one GitHub
/// doesn't list goes).
async fn transfer_with_every_link(how: Arrival) {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (web, api) = (unlinked("web"), unlinked("api"));
    let (moving, parent, related, child) = (&web[0], &web[1], &web[2], &web[3]);
    let (blocker, blocked) = (&api[0], &api[1]);
    edit(&s, parent, json!({ "add_sub_issue": reference(moving) })).await;
    edit(&s, moving, json!({ "add_sub_issue": reference(child) })).await;
    edit(&s, moving, json!({ "add_blocked_by": reference(blocker) })).await;
    edit(&s, blocked, json!({ "add_blocked_by": reference(moving) })).await;
    edit(&s, moving, json!({ "add_relates_to": reference(related) })).await;
    // A transfer keeps every link.
    let every = json!({
        "parent": parent.2, "sub_issues": [child.2], "blocked_by": [blocker.2],
        "blocking": [blocked.2], "relates_to": [related.2],
    });
    until(10.0, "the links", || async {
        (links(&s, &b, moving.2).await? == every).then_some(())
    })
    .await;
    // Two comments the mirror has; one whose webhook was lost, which it lacks; and one it holds
    // that GitHub doesn't (as if GitHub gave the transferred comments new ids).
    let had = thread(&s, &b, moving.2).await.unwrap().len();
    edit(&s, moving, json!({ "comment": "First, before the move" })).await;
    edit(&s, moving, json!({ "comment": "Second, before the move" })).await;
    until(10.0, "the comments", || async {
        (thread(&s, &b, moving.2).await?.len() == had + 2).then_some(())
    })
    .await;
    s.fake("POST", "/faults/webhooks", json!({ "drop": 1 }))
        .await;
    edit(&s, moving, json!({ "comment": "Third, its webhook lost" })).await;
    let web_id = repo_id(&s, &mut b, "web").await;
    const GHOST: i64 = 3_990_000_100;
    let ghost = json!({
        "action": "created",
        "repository": { "id": web_id, "name": "web", "full_name": "acme/web" },
        "installation": { "id": 41000001 },
        "issue": {
            "id": moving.2, "number": moving.1, "title": "x", "state": "open",
            "node_id": summary()["unlinked"].as_array().unwrap().iter()
                .find(|u| u["id"] == moving.2).unwrap()["node_id"],
            "updated_at": "2020-01-01T00:00:00Z",
            "repository_url": "https://api.github.com/repos/acme/web",
        },
        "comment": {
            "id": GHOST, "node_id": "IC_ghost", "user": { "id": 1000, "login": "tomsj" },
            "body": "A ghost GitHub doesn't list",
            "created_at": "2020-01-01T00:00:00Z", "updated_at": "2020-01-01T00:00:00Z",
        },
    });
    assert_eq!(s.deliver("issue_comment", "g-ghost", &ghost).await, 202);
    let before = until(10.0, "the ghost comment", || async {
        let t = thread(&s, &b, moving.2).await?;
        t.iter().any(|c| c.0 == GHOST).then_some(t)
    })
    .await;
    assert_eq!(before.len(), had + 3, "{before:?}");
    // The links' read-backs have landed: none reads GitHub after the transfer, which would mend
    // what the transfer's deliveries missed.
    all_landed(&s, attempts(&s).await).await;

    match how {
        Arrival::InOrder => {}
        Arrival::Reordered => {
            s.fake("POST", "/faults/webhooks", json!({ "reorder": 8 }))
                .await;
        }
        Arrival::OnlyOpened | Arrival::OnlyTransferred => {
            let lost = if how == Arrival::OnlyOpened {
                "issues.transferred"
            } else {
                "issues.opened"
            };
            s.fake(
                "POST",
                "/faults/webhooks",
                json!({ "drop": 1, "drop_only": lost }),
            )
            .await;
        }
        Arrival::Duplicated => {
            s.fake("POST", "/faults/webhooks", json!({ "duplicate": 100 }))
                .await;
        }
    }
    let swept = sweeps(&s).await;
    let sent_before = attempts(&s).await;
    let (new, deliveries) = transfer_counted(&s, moving, "docs").await;
    let id = new["id"].as_i64().unwrap();
    let copies = if how == Arrival::Duplicated { 2 } else { 1 };
    all_landed(&s, sent_before + deliveries * copies).await;
    // The deliveries did it all: no account was marked for a sweep to repair what they missed.
    assert_eq!(
        s.api(&mut b.clone(), "/api/me").await.1["sync"],
        Value::Null,
        "{how:?}"
    );
    assert_eq!(sweeps(&s).await, swept, "{how:?}: a sweep ran");

    // The old id says where it went.
    let (status, gone) = detail(&s, &b, moving.2).await;
    assert_eq!(
        (status, &gone["error"]),
        (410, &json!("moved")),
        "{how:?}: {gone}"
    );
    assert_eq!(gone["moved_to"], id, "{gone}");
    assert_eq!(gone["issue"]["repo"], "docs", "{gone}");
    assert_eq!(gone["issue"]["number"], new["number"], "{gone}");
    // Every link on the new issue, on both ends. Opening an issue with sub-issues reads them back
    // from GitHub (`reconcile::opened`), which would mend a link the transfer missed: the ends
    // that have none are checked first, before the new issue or its parent is opened.
    let ends = [
        (child.2, "parent", json!(id)),
        (blocker.2, "blocking", json!([id])),
        (blocked.2, "blocked_by", json!([id])),
        (related.2, "relates_to", json!([id])),
    ];
    for (end, kind, want) in ends {
        assert_eq!(
            links(&s, &b, end).await.unwrap()[kind],
            want,
            "{how:?}: {end}'s {kind}"
        );
    }
    assert_eq!(links(&s, &b, id).await, Some(every), "{how:?}");
    assert_eq!(
        links(&s, &b, parent.2).await.unwrap()["sub_issues"],
        json!([id]),
        "{how:?}"
    );
    // Its thread as GitHub has it: the comments the mirror had, by their ids, and the one it
    // lacked; not the ghost.
    let after = thread(&s, &b, id).await.unwrap();
    let ids: Vec<i64> = after.iter().map(|c| c.0).collect();
    for kept in before.iter().filter(|c| c.0 != GHOST) {
        assert!(ids.contains(&kept.0), "{how:?}: {after:?}");
    }
    assert!(!ids.contains(&GHOST), "{how:?}: {after:?}");
    assert_eq!(after.len(), had + 3, "{how:?}: {after:?}");
    assert!(
        after
            .iter()
            .any(|c| c.1.contains("Third, its webhook lost")),
        "{how:?}: {after:?}"
    );
    // A full issue of docs, in the list.
    let (_, d) = detail(&s, &b, id).await;
    assert_eq!(
        (d["repo"].as_str(), d["number"].as_i64()),
        (Some("docs"), new["number"].as_i64())
    );
    let (_, page) = s
        .api(&mut b.clone(), "/api/issues?q=is:any+repo:docs+repo:web")
        .await;
    let listed: Vec<i64> = page["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    assert!(listed.contains(&id));
    assert!(!listed.contains(&moving.2));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transfer_delivered_opened_first_puts_every_link_on_the_new_issue() {
    transfer_with_every_link(Arrival::InOrder).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transfer_delivered_transferred_first_leaves_the_same_mirror() {
    transfer_with_every_link(Arrival::Reordered).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transfer_whose_transferred_delivery_is_lost_is_applied_whole_from_opened() {
    transfer_with_every_link(Arrival::OnlyOpened).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transfer_whose_opened_delivery_is_lost_is_applied_whole_from_transferred() {
    transfer_with_every_link(Arrival::OnlyTransferred).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transfer_delivered_twice_leaves_the_same_mirror() {
    transfer_with_every_link(Arrival::Duplicated).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_link_read_back_that_meets_the_issue_transferred_leaves_the_account_healthy() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let (moving, parent) = (&web[0], &web[1]);
    let sent_before = attempts(&s).await;
    let link = s
        .edit(json!({ "repo": parent.0, "number": parent.1, "add_sub_issue": reference(moving) }))
        .await;
    until(10.0, "the sub-issue", || async {
        (links(&s, &b, parent.2).await?["sub_issues"] == json!([moving.2])).then_some(())
    })
    .await;
    // The link's read-back (about 2 s after its delivery) reaches GitHub after the transfer and
    // before the transfer's deliveries: GraphQL knows no such issue, as for a deleted one, while
    // the mirror still holds it.
    s.fake("POST", "/faults/webhooks", json!({ "delay_ms": 5000 }))
        .await;
    let (new, deliveries) = transfer_counted(&s, moving, "docs").await;
    all_landed(
        &s,
        sent_before + link["deliveries"].as_u64().unwrap() + deliveries,
    )
    .await;
    assert_eq!(
        s.api(&mut b.clone(), "/api/me").await.1["sync"],
        Value::Null,
        "marked for a resync"
    );
    assert_eq!(
        links(&s, &b, parent.2).await.unwrap()["sub_issues"],
        json!([new["id"]])
    );
}

/// `POST /api/ops` from `b`'s tab: the status and the body.
async fn op(s: &Stack, b: &Browser, n: usize, op: Value) -> (u16, Value) {
    let res = s
        .api_write(b, reqwest::Method::POST, "/api/ops")
        .json(&json!({ "op_id": format!("00000000-0000-4000-8000-{n:012x}"), "op": op }))
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_write_to_an_issue_transferred_before_its_webhooks_came_says_it_is_gone() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let moving = &unlinked("web")[0];
    // The transfer's deliveries are slow to come: the mirror still has the issue where it was,
    // and GitHub answers its old number with a 301 to where it is now.
    s.fake("POST", "/faults/webhooks", json!({ "delay_ms": 10_000 }))
        .await;
    transfer(&s, moving, "docs").await;
    let writes = [
        json!({ "kind": "close", "issue": moving.2, "reason": "completed" }),
        json!({ "kind": "label_add", "issue": moving.2, "label": "bug" }),
        json!({ "kind": "label_remove", "issue": moving.2, "label": "bug" }),
    ];
    for (n, w) in writes.into_iter().enumerate() {
        let (status, err) = op(&s, &b, n, w.clone()).await;
        assert_eq!(
            (status, err["error"].as_str()),
            (404, Some("gone")),
            "{w}: {err}"
        );
    }
    assert_eq!(detail(&s, &b, moving.2).await.0, 200, "still in the mirror");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_issue_transferred_out_of_the_synced_repos_stays_linked_as_a_stub() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    // tomsj syncs every repo but docs.
    let docs = repo_id(&s, &mut b, "docs").await;
    let (_, me) = s.api(&mut b, "/api/me").await;
    let keep: Vec<i64> = me["repos"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .filter(|&id| id != docs)
        .collect();
    let res = s
        .api_write(&b, reqwest::Method::PUT, "/api/repos")
        .json(&json!({ "repos": keep }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let web = unlinked("web");
    let (moving, parent) = (&web[0], &web[1]);
    edit(&s, parent, json!({ "add_sub_issue": reference(moving) })).await;
    until(10.0, "the sub-issue", || async {
        (links(&s, &b, parent.2).await?["sub_issues"] == json!([moving.2])).then_some(())
    })
    .await;

    let new = transfer(&s, moving, "docs").await;
    let id = new["id"].as_i64().unwrap();
    // Only `issues.transferred` reaches tomsj: the parent's child is now a stub in docs.
    until(10.0, "the stub", || async {
        (links(&s, &b, parent.2).await?["sub_issues"] == json!([id])).then_some(())
    })
    .await;
    let (_, d) = detail(&s, &b, parent.2).await;
    let child = &d["relationships"]["sub_issues"][0];
    assert_eq!(child["stub"], true, "{child}");
    assert_eq!(
        (child["repo"].as_str(), child["number"].as_i64()),
        (Some("docs"), new["number"].as_i64())
    );
    // The old issue says where it went, outside the synced repos: nothing to open in-app.
    let (status, gone) = detail(&s, &b, moving.2).await;
    assert_eq!(status, 410, "{gone}");
    assert_eq!(gone["error"], "moved");
    assert_eq!(gone["moved_to"], Value::Null, "{gone}");
    assert_eq!(gone["issue"]["repo"], "docs", "{gone}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deleted_issue_says_it_was_deleted_and_its_links_go_with_it() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let (deleted, parent) = (&web[0], &web[1]);
    edit(&s, parent, json!({ "add_sub_issue": reference(deleted) })).await;
    until(10.0, "the sub-issue", || async {
        (links(&s, &b, parent.2).await?["sub_issues"] == json!([deleted.2])).then_some(())
    })
    .await;

    edit(&s, deleted, json!({ "delete": true })).await;
    let (status, gone) = until(10.0, "the delete", || async {
        let (status, body) = detail(&s, &b, deleted.2).await;
        (status != 200).then_some((status, body))
    })
    .await;
    assert_eq!(status, 410, "{gone}");
    assert_eq!(gone["error"], "deleted", "{gone}");
    assert_eq!(
        links(&s, &b, parent.2).await.unwrap()["sub_issues"],
        json!([])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_issue_converted_to_a_discussion_shows_closed_and_locked_and_keeps_its_links() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let (converted, parent) = (&web[0], &web[1]);
    edit(
        &s,
        converted,
        json!({ "state": "open", "add_labels": ["bug"] }),
    )
    .await;
    edit(&s, parent, json!({ "add_sub_issue": reference(converted) })).await;
    until(10.0, "the sub-issue", || async {
        (links(&s, &b, converted.2).await?["parent"] == parent.2).then_some(())
    })
    .await;

    s.fake(
        "POST",
        "/convert",
        json!({ "repo": converted.0, "number": converted.1 }),
    )
    .await;
    let d = until(10.0, "the conversion", || async {
        let (status, d) = detail(&s, &b, converted.2).await;
        (status == 200 && d["locked"] == true && d["state"] == "closed").then_some(d)
    })
    .await;
    assert_eq!(d["state_reason"], "completed");
    assert_eq!(d["relationships"]["parent"]["id"], parent.2);
    assert!(
        d["labels"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l["name"] == "bug"),
        "{}",
        d["labels"]
    );
    assert_eq!(
        links(&s, &b, parent.2).await.unwrap()["sub_issues"],
        json!([converted.2])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_milestone_renamed_on_github_reaches_its_issues_without_bumping_them() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (_, page) = s
        .api(&mut b, "/api/issues?q=is:any+repo:web+milestone:v0.4")
        .await;
    let rows = page["rows"].as_array().unwrap().clone();
    assert!(!rows.is_empty());
    let id = rows[0]["id"].as_i64().unwrap();

    s.fake(
        "POST",
        "/milestone",
        json!({ "repo": "web", "title": "v0.4", "rename": "v0.4 renamed" }),
    )
    .await;
    let d = until(10.0, "the rename", || async {
        let (_, d) = detail(&s, &b, id).await;
        (d["milestone"]["title"] == "v0.4 renamed").then_some(d)
    })
    .await;
    assert_eq!(d["updated_at"], rows[0]["updated_at"]);
    let (_, page) = s
        .api(
            &mut b,
            "/api/issues?q=is:any+repo:web+milestone:%22v0.4+renamed%22",
        )
        .await;
    assert_eq!(page["rows"].as_array().unwrap(), &rows);
}

#[tokio::test(flavor = "multi_thread")]
async fn uninstalling_the_app_takes_its_repos_out_of_every_mirror_that_synced_them() {
    let s = start().await;
    let mut accounts = Vec::new();
    for login in ["tomsj", "ilze-k"] {
        let mut b = s.sign_in(login).await;
        let (_, page) = s.api(&mut b, "/api/issues").await;
        assert!(!page["rows"].as_array().unwrap().is_empty(), "{login}");
        accounts.push((login, b));
    }

    // The org uninstalls the App: GitHub sends `installation` `deleted`.
    s.fake("POST", "/uninstall", json!({ "login": "acme" }))
        .await;
    for (login, b) in &mut accounts {
        until(15.0, &format!("{login}'s rows leaving"), || {
            let mut b = b.clone();
            let s = &s;
            async move {
                let (_, page) = s.api(&mut b, "/api/issues?q=is:any").await;
                let (_, me) = s.api(&mut b, "/api/me").await;
                (page["rows"] == json!([]) && me["repos"] == json!([])).then_some(())
            }
        })
        .await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn archiving_a_repo_on_github_marks_it_archived_for_every_account_and_unarchiving_clears_it()
{
    let s = start().await;
    let mut accounts = Vec::new();
    for login in ["tomsj", "ilze-k"] {
        accounts.push(s.sign_in(login).await);
    }
    let mut st = s.stream(&accounts[0]).await;
    st.reset().await;
    for archived in [true, false] {
        s.fake(
            "POST",
            "/archive",
            json!({ "repo": "web", "archived": archived }),
        )
        .await;
        for b in &accounts {
            until(10.0, "the archived flag", || {
                let mut b = b.clone();
                let s = &s;
                async move {
                    let (_, me) = s.api(&mut b, "/api/me").await;
                    let web = me["repos"]
                        .as_array()?
                        .iter()
                        .find(|r| r["name"] == "web")?
                        .clone();
                    (web["archived"] == archived).then_some(())
                }
            })
            .await;
        }
        // Open tabs read what they show again.
        st.reset().await;
    }
}

/// `v` with an unknown field in every object, as GitHub adds fields over time.
fn with_unknown_fields(mut v: Value) -> Value {
    fn add(v: &mut Value) {
        match v {
            Value::Object(m) => {
                for x in m.values_mut() {
                    add(x);
                }
                m.insert(
                    "field_github_added_later".into(),
                    json!({ "nested": [1, "two", null], "flag": true }),
                );
            }
            Value::Array(a) => a.iter_mut().for_each(add),
            _ => {}
        }
    }
    add(&mut v);
    v
}

#[tokio::test(flavor = "multi_thread")]
async fn deliveries_with_fields_beghu_doesnt_know_apply_as_usual() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let web = repo_id(&s, &mut b, "web").await;
    let docs = repo_id(&s, &mut b, "docs").await;
    let repository = |id: i64, name: &str| {
        json!({
            "id": id, "node_id": format!("R_kw{id}"), "name": name,
            "full_name": format!("acme/{name}"), "private": true, "archived": false,
            "owner": { "login": "acme", "id": 61000001, "type": "Organization" },
        })
    };
    let issue = |id: i64, number: i64, repo: &str, title: &str| {
        json!({
            "id": id, "node_id": format!("I_new{id}"), "number": number, "title": title,
            "body": "Arrived with fields beghu doesn't know", "state": "open",
            "state_reason": null, "locked": false,
            "user": { "id": 1000, "login": "tomsj", "avatar_url": null, "user_view_type": "public" },
            "labels": [{ "id": 77, "name": "brand-new", "color": "ededed", "description": "",
                         "archived_at": null }],
            "assignees": [], "milestone": null, "comments": 0,
            "created_at": "2026-10-20T00:00:00Z", "updated_at": "2026-10-20T00:00:00Z",
            "closed_at": null,
            "repository_url": format!("https://api.github.com/repos/acme/{repo}"),
            "sub_issues_summary": { "total": 0, "completed": 0, "percent_completed": 0 },
            "issue_dependencies_summary": { "blocked_by": 0, "blocking": 0 },
            "pinned_comment": null, "type": null,
        })
    };
    let installation = json!({ "id": 41000001 });
    let opened = json!({
        "action": "opened",
        "issue": issue(3_990_000_001, 9_001, "web", "Opened with extras"),
        "repository": repository(web, "web"),
        "installation": installation,
    });
    assert_eq!(
        s.deliver("issues", "g-extra-opened", &with_unknown_fields(opened))
            .await,
        202
    );
    until(5.0, "the opened issue", || async {
        let (status, d) = detail(&s, &b, 3_990_000_001).await;
        (status == 200 && d["title"] == "Opened with extras").then_some(())
    })
    .await;

    let transferred = json!({
        "action": "transferred",
        "issue": issue(3_990_000_001, 9_001, "web", "Opened with extras"),
        "changes": {
            "new_issue": issue(3_990_000_002, 9_002, "docs", "Opened with extras"),
            "new_repository": repository(docs, "docs"),
        },
        "repository": repository(web, "web"),
        "installation": installation,
    });
    assert_eq!(
        s.deliver(
            "issues",
            "g-extra-transferred",
            &with_unknown_fields(transferred)
        )
        .await,
        202
    );
    until(5.0, "the transfer", || async {
        let (status, d) = detail(&s, &b, 3_990_000_002).await;
        (status == 200 && d["repo"] == "docs").then_some(())
    })
    .await;
    assert_eq!(detail(&s, &b, 3_990_000_001).await.1["error"], "moved");

    let mut archived_repo = repository(web, "web");
    archived_repo["archived"] = json!(true);
    let archived = json!({
        "action": "archived",
        "repository": archived_repo,
        "installation": installation,
    });
    assert_eq!(
        s.deliver(
            "repository",
            "g-extra-archived",
            &with_unknown_fields(archived)
        )
        .await,
        202
    );
    until(5.0, "the archived flag", || async {
        let (_, me) = s.api(&mut b.clone(), "/api/me").await;
        let web = me["repos"]
            .as_array()?
            .iter()
            .find(|r| r["name"] == "web")?
            .clone();
        (web["archived"] == true).then_some(())
    })
    .await;
}

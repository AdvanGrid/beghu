//! Relationships, read side: sub-issues, dependencies and relates-to made on GitHub reach the
//! list rows and the detail of both ends within 1–2 s, cross-repo included; stubs stand in for
//! issues in repos that aren't synced; an account never holds a relationship into a repo it can't see.
//! Every change is made on Fake GitHub (its outside edits send GitHub's deliveries) or delivered
//! by the test as GitHub would.

mod common;

use common::{
    Browser, Stack, WriteLock, ids_of, start, start_on, start_with, summary, twin_repo_fixture,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

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

/// Polls `f` every 50 ms until it gives a value, or panics after `secs`.
async fn until<T, F, Fut>(secs: f64, what: &str, mut f: F) -> T
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<T>>,
{
    let deadline = Instant::now() + Duration::from_secs_f64(secs);
    loop {
        if let Some(v) = f().await {
            return v;
        }
        assert!(
            Instant::now() < deadline,
            "{what} didn't happen within {secs} s"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn detail(s: &Stack, b: &Browser, id: i64) -> Value {
    let (status, d) = s.api(&mut b.clone(), &format!("/api/issues/{id}")).await;
    assert_eq!(status, 200, "{d}");
    d
}

/// The ids in one of the detail's relationship lists.
fn rel_ids(d: &Value, list: &str) -> Vec<i64> {
    d["relationships"][list]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect()
}

/// `id`'s row in the default list, paging until it's found.
async fn row(s: &Stack, b: &Browser, id: i64) -> Value {
    let mut path = "/api/issues".to_owned();
    loop {
        let (_, page) = s.api(&mut b.clone(), &path).await;
        if let Some(r) = page["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == id)
        {
            return r.clone();
        }
        let next = page["next"].as_str().expect("the row is in the list");
        path = format!("/api/issues?after={next}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dependency_made_on_github_shows_on_both_ends_within_2_s() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let mut stream = s.stream(&b).await;
    stream.reset().await;
    let web = unlinked("web");
    let (blocked, blocker) = (&web[0], &web[1]);

    let made = Instant::now();
    edit(&s, blocked, json!({ "add_blocked_by": reference(blocker) })).await;
    // One push names both ends.
    let ev = stream.event_within(Duration::from_secs(3)).await.unwrap();
    let ids = ids_of(&ev);
    assert!(
        ids.contains(&blocked.2) && ids.contains(&blocker.2),
        "{ids:?}"
    );
    let d = until(2.5, "the blocked side", || async {
        let d = detail(&s, &b, blocked.2).await;
        (rel_ids(&d, "blocked_by") == [blocker.2]).then_some(d)
    })
    .await;
    assert!(
        made.elapsed() < Duration::from_secs(2),
        "{:?}",
        made.elapsed()
    );
    let other = detail(&s, &b, blocker.2).await;
    assert_eq!(rel_ids(&other, "blocking"), [blocked.2]);
    let it = &d["relationships"]["blocked_by"][0];
    assert_eq!(it["repo"], "web");
    assert_eq!(it["number"], blocker.1);
    assert_eq!(it["stub"], false);

    // The row is marked blocked, with the blocker's chip.
    let r = row(&s, &b, blocked.2).await;
    assert_eq!(r["blocked_by"], 1);
    assert_eq!(r["blockers"][0]["id"], blocker.2);
    assert_eq!(r["blockers"][0]["number"], blocker.1);
    assert_eq!(r["blockers"][0]["title"], other["title"]);

    // And undone.
    edit(
        &s,
        blocked,
        json!({ "remove_blocked_by": reference(blocker) }),
    )
    .await;
    until(3.0, "the dependency going", || async {
        let d = detail(&s, &b, blocker.2).await;
        rel_ids(&d, "blocking").is_empty().then_some(())
    })
    .await;
    assert_eq!(row(&s, &b, blocked.2).await["blocked_by"], 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cross_repo_relationship_shows_on_both_ends_though_each_delivery_names_only_its_own_issue()
 {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let (web, api) = (unlinked("web"), unlinked("api"));
    let (parent, child, blocked, blocker) = (&web[0], &api[0], &api[1], &web[1]);

    let made = Instant::now();
    edit(&s, parent, json!({ "add_sub_issue": reference(child) })).await;
    edit(&s, blocked, json!({ "add_blocked_by": reference(blocker) })).await;
    until(3.0, "both ends of both relationships", || async {
        let p = detail(&s, &b, parent.2).await;
        let c = detail(&s, &b, child.2).await;
        let x = detail(&s, &b, blocked.2).await;
        let y = detail(&s, &b, blocker.2).await;
        (rel_ids(&p, "sub_issues") == [child.2]
            && c["relationships"]["parent"]["id"] == parent.2
            && rel_ids(&x, "blocked_by") == [blocker.2]
            && rel_ids(&y, "blocking") == [blocked.2])
        .then_some(())
    })
    .await;
    assert!(
        made.elapsed() < Duration::from_millis(2500),
        "{:?}",
        made.elapsed()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cross_repo_removal_that_names_the_other_end_applies_without_a_read_back() {
    let s = start_with(|c| c.read_back_retries = vec![Duration::from_secs(60)]).await;
    let b = s.sign_in("tomsj").await;
    let (web, api) = (unlinked("web"), unlinked("api"));
    let (blocked, blocker) = (&web[0], &api[0]);
    let repo = summary_repo_id(&s, &b, "web").await;
    // No read-back can land in this test: GitHub fails every one. (Made as an outside edit, the
    // dependency's two cross-repo deliveries each start a read-back, and one landing after the
    // removal below would put the edge back from GitHub's state, which still has it.) So the
    // dependency comes as a delivery that names the other end too, applied by id.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "POST /graphql", "count": 1000, "status": 502 }),
    )
    .await;
    s.deliver(
        "issue_dependencies",
        "block-1",
        &envelope(
            repo,
            "blocked_by_added",
            json!({
                "blocked_issue_id": blocked.2, "blocked_issue": issue(blocked),
                "blocking_issue_id": blocker.2,
            }),
        ),
    )
    .await;
    until(10.0, "the dependency", || async {
        let d = detail(&s, &b, blocked.2).await;
        let other = detail(&s, &b, blocker.2).await;
        (rel_ids(&d, "blocked_by") == [blocker.2] && rel_ids(&other, "blocking") == [blocked.2])
            .then_some(())
    })
    .await;

    // The removal names the blocker by id, though it's in another repo.
    s.deliver(
        "issue_dependencies",
        "unblock-1",
        &envelope(
            repo,
            "blocked_by_removed",
            json!({
                "blocked_issue_id": blocked.2, "blocked_issue": issue(blocked),
                "blocking_issue_id": blocker.2,
            }),
        ),
    )
    .await;
    until(10.0, "the dependency going", || async {
        let d = detail(&s, &b, blocked.2).await;
        rel_ids(&d, "blocked_by").is_empty().then_some(())
    })
    .await;
    let other = detail(&s, &b, blocker.2).await;
    assert_eq!(rel_ids(&other, "blocking"), Vec::<i64>::new());
}

/// With the `TwinRepo` fixture: an outside edit of `acme/web#n`, the repo named by its owner
/// (another org has a `web` too).
async fn edit_acme_web(s: &Stack, u: &(String, i64, i64), fields: Value) {
    let mut e = json!({ "repo": "acme/web", "number": u.1 });
    for (k, v) in fields.as_object().unwrap() {
        e[k] = v.clone();
    }
    s.edit(e).await;
}

/// The one relationship in a detail list, by its owner and number.
fn only(d: &Value, list: &str) -> Option<(String, i64)> {
    match d["relationships"][list].as_array().unwrap().as_slice() {
        [r] => Some((r["owner"].as_str()?.to_owned(), r["number"].as_i64()?)),
        _ => None,
    }
}

/// A `TwinRepo` fixture issue, `owner/web#number`, as the fixture made it: its id and node id,
/// and its repo's id and installation.
async fn twin_fixture_issue(
    s: &Stack,
    b: &Browser,
    owner: &str,
    number: i64,
) -> (i64, String, i64, i64) {
    let (_, me) = s.api(&mut b.clone(), "/api/me").await;
    let repo = me["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["owner"] == owner && r["name"] == "web")
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    let db = rusqlite::Connection::open(twin_repo_fixture()).unwrap();
    let id = fake_db::q::any_issue_id(&db, repo, number)
        .unwrap()
        .unwrap();
    let node_id = fake_db::q::graphql_issue(&db, id).unwrap().node_id;
    let installation = mirror_db::q::item_repos(&db, &[id]).unwrap()[0]
        .installation_id
        .unwrap();
    (id, node_id, repo, installation)
}

/// A delivery to `owner/web` (repo `repo`, through `installation`), with `fields` added.
fn twin_envelope(owner: &str, repo: i64, installation: i64, action: &str, fields: Value) -> Value {
    let mut p = envelope(repo, action, fields);
    p["repository"]["full_name"] = json!(format!("{owner}/web"));
    p["installation"]["id"] = json!(installation);
    p
}

/// How many GraphQL calls Fake GitHub has had with an installation token, and with a user's.
async fn graphql_calls(s: &Stack) -> (u64, u64) {
    let state = s.fake("GET", "/state", json!({})).await;
    let n = |k: &str| state["graphql"][k].as_u64().unwrap();
    (n("installation"), n("user"))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dependency_between_private_repos_of_two_installations_applies_by_the_ids_its_deliveries_name()
 {
    let s = start_on(twin_repo_fixture(), |_| {}).await;
    let b = s.sign_in("tomsj").await;
    let me = &unlinked("web")[0];
    // acme/web and acme-labs/web are both private, each in its own org's installation: neither
    // installation's token sees the other repo, so no read-back can find this dependency. Each
    // side's delivery names the other end's id, and the mirror holds both ends.
    let (_, _, web, web_inst) = twin_fixture_issue(&s, &b, "acme", me.1).await;
    let (twin, twin_node, labs, labs_inst) = twin_fixture_issue(&s, &b, "acme-labs", 1).await;
    let twin_issue = json!({
        "id": twin, "node_id": twin_node, "number": 1, "title": "x", "state": "open",
        "updated_at": "2020-01-01T00:00:00Z",
        "repository_url": "https://api.github.com/repos/acme-labs/web",
    });
    let deliver = |guid: &'static str,
                   (owner, repo, inst): (&'static str, i64, i64),
                   action: &'static str,
                   fields: Value| {
        let s = &s;
        async move {
            s.deliver(
                "issue_dependencies",
                guid,
                &twin_envelope(owner, repo, inst, action, fields),
            )
            .await
        }
    };
    let (acme, acme_labs) = (("acme", web, web_inst), ("acme-labs", labs, labs_inst));

    deliver(
        "dep-1",
        acme,
        "blocked_by_added",
        json!({
            "blocked_issue_id": me.2, "blocked_issue": issue(me), "blocking_issue_id": twin,
        }),
    )
    .await;
    deliver(
        "dep-2",
        acme_labs,
        "blocking_added",
        json!({
            "blocking_issue_id": twin, "blocking_issue": twin_issue, "blocked_issue_id": me.2,
        }),
    )
    .await;
    until(5.0, "both read-backs answered", || async {
        (issue_edges(&s).await >= 2).then_some(())
    })
    .await;
    // Their writes land a moment after the answers.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let d = detail(&s, &b, me.2).await;
    assert_eq!(only(&d, "blocked_by"), Some(("acme-labs".into(), 1)));
    assert_eq!(d["relationships"]["blocked_by"][0]["stub"], false);
    assert_eq!(rel_ids(&detail(&s, &b, twin).await, "blocking"), [me.2]);

    deliver(
        "undep-1",
        acme,
        "blocked_by_removed",
        json!({
            "blocked_issue_id": me.2, "blocked_issue": issue(me), "blocking_issue_id": twin,
        }),
    )
    .await;
    deliver(
        "undep-2",
        acme_labs,
        "blocking_removed",
        json!({
            "blocking_issue_id": twin, "blocking_issue": twin_issue, "blocked_issue_id": me.2,
        }),
    )
    .await;
    until(5.0, "the dependency going from both ends", || async {
        let d = detail(&s, &b, me.2).await;
        let t = detail(&s, &b, twin).await;
        (rel_ids(&d, "blocked_by").is_empty() && rel_ids(&t, "blocking").is_empty()).then_some(())
    })
    .await;
    // Nothing missed, and nothing read with tomsj's own token.
    assert!(!degraded(&s, &b).await);
    assert_eq!(graphql_calls(&s).await.1, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relates_to_between_private_repos_of_two_installations_leaves_sync_healthy() {
    let s = start_on(twin_repo_fixture(), |_| {}).await;
    let b = s.sign_in("tomsj").await;
    let me = &unlinked("web")[0];
    // Each repo's delivery names only its own issue, and neither installation's token sees the
    // other private repo. No sweep can find the other end either (it reads with the same
    // tokens), so marking the account would leave sync degraded for good: it's only logged.
    edit_acme_web(&s, me, json!({ "add_relates_to": "acme-labs/web#1" })).await;
    // Both sides were read back with their installations' tokens, never with tomsj's.
    until(5.0, "both read-backs", || async {
        (graphql_calls(&s).await.0 >= 2).then_some(())
    })
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!degraded(&s, &b).await);
    assert_eq!(graphql_calls(&s).await.1, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relationship_into_an_unsynced_repo_is_a_stub_until_none_needs_it() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let me = &web[0];
    // partner-sdk isn't synced (the App isn't even installed there) but it's public. No other
    // edge references this one.
    let number = summary()["unlinked_stubs"][0].as_i64().unwrap();
    let stub = ("partner-sdk".to_owned(), number, 0);

    edit(&s, me, json!({ "add_relates_to": reference(&stub) })).await;
    let d = until(3.0, "the stub", || async {
        let d = detail(&s, &b, me.2).await;
        (!rel_ids(&d, "relates_to").is_empty()).then_some(d)
    })
    .await;
    let it = &d["relationships"]["relates_to"][0];
    assert_eq!(it["stub"], true);
    assert_eq!(it["repo"], "partner-sdk");
    assert_eq!(it["owner"], "acme");
    assert_eq!(it["number"], number);
    assert!(it["title"].as_str().is_some_and(|t| !t.is_empty()));
    let stub_id = it["id"].as_i64().unwrap();
    // A stub isn't an issue beghu holds: it links out to GitHub.
    let (status, body) = s
        .api(&mut b.clone(), &format!("/api/issues/{stub_id}"))
        .await;
    assert_eq!((status, body["error"].clone()), (403, json!("no_access")));
    assert_eq!(body["issue"]["repo"], "partner-sdk");

    // Removed, and no other relationship references it: the stub goes.
    edit(&s, me, json!({ "remove_relates_to": reference(&stub) })).await;
    until(3.0, "the stub going", || async {
        let (status, _) = s
            .api(&mut b.clone(), &format!("/api/issues/{stub_id}"))
            .await;
        (status == 404).then_some(())
    })
    .await;
    assert_eq!(
        rel_ids(&detail(&s, &b, me.2).await, "relates_to"),
        Vec::<i64>::new()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn progress_counts_every_descendant_closed_against_total() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let (top, mid, leaf, other) = (&web[0], &web[1], &web[2], &web[3]);
    // top > mid > leaf, and top > other; leaf closed.
    edit(&s, top, json!({ "add_sub_issue": reference(mid) })).await;
    edit(&s, mid, json!({ "add_sub_issue": reference(leaf) })).await;
    edit(&s, top, json!({ "add_sub_issue": reference(other) })).await;
    edit(&s, leaf, json!({ "state": "closed" })).await;

    let d = until(4.0, "the tree and the close", || async {
        let d = detail(&s, &b, top.2).await;
        (d["relationships"]["sub_issues"][0]["progress"] == json!({ "done": 1, "total": 1 })
            && rel_ids(&d, "sub_issues").len() == 2)
            .then_some(d)
    })
    .await;
    // In GitHub's order.
    assert_eq!(rel_ids(&d, "sub_issues"), [mid.2, other.2]);
    assert_eq!(
        row(&s, &b, top.2).await["progress"],
        json!({ "done": 1, "total": 3 })
    );
    assert_eq!(
        row(&s, &b, mid.2).await["progress"],
        json!({ "done": 1, "total": 1 })
    );
    assert_eq!(row(&s, &b, other.2).await["progress"], Value::Null);
    // The breadcrumb's parent carries its own progress.
    let m = detail(&s, &b, mid.2).await;
    assert_eq!(m["relationships"]["parent"]["id"], top.2);
    assert_eq!(
        m["relationships"]["parent"]["progress"],
        json!({ "done": 1, "total": 3 })
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_row_carries_up_to_8_open_blockers_with_what_its_hover_card_shows() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let (web, api) = (unlinked("web"), unlinked("api"));
    let blocked = &web[0];
    let blockers: Vec<_> = web[1..].iter().chain(api.iter()).take(10).collect();
    for x in &blockers {
        edit(&s, blocked, json!({ "add_blocked_by": reference(x) })).await;
    }
    // One closed blocker doesn't count; one blocker is itself blocked.
    edit(&s, blockers[0], json!({ "state": "closed" })).await;
    edit(
        &s,
        blockers[1],
        json!({ "add_blocked_by": reference(&web[7]) }),
    )
    .await;

    // The chained blocker's own dependency arrives in its own deliveries.
    let chained = |r: &Value| {
        r["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == blockers[1].2)
            .map(|c| c["blocked_by"] == 1)
    };
    let r = until(5.0, "every blocker, one itself blocked", || async {
        let r = row(&s, &b, blocked.2).await;
        (r["blocked_by"] == 9 && chained(&r) == Some(true)).then_some(r)
    })
    .await;
    let chips = r["blockers"].as_array().unwrap();
    assert_eq!(chips.len(), 8);
    assert!(chips.iter().all(|c| c["id"] != blockers[0].2));
    for c in chips {
        assert!(c["title"].as_str().is_some_and(|t| !t.is_empty()));
        assert!(c.get("assignee").is_some());
        assert!(c["updated_at"].as_i64().is_some());
    }
    let d = detail(&s, &b, blocked.2).await;
    assert_eq!(rel_ids(&d, "blocked_by").len(), 10);
}

#[tokio::test(flavor = "multi_thread")]
async fn two_accounts_with_different_access_see_different_relationships_for_the_same_issue() {
    let s = start().await;
    // ilze-k loses access to api; signing in again re-reads what she can see.
    s.fake(
        "PUT",
        "/permissions",
        json!({ "login": "ilze-k", "repo": "api", "role": null }),
    )
    .await;
    let owner = s.sign_in("tomsj").await;
    let member = s.sign_in("ilze-k").await;
    let (web, api, docs) = (unlinked("web"), unlinked("api"), unlinked("docs"));
    let (me, near, far, both) = (&web[0], &web[1], &api[0], &docs[0]);

    edit(&s, me, json!({ "add_blocked_by": reference(near) })).await;
    edit(&s, me, json!({ "add_blocked_by": reference(far) })).await;
    // Across repos, so only a read-back brings it, and that read-back sees `far` too.
    edit(&s, me, json!({ "add_blocked_by": reference(both) })).await;
    let mine = until(5.0, "the read-back for the member", || async {
        let d = detail(&s, &member, me.2).await;
        rel_ids(&d, "blocked_by").contains(&both.2).then_some(d)
    })
    .await;
    assert_eq!(rel_ids(&mine, "blocked_by"), [near.2, both.2]);
    assert_eq!(row(&s, &member, me.2).await["blocked_by"], 2);
    let theirs = until(3.0, "every dependency for the owner", || async {
        let d = detail(&s, &owner, me.2).await;
        (rel_ids(&d, "blocked_by").len() == 3).then_some(d)
    })
    .await;
    assert_eq!(rel_ids(&theirs, "blocked_by"), [near.2, far.2, both.2]);
}

#[tokio::test(flavor = "multi_thread")]
async fn dependencies_are_listed_in_one_order_whatever_order_they_arrived_in() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let (me, first, second) = (&web[0], &web[1], &web[2]);
    assert!(first.2 < second.2);
    // Added the other way round.
    edit(&s, me, json!({ "add_blocked_by": reference(second) })).await;
    edit(&s, me, json!({ "add_blocked_by": reference(first) })).await;
    let d = until(5.0, "both blockers", || async {
        let d = detail(&s, &b, me.2).await;
        (rel_ids(&d, "blocked_by").len() == 2).then_some(d)
    })
    .await;
    assert_eq!(rel_ids(&d, "blocked_by"), [first.2, second.2]);
    let chips: Vec<i64> = row(&s, &b, me.2).await["blockers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_i64().unwrap())
        .collect();
    assert_eq!(chips, [first.2, second.2]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relationship_into_a_private_repo_the_account_sees_but_doesnt_sync_is_kept_as_a_stub() {
    let s = start().await;
    // ilze-k loses access to api; tomsj still sees it, but picks it out of the repos it syncs.
    s.fake(
        "PUT",
        "/permissions",
        json!({ "login": "ilze-k", "repo": "api", "role": null }),
    )
    .await;
    let mut owner = s.sign_in("tomsj").await;
    let member = s.sign_in("ilze-k").await;
    let api_id = summary_repo_id(&s, &owner, "api").await;
    let (_, picker) = s.api(&mut owner, "/api/repos").await;
    let keep: Vec<i64> = picker["repos"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .filter(|id| *id != api_id)
        .collect();
    let res = s
        .http
        .put(format!("{}/api/repos", s.server))
        .header("cookie", owner.header())
        .header("origin", &s.server)
        .json(&json!({ "repos": keep }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let (web, api) = (unlinked("web"), unlinked("api"));
    let (me, far) = (&web[0], &api[0]);

    edit(&s, me, json!({ "add_blocked_by": reference(far) })).await;
    // tomsj can see api: the blocker stays, as a stub with a link out.
    let mine = until(5.0, "the read-back for the owner", || async {
        let d = detail(&s, &owner, me.2).await;
        (rel_ids(&d, "blocked_by") == [far.2]).then_some(d)
    })
    .await;
    assert_eq!(
        mine["relationships"]["blocked_by"][0]["stub"], true,
        "{mine}"
    );
    assert_eq!(
        mine["relationships"]["blocked_by"][0]["repo"], "api",
        "{mine}"
    );
    // ilze-k can't: she never holds it.
    tokio::time::sleep(Duration::from_secs(1)).await;
    let theirs = detail(&s, &member, me.2).await;
    assert_eq!(
        rel_ids(&theirs, "blocked_by"),
        Vec::<i64>::new(),
        "{theirs}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_issue_deleted_by_a_webhook_never_gets_a_relationship_again() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let (web, api) = (unlinked("web"), unlinked("api"));
    let (me, gone, later) = (&web[0], &web[1], &api[0]);
    let repo = summary_repo_id(&s, &b, "web").await;
    s.deliver(
        "issues",
        "del-1",
        &envelope(repo, "deleted", json!({ "issue": issue(gone) })),
    )
    .await;
    // A late delivery of a dependency on it (GitHub sent it before the delete), and on GitHub
    // the dependency is still there for the read-back to find.
    edit(&s, me, json!({ "add_blocked_by": reference(gone) })).await;
    s.deliver(
        "issue_dependencies",
        "dep-1",
        &envelope(repo, "blocked_by_added", blocked_by(me, gone)),
    )
    .await;
    // A cross-repo dependency arrives only through a read-back of all of `me`'s dependencies,
    // which on GitHub still include the deleted one.
    edit(&s, me, json!({ "add_blocked_by": reference(later) })).await;
    let d = until(5.0, "the read-back after the late delivery", || async {
        let d = detail(&s, &b, me.2).await;
        rel_ids(&d, "blocked_by").contains(&later.2).then_some(d)
    })
    .await;
    assert_eq!(rel_ids(&d, "blocked_by"), [later.2]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_back_corrects_a_stale_delivery_that_a_lagging_mirror_applies_late() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let account = s.api(&mut b, "/api/me").await.1["account"]["id"]
        .as_i64()
        .unwrap();
    let web = unlinked("web");
    let (me, other, unrelated) = (&web[0], &web[1], &web[2]);
    let repo = summary_repo_id(&s, &b, "web").await;

    // Another writer holds the account's mirror, so its lane lags: a delivery ahead of the stale
    // one waits on the mirror, and the stale one waits behind it.
    let mirror = s.data.join("mirrors").join(format!("{account}.db"));
    let lock = WriteLock::take(&mirror);
    s.deliver(
        "issues",
        "lag-1",
        &envelope(repo, "edited", json!({ "issue": issue(unrelated) })),
    )
    .await;
    // GitHub had this dependency once; it's gone now, and this delivery of it is stale.
    s.deliver(
        "issue_dependencies",
        "stale-1",
        &envelope(repo, "blocked_by_added", blocked_by(me, other)),
    )
    .await;
    // Held past the 2 s debounce that a read-back scheduled on receipt would have waited out: no
    // read-back may ask GitHub anything while the stale delivery waits on the mirror.
    let acked = Instant::now();
    while acked.elapsed() < Duration::from_millis(2500) {
        let state = s.fake("GET", "/state", json!({})).await;
        assert_eq!(
            state["installation_tokens"],
            json!([]),
            "a read-back ran before its delivery applied"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    drop(lock);

    until(3.0, "the stale dependency applying", || async {
        let d = detail(&s, &b, me.2).await;
        (rel_ids(&d, "blocked_by") == [other.2]).then_some(())
    })
    .await;
    // The read-back after it puts GitHub's state back.
    until(4.0, "the read-back removing it", || async {
        let d = detail(&s, &b, me.2).await;
        rel_ids(&d, "blocked_by").is_empty().then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_back_github_fails_is_tried_again_until_it_lands() {
    let s = start_with(|c| c.read_back_retries = vec![Duration::from_millis(100); 15]).await;
    let b = s.sign_in("tomsj").await;
    let (web, api) = (unlinked("web"), unlinked("api"));
    let (blocked, blocker) = (&web[0], &api[0]);
    // More failures than the two read-backs (one per repo) used to try between them.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "POST /graphql", "count": 10, "status": 502 }),
    )
    .await;

    // Across repos: only a read-back can bring it.
    edit(&s, blocked, json!({ "add_blocked_by": reference(blocker) })).await;
    until(6.0, "the dependency, once GitHub answers", || async {
        let d = detail(&s, &b, blocked.2).await;
        (rel_ids(&d, "blocked_by") == [blocker.2]).then_some(())
    })
    .await;
    let other = detail(&s, &b, blocker.2).await;
    assert_eq!(rel_ids(&other, "blocking"), [blocked.2]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cross_repo_delivery_during_a_retry_wait_is_read_back_at_once() {
    let s = start_with(|c| c.read_back_retries = vec![Duration::from_secs(60)]).await;
    let b = s.sign_in("tomsj").await;
    let (web, api) = (unlinked("web"), unlinked("api"));
    let (blocked, blocker) = (&web[0], &api[0]);
    let repo = summary_repo_id(&s, &b, "web").await;
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "POST /graphql", "count": 1000, "status": 502 }),
    )
    .await;
    // The first read-backs fail, and wait a minute for their retry.
    edit(&s, blocked, json!({ "add_blocked_by": reference(blocker) })).await;
    until(5.0, "both read-backs failing", || async {
        (graphql_failures(&s).await >= 2).then_some(())
    })
    .await;
    s.fake("DELETE", "/faults", json!({})).await;

    // Another cross-repo delivery about the blocked issue: GitHub sends no blocker with it.
    s.deliver(
        "issue_dependencies",
        "again-1",
        &envelope(
            repo,
            "blocked_by_added",
            json!({ "blocked_issue_id": blocked.2, "blocked_issue": issue(blocked) }),
        ),
    )
    .await;
    until(2.5, "the dependency, read back at once", || async {
        let d = detail(&s, &b, blocked.2).await;
        (rel_ids(&d, "blocked_by") == [blocker.2]).then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_back_pending_when_the_server_stops_runs_after_the_restart() {
    let mut s = start_with(|c| c.read_back_retries = vec![Duration::from_secs(60)]).await;
    let b = s.sign_in("tomsj").await;
    let (web, api) = (unlinked("web"), unlinked("api"));
    let (blocked, blocker) = (&web[0], &api[0]);
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "POST /graphql", "count": 1000, "status": 502 }),
    )
    .await;
    // Across repos, so only the read-backs bring it; they fail, and wait a minute to try again.
    edit(&s, blocked, json!({ "add_blocked_by": reference(blocker) })).await;
    until(5.0, "both read-backs failing", || async {
        (graphql_failures(&s).await >= 2).then_some(())
    })
    .await;
    s.fake("DELETE", "/faults", json!({})).await;

    // The process stops while they wait; the new one reads them back.
    s.restart_with(|_| {}).await;
    until(3.0, "the dependency, after the restart", || async {
        let d = detail(&s, &b, blocked.2).await;
        (rel_ids(&d, "blocked_by") == [blocker.2]).then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_drain_doesnt_wait_for_a_read_back_and_the_next_server_reads_it_back() {
    let mut s = start_with(|c| c.read_back_retries = vec![Duration::from_secs(60)]).await;
    let b = s.sign_in("tomsj").await;
    let (web, api) = (unlinked("web"), unlinked("api"));
    let (blocked, blocker) = (&web[0], &api[0]);
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "POST /graphql", "count": 1000, "status": 502 }),
    )
    .await;
    edit(&s, blocked, json!({ "add_blocked_by": reference(blocker) })).await;
    until(5.0, "both read-backs failing", || async {
        (graphql_failures(&s).await >= 2).then_some(())
    })
    .await;
    s.fake("DELETE", "/faults", json!({})).await;

    // Its deliveries stay unprocessed while the read-backs wait, yet the drain has no writes to
    // wait for: it stops well inside its 25 s.
    let t = Instant::now();
    let stopped = s.sigterm();
    tokio::time::timeout(Duration::from_secs(5), stopped)
        .await
        .expect("the drain stops without the read-backs")
        .unwrap()
        .unwrap();
    assert!(t.elapsed() < Duration::from_secs(5));

    s.restart_with(|_| {}).await;
    until(3.0, "the dependency, after the restart", || async {
        let d = detail(&s, &b, blocked.2).await;
        (rel_ids(&d, "blocked_by") == [blocker.2]).then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn read_backs_github_fails_count_toward_github_down() {
    let s = start_with(|c| {
        c.read_back_retries = vec![Duration::from_millis(100); 15];
        c.github_probe_every = Duration::from_millis(300);
    })
    .await;
    let b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    assert_eq!(
        st.github_within(Duration::from_secs(1)).await.as_deref(),
        Some("up")
    );
    let (web, api) = (unlinked("web"), unlinked("api"));
    // Only the installation token's GraphQL read-backs call GitHub here, and each meets a 502.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "POST /graphql", "count": 1000, "status": 502 }),
    )
    .await;
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "/rate_limit", "count": 1000, "status": 503 }),
    )
    .await;
    edit(&s, &web[0], json!({ "add_blocked_by": reference(&api[0]) })).await;
    assert_eq!(
        st.github_within(Duration::from_secs(5)).await.as_deref(),
        Some("down")
    );
    s.fake("DELETE", "/faults", json!({})).await;
    assert_eq!(
        st.github_within(Duration::from_secs(5)).await.as_deref(),
        Some("up")
    );
}

/// How many calls the `POST /graphql` fail rule has failed so far (of its 1000).
async fn graphql_failures(s: &Stack) -> u64 {
    let state = s.fake("GET", "/state", json!({})).await;
    state["faults"]["fail"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["endpoint"] == "POST /graphql")
        .map_or(1000, |f| 1000 - f["remaining"].as_u64().unwrap())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_back_github_never_answers_marks_every_account_syncing_the_repo_for_resync() {
    let s = start_with(|c| c.read_back_retries = vec![Duration::from_millis(50); 2]).await;
    let owner = s.sign_in("tomsj").await;
    let member = s.sign_in("ilze-k").await;
    let browsers = [&owner, &member];
    let (web, api) = (unlinked("web"), unlinked("api"));
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "POST /graphql", "count": 1000, "status": 502 }),
    )
    .await;
    for b in browsers {
        assert!(!degraded(&s, b).await);
    }

    edit(&s, &web[0], json!({ "add_blocked_by": reference(&api[0]) })).await;
    until(5.0, "both accounts marked for resync", || async {
        let mut all = true;
        for b in browsers {
            all &= degraded(&s, b).await;
        }
        all.then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_back_github_answers_with_no_issue_marks_the_accounts_for_resync() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let repo = summary_repo_id(&s, &b, "web").await;
    // A node id GitHub doesn't know: deleted, transferred, or out of the installation's sight.
    let mut unknown = issue(&web[0]);
    unknown["node_id"] = json!("I_unknown");
    s.deliver(
        "issue_dependencies",
        "unknown-1",
        &envelope(
            repo,
            "blocked_by_added",
            json!({
                "blocked_issue_id": web[0].2, "blocked_issue": unknown,
                "blocking_issue_id": web[1].2, "blocking_issue": issue(&web[1]),
            }),
        ),
    )
    .await;
    until(5.0, "the account marked for resync", || async {
        degraded(&s, &b).await.then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_back_of_an_issue_deleted_since_marks_nothing_for_resync() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let gone = &web[0];
    let repo = summary_repo_id(&s, &b, "web").await;
    s.deliver(
        "issues",
        "del-2",
        &envelope(repo, "deleted", json!({ "issue": issue(gone) })),
    )
    .await;
    // A late cross-repo delivery about it: GitHub no longer has the issue to read back.
    let mut late = issue(gone);
    late["node_id"] = json!("I_deleted");
    s.deliver(
        "issue_dependencies",
        "late-1",
        &envelope(
            repo,
            "blocked_by_added",
            json!({ "blocked_issue_id": gone.2, "blocked_issue": late }),
        ),
    )
    .await;
    // TODO(#92 follow-up): a public sync point. Nothing outside shows that this read-back has
    // ended (it changes nothing), so the test reads the control DB.
    until(5.0, "the delivery settled after its read-back", || async {
        processed(&s, "late-1").then_some(())
    })
    .await;
    assert!(!degraded(&s, &b).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_back_for_a_removed_installation_gives_up_at_once() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let repo = summary_repo_id(&s, &b, "web").await;
    // An installation GitHub no longer has: its token request is a 404, and no retry (the
    // default ones take minutes) would get a different answer.
    let mut d = envelope(repo, "blocked_by_added", blocked_by(&web[0], &web[1]));
    d["installation"]["id"] = json!(41009999);
    s.deliver("issue_dependencies", "gone-1", &d).await;
    until(3.0, "the account marked for resync", || async {
        degraded(&s, &b).await.then_some(())
    })
    .await;
}

/// A delivery naming only `me`, as one across repos does: its read-back runs at once.
fn cross_repo_blocked_by(repo: i64, me: &(String, i64, i64)) -> Value {
    envelope(
        repo,
        "blocked_by_added",
        json!({ "blocked_issue_id": me.2, "blocked_issue": issue(me) }),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn a_delivery_within_a_repo_never_holds_off_a_read_back_due_at_once() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let me = &web[0];
    let repo = summary_repo_id(&s, &b, "web").await;
    // Each read-back takes a second, so the next one is due while the first still runs.
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": "POST /graphql", "ms": 1000 }),
    )
    .await;
    s.deliver(
        "issue_dependencies",
        "x-1",
        &cross_repo_blocked_by(repo, me),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let before = issue_edges(&s).await;
    let sent = Instant::now();
    s.deliver(
        "issue_dependencies",
        "x-2",
        &cross_repo_blocked_by(repo, me),
    )
    .await;
    // Within the repo: on its own it would wait out the 2 s debounce.
    s.deliver(
        "issue_dependencies",
        "same-1",
        &envelope(repo, "blocked_by_added", blocked_by(me, &web[1])),
    )
    .await;
    // x-2's read-back starts as soon as the first ends, about 0.8 s on, and takes a second:
    // GitHub answers it once the latency is through.
    until(5.0, "x-2's read-back answered", || async {
        (issue_edges(&s).await >= before + 2).then_some(())
    })
    .await;
    assert!(
        sent.elapsed() < Duration::from_millis(2400),
        "{:?}",
        sent.elapsed()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn deliveries_during_a_failing_read_back_do_not_restart_its_retries() {
    let s = start_with(|c| c.read_back_retries = vec![Duration::from_millis(500); 2]).await;
    let b = s.sign_in("tomsj").await;
    let me = &unlinked("web")[0];
    let repo = summary_repo_id(&s, &b, "web").await;
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "POST /graphql", "count": 1000, "status": 502 }),
    )
    .await;
    // A delivery every 200 ms brings each next try forward, but they all count: the third
    // failure is the last, however many deliveries keep coming.
    let started = Instant::now();
    for n in 0.. {
        if degraded(&s, &b).await {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "still retrying after {n} deliveries"
        );
        s.deliver(
            "issue_dependencies",
            &format!("x-{n}"),
            &cross_repo_blocked_by(repo, me),
        )
        .await;
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_steady_stream_of_deliveries_holds_a_read_back_off_for_at_most_10_s() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let (me, hidden, other) = (&web[0], &web[1], &web[2]);
    let repo = summary_repo_id(&s, &b, "web").await;
    // A dependency only GitHub knows of: both its deliveries are lost.
    s.fake("POST", "/faults/webhooks", json!({ "drop": 2 }))
        .await;
    edit(&s, me, json!({ "add_blocked_by": reference(hidden) })).await;

    // A delivery about `me`'s dependencies every second, each restarting the 2 s debounce.
    let first = Instant::now();
    let mut seen = None;
    for n in 0..14 {
        let d = envelope(repo, "blocked_by_removed", blocked_by(me, other));
        s.deliver("issue_dependencies", &format!("steady-{n}"), &d)
            .await;
        tokio::time::sleep(Duration::from_secs(1)).await;
        if rel_ids(&detail(&s, &b, me.2).await, "blocked_by") == [hidden.2] {
            seen = Some(first.elapsed());
            break;
        }
    }
    let seen = seen.expect("a read-back ran while the deliveries kept coming");
    assert!(seen < Duration::from_secs(12), "{seen:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_back_keeps_every_relates_to_past_the_first_page() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let (web, api, docs) = (unlinked("web"), unlinked("api"), unlinked("docs"));
    let me = &web[0];
    // 100 other open web issues.
    let mut others = Vec::new();
    let mut path = "/api/issues".to_owned();
    while others.len() < 100 {
        let (_, page) = s.api(&mut b.clone(), &path).await;
        for r in page["rows"].as_array().unwrap() {
            if r["repo"] == "web" && r["id"] != me.2 && others.len() < 100 {
                others.push(format!("web#{}", r["number"]));
            }
        }
        path = format!("/api/issues?after={}", page["next"].as_str().unwrap());
    }

    // The oldest link (GitHub lists the newest first, 100 to a page), then 100 more, then one
    // across repos: only a read-back brings that one, and it reads every link.
    edit(&s, me, json!({ "add_relates_to": reference(&api[0]) })).await;
    for o in &others {
        edit(&s, me, json!({ "add_relates_to": o })).await;
    }
    edit(&s, me, json!({ "add_relates_to": reference(&docs[0]) })).await;
    let d = until(15.0, "the read-back after the last link", || async {
        let d = detail(&s, &b, me.2).await;
        rel_ids(&d, "relates_to").contains(&docs[0].2).then_some(d)
    })
    .await;
    let ids = rel_ids(&d, "relates_to");
    assert!(ids.contains(&api[0].2), "the 102nd link is kept");
    assert_eq!(ids.len(), 102);
}

#[tokio::test(flavor = "multi_thread")]
async fn read_backs_share_one_installation_token_that_can_only_read_issues() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let (web, api) = (unlinked("web"), unlinked("api"));
    // A slow token endpoint: the two read-backs (one per repo) both wait on a token at once.
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": "POST /app/installations/*/access_tokens", "ms": 500 }),
    )
    .await;

    edit(&s, &web[0], json!({ "add_blocked_by": reference(&api[0]) })).await;
    until(5.0, "both ends", || async {
        let x = detail(&s, &b, web[0].2).await;
        let y = detail(&s, &b, api[0].2).await;
        (rel_ids(&x, "blocked_by") == [api[0].2] && rel_ids(&y, "blocking") == [web[0].2])
            .then_some(())
    })
    .await;
    let state = s.fake("GET", "/state", json!({})).await;
    assert_eq!(
        state["installation_tokens"],
        json!([{ "installation": 41000001, "permissions": { "issues": "read" } }])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn read_backs_waiting_on_a_token_that_github_refuses_share_the_one_refusal() {
    let s = start_with(|c| c.read_back_retries = Vec::new()).await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let repo = summary_repo_id(&s, &b, "web").await;
    let tokens = "POST /app/installations/*/access_tokens";
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": tokens, "ms": 500 }),
    )
    .await;
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": tokens, "count": 1000, "status": 500 }),
    )
    .await;

    // Four cross-repo deliveries, each read back at once: all four wait on one token request.
    let guids: Vec<String> = (0..4).map(|n| format!("mint-{n}")).collect();
    for (u, guid) in web.iter().zip(&guids) {
        let d = envelope(
            repo,
            "blocked_by_added",
            json!({ "blocked_issue_id": u.2, "blocked_issue": issue(u) }),
        );
        s.deliver("issue_dependencies", guid, &d).await;
    }
    // Each read-back gives up at the token's refusal, which marks the account.
    until(5.0, "the read-backs given up", || async {
        degraded(&s, &b).await.then_some(())
    })
    .await;
    // Any read-back still to ask for a token of its own would have by now.
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let state = s.fake("GET", "/state", json!({})).await;
    let rule = &state["faults"]["fail"][0];
    assert_eq!(rule["endpoint"], tokens);
    assert_eq!(
        rule["remaining"], 999,
        "one token request, not one per read-back"
    );
}

/// Whether the account's sync shows as degraded: what a missed change (an account marked for a
/// sweep to repair) looks like from outside.
async fn degraded(s: &Stack, b: &Browser) -> bool {
    s.api(&mut b.clone(), "/api/me").await.1["sync"]["degraded"] == true
}

/// How many `IssueEdges` read-backs GitHub has answered (after any latency the test set).
async fn issue_edges(s: &Stack) -> u64 {
    s.fake("GET", "/state", json!({})).await["graphql"]["operations"]["IssueEdges"]
        .as_u64()
        .unwrap_or(0)
}

/// Whether the delivery is marked processed: applied, and its read-back landed or given up. No
/// HTTP seam shows it (redelivery reads GitHub's log, not this), so the test reads the control
/// DB: only where nothing else can say the read-back is over.
fn processed(s: &Stack, guid: &str) -> bool {
    let db = rusqlite::Connection::open(s.control_db()).unwrap();
    control_db::q::pending_delivery(&db, guid)
        .unwrap()
        .is_none()
}

/// `u`'s GraphQL node id, as the fixture made it.
fn node_id(u: &(String, i64, i64)) -> String {
    summary()["unlinked"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == u.2)
        .unwrap()["node_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// `u` as a delivery carries it, dated long before the fixture so it never changes the row.
fn issue(u: &(String, i64, i64)) -> Value {
    json!({
        "id": u.2, "node_id": node_id(u), "number": u.1, "title": "x", "state": "open",
        "updated_at": "2020-01-01T00:00:00Z",
        "repository_url": format!("https://api.github.com/repos/acme/{}", u.0),
    })
}

/// A delivery to the web repo (`repo`) as GitHub sends it, with `fields` added.
fn envelope(repo: i64, action: &str, fields: Value) -> Value {
    let mut p = json!({
        "action": action,
        "repository": { "id": repo, "name": "web", "full_name": "acme/web" },
        "installation": { "id": 41000001 },
    });
    for (k, v) in fields.as_object().unwrap() {
        p[k] = v.clone();
    }
    p
}

/// The fields of an `issue_dependencies` delivery: `blocker` blocks `blocked`.
fn blocked_by(blocked: &(String, i64, i64), blocker: &(String, i64, i64)) -> Value {
    json!({
        "blocked_issue_id": blocked.2, "blocked_issue": issue(blocked),
        "blocking_issue_id": blocker.2, "blocking_issue": issue(blocker),
    })
}

/// The id of the synced repo called `name`.
async fn summary_repo_id(s: &Stack, b: &Browser, name: &str) -> i64 {
    let (_, me) = s.api(&mut b.clone(), "/api/me").await;
    me["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == name)
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

/// `id`'s row in the view `q`, paging until it's found, and the cursor of the last row of the
/// page it's on: what the list has loaded once it shows the row.
async fn row_in(s: &Stack, b: &Browser, q: &str, id: i64) -> (Value, String) {
    let base = format!(
        "/api/issues?{}",
        serde_urlencoded::to_string([("q", q)]).unwrap()
    );
    let mut path = base.clone();
    loop {
        let (status, page) = s.api(&mut b.clone(), &path).await;
        assert_eq!(status, 200, "{path}: {page}");
        let last = page["last"].as_str().map(str::to_owned);
        if let Some(r) = page["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == id)
        {
            return (r.clone(), last.unwrap());
        }
        let next = page["next"]
            .as_str()
            .unwrap_or_else(|| panic!("{id} in {q}"));
        path = format!("{base}&after={next}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rows_blockers_and_progress_come_with_it_under_every_filter_and_sort_and_refetch() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let (blocked, blocker, top, sub) = (&web[0], &web[1], &web[2], &web[3]);
    edit(&s, blocked, json!({ "add_blocked_by": reference(blocker) })).await;
    edit(&s, top, json!({ "add_sub_issue": reference(sub) })).await;
    edit(&s, top, json!({ "add_sub_issue": reference(blocked) })).await;
    edit(&s, sub, json!({ "state": "closed" })).await;
    let want_progress = json!({ "done": 1, "total": 2 });
    let (r, t) = until(4.0, "the dependency and the sub-issues", || async {
        let r = row(&s, &b, blocked.2).await;
        let t = row(&s, &b, top.2).await;
        (r["blocked_by"] == 1 && t["progress"] == want_progress).then_some((r, t))
    })
    .await;
    let blockers = r["blockers"].clone();
    assert_eq!(blockers[0]["id"], blocker.2);

    let mut views = vec![
        "is:open repo:web".to_owned(),
        "is:issue no:milestone".into(),
    ];
    for sort in ["updated", "created", "closed", "commented", "comments"] {
        for dir in ["", "-asc"] {
            views.push(format!("is:open sort:{sort}{dir}"));
        }
    }
    for (id, title, field, want) in [
        (blocked.2, &r["title"], "blockers", &blockers),
        (top.2, &t["title"], "progress", &want_progress),
    ] {
        // Free text, too: the row's own title.
        let text = format!("is:open {}", title.as_str().unwrap());
        for q in views.iter().chain([&text]) {
            let (r, last) = row_in(&s, &b, q, id).await;
            assert_eq!(&r[field], want, "{q}: {id}'s {field}");
            // A live refetch through what's loaded carries them too.
            let path = format!(
                "/api/issues?{}",
                serde_urlencoded::to_string([("q", q.as_str()), ("through", &last)]).unwrap()
            );
            let (status, page) = s.api(&mut b.clone(), &path).await;
            assert_eq!(status, 200, "{path}: {page}");
            let again = page["rows"]
                .as_array()
                .unwrap()
                .iter()
                .find(|x| x["id"] == id)
                .unwrap_or_else(|| panic!("{q}: {id} in the refetch"));
            assert_eq!(&again[field], want, "{q}: {id}'s {field}, refetched");
        }
    }
}

//! PRs: read-only rows and detail beside the issues, their linked PRs ("Closes" on the PR, "Linked
//! PRs" on the issue), and what keeps them fresh: a PR's `pull_request` and `pull_request_review`
//! deliveries read it back, and the events-feed poller catches a link made in GitHub's
//! Development sidebar, which sends no webhook. Every change is made on Fake GitHub.

mod common;

use common::{Browser, Stack, start_with, summary};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

/// How long a change may take to land at all on a loaded machine. The live budget (~1–3 s) is
/// printed by the tests that time it, and held by the browser suite to the tab's share
/// (web/e2e/push.ts); the server's legs alone can take seconds on a loaded machine.
const WAIT: f64 = 15.0;

/// The poller at its real pace (the harness keeps it out of other tests' way).
fn polling(c: &mut beghu::Config) {
    c.reconcile.feed_every = Duration::from_secs(2);
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

fn ids(d: &Value, list: &str) -> Vec<i64> {
    d[list]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect()
}

/// The first page of the list for `q`.
async fn rows(s: &Stack, b: &Browser, q: &str) -> Vec<Value> {
    let path = format!("/api/issues?q={}", urlencoded(q));
    let (status, page) = s.api(&mut b.clone(), &path).await;
    assert_eq!(status, 200, "{page}");
    page["rows"].as_array().unwrap().clone()
}

fn urlencoded(q: &str) -> String {
    serde_urlencoded::to_string([("q", q)]).unwrap()[2..].to_owned()
}

/// An open PR in `acme/web` that closes nothing: its row.
async fn bare_pr(s: &Stack, b: &Browser) -> Value {
    bare_prs(s, b, 1).await.remove(0)
}

/// `n` open PRs in `acme/web` that close nothing: their rows.
async fn bare_prs(s: &Stack, b: &Browser, n: usize) -> Vec<Value> {
    let mut out = Vec::new();
    for r in rows(s, b, "is:pr is:open repo:acme/web").await {
        if ids(&detail(s, b, r["id"].as_i64().unwrap()).await, "closes").is_empty() {
            out.push(r);
            if out.len() == n {
                return out;
            }
        }
    }
    panic!("fewer than {n} open PRs in acme/web close nothing");
}

/// The feed endpoint of `acme/web`, for faults.
const WEB_FEED: &str = "GET /repos/acme/web/issues/events";

/// Holds `acme/web`'s feed back from the poller: every read of it fails (a 404, which says
/// nothing about GitHub's health), until [`release_feed`].
async fn hold_feed(s: &Stack) {
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": WEB_FEED, "status": 404, "count": 100_000 }),
    )
    .await;
}

async fn release_feed(s: &Stack) {
    s.fake("DELETE", "/faults", json!({ "endpoint": WEB_FEED }))
        .await;
}

/// Waits for `n` more reads of `acme/web`'s feed than now.
async fn more_reads(s: &Stack, n: u64) {
    let (reads, _) = feed_reads(s).await;
    until(WAIT, "more reads of the feed", || async {
        (feed_reads(s).await.0 >= reads + n).then_some(())
    })
    .await;
}

/// Waits until PR `pr` shows among issue `issue`'s linked PRs.
async fn until_linked(s: &Stack, b: &Browser, issue: i64, pr: i64) {
    until(WAIT, "the linked PR", || async {
        ids(&detail(s, b, issue).await, "linked_prs")
            .contains(&pr)
            .then_some(())
    })
    .await;
}

/// The first fixture issues in `acme/web` with no relationships: `(number, id)`.
fn unlinked_web() -> Vec<(i64, i64)> {
    summary()["unlinked"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|u| u["repo"] == "web")
        .map(|u| (u["number"].as_i64().unwrap(), u["id"].as_i64().unwrap()))
        .collect()
}

/// An outside edit of PR `pr` (its row) on GitHub.
async fn edit_pr(s: &Stack, pr: &Value, fields: Value) {
    let mut e = json!({ "repo": "acme/web", "number": pr["number"] });
    for (k, v) in fields.as_object().unwrap() {
        e[k] = v.clone();
    }
    s.edit(e).await;
}

/// The fake's count of `op` GraphQL calls so far.
async fn operations(s: &Stack, op: &str) -> u64 {
    s.fake("GET", "/state", Value::Null).await["graphql"]["operations"][op]
        .as_u64()
        .unwrap_or(0)
}

/// How often `acme/web`'s events feed was read, and how many of those were 304s.
async fn feed_reads(s: &Stack) -> (u64, u64) {
    let state = s.fake("GET", "/state", Value::Null).await;
    let f = &state["feeds"]["acme/web"];
    (
        f["reads"].as_u64().unwrap_or(0),
        f["not_modified"].as_u64().unwrap_or(0),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn prs_list_only_under_is_pr_or_is_any_with_their_status_and_review() {
    let s = start_with(|_| {}).await;
    let b = s.sign_in("tomsj").await;

    let default = rows(&s, &b, "is:open").await;
    assert!(!default.is_empty());
    assert!(
        default
            .iter()
            .all(|r| r["kind"] == "issue" && r["pr"].is_null())
    );
    let prs = rows(&s, &b, "is:pr").await;
    assert!(!prs.is_empty());
    for r in &prs {
        assert_eq!(r["kind"], "pr", "{r}");
        let status = r["pr"]["status"].as_str().unwrap();
        assert!(
            ["open", "draft", "merged", "closed"].contains(&status),
            "{r}"
        );
        assert_eq!(status == "open" || status == "draft", r["state"] == "open");
        assert!(
            r["pr"]["review"].is_null()
                || ["approved", "changes_requested", "review_required"]
                    .contains(&r["pr"]["review"].as_str().unwrap()),
            "{r}"
        );
    }
    let any = rows(&s, &b, "is:any").await;
    assert!(any.iter().any(|r| r["kind"] == "pr"));
    assert!(any.iter().any(|r| r["kind"] == "issue"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_prs_detail_shows_its_branches_review_and_the_issues_it_closes_which_show_it_back() {
    let s = start_with(|_| {}).await;
    let b = s.sign_in("tomsj").await;
    // A fixture PR that closes an issue.
    let mut found = None;
    for r in rows(&s, &b, "is:pr").await {
        let d = detail(&s, &b, r["id"].as_i64().unwrap()).await;
        if !ids(&d, "closes").is_empty() {
            found = Some(d);
            break;
        }
    }
    let pr = found.expect("a fixture PR that closes an issue");
    assert_eq!(pr["kind"], "pr");
    assert!(
        pr["pr"]["head"].is_string() && pr["pr"]["base"].is_string(),
        "{pr}"
    );
    assert!(pr["pr"]["status"].is_string());
    assert_eq!(pr["linked_prs"], json!([]));
    let issue = &pr["closes"][0];
    assert_eq!(issue["kind"], "issue");
    assert!(issue["pr_status"].is_null());

    let back = detail(&s, &b, issue["id"].as_i64().unwrap()).await;
    assert!(back["pr"].is_null());
    let linked = back["linked_prs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["id"] == pr["id"])
        .expect("the issue lists the PR that closes it");
    assert_eq!(linked["kind"], "pr");
    assert_eq!(linked["pr_status"], pr["pr"]["status"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_closing_keyword_edit_shows_the_linked_pr_on_the_issue_within_seconds() {
    let s = start_with(|_| {}).await;
    let b = s.sign_in("tomsj").await;
    let pr = bare_pr(&s, &b).await;
    let pr_id = pr["id"].as_i64().unwrap();
    let (n, issue) = unlinked_web()[0];

    edit_pr(
        &s,
        &pr,
        json!({ "body": format!("Reworks the list.\n\nFixes #{n}") }),
    )
    .await;
    let sent = Instant::now();
    until(WAIT, "the linked PR", || async {
        ids(&detail(&s, &b, issue).await, "linked_prs")
            .contains(&pr_id)
            .then_some(())
    })
    .await;
    eprintln!("linked after {:?}", sent.elapsed());
    assert_eq!(ids(&detail(&s, &b, pr_id).await, "closes"), [issue]);

    // The keyword goes: so does the link.
    edit_pr(&s, &pr, json!({ "body": "Reworks the list." })).await;
    until(WAIT, "the link to go", || async {
        ids(&detail(&s, &b, issue).await, "linked_prs")
            .is_empty()
            .then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sidebar_link_shows_on_the_issue_within_seconds_while_a_stream_is_open() {
    let s = start_with(polling).await;
    let b = s.sign_in("tomsj").await;
    let pr = bare_pr(&s, &b).await;
    let pr_id = pr["id"].as_i64().unwrap();
    let (n, issue) = unlinked_web()[0];
    let _stream = s.stream(&b).await;
    until(WAIT, "the poller's first read", || async {
        (feed_reads(&s).await.0 > 0).then_some(())
    })
    .await;

    edit_pr(&s, &pr, json!({ "add_linked_issue": format!("#{n}") })).await;
    let sent = Instant::now();
    until(WAIT, "the linked PR", || async {
        ids(&detail(&s, &b, issue).await, "linked_prs")
            .contains(&pr_id)
            .then_some(())
    })
    .await;
    eprintln!("linked after {:?}", sent.elapsed());
    assert_eq!(ids(&detail(&s, &b, pr_id).await, "closes"), [issue]);

    edit_pr(&s, &pr, json!({ "remove_linked_issue": format!("#{n}") })).await;
    until(WAIT, "the link to go", || async {
        ids(&detail(&s, &b, issue).await, "linked_prs")
            .is_empty()
            .then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_poller_reads_a_feed_only_while_a_stream_is_open_and_an_unchanged_feed_is_a_304() {
    let s = start_with(|c| c.reconcile.feed_every = Duration::from_millis(300)).await;
    let b = s.sign_in("tomsj").await;
    // Signed in, no stream: nothing reads the feed.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(feed_reads(&s).await, (0, 0));

    let stream = s.stream(&b).await;
    let (reads, not_modified) = until(WAIT, "a few reads", || async {
        let r = feed_reads(&s).await;
        (r.0 >= 4).then_some(r)
    })
    .await;
    // Only the first read had anything to say; every one after it was a 304.
    assert!(
        not_modified >= reads - 1,
        "{reads} reads, {not_modified} 304s"
    );

    // The stream closes: the reads stop (one may be on its way).
    drop(stream);
    tokio::time::sleep(Duration::from_millis(600)).await;
    let stopped = feed_reads(&s).await.0;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(feed_reads(&s).await.0, stopped);
}

#[tokio::test(flavor = "multi_thread")]
async fn feed_events_out_of_id_order_are_each_acted_on_once() {
    let s = start_with(polling).await;
    let b = s.sign_in("tomsj").await;
    let prs = bare_prs(&s, &b, 3).await;
    let web = unlinked_web();
    let _stream = s.stream(&b).await;
    more_reads(&s, 2).await;
    let before = operations(&s, "PullReadBack").await;

    // Three PRs linked between two reads, so one read finds all three, their ids out of order
    // (the fake shuffles them): a poller that kept the highest id would act on some only.
    hold_feed(&s).await;
    for (pr, (n, _)) in prs.iter().zip(&web) {
        edit_pr(&s, pr, json!({ "add_linked_issue": format!("#{n}") })).await;
    }
    release_feed(&s).await;
    for (pr, (_, issue)) in prs.iter().zip(&web) {
        until_linked(&s, &b, *issue, pr["id"].as_i64().unwrap()).await;
    }
    // A newer event changes the feed, so the next read is a fresh page holding the three again:
    // none is acted on twice.
    s.edit(json!({ "repo": "acme/web", "number": web[3].0, "state": "closed" }))
        .await;
    more_reads(&s, 3).await;
    assert_eq!(operations(&s, "PullReadBack").await - before, 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_burst_of_events_between_two_reads_is_read_past_the_feeds_first_page() {
    let s = start_with(polling).await;
    let b = s.sign_in("tomsj").await;
    let prs = bare_prs(&s, &b, 2).await;
    let web = unlinked_web();
    let (first, (n, issue)) = (&prs[0], web[0]);
    let _stream = s.stream(&b).await;
    more_reads(&s, 2).await;

    // One link, then 240 newer events (a second PR linked and unlinked 60 times, each an event
    // on the PR and one on the issue): the link is on the third page by the next read.
    hold_feed(&s).await;
    edit_pr(&s, first, json!({ "add_linked_issue": format!("#{n}") })).await;
    let other = format!("#{}", web[1].0);
    for _ in 0..60 {
        edit_pr(&s, &prs[1], json!({ "add_linked_issue": other })).await;
        edit_pr(&s, &prs[1], json!({ "remove_linked_issue": other })).await;
    }
    release_feed(&s).await;
    until_linked(&s, &b, issue, first["id"].as_i64().unwrap()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repos_first_read_acts_on_every_link_on_its_page_however_old() {
    let s = start_with(polling).await;
    let b = s.sign_in("tomsj").await;
    let pr = bare_pr(&s, &b).await;
    let (n, issue) = unlinked_web()[0];
    // Linked an hour before anything reads the feed (no stream is open yet): a link has no other
    // trace, so the first read can't leave it to the sweeps.
    s.fake("PUT", "/clock", json!({ "offset": -3600 })).await;
    edit_pr(&s, &pr, json!({ "add_linked_issue": format!("#{n}") })).await;
    s.fake("PUT", "/clock", json!({ "offset": 0 })).await;

    let _stream = s.stream(&b).await;
    until_linked(&s, &b, issue, pr["id"].as_i64().unwrap()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pr_in_a_repo_not_synced_linked_in_the_sidebar_shows_on_the_issue_as_a_stub() {
    let s = start_with(polling).await;
    let mut b = s.sign_in("tomsj").await;
    let pr = rows(&s, &b, "is:pr is:open repo:acme/ops").await[0].clone();
    let (pr_id, pr_number) = (pr["id"].as_i64().unwrap(), pr["number"].as_i64().unwrap());
    let (n, issue) = unlinked_web()[0];
    // ops stops being synced: the installation still reaches it, so it may show as stubs.
    let (_, picker) = s.api(&mut b, "/api/repos").await;
    let keep: Vec<i64> = picker["repos"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["synced"] == true && r["name"] != "ops")
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    let res = s
        .http
        .put(format!("{}/api/repos", s.server))
        .header("cookie", b.header())
        .header("origin", &s.server)
        .json(&json!({ "repos": keep }))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "{}", res.status());
    until(WAIT, "ops unsynced", || async {
        let (_, facets) = s.api(&mut b.clone(), "/api/facets").await;
        (!facets["repos"].as_array().unwrap().contains(&json!("ops"))).then_some(())
    })
    .await;
    let _stream = s.stream(&b).await;
    more_reads(&s, 2).await;

    // Only web's feed is read, and its event names only the issue.
    let ops_pr = json!({ "repo": "acme/ops", "number": pr_number });
    let mut link = ops_pr.clone();
    link["add_linked_issue"] = json!(format!("acme/web#{n}"));
    s.edit(link).await;
    until_linked(&s, &b, issue, pr_id).await;
    let d = detail(&s, &b, issue).await;
    let linked = &d["linked_prs"][0];
    assert_eq!(linked["repo"], "ops", "{linked}");

    let mut unlink = ops_pr;
    unlink["remove_linked_issue"] = json!(format!("acme/web#{n}"));
    s.edit(unlink).await;
    until(WAIT, "the link to go", || async {
        ids(&detail(&s, &b, issue).await, "linked_prs")
            .is_empty()
            .then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_review_refreshes_the_prs_review_decision() {
    let s = start_with(|_| {}).await;
    let b = s.sign_in("tomsj").await;
    let pr = bare_pr(&s, &b).await;
    let pr_id = pr["id"].as_i64().unwrap();
    let want = if pr["pr"]["review"] == "approved" {
        ("request_changes", "changes_requested")
    } else {
        ("approve", "approved")
    };

    // Not by its author: GitHub refuses that.
    let author = detail(&s, &b, pr_id).await["author"]["login"].clone();
    let reviewer = if author == "ilze-k" {
        "tomsj"
    } else {
        "ilze-k"
    };
    edit_pr(&s, &pr, json!({ "as": reviewer, "review": want.0 })).await;
    until(WAIT, "the new review decision", || async {
        let d = detail(&s, &b, pr_id).await;
        (d["pr"]["review"] == want.1).then_some(())
    })
    .await;
    let row = rows(&s, &b, "is:pr is:open repo:acme/web")
        .await
        .into_iter()
        .find(|r| r["id"] == pr_id)
        .unwrap();
    assert_eq!(row["pr"]["review"], want.1);
}

/// Probes every 300 ms (the sweeps' other rounds off), and the poller at a quick pace.
fn probing(c: &mut beghu::Config) {
    c.reconcile.tick = Duration::from_millis(100);
    c.reconcile.probe_every = Duration::from_millis(300);
    c.reconcile.count_every = Duration::from_secs(3600);
    c.reconcile.webhook_grace = Duration::ZERO;
    c.reconcile.feed_every = Duration::from_millis(200);
}

/// The next `n` webhooks Fake GitHub would send are lost.
async fn drop_webhooks(s: &Stack, n: u32) {
    s.fake("POST", "/faults/webhooks", json!({ "drop": n }))
        .await;
}

async fn until_unlinked(s: &Stack, b: &Browser, issue: i64) {
    until(WAIT, "the link to go", || async {
        ids(&detail(s, b, issue).await, "linked_prs")
            .is_empty()
            .then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_probe_removes_a_linked_pr_whose_keyword_went_while_its_webhook_was_lost() {
    let s = start_with(probing).await;
    let b = s.sign_in("tomsj").await;
    let pr = bare_pr(&s, &b).await;
    let (n, issue) = unlinked_web()[0];
    let read_backs = operations(&s, "PullReadBack").await;
    edit_pr(&s, &pr, json!({ "body": format!("Closes #{n}.") })).await;
    until_linked(&s, &b, issue, pr["id"].as_i64().unwrap()).await;
    // Its webhook landed (the probe may have been first): the next one is the one lost.
    until(WAIT, "the edit's read-back", || async {
        (operations(&s, "PullReadBack").await > read_backs).then_some(())
    })
    .await;

    // The keyword goes, and so does its `pull_request` `edited`: only the probe, which sees the
    // PR updated, can tell.
    drop_webhooks(&s, 1).await;
    edit_pr(&s, &pr, json!({ "body": "No longer closes anything." })).await;
    until_unlinked(&s, &b, issue).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resync_removes_a_sidebar_link_nothing_else_saw_go() {
    let s = start_with(|c| c.reconcile.resync_every = Duration::ZERO).await;
    let b = s.sign_in("tomsj").await;
    let pr = bare_pr(&s, &b).await;
    let (n, issue) = unlinked_web()[0];
    // Linked in the sidebar: the import of a fresh account would bring it, as a Resync does.
    edit_pr(&s, &pr, json!({ "add_linked_issue": format!("#{n}") })).await;
    resync(&s, &b).await;
    until_linked(&s, &b, issue, pr["id"].as_i64().unwrap()).await;

    // Unlinked with no stream open: no webhook, no `updated_at`, and no poller.
    edit_pr(&s, &pr, json!({ "remove_linked_issue": format!("#{n}") })).await;
    resync(&s, &b).await;
    assert!(ids(&detail(&s, &b, issue).await, "linked_prs").is_empty());
    assert!(ids(&detail(&s, &b, pr["id"].as_i64().unwrap()).await, "closes").is_empty());
}

/// Asks for a Resync as `b` and waits for it to end.
async fn resync(s: &Stack, b: &Browser) {
    let res = s
        .http
        .post(format!("{}/api/resync", s.server))
        .header("cookie", b.header())
        .header("origin", &s.server)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 202);
    until(120.0, "the resync to end", || async {
        s.api(&mut b.clone(), "/api/me").await.1["sync"]
            .is_null()
            .then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_probe_that_read_a_link_before_the_poller_saw_it_go_doesnt_bring_it_back() {
    let s = start_with(probing).await;
    let b = s.sign_in("tomsj").await;
    let pr = bare_pr(&s, &b).await;
    let pr_id = pr["id"].as_i64().unwrap();
    let (n, issue) = unlinked_web()[0];
    let _stream = s.stream(&b).await;
    edit_pr(&s, &pr, json!({ "add_linked_issue": format!("#{n}") })).await;
    until_linked(&s, &b, issue, pr_id).await;
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // The next GraphQL call is answered at once but its answer held for 3 s. The PR changes
    // with its webhook lost, so that call is the probe's read of the PR's details: it reads the
    // link.
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": "POST /graphql", "ms": 3000, "after": true, "count": 1 }),
    )
    .await;
    drop_webhooks(&s, 1).await;
    edit_pr(&s, &pr, json!({ "title": "Read while linked" })).await;
    until(WAIT, "the probe's held read", || async {
        let st = s.fake("GET", "/state", Value::Null).await;
        st["faults"]["latency"]
            .as_array()
            .unwrap()
            .iter()
            .all(|l| l["endpoint"] != "POST /graphql" || l["remaining"] == 0)
            .then_some(())
    })
    .await;
    let held = Instant::now();
    // Meanwhile the link goes, and the poller's read-back of the PR writes that.
    edit_pr(&s, &pr, json!({ "remove_linked_issue": format!("#{n}") })).await;
    until_unlinked(&s, &b, issue).await;
    assert!(held.elapsed() < Duration::from_secs(3), "too slow to tell");
    // The probe's answer lands, stale: it mustn't bring the link back.
    let landed = held + Duration::from_millis(4500);
    while Instant::now() < landed {
        assert!(ids(&detail(&s, &b, issue).await, "linked_prs").is_empty());
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(ids(&detail(&s, &b, issue).await, "linked_prs").is_empty());
}

/// Whether the account is marked for a sweep to repair (the control DB: no HTTP seam shows it).
fn needs_resync(s: &Stack, account: i64) -> bool {
    let db = rusqlite::Connection::open(s.control_db()).unwrap();
    control_db::q::account(&db, account)
        .unwrap()
        .unwrap()
        .needs_resync
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rate_limited_read_back_waits_out_the_pause_and_marks_no_resync() {
    // No retries: any other failure would give the read-back up at once.
    let s = start_with(|c| c.read_back_retries = Vec::new()).await;
    let b = s.sign_in("tomsj").await;
    let account = s.api(&mut b.clone(), "/api/me").await.1["account"]["id"]
        .as_i64()
        .unwrap();
    let pr = bare_pr(&s, &b).await;
    let pr_id = pr["id"].as_i64().unwrap();
    let (n, issue) = unlinked_web()[0];

    // The read-back's first call meets GitHub's secondary limit, asking for 2 s.
    let endpoint = format!("GET /repos/acme/web/issues/{}", pr["number"]);
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": endpoint, "status": 403, "limit": "secondary", "retry_after": 2, "count": 1 }),
    )
    .await;
    edit_pr(&s, &pr, json!({ "body": format!("Fixes #{n}") })).await;
    let sent = Instant::now();
    until_linked(&s, &b, issue, pr_id).await;
    let took = sent.elapsed();
    eprintln!("linked after {took:?}");
    let st = s.fake("GET", "/state", Value::Null).await;
    assert_eq!(
        st["faults"]["fail"],
        json!([]),
        "the read-back met the limit"
    );
    assert!(took >= Duration::from_secs(2), "{took:?}: it waited");
    assert!(!needs_resync(&s, account));
}

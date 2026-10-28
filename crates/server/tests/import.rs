//! Repo picking, the install flow and the phased import, through the server's HTTP surface with
//! Fake GitHub behind it.

mod common;

use common::*;
use serde_json::{Value, json};
use std::path::Path;
use std::time::{Duration, Instant};

/// tomsj's GitHub user id in the fixture.
const TOMSJ: i64 = 1000;

impl Stack {
    /// `PUT /api/repos` from beghu's own page.
    async fn pick(&self, b: &Browser, repos: &[i64]) -> (u16, Value) {
        let res = self
            .api_write(b, reqwest::Method::PUT, "/api/repos")
            .json(&json!({ "repos": repos }))
            .send()
            .await
            .unwrap();
        let status = res.status().as_u16();
        (status, res.json().await.unwrap_or(Value::Null))
    }

    /// Every repo the account can see, by `owner/name`.
    async fn visible(&self, b: &mut Browser) -> Vec<(String, i64)> {
        let (status, picker) = self.api(b, "/api/repos").await;
        assert_eq!(status, 200, "{picker}");
        picker["repos"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    format!(
                        "{}/{}",
                        r["owner"].as_str().unwrap(),
                        r["name"].as_str().unwrap()
                    ),
                    r["id"].as_i64().unwrap(),
                )
            })
            .collect()
    }

    /// Every repo the account can see, once there's at least one: after an install, the setup
    /// URL re-reads them unless the last re-read was moments ago, and the installation's webhook
    /// does in any case.
    async fn until_visible(&self, b: &mut Browser) -> Vec<(String, i64)> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let visible = self.visible(b).await;
            if !visible.is_empty() {
                return visible;
            }
            assert!(Instant::now() < deadline, "no repo became visible");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Waits until the account's import is done (`/api/me` has no `import`), or panics.
    async fn until_imported(&self, b: &mut Browser, secs: u64) {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            let (status, me) = self.api(b, "/api/me").await;
            if status == 200 && me["import"].is_null() {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "still importing after {secs} s: {me}"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

/// Every row of GitHub's data `path` holds, table by table, through mirror-db's dump queries.
fn dump(path: &Path) -> Vec<(&'static str, Vec<String>)> {
    let c = rusqlite::Connection::open(path).unwrap();
    fn rows<T: std::fmt::Debug>(v: Vec<T>) -> Vec<String> {
        v.iter().map(|r| format!("{r:?}")).collect()
    }
    use mirror_db::q;
    vec![
        ("repos", rows(q::dump_repos(&c).unwrap())),
        ("users", rows(q::dump_users(&c).unwrap())),
        ("labels", rows(q::dump_labels(&c).unwrap())),
        ("milestones", rows(q::dump_milestones(&c).unwrap())),
        ("items", rows(q::dump_items(&c).unwrap())),
        ("item_labels", rows(q::dump_item_labels(&c).unwrap())),
        ("item_assignees", rows(q::dump_item_assignees(&c).unwrap())),
        ("relationships", rows(q::dump_relationships(&c).unwrap())),
        ("comments", rows(q::dump_comments(&c).unwrap())),
    ]
}

/// What differs between two mirrors: per table, the rows only one side has (a few of each).
fn diff(want: &Path, got: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for ((table, a), (_, b)) in dump(want).into_iter().zip(dump(got)) {
        let (sa, sb): (std::collections::BTreeSet<_>, std::collections::BTreeSet<_>) =
            (a.iter().collect(), b.iter().collect());
        let missing: Vec<_> = sa.difference(&sb).take(3).collect();
        let extra: Vec<_> = sb.difference(&sa).take(3).collect();
        if !missing.is_empty() || !extra.is_empty() {
            out.push(format!(
                "{table}: {} rows want, {} got; missing {missing:?}; extra {extra:?}",
                a.len(),
                b.len()
            ));
        }
    }
    out
}

/// The generator's mirror as tomsj sees it: the fixture with tomsj's roles.
async fn pristine_tomsj(fixture: &Path, dir: &Path) -> std::path::PathBuf {
    let written = fake_github::pristine_mirrors(fixture, &dir.join("truth.db"), &dir.join("m"))
        .await
        .unwrap();
    written
        .into_iter()
        .find(|(login, _)| login == "tomsj")
        .unwrap()
        .1
}

/// Signs tomsj in on a stack with no mirrors and picks every repo it can see.
async fn import_everything(s: &Stack) -> Browser {
    let mut b = s.sign_in("tomsj").await;
    let repos: Vec<i64> = s
        .visible(&mut b)
        .await
        .into_iter()
        .map(|(_, id)| id)
        .collect();
    assert_eq!(repos.len(), 10);
    let (status, body) = s.pick(&b, &repos).await;
    assert_eq!(status, 200, "{body}");
    b
}

/// tomsj's mirror against the generator's, row for row.
async fn assert_same_as_generated(s: &Stack, fixture: &Path) {
    let dir = tempfile::tempdir().unwrap();
    let want = pristine_tomsj(fixture, dir.path()).await;
    let got = s.data.join("mirrors").join(format!("{TOMSJ}.db"));
    assert_eq!(diff(&want, &got), Vec::<String>::new());
}

/// The phases in the order they run.
const PHASES: [&str; 4] = ["open_issues", "open_prs", "open_comments", "closed"];

/// The import's `(phase, done, of)` as the tab's stream reports it, until the import ends; the
/// phase as its place in [`PHASES`].
fn watch_status(mut stream: Stream) -> tokio::task::JoinHandle<Vec<(usize, i64, i64)>> {
    tokio::spawn(async move {
        let mut seen = Vec::new();
        while let Some(ev) = stream.event_within(Duration::from_secs(120)).await {
            if ev.event != "status" {
                continue;
            }
            let v: Value = serde_json::from_str(&ev.data).unwrap();
            let i = &v["import"];
            if i.is_null() {
                if seen.is_empty() {
                    continue;
                }
                break;
            }
            let n = |k: &str| i[k].as_i64().unwrap();
            let phase = PHASES.iter().position(|p| i["phase"] == *p).unwrap();
            seen.push((phase, n("done"), n("of")));
        }
        seen
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn importing_the_fixture_through_the_fake_rebuilds_the_generators_mirror_exactly() {
    let s = start_fresh().await;
    let mut b = s.sign_in("tomsj").await;
    let status = watch_status(s.stream(&b).await);
    let repos: Vec<i64> = s
        .visible(&mut b)
        .await
        .into_iter()
        .map(|(_, id)| id)
        .collect();
    assert_eq!(repos.len(), 10);
    let (code, body) = s.pick(&b, &repos).await;
    assert_eq!(code, 200, "{body}");
    s.until_imported(&mut b, 120).await;
    assert_same_as_generated(&s, &fixture()).await;

    // Through the App's own token, narrowed to what the import reads, and only one: every call
    // reused it.
    let state = s.fake("GET", "/state", Value::Null).await;
    assert_eq!(
        state["installation_tokens"],
        json!([{
            "installation": 41_000_001,
            "permissions": { "issues": "read", "metadata": "read", "pull_requests": "read" },
        }]),
        "{state}"
    );

    // The phases ran in order, each through every repo before the next began.
    let seen = status.await.unwrap();
    let phases: Vec<usize> = seen.iter().map(|(p, _, _)| *p).collect();
    assert!(phases.is_sorted(), "{seen:?}");
    for phase in 0..PHASES.len() {
        let of: Vec<_> = seen.iter().filter(|(p, _, _)| *p == phase).collect();
        assert_eq!(of.first().map(|(_, done, _)| *done), Some(0), "{seen:?}");
        assert_eq!(
            of.last().map(|(_, done, of)| (*done, *of)),
            Some((10, 10)),
            "{seen:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dependency_between_two_closed_issues_is_imported() {
    // GitHub's `issueDependenciesSummary { blockedBy blocking }` count open issues only: a dependency
    // between two closed issues, neither with an open dependency, shows in neither count.
    let items = fixture_items();
    let state = |id: i64| items.iter().find(|i| i.0 == id).map(|i| i.3.as_str());
    let rels = fixture_relationships();
    let open_dependency = |id: i64| {
        rels.iter().any(|(k, a, z)| {
            k == "blocks"
                && ((*a == id && state(*z) == Some("open"))
                    || (*z == id && state(*a) == Some("open")))
        })
    };
    let (_, blocker, blocked) = rels
        .iter()
        .find(|(k, a, z)| {
            k == "blocks"
                && state(*a) == Some("closed")
                && state(*z) == Some("closed")
                && !open_dependency(*a)
                && !open_dependency(*z)
        })
        .expect("the fixture has a dependency between two closed issues")
        .clone();

    let s = start_fresh().await;
    let mut b = import_everything(&s).await;
    s.until_imported(&mut b, 120).await;
    // The detail doesn't carry relationships yet: the mirror's own rows say.
    let mirror = s.data.join("mirrors").join(format!("{TOMSJ}.db"));
    let c = rusqlite::Connection::open(mirror).unwrap();
    let got: Vec<(String, i64, i64)> = mirror_db::q::dump_relationships(&c)
        .unwrap()
        .into_iter()
        .map(|r| (r.kind, r.src_id, r.dst_id))
        .collect();
    assert!(
        got.contains(&("blocks".into(), blocker, blocked)),
        "{blocker} blocks {blocked} is missing"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_issue_related_to_more_than_fifty_others_gets_every_one_through_paging() {
    let fixture = wide_relates_fixture();
    let s = start_fresh_on(fixture.clone()).await;
    let mut b = import_everything(&s).await;
    s.until_imported(&mut b, 120).await;
    assert_same_as_generated(&s, &fixture).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn over_a_hundred_labels_and_over_fifty_closing_references_get_every_one_through_paging() {
    let fixture = wide_links_fixture();
    let s = start_fresh_on(fixture.clone()).await;
    let mut b = import_everything(&s).await;
    s.until_imported(&mut b, 120).await;
    assert_same_as_generated(&s, &fixture).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relationship_from_a_private_repo_the_account_cant_see_is_dropped() {
    // The App's token reads acme/vault (it's under the org's installation), but tomsj can't see
    // it: its issue is neither a stub nor a relationship end in tomsj's mirror, which is the plain
    // fixture's.
    let s = start_fresh_on(private_relationship_fixture()).await;
    let mut b = import_everything(&s).await;
    s.until_imported(&mut b, 120).await;
    assert_same_as_generated(&s, &fixture()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn latency_server_errors_and_rate_limits_mid_import_are_waited_out_and_it_finishes() {
    let s = start_fresh().await;
    let fail = |endpoint: &str, status: u16, count: u32, retry_after: Option<u64>| json!({ "endpoint": endpoint, "status": status, "count": count, "retry_after": retry_after });
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": "POST /graphql", "ms": 150 }),
    )
    .await;
    for rule in [
        fail("POST /graphql", 502, 3, None),
        fail("POST /graphql", 429, 2, Some(1)),
        fail("GET /repos/*/*/issues", 403, 2, Some(1)),
        fail("GET /repos/*/*/labels", 503, 2, None),
        fail("GET /repos/*/*/issues/comments", 500, 2, None),
    ] {
        s.fake("POST", "/faults/fail", rule).await;
    }
    let mut b = import_everything(&s).await;
    s.until_imported(&mut b, 180).await;
    // Every rule was used up: the import met each fault and went on.
    let state = s.fake("GET", "/state", Value::Null).await;
    assert_eq!(state["faults"]["fail"], json!([]), "{state}");
    assert_same_as_generated(&s, &fixture()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_secondary_rate_limit_that_names_no_wait_is_waited_out_for_a_minute_not_given_up() {
    let s = start_fresh().await;
    // GitHub's secondary limit: a 403 saying so, with no `retry-after` and primary quota left.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "POST /graphql", "status": 403, "limit": "secondary", "count": 1 }),
    )
    .await;
    let mut b = import_everything(&s).await;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let (_, me) = s.api(&mut b, "/api/me").await;
        let import = &me["import"];
        assert_eq!(import["failed"], json!([]), "{me}");
        if import["waiting"] == "GitHub's rate limit · resuming in 60 s" {
            break;
        }
        assert!(Instant::now() < deadline, "{me}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_graphql_rate_limit_inside_a_200_answer_is_waited_out_and_the_import_finishes() {
    let s = start_fresh().await;
    // GraphQL's primary limit: 200, a `RATE_LIMITED` error and no data, `x-ratelimit-reset` a
    // second out.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "POST /graphql", "status": 200, "limit": "graphql", "retry_after": 1, "count": 2 }),
    )
    .await;
    let mut b = import_everything(&s).await;
    s.until_imported(&mut b, 120).await;
    let state = s.fake("GET", "/state", Value::Null).await;
    assert_eq!(state["faults"]["fail"], json!([]), "{state}");
    assert_same_as_generated(&s, &fixture()).await;
}

/// The default list's every row, paging through it.
async fn whole_list(s: &Stack, b: &mut Browser, q: &str) -> Vec<Value> {
    let mut rows = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let mut url = format!("/api/issues?q={}", urlencode(q));
        if let Some(a) = &after {
            url.push_str(&format!("&after={a}"));
        }
        let (status, page) = s.api(b, &url).await;
        assert_eq!(status, 200, "{page}");
        rows.extend(page["rows"].as_array().unwrap().iter().cloned());
        match page["next"].as_str() {
            Some(n) => after = Some(n.to_owned()),
            None => return rows,
        }
    }
}

fn urlencode(s: &str) -> String {
    serde_urlencoded::to_string([("x", s)]).unwrap()[2..].to_owned()
}

/// Waits until the account's import reports `phase`, or panics.
async fn until_phase(s: &Stack, b: &mut Browser, phase: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let (_, me) = s.api(b, "/api/me").await;
        if me["import"]["phase"] == phase {
            return me["import"].clone();
        }
        assert!(
            Instant::now() < deadline,
            "never reached phase {phase}: {me}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// GitHub fails every REST issue-list call from now on: phase 2 (open PRs) can't get anywhere.
async fn hold_at_phase_two(s: &Stack) {
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "GET /repos/*/*/issues", "status": 502, "count": 100000 }),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_app_is_usable_after_phase_one_and_an_issue_opened_early_fetches_its_comments() {
    let s = start_fresh().await;
    hold_at_phase_two(&s).await;
    let mut b = import_everything(&s).await;
    let import = until_phase(&s, &mut b, "open_prs").await;
    assert_eq!(import["of"], 10);

    // Every open issue of every repo is there; no PR and nothing closed yet.
    let open = whole_list(&s, &mut b, "is:open").await;
    assert_eq!(
        open.len() as u64,
        summary()["open_issues"].as_u64().unwrap()
    );
    assert_eq!(whole_list(&s, &mut b, "is:pr").await, Vec::<Value>::new());
    assert_eq!(
        whole_list(&s, &mut b, "is:closed").await,
        Vec::<Value>::new()
    );
    // The status slot says what holds it up.
    let (_, me) = s.api(&mut b, "/api/me").await;
    assert_eq!(
        me["import"]["waiting"], "GitHub isn't answering · retrying",
        "{me}"
    );

    // Comments are phase 3's, but opening an issue now fetches its own.
    let id = summary()["detail_targets"][0].as_i64().unwrap();
    let (status, detail) = s.api(&mut b, &format!("/api/issues/{id}")).await;
    assert_eq!(status, 200, "{detail}");
    assert_eq!(detail["comment_total"], 30);
    assert_eq!(detail["comments"]["comments"].as_array().unwrap().len(), 15);

    s.fake("DELETE", "/faults", Value::Null).await;
    s.until_imported(&mut b, 120).await;
    assert_same_as_generated(&s, &fixture()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_unsynced_and_picked_again_while_its_import_runs_is_imported_whole() {
    let s = start_fresh().await;
    hold_at_phase_two(&s).await;
    let mut b = import_everything(&s).await;
    until_phase(&s, &mut b, "open_prs").await;
    // Its open issues landed in phase 1; unsyncing takes them away, and picking it again within
    // the same round must bring them back.
    let visible = s.visible(&mut b).await;
    let docs = visible.iter().find(|(n, _)| n == "acme/docs").unwrap().1;
    let all: Vec<i64> = visible.iter().map(|(_, id)| *id).collect();
    let without: Vec<i64> = all.iter().copied().filter(|id| *id != docs).collect();
    assert_eq!(s.pick(&b, &without).await.0, 200);
    assert_eq!(s.pick(&b, &all).await.0, 200);

    s.fake("DELETE", "/faults", Value::Null).await;
    s.until_imported(&mut b, 120).await;
    assert_same_as_generated(&s, &fixture()).await;
}

/// The picker's `(owner/name, importing)` for every synced repo.
async fn importing(s: &Stack, b: &mut Browser) -> Vec<(String, bool)> {
    let (status, picker) = s.api(b, "/api/repos").await;
    assert_eq!(status, 200, "{picker}");
    picker["repos"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["synced"] == true)
        .map(|r| {
            (
                format!(
                    "{}/{}",
                    r["owner"].as_str().unwrap(),
                    r["name"].as_str().unwrap()
                ),
                r["importing"].as_bool().unwrap(),
            )
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_whose_import_fails_for_good_stays_importing_says_so_and_is_tried_again() {
    let s = start_fresh_with(|c| c.import_retry_after = Duration::from_secs(1)).await;
    // acme/docs's issue list is gone from GitHub's side: phase 2 can't get past it.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "GET /repos/acme/docs/issues", "status": 404, "count": 100000 }),
    )
    .await;
    let mut b = import_everything(&s).await;

    // Every other repo finishes; docs stays importing, and the status slot names it.
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let repos = importing(&s, &mut b).await;
        let (_, me) = s.api(&mut b, "/api/me").await;
        let others_done = repos.iter().all(|(n, i)| *i == (n == "acme/docs"));
        if others_done && me["import"]["failed"] == json!(["acme/docs"]) {
            break;
        }
        assert!(Instant::now() < deadline, "{repos:?} {me}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // Tried again with backoff (1 s, then 2 s, …), not in a tight loop.
    let calls = || async {
        let state = s.fake("GET", "/state", Value::Null).await;
        100000 - state["faults"]["fail"][0]["remaining"].as_i64().unwrap()
    };
    let before = calls().await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let tried = calls().await - before;
    assert!((1..=3).contains(&tried), "tried {tried} times in 3 s");

    // GitHub recovers: the next try imports docs whole.
    s.fake("DELETE", "/faults", Value::Null).await;
    s.until_imported(&mut b, 120).await;
    assert_same_as_generated(&s, &fixture()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_github_keeps_answering_5xx_for_fails_and_the_other_repos_finish() {
    // A call gives up on a 5xx after 2 s here (5 minutes in production); the failed repo isn't
    // tried again within the test.
    let s = start_fresh_with(|c| c.import_give_up_after = Duration::from_secs(2)).await;
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "GET /repos/acme/docs/issues", "status": 502, "count": 100000 }),
    )
    .await;
    let mut b = import_everything(&s).await;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let repos = importing(&s, &mut b).await;
        let (_, me) = s.api(&mut b, "/api/me").await;
        let others_done = repos.iter().all(|(n, i)| *i == (n == "acme/docs"));
        if others_done && me["import"]["failed"] == json!(["acme/docs"]) {
            break;
        }
        assert!(Instant::now() < deadline, "{repos:?} {me}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // Between rounds the status slot says when docs is tried again (a minute on, the first
    // time), as a time rather than a countdown that would go stale.
    let deadline = Instant::now() + Duration::from_secs(10);
    let import = loop {
        let (_, me) = s.api(&mut b, "/api/me").await;
        if me["import"]["phase"].is_null() {
            break me["import"].clone();
        }
        assert!(Instant::now() < deadline, "{me}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let at = import["retry_at"].as_i64().unwrap_or(0);
    assert!((now + 30..=now + 61).contains(&at), "{import}");
    assert_eq!(import["waiting"], Value::Null, "{import}");
}

/// The fixture's items, `(id, repo_id, number, state, kind)`, stubs left out.
fn fixture_items() -> Vec<(i64, i64, i64, String, String)> {
    let c = rusqlite::Connection::open(fixture()).unwrap();
    mirror_db::q::dump_items(&c)
        .unwrap()
        .into_iter()
        .filter(|i| i.is_stub == 0)
        .map(|i| (i.id, i.repo_id, i.number, i.state, i.kind))
        .collect()
}

/// The fixture's relationships, `(kind, src, dst)`.
fn fixture_relationships() -> Vec<(String, i64, i64)> {
    let c = rusqlite::Connection::open(fixture()).unwrap();
    mirror_db::q::dump_relationships(&c)
        .unwrap()
        .into_iter()
        .map(|r| (r.kind, r.src_id, r.dst_id))
        .collect()
}

/// A delivery of the issue as REST would carry it, built from what the fixture holds.
fn issue_payload(
    action: &str,
    repo: i64,
    id: i64,
    number: i64,
    title: &str,
    updated: &str,
) -> Value {
    json!({
        "action": action,
        "repository": { "id": repo },
        "installation": { "id": 41_000_001 },
        "issue": {
            "id": id, "node_id": format!("I_kw{id}"), "number": number, "title": title,
            "body": "Rewritten while the import ran.", "state": "closed",
            "state_reason": "completed", "locked": false, "user": null, "labels": [],
            "assignees": [], "milestone": null, "comments": 0,
            "created_at": "2024-01-01T00:00:00Z", "updated_at": updated,
            "closed_at": "2024-01-02T00:00:00Z",
        },
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn webhooks_mid_import_apply_and_an_older_page_never_overwrites_or_revives_them() {
    let s = start_fresh().await;
    hold_at_phase_two(&s).await;
    let mut b = import_everything(&s).await;
    until_phase(&s, &mut b, "open_prs").await;

    // Two closed issues, which only phase 4 imports: one edited after the fixture's snapshot, one
    // deleted.
    let closed: Vec<_> = fixture_items()
        .into_iter()
        .filter(|(_, _, _, state, kind)| state == "closed" && kind == "issue")
        .take(2)
        .collect();
    let (edited, deleted) = (&closed[0], &closed[1]);
    let newer = issue_payload(
        "edited",
        edited.1,
        edited.0,
        edited.2,
        "Retitled by a webhook",
        "2030-01-01T00:00:00Z",
    );
    assert_eq!(s.deliver("issues", "mid-import-edit", &newer).await, 202);
    let gone = issue_payload(
        "deleted",
        deleted.1,
        deleted.0,
        deleted.2,
        "gone",
        "2030-01-01T00:00:00Z",
    );
    assert_eq!(s.deliver("issues", "mid-import-delete", &gone).await, 202);
    // Applied now, mid-import.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let (status, d) = s.api(&mut b, &format!("/api/issues/{}", edited.0)).await;
        if status == 200 && d["title"] == "Retitled by a webhook" {
            break;
        }
        assert!(Instant::now() < deadline, "the webhook never applied: {d}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    s.fake("DELETE", "/faults", Value::Null).await;
    s.until_imported(&mut b, 120).await;
    // Phase 4's page of closed issues was older than the webhook: the webhook's version stays.
    let (_, d) = s.api(&mut b, &format!("/api/issues/{}", edited.0)).await;
    assert_eq!(d["title"], "Retitled by a webhook", "{d}");
    // And the deleted one never came back: it says it was deleted.
    let (status, body) = s.api(&mut b, &format!("/api/issues/{}", deleted.0)).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (410, Some("deleted")),
        "{body}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn unsyncing_a_repo_deletes_its_rows_but_keeps_stubs_a_relationship_from_a_synced_item_reaches()
 {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let visible = s.visible(&mut b).await;
    let docs = visible.iter().find(|(n, _)| n == "acme/docs").unwrap().1;
    let items = fixture_items();
    let in_docs = |id: i64| items.iter().any(|i| i.0 == id && i.1 == docs);
    let outside_docs = |id: i64| items.iter().any(|i| i.0 == id && i.1 != docs);
    // A docs issue a relationship from another synced repo's issue reaches, and one nothing outside
    // docs does.
    let rels = fixture_relationships();
    let reached = rels
        .iter()
        .find_map(|(_, src, dst)| {
            (in_docs(*dst) && outside_docs(*src))
                .then_some(*dst)
                .or((in_docs(*src) && outside_docs(*dst)).then_some(*src))
        })
        .unwrap();
    let alone = items
        .iter()
        .find(|i| {
            i.1 == docs
                && !rels
                    .iter()
                    .any(|(_, a, z)| (*a == i.0 && !in_docs(*z)) || (*z == i.0 && !in_docs(*a)))
        })
        .unwrap()
        .0;
    for id in [reached, alone] {
        assert_eq!(s.api(&mut b, &format!("/api/issues/{id}")).await.0, 200);
    }

    let keep: Vec<i64> = visible
        .iter()
        .filter(|(_, id)| *id != docs)
        .map(|(_, id)| *id)
        .collect();
    let (status, picker) = s.pick(&b, &keep).await;
    assert_eq!(status, 200, "{picker}");
    let docs_row = picker["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == docs)
        .unwrap();
    assert_eq!(docs_row["synced"], false);

    // The reached one is a stub now: outside the synced repos, with a link out.
    let (status, body) = s.api(&mut b, &format!("/api/issues/{reached}")).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (403, Some("no_access")),
        "{body}"
    );
    assert_eq!(body["issue"]["repo"], "docs");
    // The other is gone, and no docs row is listed.
    let (status, body) = s.api(&mut b, &format!("/api/issues/{alone}")).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (404, Some("gone")),
        "{body}"
    );
    let rows = whole_list(&s, &mut b, "is:any").await;
    assert!(rows.iter().all(|r| r["repo"] != "docs"));
    let (_, me) = s.api(&mut b, "/api/me").await;
    assert!(
        me["repos"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["name"] != "docs"),
        "{me}"
    );

    // Syncing it again brings both back: nothing was recorded as deleted.
    let (status, _) = s
        .pick(&b, &visible.iter().map(|(_, id)| *id).collect::<Vec<_>>())
        .await;
    assert_eq!(status, 200);
    s.until_imported(&mut b, 120).await;
    for id in [reached, alone] {
        let (status, d) = s.api(&mut b, &format!("/api/issues/{id}")).await;
        assert_eq!(status, 200, "{d}");
    }
}

/// A docs issue nothing outside docs reaches: unsyncing docs deletes it.
fn alone_in(docs: i64) -> i64 {
    let items = fixture_items();
    let in_docs = |id: i64| items.iter().any(|i| i.0 == id && i.1 == docs);
    let rels = fixture_relationships();
    items
        .iter()
        .find(|i| {
            i.1 == docs
                && !rels
                    .iter()
                    .any(|(_, a, z)| (*a == i.0 && !in_docs(*z)) || (*z == i.0 && !in_docs(*a)))
        })
        .unwrap()
        .0
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unsync_a_restart_cuts_short_lists_none_of_the_repo_and_finishes_at_the_next_re_read() {
    let mut s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let visible = s.visible(&mut b).await;
    let docs = visible.iter().find(|(n, _)| n == "acme/docs").unwrap().1;
    let alone = alone_in(docs);
    assert_eq!(s.api(&mut b, &format!("/api/issues/{alone}")).await.0, 200);
    assert!(
        whole_list(&s, &mut b, "is:any")
            .await
            .iter()
            .any(|r| r["repo"] == "docs")
    );

    // Another writer holds the mirror, so the unsync's first transaction waits on it, and the
    // process stops while it waits: the transaction goes through once the mirror is free, but
    // nothing of the stopped process runs after it.
    let mirror = s.data.join("mirrors").join(format!("{TOMSJ}.db"));
    let mut other = rusqlite::Connection::open(&mirror).unwrap();
    let lock = other
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let keep: Vec<i64> = visible
        .iter()
        .filter(|(_, id)| *id != docs)
        .map(|(_, id)| *id)
        .collect();
    let pick = {
        let req = s
            .api_write(&b, reqwest::Method::PUT, "/api/repos")
            .json(&json!({ "repos": keep }));
        tokio::spawn(req.send())
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    s.restart_with(|_| {}).await;
    drop(lock);
    let _ = pick.await;
    // The repo is no longer synced: it leaves the repo facet.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let (status, facets) = s.api(&mut b, "/api/facets").await;
        assert_eq!(status, 200, "{facets}");
        if !facets["repos"].as_array().unwrap().contains(&json!("docs")) {
            break;
        }
        assert!(Instant::now() < deadline, "docs stayed synced: {facets}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Its rows are still in the mirror, but nothing lists or counts them.
    let rows = whole_list(&s, &mut b, "is:any").await;
    assert!(rows.iter().all(|r| r["repo"] != "docs"));
    let (status, counts) = s.api(&mut b, "/api/facets/repo/counts?q=is:any").await;
    assert_eq!(status, 200, "{counts}");
    assert!(
        counts
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["value"] != "docs"),
        "{counts}"
    );

    // The new process's first re-read of the account's repos finishes the unsync.
    let (status, me) = s.api(&mut b, "/api/me").await;
    assert_eq!(status, 200, "{me}");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let (status, body) = s.api(&mut b, &format!("/api/issues/{alone}")).await;
        if (status, body["error"].as_str()) == (404, Some("gone")) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "{alone} outlived the unsync: {status} {body}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// A fixture issue of `repo` with no relationships: `(number, id)`.
fn unlinked_in(repo: &str) -> (i64, i64) {
    let u = summary()["unlinked"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["repo"] == repo)
        .unwrap()
        .clone();
    (u["number"].as_i64().unwrap(), u["id"].as_i64().unwrap())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relationship_made_while_an_unsync_is_held_keeps_its_end_as_a_stub() {
    let mut s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let visible = s.visible(&mut b).await;
    let docs = visible.iter().find(|(n, _)| n == "acme/docs").unwrap().1;
    let keep: Vec<i64> = visible
        .iter()
        .map(|(_, id)| *id)
        .filter(|id| *id != docs)
        .collect();
    let ((me_number, me), (far_number, far)) = (unlinked_in("web"), unlinked_in("docs"));

    // Unsyncing docs starts, and stops before any of its items go: another writer holds the
    // mirror, and the process stops meanwhile (see the restart test above).
    let mirror = s.data.join("mirrors").join(format!("{TOMSJ}.db"));
    let mut other = rusqlite::Connection::open(&mirror).unwrap();
    let lock = other
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let pick = {
        let req = s
            .api_write(&b, reqwest::Method::PUT, "/api/repos")
            .json(&json!({ "repos": keep }));
        tokio::spawn(req.send())
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    s.restart_with(|_| {}).await;
    drop(lock);
    let _ = pick.await;

    // Meanwhile a web issue gets blocked by a docs issue: docs is no longer synced but still
    // visible, so its end is kept, though it's still a full item.
    s.edit(json!({
        "repo": "web",
        "number": me_number,
        "add_blocked_by": format!("docs#{far_number}"),
    }))
    .await;
    let blockers = |d: &Value| -> Vec<(i64, bool)> {
        d["relationships"]["blocked_by"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| (r["id"].as_i64().unwrap(), r["stub"].as_bool().unwrap()))
            .collect()
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let (status, d) = s.api(&mut b, &format!("/api/issues/{me}")).await;
        assert_eq!(status, 200, "{d}");
        if blockers(&d).iter().any(|(id, _)| *id == far) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the relationship never landed: {d}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // The next re-read finishes the unsync: the blocker is a stub now, not gone.
    let (status, me_body) = s.api(&mut b, "/api/me").await;
    assert_eq!(status, 200, "{me_body}");
    until_issue(&s, &mut b, alone_in(docs), "gone", 10).await;
    let (_, d) = s.api(&mut b, &format!("/api/issues/{me}")).await;
    assert_eq!(blockers(&d), [(far, true)], "{d}");
    let (status, body) = s.api(&mut b, &format!("/api/issues/{far}")).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (403, Some("no_access")),
        "{body}"
    );
}

/// Waits until `/api/issues/{id}` answers `want` (`200`, or the error kind), or panics.
async fn until_issue(s: &Stack, b: &mut Browser, id: i64, want: &str, secs: u64) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        let (status, body) = s.api(b, &format!("/api/issues/{id}")).await;
        let got = match status {
            200 => "200",
            _ => body["error"].as_str().unwrap_or(""),
        };
        if got == want {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "issue {id} never became {want}: {status} {body}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pick_whose_request_goes_away_still_imports_the_repos_it_picked() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let visible = s.visible(&mut b).await;
    let id_of = |name: &str| visible.iter().find(|(n, _)| n == name).unwrap().1;
    let (docs, web) = (id_of("acme/docs"), id_of("acme/web"));
    let all: Vec<i64> = visible.iter().map(|(_, id)| *id).collect();
    let without =
        |gone: i64| -> Vec<i64> { all.iter().copied().filter(|id| *id != gone).collect() };
    let alone = alone_in(docs);
    assert_eq!(s.pick(&b, &without(docs)).await.0, 200);
    until_issue(&s, &mut b, alone, "gone", 10).await;

    // docs back, web out. Another writer holds the mirror, so the pick waits on it, and the
    // browser goes away meanwhile.
    let mirror = s.data.join("mirrors").join(format!("{TOMSJ}.db"));
    let mut other = rusqlite::Connection::open(&mirror).unwrap();
    let lock = other
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let pick = {
        let req = s
            .api_write(&b, reqwest::Method::PUT, "/api/repos")
            .json(&json!({ "repos": without(web) }));
        tokio::spawn(req.send())
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    pick.abort();
    let _ = pick.await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    drop(lock);

    // The pick still lands whole: docs is imported again and web's rows go.
    until_issue(&s, &mut b, alone, "200", 60).await;
    until_issue(&s, &mut b, alone_in(web), "gone", 10).await;
}

/// Puts a fault into tomsj's mirror: from now on (`true`) every unsync stalls at its first
/// chunk, as on a failure that persists; `false` lifts it.
fn stall_unsyncs(s: &Stack, stalled: bool) {
    let mirror = s.data.join("mirrors").join(format!("{TOMSJ}.db"));
    let c = rusqlite::Connection::open(&mirror).unwrap();
    if stalled {
        mirror_db::q::fault_stall_unsyncs(&c).unwrap();
    } else {
        mirror_db::q::fault_unstall_unsyncs(&c).unwrap();
    }
}

const FACETS: [&str; 6] = [
    "labels",
    "assignees",
    "authors",
    "repos",
    "milestones",
    "types",
];

#[tokio::test(flavor = "multi_thread")]
async fn an_unsync_that_keeps_failing_holds_up_no_later_pick_and_finishes_once_it_can() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let visible = s.visible(&mut b).await;
    let id_of = |name: &str| visible.iter().find(|(n, _)| n == name).unwrap().1;
    let (docs, web) = (id_of("acme/docs"), id_of("acme/web"));
    let all: Vec<i64> = visible.iter().map(|(_, id)| *id).collect();
    let without =
        |gone: i64| -> Vec<i64> { all.iter().copied().filter(|id| *id != gone).collect() };
    let (docs_alone, web_alone) = (alone_in(docs), alone_in(web));
    assert_eq!(s.pick(&b, &without(web)).await.0, 200);
    until_issue(&s, &mut b, web_alone, "gone", 10).await;

    // docs' unsync stalls; the pick still answers, with docs no longer synced.
    stall_unsyncs(&s, true);
    let (status, body) = s.pick(&b, &without(docs)).await;
    assert_eq!(status, 200, "{body}");
    let docs_row = body["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == docs)
        .unwrap()
        .clone();
    assert_eq!(docs_row["synced"], false, "{body}");
    // web, picked in the same go, is imported however often the stalled unsync is tried again.
    until_issue(&s, &mut b, web_alone, "200", 60).await;
    let (status, body) = s.pick(&b, &without(docs)).await;
    assert_eq!(status, 200, "{body}");
    // docs' rows are still there, but nothing lists them.
    assert_ne!(
        s.api(&mut b, &format!("/api/issues/{docs_alone}")).await.0,
        200
    );
    assert!(
        whole_list(&s, &mut b, "is:any")
            .await
            .iter()
            .all(|r| r["repo"] != "docs")
    );

    // Once deleting works again, the next pick finishes it.
    stall_unsyncs(&s, false);
    let (status, body) = s.pick(&b, &without(docs)).await;
    assert_eq!(status, 200, "{body}");
    let mirror = s.data.join("mirrors").join(format!("{TOMSJ}.db"));
    let c = rusqlite::Connection::open(&mirror).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while mirror_db::q::dump_items(&c)
        .unwrap()
        .iter()
        .any(|i| i.id == docs_alone)
    {
        assert!(
            Instant::now() < deadline,
            "{docs_alone} outlived the unsync"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_filter_bar_suggests_nothing_from_repos_whose_unsync_is_still_unfinished() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (_, facets) = s.api(&mut b, "/api/facets").await;
    for facet in FACETS {
        assert_ne!(facets[facet], json!([]), "{facet}: {facets}");
    }

    // Every repo leaves, and every unsync stalls with all its rows still in the mirror.
    stall_unsyncs(&s, true);
    let (status, body) = s.pick(&b, &[]).await;
    assert_eq!(status, 200, "{body}");
    let (status, facets) = s.api(&mut b, "/api/facets").await;
    assert_eq!(status, 200, "{facets}");
    for facet in FACETS {
        assert_eq!(facets[facet], json!([]), "{facet}: {facets}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn only_repos_the_account_can_see_can_be_picked_and_only_from_beghus_own_pages() {
    let s = start().await;
    let mut b = s.sign_in("octo-ext").await;
    let visible = s.visible(&mut b).await;
    let names: Vec<&str> = visible.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, ["acme/docs", "acme/web"]);
    // acme/api exists, but octo-ext can't see it.
    let (status, body) = s.pick(&b, &[9_000_001]).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (400, Some("bad_request")),
        "{body}"
    );
    let res = s
        .http
        .put(format!("{}/api/repos", s.server))
        .header("cookie", b.header())
        .header("x-beghu-account", b.account())
        .header("origin", "https://evil.example")
        .json(&json!({ "repos": [visible[0].1] }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
}

/// Follows the install step from the page the callback showed: the fake's install page, its
/// Install button, and back through the setup URL. The URLs visited after the button.
async fn install_from(s: &Stack, b: &mut Browser, step: &str, login: &str) -> Vec<String> {
    let href = step
        .split("href=\"")
        .nth(1)
        .and_then(|r| r.split('"').next())
        .unwrap()
        .replace("&amp;", "&");
    assert!(href.contains("/apps/beghu-dev/installations/new"), "{href}");
    // The fake knows who's installing from its own sign-in cookie; a script says so instead.
    let page = s
        .http
        .get(format!("{href}?login={login}"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(page.contains("Install</button>"), "{page}");
    let res = s
        .http
        .post(&href)
        .form(&[("login", login), ("target", login)])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 302);
    let setup = location(&res);
    assert!(
        setup.starts_with(&format!("{}/auth/setup?installation_id=", s.server)),
        "{setup}"
    );
    let (visited, last) = s.follow(b, &setup[s.server.len()..]).await;
    assert_eq!(last.status(), 200);
    visited
}

#[tokio::test(flavor = "multi_thread")]
async fn a_user_with_no_installation_installs_comes_back_picks_and_watches_rows_arrive() {
    let s = start().await;
    let mut b = Browser::default();
    let (visited, res) = s.follow(&mut b, "/auth/login?login=newcomer").await;
    // Signed in, but with nothing to read: the install step, not the app.
    assert!(
        visited.last().unwrap().contains("/auth/callback"),
        "{visited:?}"
    );
    assert_eq!(res.status(), 200);
    assert!(b.cookies.contains_key(SID));
    let step = res.text().await.unwrap();
    assert!(step.contains("Install beghu"), "{step}");

    let visited = install_from(&s, &mut b, &step, "newcomer").await;
    assert_eq!(
        visited.last().unwrap(),
        &format!("{}/repos", s.server),
        "{visited:?}"
    );

    let visible = s.until_visible(&mut b).await;
    assert_eq!(
        visible.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(),
        ["newcomer/notes"]
    );
    let mut stream = s.stream(&b).await;
    let (status, _) = s.pick(&b, &[visible[0].1]).await;
    assert_eq!(status, 200);
    // Rows arrive as the import lands them, each page pushed to the tab.
    let mut pushed = Vec::new();
    while let Some(ev) = stream.event_within(Duration::from_secs(10)).await {
        if ev.event == "ids" {
            pushed.extend(ids_of(&ev));
        }
        if ev.event == "status" && ev.data.contains("\"import\":null") && !pushed.is_empty() {
            break;
        }
    }
    assert!(!pushed.is_empty());
    s.until_imported(&mut b, 30).await;
    let open = whole_list(&s, &mut b, "is:open").await;
    let titles: Vec<&str> = open.iter().map(|r| r["title"].as_str().unwrap()).collect();
    assert_eq!(titles.len(), 5, "{titles:?}");
    assert!(titles.contains(&"Plan the garden beds"), "{titles:?}");
    assert_eq!(whole_list(&s, &mut b, "is:any").await.len(), 8);
}

#[tokio::test(flavor = "multi_thread")]
async fn when_github_wont_say_where_installing_starts_the_apps_own_install_page_is_offered() {
    let s = start().await;
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "GET /app", "status": 500, "count": 100000 }),
    )
    .await;
    let mut b = Browser::default();
    let (_, res) = s.follow(&mut b, "/auth/login?login=newcomer").await;
    let step = res.text().await.unwrap();
    // The install step links to it, and so does the (empty) picker.
    let want = format!("{}/apps/beghu-dev/installations/new", s.fake_api);
    assert!(step.contains(&format!("href=\"{want}\"")), "{step}");
    let (status, picker) = s.api(&mut b, "/api/repos").await;
    assert_eq!(status, 200, "{picker}");
    assert_eq!(picker["repos"], json!([]));
    assert_eq!(picker["install_url"], want, "{picker}");
}

#[tokio::test(flavor = "multi_thread")]
async fn coming_back_from_installing_lists_the_new_repos_without_waiting_for_the_webhook() {
    let s = start_with(|c| c.setup_reread_after = Duration::from_secs(5)).await;
    let mut b = Browser::default();
    let (_, res) = s.follow(&mut b, "/auth/login?login=newcomer").await;
    let step = res.text().await.unwrap();
    // No webhook reaches beghu: only the setup URL tells it about the installation.
    s.fake("PUT", "/webhooks", json!({ "url": null })).await;
    // The sign-in's re-read of the repos is past the setup URL's floor (5 s here) by the time
    // the user comes back.
    tokio::time::sleep(Duration::from_secs(6)).await;
    install_from(&s, &mut b, &step, "newcomer").await;
    let visible = s.visible(&mut b).await;
    assert_eq!(
        visible.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(),
        ["newcomer/notes"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn uninstalling_takes_the_rows_away_and_installing_again_brings_the_same_ones_back() {
    let s = start().await;
    let mut b = Browser::default();
    let (_, res) = s.follow(&mut b, "/auth/login?login=newcomer").await;
    let step = res.text().await.unwrap();
    install_from(&s, &mut b, &step, "newcomer").await;
    let notes = s.until_visible(&mut b).await[0].1;
    s.pick(&b, &[notes]).await;
    s.until_imported(&mut b, 30).await;
    let before = whole_list(&s, &mut b, "is:any").await;
    assert_eq!(before.len(), 8);

    // GitHub sends `installation` `deleted`; the rows leave the mirror.
    s.fake("POST", "/uninstall", json!({ "login": "newcomer" }))
        .await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !whole_list(&s, &mut b, "is:any").await.is_empty() {
        assert!(
            Instant::now() < deadline,
            "the rows outlived the installation"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let id = before[0]["id"].as_i64().unwrap();
    assert_eq!(s.api(&mut b, &format!("/api/issues/{id}")).await.0, 404);
    assert_eq!(s.visible(&mut b).await, vec![]);

    // Installed again and picked again, the same issues come back: nothing was tombstoned.
    let install = s
        .http
        .post(format!("{}/apps/beghu-dev/installations/new", s.fake_api))
        .form(&[("login", "newcomer"), ("target", "newcomer")])
        .send()
        .await
        .unwrap();
    let setup = location(&install);
    s.follow(&mut b, &setup[s.server.len()..]).await;
    s.until_visible(&mut b).await;
    s.pick(&b, &[notes]).await;
    s.until_imported(&mut b, 30).await;
    let after = whole_list(&s, &mut b, "is:any").await;
    assert_eq!(after, before);
}

#[tokio::test(flavor = "multi_thread")]
async fn suspending_the_installation_takes_its_rows_away_and_unsuspending_shows_its_repos_again() {
    let s = start().await;
    let mut b = Browser::default();
    let (_, res) = s.follow(&mut b, "/auth/login?login=newcomer").await;
    let step = res.text().await.unwrap();
    install_from(&s, &mut b, &step, "newcomer").await;
    let notes = s.until_visible(&mut b).await[0].1;
    s.pick(&b, &[notes]).await;
    s.until_imported(&mut b, 30).await;
    assert_eq!(whole_list(&s, &mut b, "is:any").await.len(), 8);

    // GitHub sends `installation` `suspend`; the installation still lists, with `suspended_at`,
    // but beghu reads nothing through it.
    s.fake("POST", "/suspend", json!({ "login": "newcomer" }))
        .await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !whole_list(&s, &mut b, "is:any").await.is_empty() {
        assert!(
            Instant::now() < deadline,
            "the rows outlived the suspension"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(s.visible(&mut b).await, vec![]);

    // Unsuspended, its repos can be picked again.
    s.fake("POST", "/unsuspend", json!({ "login": "newcomer" }))
        .await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while s.visible(&mut b).await.is_empty() {
        assert!(Instant::now() < deadline, "the repo never came back");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_user_with_an_installation_is_never_sent_to_install_even_when_its_repos_read_slowly() {
    // No mirror yet, and the installation's repos take longer to list than the sign-in waits
    // for: the callback asks `/user/installations` itself.
    let s = start_fresh().await;
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": "/user/installations/*", "ms": 3000 }),
    )
    .await;
    let mut b = Browser::default();
    let (visited, res) = s.follow(&mut b, "/auth/login?login=tomsj").await;
    assert_eq!(res.status(), 200);
    assert_eq!(
        visited.last().unwrap(),
        &format!("{}/repos", s.server),
        "{visited:?}"
    );
}

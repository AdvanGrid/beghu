//! The account's roles, re-read from GitHub at sign-in and by `/api/me` when they're older than
//! `repo_refresh_every` (in most tests here zero: every request). Requests that arrive while a
//! re-read is running wait on that one; after a failed re-read the next waits
//! `roles_retry_after_failure` (a minute by default), so a failing GitHub isn't asked, and
//! waited on, by every request.
//!
//! And what the roles allow: the live-verified role matrix
//! (docs/research/saml-sso-and-read-only-access.md, section 1) is the oracle, checked through
//! `/api/me`'s tables, the detail's `can` set and real writes against Fake GitHub, which answers
//! as GitHub was measured to (403s, silent 2xx drops). ilze-k has Write on web, Read on cli and
//! Triage on docs. A role change reaches the account's tabs as a `roles` push.

mod common;

use common::{Browser, Stack, start, start_with};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const INSTALLATIONS: &str = "GET /user/installations";

/// How many more calls the fail rule on `INSTALLATIONS` will fail: each call GitHub got uses one.
fn calls_left(state: &Value) -> u64 {
    state["faults"]["fail"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["endpoint"] == INSTALLATIONS)
        .map_or(0, |f| f["remaining"].as_u64().unwrap())
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_requests_share_one_roles_refresh() {
    let s = start_with(|c| c.repo_refresh_every = Duration::ZERO).await;
    let b = s.sign_in("tomsj").await;
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": INSTALLATIONS, "ms": 500 }),
    )
    .await;
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": INSTALLATIONS, "status": 502, "count": 50 }),
    )
    .await;

    let statuses = s.concurrently(&b, "/api/me", 8).await;
    assert!(statuses.iter().all(|&st| st == 200), "{statuses:?}");
    let state = s.fake("GET", "/state", json!(null)).await;
    assert_eq!(calls_left(&state), 49, "one call for 8 requests: {state}");
}

#[tokio::test(flavor = "multi_thread")]
async fn after_a_failed_roles_refresh_requests_neither_retry_it_nor_wait_for_it() {
    let s = start_with(|c| c.repo_refresh_every = Duration::ZERO).await;
    let mut b = s.sign_in("tomsj").await;
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": INSTALLATIONS, "ms": 2500 }),
    )
    .await;
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": INSTALLATIONS, "status": 502, "count": 50 }),
    )
    .await;

    // The first request waits its 2 s and serves the roles it has; the refresh fails later.
    let (status, me) = s.api(&mut b, "/api/me").await;
    assert_eq!(status, 200);
    assert_eq!(me["account"]["login"], "tomsj");
    tokio::time::sleep(Duration::from_millis(1000)).await;
    assert_eq!(calls_left(&s.fake("GET", "/state", json!(null)).await), 49);

    for _ in 0..3 {
        let started = Instant::now();
        assert_eq!(s.api(&mut b, "/api/me").await.0, 200);
        assert!(
            started.elapsed() < Duration::from_millis(1000),
            "waited {:?} on a refresh that just failed",
            started.elapsed()
        );
    }
    assert_eq!(calls_left(&s.fake("GET", "/state", json!(null)).await), 49);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_waits_at_most_2_s_for_a_slow_roles_refresh() {
    let s = common::start().await;
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": INSTALLATIONS, "ms": 4000 }),
    )
    .await;

    let started = Instant::now();
    let mut b = s.sign_in("tomsj").await;
    let took = started.elapsed();
    assert!(
        took < Duration::from_millis(3500),
        "the sign-in waited {took:?} on GitHub"
    );
    // It lands signed in, with the roles the mirror had.
    let (status, me) = s.api(&mut b, "/api/me").await;
    assert_eq!(status, 200);
    assert_eq!(me["account"]["login"], "tomsj");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_during_a_running_roles_refresh_gets_a_fresh_one_after_it() {
    let s = start_with(|c| c.repo_refresh_every = Duration::ZERO).await;
    let b = s.sign_in("tomsj").await;
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": INSTALLATIONS, "ms": 1500 }),
    )
    .await;
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": INSTALLATIONS, "status": 502, "count": 50 }),
    )
    .await;

    // A request starts a re-read, with the token as it is; while it runs, the same user signs
    // in again on another browser, with a new token.
    let running = {
        let (s_url, cookie) = (s.server.clone(), b.header());
        let http = s.http.clone();
        tokio::spawn(async move {
            http.get(format!("{s_url}/api/me"))
                .header("cookie", cookie)
                .send()
                .await
                .unwrap()
                .status()
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    s.sign_in("tomsj").await;
    assert_eq!(running.await.unwrap(), 200);
    tokio::time::sleep(Duration::from_millis(2000)).await;

    // Three calls: the running re-read, the sign-in's own check of the user's installations,
    // and the sign-in's re-read after the running one.
    let state = s.fake("GET", "/state", json!(null)).await;
    assert_eq!(
        calls_left(&state),
        47,
        "the sign-in got a re-read of its own: {state}"
    );
}

/// The App's setup URL, three times, as GitHub (or any site) sends the browser there.
async fn setup_thrice(s: &common::Stack, b: &mut common::Browser) {
    for _ in 0..3 {
        let res = s
            .get(b, "/auth/setup?installation_id=1&setup_action=update")
            .await;
        assert_eq!(res.status(), 302);
        assert_eq!(common::location(&res), "/repos");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_setup_url_re_reads_repos_past_its_floor_once_however_often_its_hit() {
    // `/auth/setup` is a GET any site can send the browser to: it re-reads the repos only once
    // the last re-read is `setup_reread_after` old (a minute; 5 s here), one at a time, and a
    // failed one backs off.
    let s = common::start_with(|c| c.setup_reread_after = Duration::from_secs(5)).await;
    let mut b = s.sign_in("tomsj").await;
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": INSTALLATIONS, "status": 502, "count": 50 }),
    )
    .await;
    // The sign-in's re-read is fresh: nothing to do.
    setup_thrice(&s, &mut b).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(calls_left(&s.fake("GET", "/state", json!(null)).await), 50);
    // Past the floor, one re-read (failing here) for all three.
    tokio::time::sleep(Duration::from_secs(5)).await;
    setup_thrice(&s, &mut b).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(calls_left(&s.fake("GET", "/state", json!(null)).await), 49);
}

/// A fresh op id, as the tab makes them: a random (version 4) UUID.
fn uuid() -> String {
    let n: u128 = rand::random();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        n >> 96,
        (n >> 80) & 0xffff,
        (n >> 64) & 0xfff,
        0x8000 | ((n >> 48) & 0x3fff),
        n & 0xffff_ffff_ffff
    )
}

/// `POST /api/ops`: the status, and the reply or the refusal's message.
async fn op(s: &Stack, b: &Browser, op: Value) -> (u16, Value) {
    let res = s
        .api_write(b, reqwest::Method::POST, "/api/ops")
        .json(&json!({ "op_id": uuid(), "op": op }))
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

/// The synced repo `name`, as `/api/me` has it.
async fn repo(s: &Stack, b: &mut Browser, name: &str) -> Value {
    let (_, me) = s.api(b, "/api/me").await;
    me["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == name)
        .unwrap_or_else(|| panic!("no synced repo {name}: {me}"))
        .clone()
}

async fn detail(s: &Stack, b: &mut Browser, id: i64) -> Value {
    let (status, d) = s.api(b, &format!("/api/issues/{id}")).await;
    assert_eq!(status, 200, "{d}");
    d
}

/// Open issues in `repo` that `login` didn't open, from the top of the list.
async fn others_issues(s: &Stack, b: &mut Browser, repo: &str, login: &str) -> Vec<Value> {
    let q = format!("/api/issues?q=is%3Aopen%20repo%3A{repo}");
    let (_, page) = s.api(b, &q).await;
    let mut out = Vec::new();
    for r in page["rows"].as_array().unwrap() {
        let d = detail(s, b, r["id"].as_i64().unwrap()).await;
        if d["author"]["login"] != login {
            out.push(d);
        }
        if out.len() == 2 {
            break;
        }
    }
    assert_eq!(out.len(), 2, "two open issues of others' in {repo}");
    out
}

/// A new issue the account opens in `repo` (Read may: title and body only).
async fn own_issue(s: &Stack, b: &mut Browser, repo_id: &Value) -> Value {
    let (status, reply) = op(
        s,
        b,
        json!({ "kind": "create", "repo": repo_id, "title": "Mine", "body": "My own words" }),
    )
    .await;
    assert_eq!(status, 200, "{reply}");
    detail(s, b, reply["issue"].as_i64().unwrap()).await
}

/// The ops of the matrix, by what `can` calls each, made on issue `d` in turn: `other` is another
/// issue in its repo, `child` an issue with no relationships yet (a sub-issue and a blocker), and
/// the label, assignee and milestone are the repo's own.
async fn matrix_writes(
    s: &Stack,
    b: &mut Browser,
    d: &Value,
    other: &Value,
    child: &Value,
) -> Vec<(&'static str, Value)> {
    let id = d["id"].as_i64().unwrap();
    let repo = d["repo_id"].as_i64().unwrap();
    let (_, labels) = s.api(b, &format!("/api/repos/{repo}/labels")).await;
    let label = labels[0]["name"].clone();
    let (_, milestones) = s.api(b, &format!("/api/repos/{repo}/milestones")).await;
    let milestone = milestones[0]["number"].clone();
    let (_, source) = s.api(b, &format!("/api/issues/{id}/source")).await;
    let end = |e: &Value| json!({ "id": e["id"], "owner": e["owner"], "repo": e["repo"], "number": e["number"] });
    vec![
        (
            "comment",
            json!({ "kind": "comment", "issue": id, "body": "A comment" }),
        ),
        (
            "close",
            json!({ "kind": "close", "issue": id, "reason": "completed" }),
        ),
        ("reopen", json!({ "kind": "reopen", "issue": id })),
        (
            "labels",
            json!({ "kind": "label_add", "issue": id, "label": label }),
        ),
        (
            "labels",
            json!({ "kind": "label_remove", "issue": id, "label": label }),
        ),
        // tomsj has Admin everywhere: GitHub assigns only people with Write or up.
        (
            "assignees",
            json!({ "kind": "assignee_add", "issue": id, "login": "tomsj" }),
        ),
        (
            "assignees",
            json!({ "kind": "assignee_remove", "issue": id, "login": "tomsj" }),
        ),
        (
            "milestone",
            json!({ "kind": "milestone_set", "issue": id, "milestone": milestone }),
        ),
        (
            "edit",
            json!({ "kind": "title_edit", "issue": id, "new": "Renamed", "base": d["title"] }),
        ),
        (
            "edit",
            json!({ "kind": "body_edit", "issue": id, "new": "New words", "base": source["body"] }),
        ),
        (
            "relationships",
            json!({ "kind": "relate_add", "issue": id, "other": end(other) }),
        ),
        (
            "relationships",
            json!({ "kind": "block_add", "issue": id, "other": end(child), "blocking": false }),
        ),
        (
            "relationships",
            json!({ "kind": "sub_add", "issue": id, "child": end(child), "replace_parent": false, "after": null }),
        ),
        (
            "relationships",
            json!({ "kind": "sub_reorder", "issue": id, "child": child["id"], "after": null }),
        ),
    ]
}

/// What `matrix_writes` makes, in its order.
const WRITES: [&str; 14] = [
    "comment",
    "close",
    "reopen",
    "labels",
    "labels",
    "assignees",
    "assignees",
    "milestone",
    "edit",
    "edit",
    "relationships",
    "relationships",
    "relationships",
    "relationships",
];

/// One row of the matrix: an issue as one role sees it, and what each op comes to (`None`: it's
/// made; else the refusal's reason), in `WRITES`' order.
struct Case {
    name: &'static str,
    issue: Value,
    other: Value,
    expect: Vec<(&'static str, Option<String>)>,
}

/// Every op made, as for Write and up.
fn all_made() -> Vec<(&'static str, Option<String>)> {
    WRITES.iter().map(|&c| (c, None)).collect()
}

/// `made`'s ops made, and every other op refused, each with its reason from `why`.
fn only(made: &[&str], why: impl Fn(&str) -> String) -> Vec<(&'static str, Option<String>)> {
    WRITES
        .iter()
        .map(|&c| (c, (!made.contains(&c)).then(|| why(c))))
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_role_matrix_holds_in_me_the_detail_and_real_writes() {
    let s = start().await;
    let mut b = s.sign_in("ilze-k").await;
    let (cli, docs, web) = (
        repo(&s, &mut b, "cli").await,
        repo(&s, &mut b, "docs").await,
        repo(&s, &mut b, "web").await,
    );
    let all = [
        "comment",
        "close",
        "reopen",
        "labels",
        "assignees",
        "milestone",
        "edit",
        "relationships",
    ];

    // `/api/me`'s tables, per repo: what the account may do on its own issues and on others', and
    // why not the rest.
    let table = |r: &Value, side: &str| -> Vec<String> {
        r["can"][side]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c.as_str().unwrap().to_owned())
            .collect()
    };
    let strings = |xs: &[&str]| xs.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    assert_eq!(
        table(&cli, "own"),
        strings(&["comment", "close", "reopen", "edit", "create"])
    );
    assert_eq!(table(&cli, "others"), strings(&["comment", "create"]));
    assert_eq!(cli["can"]["denied_own"]["labels"], "you have Read on cli");
    assert_eq!(
        cli["can"]["denied_own"]["relationships"],
        "needs Triage on cli"
    );
    let mut triage_all = strings(&all);
    triage_all.push("create".into());
    assert_eq!(table(&docs, "own"), triage_all);
    assert_eq!(
        table(&docs, "others"),
        strings(&[
            "comment",
            "close",
            "reopen",
            "labels",
            "assignees",
            "milestone",
            "relationships",
            "create"
        ])
    );
    assert_eq!(
        docs["can"]["denied_others"],
        json!({ "edit": "you have Triage on docs, which edits only issues you opened" })
    );
    assert_eq!(table(&web, "own"), triage_all);
    assert_eq!(table(&web, "others"), triage_all);
    assert_eq!(web["can"]["denied_own"], json!({}));

    let read = |why: &str| why.to_owned();
    let cli_others = others_issues(&s, &mut b, "cli", "ilze-k").await;
    let docs_others = others_issues(&s, &mut b, "docs", "ilze-k").await;
    let web_others = others_issues(&s, &mut b, "web", "ilze-k").await;
    let read_cli = |c: &str| match c {
        // GitHub answers 403 to labels and assignees, and drops the milestone silently.
        "labels" | "assignees" | "milestone" => read("you have Read on cli"),
        "close" | "reopen" => {
            read("you have Read on cli, which closes or reopens only issues you opened")
        }
        "edit" => read("you have Read on cli, which edits only issues you opened"),
        // Authorship gives no relationship rights.
        _ => read("needs Triage on cli"),
    };
    let cases = vec![
        Case {
            name: "Read, own",
            issue: own_issue(&s, &mut b, &cli["id"]).await,
            other: cli_others[0].clone(),
            expect: only(&["comment", "close", "reopen", "edit"], read_cli),
        },
        Case {
            name: "Read, others'",
            issue: cli_others[0].clone(),
            other: cli_others[1].clone(),
            expect: only(&["comment"], read_cli),
        },
        Case {
            name: "Triage, own",
            issue: own_issue(&s, &mut b, &docs["id"]).await,
            other: docs_others[0].clone(),
            expect: all_made(),
        },
        Case {
            name: "Triage, others'",
            issue: docs_others[0].clone(),
            other: docs_others[1].clone(),
            // GitHub answers 200 and leaves the text as it was.
            expect: only(
                &[
                    "comment",
                    "close",
                    "reopen",
                    "labels",
                    "assignees",
                    "milestone",
                    "relationships",
                ],
                |_| read("you have Triage on docs, which edits only issues you opened"),
            ),
        },
        Case {
            name: "Write, own",
            issue: own_issue(&s, &mut b, &web["id"]).await,
            other: web_others[0].clone(),
            expect: all_made(),
        },
        Case {
            name: "Write, others'",
            issue: web_others[0].clone(),
            other: web_others[1].clone(),
            expect: all_made(),
        },
    ];

    for case in cases {
        let id = case.issue["id"].as_i64().unwrap();
        // The detail's `can` set: the ops the case makes, each once; the rest have a reason.
        let d = detail(&s, &mut b, id).await;
        let mut offered: Vec<&str> = case
            .expect
            .iter()
            .filter(|(_, why)| why.is_none())
            .map(|(c, _)| *c)
            .collect();
        offered.dedup();
        assert_eq!(d["can"], json!(offered), "{}: can", case.name);
        for (c, why) in case.expect.iter().filter(|(_, why)| why.is_some()) {
            assert_eq!(
                d["denied"][c].as_str().map(str::to_owned),
                *why,
                "{}: why not {c}",
                case.name
            );
        }

        // Real writes, each as GitHub answers it. The sub-issue and blocker is a new issue of
        // the account's own in the case's repo, with no relationships of its own yet.
        let child = own_issue(&s, &mut b, &d["repo_id"]).await;
        let writes = matrix_writes(&s, &mut b, &d, &case.other, &child).await;
        for ((c, o), (want_c, want)) in writes.into_iter().zip(&case.expect) {
            assert_eq!(c, *want_c);
            let (status, reply) = op(&s, &b, o.clone()).await;
            match want {
                None => assert_eq!(status, 200, "{}: {o} → {reply}", case.name),
                Some(why) => {
                    assert_eq!(
                        (status, reply["error"].as_str(), reply["message"].as_str()),
                        (422, Some("refused"), Some(why.as_str())),
                        "{}: {o}",
                        case.name
                    );
                }
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cross_repo_relationship_needs_triage_on_both_repos() {
    let s = start().await;
    // Triage on docs, Read on cli, Write on web.
    let mut b = s.sign_in("ilze-k").await;
    let docs = others_issues(&s, &mut b, "docs", "ilze-k").await;
    let cli = others_issues(&s, &mut b, "cli", "ilze-k").await;
    let web = others_issues(&s, &mut b, "web", "ilze-k").await;
    let end = |d: &Value| json!({ "id": d["id"], "owner": d["owner"], "repo": d["repo"], "number": d["number"] });
    // Any relationship write reaching GitHub would use up one of these failures.
    const WRITES_TO_GITHUB: [&str; 3] = [
        "POST /repos/*/*/issues/*/relates_to",
        "POST /repos/*/*/issues/*/dependencies/blocked_by",
        "POST /repos/*/*/issues/*/sub_issues",
    ];
    for endpoint in WRITES_TO_GITHUB {
        s.fake(
            "POST",
            "/faults/fail",
            json!({ "endpoint": endpoint, "status": 502, "count": 100 }),
        )
        .await;
    }

    // Each way round, and as each kind: refused before any call, from the stored roles.
    for (issue, other) in [(&docs[0], &cli[0]), (&cli[0], &docs[0])] {
        let id = issue["id"].as_i64().unwrap();
        for o in [
            json!({ "kind": "relate_add", "issue": id, "other": end(other) }),
            json!({ "kind": "block_add", "issue": id, "other": end(other), "blocking": false }),
            json!({ "kind": "sub_add", "issue": id, "child": end(other), "replace_parent": false, "after": null }),
        ] {
            let (status, reply) = op(&s, &b, o.clone()).await;
            assert_eq!(
                (status, reply["message"].as_str()),
                (422, Some("needs Triage on cli")),
                "{o} → {reply}"
            );
        }
    }
    let rules = s.fake("GET", "/state", Value::Null).await["faults"]["fail"].clone();
    for rule in rules.as_array().unwrap() {
        assert_eq!(rule["remaining"], 100, "a write reached GitHub: {rule}");
    }
    s.fake("DELETE", "/faults", Value::Null).await;
    // The picker says so beside each issue in the other repo.
    let docs_id = docs[0]["id"].as_i64().unwrap();
    let q = format!("cli%23{}", cli[0]["number"]);
    let (_, offered) = s
        .api(
            &mut b,
            &format!("/api/issues/{docs_id}/relatable?kind=relates&q={q}"),
        )
        .await;
    assert_eq!(offered[0]["why_not"], "needs Triage on cli", "{offered}");

    // Triage on one and Write on the other: made.
    let (status, reply) = op(
        &s,
        &b,
        json!({ "kind": "relate_add", "issue": docs_id, "other": end(&web[0]) }),
    )
    .await;
    assert_eq!(status, 200, "{reply}");
    let q = format!("web%23{}", web[1]["number"]);
    let (_, offered) = s
        .api(
            &mut b,
            &format!("/api/issues/{docs_id}/relatable?kind=relates&q={q}"),
        )
        .await;
    assert_eq!(offered[0]["why_not"], Value::Null, "{offered}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_role_changed_on_github_reaches_the_tabs_as_a_roles_push() {
    // A live session's roles are re-read every `repo_refresh_every`; a second here.
    let s = start_with(|c| c.repo_refresh_every = Duration::from_secs(1)).await;
    let mut b = s.sign_in("ilze-k").await;
    let issue = &others_issues(&s, &mut b, "docs", "ilze-k").await[0];
    let id = issue["id"].as_i64().unwrap();
    assert_eq!(detail(&s, &mut b, id).await["role_line"], "Triage on docs");
    let mut st = s.stream(&b).await;
    st.reset().await;

    s.fake(
        "PUT",
        "/permissions",
        json!({ "login": "ilze-k", "repo": "docs", "role": "write" }),
    )
    .await;
    let ev = st
        .event_within(Duration::from_secs(5))
        .await
        .expect("a push");
    assert_eq!((ev.event.as_str(), ev.data.as_str()), ("roles", "{}"));
    let d = detail(&s, &mut b, id).await;
    assert_eq!(d["role_line"], Value::Null);
    assert!(d["can"].as_array().unwrap().contains(&json!("edit")), "{d}");
    assert_eq!(repo(&s, &mut b, "docs").await["role"], "write");
    // Nothing changed since: no more pushes.
    assert_eq!(st.events_for(Duration::from_secs(2)).await, Vec::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refusal_that_finds_the_role_changed_pushes_roles_to_the_tabs() {
    let s = start().await;
    let mut b = s.sign_in("ilze-k").await;
    let issue = &others_issues(&s, &mut b, "docs", "ilze-k").await[0];
    let id = issue["id"].as_i64().unwrap();
    let mut st = s.stream(&b).await;
    st.reset().await;
    s.fake(
        "PUT",
        "/permissions",
        json!({ "login": "ilze-k", "repo": "docs", "role": "read" }),
    )
    .await;

    let (status, reply) = op(
        &s,
        &b,
        json!({ "kind": "close", "issue": id, "reason": "completed" }),
    )
    .await;
    assert_eq!(
        (status, reply["message"].as_str()),
        (
            422,
            Some("you have Read on docs, which closes or reopens only issues you opened")
        ),
        "{reply}"
    );
    let events: Vec<String> = st
        .events_for(Duration::from_secs(2))
        .await
        .into_iter()
        .map(|e| e.event)
        .collect();
    assert_eq!(events, ["roles"]);
    assert_eq!(detail(&s, &mut b, id).await["can"], json!(["comment"]));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_archived_repo_is_read_only_for_everyone() {
    let s = start().await;
    // Admin everywhere.
    let mut b = s.sign_in("tomsj").await;
    let issue = &others_issues(&s, &mut b, "docs", "tomsj").await[0];
    let id = issue["id"].as_i64().unwrap();
    let mut st = s.stream(&b).await;
    st.reset().await;

    s.fake(
        "POST",
        "/archive",
        json!({ "repo": "docs", "archived": true }),
    )
    .await;
    let ev = st
        .event_within(Duration::from_secs(5))
        .await
        .expect("a push");
    assert_eq!(ev.event, "roles");
    let docs = repo(&s, &mut b, "docs").await;
    assert_eq!(docs["can"]["own"], json!([]));
    assert_eq!(docs["can"]["others"], json!([]));
    assert_eq!(
        docs["can"]["denied_own"]["create"],
        "docs is archived, so it's read-only"
    );
    let d = detail(&s, &mut b, id).await;
    assert_eq!(d["role_line"], "Archived repo · read-only");
    assert_eq!(d["can"], json!([]));
    assert_eq!(
        d["denied"]["comment"],
        "docs is archived, so it's read-only"
    );
    // GitHub refuses a write all the same, and the reason is the repo's.
    let (status, reply) = op(
        &s,
        &b,
        json!({ "kind": "comment", "issue": id, "body": "Too late" }),
    )
    .await;
    assert_eq!(
        (status, reply["message"].as_str()),
        (422, Some("docs is archived, so it's read-only")),
        "{reply}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_locked_issue_takes_comments_only_from_write_and_up() {
    let s = start().await;
    let mut b = s.sign_in("ilze-k").await;
    let docs = &others_issues(&s, &mut b, "docs", "ilze-k").await[0];
    let web = &others_issues(&s, &mut b, "web", "ilze-k").await[0];
    let mut st = s.stream(&b).await;
    st.reset().await;
    for d in [docs, web] {
        s.edit(json!({ "repo": d["repo"], "number": d["number"], "locked": true }))
            .await;
        st.event_within(Duration::from_secs(5))
            .await
            .expect("a push");
    }

    // Triage: no composer, and GitHub refuses the comment.
    let id = docs["id"].as_i64().unwrap();
    let d = detail(&s, &mut b, id).await;
    assert_eq!(d["locked"], true);
    assert!(
        !d["can"].as_array().unwrap().contains(&json!("comment")),
        "{d}"
    );
    let why = "it's locked, and only Write and up comment on it; you have Triage on docs";
    assert_eq!(d["denied"]["comment"], why);
    // Locking takes nothing else away.
    assert!(
        d["can"].as_array().unwrap().contains(&json!("labels")),
        "{d}"
    );
    let (status, reply) = op(
        &s,
        &b,
        json!({ "kind": "comment", "issue": id, "body": "Hello" }),
    )
    .await;
    assert_eq!(
        (status, reply["message"].as_str()),
        (422, Some(why)),
        "{reply}"
    );

    // Write keeps the composer, and comments.
    let id = web["id"].as_i64().unwrap();
    let d = detail(&s, &mut b, id).await;
    assert_eq!(d["locked"], true);
    assert!(
        d["can"].as_array().unwrap().contains(&json!("comment")),
        "{d}"
    );
    let (status, reply) = op(
        &s,
        &b,
        json!({ "kind": "comment", "issue": id, "body": "Hello" }),
    )
    .await;
    assert_eq!(status, 200, "{reply}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stored_role_too_low_refuses_then_is_re_read_and_the_next_attempt_goes_through() {
    let s = start().await;
    let mut b = s.sign_in("ilze-k").await;
    let cli = others_issues(&s, &mut b, "cli", "ilze-k").await;
    let billing = repo(&s, &mut b, "billing").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    // GitHub raises her to Triage on both; beghu still has Read (its next re-read is minutes off).
    for repo in ["cli", "billing"] {
        s.fake(
            "PUT",
            "/permissions",
            json!({ "login": "ilze-k", "repo": repo, "role": "triage" }),
        )
        .await;
    }
    let end = |d: &Value| json!({ "id": d["id"], "owner": d["owner"], "repo": d["repo"], "number": d["number"] });
    let relate = json!({ "kind": "relate_add", "issue": cli[0]["id"], "other": end(&cli[1]) });

    // A relationship: refused from the stored role, before any call, and the role is re-read.
    let (status, reply) = op(&s, &b, relate.clone()).await;
    assert_eq!(
        (status, reply["message"].as_str()),
        (422, Some("needs Triage on cli")),
        "{reply}"
    );
    let ev = st
        .event_within(Duration::from_secs(5))
        .await
        .expect("a push");
    assert_eq!(ev.event, "roles");
    assert_eq!(repo(&s, &mut b, "cli").await["role"], "triage");
    let (status, reply) = op(&s, &b, relate).await;
    assert_eq!(status, 200, "{reply}");

    // A new issue's labels, the same way.
    let create = json!({ "kind": "create", "repo": billing["id"], "title": "Labelled", "body": "", "labels": ["bug"] });
    let (status, reply) = op(&s, &b, create.clone()).await;
    assert_eq!(
        (status, reply["message"].as_str()),
        (
            422,
            Some("you have Read on billing, which can't set labels, assignees or a milestone")
        ),
        "{reply}"
    );
    // The relationship just made pushes its issues too: past those, to the role's push.
    let pushed: Vec<String> = st
        .events_for(Duration::from_secs(3))
        .await
        .into_iter()
        .map(|e| e.event)
        .collect();
    assert!(pushed.contains(&"roles".to_owned()), "{pushed:?}");
    let (status, reply) = op(&s, &b, create).await;
    assert_eq!(status, 200, "{reply}");
    let made = detail(&s, &mut b, reply["issue"].as_i64().unwrap()).await;
    assert_eq!(made["labels"][0]["name"], "bug", "{made}");
}

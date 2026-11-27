//! An issue's or PR's body history, for Diff mode: `GET /api/issues/:id/history`, the earlier
//! versions of the body newest first, read from GitHub's `userContentEdits` with the viewer's
//! token and kept in the mirror until the body changes. Driven against Fake GitHub, with outside
//! edits through its control port.

mod common;

use common::{Browser, Stack, start};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

/// How many `BodyHistory` queries Fake GitHub has answered.
async fn history_reads(s: &Stack) -> u64 {
    s.fake("GET", "/state", Value::Null).await["graphql"]["operations"]["BodyHistory"]
        .as_u64()
        .unwrap_or(0)
}

/// The first open item of `kind` on the list whose body the fixture's history doesn't seed (see
/// Fake GitHub's `history.rs`): its id, repo and number.
async fn unseeded(s: &Stack, b: &mut Browser, kind: &str) -> (i64, String, i64) {
    let (_, page) = s.api(b, &format!("/api/issues?q=is:{kind}+is:open")).await;
    let r = page["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| {
            let n = r["number"].as_i64().unwrap();
            n > 58 || n % 5 != 3
        })
        .expect("an unseeded item");
    (
        r["id"].as_i64().unwrap(),
        format!(
            "{}/{}",
            r["owner"].as_str().unwrap(),
            r["repo"].as_str().unwrap()
        ),
        r["number"].as_i64().unwrap(),
    )
}

/// The body's Markdown as the mirror has it.
async fn source(s: &Stack, b: &mut Browser, id: i64) -> String {
    let (status, src) = s.api(b, &format!("/api/issues/{id}/source")).await;
    assert_eq!(status, 200, "{src}");
    src["body"].as_str().unwrap().to_owned()
}

/// Edits the body on GitHub as `login`, and waits for its webhook to reach the mirror.
async fn edit_body(
    s: &Stack,
    b: &mut Browser,
    (id, repo, number): (i64, &str, i64),
    login: &str,
    body: &str,
) {
    s.edit(json!({ "repo": repo, "number": number, "as": login, "body": body }))
        .await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while source(s, b, id).await != body {
        assert!(
            Instant::now() < deadline,
            "the edit never reached the mirror"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn history(s: &Stack, b: &mut Browser, id: i64) -> Value {
    let (status, h) = s.api(b, &format!("/api/issues/{id}/history")).await;
    assert_eq!(status, 200, "{h}");
    h
}

/// Every text in a rendered post, run together.
fn text(md: &Value) -> String {
    match md {
        Value::String(s) => s.clone(),
        // A node, `[tag, attrs | 0, ...children]`; else a post's list of blocks.
        Value::Array(a) if a.first().is_some_and(Value::is_string) && a.len() >= 2 => {
            a.iter().skip(2).map(text).collect()
        }
        Value::Array(a) => a.iter().map(text).collect(),
        _ => String::new(),
    }
}

/// Each revision's editor and text, newest first (`None` for a deleted one's).
fn versions(h: &Value) -> Vec<(Option<String>, Option<String>)> {
    h["revisions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["editor"].as_str().map(str::to_owned),
                (!r["body"].is_null()).then(|| text(&r["body"])),
            )
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn outside_edits_read_back_as_the_earlier_versions_newest_first_then_from_the_mirror() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, repo, number) = unseeded(&s, &mut b, "issue").await;
    let at = (id, repo.as_str(), number);
    let original = source(&s, &mut b, id).await;
    let (_, d) = s.api(&mut b, &format!("/api/issues/{id}")).await;
    let author = d["author"]["login"].as_str().unwrap().to_owned();

    // Never edited: no revisions, and nothing reaching back to the body as created.
    let h = history(&s, &mut b, id).await;
    assert_eq!(h["revisions"], json!([]));
    assert_eq!(h["includes_created"], false);
    assert_eq!(h["body_digest"], d["body_digest"]);

    edit_body(&s, &mut b, at, "ilze-k", "First **rewrite**").await;
    edit_body(&s, &mut b, at, "tomsj", "Second rewrite").await;
    let reads = history_reads(&s).await;
    let h = history(&s, &mut b, id).await;
    assert_eq!(history_reads(&s).await, reads + 1);
    // The newest revision is the current body, which the detail has: not repeated.
    let first_text = text(&history(&s, &mut b, id).await["revisions"][0]["body"]);
    assert_eq!(first_text, "First rewrite");
    let got = versions(&h);
    assert_eq!(got.len(), 2, "{h}");
    assert_eq!(got[0].0.as_deref(), Some("ilze-k"));
    assert_eq!(got[1].0.as_deref(), Some(author.as_str()));
    assert!(
        original.contains(
            got[1]
                .1
                .as_deref()
                .unwrap()
                .split_whitespace()
                .next()
                .unwrap()
        ),
        "the oldest is the body as created: {h}"
    );
    assert_eq!(h["includes_created"], true);
    let at_times: Vec<i64> = h["revisions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["edited_at"].as_i64().unwrap())
        .collect();
    assert!(at_times[0] >= at_times[1], "{at_times:?}");
    let (_, d) = s.api(&mut b, &format!("/api/issues/{id}")).await;
    assert_eq!(h["body_digest"], d["body_digest"]);

    // Read again with the body unchanged: from the mirror, with no GitHub call at all.
    let again = history(&s, &mut b, id).await;
    assert_eq!(again, h);
    assert_eq!(history_reads(&s).await, reads + 1);

    // The body changes: the next read asks GitHub again.
    edit_body(&s, &mut b, at, "ilze-k", "Third rewrite").await;
    let h = history(&s, &mut b, id).await;
    assert_eq!(history_reads(&s).await, reads + 2);
    let got = versions(&h);
    assert_eq!(got.len(), 3, "{h}");
    assert_eq!(
        got[..2],
        [
            (Some("tomsj".into()), Some("Second rewrite".into())),
            (Some("ilze-k".into()), Some("First rewrite".into())),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_changed_back_and_forth_keeps_one_revision_per_version() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, repo, number) = unseeded(&s, &mut b, "issue").await;
    let at = (id, repo.as_str(), number);
    edit_body(&s, &mut b, at, "ilze-k", "Same\nwords").await;
    // GitHub records a revision per edit, even one that only changes line ends.
    edit_body(&s, &mut b, at, "tomsj", "Same\r\nwords").await;
    edit_body(&s, &mut b, at, "tomsj", "Now").await;
    let h = history(&s, &mut b, id).await;
    let got = versions(&h);
    assert_eq!(got.len(), 2, "{h}");
    // The run of one body is kept as its oldest: when it came about.
    assert_eq!(got[0].0.as_deref(), Some("ilze-k"), "{h}");
    assert!(got[0].1.as_deref().unwrap().starts_with("Same"), "{h}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_prs_description_has_its_history_too() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, repo, number) = unseeded(&s, &mut b, "pr").await;
    edit_body(
        &s,
        &mut b,
        (id, repo.as_str(), number),
        "ilze-k",
        "Reworded description",
    )
    .await;
    let h = history(&s, &mut b, id).await;
    let got = versions(&h);
    assert_eq!(got.len(), 1, "{h}");
    assert!(got[0].1.is_some());
    assert_eq!(h["includes_created"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_revision_deleted_from_the_history_has_no_body() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, repo, number) = unseeded(&s, &mut b, "issue").await;
    let at = (id, repo.as_str(), number);
    edit_body(&s, &mut b, at, "ilze-k", "Something regrettable").await;
    edit_body(&s, &mut b, at, "ilze-k", "Something better").await;
    // From the newest: 0 is the current body, 1 the regrettable one.
    let done = s
        .fake(
            "POST",
            "/history/delete",
            json!({ "repo": repo, "number": number, "revision": 1 }),
        )
        .await;
    assert_eq!(done["ok"], true, "{done}");
    let h = history(&s, &mut b, id).await;
    let r = &h["revisions"][0];
    assert_eq!(r["deleted"], true, "{h}");
    assert_eq!(r["body"], Value::Null);
    assert_eq!(r["editor"], "ilze-k");
    assert_eq!(h["revisions"][1]["deleted"], false);
    assert!(!h["revisions"][1]["body"].is_null());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_fixture_has_history_on_issues_and_prs() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut seen = (0, 0);
    for number in (3..=58).step_by(5) {
        let (status, d) = s.api(&mut b, &format!("/api/at/acme/web/{number}")).await;
        assert_eq!(status, 200, "{d}");
        let h = history(&s, &mut b, d["id"].as_i64().unwrap()).await;
        let n = h["revisions"].as_array().unwrap().len();
        if n == 0 {
            continue;
        }
        assert!(n <= 3, "{h}");
        assert_eq!(h["includes_created"], true);
        if d["kind"] == "pr" {
            seen.1 += 1;
        } else {
            seen.0 += 1;
        }
    }
    assert!(seen.0 > 0 && seen.1 > 0, "{seen:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn github_down_or_rate_limited_says_so_and_a_later_read_works() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, ..) = unseeded(&s, &mut b, "issue").await;

    s.fake("POST", "/faults/down", json!({ "down": true }))
        .await;
    let (status, err) = s.api(&mut b, &format!("/api/issues/{id}/history")).await;
    assert_eq!(
        (status, err["error"].as_str()),
        (503, Some("github_down")),
        "{err}"
    );
    s.fake("POST", "/faults/down", json!({ "down": false }))
        .await;

    // GraphQL's own rate limit: a 200 with a RATE_LIMITED error.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "POST /graphql", "status": 200, "limit": "graphql", "count": 1 }),
    )
    .await;
    let deadline = Instant::now() + Duration::from_secs(10);
    let (status, err) = loop {
        let (status, err) = s.api(&mut b, &format!("/api/issues/{id}/history")).await;
        // The server may still count GitHub as down for a moment after the outage.
        if status != 503 || Instant::now() > deadline {
            break (status, err);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    assert_eq!(
        (status, err["error"].as_str()),
        (429, Some("rate_limited")),
        "{err}"
    );
    let (status, h) = s.api(&mut b, &format!("/api/issues/{id}/history")).await;
    assert_eq!(status, 200, "{h}");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_id_the_mirror_doesnt_hold_is_gone() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    for id in ["1", "nope"] {
        let (status, err) = s.api(&mut b, &format!("/api/issues/{id}/history")).await;
        assert_eq!(
            (status, err["error"].as_str()),
            (404, Some("gone")),
            "{err}"
        );
    }
}

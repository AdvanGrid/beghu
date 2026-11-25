//! The PR view's analysis runs (#176), through HTTP: starting a run and its prompt, pinning on
//! the first fetch, every run file, each upload answer, the quote and `carried` checks, a
//! migrated upload and a migration on read, supersede, expiry and every revocation, the 3,000-file
//! refusal, the graph and claims answers, and the `analysis` event. GitHub's side (the PR's head,
//! files and description) is set up on Fake GitHub; the analyses are the analysis crate's
//! hand-written sample, each refused one built by editing it next to its assertion.

mod common;

use analysis::migrate::{Chain, Rename, Step};
use common::{Browser, Stack, start, start_with, until};
use serde_json::{Value, json};
use std::io::{Read as _, Write as _};
use std::time::Duration;

/// The head every test's PR is pushed to: the sample's `pr.headSha`.
const HEAD: &str = "2222222222222222222222222222222222222222";

/// The analysis crate's hand-written sample: a two-file PR adding refunds.
fn sample() -> Value {
    let mut v: Value =
        serde_json::from_str(include_str!("../../analysis/tests/sample/analysis.json")).unwrap();
    // A first analysis of the PR: nothing to carry.
    v["carried"] = json!([]);
    v
}

/// The sample's PR description, which its description evidence quotes.
fn description() -> String {
    sample()["pr"]["description"].as_str().unwrap().to_owned()
}

/// `tomsj`'s browser, and an open PR of `acme/web` set up as the sample's: its description, and
/// a push to [`HEAD`] changing the sample's two files.
async fn setup(s: &Stack) -> (Browser, i64) {
    let mut b = s.sign_in("tomsj").await;
    let number = setup_pr(s, &mut b, 0).await;
    (b, number)
}

/// The `index`th open PR of `acme/web`, set up as [`setup`] sets up the first.
async fn setup_pr(s: &Stack, b: &mut Browser, index: usize) -> i64 {
    let (status, page) = s
        .api(b, "/api/issues?q=is%3Apr%20is%3Aopen%20repo%3Aacme%2Fweb")
        .await;
    assert_eq!(status, 200, "{page}");
    let number = page["rows"][index]["number"].as_i64().unwrap();
    s.edit(json!({ "repo": "acme/web", "number": number, "body": description() }))
        .await;
    push(s, number, HEAD).await;
    number
}

/// A test's pause at `point` ([`beghu::Config::analysis_pause`]): the first run that gets there
/// says so on `reached` and waits there until `release`; every other passes.
struct Pause {
    reached: std::sync::Arc<tokio::sync::Notify>,
    release: std::sync::Arc<tokio::sync::Notify>,
}

fn pause_once(point: beghu::RunPausePoint) -> (beghu::RunPause, Pause) {
    let armed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let p = Pause {
        reached: Default::default(),
        release: Default::default(),
    };
    let (reached, release) = (p.reached.clone(), p.release.clone());
    let hook: beghu::RunPause = std::sync::Arc::new(move |at| {
        if at != point || !armed.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return Box::pin(async {});
        }
        let (reached, release) = (reached.clone(), release.clone());
        Box::pin(async move {
            reached.notify_one();
            release.notified().await;
        })
    });
    (hook, p)
}

/// A push to the PR's head: `sha`, changing the sample's two files.
async fn push(s: &Stack, number: i64, sha: &str) -> Value {
    s.fake(
        "POST",
        "/push",
        json!({
            "repo": "acme/web", "number": number, "sha": sha,
            "files": [
                { "filename": "api/main.go", "status": "modified", "additions": 1, "deletions": 0 },
                { "filename": "api/orders/refund.go", "status": "added", "additions": 21, "deletions": 0 },
            ],
        }),
    )
    .await
}

/// `POST /api/acme/web/pulls/{n}/runs` from the tab: the status and the body.
async fn start_run(s: &Stack, b: &Browser, number: i64) -> (u16, Value) {
    let res = s
        .api_write(
            b,
            reqwest::Method::POST,
            &format!("/api/acme/web/pulls/{number}/runs"),
        )
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

/// A started run's token.
async fn run(s: &Stack, b: &Browser, number: i64) -> String {
    let (status, body) = start_run(s, b, number).await;
    assert_eq!(status, 201, "{body}");
    body["token"].as_str().unwrap().to_owned()
}

/// A run file, as an agent fetches it with `curl`: no cookie, no `Origin`.
async fn fetch(s: &Stack, token: &str, file: &str) -> reqwest::Response {
    s.http
        .get(format!("{}/api/runs/{token}/{file}", s.server))
        .send()
        .await
        .unwrap()
}

async fn fetch_json(s: &Stack, token: &str, file: &str) -> (u16, Value) {
    let res = fetch(s, token, file).await;
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

/// An upload's `Beghu-Snippets: checked`, alone.
const CHECKED: &[(&str, &str)] = &[("beghu-snippets", "checked")];

/// An upload of `body` as is, `checked`.
async fn upload(s: &Stack, token: &str, body: &Value) -> (u16, Value) {
    upload_raw(s, token, serde_json::to_vec(body).unwrap(), CHECKED).await
}

async fn upload_raw(
    s: &Stack,
    token: &str,
    body: Vec<u8>,
    headers: &[(&str, &str)],
) -> (u16, Value) {
    let mut req = s
        .http
        .post(format!("{}/api/runs/{token}/analysis", s.server))
        .header("content-type", "application/json")
        .body(body);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let res = req.send().await.unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(bytes).unwrap();
    e.finish().unwrap()
}

/// The rule IDs of a 422's report.
fn rules(body: &Value) -> Vec<String> {
    body["report"]["errors"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|f| f["rule"].as_str().unwrap().to_owned())
        .collect()
}

/// The PR's graph as the tab reads it, with `accept-encoding` and `if-none-match` as given.
async fn graph(
    s: &Stack,
    b: &Browser,
    number: i64,
    accept: &str,
    etag: Option<&str>,
) -> reqwest::Response {
    let mut req = s
        .http
        .get(format!("{}/api/acme/web/pulls/{number}/analysis", s.server))
        .header("cookie", b.header())
        .header("accept-encoding", accept);
    if let Some(t) = etag {
        req = req.header("if-none-match", t);
    }
    req.send().await.unwrap()
}

/// A body as the server encoded it.
async fn decoded(res: reqwest::Response) -> Value {
    let enc = res
        .headers()
        .get("content-encoding")
        .map(|v| v.to_str().unwrap().to_owned());
    let bytes = res.bytes().await.unwrap();
    let mut out = Vec::new();
    match enc.as_deref() {
        Some("br") => {
            brotli::Decompressor::new(&bytes[..], 4096)
                .read_to_end(&mut out)
                .unwrap();
        }
        Some("gzip") => {
            flate2::read::GzDecoder::new(&bytes[..])
                .read_to_end(&mut out)
                .unwrap();
        }
        _ => out = bytes.to_vec(),
    }
    serde_json::from_slice(&out).unwrap()
}

/// The next `analysis` event on `st`, within a few seconds.
async fn analysis_event(st: &mut common::Stream) -> Value {
    for _ in 0..20 {
        match st.event_within(Duration::from_secs(5)).await {
            Some(ev) if ev.event == "analysis" => return serde_json::from_str(&ev.data).unwrap(),
            Some(_) => continue,
            None => break,
        }
    }
    panic!("no analysis event");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_starts_with_its_prompt_and_pins_the_pr_on_its_first_fetch() {
    let s = start().await;
    let (b, number) = setup(&s).await;
    let mut st = s.stream(&b).await;
    st.reset().await;

    let (status, started) = start_run(&s, &b, number).await;
    assert_eq!(status, 201, "{started}");
    let token = started["token"].as_str().unwrap();
    // 256 bits, URL-safe.
    assert_eq!(token.len(), 43, "{token}");
    assert_eq!(
        started["prompt"],
        format!(
            "Analyse pull request acme/web#{number} (2 files, +22 \u{2212}0) for beghu by fetching your instructions from `{}/api/runs/{token}/instructions` and following them to the end: they say how to check out the code, build and check the analysis, and upload it. Large PRs are split across several agents and can take an hour; treat the link as a password, as it lets anyone holding it act on this PR's analysis until the run ends.",
            s.server
        )
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let expires = started["expiresAt"].as_i64().unwrap();
    assert!((now + 24 * 3600 - expires).abs() < 60, "{expires}");
    assert_eq!(
        analysis_event(&mut st).await,
        json!({ "repo": "acme/web", "number": number })
    );
    // Only the token's hash is stored.
    assert!(!common::contains(
        &common::db_bytes(&s.control_db()),
        token.as_bytes()
    ));

    // A push before the first fetch is what the run pins.
    let later = "3333333333333333333333333333333333333333";
    push(&s, number, later).await;
    let (status, pr) = fetch_json(&s, token, "pr.json").await;
    assert_eq!(status, 200, "{pr}");
    assert_eq!(pr["headSha"], later);
    assert_eq!(pr["repo"], "acme/web");
    assert_eq!(pr["number"], number);
    assert_eq!(pr["body"], description());
    assert_eq!(pr["base"]["ref"], "main");
    assert_eq!(pr["base"]["sha"].as_str().unwrap().len(), 40);
    assert_eq!(
        pr["files"],
        json!([
            { "path": "api/main.go", "status": "modified", "additions": 1, "deletions": 0 },
            { "path": "api/orders/refund.go", "status": "added", "additions": 21, "deletions": 0 },
        ])
    );
    assert_eq!(
        pr["stats"],
        json!({ "files": 2, "additions": 22, "deletions": 0 })
    );
    assert_eq!(
        analysis_event(&mut st).await,
        json!({ "repo": "acme/web", "number": number }),
        "attached"
    );
    // A push after it changes nothing.
    push(&s, number, HEAD).await;
    let (_, again) = fetch_json(&s, token, "pr.json").await;
    assert_eq!(again["headSha"], later);

    // A token beghu never gave out.
    let (status, body) = fetch_json(&s, &"A".repeat(43), "pr.json").await;
    assert_eq!((status, body["error"].as_str()), (401, Some("bad_token")));
    let (status, _) = fetch_json(&s, "not-a-token", "pr.json").await;
    assert_eq!(status, 401);
}

#[tokio::test(flavor = "multi_thread")]
async fn every_run_file_is_served() {
    let s = start().await;
    let (b, number) = setup(&s).await;
    let token = run(&s, &b, number).await;

    let res = fetch(&s, &token, "instructions").await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["cache-control"], "no-store", "an API answer");
    let text = res.text().await.unwrap();
    for part in [
        format!("acme/web#{number}"),
        format!("`{HEAD}`"),
        "2 files, +22 \u{2212}0".to_owned(),
        "`test-build`".to_owned(),
        "3,000 changed files".to_owned(),
        "8 MB on the wire and 32 MB".to_owned(),
        format!("{}/api/runs/{token}/schema.ts", s.server),
        format!("{}/api/runs/{token}/analysis", s.server),
        "Beghu-Snippets: checked".to_owned(),
    ] {
        assert!(text.contains(&part), "the run header names {part}:\n{text}");
    }
    assert!(
        text.ends_with(analysis::INSTRUCTIONS),
        "ANALYSIS.md follows"
    );

    let res = fetch(&s, &token, "schema.ts").await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.text().await.unwrap(), analysis::SCHEMA_TS);
    for (name, body) in common::TOOLS {
        let res = fetch(&s, &token, name).await;
        assert_eq!(res.status(), 200, "{name}");
        assert_eq!(res.text().await.unwrap(), *body, "{name}");
    }
    // No previous analysis.
    for file in ["previous-ids.json", "vocabulary.json"] {
        let (status, body) = fetch_json(&s, &token, file).await;
        assert_eq!(
            (status, body["error"].as_str()),
            (404, Some("not_found")),
            "{file}"
        );
    }
    let (status, _) = fetch_json(&s, &token, "previous.json").await;
    assert_eq!(status, 404, "there is no previous.json");

    // Once an analysis is stored, its IDs and vocabulary, and nothing of its claims.
    let (status, accepted) = upload(&s, &token, &sample()).await;
    assert_eq!(status, 201, "{accepted}");
    let (status, ids) = fetch_json(&s, &token, "previous-ids.json").await;
    assert_eq!(status, 200, "{ids}");
    let nodes: Vec<&str> = ids["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["id"].as_str().unwrap())
        .collect();
    assert!(nodes.contains(&"api.orders"), "{ids}");
    assert_eq!(
        ids["edges"][0]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        ["from", "id", "to"]
    );
    let (status, vocabulary) = fetch_json(&s, &token, "vocabulary.json").await;
    assert_eq!(status, 200, "{vocabulary}");
    assert_eq!(vocabulary["purposes"][0]["id"], "purpose:refunds");
    assert!(
        !vocabulary.to_string().contains("\"claims\""),
        "{vocabulary}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn pr_json_serves_the_linked_issues_from_the_mirror_and_lists_the_rest() {
    let s = start().await;
    let (mut b, number) = setup(&s).await;
    // Issues of the account's synced repos, one of them with comments.
    let (_, page) = s
        .api(&mut b, "/api/issues?q=is%3Aissue%20repo%3Aacme%2Fweb")
        .await;
    let web = page["rows"][0]["number"].as_i64().unwrap();
    let (_, page) = s
        .api(&mut b, "/api/issues?q=is%3Aissue%20repo%3Aacme%2Fapi")
        .await;
    let api = page["rows"][0]["number"].as_i64().unwrap();
    let (_, page) = s
        .api(&mut b, "/api/issues?q=is%3Apr%20repo%3Aacme%2Fweb")
        .await;
    let other_pr = page["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["number"].as_i64().unwrap())
        .find(|n| *n != number)
        .unwrap();
    let body = format!(
        "{}\n\nSee #{web}, acme/api#{api} and nobody/nowhere#3. Follows #{other_pr}.\n\n`#999999` in code isn't a reference.",
        description()
    );
    s.edit(json!({ "repo": "acme/web", "number": number, "body": body }))
        .await;
    let token = run(&s, &b, number).await;
    let (status, pr) = fetch_json(&s, &token, "pr.json").await;
    assert_eq!(status, 200, "{pr}");
    let served: Vec<String> = pr["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| format!("{}#{}", i["repo"].as_str().unwrap(), i["number"]))
        .collect();
    // The PR's closing references come first, then the description's.
    assert_eq!(
        served[served.len() - 2..],
        [format!("acme/web#{web}"), format!("acme/api#{api}")]
    );
    let first = &pr["issues"][0];
    assert!(
        first["title"].is_string() && first["body"].is_string(),
        "{first}"
    );
    assert!(first["comments"].is_array(), "{first}");
    assert_eq!(
        pr["unreached"],
        json!([
            { "ref": "nobody/nowhere#3", "reason": "not in a repo you sync" },
            { "ref": format!("acme/web#{other_pr}"), "reason": "a pull request, not an issue" },
        ])
    );

    // Issue evidence quotes only a served issue, word for word.
    let quoted = pr["issues"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["body"].as_str().unwrap().split_whitespace().count() >= 4)
        .expect("a served issue with a body");
    let quote: String = quoted["body"]
        .as_str()
        .unwrap()
        .split_whitespace()
        .take(4)
        .collect::<Vec<_>>()
        .join(" ");
    let (repo, at) = (quoted["repo"].clone(), quoted["number"].clone());
    let mut a = sample();
    a["claims"][14]["evidence"][0] = json!({
        "kind": "issue", "repo": repo, "number": at, "quote": quote, "note": "the ask",
    });
    let (status, accepted) = upload(&s, &token, &a).await;
    assert_eq!(status, 201, "{accepted}");
    a["claims"][14]["evidence"][0]["quote"] = json!("words this issue never said");
    let (status, refused) = upload(&s, &token, &a).await;
    assert_eq!(status, 422, "{refused}");
    assert_eq!(rules(&refused), ["evidence.quote-mismatch"]);
    a["claims"][14]["evidence"][0] = json!({
        "kind": "issue", "repo": "nobody/nowhere", "number": 3, "quote": "anything", "note": "unreached",
    });
    let (status, refused) = upload(&s, &token, &a).await;
    assert_eq!(status, 422, "{refused}");
    assert_eq!(rules(&refused), ["evidence.issue-not-served"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn each_upload_answer() {
    let s = start().await;
    let (b, number) = setup(&s).await;
    let token = run(&s, &b, number).await;
    let mut st = s.stream(&b).await;
    st.reset().await;

    // Fails the validator: a node with no kind.
    let mut a = sample();
    a["nodes"][1].as_object_mut().unwrap().remove("kind");
    let (status, refused) = upload(&s, &token, &a).await;
    assert_eq!(
        (status, refused["error"].as_str()),
        (422, Some("refused")),
        "{refused}"
    );
    assert_eq!(rules(&refused), ["shape.missing-field"]);
    assert_eq!(refused["version"], analysis::VERSION);
    assert_eq!(
        analysis_event(&mut st).await,
        json!({ "repo": "acme/web", "number": number }),
        "a refusal"
    );

    // A newer version than the server's.
    let mut a = sample();
    a["version"] = json!(analysis::VERSION + 1);
    let (status, refused) = upload(&s, &token, &a).await;
    assert_eq!(status, 422, "{refused}");
    assert_eq!(rules(&refused), ["version.unknown"]);
    assert_eq!(refused["version"], analysis::VERSION);

    // A shape error is answered before the head.
    let mut a = sample();
    a["pr"]["headSha"] = json!("4444444444444444444444444444444444444444");
    let (status, moved) = upload(&s, &token, &a).await;
    assert_eq!(
        (status, moved["error"].as_str()),
        (409, Some("head_moved")),
        "{moved}"
    );
    assert_eq!(moved["pinned"], HEAD);
    a["nodes"][1].as_object_mut().unwrap().remove("kind");
    assert_eq!(upload(&s, &token, &a).await.0, 422);

    // A changed file placed on no node.
    let mut a = sample();
    a["nodes"][1]["files"] = json!([]);
    let (status, refused) = upload(&s, &token, &a).await;
    assert_eq!(status, 422, "{refused}");
    assert!(
        rules(&refused).contains(&"file.unplaced".to_owned()),
        "{refused}"
    );

    // A description quote that isn't word for word.
    let mut a = sample();
    a["claims"][14]["evidence"][0]["quote"] = json!("Adds a refund endpoint for invoices.");
    let (status, refused) = upload(&s, &token, &a).await;
    assert_eq!(status, 422, "{refused}");
    assert_eq!(rules(&refused), ["evidence.quote-mismatch"]);
    assert_eq!(
        refused["report"]["errors"][0]["path"],
        "/claims/14/evidence/0/quote"
    );

    // With no previous analysis, `carried` must be empty.
    let mut a = sample();
    a["carried"] = sample_carried();
    let (status, refused) = upload(&s, &token, &a).await;
    assert_eq!(status, 422, "{refused}");
    assert_eq!(rules(&refused), ["carry.unknown"]);

    // Too large: past 8 MB on the wire, or 32 MB inflated.
    let big = vec![b' '; 8 * 1024 * 1024 + 1];
    let (status, refused) = upload_raw(&s, &token, big, CHECKED).await;
    assert_eq!(
        (status, refused["error"].as_str()),
        (413, Some("too_large")),
        "{refused}"
    );
    assert_eq!(
        refused["limits"],
        json!({ "wire": 8 << 20, "inflated": 32 << 20 })
    );
    let bomb = gzip(&vec![b' '; 33 * 1024 * 1024]);
    let (status, _) = upload_raw(
        &s,
        &token,
        bomb,
        &[("content-encoding", "gzip"), ("beghu-snippets", "checked")],
    )
    .await;
    assert_eq!(status, 413);
    let (status, refused) = upload_raw(
        &s,
        &token,
        b"{}".to_vec(),
        &[("content-encoding", "br"), ("beghu-snippets", "checked")],
    )
    .await;
    assert_eq!(
        (status, refused["error"].as_str()),
        (415, Some("unsupported_encoding"))
    );

    // Accepted, gzipped: its ID, the head and the warnings.
    let body = gzip(&serde_json::to_vec(&sample()).unwrap());
    let (status, accepted) = upload_raw(
        &s,
        &token,
        body,
        &[
            ("content-encoding", "gzip"),
            ("beghu-snippets", "not-checked"),
        ],
    )
    .await;
    assert_eq!(status, 201, "{accepted}");
    let id = accepted["analysis"].as_str().unwrap().to_owned();
    assert_eq!(accepted["headSha"], HEAD);
    assert!(accepted["warnings"].is_array(), "{accepted}");
    // Every refused upload counted, and their reports are kept on the run; the event names the
    // analysis.
    let mut ev = analysis_event(&mut st).await;
    while ev.get("analysis").is_none() {
        ev = analysis_event(&mut st).await;
    }
    assert_eq!(
        ev,
        json!({ "repo": "acme/web", "number": number, "analysis": id })
    );
    let res = graph(&s, &b, number, "identity", None).await;
    assert_eq!(decoded(res).await["snippets"], "not-checked");

    // Uploads are unlimited within the run; each accepted one replaces the analysis. The
    // second keeps every ID, so it needs no `carried`.
    let (status, again) = upload(&s, &token, &sample()).await;
    assert_eq!(status, 201, "{again}");
    assert_ne!(again["analysis"], id);
    let res = graph(&s, &b, number, "identity", None).await;
    let g = decoded(res).await;
    assert_eq!(
        (g["id"].clone(), g["snippets"].clone()),
        (again["analysis"].clone(), json!("checked"))
    );

    // Ended: every later call is told why.
    let res = s
        .http
        .post(format!("{}/api/runs/{token}/end", s.server))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    let (status, gone) = upload(&s, &token, &sample()).await;
    assert_eq!(
        (status, gone["error"].as_str(), gone["reason"].as_str()),
        (410, Some("run_ended"), Some("ended"))
    );
}

/// The sample's own `carried`: `api.payments`, renamed to `api.orders` as a correction.
fn sample_carried() -> Value {
    let v: Value =
        serde_json::from_str(include_str!("../../analysis/tests/sample/analysis.json")).unwrap();
    v["carried"].clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn carried_is_checked_against_the_stored_analysis() {
    let s = start().await;
    let (b, number) = setup(&s).await;
    let token = run(&s, &b, number).await;
    // The first analysis calls the part `api.payments`, and so its lines.
    let first = rename(sample(), "api.orders", "api.payments");
    let (status, accepted) = upload(&s, &token, &first).await;
    assert_eq!(status, 201, "{accepted}");

    // The next, from a new run, calls it `api.orders`: the old ID must be accounted for.
    let token = run(&s, &b, number).await;
    let (status, refused) = upload(&s, &token, &sample()).await;
    assert_eq!(status, 422, "{refused}");
    assert!(
        rules(&refused).iter().all(|r| r == "carry.unaccounted"),
        "{refused}"
    );
    assert!(!rules(&refused).is_empty());
    // Each renamed ID declared, the part's and its lines'.
    let mut carried = sample_carried().as_array().unwrap().clone();
    for e in sample()["edges"].as_array().unwrap() {
        let now = e["id"].as_str().unwrap();
        if now.contains("api.orders") {
            carried.push(json!({
                "kind": "renamed", "was": now.replace("api.orders", "api.payments"), "now": [now],
                "cause": "correction", "reason": "the part is api/orders", "claims": ["c3"],
            }));
        }
    }
    let mut a = sample();
    a["carried"] = Value::Array(carried);
    let (status, accepted) = upload(&s, &token, &a).await;
    assert_eq!(status, 201, "{accepted}");
}

/// `v` with every string equal to `from`, or starting with `from` and a separator, renamed.
fn rename(v: Value, from: &str, to: &str) -> Value {
    match v {
        Value::String(s) if s == from => Value::String(to.to_owned()),
        Value::String(s) => {
            for sep in ["->", ":"] {
                if let Some(rest) = s.strip_prefix(&format!("{from}{sep}")) {
                    return Value::String(format!("{to}{sep}{rest}"));
                }
                if let Some(head) = s.strip_suffix(&format!("{sep}{from}")) {
                    return Value::String(format!("{head}{sep}{to}"));
                }
            }
            Value::String(s)
        }
        Value::Array(a) => Value::Array(a.into_iter().map(|x| rename(x, from, to)).collect()),
        Value::Object(o) => Value::Object(
            o.into_iter()
                .map(|(k, x)| (k, rename(x, from, to)))
                .collect(),
        ),
        other => other,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_graph_and_its_claims_are_served_as_stored_with_their_etag() {
    let s = start().await;
    let (b, number) = setup(&s).await;
    let res = graph(&s, &b, number, "br", None).await;
    assert_eq!(res.status(), 404);
    assert_eq!(decoded(res).await["error"], "no_analysis");

    let token = run(&s, &b, number).await;
    let (status, accepted) = upload(&s, &token, &sample()).await;
    assert_eq!(status, 201, "{accepted}");
    let id = accepted["analysis"].as_str().unwrap();

    let res = graph(&s, &b, number, "gzip, deflate, br", None).await;
    assert_eq!(res.status(), 200);
    let h = res.headers().clone();
    assert_eq!(h["content-encoding"], "br");
    assert_eq!(h["etag"], format!("\"{id}.v{}\"", analysis::VERSION));
    assert_eq!(h["cache-control"], "private, no-cache");
    assert_eq!(h["vary"], "accept-encoding");
    let g = decoded(res).await;
    assert_eq!(g["id"], id);
    assert_eq!(g["version"], analysis::VERSION);
    assert_eq!(g["headSha"], HEAD);
    assert_eq!(g["mergeBase"], sample()["pr"]["baseSha"]);
    assert_eq!(g["snippets"], "checked");
    assert_eq!(g["migratedIds"], json!([]));
    let claims_url = format!(
        "/api/acme/web/pulls/{number}/analysis/{id}/v{}/claims",
        analysis::VERSION
    );
    assert_eq!(g["claimsUrl"], claims_url);
    // The graph keeps everything but the claims' bodies: each claim's ID, status and evidence
    // counts.
    let mut expected = typed(sample());
    expected["claims"] = Value::Null;
    let mut got = g["analysis"].clone();
    let stubs = got["claims"].take();
    assert_eq!(got, expected);
    assert_eq!(
        stubs[14],
        json!({ "id": "c15", "status": "supported", "code": 0, "description": 1, "issue": 0 })
    );
    assert_eq!(
        stubs.as_array().unwrap().len(),
        sample()["claims"].as_array().unwrap().len()
    );

    // gzip, or as is.
    let res = graph(&s, &b, number, "gzip", None).await;
    assert_eq!(res.headers()["content-encoding"], "gzip");
    assert_eq!(decoded(res).await, g);
    let res = graph(&s, &b, number, "identity", None).await;
    assert!(res.headers().get("content-encoding").is_none());
    assert_eq!(decoded(res).await, g);

    // A revisit: 304, no body.
    let etag = h["etag"].to_str().unwrap();
    let res = graph(&s, &b, number, "br", Some(etag)).await;
    assert_eq!(res.status(), 304);
    assert_eq!(res.headers()["etag"], etag);
    assert!(res.bytes().await.unwrap().is_empty());

    // The claims, whole, immutable.
    let res = s
        .http
        .get(format!("{}{claims_url}", s.server))
        .header("cookie", b.header())
        .header("accept-encoding", "br")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers()["cache-control"],
        "private, max-age=31536000, immutable"
    );
    let c = decoded(res).await;
    assert_eq!(c["claims"], typed(sample())["claims"]);
    // Another analysis, or version: 404.
    for url in [
        format!(
            "/api/acme/web/pulls/{number}/analysis/nope/v{}/claims",
            analysis::VERSION
        ),
        format!(
            "/api/acme/web/pulls/{number}/analysis/{id}/v{}/claims",
            analysis::VERSION + 1
        ),
    ] {
        let res = s.get(&mut b.clone(), &url).await;
        assert_eq!(res.status(), 404, "{url}");
    }
    // Only the account's own: another account has none, and its claims URL is no one else's.
    let mut ilze = s.sign_in("ilze-k").await;
    let res = graph(&s, &ilze, number, "br", None).await;
    assert_eq!(res.status(), 404);
    let url = format!(
        "/api/acme/web/pulls/{number}/analysis/{id}/v{}/claims",
        analysis::VERSION
    );
    let res = s.get(&mut ilze, &url).await;
    assert_eq!(res.status(), 404, "{url}");
}

/// `v` as the schema's types write it: what the server stores of an upload.
fn typed(v: Value) -> Value {
    serde_json::to_value(serde_json::from_value::<analysis::Analysis>(v).unwrap()).unwrap()
}

/// A chain one version ahead of this build's: its step renames `api.orders`.
fn bump(mut v: Value) -> Result<(Value, Vec<Rename>), String> {
    v = rename(v, "api.orders", "api.order-flow");
    Ok((
        v,
        vec![Rename {
            old: "api.orders".into(),
            new: "api.order-flow".into(),
            step: 1,
        }],
    ))
}

static AHEAD: Chain<'static> = Chain {
    version: 2,
    steps: &[Step { from: 1, run: bump }],
};

fn broken(_: Value) -> Result<(Value, Vec<Rename>), String> {
    Err("this step fails".into())
}

static BROKEN: Chain<'static> = Chain {
    version: 2,
    steps: &[Step {
        from: 1,
        run: broken,
    }],
};

#[tokio::test(flavor = "multi_thread")]
async fn an_older_upload_is_migrated_and_so_is_a_stored_analysis_on_read() {
    let mut s = start().await;
    let (b, number) = setup(&s).await;
    let token = run(&s, &b, number).await;
    let (status, accepted) = upload(&s, &token, &sample()).await;
    assert_eq!(status, 201, "{accepted}");
    let id = accepted["analysis"].as_str().unwrap().to_owned();
    let old = graph(&s, &b, number, "br", None).await;
    let old_etag = old.headers()["etag"].to_str().unwrap().to_owned();

    // A deploy whose migration fails: a 500 of its own kind, and the stored analysis is left
    // as it was.
    s.restart_with(|c| c.analysis_chain = &BROKEN).await;
    let b = s.sign_in("tomsj").await;
    let res = graph(&s, &b, number, "br", None).await;
    assert_eq!(res.status(), 500);
    assert_eq!(decoded(res).await["error"], "migration_failed");
    s.restart_with(|_| {}).await;
    let b = s.sign_in("tomsj").await;
    let res = graph(&s, &b, number, "br", Some(&old_etag)).await;
    assert_eq!(res.status(), 304, "untouched");

    // A deploy a schema version ahead: the first read migrates and writes it back, under the
    // same ID; the ETag and the claims URL move to the new version.
    s.restart_with(|c| c.analysis_chain = &AHEAD).await;
    let b = s.sign_in("tomsj").await;
    let res = graph(&s, &b, number, "br", Some(&old_etag)).await;
    assert_eq!(res.status(), 200, "not a stale 304");
    assert_eq!(res.headers()["etag"], format!("\"{id}.v2\""));
    let g = decoded(res).await;
    assert_eq!(g["version"], 2);
    assert_eq!(g["analysis"]["version"], 2);
    assert_eq!(
        g["migratedIds"],
        json!([{ "old": "api.orders", "new": "api.order-flow", "step": 1 }])
    );
    assert!(g.to_string().contains("api.order-flow"));
    let claims = |v: u32| format!("/api/acme/web/pulls/{number}/analysis/{id}/v{v}/claims");
    assert_eq!(s.get(&mut b.clone(), &claims(1)).await.status(), 404);
    assert_eq!(s.get(&mut b.clone(), &claims(2)).await.status(), 200);

    // An upload made against version 1 is migrated on arrival: accepted with a warning, or
    // refused with word that the schema moved. The stored analysis it's checked against is at
    // version 2 too, so `api.orders` → `api.order-flow` needs no `carried`.
    let token = run(&s, &b, number).await;
    let mut bad = sample();
    bad["nodes"][1]["files"] = json!([]);
    let (status, refused) = upload(&s, &token, &bad).await;
    assert_eq!(status, 422, "{refused}");
    assert!(
        refused["message"]
            .as_str()
            .unwrap()
            .contains("moved from version 1 to 2"),
        "{refused}"
    );
    let (status, accepted) = upload(&s, &token, &sample()).await;
    assert_eq!(status, 201, "{accepted}");
    let warned: Vec<&str> = accepted["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["rule"].as_str().unwrap())
        .collect();
    assert!(warned.contains(&"schema.migrated"), "{accepted}");
    let res = graph(&s, &b, number, "br", None).await;
    let g = decoded(res).await;
    assert_eq!(g["version"], 2);
    assert_eq!(
        g["migratedIds"],
        json!([{ "old": "api.orders", "new": "api.order-flow", "step": 1 }])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_run_supersedes_the_live_one_and_ending_it_revokes_it() {
    let s = start().await;
    let (b, number) = setup(&s).await;
    let first = run(&s, &b, number).await;
    assert_eq!(fetch_json(&s, &first, "pr.json").await.0, 200);
    let second = run(&s, &b, number).await;
    let (status, gone) = fetch_json(&s, &first, "pr.json").await;
    assert_eq!(
        (status, gone["reason"].as_str()),
        (410, Some("superseded")),
        "{gone}"
    );
    assert_eq!(fetch_json(&s, &second, "pr.json").await.0, 200);

    // The panel ends it.
    let mut st = s.stream(&b).await;
    st.reset().await;
    let res = s
        .api_write(
            &b,
            reqwest::Method::DELETE,
            &format!("/api/acme/web/pulls/{number}/run"),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    assert_eq!(
        analysis_event(&mut st).await,
        json!({ "repo": "acme/web", "number": number })
    );
    let (status, gone) = fetch_json(&s, &second, "instructions").await;
    assert_eq!(
        (status, gone["reason"].as_str()),
        (410, Some("ended")),
        "{gone}"
    );
    assert!(
        gone["message"]
            .as_str()
            .unwrap()
            .ends_with("Start a new run.")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_expires_unused_or_idle() {
    let s = start_with(|c| {
        c.runs.unused_for = Duration::from_secs(2);
        c.runs.idle_for = Duration::from_secs(3);
    })
    .await;
    let (b, number) = setup(&s).await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let unused = run(&s, &b, number).await;
    analysis_event(&mut st).await;
    // Nobody calls: the run's watch expires it, and the tabs hear it.
    assert_eq!(
        analysis_event(&mut st).await,
        json!({ "repo": "acme/web", "number": number }),
        "expired"
    );
    let (status, gone) = fetch_json(&s, &unused, "pr.json").await;
    assert_eq!(
        (status, gone["reason"].as_str()),
        (410, Some("expired")),
        "{gone}"
    );

    // Attached, it lives while it's called, then expires once idle.
    let token = run(&s, &b, number).await;
    for _ in 0..3 {
        assert_eq!(fetch_json(&s, &token, "pr.json").await.0, 200);
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
    tokio::time::sleep(Duration::from_secs(4)).await;
    let (status, gone) = fetch_json(&s, &token, "pr.json").await;
    assert_eq!(
        (status, gone["reason"].as_str()),
        (410, Some("expired")),
        "{gone}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_out_of_every_browser_revokes_a_run() {
    let s = start().await;
    let (mut b, number) = setup(&s).await;
    let mut other = s.sign_in("tomsj").await;
    let token = run(&s, &b, number).await;
    // Signed out of one browser, still signed in on the other.
    let account = b.account();
    s.post_form(&mut b, "/auth/logout", &[("account", &account)])
        .await;
    assert_eq!(fetch_json(&s, &token, "pr.json").await.0, 200);
    s.post_form(&mut other, "/auth/logout", &[("account", &account)])
        .await;
    let (status, gone) = fetch_json(&s, &token, "pr.json").await;
    assert_eq!(
        (status, gone["reason"].as_str()),
        (410, Some("signed_out")),
        "{gone}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_revoked_grant_revokes_a_run() {
    let s = start().await;
    let (b, number) = setup(&s).await;
    let token = run(&s, &b, number).await;
    s.fake("POST", "/revoke", json!({ "login": "tomsj" })).await;
    until(15.0, "the run revoked", || async {
        let (status, gone) = fetch_json(&s, &token, "pr.json").await;
        (status == 410).then_some(gone)
    })
    .await;
    let (_, gone) = fetch_json(&s, &token, "pr.json").await;
    assert_eq!(gone["reason"], "sign_in_again", "{gone}");
}

#[tokio::test(flavor = "multi_thread")]
async fn losing_read_on_the_repo_revokes_a_run() {
    let s = start_with(|c| c.repo_refresh_every = Duration::from_secs(1)).await;
    let (mut b, number) = setup(&s).await;
    let token = run(&s, &b, number).await;
    assert_eq!(fetch_json(&s, &token, "pr.json").await.0, 200);
    s.fake(
        "PUT",
        "/permissions",
        json!({ "login": "tomsj", "repo": "web", "role": null }),
    )
    .await;
    until(15.0, "the run revoked", || {
        let mut b = b.clone();
        let s = &s;
        let token = token.clone();
        async move {
            // The tab's use keeps the account's roles re-read.
            s.api(&mut b, "/api/me").await;
            let (status, gone) = fetch_json(s, &token, "pr.json").await;
            (status == 410).then_some(gone)
        }
    })
    .await;
    let (_, gone) = fetch_json(&s, &token, "pr.json").await;
    assert_eq!(gone["reason"], "no_read", "{gone}");
    let _ = s.api(&mut b, "/api/me").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn going_dormant_revokes_a_run_and_deletes_the_analyses() {
    let s = start_with(|c| {
        c.accounts_check_every = Duration::from_millis(100);
        c.dormant_after = Duration::from_secs(3);
    })
    .await;
    let (b, number) = setup(&s).await;
    let token = run(&s, &b, number).await;
    let (status, _) = upload(&s, &token, &sample()).await;
    assert_eq!(status, 201);
    let account: i64 = b.account().parse().unwrap();
    let file = s.data.join("analyses").join(format!("{account}.db"));
    assert!(file.exists());
    until(15.0, "the analyses deleted", || async {
        (!file.exists()).then_some(())
    })
    .await;
    let (status, gone) = fetch_json(&s, &token, "pr.json").await;
    assert_eq!(
        (status, gone["reason"].as_str()),
        (410, Some("dormant")),
        "{gone}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pr_past_3000_files_is_refused_at_the_start() {
    let s = start().await;
    let (b, number) = setup(&s).await;
    s.fake(
        "POST",
        "/push",
        json!({ "repo": "acme/web", "number": number, "file_count": 3001 }),
    )
    .await;
    let (status, refused) = start_run(&s, &b, number).await;
    assert_eq!(
        (status, refused["error"].as_str()),
        (422, Some("pr_too_large")),
        "{refused}"
    );
    assert!(
        refused["message"].as_str().unwrap().contains("3000"),
        "{refused}"
    );
    // At the cap, it starts.
    s.fake(
        "POST",
        "/push",
        json!({ "repo": "acme/web", "number": number, "file_count": 3000 }),
    )
    .await;
    let token = run(&s, &b, number).await;
    let (status, pr) = fetch_json(&s, &token, "pr.json").await;
    assert_eq!(status, 200);
    assert_eq!(pr["files"].as_array().unwrap().len(), 3000);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cli_run_needs_the_cli_credential() {
    let s = start().await;
    let res = s
        .http
        .post(format!("{}/api/cli/runs", s.server))
        .header("authorization", "Bearer beghu_cli_unknown")
        .json(&json!({ "owner": "acme", "repo": "web", "number": 1 }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_upload_without_a_known_beghu_snippets_is_a_400_and_not_counted() {
    let s = start().await;
    let (b, number) = setup(&s).await;
    let token = run(&s, &b, number).await;
    // Attached first: its event isn't among the ones counted below.
    assert_eq!(fetch_json(&s, &token, "pr.json").await.0, 200);
    let mut st = s.stream(&b).await;
    st.reset().await;
    let body = serde_json::to_vec(&sample()).unwrap();
    for headers in [&[][..], &[("beghu-snippets", "maybe")][..]] {
        let (status, bad) = upload_raw(&s, &token, body.clone(), headers).await;
        assert_eq!(
            (status, bad["error"].as_str()),
            (400, Some("bad_request")),
            "{headers:?}: {bad}"
        );
        assert!(
            bad["message"].as_str().unwrap().contains("Beghu-Snippets"),
            "{bad}"
        );
    }
    // A refused upload counts and the tabs hear it; neither 400 did, so the first event is this
    // refusal's.
    let mut a = sample();
    a["nodes"][1].as_object_mut().unwrap().remove("kind");
    assert_eq!(upload(&s, &token, &a).await.0, 422);
    let mut seen = Vec::new();
    while let Some(ev) = st.event_within(Duration::from_secs(2)).await {
        if ev.event == "analysis" {
            seen.push(ev.data);
        }
    }
    assert_eq!(seen.len(), 1, "only the 422 is a refusal: {seen:?}");
    // Nothing was stored by either.
    assert_eq!(graph(&s, &b, number, "identity", None).await.status(), 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_lives_at_most_its_lifetime_from_its_start() {
    let s = start_with(|c| {
        c.runs.unused_for = Duration::from_secs(60);
        c.runs.idle_for = Duration::from_secs(60);
        c.runs.lives_for = Duration::from_secs(6);
    })
    .await;
    let (b, number) = setup(&s).await;
    let started = std::time::Instant::now();
    let token = run(&s, &b, number).await;
    // Attached halfway through: the cap still counts from the start.
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(fetch_json(&s, &token, "pr.json").await.0, 200);
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(fetch_json(&s, &token, "schema.ts").await.0, 200);
    // Busy, but 7 s after its start (6 s after it attached would be 9 s).
    tokio::time::sleep(Duration::from_secs(7).saturating_sub(started.elapsed())).await;
    let (status, gone) = fetch_json(&s, &token, "pr.json").await;
    assert_eq!(
        (status, gone["reason"].as_str()),
        (410, Some("expired")),
        "{gone}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_upload_superseded_while_it_is_checked_stores_nothing() {
    let (hook, pause) = pause_once(beghu::RunPausePoint::Store);
    let s = start_with(move |c| c.analysis_pause = Some(hook)).await;
    let (b, number) = setup(&s).await;
    let token = run(&s, &b, number).await;
    let uploading = {
        let (http, url) = (
            s.http.clone(),
            format!("{}/api/runs/{token}/analysis", s.server),
        );
        tokio::spawn(async move {
            let res = http
                .post(url)
                .header("content-type", "application/json")
                .header("beghu-snippets", "checked")
                .body(serde_json::to_vec(&sample()).unwrap())
                .send()
                .await
                .unwrap();
            let status = res.status().as_u16();
            (status, res.json::<Value>().await.unwrap())
        })
    };
    // Checked and about to be stored, the upload's run is superseded.
    tokio::time::timeout(Duration::from_secs(15), pause.reached.notified())
        .await
        .expect("the upload reached its store");
    let newer = run(&s, &b, number).await;
    pause.release.notify_one();
    let (status, gone) = uploading.await.unwrap();
    assert_eq!(
        (status, gone["error"].as_str(), gone["reason"].as_str()),
        (410, Some("run_ended"), Some("superseded")),
        "{gone}"
    );
    assert_eq!(graph(&s, &b, number, "identity", None).await.status(), 404);
    // The newer run's upload is stored.
    assert_eq!(upload(&s, &newer, &sample()).await.0, 201);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_ended_first_by_another_call_is_reported_as_that() {
    let (hook, pause) = pause_once(beghu::RunPausePoint::End);
    let s = start_with(move |c| c.analysis_pause = Some(hook)).await;
    let (mut b, number) = setup(&s).await;
    let token = run(&s, &b, number).await;
    assert_eq!(fetch_json(&s, &token, "pr.json").await.0, 200);
    // Signed out of the only browser: the next call finds the run revoked, and is held as it
    // goes to mark it so.
    let account = b.account();
    s.post_form(&mut b, "/auth/logout", &[("account", &account)])
        .await;
    let fetching = {
        let (http, url) = (
            s.http.clone(),
            format!("{}/api/runs/{token}/pr.json", s.server),
        );
        tokio::spawn(async move {
            let res = http.get(url).send().await.unwrap();
            let status = res.status().as_u16();
            (status, res.json::<Value>().await.unwrap())
        })
    };
    tokio::time::timeout(Duration::from_secs(15), pause.reached.notified())
        .await
        .expect("the call reached its end");
    // Meanwhile, signed in again, a newer run supersedes it.
    let b = s.sign_in("tomsj").await;
    run(&s, &b, number).await;
    pause.release.notify_one();
    let (status, gone) = fetching.await.unwrap();
    assert_eq!(
        (status, gone["reason"].as_str()),
        (410, Some("superseded")),
        "{gone}"
    );
}

/// Every upload holds at its store, its turn held, until `release` says `true`: how many got
/// there is `arrived`.
struct HeldAtStore {
    arrived: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    release: tokio::sync::watch::Sender<bool>,
}

impl HeldAtStore {
    fn count(&self) -> usize {
        self.arrived.load(std::sync::atomic::Ordering::SeqCst)
    }
}

fn held_at_store() -> (beghu::RunPause, HeldAtStore) {
    let arrived = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (release, released) = tokio::sync::watch::channel(false);
    let hook: beghu::RunPause = {
        let arrived = arrived.clone();
        std::sync::Arc::new(move |at| {
            if at != beghu::RunPausePoint::Store {
                return Box::pin(async {});
            }
            arrived.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let mut released = released.clone();
            Box::pin(async move {
                let _ = released.wait_for(|r| *r).await;
            })
        })
    };
    (hook, HeldAtStore { arrived, release })
}

/// `tomsj`'s browser, and a run's token for each of `n` PRs of `acme/web` set up as [`setup`]
/// sets up the first.
async fn runs_on_prs(s: &Stack, n: usize) -> (Browser, Vec<String>) {
    let (mut b, first) = setup(s).await;
    let mut tokens = vec![run(s, &b, first).await];
    for i in 1..n {
        let number = setup_pr(s, &mut b, i).await;
        tokens.push(run(s, &b, number).await);
    }
    (b, tokens)
}

/// The sample uploaded with `token`, in a task of its own: its status.
fn upload_task(s: &Stack, token: &str) -> tokio::task::JoinHandle<(u16, Value)> {
    let (http, url) = (
        s.http.clone(),
        format!("{}/api/runs/{token}/analysis", s.server),
    );
    tokio::spawn(async move {
        let res = http
            .post(url)
            .header("content-type", "application/json")
            .header("beghu-snippets", "checked")
            .body(serde_json::to_vec(&sample()).unwrap())
            .send()
            .await
            .unwrap();
        let status = res.status().as_u16();
        (status, res.json().await.unwrap_or(Value::Null))
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn two_uploads_at_most_do_the_heavy_work_at_once() {
    let (hook, held) = held_at_store();
    let s = start_with(move |c| c.analysis_pause = Some(hook)).await;
    // One upload per PR, so no PR's lock holds one back.
    let (_b, tokens) = runs_on_prs(&s, 3).await;
    let uploads: Vec<_> = tokens.iter().map(|t| upload_task(&s, t)).collect();
    until(15.0, "two uploads at their store", || async {
        (held.count() >= 2).then_some(())
    })
    .await;
    // The third waits for a turn while the two hold theirs.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(held.count(), 2);
    held.release.send(true).unwrap();
    for u in uploads {
        assert_eq!(u.await.unwrap().0, 201);
    }
    assert_eq!(held.count(), 3);
}

/// The sample sent whole as an upload with `token` over a connection of its own, which the
/// caller closes once it likes: a client that leaves without waiting for the answer.
fn send_upload(s: &Stack, token: &str) -> std::net::TcpStream {
    let addr = s.server.trim_start_matches("http://");
    let body = serde_json::to_vec(&sample()).unwrap();
    let mut c = std::net::TcpStream::connect(addr).unwrap();
    let head = format!(
        "POST /api/runs/{token}/analysis HTTP/1.1\r\nhost: {addr}\r\ncontent-type: application/json\r\nbeghu-snippets: checked\r\ncontent-length: {}\r\n\r\n",
        body.len()
    );
    c.write_all(head.as_bytes()).unwrap();
    c.write_all(&body).unwrap();
    c
}

#[tokio::test(flavor = "multi_thread")]
async fn an_upload_whose_client_leaves_keeps_its_turn_until_its_work_is_done() {
    let (hook, held) = held_at_store();
    let s = start_with(move |c| c.analysis_pause = Some(hook)).await;
    let (b, tokens) = runs_on_prs(&s, 3).await;
    // Two uploads sent whole, each client gone once its upload holds its turn.
    for (i, token) in tokens[..2].iter().enumerate() {
        let c = send_upload(&s, token);
        until(15.0, "the upload at its store", || async {
            (held.count() > i).then_some(())
        })
        .await;
        drop(c);
    }
    // The third still waits for a turn: the two that left hold theirs until their work is done.
    let third = upload_task(&s, &tokens[2]);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(held.count(), 2);
    held.release.send(true).unwrap();
    assert_eq!(third.await.unwrap().0, 201);
    assert_eq!(held.count(), 3);
    // Nobody heard their answers, but the two were stored all the same.
    let (status, page) = s
        .api(
            &mut b.clone(),
            "/api/issues?q=is%3Apr%20is%3Aopen%20repo%3Aacme%2Fweb",
        )
        .await;
    assert_eq!(status, 200, "{page}");
    for i in 0..2 {
        let number = page["rows"][i]["number"].as_i64().unwrap();
        until(15.0, "the upload stored", || async {
            (graph(&s, &b, number, "identity", None).await.status() == 200).then_some(())
        })
        .await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_rearms_every_live_runs_expiry() {
    let adjust = |c: &mut beghu::Config| c.runs.unused_for = Duration::from_secs(3);
    let mut s = start_with(adjust).await;
    let (b, number) = setup(&s).await;

    // Past its deadline by the time beghu is back: expired as it starts, and the tabs hear it.
    let token = run(&s, &b, number).await;
    s.stop();
    tokio::time::sleep(Duration::from_secs(4)).await;
    let held = s.restart_held(adjust).await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    held.start().await;
    assert_eq!(
        analysis_event(&mut st).await,
        json!({ "repo": "acme/web", "number": number }),
        "expired at startup"
    );
    let (status, gone) = fetch_json(&s, &token, "pr.json").await;
    assert_eq!(
        (status, gone["reason"].as_str()),
        (410, Some("expired")),
        "{gone}"
    );

    // Not yet due: its timer, re-armed, expires it on time with no call made.
    let token = run(&s, &b, number).await;
    s.restart_with(adjust).await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    assert_eq!(
        analysis_event(&mut st).await,
        json!({ "repo": "acme/web", "number": number }),
        "expired by its re-armed timer"
    );
    let (status, gone) = fetch_json(&s, &token, "pr.json").await;
    assert_eq!(
        (status, gone["reason"].as_str()),
        (410, Some("expired")),
        "{gone}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_ended_runs_timer_stops_with_it() {
    let s = start().await;
    let (b, number) = setup(&s).await;
    // The same calls once first, so the server's tasks for them (its connection) are counted.
    run(&s, &b, number).await;
    end_live(&s, &b, number).await;
    let before = s.server_tasks();
    // Forty runs, each superseding the one before, and the last ended: each run's 24 h timer
    // must stop with it.
    for _ in 0..40 {
        run(&s, &b, number).await;
    }
    end_live(&s, &b, number).await;
    until(15.0, "the server's tasks settled", || async {
        (s.server_tasks() <= before + 10).then_some(())
    })
    .await;
}

/// The panel ends the PR's live run.
async fn end_live(s: &Stack, b: &Browser, number: i64) {
    let res = s
        .api_write(
            b,
            reqwest::Method::DELETE,
            &format!("/api/acme/web/pulls/{number}/run"),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
}

#[tokio::test(flavor = "multi_thread")]
async fn disconnect_deletes_the_analyses() {
    let s = start().await;
    let (mut b, number) = setup(&s).await;
    let token = run(&s, &b, number).await;
    assert_eq!(upload(&s, &token, &sample()).await.0, 201);
    let account = b.account();
    let file = s.data.join("analyses").join(format!("{account}.db"));
    assert!(file.exists());
    let res = s
        .post_form(&mut b, "/auth/disconnect", &[("account", &account)])
        .await;
    assert_eq!(res.status(), 303);
    until(15.0, "the analyses deleted", || async {
        (!file.exists()).then_some(())
    })
    .await;
    let (status, gone) = fetch_json(&s, &token, "pr.json").await;
    assert_eq!(
        (status, gone["reason"].as_str()),
        (410, Some("sign_in_again")),
        "{gone}"
    );
    // Signed in again, the account starts with none.
    let b = s.sign_in("tomsj").await;
    let res = graph(&s, &b, number, "identity", None).await;
    assert_eq!(res.status(), 404);
    assert_eq!(decoded(res).await["error"], "no_analysis");
    let (status, gone) = fetch_json(&s, &token, "pr.json").await;
    assert_eq!((status, gone["error"].as_str()), (410, Some("run_ended")));
}

#[tokio::test(flavor = "multi_thread")]
async fn losing_read_on_the_repo_deletes_its_analyses_and_runs() {
    let s = start_with(|c| c.repo_refresh_every = Duration::from_secs(1)).await;
    let (mut b, number) = setup(&s).await;
    let token = run(&s, &b, number).await;
    assert_eq!(upload(&s, &token, &sample()).await.0, 201);
    let mut st = s.stream(&b).await;
    st.reset().await;
    s.fake(
        "PUT",
        "/permissions",
        json!({ "login": "tomsj", "repo": "web", "role": null }),
    )
    .await;
    // The tab's use keeps the account's roles re-read; no call on the run is made, so the
    // run's end is the lost Read's.
    let mut heard = None;
    for _ in 0..30 {
        s.api(&mut b, "/api/me").await;
        if let Some(ev) = st.event_within(Duration::from_millis(500)).await
            && ev.event == "analysis"
        {
            heard = Some(serde_json::from_str::<Value>(&ev.data).unwrap());
            break;
        }
    }
    assert_eq!(heard, Some(json!({ "repo": "acme/web", "number": number })));
    let (status, gone) = fetch_json(&s, &token, "pr.json").await;
    assert_eq!(
        (status, gone["reason"].as_str()),
        (410, Some("no_read")),
        "{gone}"
    );

    // Read again: the analysis went with the Read, and the run is still told why it ended.
    s.fake(
        "PUT",
        "/permissions",
        json!({ "login": "tomsj", "repo": "web", "role": "admin" }),
    )
    .await;
    until(15.0, "the repo readable again", || {
        let mut b = b.clone();
        let s = &s;
        async move {
            s.api(&mut b, "/api/me").await;
            let res = graph(s, &b, number, "identity", None).await;
            let status = res.status();
            let body = decoded(res).await;
            // `no_analysis` either way; readable once a run can start.
            assert_eq!(
                (status.as_u16(), &body["error"]),
                (404, &json!("no_analysis"))
            );
            (start_run(s, &b, number).await.0 == 201).then_some(())
        }
    })
    .await;
    let (status, gone) = fetch_json(&s, &token, "pr.json").await;
    assert_eq!(
        (status, gone["reason"].as_str()),
        (410, Some("no_read")),
        "{gone}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daily_check_prunes_runs_long_ended() {
    let s = start_with(|c| {
        c.accounts_check_every = Duration::from_millis(200);
        c.runs.ended_kept_for = Duration::from_secs(1);
    })
    .await;
    let (b, number) = setup(&s).await;
    let token = run(&s, &b, number).await;
    let res = s
        .http
        .post(format!("{}/api/runs/{token}/end", s.server))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    // Told why at first; once kept long enough, its token is gone with its row.
    let (status, gone) = fetch_json(&s, &token, "pr.json").await;
    assert_eq!((status, gone["reason"].as_str()), (410, Some("ended")));
    until(15.0, "the ended run pruned", || async {
        let (status, body) = fetch_json(&s, &token, "pr.json").await;
        (status == 401).then_some(body)
    })
    .await;
    // A live run is kept, however old the check's limit.
    let live = run(&s, &b, number).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(fetch_json(&s, &live, "pr.json").await.0, 200);
}

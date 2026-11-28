//! The PR view's recorded PR (#178): `AdvanGrid/beghu#191`, which every fixture holds and Fake
//! GitHub serves at v1's head. A run on it pins the recorded `pr.json` byte for byte, the
//! recorded analysis uploads through the run as the agent sent it and is accepted, and the server
//! keeps the upload's body, which `./dev-ctl analysis record` reads back untouched. v2 follows on
//! the same account after the PR moves to its head.

mod common;

use common::{RECORDED, start};
use serde_json::{Value, json};

#[tokio::test(flavor = "multi_thread")]
async fn the_recorded_pr_pins_as_recorded_and_its_analysis_is_accepted_and_kept_untouched() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let up = s.upload_recorded(&b, 1, 1).await;
    assert_eq!(up.status, 201, "{}", up.answer);
    let v1 = fixture::recorded::version(RECORDED, 1).unwrap();
    let pinned: serde_json::Value = serde_json::from_str(&up.pinned).unwrap();
    assert_eq!(pinned, v1.pr, "the pin is the recorded pr.json");
    assert_eq!(up.answer["headSha"], v1.pr["headSha"]);

    // The stored upload is the committed file, byte for byte.
    let id = up.answer["analysis"].as_str().unwrap();
    let dbs: Vec<_> = std::fs::read_dir(s.data.join("analyses"))
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "db"))
        .collect();
    assert_eq!(dbs.len(), 1, "only tomsj has an analyses.db: {dbs:?}");
    let got = analysis_fixtures::record(&dbs[0], id).unwrap();
    let committed =
        std::fs::read_to_string(fixture::recorded::analysis_path(RECORDED, 1).unwrap()).unwrap();
    assert!(got.analysis == committed, "the upload is kept untouched");
    // And the run's pin is stored as the recording has it, byte for byte.
    assert!(got.pr == v1.text);
    assert_eq!(got.number, i64::from(RECORDED));

    // Each claim's stub in the graph names the issues it quotes, once each, for the
    // walkthrough's `#N` chips; a claim quoting none has no `issues`.
    let mut tomsj = b;
    let g: Value = s
        .get(
            &mut tomsj,
            &format!("/api/AdvanGrid/beghu/pulls/{RECORDED}/analysis"),
        )
        .await
        .json()
        .await
        .unwrap();
    let recorded: Value = serde_json::from_str(&committed).unwrap();
    let stubs = g["analysis"]["claims"].as_array().unwrap();
    let mut quoting = 0;
    for (stub, claim) in stubs.iter().zip(recorded["claims"].as_array().unwrap()) {
        assert_eq!(stub["id"], claim["id"]);
        let mut want: Vec<String> = Vec::new();
        for e in claim["evidence"].as_array().unwrap() {
            if e["kind"] == "issue" {
                let r = format!("{}#{}", e["repo"].as_str().unwrap(), e["number"]);
                if !want.contains(&r) {
                    want.push(r);
                }
            }
        }
        if want.is_empty() {
            assert_eq!(stub.get("issues"), None, "{stub}");
        } else {
            quoting += 1;
            assert_eq!(stub["issues"], json!(want), "{stub}");
        }
    }
    assert!(quoting > 0, "v1 quotes the issues its run served");

    // The graph is tomsj's alone: ilze-k, who sees the repo, has no analysis of it.
    let mut ilze = s.sign_in("ilze-k").await;
    let res = s
        .get(
            &mut ilze,
            &format!("/api/AdvanGrid/beghu/pulls/{RECORDED}/analysis"),
        )
        .await;
    assert_eq!(res.status(), 404);
}

/// A gzipped upload (`Content-Encoding: gzip`, as an agent's `curl --data-binary @file.gz`) is
/// kept inflated, byte for byte what the agent compressed, and recorded so.
#[tokio::test(flavor = "multi_thread")]
async fn a_gzipped_upload_is_kept_and_recorded_exactly() {
    use std::io::Write as _;
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let (_, token) = s.pin_recorded(&b, 1, 1).await;
    let committed =
        std::fs::read_to_string(fixture::recorded::analysis_path(RECORDED, 1).unwrap()).unwrap();
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(committed.as_bytes()).unwrap();
    let res = s
        .http
        .post(format!("{}/api/runs/{token}/analysis", s.server))
        .header("content-type", "application/json")
        .header("content-encoding", "gzip")
        .header("beghu-snippets", "checked")
        .body(gz.finish().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 201);
    let answer: Value = res.json().await.unwrap();
    let id = answer["analysis"].as_str().unwrap();
    let db = std::fs::read_dir(s.data.join("analyses"))
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|x| x == "db"))
        .unwrap();
    let got = analysis_fixtures::record(&db, id).unwrap();
    assert!(got.analysis == committed, "kept as the agent wrote it");
}

/// v2 on top of v1: the PR moves to v2's head, a new run pins v2's `pr.json` byte for byte, and
/// v2 (whose `carried` is checked against v1) is accepted. Moving the PR back restores v1's pin,
/// and moving it on again v2's: the comment v2's thread adds, deleted on the way back, is made
/// again, as a new comment.
#[tokio::test(flavor = "multi_thread")]
async fn v2_is_accepted_after_v1_once_the_pr_moves_to_its_head() {
    let v1 = fixture::recorded::version(RECORDED, 1).unwrap();
    let v2 = fixture::recorded::version(RECORDED, 2).expect("v2 is recorded");
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let up = s.upload_recorded(&b, 1, 1).await;
    assert_eq!(up.status, 201, "{}", up.answer);
    let up = s.upload_recorded(&b, 1, 2).await;
    assert_eq!(up.status, 201, "{}", up.answer);
    assert_eq!(up.answer["headSha"], v2.pr["headSha"]);
    let pinned: Value = serde_json::from_str(&up.pinned).unwrap();
    assert_eq!(pinned, v2.pr, "the pin is v2's pr.json");

    let (back, _) = s.pin_recorded(&b, 2, 1).await;
    let back: Value = serde_json::from_str(&back).unwrap();
    assert_eq!(back, v1.pr, "v1's pin, as it was");
    let (again, _) = s.pin_recorded(&b, 1, 2).await;
    let again: Value = serde_json::from_str(&again).unwrap();
    assert_eq!(again, v2.pr, "v2's pin, as it was");
}

/// Moving the recorded PR to a later version and back restores v1's pin exactly: the PR's title,
/// description, head, base and files, and its linked issues' descriptions and comment threads,
/// authors and repeated bodies included (a comment the later version's thread added is made by
/// its author, and deleted by its author and body). The later version is made up here from v1,
/// as real v2 neither moves the base nor edits an issue's description, nor repeats a comment.
#[tokio::test(flavor = "multi_thread")]
async fn moving_the_recorded_pr_to_a_later_version_and_back_restores_v1s_pin() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let v1 = fixture::recorded::version(RECORDED, 1).unwrap();
    let (first, _) = s.pin_when(&b, "a run pins v1", |p| p == &v1.pr).await;

    let mut later = v1.clone();
    later.version = 2;
    let pr = &mut later.pr;
    pr["title"] = json!("The PR view (#174), later");
    pr["body"] = json!(format!("{}\n\nAnd more.", v1.pr["body"].as_str().unwrap()));
    pr["headSha"] = json!("5".repeat(40));
    pr["base"]["sha"] = json!("6".repeat(40));
    let files = pr["files"].as_array_mut().unwrap();
    files.pop();
    files.push(json!({ "path": "later.md", "status": "added", "additions": 1, "deletions": 0 }));
    let issues = pr["issues"].as_array_mut().unwrap();
    // A later description, a comment on a thread that had one, and one on a thread that had none;
    // and on the first, its first comment again by its author and by someone else (no beghu
    // account), so the same body is in the thread three times by two authors.
    let commented = issues
        .iter()
        .position(|i| !i["comments"].as_array().unwrap().is_empty())
        .unwrap();
    let bare = issues
        .iter()
        .position(|i| i["comments"].as_array().unwrap().is_empty())
        .unwrap();
    issues[bare]["body"] = json!("A later description.");
    for i in [commented, bare] {
        let n = issues[i]["number"].clone();
        issues[i]["comments"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "author": "tomsj", "body": format!("A later comment on #{n}.") }));
    }
    let thread = issues[commented]["comments"].as_array_mut().unwrap();
    let again = thread[0].clone();
    thread.push(json!({ "author": "tomsj", "body": again["body"] }));
    thread.push(again);
    let (commented, bare) = (issues[commented].clone(), issues[bare].clone());

    for (path, body) in fixture::recorded::moves(&v1, &later) {
        s.fake("POST", path, body).await;
    }
    let issue = |p: &Value, n: &Value| {
        p["issues"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| &i["number"] == n)
            .cloned()
            .unwrap()
    };
    let thread = |i: &Value| i["comments"].clone();
    s.pin_when(&b, "a run pins the later version", |p| {
        p["headSha"] == later.pr["headSha"]
            && p["title"] == later.pr["title"]
            && p["body"] == later.pr["body"]
            && p["files"] == later.pr["files"]
            && p["base"] == later.pr["base"]
            && issue(p, &bare["number"])["body"] == bare["body"]
            && thread(&issue(p, &bare["number"])) == thread(&bare)
            && thread(&issue(p, &commented["number"])) == thread(&commented)
    })
    .await;

    for (path, body) in fixture::recorded::moves(&later, &v1) {
        s.fake("POST", path, body).await;
    }
    let (back, _) = s.pin_when(&b, "a run pins v1 again", |p| p == &v1.pr).await;
    assert_eq!(back, first, "v1's pin, as it was");
}

/// Seeding the recordings leaves tomsj's default list (Recently updated) in the order it has
/// without them, as `./dev-ctl start` seeds v1 then v2: the move to v2's head is dated as the
/// fixture dates the recorded PR, so its edits, comment and push land just after v1's state, far
/// below the top, where the browser suite's tests open the first rows.
#[tokio::test(flavor = "multi_thread")]
async fn seeding_v1_then_v2_leaves_the_default_list_in_its_order() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let list = async |b: &mut common::Browser| -> Vec<Value> {
        let mut rows = Vec::new();
        let mut path = "/api/issues".to_owned();
        loop {
            let (status, page) = s.api(b, &path).await;
            assert_eq!(status, 200);
            rows.extend(page["rows"].as_array().unwrap().iter().cloned());
            let Some(next) = page["next"].as_str() else {
                return rows;
            };
            path = format!("/api/issues?after={next}");
        }
    };
    let before = list(&mut b).await;
    let up = s.upload_recorded(&b, 1, 1).await;
    assert_eq!(up.status, 201, "{}", up.answer);
    let up = s.upload_recorded(&b, 1, 2).await;
    assert_eq!(up.status, 201, "{}", up.answer);
    let after = list(&mut b).await;

    let ids = |rows: &[Value]| rows.iter().map(|r| r["id"].clone()).collect::<Vec<_>>();
    let (without, with) = (ids(&before), ids(&after));
    let at = without.iter().zip(&with).position(|(a, b)| a != b);
    assert!(
        without == with,
        "the list's order, as without them: from row {at:?}, {:?} became {:?}",
        at.map(|i| &without[i..(i + 5).min(without.len())]),
        at.map(|i| &with[i..(i + 5).min(with.len())]),
    );
    // The move did change the PR (its push bumped `updated_at`), only not to now.
    let pr = |rows: &[Value]| {
        rows.iter()
            .find(|r| r["owner"] == "AdvanGrid" && r["repo"] == "beghu" && r["number"] == RECORDED)
            .expect("the recorded PR lists")["updated_at"]
            .as_i64()
            .unwrap()
    };
    let (was, now) = (pr(&before), pr(&after));
    assert!(
        now > was,
        "v2's push dates the PR after v1's state: {was} → {now}"
    );
    assert!(
        now < fixture::FIXTURE_NOW - 300 * 86_400,
        "and long before the fixture's now: {now}"
    );
}

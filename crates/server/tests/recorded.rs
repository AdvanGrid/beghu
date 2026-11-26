//! The PR view's recorded PR (#178): `AdvanGrid/beghu#191`, which every fixture holds and Fake
//! GitHub serves at v1's head. A run on it pins the recorded `pr.json` byte for byte, the
//! recorded analysis uploads through the run as the agent sent it and is accepted, and the server
//! keeps the upload's body, which `./dev-ctl analysis record` reads back untouched. v2, once the
//! owner records it, follows on the same run after the PR moves to its head.

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
    let scratch = tempfile::tempdir().unwrap();
    let got = analysis_fixtures::record(&dbs[0], id, scratch.path()).unwrap();
    let committed =
        std::fs::read_to_string(fixture::recorded::analysis_path(RECORDED, 1).unwrap()).unwrap();
    assert!(got.analysis == committed, "the upload is kept untouched");
    // And the run's pin is stored as the recording has it, byte for byte.
    assert!(got.pr == v1.text);
    assert_eq!(got.number, i64::from(RECORDED));

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

/// v2 on top of v1, once recorded: the PR moves to v2's head, a new run pins v2's `pr.json`, and
/// v2 (whose `carried` is checked against v1) is accepted. Nothing to check before then.
#[tokio::test(flavor = "multi_thread")]
async fn v2_is_accepted_after_v1_once_the_pr_moves_to_its_head() {
    let Some(v2) = fixture::recorded::version(RECORDED, 2) else {
        eprintln!("v2 isn't recorded yet");
        return;
    };
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let up = s.upload_recorded(&b, 1, 1).await;
    assert_eq!(up.status, 201, "{}", up.answer);
    let up = s.upload_recorded(&b, 1, 2).await;
    assert_eq!(up.status, 201, "{}", up.answer);
    assert_eq!(up.answer["headSha"], v2.pr["headSha"]);
}

/// Moving the recorded PR to a later version and back restores v1's pin exactly: the PR's title,
/// description, head, base and files, and its linked issues' descriptions and comment threads (a
/// comment the later version's thread added is deleted). v2 isn't recorded yet, so the later
/// version is made up here from v1.
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
    // A later description, a comment on a thread that had one, and one on a thread that had none.
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
    let bodies = |i: &Value| -> Vec<Value> {
        i["comments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["body"].clone())
            .collect()
    };
    s.pin_when(&b, "a run pins the later version", |p| {
        p["headSha"] == later.pr["headSha"]
            && p["title"] == later.pr["title"]
            && p["body"] == later.pr["body"]
            && p["files"] == later.pr["files"]
            && p["base"] == later.pr["base"]
            && issue(p, &bare["number"])["body"] == bare["body"]
            && bodies(&issue(p, &bare["number"])) == bodies(&bare)
            && bodies(&issue(p, &commented["number"])) == bodies(&commented)
    })
    .await;

    for (path, body) in fixture::recorded::moves(&later, &v1) {
        s.fake("POST", path, body).await;
    }
    let (back, _) = s.pin_when(&b, "a run pins v1 again", |p| p == &v1.pr).await;
    assert_eq!(back, first, "v1's pin, as it was");
}

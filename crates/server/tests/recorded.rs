//! The PR view's recorded PR (#178): `AdvanGrid/beghu#191`, which every fixture holds and Fake
//! GitHub serves at v1's head. A run on it pins the recorded `pr.json` byte for byte, the
//! recorded analysis uploads through the run as the agent sent it and is accepted, and the server
//! keeps the upload's body, which `./dev-ctl analysis record` reads back untouched. v2, once the
//! owner records it, follows on the same run after the PR moves to its head.

mod common;

use common::{RECORDED, start};

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

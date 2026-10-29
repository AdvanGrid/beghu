//! With `BEGHU_SCAN_STEPS` on, every API answer says how many rows its statements stepped through
//! with no index to seek on (`x-beghu-scan-steps`), and only its own: the perf gates' "no full
//! scans" reads it.
//! Off, as in production, it says nothing.

mod common;

use common::{start, start_with, summary};
use std::time::Duration;

fn steps(res: &reqwest::Response) -> Option<u64> {
    res.headers()
        .get("x-beghu-scan-steps")
        .map(|v| v.to_str().unwrap().parse().unwrap())
}

#[tokio::test(flavor = "multi_thread")]
async fn on_an_answer_reports_the_rows_its_queries_stepped_through_unseeked() {
    let s = start_with(|c| c.scan_steps = true).await;
    let mut b = s.sign_in("tomsj").await;
    // The filter bar's suggestions read whole small tables (the labels, the repos), at least.
    let res = s.get(&mut b, "/api/facets").await;
    assert_eq!(res.status(), 200);
    assert!(steps(&res).unwrap() > 0, "{:?}", steps(&res));
    // An issue's detail is read by its id: nothing walked.
    let id = summary()["detail_targets"][0].as_i64().unwrap();
    let res = s.get(&mut b, &format!("/api/issues/{id}")).await;
    assert_eq!(res.status(), 200);
    assert_eq!(steps(&res), Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn off_an_answer_says_nothing_of_scans() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let res = s.get(&mut b, "/api/issues").await;
    assert_eq!(res.status(), 200);
    assert_eq!(steps(&res), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_scan_a_background_job_makes_is_not_charged_to_the_next_request() {
    // Sweeps every 50 ms: each reads which repos to probe (a walk of the repos table) on a
    // mirror connection, outside any API request.
    let s = start_with(|c| {
        c.scan_steps = true;
        c.reconcile.tick = Duration::from_millis(50);
        c.reconcile.probe_every = Duration::from_millis(50);
    })
    .await;
    let mut b = s.sign_in("tomsj").await;
    let id = summary()["detail_targets"][0].as_i64().unwrap();
    for i in 0..60 {
        // An issue read by its id walks nothing, whatever ran on its connection before.
        let res = s.get(&mut b, &format!("/api/issues/{id}")).await;
        assert_eq!(res.status(), 200);
        assert_eq!(steps(&res), Some(0), "read {i}");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

//! The account's roles, re-read from GitHub at sign-in and by `/api/me` when they're older than
//! `repo_refresh_every` (in most tests here zero: every request). Requests that arrive while a
//! re-read is running wait on that one; after a failed re-read the next waits
//! `roles_retry_after_failure` (a minute by default), so a failing GitHub isn't asked, and
//! waited on, by every request.

mod common;

use common::start_with;
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

    let state = s.fake("GET", "/state", json!(null)).await;
    assert_eq!(
        calls_left(&state),
        48,
        "the sign-in got a re-read of its own: {state}"
    );
}

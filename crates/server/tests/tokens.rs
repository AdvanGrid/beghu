//! The user token behind each account: refreshed before use when under 5 minutes are left,
//! under a per-account lock so a single-use refresh token is never spent twice, and refreshed
//! once more (with one retry) when GitHub answers 401. `/api/me` uses the token: it re-reads the
//! account's repos and roles, here on every request (`repo_refresh_every` of zero).

mod common;

use common::start_with;
use serde_json::json;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_requests_refresh_an_expiring_token_one_at_a_time_and_never_reuse_a_refresh_token()
 {
    let s = start_with(|c| c.repo_refresh_every = Duration::ZERO).await;
    // Every token now starts inside the 5-minute window, so each use must refresh first.
    s.fake("PUT", "/tokens", json!({ "access_ttl": 60 })).await;
    let b = s.sign_in("tomsj").await;

    let statuses = s.concurrently(&b, "/api/me", 16).await;
    assert!(statuses.iter().all(|&st| st == 200), "{statuses:?}");

    let refreshes = s.fake("GET", "/state", json!(null)).await["refreshes"].clone();
    assert_eq!(
        refreshes["reused"], 0,
        "a refresh token was spent twice: {refreshes}"
    );
    assert!(
        refreshes["ok"].as_u64().unwrap() >= 2,
        "the expiring token was refreshed before use: {refreshes}"
    );
    assert_eq!(s.api(&mut b.clone(), "/api/me").await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_401_from_github_forces_one_refresh_and_one_retry() {
    let s = start_with(|c| c.repo_refresh_every = Duration::ZERO).await;
    let mut b = s.sign_in("tomsj").await;
    let refreshed = |state: serde_json::Value| state["refreshes"]["ok"].as_u64().unwrap();
    assert_eq!(refreshed(s.fake("GET", "/state", json!(null)).await), 0);

    let fail = |count: u32| json!({ "endpoint": "GET /user/installations", "status": 401, "count": count });
    s.fake("POST", "/faults/fail", fail(1)).await;
    let (status, me) = s.api(&mut b, "/api/me").await;
    assert_eq!(status, 200);
    assert_eq!(me["account"]["login"], "tomsj");
    assert_eq!(refreshed(s.fake("GET", "/state", json!(null)).await), 1);
    let state = s.fake("GET", "/state", json!(null)).await;
    assert_eq!(state["faults"]["fail"], json!([]), "the retry was made");

    // GitHub keeps answering 401: one refresh, one retry, then give up for this request.
    s.fake("POST", "/faults/fail", fail(5)).await;
    s.api(&mut b, "/api/me").await;
    let state = s.fake("GET", "/state", json!(null)).await;
    assert_eq!(refreshed(state.clone()), 2);
    assert_eq!(state["faults"]["fail"][0]["remaining"], 3, "{state}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_refresh_signs_the_account_out_and_deletes_its_mirror() {
    let s = start_with(|c| c.repo_refresh_every = Duration::ZERO).await;
    s.fake("PUT", "/tokens", json!({ "access_ttl": 60 })).await;
    let mut b = s.sign_in("tomsj").await;
    let id = s.api(&mut b, "/api/me").await.1["account"]["id"]
        .as_i64()
        .unwrap();
    let mut tab = s.stream_as(&b, id).await;
    tab.reset().await;
    // GitHub's grant goes, and with it the refresh token; with no webhook to say so, the
    // refresh is what finds out.
    s.fake("PUT", "/webhooks", json!({ "url": null })).await;
    s.fake("POST", "/revoke", json!({ "login": "tomsj" })).await;

    let (status, body) = s.api(&mut b, "/api/me").await;
    assert_eq!(status, 401);
    assert_eq!(body["error"], "signed_out");
    assert_eq!(s.api(&mut b, "/api/issues").await.0, 401);
    // The tab hears once the mirror is deleted: signing in again imports afresh (slowed, so
    // it's still under way when looked at).
    let ev = tab
        .event_within(Duration::from_secs(5))
        .await
        .expect("a switched push");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&ev.data).unwrap(),
        json!({ "account": id, "sign_in_again": true })
    );
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": "POST /graphql", "ms": 300 }),
    )
    .await;
    s.sign_in_on(&mut b, "tomsj").await;
    let me = s.api(&mut b, "/api/me").await.1;
    assert!(!me["import"].is_null(), "a fresh import: {me}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_moved_to_another_account_in_the_control_db_does_not_open() {
    let s = start_with(|c| c.repo_refresh_every = Duration::ZERO).await;
    let mut tomsj = s.sign_in("tomsj").await;
    let mut ilze = s.sign_in("ilze-k").await;
    let id = |me: serde_json::Value| me["account"]["id"].as_i64().unwrap();
    let from = id(s.api(&mut tomsj, "/api/me").await.1);
    let to = id(s.api(&mut ilze, "/api/me").await.1);

    // Someone with write access to the control DB copies tomsj's sealed tokens onto ilze-k.
    // Written straight to the file: tampering is by definition not something the server's HTTP
    // seams, or the fake's, can do.
    let db = rusqlite::Connection::open(s.control_db()).unwrap();
    db.busy_timeout(Duration::from_secs(5)).unwrap();
    let row = control_db::q::tokens(&db, from).unwrap().unwrap();
    control_db::q::put_tokens(
        &db,
        to,
        &row.access_enc,
        row.access_expires_at,
        &row.refresh_enc,
        row.refresh_expires_at,
        row.issued_at,
    )
    .unwrap();

    // ilze-k's requests can't act as tomsj: the tokens are sealed to their own account.
    let (status, body) = s.api(&mut ilze, "/api/me").await;
    assert_eq!(status, 401, "{body}");
    assert_eq!(body["error"], "signed_out");
    assert_eq!(s.api(&mut tomsj, "/api/me").await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refreshed_pair_is_kept_when_the_control_db_is_briefly_too_busy_to_store_it() {
    let s = start_with(|c| {
        c.repo_refresh_every = Duration::ZERO;
        // Were the pair lost, the roles refresh fails: try again at once, to see it.
        c.roles_retry_after_failure = Duration::ZERO;
    })
    .await;
    s.fake("PUT", "/tokens", json!({ "access_ttl": 60 })).await;
    let mut b = s.sign_in("tomsj").await;

    // Another writer holds the control DB for longer than the server's 5 s busy timeout, so the
    // first try to store the refreshed pair fails; by the retry it has let go. The writer is a
    // connection of the test's own: no seam makes the server's DB busy, and the lock contention
    // is what's under test.
    let path = s.control_db();
    let (locked_tx, locked) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let mut db = rusqlite::Connection::open(path).unwrap();
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        locked_tx.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(6500));
        tx.rollback().unwrap();
    });
    locked.recv().unwrap();
    // Spends the refresh token; the roles refresh carries on after the request's 2 s wait.
    assert_eq!(s.api(&mut b, "/api/me").await.0, 200);
    holder.join().unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;

    // The new pair was stored: the next use refreshes with it, not with the spent one.
    let (status, body) = s.api(&mut b, "/api/me").await;
    assert_eq!(status, 200, "{body}");
    let refreshes = s.fake("GET", "/state", json!(null)).await["refreshes"].clone();
    assert_eq!(refreshes["reused"], 0, "{refreshes}");
}

#[tokio::test(flavor = "multi_thread")]
async fn once_its_tokens_cant_be_opened_the_account_stays_signed_out_everywhere() {
    let mut s = common::start().await;
    let mut b = s.sign_in("tomsj").await;
    assert_eq!(s.api(&mut b, "/api/issues").await.0, 200);

    // The server comes back with another BEGHU_TOKEN_KEY: the stored tokens no longer open, and
    // its first /api/me re-reads the roles, which needs them.
    s.restart_with(|c| c.token_key = b"another key, also at least 32 bytes long".to_vec())
        .await;
    for path in ["/api/me", "/api/issues", "/api/me", "/api/issues"] {
        let (status, body) = s.api(&mut b, path).await;
        assert_eq!(status, 401, "{path}");
        assert_eq!(body["error"], "signed_out", "{path}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_access_and_refresh_token_swapped_in_the_control_db_do_not_open() {
    let s = start_with(|c| c.repo_refresh_every = Duration::ZERO).await;
    let mut b = s.sign_in("tomsj").await;
    let me = s.api(&mut b, "/api/me").await.1;
    let account = me["account"]["id"].as_i64().unwrap();

    // Someone with write access to the control DB swaps the two sealed tokens of one account.
    // Written straight to the file, as tampering can't go through any seam.
    let db = rusqlite::Connection::open(s.control_db()).unwrap();
    db.busy_timeout(Duration::from_secs(5)).unwrap();
    let row = control_db::q::tokens(&db, account).unwrap().unwrap();
    control_db::q::put_tokens(
        &db,
        account,
        &row.refresh_enc,
        row.access_expires_at,
        &row.access_enc,
        row.refresh_expires_at,
        row.issued_at,
    )
    .unwrap();

    // Neither opens: the account must sign in again, and GitHub never sees the refresh token
    // used as an access token (the one-call fail rule is still there afterwards).
    let rule = json!({ "endpoint": "GET /user/installations", "status": 502, "count": 1 });
    s.fake("POST", "/faults/fail", rule).await;
    let (status, body) = s.api(&mut b, "/api/me").await;
    assert_eq!(status, 401, "{body}");
    assert_eq!(body["error"], "signed_out");
    let state = s.fake("GET", "/state", json!(null)).await;
    assert_eq!(state["faults"]["fail"][0]["remaining"], 1, "{state}");
}

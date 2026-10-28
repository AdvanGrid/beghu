//! Dormant accounts through the server's HTTP surface, with Fake GitHub behind it: an account
//! unused for `dormant_after` loses its mirror and drops out of fan-out (its repos' webhooks are
//! deduped and dropped, with nothing read back from GitHub), a use while its mirror is being
//! deleted keeps it, and using it again or signing in again re-imports it as a return from time
//! away. Each test shortens 30 days to a few seconds of the server's own clock.

mod common;

use common::*;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// An account goes dormant 3 s after its last use (the check runs every 100 ms), and a request
/// counts as use whenever it comes (`activity_every` zero: no hourly limit).
fn dormant_after_3s(c: &mut beghu::Config) {
    c.accounts_check_every = Duration::from_millis(100);
    c.dormant_after = Duration::from_secs(3);
    c.activity_every = Duration::ZERO;
}

/// The account's mirror file, as the volume holds it.
fn mirror_of(s: &Stack, account: i64) -> PathBuf {
    s.control_db()
        .with_file_name("mirrors")
        .join(format!("{account}.db"))
}

async fn me(s: &Stack, b: &mut Browser) -> Value {
    let (status, me) = s.api(b, "/api/me").await;
    assert_eq!(status, 200, "{me}");
    me
}

/// Signs `login` in and waits for its import, if any, to end: its id.
async fn signed_in(s: &Stack, login: &str) -> (Browser, i64) {
    let mut b = s.sign_in(login).await;
    let id = me(s, &mut b).await["account"]["id"].as_i64().unwrap();
    until(30.0, "the import to end", || {
        let mut b = b.clone();
        async move { me(s, &mut b).await["import"].is_null().then_some(()) }
    })
    .await;
    (b, id)
}

/// Waits, without using the account, for its mirror file to go.
async fn until_dormant(s: &Stack, account: i64) {
    let mirror = mirror_of(s, account);
    until(10.0, "the mirror deleted", || async {
        (!mirror.exists()).then_some(())
    })
    .await;
}

async fn fake_state(s: &Stack) -> Value {
    s.fake("GET", "/state", Value::Null).await
}

/// The fake's count of `op` GraphQL calls so far.
async fn operations(s: &Stack, op: &str) -> u64 {
    fake_state(s).await["graphql"]["operations"][op]
        .as_u64()
        .unwrap_or(0)
}

/// How many delivery attempts the fake has made, and how many beghu didn't answer 2xx.
async fn deliveries(s: &Stack) -> (u64, u64) {
    let d = &fake_state(s).await["webhooks"]["deliveries"];
    (
        d["attempts"].as_u64().unwrap(),
        d["failed"].as_u64().unwrap(),
    )
}

/// Whether beghu has settled every delivery it stored.
fn all_settled(s: &Stack) -> bool {
    let db = rusqlite::Connection::open(s.control_db()).unwrap();
    db.busy_timeout(Duration::from_secs(5)).unwrap();
    control_db::q::pending_delivery_guids(&db, i64::MAX)
        .unwrap()
        .is_empty()
}

async fn rows(s: &Stack, b: &Browser, q: &str) -> Vec<Value> {
    let (status, page) = s
        .api(
            &mut b.clone(),
            &format!("/api/issues?q={}", q.replace(' ', "+")),
        )
        .await;
    assert_eq!(status, 200, "{page}");
    page["rows"].as_array().unwrap().clone()
}

async fn title_of(s: &Stack, b: &Browser, id: i64) -> Value {
    let (status, d) = s.api(&mut b.clone(), &format!("/api/issues/{id}")).await;
    assert_eq!(status, 200, "{d}");
    d["title"].clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unused_account_loses_its_mirror_and_its_repos_webhooks_are_deduped_and_dropped_unread()
{
    let s = start_with(dormant_after_3s).await;
    let (b, tomsj) = signed_in(&s, "tomsj").await;
    let pr = rows(&s, &b, "is:pr is:open repo:acme/web").await[0].clone();
    let edit_pr =
        |title: &str| json!({ "repo": "acme/web", "number": pr["number"], "title": title });

    // In use, a PR's webhook is read back from GitHub.
    let reads = operations(&s, "PullReadBack").await;
    s.edit(edit_pr("Read back while in use")).await;
    until(10.0, "the PR read back", || async {
        (operations(&s, "PullReadBack").await > reads).then_some(())
    })
    .await;

    // Unused from here: the daily check makes the account dormant and deletes its mirror.
    until_dormant(&s, tomsj).await;

    // No active account syncs acme/web now. Its next delivery comes twice under one GUID, as a
    // redelivery would: both are answered, the second deduped, and nothing is read back.
    let reads = operations(&s, "PullReadBack").await;
    let (attempts, failed) = deliveries(&s).await;
    s.fake("POST", "/faults/webhooks", json!({ "duplicate": 1 }))
        .await;
    s.edit(edit_pr("Changed while dormant")).await;
    until(10.0, "both attempts answered and settled", || async {
        (deliveries(&s).await.0 >= attempts + 2 && all_settled(&s)).then_some(())
    })
    .await;
    assert_eq!(deliveries(&s).await.1, failed, "every attempt answered 2xx");
    // A delivery settles only once its read-back has landed: none came.
    assert_eq!(operations(&s, "PullReadBack").await, reads);
    assert!(!mirror_of(&s, tomsj).exists(), "no webhook brought it back");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_account_in_use_keeps_its_mirror_past_the_limit() {
    let s = start_with(dormant_after_3s).await;
    let (mut b, ilze) = signed_in(&s, "ilze-k").await;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        me(&s, &mut b).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    assert!(mirror_of(&s, ilze).exists());
    assert!(me(&s, &mut b).await["import"].is_null());
}

/// Holds the account's mirror writer up: a delivery's write waits on another writer's lock,
/// for at most SQLite's 5 s busy timeout, so a delete that starts meanwhile (it waits for the
/// write in flight) holds its window open until the lock is dropped. The edited issue and its
/// new title.
async fn hold_the_writer(s: &Stack, account: i64) -> (WriteLock, (i64, String)) {
    let web = summary()["unlinked"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["repo"] == "web")
        .unwrap()
        .clone();
    let lock = WriteLock::take(&mirror_of(s, account));
    let title = "Applied after the window".to_owned();
    s.edit(json!({ "repo": "web", "number": web["number"], "title": title }))
        .await;
    (lock, (web["id"].as_i64().unwrap(), title))
}

/// An account goes dormant 2 s after its last use: its delete starts 1 to 2.1 s after it
/// (`last_active_at` is in whole seconds; the check runs every 100 ms). A write held up from
/// just after that use ([`hold_the_writer`]) holds the delete's window open until about 5 s
/// after it.
fn dormant_after_2s(c: &mut beghu::Config) {
    dormant_after_3s(c);
    c.dormant_after = Duration::from_secs(2);
}

/// Whether the account's request was turned away because its mirror is being deleted.
async fn being_deleted(s: &Stack, b: &mut Browser) -> bool {
    let (status, body) = s.api(b, "/api/issues").await;
    status == 503 && body.to_string().contains("being deleted")
}

/// Once its writes land, the account kept its mirror: the deliveries applied to it, nothing
/// re-imported.
async fn kept_with_its_mirror(
    s: &Stack,
    b: &mut Browser,
    account: i64,
    (id, title): &(i64, String),
    imports: u64,
) {
    {
        until(10.0, "the delivery applied", || {
            let b = b.clone();
            async move {
                let (status, d) = s.api(&mut b.clone(), &format!("/api/issues/{id}")).await;
                (status == 200 && d["title"] == title.as_str()).then_some(())
            }
        })
        .await;
    }
    assert!(me(s, b).await["import"].is_null());
    assert_eq!(
        operations(s, "ImportIssues").await,
        imports,
        "not re-imported"
    );
    assert!(mirror_of(s, account).exists());
    assert_eq!(
        status_of(s, account),
        "active",
        "the use kept the account active"
    );
}

/// The account's status, as the control DB holds it.
fn status_of(s: &Stack, account: i64) -> String {
    let db = rusqlite::Connection::open(s.control_db()).unwrap();
    db.busy_timeout(Duration::from_secs(5)).unwrap();
    control_db::q::account(&db, account)
        .unwrap()
        .unwrap()
        .status
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_while_the_mirror_is_being_deleted_keeps_the_account_and_its_mirror() {
    // Only the sign-in counts as use: requests move `last_active_at` hourly.
    let s = start_with(|c| {
        dormant_after_2s(c);
        c.activity_every = beghu::default_activity_every();
    })
    .await;
    let mut b = s.sign_in("ilze-k").await;
    let ilze = me(&s, &mut b).await["account"]["id"].as_i64().unwrap();
    let imports = operations(&s, "ImportIssues").await;
    let (lock, edited) = hold_the_writer(&s, ilze).await;

    // The delete has begun: the account's requests are turned away for a moment.
    until(4.0, "the delete under way", || {
        let mut b = b.clone();
        let s = &s;
        async move { being_deleted(s, &mut b).await.then_some(()) }
    })
    .await;
    // The user signs in again meanwhile; then the writes land.
    s.sign_in_on(&mut b, "ilze-k").await;
    drop(lock);
    kept_with_its_mirror(&s, &mut b, ilze, &edited, imports).await;
    assert!(!rows(&s, &b, "repo:web").await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_while_the_mirror_is_being_deleted_keeps_the_account_and_its_mirror() {
    // Every request counts as use: the test makes none until the window is open.
    let s = start_with(dormant_after_2s).await;
    let mut b = s.sign_in("ilze-k").await;
    let ilze = me(&s, &mut b).await["account"]["id"].as_i64().unwrap();
    let used = Instant::now();
    let imports = operations(&s, "ImportIssues").await;
    let (lock, edited) = hold_the_writer(&s, ilze).await;

    // Unused, its delete starts within 2.1 s of that last use, and the write holds its window
    // open until about 5 s after it. Its next request comes between: turned away, as the
    // mirror is being decided, but it counts as use.
    tokio::time::sleep(Duration::from_millis(3600).saturating_sub(used.elapsed())).await;
    assert!(
        being_deleted(&s, &mut b).await,
        "the request came in the window"
    );
    drop(lock);
    kept_with_its_mirror(&s, &mut b, ilze, &edited, imports).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dormant_account_has_no_mirror_after_a_restart_and_its_use_re_imports_it() {
    let mut s = start_with(dormant_after_3s).await;
    let (mut b, ilze) = signed_in(&s, "ilze-k").await;
    until_dormant(&s, ilze).await;

    // Restarted: the startup's cleanup leaves it without a mirror, and nothing opens one.
    s.restart_with(dormant_after_3s).await;
    assert_eq!(status_of(&s, ilze), "dormant");
    assert!(!mirror_of(&s, ilze).exists());

    // Its next request wakes it, and its whole pick re-imports.
    reimports_as_back_from_away(&s, &mut b, async |b| {
        s.api(b, "/api/me").await;
    })
    .await;
    assert!(mirror_of(&s, ilze).exists());
    assert!(!rows(&s, &b, "is:open").await.is_empty());
}

/// Waits, without using the account, for it to have to sign in again; then its request is
/// turned away to sign in, and wakes nothing.
async fn until_signed_out(s: &Stack, b: &mut Browser, account: i64) {
    until(10.0, "the account to have to sign in again", || async {
        (status_of(s, account) == "needs_sign_in").then_some(())
    })
    .await;
    let (status, body) = s.api(b, "/api/me").await;
    assert_eq!(status, 401, "{body}");
    assert_eq!(body["error"], "signed_out", "{body}");
    assert_eq!(status_of(s, account), "needs_sign_in");
    assert!(!mirror_of(s, account).exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dormant_account_whose_refresh_token_lapses_must_sign_in_again() {
    let s = start_with(dormant_after_3s).await;
    // Its refresh token lapses 8 s after it signs in, once it's dormant.
    s.fake("PUT", "/tokens", json!({ "refresh_ttl": 8 })).await;
    let (mut b, ilze) = signed_in(&s, "ilze-k").await;
    until_dormant(&s, ilze).await;
    assert_eq!(status_of(&s, ilze), "dormant");
    until_signed_out(&s, &mut b, ilze).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dormant_account_that_revokes_beghu_must_sign_in_again() {
    let s = start_with(dormant_after_3s).await;
    let (mut b, ilze) = signed_in(&s, "ilze-k").await;
    until_dormant(&s, ilze).await;
    assert_eq!(status_of(&s, ilze), "dormant");
    // The revoke's webhook says so.
    s.fake("POST", "/revoke", json!({ "login": "ilze-k" }))
        .await;
    until_signed_out(&s, &mut b, ilze).await;
}

/// Uses the account (an `/api/me` with it active) with GitHub's GraphQL slowed, until its import
/// shows: it's back after time away.
async fn reimports_as_back_from_away(
    s: &Stack,
    b: &mut Browser,
    again: impl AsyncFn(&mut Browser),
) {
    let latency = |ms: u64| json!({ "endpoint": "POST /graphql", "ms": ms });
    s.fake("POST", "/faults/latency", latency(300)).await;
    again(b).await;
    let import = until(10.0, "the re-import", || {
        let mut b = b.clone();
        async move {
            let import = me(s, &mut b).await["import"].clone();
            (!import.is_null()).then_some(import)
        }
    })
    .await;
    s.fake("POST", "/faults/latency", latency(0)).await;
    assert_eq!(import["away"], true, "{import}");
    until(30.0, "the re-import to end", || {
        let mut b = b.clone();
        async move { me(s, &mut b).await["import"].is_null().then_some(()) }
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dormant_account_used_or_signed_in_again_re_imports_what_it_can_still_see() {
    let s = start_with(dormant_after_3s).await;
    let (mut b, ilze) = signed_in(&s, "ilze-k").await;
    let synced = |me: &Value| -> Vec<String> {
        me["repos"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["name"].as_str().unwrap().to_owned())
            .collect()
    };
    let before = synced(&me(&s, &mut b).await);
    assert!(before.len() > 1, "{before:?}");
    until_dormant(&s, ilze).await;

    // While it's dormant, it loses access to one of its repos.
    let gone = before[0].clone();
    s.fake(
        "PUT",
        "/permissions",
        json!({ "login": "ilze-k", "repo": gone, "role": null }),
    )
    .await;

    // Its next request wakes it: its repos are read afresh, and what it still sees re-imports.
    reimports_as_back_from_away(&s, &mut b, async |b| {
        s.api(b, "/api/me").await;
    })
    .await;
    let now = synced(&me(&s, &mut b).await);
    assert!(!now.contains(&gone), "{now:?}");
    assert_eq!(now.len(), before.len() - 1, "{now:?}");
    let listed = rows(&s, &b, "is:open").await;
    assert!(!listed.is_empty());
    assert!(
        listed.iter().all(|r| r["repo"] != gone.as_str()),
        "{listed:?}"
    );

    // Unused again, it goes dormant again; signing in again brings it back the same way.
    until_dormant(&s, ilze).await;
    reimports_as_back_from_away(&s, &mut b, async |b| {
        s.sign_in_on(b, "ilze-k").await;
    })
    .await;
    assert!(mirror_of(&s, ilze).exists());
    let id = listed[0]["id"].as_i64().unwrap();
    assert_eq!(title_of(&s, &b, id).await, listed[0]["title"]);
}

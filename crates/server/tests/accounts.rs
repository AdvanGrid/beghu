//! Several connected accounts in one browser, and every way out of a session: switching, the
//! `switched` answer and push, signing out, Disconnect, and losing access (a revoke from GitHub,
//! a lapsed refresh token).

mod common;

use common::{Browser, SID, Stack, start, start_with};
use serde_json::{Value, json};
use std::time::Duration;

const SECS: Duration = Duration::from_secs(1);

async fn me(s: &Stack, b: &mut Browser) -> Value {
    let (status, me) = s.api(b, "/api/me").await;
    assert_eq!(status, 200, "{me}");
    me
}

fn logins(me: &Value) -> Vec<String> {
    me["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["login"].as_str().unwrap().to_owned())
        .collect()
}

fn id_of(me: &Value, login: &str) -> i64 {
    me["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["login"] == login)
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

fn role_on(me: &Value, repo: &str) -> Value {
    me["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == repo)
        .map_or(Value::Null, |r| r["role"].clone())
}

fn repos_listed(page: &Value) -> std::collections::BTreeSet<String> {
    page["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["repo"].as_str().unwrap().to_owned())
        .collect()
}

fn location(res: &reqwest::Response) -> String {
    common::location(res)
}

/// The browser with tomsj signed in, then ilze-k: both in its session, ilze-k active.
async fn both(s: &Stack) -> (Browser, i64, i64) {
    let mut b = s.sign_in("tomsj").await;
    s.sign_in_on(&mut b, "ilze-k").await;
    let me = me(s, &mut b).await;
    (b, id_of(&me, "tomsj"), id_of(&me, "ilze-k"))
}

/// Signs `login` in again on `b`, with GitHub's GraphQL slowed so an import is still under way
/// when `/api/me` is read: whether the account's mirror was deleted, seen from outside. A
/// deleted mirror comes back empty and imports afresh; one that was kept has nothing to import.
async fn signs_in_to_a_fresh_import(s: &Stack, b: &mut Browser, login: &str) -> bool {
    let latency = |ms: u64| json!({ "endpoint": "POST /graphql", "ms": ms });
    s.fake("POST", "/faults/latency", latency(300)).await;
    s.sign_in_on(b, login).await;
    let now = me(s, b).await;
    s.fake("POST", "/faults/latency", latency(0)).await;
    !now["import"].is_null()
}

#[tokio::test(flavor = "multi_thread")]
async fn two_accounts_in_one_browser_switch_and_each_sees_only_its_own_mirror() {
    let s = start_with(|c| c.repo_refresh_every = Duration::ZERO).await;
    // ilze-k can't see `ops`, which tomsj syncs.
    s.fake(
        "PUT",
        "/permissions",
        json!({ "login": "ilze-k", "repo": "ops", "role": null }),
    )
    .await;
    let (mut b, tomsj, ilze) = both(&s).await;
    let ilze_me = me(&s, &mut b).await;
    assert_eq!(ilze_me["account"]["login"], "ilze-k");
    assert_eq!(logins(&ilze_me), ["tomsj", "ilze-k"]);
    assert_eq!(role_on(&ilze_me, "cli"), "read");
    let ilze_repos = repos_listed(&s.until_list(&mut b, 5, |_| true).await);
    assert!(!ilze_repos.contains("ops"), "{ilze_repos:?}");
    assert_eq!(b.cookies["beghu_acct"], ilze.to_string());

    let res = s
        .post_form(
            &mut b,
            "/auth/switch",
            &[("account", &tomsj.to_string()), ("next", "/issues/5?q=x")],
        )
        .await;
    assert_eq!(res.status(), 303);
    assert_eq!(location(&res), "/issues/5?q=x");
    assert_eq!(b.cookies["beghu_acct"], tomsj.to_string());
    let tomsj_me = me(&s, &mut b).await;
    assert_eq!(tomsj_me["account"]["login"], "tomsj");
    assert_eq!(
        logins(&tomsj_me),
        ["tomsj", "ilze-k"],
        "switching keeps every account"
    );
    assert_eq!(role_on(&tomsj_me, "cli"), "admin");
    let (_, page) = s.api(&mut b, "/api/issues?q=repo:ops").await;
    assert!(!page["rows"].as_array().unwrap().is_empty(), "{page}");

    // And back.
    s.post_form(
        &mut b,
        "/auth/switch",
        &[("account", &ilze.to_string()), ("next", "/")],
    )
    .await;
    let (_, page) = s.api(&mut b, "/api/issues?q=repo:ops").await;
    assert_eq!(page["rows"], json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_or_stream_from_a_tab_on_another_account_answers_switched() {
    let s = start().await;
    let (mut b, tomsj, ilze) = both(&s).await;

    let (status, body) = s.api_as(&mut b, tomsj, "/api/issues").await;
    assert_eq!(status, 409);
    assert_eq!(body["error"], "switched");
    assert_eq!(s.api_as(&mut b, ilze, "/api/issues").await.0, 200);
    // The shell's preloads carry no account: they're for whoever is active.
    assert_eq!(s.api(&mut b, "/api/issues").await.0, 200);

    // A write for the old account isn't made for the new one.
    let (_, page) = s.api(&mut b, "/api/issues").await;
    let issue = page["rows"][0]["id"].as_i64().unwrap();
    let res = s
        .http
        .post(format!("{}/api/ops", s.server))
        .header("cookie", b.header())
        .header("origin", &s.server)
        .header("x-beghu-account", tomsj.to_string())
        .json(&json!({ "op_id": "0b5e9a64-1b9f-4f5e-9d61-58a4a2f1c001", "op": { "kind": "comment", "issue": issue, "body": "as whom?" } }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 409);
    assert_eq!(res.json::<Value>().await.unwrap()["error"], "switched");
    // Nor is one that names no account: beghu can't tell whose tab made it.
    let res = s
        .http
        .post(format!("{}/api/ops", s.server))
        .header("cookie", b.header())
        .header("origin", &s.server)
        .json(&json!({ "op_id": "0b5e9a64-1b9f-4f5e-9d61-58a4a2f1c002", "op": { "kind": "comment", "issue": issue, "body": "as whom?" } }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    let (_, detail) = s.api(&mut b, &format!("/api/issues/{issue}")).await;
    assert!(!detail.to_string().contains("as whom?"));

    // Every answer names the account it was made as, a preload's (which names none) too.
    let res = s.get(&mut b, "/api/issues").await;
    assert_eq!(res.headers()["x-beghu-account"], ilze.to_string());

    // A stream opened for the old account says so, and ends.
    let mut st = s.stream_as(&b, tomsj).await;
    let ev = st.event_within(SECS).await.unwrap();
    assert_eq!(ev.event, "switched");
    assert_eq!(
        serde_json::from_str::<Value>(&ev.data).unwrap(),
        json!({ "account": ilze, "sign_in_again": false })
    );
    assert!(st.ends_within(SECS).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_switch_or_a_sign_in_reaches_every_stream_of_the_browser_and_no_other() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let tomsj = me(&s, &mut b).await["account"]["id"].as_i64().unwrap();
    let mut tab = s.stream_as(&b, tomsj).await;
    tab.reset().await;
    let elsewhere = s.sign_in("tomsj").await;
    let mut other = s.stream_as(&elsewhere, tomsj).await;
    other.reset().await;

    // Signing ilze-k in from another tab of this browser (which gives it a new session id)
    // makes ilze-k active: the first tab hears at once.
    s.sign_in_on(&mut b, "ilze-k").await;
    let ilze = id_of(&me(&s, &mut b).await, "ilze-k");
    let ev = tab.event_within(SECS).await.unwrap();
    assert_eq!(ev.event, "switched");
    assert_eq!(
        serde_json::from_str::<Value>(&ev.data).unwrap(),
        json!({ "account": ilze, "sign_in_again": false })
    );
    assert!(tab.ends_within(SECS).await);

    // A tab on ilze-k, under the new session id, hears the switch back.
    let mut tab = s.stream_as(&b, ilze).await;
    tab.reset().await;
    s.post_form(
        &mut b,
        "/auth/switch",
        &[("account", &tomsj.to_string()), ("next", "/")],
    )
    .await;
    let ev = tab.event_within(SECS).await.unwrap();
    assert_eq!(ev.event, "switched");
    assert_eq!(
        serde_json::from_str::<Value>(&ev.data).unwrap()["account"],
        tomsj
    );

    // The other browser, on the same account, heard nothing.
    assert_eq!(other.events_for(SECS).await, vec![]);
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_out_one_account_switches_to_another_and_signing_out_of_all_ends_the_session() {
    let s = start().await;
    let (mut b, tomsj, ilze) = both(&s).await;
    let mut ilze_elsewhere = s.sign_in("ilze-k").await;
    let mut tab = s.stream_as(&b, ilze).await;
    tab.reset().await;

    let res = s
        .post_form(
            &mut b,
            "/auth/logout",
            &[("account", &ilze.to_string()), ("next", "/?q=is:open")],
        )
        .await;
    assert_eq!(res.status(), 303);
    assert_eq!(location(&res), "/?q=is:open");
    assert_eq!(b.cookies["beghu_acct"], tomsj.to_string());
    let now = me(&s, &mut b).await;
    assert_eq!(now["account"]["login"], "tomsj");
    assert_eq!(logins(&now), ["tomsj"]);
    let ev = tab.event_within(SECS).await.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&ev.data).unwrap()["account"],
        tomsj
    );

    // GitHub's tokens are left alone: ilze-k is still signed in on the other browser, and
    // GitHub still counts it signed in.
    assert_eq!(s.api(&mut ilze_elsewhere, "/api/issues").await.0, 200);
    let state = s.fake("GET", "/state", json!({})).await;
    assert!(state["signed_in"].to_string().contains("ilze-k"), "{state}");

    let mut tab = s.stream_as(&b, tomsj).await;
    tab.reset().await;
    let before = b.clone();
    let res = s
        .post_form(&mut b, "/auth/logout", &[("all", "1"), ("next", "/")])
        .await;
    assert_eq!(res.status(), 303);
    assert_eq!(location(&res), "/auth/signed-out");
    assert!(!b.cookies.contains_key(SID), "{:?}", b.cookies);
    assert!(!b.cookies.contains_key("beghu_acct"), "{:?}", b.cookies);
    let ev = tab.event_within(SECS).await.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&ev.data).unwrap(),
        json!({ "account": null, "sign_in_again": false })
    );
    assert_eq!(s.api(&mut b, "/api/me").await.0, 401);
    // A tab whose stream reopens now (it still holds the old cookie) hears the session ended.
    let mut again = s.stream_as(&before, tomsj).await;
    let ev = again.event_within(SECS).await.expect("a switched event");
    assert_eq!(
        serde_json::from_str::<Value>(&ev.data).unwrap(),
        json!({ "account": null, "sign_in_again": false })
    );
    assert!(again.ends_within(SECS).await);

    // A plain page, with a way back in that doesn't sign the same account straight back in.
    let res = s.get(&mut b, "/auth/signed-out").await;
    assert_eq!(res.status(), 200);
    let html = res.text().await.unwrap();
    assert!(html.contains("href=\"/auth/login"), "{html}");
}

#[tokio::test(flavor = "multi_thread")]
async fn sign_out_switch_and_disconnect_are_refused_from_another_site() {
    let s = start().await;
    let (mut b, tomsj, ilze) = both(&s).await;
    for path in ["/auth/switch", "/auth/logout", "/auth/disconnect"] {
        for origin in [Some("https://evil.example"), None] {
            let res = s
                .post_form_from(
                    &mut b,
                    path,
                    &[("account", &tomsj.to_string()), ("all", "1")],
                    origin,
                )
                .await;
            assert_eq!(res.status(), 403, "{path} from {origin:?}");
        }
    }
    let now = me(&s, &mut b).await;
    assert_eq!(now["account"]["id"], ilze);
    assert_eq!(logins(&now), ["tomsj", "ilze-k"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn disconnect_revokes_the_grant_deletes_the_mirror_and_ends_every_session() {
    let s = start().await;
    let mut alone = s.sign_in("ilze-k").await;
    let ilze = me(&s, &mut alone).await["account"]["id"].as_i64().unwrap();
    let (mut shared, tomsj, _) = both(&s).await;
    let mut other = s.sign_in("ilze-k").await;
    let mut tab = s.stream_as(&shared, ilze).await;
    tab.reset().await;

    // TODO(#113): set an account preference through the setting #113 adds, and check Disconnect
    // deletes it (signing in again reads the default).

    let res = s
        .post_form(
            &mut alone,
            "/auth/disconnect",
            &[("account", &ilze.to_string())],
        )
        .await;
    assert_eq!(res.status(), 303);
    assert_eq!(location(&res), "/auth/signed-out");
    assert!(!alone.cookies.contains_key(SID));

    // Every browser's session loses it: one with nothing else signed in ends, one with another
    // account switches to it, and its tab hears.
    assert_eq!(s.api(&mut other, "/api/me").await.0, 401);
    // That browser's hint cookie still names ilze-k, so a tab it loads now is on ilze-k. Every
    // answer it gets puts the cookie right, the refusals included: the stream's one event and
    // the API's 409, so the next load is on tomsj rather than refused until the session slides.
    assert_eq!(shared.account(), ilze.to_string());
    let reopened = s.stream_as(&shared, ilze).await;
    let hint = reopened
        .res_headers
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().unwrap().to_owned())
        .find(|c| c.starts_with("beghu_acct="));
    assert_eq!(
        hint.as_deref().and_then(|c| c.split(';').next()),
        Some(format!("beghu_acct={tomsj}").as_str())
    );
    let stale: i64 = shared.account().parse().unwrap();
    let (status, body) = s.api_as(&mut shared, stale, "/api/me").await;
    assert_eq!((status, body["error"].clone()), (409, json!("switched")));
    assert_eq!(shared.account(), tomsj.to_string());
    let now = me(&s, &mut shared).await;
    assert_eq!(now["account"]["id"], tomsj);
    assert_eq!(logins(&now), ["tomsj"]);
    let ev = tab.event_within(SECS).await.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&ev.data).unwrap()["account"],
        tomsj
    );

    // GitHub's grant is revoked.
    let state = s.fake("GET", "/state", json!({})).await;
    assert!(
        !state["signed_in"].to_string().contains("ilze-k"),
        "{state}"
    );

    // Signing in again starts afresh: the mirror was deleted, so it imports anew. The repo pick
    // is remembered: no picker.
    let mut again = Browser::default();
    assert!(signs_in_to_a_fresh_import(&s, &mut again, "ilze-k").await);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_revoke_from_github_deletes_the_mirror_asks_for_sign_in_and_signing_in_reimports() {
    let s = start().await;
    let mut b = s.sign_in("ilze-k").await;
    let ilze = me(&s, &mut b).await["account"]["id"].as_i64().unwrap();
    let mut tab = s.stream_as(&b, ilze).await;
    tab.reset().await;

    // The user revokes beghu in GitHub's settings: GitHub sends `github_app_authorization`.
    // The tab hears once the mirror is deleted.
    s.fake("POST", "/revoke", json!({ "login": "ilze-k" }))
        .await;
    let ev = tab.event_within(5 * SECS).await.expect("a switched push");
    assert_eq!(ev.event, "switched");
    assert_eq!(
        serde_json::from_str::<Value>(&ev.data).unwrap(),
        json!({ "account": ilze, "sign_in_again": true })
    );
    let (status, body) = s.api(&mut b, "/api/me").await;
    assert_eq!((status, body["error"].clone()), (401, json!("signed_out")));
    // A tab whose stream (re)opens from here hears the same, and its stream ends.
    let mut again = s.stream_as(&b, ilze).await;
    let ev = again.event_within(SECS).await.expect("a switched event");
    assert_eq!(ev.event, "switched");
    assert_eq!(
        serde_json::from_str::<Value>(&ev.data).unwrap(),
        json!({ "account": ilze, "sign_in_again": true })
    );
    assert!(again.ends_within(SECS).await);

    // Signing in again from this browser asks GitHub for the same account.
    let res = s.get(&mut b, "/auth/login?next=/").await;
    assert_eq!(
        common::query_param(&location(&res), "login").as_deref(),
        Some("ilze-k")
    );

    assert!(signs_in_to_a_fresh_import(&s, &mut b, "ilze-k").await);
    s.until_list(&mut b, 30, |p| !p["rows"].as_array().unwrap().is_empty())
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lapsed_refresh_token_signs_the_account_out_and_deletes_its_mirror() {
    let s = start_with(|c| c.accounts_check_every = Duration::from_millis(200)).await;
    s.fake("PUT", "/tokens", json!({ "refresh_ttl": 3 })).await;
    let mut b = s.sign_in("ilze-k").await;
    let ilze = me(&s, &mut b).await["account"]["id"].as_i64().unwrap();
    let mut tab = s.stream_as(&b, ilze).await;
    tab.reset().await;

    // The tab hears once the mirror is deleted.
    let ev = tab.event_within(10 * SECS).await.expect("a switched push");
    assert_eq!(
        serde_json::from_str::<Value>(&ev.data).unwrap(),
        json!({ "account": ilze, "sign_in_again": true })
    );
    assert_eq!(s.api(&mut b, "/api/me").await.0, 401);

    s.fake("PUT", "/tokens", json!({ "refresh_ttl": 3600 }))
        .await;
    assert!(signs_in_to_a_fresh_import(&s, &mut b, "ilze-k").await);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_revoke_applied_after_the_account_signed_in_again_leaves_it_signed_in() {
    let mut s = start().await;
    let mut b = s.sign_in("ilze-k").await;
    let ilze = me(&s, &mut b).await["account"]["id"].as_i64().unwrap();

    // The revoke reaches beghu while its startup holds the deliveries back, and the account
    // signs in again before beghu gets to it: GitHub's own delivery is lost, and the same one is
    // handed in directly, so it's known to have arrived before the sign-in.
    let held = s.restart_held(|_| {}).await;
    s.fake("POST", "/faults/webhooks", json!({ "drop": 1 }))
        .await;
    s.fake("POST", "/revoke", json!({ "login": "ilze-k" }))
        .await;
    let revoked = json!({ "action": "revoked", "sender": { "id": ilze, "login": "ilze-k" } });
    assert_eq!(
        s.deliver(
            "github_app_authorization",
            "6d3c2a10-0b6e-11f0-9a8e-3a1b5c7d9e01",
            &revoked
        )
        .await,
        202
    );
    s.sign_in_on(&mut b, "ilze-k").await;
    let mut tab = s.stream_as(&b, ilze).await;
    tab.reset().await;
    held.start().await;

    // The revoke was about the grant before: nothing changes for the new one.
    let heard = tab.events_for(2 * SECS).await;
    assert!(
        heard.iter().all(|e| e.event != "switched"),
        "{:?}",
        heard
            .iter()
            .map(|e| (&e.event, &e.data))
            .collect::<Vec<_>>()
    );
    assert_eq!(me(&s, &mut b).await["account"]["id"], ilze);
    let (status, page) = s.api(&mut b, "/api/issues").await;
    assert_eq!(status, 200, "{page}");
    assert!(!page["rows"].as_array().unwrap().is_empty(), "{page}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mirror_whose_delete_never_ran_is_deleted_at_the_next_start() {
    let mut s = start_with(|c| c.repo_refresh_every = Duration::ZERO).await;
    let mut b = s.sign_in("ilze-k").await;
    me(&s, &mut b).await;

    // GitHub's grant goes while beghu's startup is held back, before the lost-access path runs:
    // the refused refresh marks the account, and beghu stops before deleting its mirror.
    let _held = s.restart_held(|_| {}).await;
    s.fake("PUT", "/webhooks", json!({ "url": null })).await;
    s.fake("POST", "/revoke", json!({ "login": "ilze-k" }))
        .await;
    assert_eq!(s.api(&mut b, "/api/me").await.0, 401);

    s.restart_with(|_| {}).await;
    assert!(signs_in_to_a_fresh_import(&s, &mut b, "ilze-k").await);
}

#[tokio::test(flavor = "multi_thread")]
async fn disconnect_without_usable_tokens_says_github_access_was_not_revoked() {
    let s = start().await;
    let mut b = s.sign_in("ilze-k").await;
    let ilze = me(&s, &mut b).await["account"]["id"].as_i64().unwrap();
    let mut tab = s.stream_as(&b, ilze).await;
    tab.reset().await;
    // The grant goes on GitHub's side: beghu's tokens for the account no longer work.
    s.fake("POST", "/revoke", json!({ "login": "ilze-k" }))
        .await;
    tab.event_within(5 * SECS).await.expect("a switched push");

    let res = s
        .post_form(
            &mut b,
            "/auth/disconnect",
            &[("account", &ilze.to_string())],
        )
        .await;
    assert_eq!(res.status(), 200);
    assert!(!b.cookies.contains_key(SID), "{:?}", b.cookies);
    let html = res.text().await.unwrap();
    assert!(html.contains("wasn't revoked"), "{html}");
    assert!(html.contains("/settings/apps/authorizations"), "{html}");
    assert!(html.contains("href=\"/auth/signed-out\""), "{html}");
}

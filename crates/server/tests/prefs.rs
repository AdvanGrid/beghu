//! Account preferences through `PATCH /api/prefs`: comment order and the keymap, one field per
//! call, delivered in `/api/me`, applied by the server to the detail, pushed to the account's
//! tabs as `prefs`, kept across a sign-out and gone with Disconnect.

mod common;

use common::{Browser, Stack, start, summary};
use reqwest::Method;
use serde_json::{Value, json};
use std::time::Duration;

const SECS: Duration = Duration::from_secs(1);

async fn me(s: &Stack, b: &mut Browser) -> Value {
    let (status, me) = s.api(b, "/api/me").await;
    assert_eq!(status, 200, "{me}");
    me
}

/// `PATCH /api/prefs` from the tab on `b`'s active account: the status, and the body if any.
async fn patch(s: &Stack, b: &Browser, body: Value) -> (u16, Value) {
    let res = s
        .api_write(b, Method::PATCH, "/api/prefs")
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

fn key(action: &str, binding: Option<&str>) -> Value {
    json!({ "field": "key", "action": action, "binding": binding })
}

fn order(value: &str) -> Value {
    json!({ "field": "comment_order", "value": value })
}

/// An issue with more than one page of comments.
fn target() -> i64 {
    summary()["detail_targets"][0].as_i64().unwrap()
}

fn first_comment(detail: &Value) -> i64 {
    detail["comments"]["comments"][0]["id"].as_i64().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_account_starts_on_the_defaults_and_each_change_sets_one_field() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let now = me(&s, &mut b).await;
    assert_eq!(now["comment_order"], "newest");
    assert_eq!(
        now["keymap"],
        json!({}),
        "no binding of its own: the preset"
    );

    assert_eq!(patch(&s, &b, key("next", Some("n"))).await.0, 204);
    assert_eq!(patch(&s, &b, key("help", Some(""))).await.0, 204);
    assert_eq!(
        patch(&s, &b, key("openIssue", Some("Enter\ng o"))).await.0,
        204
    );
    assert_eq!(patch(&s, &b, order("oldest")).await.0, 204);
    let now = me(&s, &mut b).await;
    assert_eq!(now["comment_order"], "oldest");
    assert_eq!(
        now["keymap"],
        json!({ "next": "n", "help": "", "openIssue": "Enter\ng o" }),
        "'' is kept as deliberately unbound"
    );

    // The last write wins, field by field; null goes back to the preset.
    assert_eq!(patch(&s, &b, key("next", Some("Shift+n"))).await.0, 204);
    assert_eq!(patch(&s, &b, key("help", None)).await.0, 204);
    assert_eq!(patch(&s, &b, order("newest")).await.0, 204);
    let now = me(&s, &mut b).await;
    assert_eq!(now["comment_order"], "newest");
    assert_eq!(
        now["keymap"],
        json!({ "next": "Shift+n", "openIssue": "Enter\ng o" })
    );
}

/// Every key action the wire knows, as ts-rs writes the server's `KeyAction` for the web app.
fn key_actions() -> Vec<String> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/src/bindings/KeyAction.ts"
    );
    let ts = std::fs::read_to_string(path).unwrap();
    let union = ts.split("export type KeyAction =").nth(1).unwrap();
    let names: Vec<String> = union
        .split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect();
    assert!(names.len() > 10, "{names:?}");
    names
}

#[tokio::test(flavor = "multi_thread")]
async fn every_key_action_is_stored_and_read_back_on_its_own() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let actions = key_actions();
    let mut want = serde_json::Map::new();
    for (i, action) in actions.iter().enumerate() {
        // A binding of its own for each, so one stored in another's column shows.
        let binding = format!("F{}", i + 1);
        let (status, body) = patch(&s, &b, key(action, Some(&binding))).await;
        assert_eq!(status, 204, "{action}: {body}");
        want.insert(action.clone(), json!(binding));
        assert_eq!(
            me(&s, &mut b).await["keymap"],
            Value::Object(want.clone()),
            "after {action}"
        );
    }
    // And each goes back to the preset on its own.
    for action in &actions {
        assert_eq!(patch(&s, &b, key(action, None)).await.0, 204, "{action}");
        want.remove(action);
        assert_eq!(
            me(&s, &mut b).await["keymap"],
            Value::Object(want.clone()),
            "after {action}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_change_that_isnt_one_field_or_one_this_build_knows_is_refused_and_changes_nothing() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    for bad in [
        json!({ "field": "key", "action": "launchRockets", "binding": "x" }),
        json!({ "field": "comment_order", "value": "sideways" }),
        json!({ "field": "theme", "value": "dark" }),
        json!({ "comment_order": "oldest", "next": "n" }),
        key("next", Some("a\u{7}")),
        key("next", Some(&"x".repeat(300))),
    ] {
        let (status, _) = patch(&s, &b, bad.clone()).await;
        assert!((400..500).contains(&status), "{bad}: {status}");
    }
    let now = me(&s, &mut b).await;
    assert_eq!(
        (now["comment_order"].clone(), now["keymap"].clone()),
        (json!("newest"), json!({}))
    );

    // A write must name the tab's account, as every write does.
    let res = s
        .http
        .patch(format!("{}/api/prefs", s.server))
        .header("cookie", b.header())
        .header("origin", &s.server)
        .json(&order("oldest"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    assert_eq!(me(&s, &mut b).await["comment_order"], "newest");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_detail_comes_in_the_accounts_order_unless_the_tab_asks_for_the_one_it_shows() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let id = target();
    let (_, newest) = s.api(&mut b, &format!("/api/issues/{id}")).await;
    assert_eq!(newest["comment_order"], "newest");

    assert_eq!(patch(&s, &b, order("oldest")).await.0, 204);
    let (_, oldest) = s.api(&mut b, &format!("/api/issues/{id}")).await;
    assert_eq!(oldest["comment_order"], "oldest");
    assert_ne!(first_comment(&oldest), first_comment(&newest));
    let (_, page) = s
        .api(&mut b, &format!("/api/issues/{id}/comments?order=oldest"))
        .await;
    assert_eq!(first_comment(&oldest), page["comments"][0]["id"]);

    // Another tab still showing newest first refetches in its own order until it opens the
    // issue afresh.
    let (status, mine) = s
        .api(&mut b, &format!("/api/issues/{id}?order=newest"))
        .await;
    assert_eq!(status, 200);
    assert_eq!(mine["comment_order"], "newest");
    assert_eq!(first_comment(&mine), first_comment(&newest));
    let (status, _) = s
        .api(&mut b, &format!("/api/issues/{id}?order=sideways"))
        .await;
    assert_eq!(status, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_change_is_pushed_to_every_tab_of_the_account_and_no_one_elses() {
    let s = start().await;
    let mut here = s.sign_in("tomsj").await;
    let mut elsewhere = s.sign_in("tomsj").await;
    let mut ilze = s.sign_in("ilze-k").await;
    let tomsj = me(&s, &mut here).await["account"]["id"].as_i64().unwrap();
    let ilze_id = me(&s, &mut ilze).await["account"]["id"].as_i64().unwrap();
    let mut tabs = [
        s.stream_as(&here, tomsj).await,
        s.stream_as(&elsewhere, tomsj).await,
    ];
    let mut other = s.stream_as(&ilze, ilze_id).await;
    for t in tabs.iter_mut().chain([&mut other]) {
        t.reset().await;
    }

    assert_eq!(patch(&s, &here, key("next", Some("n"))).await.0, 204);
    for t in &mut tabs {
        let ev = t.event_within(SECS).await.expect("a prefs push");
        assert_eq!((ev.event.as_str(), ev.data.as_str()), ("prefs", "{}"));
    }
    assert!(other.event_within(SECS / 2).await.is_none());
    assert_eq!(
        me(&s, &mut elsewhere).await["keymap"],
        json!({ "next": "n" })
    );
    assert_eq!(me(&s, &mut ilze).await["keymap"], json!({}));
}

#[tokio::test(flavor = "multi_thread")]
async fn preferences_survive_a_sign_out() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let tomsj = me(&s, &mut b).await["account"]["id"].as_i64().unwrap();
    assert_eq!(patch(&s, &b, order("oldest")).await.0, 204);
    assert_eq!(patch(&s, &b, key("comment", Some("Shift+r"))).await.0, 204);

    let res = s
        .post_form(&mut b, "/auth/logout", &[("account", &tomsj.to_string())])
        .await;
    assert_eq!(res.status(), 303);
    assert_eq!(s.api(&mut b, "/api/me").await.0, 401);

    let mut again = s.sign_in("tomsj").await;
    let now = me(&s, &mut again).await;
    assert_eq!(now["comment_order"], "oldest");
    assert_eq!(now["keymap"], json!({ "comment": "Shift+r" }));
}

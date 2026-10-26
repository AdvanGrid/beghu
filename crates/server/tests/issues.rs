//! `/api/issues` serves the default list (open issues, newest update first) from the account's
//! pre-seeded mirror, a page at a time, and every API answer is `no-store`.

mod common;

use common::{Browser, start, start_with, summary};
use serde_json::Value;
use std::collections::HashSet;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread")]
async fn the_default_list_pages_through_every_open_issue_newest_update_first() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let res = s.get(&mut b, "/api/issues").await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["cache-control"], "no-store");
    assert_eq!(res.headers()["x-beghu-build"], common::BUILD);
    let first: Value = res.json().await.unwrap();

    let rows = first["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 100);
    // The generator records the top of the default view.
    let top: Vec<i64> = rows[..40]
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    let want: Vec<i64> = summary()["detail_targets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_i64().unwrap())
        .collect();
    assert_eq!(top, want);
    let r = &rows[0];
    assert_eq!(r["state"], "open");
    assert_eq!(r["kind"], "issue");
    assert_eq!(r["owner"], "acme");
    assert_eq!(r["comments"], 30);
    for key in [
        "repo",
        "number",
        "title",
        "updated_at",
        "labels",
        "assignees",
    ] {
        assert!(!r[key].is_null(), "{key} in {r}");
    }

    let mut seen: Vec<(i64, i64)> = Vec::new();
    let mut page = first;
    loop {
        for r in page["rows"].as_array().unwrap() {
            assert_eq!(r["state"], "open");
            seen.push((r["updated_at"].as_i64().unwrap(), r["id"].as_i64().unwrap()));
        }
        let Some(next) = page["next"].as_str() else {
            break;
        };
        let (status, p) = s.api(&mut b, &format!("/api/issues?after={next}")).await;
        assert_eq!(status, 200);
        page = p;
    }
    assert_eq!(
        seen.len() as u64,
        summary()["open_issues"].as_u64().unwrap()
    );
    assert!(
        seen.windows(2).all(|w| w[0] > w[1]),
        "newest first, ties on id"
    );
    let ids: HashSet<i64> = seen.iter().map(|s| s.1).collect();
    assert_eq!(ids.len(), seen.len(), "no row twice");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cursor_that_isnt_one_is_a_400() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (status, body) = s.api(&mut b, "/api/issues?after=yesterday").await;
    assert_eq!(status, 400);
    assert_eq!(body["error"], "bad_request");
}

#[tokio::test(flavor = "multi_thread")]
async fn at_the_mirror_connection_cap_a_request_gets_503_with_retry_after() {
    // One mirror connection for the whole process, and no waiting for it.
    let s = start_with(|c| {
        c.mirrors.budget.max = 1;
        c.mirrors.budget.wait = Duration::ZERO;
    })
    .await;
    let b = s.sign_in("tomsj").await;
    let other = s.sign_in("ilze-k").await;

    let mut statuses = Vec::new();
    let mut unavailable = None;
    for _ in 0..20 {
        let reqs: Vec<_> = [&b, &other]
            .iter()
            .flat_map(|br| std::iter::repeat_n(br.header(), 16))
            .map(|cookie| {
                let req = s
                    .http
                    .get(format!("{}/api/issues", s.server))
                    .header("cookie", cookie);
                tokio::spawn(async move { req.send().await.unwrap() })
            })
            .collect();
        for r in reqs {
            let res = r.await.unwrap();
            statuses.push(res.status().as_u16());
            if res.status() == 503 && unavailable.is_none() {
                unavailable = Some((
                    res.headers().get("retry-after").cloned(),
                    res.headers()["cache-control"].clone(),
                    res.json::<Value>().await.unwrap(),
                ));
            }
        }
        if unavailable.is_some() {
            break;
        }
    }
    assert!(
        statuses.iter().all(|s| *s == 200 || *s == 503),
        "{statuses:?}"
    );
    let (retry_after, cache, body) = unavailable.expect("some request found the cap full");
    assert_eq!(retry_after.unwrap(), "1");
    assert_eq!(cache, "no-store");
    assert_eq!(body["error"], "unavailable");
}

#[tokio::test(flavor = "multi_thread")]
async fn each_account_reads_its_own_mirror_with_its_own_roles() {
    let s = start().await;
    let mut owner = s.sign_in("tomsj").await;
    let mut member = s.sign_in("ilze-k").await;
    let role_on = |me: &Value, repo: &str| {
        me["repos"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["name"] == repo)
            .map(|r| r["role"].clone())
    };
    let (_, a) = s.api(&mut owner, "/api/me").await;
    let (_, b) = s.api(&mut member, "/api/me").await;
    assert_eq!(a["account"]["login"], "tomsj");
    assert_eq!(b["account"]["login"], "ilze-k");
    assert_eq!(role_on(&a, "cli"), Some("admin".into()));
    assert_eq!(role_on(&b, "cli"), Some("read".into()));
    assert_eq!(role_on(&b, "web"), Some("write".into()));

    // A browser that never signed in sees nothing.
    assert_eq!(s.api(&mut Browser::default(), "/api/issues").await.0, 401);
}

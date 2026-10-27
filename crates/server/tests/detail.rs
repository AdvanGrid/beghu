//! `/api/issues/:id` serves one issue's detail (properties, body, the first page of comments and
//! their total), `/api/issues/:id/comments` pages the thread 15 at a time, and `through=` refetches
//! everything loaded so far in one request.

mod common;

use common::{Stack, start, summary};
use serde_json::Value;

/// A top-of-list issue: the fixture gives each of these exactly 30 comments.
fn target() -> i64 {
    summary()["detail_targets"][0].as_i64().unwrap()
}

fn ids(comments: &Value) -> Vec<i64> {
    comments
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_i64().unwrap())
        .collect()
}

/// `(created_at, id)` of each comment, the thread's order key.
fn keys(comments: &Value) -> Vec<(i64, i64)> {
    comments
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["created_at"].as_i64().unwrap(), c["id"].as_i64().unwrap()))
        .collect()
}

/// Every comment of `id` in `order`, a page at a time from the detail's first page.
async fn walk(s: &Stack, b: &mut common::Browser, id: i64, order: &str) -> Vec<Value> {
    let (status, detail) = s.api(b, &format!("/api/issues/{id}")).await;
    assert_eq!(status, 200);
    let mut all: Vec<Value> = Vec::new();
    let mut page = if order == "newest" {
        detail["comments"].clone()
    } else {
        let (status, p) = s
            .api(b, &format!("/api/issues/{id}/comments?order={order}"))
            .await;
        assert_eq!(status, 200);
        p
    };
    loop {
        let got = page["comments"].as_array().unwrap();
        assert!(got.len() <= 15, "pages hold 15");
        all.extend(got.iter().cloned());
        let Some(next) = page["next"].as_str() else {
            break;
        };
        assert_eq!(got.len(), 15, "only the last page is short");
        let (status, p) = s
            .api(
                b,
                &format!("/api/issues/{id}/comments?order={order}&after={next}"),
            )
            .await;
        assert_eq!(status, 200);
        page = p;
    }
    all
}

#[tokio::test(flavor = "multi_thread")]
async fn the_detail_holds_the_issues_properties_body_and_newest_15_comments() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let id = target();
    let (_, list) = s.api(&mut b, "/api/issues").await;
    let row = list["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == id)
        .unwrap()
        .clone();

    let res = s.get(&mut b, &format!("/api/issues/{id}")).await;
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["cache-control"], "no-store");
    let d: Value = res.json().await.unwrap();

    // The same issue the list shows, with the same properties.
    for key in [
        "id",
        "kind",
        "owner",
        "repo",
        "number",
        "title",
        "state",
        "labels",
        "assignees",
    ] {
        assert_eq!(d[key], row[key], "{key}");
    }
    assert!(!d["body"].as_array().unwrap().is_empty(), "the body's AST");
    assert!(d["author"]["login"].is_string(), "{}", d["author"]);
    assert!(d["created_at"].as_i64().unwrap() <= d["updated_at"].as_i64().unwrap());
    assert!(
        d.get("milestone").is_some(),
        "milestone is present, null or not"
    );

    assert_eq!(d["comment_order"], "newest");
    assert_eq!(d["comment_total"], 30);
    let page = &d["comments"]["comments"];
    assert_eq!(page.as_array().unwrap().len(), 15);
    let k = keys(page);
    assert!(k.windows(2).all(|w| w[0] > w[1]), "newest first: {k:?}");
    let (t, last) = k.last().unwrap();
    assert_eq!(
        d["comments"]["next"],
        format!("{t}.{last}"),
        "the last comment's cursor"
    );
    let c = &page[0];
    assert!(c["author"]["login"].is_string());
    assert!(
        !c["body"].as_array().unwrap().is_empty(),
        "the comment's AST"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn comments_page_15_at_a_time_in_either_order_with_nothing_skipped_or_repeated() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let id = target();

    let newest = walk(&s, &mut b, id, "newest").await;
    let oldest = walk(&s, &mut b, id, "oldest").await;
    assert_eq!(newest.len(), 30);
    let (kn, ko) = (keys(&Value::from(newest)), keys(&Value::from(oldest)));
    assert!(kn.windows(2).all(|w| w[0] > w[1]), "newest first");
    assert!(ko.windows(2).all(|w| w[0] < w[1]), "oldest first");
    let mut reversed = ko.clone();
    reversed.reverse();
    assert_eq!(kn, reversed, "the same thread either way");
}

#[tokio::test(flavor = "multi_thread")]
async fn through_refetches_every_loaded_comment_in_one_request() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let id = target();
    let (_, d) = s.api(&mut b, &format!("/api/issues/{id}")).await;
    let first = d["comments"].clone();
    let after = first["next"].as_str().unwrap().to_owned();
    let (_, second) = s
        .api(
            &mut b,
            &format!("/api/issues/{id}/comments?order=newest&after={after}"),
        )
        .await;
    let last = cursor(second["comments"].as_array().unwrap().last().unwrap());

    // Two pages loaded: one request brings both back, with the properties.
    let (status, again) = s
        .api(&mut b, &format!("/api/issues/{id}?through={last}"))
        .await;
    assert_eq!(status, 200);
    assert_eq!(again["title"], d["title"]);
    let mut loaded = ids(&first["comments"]);
    loaded.extend(ids(&second["comments"]));
    assert_eq!(ids(&again["comments"]["comments"]), loaded);
    assert_eq!(again["comments"]["next"], Value::Null, "nothing after");

    // Through a comment mid-thread: up to it, and the cursor after it.
    let mid = cursor(&first["comments"][9]);
    let (_, part) = s
        .api(&mut b, &format!("/api/issues/{id}?through={mid}"))
        .await;
    assert_eq!(
        ids(&part["comments"]["comments"]),
        ids(&first["comments"])[..10]
    );
    assert_eq!(part["comments"]["next"], mid);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deleted_or_unknown_issue_is_gone_and_one_outside_the_synced_repos_is_no_access() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    for path in [
        "/api/issues/1",
        "/api/issues/1/comments",
        "/api/issues/not-an-id",
    ] {
        let (status, body) = s.api(&mut b, path).await;
        assert_eq!(status, 404, "{path}");
        assert_eq!(body["error"], "gone", "{path}");
    }
    let stub = common::linked_stub();
    for path in [
        format!("/api/issues/{stub}"),
        format!("/api/issues/{stub}/comments"),
    ] {
        let (status, body) = s.api(&mut b, &path).await;
        assert_eq!(status, 403, "{path}");
        assert_eq!(body["error"], "no_access", "{path}");
        // Enough to link out to it on GitHub.
        assert_eq!(body["issue"]["kind"], "issue", "{path}");
        for key in ["owner", "repo", "title"] {
            assert!(body["issue"][key].is_string(), "{path}: {key} in {body}");
        }
        assert!(body["issue"]["number"].is_i64(), "{path}: {body}");
    }
    // A 404 says nothing more.
    let (_, body) = s.api(&mut b, "/api/issues/1").await;
    assert_eq!(body.get("issue"), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_malformed_cursor_or_order_is_a_400() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let id = target();
    for q in [
        "after=x".to_owned(),
        "after=12".into(),
        "after=1.x".into(),
        "order=sideways".into(),
    ] {
        let (status, body) = s
            .api(&mut b, &format!("/api/issues/{id}/comments?{q}"))
            .await;
        assert_eq!(status, 400, "{q}");
        assert_eq!(body["error"], "bad_request", "{q}");
    }
    let (status, _) = s.api(&mut b, &format!("/api/issues/{id}?through=x")).await;
    assert_eq!(status, 400);
}

/// The cursor for a comment: `<created_at>.<id>`.
fn cursor(c: &Value) -> String {
    let (t, id) = key(c);
    format!("{t}.{id}")
}

/// A comment's place in the thread: `(created_at, id)`.
fn key(c: &Value) -> (i64, i64) {
    (c["created_at"].as_i64().unwrap(), c["id"].as_i64().unwrap())
}

/// A made-up position strictly between two neighbouring comments `a` and `b` (in either order)
/// that no comment of `all` occupies: where a comment deleted since its cursor went out would
/// have been.
fn between(a: &Value, b: &Value, all: &[Value]) -> String {
    let (lo, hi) = if key(a) < key(b) {
        (key(a), key(b))
    } else {
        (key(b), key(a))
    };
    let taken: Vec<(i64, i64)> = all.iter().map(key).collect();
    let (t, id) = [(hi.0, hi.1 - 1), (lo.0, lo.1 + 1), (lo.0 + 1, 0)]
        .into_iter()
        .find(|p| lo < *p && *p < hi && !taken.contains(p))
        .expect("room between the two comments");
    format!("{t}.{id}")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cursor_places_its_page_even_where_no_comment_is_any_more() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let id = target();
    for order in ["newest", "oldest"] {
        let all = walk(&s, &mut b, id, order).await;
        let (_, first) = s
            .api(&mut b, &format!("/api/issues/{id}/comments?order={order}"))
            .await;
        assert_eq!(
            first["next"].as_str().unwrap(),
            cursor(&all[14]),
            "{order}: next is the last comment's cursor"
        );

        // The comment a cursor named was deleted between two pages: its position is empty.
        let gap = between(&all[14], &all[15], &all);
        let (status, second) = s
            .api(
                &mut b,
                &format!("/api/issues/{id}/comments?order={order}&after={gap}"),
            )
            .await;
        assert_eq!(status, 200, "{order}: {second}");
        assert_eq!(
            ids(&second["comments"]),
            ids(&Value::from(all[15..].to_vec())),
            "{order}: the page after it, nothing skipped or repeated"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn through_refetches_an_oldest_first_thread_even_through_a_position_no_comment_holds() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let id = target();
    // No API sets the comment order yet (preferences come later): written as the server would.
    let (_, me) = s.api(&mut b, "/api/me").await;
    let account = me["account"]["id"].as_i64().unwrap();
    let control = rusqlite::Connection::open(s.control_db()).unwrap();
    control_db::q::set_comment_order(&control, account, Some("oldest")).unwrap();

    let all = walk(&s, &mut b, id, "oldest").await;
    let (_, d) = s.api(&mut b, &format!("/api/issues/{id}")).await;
    assert_eq!(d["comment_order"], "oldest");
    assert_eq!(
        ids(&d["comments"]["comments"]),
        ids(&Value::from(all[..15].to_vec()))
    );

    // Through the last comment of page 2: everything, oldest first, nothing after.
    let (status, again) = s
        .api(
            &mut b,
            &format!("/api/issues/{id}?through={}", cursor(&all[29])),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        ids(&again["comments"]["comments"]),
        ids(&Value::from(all.clone()))
    );
    assert_eq!(again["comments"]["next"], Value::Null);

    // Through where a deleted comment was, mid-thread: up to there, and the rest after it.
    let gap = between(&all[18], &all[19], &all);
    let (status, part) = s
        .api(&mut b, &format!("/api/issues/{id}?through={gap}"))
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        ids(&part["comments"]["comments"]),
        ids(&Value::from(all[..19].to_vec()))
    );
    let next = part["comments"]["next"].as_str().unwrap().to_owned();
    let (_, rest) = s
        .api(
            &mut b,
            &format!("/api/issues/{id}/comments?order=oldest&after={next}"),
        )
        .await;
    assert_eq!(
        ids(&rest["comments"]),
        ids(&Value::from(all[19..].to_vec()))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn through_a_position_before_every_comment_still_says_where_the_thread_goes_on() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let id = target();
    let all = walk(&s, &mut b, id, "newest").await;
    // Every comment the tab had loaded was deleted: the position is newer than all that's left.
    let (t, top) = key(&all[0]);
    let gap = format!("{t}.{}", top + 1);
    let (status, d) = s
        .api(&mut b, &format!("/api/issues/{id}?through={gap}"))
        .await;
    assert_eq!(status, 200, "{d}");
    assert_eq!(ids(&d["comments"]["comments"]), Vec::<i64>::new());
    assert_eq!(
        d["comments"]["next"], gap,
        "paging goes on from the position"
    );
    let (_, next) = s
        .api(
            &mut b,
            &format!("/api/issues/{id}/comments?order=newest&after={gap}"),
        )
        .await;
    assert_eq!(
        ids(&next["comments"]),
        ids(&Value::from(all[..15].to_vec()))
    );
}

/// An issue of `repo` (by name) that a relationship from another repo's issue reaches, in the
/// fixture.
fn reached_issue_of(repo: &str) -> i64 {
    let c = rusqlite::Connection::open(common::fixture()).unwrap();
    let repo = mirror_db::q::dump_repos(&c)
        .unwrap()
        .into_iter()
        .find(|r| r.name == repo)
        .unwrap()
        .id;
    let items = mirror_db::q::dump_items(&c).unwrap();
    let in_repo = |id: i64| items.iter().any(|i| i.id == id && i.repo_id == repo);
    let rel = mirror_db::q::dump_relationships(&c)
        .unwrap()
        .into_iter()
        .find(|r| in_repo(r.dst_id) && !in_repo(r.src_id))
        .unwrap();
    rel.dst_id
}

// An issue in a repo that leaves the synced set because the account picked it out: a
// relationship from a synced issue keeps it as a stub, NoAccess with a link out
// (tests/import.rs, `unsyncing_a_repo_…`). Losing access to the repo is different: the account
// may not even see a stub of it.
#[tokio::test(flavor = "multi_thread")]
async fn an_issue_in_a_repo_the_account_lost_access_to_is_gone_even_where_a_relationship_reached_it()
 {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let issue = reached_issue_of("docs");
    assert_eq!(s.api(&mut b, &format!("/api/issues/{issue}")).await.0, 200);

    // An admin takes tomsj off acme/docs; the next re-read of its repos (a sign-in forces one)
    // finds it gone.
    s.fake(
        "PUT",
        "/permissions",
        serde_json::json!({ "login": "tomsj", "repo": "acme/docs", "role": null }),
    )
    .await;
    let mut b = s.sign_in("tomsj").await;
    let (status, body) = s.api(&mut b, &format!("/api/issues/{issue}")).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (404, Some("gone")),
        "{body}"
    );
    let (_, me) = s.api(&mut b, "/api/me").await;
    let names: Vec<&str> = me["repos"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["name"].as_str().unwrap())
        .collect();
    assert!(!names.contains(&"docs"), "{names:?}");
}

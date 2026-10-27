//! What the detail's pickers offer: a synced repo's labels and milestones from the mirror, kept
//! live by GitHub's `label` and `milestone` deliveries, and who can be assigned, read from GitHub
//! as a picker opens.

mod common;

use common::{Browser, Stack, ids_of, start, start_with};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const SECS: Duration = Duration::from_secs(1);

/// The id of the synced repo called `name`.
async fn repo_id(s: &Stack, b: &mut Browser, name: &str) -> i64 {
    let (_, me) = s.api(b, "/api/me").await;
    me["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == name)
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

fn names(list: &Value, key: &str) -> Vec<String> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|v| v[key].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_offers_its_labels_milestones_and_who_can_be_assigned() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let web = repo_id(&s, &mut b, "web").await;

    let (status, labels) = s.api(&mut b, &format!("/api/repos/{web}/labels")).await;
    assert_eq!(status, 200, "{labels}");
    let bug = labels
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["name"] == "bug")
        .unwrap();
    assert_eq!(
        *bug,
        json!({ "name": "bug", "color": "d73a4a", "description": "bug work" })
    );
    let listed = names(&labels, "name");
    let mut by_name = listed.clone();
    by_name.sort_by_key(|n| n.to_lowercase());
    assert_eq!(listed, by_name);

    // Open ones first, each by due date.
    let (status, milestones) = s.api(&mut b, &format!("/api/repos/{web}/milestones")).await;
    assert_eq!(status, 200, "{milestones}");
    let order: Vec<(i64, String)> = milestones
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["number"].as_i64().unwrap(),
                m["state"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        order,
        [
            (3, "open".into()),
            (4, "open".into()),
            (1, "closed".into()),
            (2, "closed".into())
        ]
    );

    let (status, assignable) = s.api(&mut b, &format!("/api/repos/{web}/assignees")).await;
    assert_eq!(status, 200, "{assignable}");
    let logins = names(&assignable, "login");
    assert!(logins.contains(&"ilze-k".to_owned()), "{logins:?}");
    assert!(!logins.contains(&"octo-ext".to_owned()), "{logins:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_that_isnt_synced_offers_nothing() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    // partner-sdk: in the mirror only as the home of stubs.
    for what in ["labels", "milestones", "assignees"] {
        for repo in ["9000100", "1", "web"] {
            let (status, body) = s.api(&mut b, &format!("/api/repos/{repo}/{what}")).await;
            assert_eq!(
                (status, body["error"].as_str()),
                (404, Some("gone")),
                "{repo} {what}"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_github_failure_listing_who_can_be_assigned_says_github_didnt_answer() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let web = repo_id(&s, &mut b, "web").await;
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "GET /repos/*/*/assignees", "status": 502, "count": 1 }),
    )
    .await;
    let (status, err) = s.api(&mut b, &format!("/api/repos/{web}/assignees")).await;
    assert_eq!(
        (status, err["error"].as_str()),
        (503, Some("github_down")),
        "{err}"
    );
    let (status, _) = s.api(&mut b, &format!("/api/repos/{web}/assignees")).await;
    assert_eq!(status, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_label_renamed_on_github_reaches_the_picker_and_the_rows_live() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let web = repo_id(&s, &mut b, "web").await;
    let (_, page) = s
        .api(&mut b, "/api/issues?q=is:open+repo:web+label:ux")
        .await;
    let tagged = page["rows"][0]["id"]
        .as_i64()
        .expect("an open web issue labelled ux");

    s.fake(
        "POST",
        "/label",
        json!({ "repo": "web", "name": "ux", "rename": "user experience" }),
    )
    .await;
    let pushed = ids_of(&st.event_within(5 * SECS).await.unwrap());
    assert!(pushed.contains(&tagged), "{pushed:?}");

    let (_, labels) = s.api(&mut b, &format!("/api/repos/{web}/labels")).await;
    let listed = names(&labels, "name");
    assert!(listed.contains(&"user experience".to_owned()), "{listed:?}");
    assert!(!listed.contains(&"ux".to_owned()));
    let (_, d) = s.api(&mut b, &format!("/api/issues/{tagged}")).await;
    assert!(names(&d["labels"], "name").contains(&"user experience".to_owned()));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_label_no_issue_carries_still_tells_open_tabs_to_read_again() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let web = repo_id(&s, &mut b, "web").await;
    let created = json!({
        "action": "created",
        "label": { "id": 5_999_001, "name": "brand new", "color": "ededed", "description": null },
        "repository": { "id": web },
        "installation": { "id": 41000001 },
    });
    assert_eq!(s.deliver("label", "g-new-label", &created).await, 202);
    // Not an `ids` push naming nothing, which every view would take as a reason to read its
    // rows again: a `defs` push, for what offers labels and milestones.
    let ev = st.event_within(2 * SECS).await.unwrap();
    assert_eq!(ev.event, "defs", "{ev:?}");
    let (_, labels) = s.api(&mut b, &format!("/api/repos/{web}/labels")).await;
    assert!(names(&labels, "name").contains(&"brand new".to_owned()));
}

/// How Fake GitHub has answered for who can be assigned: in full, or 304.
async fn assignee_calls(s: &Stack) -> Value {
    s.fake("GET", "/state", json!({})).await["assignees"].clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn who_can_be_assigned_is_served_from_the_cache_at_once_and_rechecked_in_the_background() {
    let recheck = 3 * SECS;
    let s = start_with(|c| c.assignees_recheck_after = recheck).await;
    let mut b = s.sign_in("tomsj").await;
    let mut other = s.sign_in("ilze-k").await;
    let web = repo_id(&s, &mut b, "web").await;
    let (status, first) = s.api(&mut b, &format!("/api/repos/{web}/assignees")).await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(
        assignee_calls(&s).await,
        json!({ "full": 1, "not_modified": 0 })
    );
    // GitHub is slow from here on: an open never waits for it once the repo's list is known.
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": "GET /repos/*/*/assignees", "ms": 2000 }),
    )
    .await;
    let quick = |started: Instant| {
        let took = started.elapsed();
        assert!(took < SECS, "an open waited {took:?} on GitHub");
    };

    // Opened again within the recheck, by anyone who syncs the repo: the list GitHub last gave,
    // without asking.
    let started = Instant::now();
    let (status, again) = s
        .api(&mut other, &format!("/api/repos/{web}/assignees"))
        .await;
    quick(started);
    assert_eq!((status, &again), (200, &first));
    assert_eq!(
        assignee_calls(&s).await,
        json!({ "full": 1, "not_modified": 0 })
    );

    // Someone new can be assigned. Past the recheck, an open still answers at once, and asks
    // GitHub again meanwhile (a 304 for each page that didn't change): a later open has them.
    s.fake(
        "PUT",
        "/permissions",
        json!({ "login": "octo-ext", "repo": "web", "role": "write" }),
    )
    .await;
    tokio::time::sleep(recheck).await;
    let started = Instant::now();
    let (_, stale) = s.api(&mut b, &format!("/api/repos/{web}/assignees")).await;
    quick(started);
    assert_eq!(stale, first);
    let deadline = Instant::now() + 6 * SECS;
    loop {
        let (_, now) = s.api(&mut b, &format!("/api/repos/{web}/assignees")).await;
        if names(&now, "login").contains(&"octo-ext".to_owned()) {
            break;
        }
        assert!(Instant::now() < deadline, "octo-ext never listed: {now}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

impl Stack {
    /// `PUT /api/repos` from beghu's own page: the repos `b`'s account syncs.
    async fn pick(&self, b: &Browser, repos: &[i64]) {
        let res = self
            .http
            .put(format!("{}/api/repos", self.server))
            .header("cookie", b.header())
            .header("origin", &self.server)
            .json(&json!({ "repos": repos }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_unsynced_and_picked_again_lists_who_can_be_assigned_afresh() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (_, me) = s.api(&mut b, "/api/me").await;
    let synced: Vec<i64> = me["repos"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    let web = repo_id(&s, &mut b, "web").await;
    let (_, first) = s.api(&mut b, &format!("/api/repos/{web}/assignees")).await;
    assert!(!names(&first, "login").contains(&"octo-ext".to_owned()));

    let others: Vec<i64> = synced.iter().copied().filter(|r| *r != web).collect();
    s.pick(&b, &others).await;
    s.fake(
        "PUT",
        "/permissions",
        json!({ "login": "octo-ext", "repo": "web", "role": "write" }),
    )
    .await;
    s.pick(&b, &synced).await;
    // Within the minute the list would otherwise be served as it was.
    let (status, now) = s.api(&mut b, &format!("/api/repos/{web}/assignees")).await;
    assert_eq!(status, 200, "{now}");
    assert!(
        names(&now, "login").contains(&"octo-ext".to_owned()),
        "{now}"
    );
}

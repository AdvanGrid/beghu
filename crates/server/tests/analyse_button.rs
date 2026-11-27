//! The PR panel's Analyse button (#177), through HTTP: the PR detail's `run` and `analysis` in
//! each state, set up through the run API (start, the agent's first fetch, a refused and an
//! accepted upload, the end call, an expiry); "N behind" as Fake GitHub's pushes move the PR's
//! head, by `synchronize` webhooks and by the sweeps' probes when a webhook is lost; a force push
//! that leaves the analysed head out of the PR's commits; GitHub refusing the commit list, lagging
//! the head, or listing only 250 commits; a rate limit resting the count; GitHub down, and the
//! counts read meanwhile made once it's back; the count coming later by its event while the read
//! answers at once, one call however many reads; an `analyses.db` that can't be read; and "last
//! heard" told at most once a while.

mod common;

use common::{Browser, Stack, start, start_with, until};
use serde_json::{Value, json};
use std::time::Duration;

/// The head the PR is pushed to: the analysis crate's sample's `pr.headSha`.
const HEAD: &str = "2222222222222222222222222222222222222222";

/// The analysis crate's hand-written sample: a two-file PR adding refunds, a first analysis.
fn sample() -> Value {
    let mut v: Value =
        serde_json::from_str(include_str!("../../analysis/tests/sample/analysis.json")).unwrap();
    v["carried"] = json!([]);
    v
}

/// `tomsj`'s browser and the first open PR of `acme/web`, set up as the sample's PR: its
/// description, and a push to [`HEAD`] changing the sample's two files, which the mirror has.
async fn setup(s: &Stack) -> (Browser, i64) {
    let mut b = s.sign_in("tomsj").await;
    let (status, page) = s
        .api(
            &mut b,
            "/api/issues?q=is%3Apr%20is%3Aopen%20repo%3Aacme%2Fweb",
        )
        .await;
    assert_eq!(status, 200, "{page}");
    let number = page["rows"][0]["number"].as_i64().unwrap();
    let id = page["rows"][0]["id"].as_i64().unwrap();
    let description = sample()["pr"]["description"].as_str().unwrap().to_owned();
    s.edit(json!({ "repo": "acme/web", "number": number, "body": description }))
        .await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    s.fake(
        "POST",
        "/push",
        json!({
            "repo": "acme/web", "number": number, "sha": HEAD,
            "files": [
                { "filename": "api/main.go", "status": "modified", "additions": 1, "deletions": 0 },
                { "filename": "api/orders/refund.go", "status": "added", "additions": 21, "deletions": 0 },
            ],
        }),
    )
    .await;
    // The mirror has the push: its read-back names the PR.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        assert!(std::time::Instant::now() < deadline, "the push's read-back");
        match st.event_within(Duration::from_millis(500)).await {
            Some(e) if e.event == "ids" && common::ids_of(&e).contains(&id) => break,
            _ => {}
        }
    }
    (b, number)
}

/// The PR's own fields in its detail, as the panel reads them.
async fn pr(s: &Stack, b: &mut Browser, number: i64) -> Value {
    let (status, d) = s.api(b, &format!("/api/at/acme/web/{number}")).await;
    assert_eq!(status, 200, "{d}");
    d["pr"].clone()
}

/// Polls the PR's detail until `ok` holds of its PR fields.
async fn pr_until(
    s: &Stack,
    b: &Browser,
    number: i64,
    what: &str,
    ok: impl Fn(&Value) -> bool,
) -> Value {
    until(10.0, what, || async {
        let mut b = b.clone();
        let p = pr(s, &mut b, number).await;
        ok(&p).then_some(p)
    })
    .await
}

/// `POST /api/acme/web/pulls/{n}/runs` from the tab: the run's token.
async fn start_run(s: &Stack, b: &Browser, number: i64) -> (String, Value) {
    let res = s
        .api_write(
            b,
            reqwest::Method::POST,
            &format!("/api/acme/web/pulls/{number}/runs"),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 201);
    let body: Value = res.json().await.unwrap();
    (body["token"].as_str().unwrap().to_owned(), body)
}

/// `DELETE /api/acme/web/pulls/{n}/run` from the tab: its status.
async fn end_run(s: &Stack, b: &Browser, number: i64) -> u16 {
    s.api_write(
        b,
        reqwest::Method::DELETE,
        &format!("/api/acme/web/pulls/{number}/run"),
    )
    .send()
    .await
    .unwrap()
    .status()
    .as_u16()
}

/// A run file, fetched as an agent does: no cookie.
async fn fetch(s: &Stack, token: &str, file: &str) -> u16 {
    s.http
        .get(format!("{}/api/runs/{token}/{file}", s.server))
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

/// An upload of `body`, `Beghu-Snippets: checked`: the status and the answer.
async fn upload(s: &Stack, token: &str, body: &Value) -> (u16, Value) {
    let res = s
        .http
        .post(format!("{}/api/runs/{token}/analysis", s.server))
        .header("content-type", "application/json")
        .header("beghu-snippets", "checked")
        .body(serde_json::to_vec(body).unwrap())
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

/// A run on the PR with the sample uploaded at [`HEAD`], ended: the PR has an analysis and no run.
async fn analysed(s: &Stack, b: &Browser, number: i64) {
    let (token, _) = start_run(s, b, number).await;
    assert_eq!(fetch(s, &token, "pr.json").await, 200);
    let (status, body) = upload(s, &token, &sample()).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(end_run(s, b, number).await, 204);
}

/// The PR's commit list, as Fake GitHub's fault rules name it.
const COMMITS: &str = "GET /repos/*/*/pulls/*/commits";

/// How many more calls to [`COMMITS`] the fake's `kind` rule (`fail` or `latency`) applies to:
/// each call GitHub got uses one.
async fn commit_calls_left(s: &Stack, kind: &str) -> u64 {
    let st = s.fake("GET", "/state", Value::Null).await;
    st["faults"][kind]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["endpoint"] == COMMITS)
        .map_or(0, |f| f["remaining"].as_u64().unwrap())
}

/// A push to the PR's head branch: a derived commit on top, or with `force`, new history.
async fn push(s: &Stack, number: i64, force: bool) -> String {
    let at = s
        .fake(
            "POST",
            "/push",
            json!({ "repo": "acme/web", "number": number, "force": force }),
        )
        .await;
    at["head"].as_str().unwrap().to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_pr_detail_shows_the_run_and_the_analysis_in_each_state() {
    let s = start().await;
    let (mut b, number) = setup(&s).await;
    // Nothing yet: no run, no analysis, and neither field.
    let p = pr(&s, &mut b, number).await;
    assert!(
        p.get("run").is_none() && p.get("analysis").is_none() && p.get("run_unknown").is_none(),
        "{p}"
    );

    // Started from the panel: waiting for its agent, for 24 h.
    let (token, started) = start_run(&s, &b, number).await;
    let p = pr(&s, &mut b, number).await;
    let run = &p["run"];
    assert_eq!(run["id"], started["run"]);
    assert_eq!(
        (run["producer"].as_str(), run["state"].as_str()),
        (Some("button"), Some("waiting")),
        "{run}"
    );
    assert_eq!(run["refused"], 0);
    assert_eq!(run["expiresAt"], started["expiresAt"]);
    assert_eq!(run["startedAt"], started["startedAt"]);
    assert!(
        run.get("pinnedSha").is_none() && run.get("lastHeard").is_none(),
        "{run}"
    );

    // The agent's first fetch pins the PR at its head: attached, heard from, 2 h idle from then.
    assert_eq!(fetch(&s, &token, "instructions").await, 200);
    let p = pr(&s, &mut b, number).await;
    let run = &p["run"];
    assert_eq!(run["state"], "attached", "{run}");
    assert_eq!(run["pinnedSha"], HEAD);
    let heard = run["lastHeard"].as_i64().unwrap();
    assert_eq!(run["expiresAt"].as_i64().unwrap(), heard + 2 * 3600);

    // A refused upload: its errors are counted, and only while it's the last upload.
    let mut bad = sample();
    bad["nodes"][1].as_object_mut().unwrap().remove("kind");
    bad["nodes"][2].as_object_mut().unwrap().remove("kind");
    let (status, refused) = upload(&s, &token, &bad).await;
    assert_eq!(status, 422, "{refused}");
    let errors = refused["report"]["errors"].as_array().unwrap().len() as i64;
    assert!(errors >= 2, "{refused}");
    assert_eq!(pr(&s, &mut b, number).await["run"]["refused"], errors);
    // A wrong head is one error.
    let mut moved = sample();
    moved["pr"]["headSha"] = json!("4444444444444444444444444444444444444444");
    assert_eq!(upload(&s, &token, &moved).await.0, 409);
    assert_eq!(pr(&s, &mut b, number).await["run"]["refused"], 1);

    // Accepted: the analysis, at the PR's head; the run stays attached, nothing refused.
    let (status, accepted) = upload(&s, &token, &sample()).await;
    assert_eq!(status, 201, "{accepted}");
    let p = pr(&s, &mut b, number).await;
    assert_eq!(p["run"]["state"], "attached");
    assert_eq!(p["run"]["refused"], 0);
    let created = p["analysis"]["createdAt"].as_i64().unwrap();
    assert_eq!(
        p["analysis"],
        json!({
            "id": accepted["analysis"], "headSha": HEAD, "createdAt": created,
            "parts": 5, "purposes": 2, "conflicts": 1,
        })
    );

    // Ended from the panel: no run; the analysis stays. Ending again, with none live, is a 204.
    assert_eq!(end_run(&s, &b, number).await, 204);
    let p = pr(&s, &mut b, number).await;
    assert!(p.get("run").is_none(), "{p}");
    assert_eq!(p["analysis"]["id"], accepted["analysis"]);
    assert_eq!(end_run(&s, &b, number).await, 204);

    // A new run supersedes nothing now, and shows as the PR's run beside its analysis.
    let (_, again) = start_run(&s, &b, number).await;
    let p = pr(&s, &mut b, number).await;
    assert_eq!(p["run"]["id"], again["run"]);
    assert_eq!(p["run"]["state"], "waiting");
    assert_eq!(p["analysis"]["id"], accepted["analysis"]);

    // Another account sees none of it.
    let mut other = s.sign_in("ilze-k").await;
    let p = pr(&s, &mut other, number).await;
    assert!(p.get("run").is_none() && p.get("analysis").is_none(), "{p}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_that_expired_reads_as_expired_until_another_starts() {
    let s = start_with(|c| c.runs.unused_for = Duration::from_secs(1)).await;
    let (b, number) = setup(&s).await;
    let (_, started) = start_run(&s, &b, number).await;
    let p = pr_until(&s, &b, number, "the run expired", |p| {
        p["run"]["state"] == "expired"
    })
    .await;
    assert_eq!(p["run"]["id"], started["run"]);
    assert_eq!(p["run"]["expiresAt"], started["expiresAt"]);
    assert!(p.get("analysis").is_none(), "{p}");

    // A new run is the PR's run; once it's ended by the user, the PR has none.
    let (_, next) = start_run(&s, &b, number).await;
    let mut b2 = b.clone();
    let p = pr(&s, &mut b2, number).await;
    assert_eq!(
        (p["run"]["id"].clone(), p["run"]["state"].as_str()),
        (next["run"].clone(), Some("waiting"))
    );
    assert_eq!(end_run(&s, &b, number).await, 204);
    assert!(pr(&s, &mut b2, number).await.get("run").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn behind_counts_the_commits_pushed_since_the_analysed_head_once_per_head() {
    let s = start().await;
    let (b, number) = setup(&s).await;
    analysed(&s, &b, number).await;
    let mut b2 = b.clone();
    assert!(
        pr(&s, &mut b2, number).await["analysis"]
            .get("behind")
            .is_none(),
        "at head"
    );

    // Each push reaches the mirror by its `synchronize` webhook.
    push(&s, number, false).await;
    pr_until(&s, &b, number, "1 behind", |p| p["analysis"]["behind"] == 1).await;
    push(&s, number, false).await;
    pr_until(&s, &b, number, "2 behind", |p| p["analysis"]["behind"] == 2).await;

    // Counted once for this head: GitHub isn't asked again.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "GET /repos/*/*/pulls/*/commits", "count": 5, "status": 500 }),
    )
    .await;
    assert_eq!(pr(&s, &mut b2, number).await["analysis"]["behind"], 2);
    s.fake("DELETE", "/faults", json!({})).await;

    // A force push takes the analysed head out of the PR's commits: outdated.
    push(&s, number, true).await;
    pr_until(&s, &b, number, "outdated", |p| {
        p["analysis"]["behind"] == "outdated"
    })
    .await;

    // Still outdated after another push; a new analysis at the PR's head is at head again.
    let head = push(&s, number, false).await;
    pr_until(&s, &b, number, "outdated at the next head", |p| {
        p["analysis"]["behind"] == "outdated"
    })
    .await;
    let (token, _) = start_run(&s, &b, number).await;
    assert_eq!(fetch(&s, &token, "pr.json").await, 200);
    let mut at_head = sample();
    at_head["pr"]["headSha"] = json!(head);
    let (status, body) = upload(&s, &token, &at_head).await;
    assert_eq!(status, 201, "{body}");
    // Once the mirror has that head too (it read outdated before, so it may still lag).
    let p = pr_until(&s, &b, number, "at the new head", |p| {
        p["analysis"].get("behind").is_none()
    })
    .await;
    assert_eq!(p["analysis"]["headSha"], json!(head));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_push_whose_webhook_was_lost_reaches_behind_by_the_next_probe() {
    let s = start_with(|c| {
        c.reconcile.tick = Duration::from_millis(100);
        c.reconcile.probe_every = Duration::from_millis(300);
        c.reconcile.webhook_grace = Duration::ZERO;
    })
    .await;
    let (b, number) = setup(&s).await;
    analysed(&s, &b, number).await;
    s.fake("POST", "/faults/webhooks", json!({ "drop": 1 }))
        .await;
    push(&s, number, false).await;
    pr_until(&s, &b, number, "1 behind, by a probe", |p| {
        p["analysis"]["behind"] == 1
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_commit_list_github_refuses_reads_as_outdated_and_is_asked_for_once() {
    let s = start().await;
    let (b, number) = setup(&s).await;
    analysed(&s, &b, number).await;
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "GET /repos/*/*/pulls/*/commits", "count": 1, "status": 403 }),
    )
    .await;
    push(&s, number, false).await;
    pr_until(&s, &b, number, "outdated", |p| {
        p["analysis"]["behind"] == "outdated"
    })
    .await;
    // Kept for this head, though GitHub would list it now.
    let mut b2 = b.clone();
    assert_eq!(
        pr(&s, &mut b2, number).await["analysis"]["behind"],
        "outdated"
    );
    // The next head is counted afresh.
    push(&s, number, false).await;
    pr_until(&s, &b, number, "2 behind", |p| p["analysis"]["behind"] == 2).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_commit_list_github_fails_to_answer_reads_as_counting_until_it_does() {
    let s = start().await;
    let (b, number) = setup(&s).await;
    analysed(&s, &b, number).await;
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "GET /repos/*/*/pulls/*/commits", "count": 1, "status": 502 }),
    )
    .await;
    push(&s, number, false).await;
    pr_until(&s, &b, number, "counting while GitHub fails", |p| {
        p["analysis"]["behind"] == "counting"
    })
    .await;
    // Not kept: the next read counts.
    pr_until(&s, &b, number, "1 behind", |p| p["analysis"]["behind"] == 1).await;
}

/// The `analysis` events the stream brings within `wait`.
async fn analysis_events(st: &mut common::Stream, wait: Duration) -> Vec<Value> {
    st.events_for(wait)
        .await
        .into_iter()
        .filter(|e| e.event == "analysis")
        .map(|e| serde_json::from_str(&e.data).unwrap())
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_detail_read_never_waits_on_github_and_the_count_comes_by_its_event() {
    let s = start().await;
    let (mut b, number) = setup(&s).await;
    analysed(&s, &b, number).await;
    // GitHub takes 4 s to list the PR's commits, for the next 100 calls.
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": COMMITS, "ms": 4000, "count": 100 }),
    )
    .await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    push(&s, number, false).await;
    // Until the mirror has the new head the PR reads at head; then counting while it's counted.
    // Every read answers at once.
    let read_at = until(10.0, "the mirror's head moved", || {
        let mut b = b.clone();
        let s = &s;
        async move {
            let t = std::time::Instant::now();
            let p = pr(s, &mut b, number).await;
            let took = t.elapsed();
            assert!(took < Duration::from_secs(2), "the read took {took:?}");
            (p["analysis"]["behind"] == "counting").then_some(std::time::Instant::now())
        }
    })
    .await;
    // A second read meanwhile starts no second count, and doesn't wait either.
    let t = std::time::Instant::now();
    assert_eq!(
        pr(&s, &mut b, number).await["analysis"]["behind"],
        "counting"
    );
    assert!(t.elapsed() < Duration::from_secs(2));
    // The count lands and tells the stream, which reads the PR again.
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let got = loop {
        assert!(
            std::time::Instant::now() < deadline,
            "no analysis event for the count"
        );
        let evs = analysis_events(&mut st, Duration::from_millis(200)).await;
        if let Some(e) = evs.into_iter().find(|e| e["number"] == number) {
            break e;
        }
    };
    assert!(
        read_at.elapsed() >= Duration::from_secs(2),
        "the event came with the count"
    );
    assert_eq!(got["repo"], "acme/web");
    assert_eq!(pr(&s, &mut b, number).await["analysis"]["behind"], 1);
    // However many reads there were, GitHub was asked once.
    assert_eq!(commit_calls_left(&s, "latency").await, 99);
    s.fake("DELETE", "/faults", json!({})).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_commit_list_that_lags_the_head_is_counted_again_and_never_kept_wrong() {
    let s = start().await;
    let (b, number) = setup(&s).await;
    analysed(&s, &b, number).await;
    // GitHub's REST list hasn't caught up with the push the mirror read: it ends at the analysed
    // head.
    s.fake(
        "POST",
        "/faults/rewrite",
        json!({
            "endpoint": "GET /repos/*/*/pulls/*/commits", "count": 1,
            "raw": format!("[{{\"sha\":\"{HEAD}\"}}]"),
        }),
    )
    .await;
    push(&s, number, false).await;
    // Never at head (what counting to the list's end would say), and 1 behind once listed.
    let seen = std::sync::Mutex::new(Vec::new());
    pr_until(&s, &b, number, "1 behind", |p| {
        seen.lock()
            .unwrap()
            .push(p["analysis"].get("behind").cloned());
        p["analysis"]["behind"] == 1
    })
    .await;
    let seen = seen.into_inner().unwrap();
    let first_moved = seen.iter().position(|b| b.is_some()).unwrap();
    assert!(
        seen[first_moved..].iter().all(|b| b.is_some()),
        "read at head after the head moved: {seen:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_head_past_the_250_commits_github_lists_reads_as_outdated() {
    let s = start().await;
    let (b, number) = setup(&s).await;
    analysed(&s, &b, number).await;
    s.fake(
        "POST",
        "/push",
        json!({ "repo": "acme/web", "number": number, "commits": 300 }),
    )
    .await;
    pr_until(&s, &b, number, "outdated", |p| {
        p["analysis"]["behind"] == "outdated"
    })
    .await;
    // Past the counts' retries: still outdated, never a count up to the list's end.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let mut b2 = b.clone();
    assert_eq!(
        pr(&s, &mut b2, number).await["analysis"]["behind"],
        "outdated"
    );
    // Resting: reads meanwhile don't ask GitHub again.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": COMMITS, "count": 50, "status": 500 }),
    )
    .await;
    for _ in 0..3 {
        assert_eq!(
            pr(&s, &mut b2, number).await["analysis"]["behind"],
            "outdated"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert_eq!(commit_calls_left(&s, "fail").await, 50);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rate_limited_commit_list_rests_until_githubs_wait_is_over() {
    let s = start().await;
    let (mut b, number) = setup(&s).await;
    analysed(&s, &b, number).await;
    // GitHub's secondary rate limit, a minute's wait named.
    s.fake(
        "POST",
        "/faults/fail",
        json!({
            "endpoint": COMMITS, "count": 50, "status": 403,
            "limit": "secondary", "retry_after": 60,
        }),
    )
    .await;
    push(&s, number, false).await;
    pr_until(&s, &b, number, "counting", |p| {
        p["analysis"]["behind"] == "counting"
    })
    .await;
    until(10.0, "the count asked GitHub", || async {
        (commit_calls_left(&s, "fail").await == 49).then_some(())
    })
    .await;
    // Past the passing failures' retries (2 s, then 4 s): every read still counting, and GitHub
    // not asked again.
    for _ in 0..8 {
        assert_eq!(
            pr(&s, &mut b, number).await["analysis"]["behind"],
            "counting"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert_eq!(commit_calls_left(&s, "fail").await, 49);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_count_read_while_github_is_down_is_made_once_its_back() {
    let s = start_with(|c| {
        c.github_probe_every = Duration::from_millis(300);
        c.reconcile.feed_every = Duration::from_millis(50);
    })
    .await;
    let (mut b, number) = setup(&s).await;
    analysed(&s, &b, number).await;
    let (_, d) = s.api(&mut b, &format!("/api/at/acme/web/{number}")).await;
    let id = d["id"].as_i64().unwrap();
    let mut st = s.stream(&b).await;
    st.reset().await;
    assert_eq!(
        st.github_within(Duration::from_secs(5)).await.as_deref(),
        Some("up")
    );
    // The mirror has the push, unread by the panel.
    push(&s, number, false).await;
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        assert!(std::time::Instant::now() < deadline, "the push's read-back");
        match st.event_within(Duration::from_millis(500)).await {
            Some(e) if e.event == "ids" && common::ids_of(&e).contains(&id) => break,
            _ => {}
        }
    }
    // GitHub goes down: the stream's poller finds it so.
    s.fake("POST", "/faults/down", json!({ "down": true }))
        .await;
    assert_eq!(
        st.github_within(Duration::from_secs(10)).await.as_deref(),
        Some("down")
    );
    for _ in 0..3 {
        assert_eq!(
            pr(&s, &mut b, number).await["analysis"]["behind"],
            "counting"
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    // Back: the count is made with no read to start it, and its event tells the stream.
    s.fake("POST", "/faults/down", json!({ "down": false }))
        .await;
    assert_eq!(
        st.github_within(Duration::from_secs(10)).await.as_deref(),
        Some("up")
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        assert!(
            std::time::Instant::now() < deadline,
            "no analysis event for the count"
        );
        let evs = analysis_events(&mut st, Duration::from_millis(200)).await;
        if evs.iter().any(|e| e["number"] == number) {
            break;
        }
    }
    assert_eq!(pr(&s, &mut b, number).await["analysis"]["behind"], 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_analyses_db_that_cant_be_read_leaves_the_pr_detail_without_run_or_analysis() {
    let s = start().await;
    let (mut b, number) = setup(&s).await;
    // Before this server first opens the account's `analyses.db`, it's made into a file that
    // isn't a database (a disk fault): every use of it fails. Written to the data dir, not
    // through a public seam: no HTTP surface, the server's or Fake GitHub's, makes a disk fail.
    let dir = s.data.join("analyses");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(format!("{}.db", b.account()));
    std::fs::write(&file, vec![b'x'; 4096]).unwrap();
    let (status, d) = s.api(&mut b, &format!("/api/at/acme/web/{number}")).await;
    assert_eq!(status, 200, "{d}");
    assert_eq!(d["number"], number);
    assert!(
        d["pr"].get("run").is_none() && d["pr"].get("analysis").is_none(),
        "{d}"
    );
    // Not known, rather than none: the panel keeps what it showed.
    assert_eq!(d["pr"]["run_unknown"], true, "{d}");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agents_calls_tell_the_stream_it_was_heard_from_at_most_once_a_while() {
    let s = start_with(|c| c.runs.heard_every = Duration::from_secs(2)).await;
    let (mut b, number) = setup(&s).await;
    let (token, _) = start_run(&s, &b, number).await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    // The first fetch attaches the run: one event.
    assert_eq!(fetch(&s, &token, "instructions").await, 200);
    assert_eq!(
        analysis_events(&mut st, Duration::from_millis(500))
            .await
            .len(),
        1
    );
    let heard = pr(&s, &mut b, number).await["run"]["lastHeard"]
        .as_i64()
        .unwrap();
    // Another call at once: nothing to tell yet.
    assert_eq!(fetch(&s, &token, "pr.json").await, 200);
    assert!(
        analysis_events(&mut st, Duration::from_millis(500))
            .await
            .is_empty()
    );
    // A call `heard_every` later is told, and the detail has it.
    tokio::time::sleep(Duration::from_millis(2100)).await;
    assert_eq!(fetch(&s, &token, "pr.json").await, 200);
    let evs = analysis_events(&mut st, Duration::from_millis(500)).await;
    assert_eq!(evs.len(), 1, "{evs:?}");
    assert_eq!(evs[0]["number"], number);
    let now = pr(&s, &mut b, number).await["run"]["lastHeard"]
        .as_i64()
        .unwrap();
    assert!(now >= heard + 2, "{heard} then {now}");
}

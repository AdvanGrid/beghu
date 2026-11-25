//! The PR panel's Analyse button (#177), through HTTP: the PR detail's `run` and `analysis` in
//! each state, set up through the run API (start, the agent's first fetch, a refused and an
//! accepted upload, the end call, an expiry); "N behind" as Fake GitHub's pushes move the PR's
//! head, by `synchronize` webhooks and by the sweeps' probes when a webhook is lost; a force push
//! that leaves the analysed head out of the PR's commits; and GitHub refusing the commit list.

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
    let description = sample()["pr"]["description"].as_str().unwrap().to_owned();
    s.edit(json!({ "repo": "acme/web", "number": number, "body": description }))
        .await;
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
    assert!(p.get("run").is_none() && p.get("analysis").is_none(), "{p}");

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
    let p = pr(&s, &mut b2, number).await;
    assert_eq!(p["analysis"]["headSha"], json!(head));
    assert!(p["analysis"].get("behind").is_none(), "{p}");
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
async fn a_commit_list_github_fails_to_answer_reads_as_outdated_until_it_does() {
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
    pr_until(&s, &b, number, "outdated while GitHub fails", |p| {
        p["analysis"]["behind"] == "outdated"
    })
    .await;
    // Not kept: the next read counts.
    pr_until(&s, &b, number, "1 behind", |p| p["analysis"]["behind"] == 1).await;
}

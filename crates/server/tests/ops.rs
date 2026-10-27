//! Writes: `POST /api/ops` with Fake GitHub behind it. Each op is one GitHub call made with the
//! user's token; its answer is written to the mirror (pushing the issue's id) before the reply,
//! and the webhook GitHub sends back for it changes nothing more. Resends of one `op_id` share
//! one call, a client that goes away doesn't stop it, and the retry matrix, rate limits and the
//! process-wide GitHub down flag are driven through the fake's faults.

mod common;

use common::{Browser, Stack, ids_of, start, start_with};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const SECS: Duration = Duration::from_secs(1);

/// A fresh op id, as the tab makes them: a random (version 4) UUID.
fn uuid() -> String {
    let n: u128 = rand::random();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        n >> 96,
        (n >> 80) & 0xffff,
        (n >> 64) & 0xfff,
        0x8000 | ((n >> 48) & 0x3fff),
        n & 0xffff_ffff_ffff
    )
}

impl Stack {
    /// `POST /api/ops` from `b`'s tab, from beghu's own origin; the status and the body.
    async fn op(&self, b: &Browser, op_id: &str, op: Value) -> (u16, Value) {
        let res = self.post_op(b, Some(&self.server), op_id, &op).await;
        let status = res.status().as_u16();
        (status, res.json().await.unwrap_or(Value::Null))
    }

    /// As [`Stack::op`], but marked as a resend: the tab sent this op before and got no answer.
    async fn resend(&self, b: &Browser, op_id: &str, op: Value) -> (u16, Value) {
        let res = self
            .http
            .post(format!("{}/api/ops", self.server))
            .header("cookie", b.header())
            .header("origin", &self.server)
            .json(&json!({ "op_id": op_id, "op": op, "resend": true }))
            .send()
            .await
            .unwrap();
        let status = res.status().as_u16();
        (status, res.json().await.unwrap_or(Value::Null))
    }

    async fn post_op(
        &self,
        b: &Browser,
        origin: Option<&str>,
        op_id: &str,
        op: &Value,
    ) -> reqwest::Response {
        let mut req = self
            .http
            .post(format!("{}/api/ops", self.server))
            .header("cookie", b.header())
            .json(&json!({ "op_id": op_id, "op": op }));
        if let Some(o) = origin {
            req = req.header("origin", o);
        }
        req.send().await.unwrap()
    }

    /// The fake's fault rules still waiting to fail calls.
    async fn fail_rules(&self) -> Value {
        let res = self
            .http
            .get(format!("{}/state", self.fake_ctl))
            .send()
            .await
            .unwrap();
        res.json::<Value>().await.unwrap()["faults"]["fail"].clone()
    }

    async fn fail(&self, endpoint: &str, status: u16, count: u32, retry_after: Option<u64>) {
        self.fake(
            "POST",
            "/faults/fail",
            json!({ "endpoint": endpoint, "status": status, "count": count, "retry_after": retry_after }),
        )
        .await;
    }
}

/// An open issue at the top of `b`'s list: its id and the list row.
async fn an_open_issue(s: &Stack, b: &mut Browser) -> (i64, Value) {
    let (_, page) = s.api(b, "/api/issues").await;
    let r = page["rows"][0].clone();
    (r["id"].as_i64().unwrap(), r)
}

/// The comments of `id`'s detail with this body.
async fn comments_saying(s: &Stack, b: &mut Browser, id: i64, body: &str) -> Vec<Value> {
    let (status, d) = s.api(b, &format!("/api/issues/{id}")).await;
    assert_eq!(status, 200, "{d}");
    d["comments"]["comments"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["body"] == body)
        .cloned()
        .collect()
}

/// A pull request `b` can see: GitHub's issue endpoints take PRs too, but beghu writes only to
/// issues.
async fn a_pr(s: &Stack, b: &mut Browser) -> i64 {
    for id in 3_000_000_000..3_000_001_300 {
        let (status, d) = s.api(b, &format!("/api/issues/{id}")).await;
        if status == 200 && d["kind"] == "pr" {
            return id;
        }
    }
    panic!("no PR in the fixture");
}

const COMMENTS: &str = "POST /repos/*/*/issues/*/comments";
const ISSUE: &str = "PATCH /repos/*/*/issues/*";

#[tokio::test(flavor = "multi_thread")]
async fn a_comment_is_on_github_and_in_the_detail_when_the_reply_comes_and_its_echo_adds_nothing() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.event_within(SECS).await;
    let (id, _) = an_open_issue(&s, &mut b).await;

    let (status, reply) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "comment", "issue": id, "body": "Posted from beghu" }),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    assert_eq!(reply["issue"], id);
    assert_eq!(reply["comment"]["body"], "Posted from beghu");
    assert_eq!(reply["comment"]["author"]["login"], "tomsj");
    // In the mirror before the reply: a read now has it, and the push has gone out.
    let now = comments_saying(&s, &mut b, id, "Posted from beghu").await;
    assert_eq!(now.len(), 1);
    assert_eq!(now[0]["id"], reply["comment"]["id"]);
    assert_eq!(ids_of(&st.event_within(SECS).await.unwrap()), [id]);

    // GitHub's issue_comment.created comes back about a second later: still one comment.
    tokio::time::sleep(2 * SECS).await;
    assert_eq!(
        comments_saying(&s, &mut b, id, "Posted from beghu")
            .await
            .len(),
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resent_op_id_joins_its_write_and_a_client_that_goes_away_doesnt_cancel_it() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": COMMENTS, "ms": 1500 }),
    )
    .await;
    let op = json!({ "kind": "comment", "issue": id, "body": "Sent once" });
    let op_id = uuid();

    // The tab's connection drops while GitHub is still answering.
    let dropped = s
        .http
        .post(format!("{}/api/ops", s.server))
        .header("cookie", b.header())
        .header("origin", &s.server)
        .json(&json!({ "op_id": op_id, "op": op }))
        .timeout(Duration::from_millis(300))
        .send()
        .await;
    assert!(dropped.is_err(), "the client gave up first");
    // The resend joins the write in flight.
    let (status, first) = s.resend(&b, &op_id, op.clone()).await;
    assert_eq!(status, 200, "{first}");
    // A resend after it ends gets its outcome, at once: no second call to slow GitHub.
    let t = Instant::now();
    let (status, again) = s.resend(&b, &op_id, op.clone()).await;
    assert_eq!(status, 200);
    assert!(
        t.elapsed() < Duration::from_millis(1000),
        "{:?}",
        t.elapsed()
    );
    assert_eq!(again["comment"]["id"], first["comment"]["id"]);

    // One comment on GitHub, so one in the mirror once its webhook is in too.
    tokio::time::sleep(2 * SECS).await;
    assert_eq!(comments_saying(&s, &mut b, id, "Sent once").await.len(), 1);

    // An op_id is one op.
    let other = json!({ "kind": "comment", "issue": id, "body": "Something else" });
    assert_eq!(s.op(&b, &op_id, other).await.0, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn close_is_tried_again_twice_on_a_5xx_but_a_comment_never_is() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;

    // Two 5xx, then GitHub answers: the third call, after 1 s and 3 s, closes it.
    s.fail(ISSUE, 502, 2, None).await;
    let t = Instant::now();
    let (status, reply) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "close", "issue": id, "reason": "not_planned" }),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    assert!(t.elapsed() >= 4 * SECS, "{:?}", t.elapsed());
    assert_eq!(s.fail_rules().await, json!([]));
    let (_, d) = s.api(&mut b, &format!("/api/issues/{id}")).await;
    assert_eq!(d["state"], "closed");
    assert_eq!(d["state_reason"], "not_planned");

    // A comment that meets a 5xx fails at once, after one call: GitHub may have posted it, and
    // the failure says so.
    s.fail(COMMENTS, 502, 2, None).await;
    let (status, err) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "comment", "issue": id, "body": "Once only" }),
        )
        .await;
    assert_eq!(status, 424, "{err}");
    assert_eq!(err["error"], "maybe_posted");
    assert!(
        err["message"]
            .as_str()
            .unwrap()
            .contains("check the thread"),
        "{err}"
    );
    assert_eq!(s.fail_rules().await[0]["remaining"], 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn one_close_that_meets_three_5xx_marks_github_down() {
    let s = start_with(|c| c.github_probe_every = Duration::from_millis(300)).await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    assert_eq!(st.github_within(SECS).await.as_deref(), Some("up"));
    let (id, _) = an_open_issue(&s, &mut b).await;

    // A close and its two retries all meet a 500: three GitHub calls failed in a row.
    s.fail(ISSUE, 500, 3, None).await;
    s.fail("/rate_limit", 503, 1, None).await;
    let (status, err) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "close", "issue": id, "reason": "completed" }),
        )
        .await;
    assert_eq!((status, err["error"].as_str()), (503, Some("github_down")));
    assert_eq!(st.github_within(SECS).await.as_deref(), Some("down"));
}

#[tokio::test(flavor = "multi_thread")]
async fn three_failed_ops_in_a_row_mark_github_down_until_rate_limit_answers_again() {
    let s = start_with(|c| c.github_probe_every = Duration::from_millis(300)).await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    // The stream opens with GitHub's state.
    assert_eq!(st.github_within(SECS).await.as_deref(), Some("up"));
    let (id, _) = an_open_issue(&s, &mut b).await;

    s.fail(COMMENTS, 503, 3, None).await;
    s.fail("/rate_limit", 503, 2, None).await;
    for n in 0..3 {
        let (status, err) = s
            .op(
                &b,
                &uuid(),
                json!({ "kind": "comment", "issue": id, "body": format!("Into the void {n}") }),
            )
            .await;
        assert_eq!(status, 424, "{err}");
    }
    assert_eq!(st.github_within(SECS).await.as_deref(), Some("down"));

    // While it's down a write fails at once, without a call.
    let t = Instant::now();
    let (status, err) = s
        .op(&b, &uuid(), json!({ "kind": "reopen", "issue": id }))
        .await;
    assert_eq!((status, err["error"].as_str()), (503, Some("github_down")));
    assert!(t.elapsed() < SECS);

    // The probe fails twice more, then GitHub answers: up again, and writes go through.
    assert_eq!(st.github_within(5 * SECS).await.as_deref(), Some("up"));
    assert_eq!(s.fail_rules().await, json!([]));
    let (status, _) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "close", "issue": id, "reason": "completed" }),
        )
        .await;
    assert_eq!(status, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_short_rate_limit_is_waited_out_quietly_and_a_long_one_says_when_to_try_again() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;

    s.fail(COMMENTS, 429, 1, Some(1)).await;
    let t = Instant::now();
    let (status, reply) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "comment", "issue": id, "body": "After a wait" }),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    assert!(t.elapsed() >= SECS, "{:?}", t.elapsed());

    s.fail(ISSUE, 403, 1, Some(30)).await;
    let res = s
        .post_op(
            &b,
            Some(&s.server),
            &uuid(),
            &json!({ "kind": "close", "issue": id, "reason": "completed" }),
        )
        .await;
    assert_eq!(res.status(), 429);
    assert_eq!(res.headers()["retry-after"], "30");
    let err: Value = res.json().await.unwrap();
    assert_eq!(err["error"], "rate_limited");
    assert!(
        err["message"]
            .as_str()
            .unwrap()
            .contains("try again in 30 s"),
        "{err}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_close_github_refuses_for_the_role_fails_and_leaves_the_issue_open() {
    let s = start().await;
    // Read on `cli`, `billing` and `ops`, on issues other people opened.
    let mut b = s.sign_in("ilze-k").await;
    let (_, page) = s.api(&mut b, "/api/issues").await;
    let id = page["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| matches!(r["repo"].as_str(), Some("cli" | "billing" | "ops")))
        .expect("an open issue in a repo ilze-k reads")["id"]
        .as_i64()
        .unwrap();
    let (status, err) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "close", "issue": id, "reason": "completed" }),
        )
        .await;
    assert_eq!(status, 422, "{err}");
    assert_eq!(err["error"], "refused");
    let (_, d) = s.api(&mut b, &format!("/api/issues/{id}")).await;
    assert_eq!(d["state"], "open");
    // An issue the mirror doesn't hold.
    let (status, err) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "close", "issue": 1, "reason": "completed" }),
        )
        .await;
    assert_eq!((status, err["error"].as_str()), (404, Some("gone")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_write_from_another_site_or_with_no_origin_is_refused_before_anything_happens() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    let op = json!({ "kind": "close", "issue": id, "reason": "completed" });
    for origin in [Some("https://evil.example"), None] {
        let res = s.post_op(&b, origin, &uuid(), &op).await;
        assert_eq!(res.status(), 403, "{origin:?}");
        assert_eq!(res.json::<Value>().await.unwrap()["error"], "forbidden");
    }
    let (_, d) = s.api(&mut b, &format!("/api/issues/{id}")).await;
    assert_eq!(d["state"], "open");
}

#[tokio::test(flavor = "multi_thread")]
async fn every_api_route_refuses_a_non_get_from_another_site_but_the_webhook_takes_github() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    // Every route under /api, the list's facets and the detail included, and a path that isn't
    // one.
    for path in [
        "/api/me".to_owned(),
        "/api/issues".to_owned(),
        "/api/facets".to_owned(),
        "/api/facets/label/counts".to_owned(),
        format!("/api/issues/{id}"),
        format!("/api/issues/{id}/comments"),
        "/api/stream".to_owned(),
        "/api/ops".to_owned(),
        "/api/no-such-route".to_owned(),
    ] {
        for method in [reqwest::Method::POST, reqwest::Method::DELETE] {
            let res = s
                .http
                .request(method.clone(), format!("{}{path}", s.server))
                .header("cookie", b.header())
                .header("origin", "https://evil.example")
                .json(&json!({}))
                .send()
                .await
                .unwrap();
            assert_eq!(res.status(), 403, "{method} {path}");
        }
    }
    // GitHub's deliveries come from GitHub's servers: `/webhook` is outside the check, and its
    // signature is what it trusts.
    let body = serde_json::to_vec(&json!({ "zen": "Keep it simple.", "hook_id": 1 })).unwrap();
    let res = s
        .http
        .post(format!("{}/webhook", s.server))
        .header("origin", "https://evil.example")
        .header("x-github-event", "ping")
        .header("x-github-delivery", uuid())
        .header(
            "x-hub-signature-256",
            fake_github::sign_webhook(common::WEBHOOK_SECRET, &body),
        )
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "{}", res.status());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_write_to_a_pull_request_is_refused_before_github_is_called() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let pr = a_pr(&s, &mut b).await;
    let (_, before) = s.api(&mut b, &format!("/api/issues/{pr}")).await;
    // Any call to GitHub would use this up.
    s.fail("/repos/*", 500, 1, None).await;
    for op in [
        json!({ "kind": "close", "issue": pr, "reason": "completed" }),
        json!({ "kind": "reopen", "issue": pr }),
        json!({ "kind": "comment", "issue": pr, "body": "On a PR" }),
    ] {
        let (status, err) = s.op(&b, &uuid(), op).await;
        assert_eq!(
            (status, err["error"].as_str()),
            (422, Some("refused")),
            "{err}"
        );
    }
    assert_eq!(s.fail_rules().await[0]["remaining"], 1);
    let (_, after) = s.api(&mut b, &format!("/api/issues/{pr}")).await;
    assert_eq!(after["state"], before["state"]);
    assert_eq!(after["comment_total"], before["comment_total"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_op_id_is_a_uuid() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    let op = json!({ "kind": "reopen", "issue": id });
    for bad in [
        "op-1",
        "",
        "not-a-uuid-at-all-but-36-chars-long!",
        &"a".repeat(64),
    ] {
        let (status, err) = s.op(&b, bad, op.clone()).await;
        assert_eq!(
            (status, err["error"].as_str()),
            (400, Some("bad_request")),
            "{bad:?}: {err}"
        );
    }
    let (status, reply) = s.op(&b, &uuid(), op).await;
    assert_eq!(status, 200, "{reply}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_comment_longer_than_github_takes_is_refused_with_why() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    // GitHub's limit counts characters, not bytes: 65,536 of "é" is 131,072 bytes and fits.
    let longest = "é".repeat(65_536);
    let (status, reply) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "comment", "issue": id, "body": longest }),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    let (status, err) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "comment", "issue": id, "body": "x".repeat(65_537) }),
        )
        .await;
    assert_eq!((status, err["error"].as_str()), (400, Some("bad_request")));
    assert!(err["message"].as_str().unwrap().contains("65,536"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resend_the_server_has_no_record_of_is_lost_and_never_sent_again() {
    let mut s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": COMMENTS, "ms": 1500 }),
    )
    .await;
    let op = json!({ "kind": "comment", "issue": id, "body": "Across a restart" });
    let op_id = uuid();
    // The tab's connection drops while GitHub is answering, and beghu restarts meanwhile.
    let dropped = s
        .http
        .post(format!("{}/api/ops", s.server))
        .header("cookie", b.header())
        .header("origin", &s.server)
        .json(&json!({ "op_id": op_id, "op": op }))
        .timeout(Duration::from_millis(300))
        .send()
        .await;
    assert!(dropped.is_err(), "the client gave up first");
    s.restart_with(|_| {}).await;
    // Any call to GitHub would use this up.
    s.fail(COMMENTS, 500, 1, None).await;

    // The new server has never heard of the op: it may or may not have reached GitHub, so it's
    // lost, and not sent again.
    let (status, err) = s.resend(&b, &op_id, op.clone()).await;
    assert_eq!(
        (status, err["error"].as_str()),
        (410, Some("lost")),
        "{err}"
    );
    // In the words the tab shows.
    assert_eq!(
        err["message"],
        "May or may not have been sent; check the thread"
    );
    let close = json!({ "kind": "close", "issue": id, "reason": "completed" });
    let (_, err) = s.resend(&b, &uuid(), close).await;
    assert_eq!(err["message"], "May or may not have reached GitHub");
    assert_eq!(s.fail_rules().await[0]["remaining"], 1);
    // And it stays lost: the resend didn't start it.
    let (status, err) = s.resend(&b, &op_id, op.clone()).await;
    assert_eq!(
        (status, err["error"].as_str()),
        (410, Some("lost")),
        "{err}"
    );

    // The first send did reach GitHub: one comment.
    tokio::time::sleep(3 * SECS).await;
    assert_eq!(
        comments_saying(&s, &mut b, id, "Across a restart")
            .await
            .len(),
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_comment_github_keeps_in_its_own_words_is_posted_as_github_keeps_it() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    s.fake(
        "POST",
        "/faults/rewrite",
        json!({ "endpoint": COMMENTS, "body": "Normalised by GitHub" }),
    )
    .await;
    let (status, reply) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "comment", "issue": id, "body": "As typed" }),
        )
        .await;
    // GitHub answered 201: the comment is posted, whatever its text came back as.
    assert_eq!(status, 200, "{reply}");
    assert_eq!(reply["comment"]["body"], "Normalised by GitHub");
    let shown = comments_saying(&s, &mut b, id, "Normalised by GitHub").await;
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0]["id"], reply["comment"]["id"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_comment_github_doesnt_answer_may_have_been_posted_and_isnt_sent_again() {
    let s = start_with(|c| c.github_write_timeout = Duration::from_millis(500)).await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    let comment = |body: &str| json!({ "kind": "comment", "issue": id, "body": body });

    // No answer within the write's timeout.
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": COMMENTS, "ms": 1500, "count": 1 }),
    )
    .await;
    let t = Instant::now();
    let (status, err) = s.op(&b, &uuid(), comment("Timed out")).await;
    assert_eq!(
        (status, err["error"].as_str()),
        (424, Some("maybe_posted")),
        "{err}"
    );
    assert_eq!(err["message"], "May have been posted; check the thread");
    assert!(
        t.elapsed() < Duration::from_millis(1500),
        "{:?}",
        t.elapsed()
    );

    // The connection drops with no answer: once, and not again.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": COMMENTS, "reset": true }),
    )
    .await;
    s.fail(COMMENTS, 500, 1, None).await;
    let (status, err) = s.op(&b, &uuid(), comment("Reset")).await;
    assert_eq!(
        (status, err["error"].as_str()),
        (424, Some("maybe_posted")),
        "{err}"
    );
    assert_eq!(s.fail_rules().await[0]["status"], 500);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_maybe_posted_comment_names_the_newest_comment_the_mirror_had_as_it_was_sent() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    let comment = |body: &str| json!({ "kind": "comment", "issue": id, "body": body });
    let (status, reply) = s.op(&b, &uuid(), comment("+1")).await;
    assert_eq!(status, 200, "{reply}");

    // The same text again, and GitHub fails on it: only a comment newer than the first can be it.
    s.fail(COMMENTS, 502, 1, None).await;
    let (status, err) = s.op(&b, &uuid(), comment("+1")).await;
    assert_eq!(
        (status, err["error"].as_str()),
        (424, Some("maybe_posted")),
        "{err}"
    );
    assert_eq!(err["after"], reply["comment"]["id"], "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_comment_github_posts_but_answers_unreadably_may_have_been_posted() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    // GitHub's 201, cut short on the way back: not JSON at all, and JSON that isn't a comment.
    for (raw, text) in [(r#"{"id": 1, "bo"#, "Cut short"), ("{}", "Not a comment")] {
        s.fake(
            "POST",
            "/faults/rewrite",
            json!({ "endpoint": COMMENTS, "raw": raw }),
        )
        .await;
        let (status, err) = s
            .op(
                &b,
                &uuid(),
                json!({ "kind": "comment", "issue": id, "body": text }),
            )
            .await;
        assert_eq!(
            (status, err["error"].as_str()),
            (424, Some("maybe_posted")),
            "{text}: {err}"
        );
        // It was posted: its webhook brings it to the thread.
        let t = Instant::now();
        while comments_saying(&s, &mut b, id, text).await.is_empty() {
            assert!(t.elapsed() < 10 * SECS, "{text} never reached the thread");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn close_and_reopen_are_tried_again_after_a_timeout_or_a_reset() {
    let s = start_with(|c| c.github_write_timeout = Duration::from_millis(500)).await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    let state = |d: &Value| d["state"].as_str().unwrap().to_owned();

    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": ISSUE, "ms": 1500, "count": 1 }),
    )
    .await;
    let (status, reply) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "close", "issue": id, "reason": "completed" }),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    assert_eq!(
        state(&s.api(&mut b, &format!("/api/issues/{id}")).await.1),
        "closed"
    );

    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": ISSUE, "reset": true }),
    )
    .await;
    let (status, reply) = s
        .op(&b, &uuid(), json!({ "kind": "reopen", "issue": id }))
        .await;
    assert_eq!(status, 200, "{reply}");
    assert_eq!(s.fail_rules().await, json!([]));
    assert_eq!(
        state(&s.api(&mut b, &format!("/api/issues/{id}")).await.1),
        "open"
    );
}

/// Points the fake's webhooks at a listener of the test's own: the `issues` deliveries' actions,
/// in the order GitHub sent them.
async fn issue_actions(s: &Stack) -> std::sync::Arc<std::sync::Mutex<Vec<String>>> {
    let got = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = got.clone();
    let app = axum::Router::new().route(
        "/hook",
        axum::routing::post(
            move |headers: axum::http::HeaderMap, body: axum::body::Bytes| {
                let sink = sink.clone();
                async move {
                    if headers["x-github-event"] == "issues" {
                        let v: Value = serde_json::from_slice(&body).unwrap();
                        let action = v["action"].as_str().unwrap().to_owned();
                        sink.lock().unwrap().push(action);
                    }
                    "ok"
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hook", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    s.fake("PUT", "/webhooks", json!({ "url": url })).await;
    got
}

#[tokio::test(flavor = "multi_thread")]
async fn ops_on_one_issue_reach_github_in_the_order_they_arrived() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    let actions = issue_actions(&s).await;
    // GitHub is slow to take the close; the reopen arrives while it's in flight.
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": ISSUE, "ms": 1000, "count": 1 }),
    )
    .await;
    let close = {
        let (s, b) = (s.server.clone(), b.clone());
        let req = reqwest::Client::new()
            .post(format!("{s}/api/ops"))
            .header("cookie", b.header())
            .header("origin", &s)
            .json(&json!({
                "op_id": uuid(),
                "op": { "kind": "close", "issue": id, "reason": "completed" },
            }));
        tokio::spawn(async move { req.send().await.unwrap().status().as_u16() })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (status, reply) = s
        .op(&b, &uuid(), json!({ "kind": "reopen", "issue": id }))
        .await;
    assert_eq!(status, 200, "{reply}");
    assert_eq!(close.await.unwrap(), 200);

    let (_, d) = s.api(&mut b, &format!("/api/issues/{id}")).await;
    assert_eq!(d["state"], "open");
    tokio::time::sleep(2 * SECS).await;
    assert_eq!(*actions.lock().unwrap(), ["closed", "reopened"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn past_500_remembered_ops_the_oldest_done_one_is_forgotten_and_its_resend_is_lost() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    let op = json!({ "kind": "reopen", "issue": id });
    let ids: Vec<String> = (0..501).map(|_| uuid()).collect();
    for op_id in &ids {
        assert_eq!(s.op(&b, op_id, op.clone()).await.0, 200);
    }
    let (status, err) = s.resend(&b, &ids[0], op.clone()).await;
    assert_eq!(
        (status, err["error"].as_str()),
        (410, Some("lost")),
        "{err}"
    );
    for op_id in [&ids[1], &ids[500]] {
        assert_eq!(s.resend(&b, op_id, op.clone()).await.0, 200);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rate_limit_that_doesnt_say_for_how_long_waits_a_minute() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    let close = json!({ "kind": "close", "issue": id, "reason": "completed" });
    // A bare 429, and GitHub's secondary rate limit (a 403 saying so): GitHub's docs say to wait
    // at least a minute.
    s.fail(ISSUE, 429, 1, None).await;
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": ISSUE, "status": 403, "secondary_rate_limit": true }),
    )
    .await;
    for _ in 0..2 {
        let res = s.post_op(&b, Some(&s.server), &uuid(), &close).await;
        assert_eq!(res.status(), 429);
        assert_eq!(res.headers()["retry-after"], "60");
        let err: Value = res.json().await.unwrap();
        assert_eq!(err["error"], "rate_limited", "{err}");
    }
    let (_, d) = s.api(&mut b, &format!("/api/issues/{id}")).await;
    assert_eq!(d["state"], "open");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_conflict_from_github_fails_the_write_as_a_conflict() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    s.fail(ISSUE, 409, 1, None).await;
    let (status, err) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "close", "issue": id, "reason": "completed" }),
        )
        .await;
    assert_eq!(
        (status, err["error"].as_str()),
        (409, Some("conflict")),
        "{err}"
    );
    assert_eq!(s.fail_rules().await, json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refusal_rereads_the_repo_s_role_at_once_and_says_why_in_its_terms() {
    let s = start().await;
    let mut b = s.sign_in("ilze-k").await;
    let (id, _, repo) = someone_elses_issue_she_triages(&s, &mut b).await;
    assert_eq!(role_on(&s.api(&mut b, "/api/me").await.1, &repo), "triage");
    s.fake(
        "PUT",
        "/permissions",
        json!({ "login": "ilze-k", "repo": repo, "role": "read" }),
    )
    .await;

    let (status, err) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "close", "issue": id, "reason": "completed" }),
        )
        .await;
    assert_eq!(
        (status, err["error"].as_str()),
        (422, Some("refused")),
        "{err}"
    );
    // Just the reason: the tab says what couldn't be done.
    assert_eq!(
        err["message"],
        format!("you have Read on {repo}, which closes or reopens only issues you opened")
    );
    // The role was re-read before the reply: the next /api/me has it.
    assert_eq!(role_on(&s.api(&mut b, "/api/me").await.1, &repo), "read");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_write_github_still_answers_401_after_a_refresh_signs_the_user_out() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    // The token is refused, and so is the one the refresh brings.
    s.fail(ISSUE, 401, 2, None).await;
    let (status, err) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "close", "issue": id, "reason": "completed" }),
        )
        .await;
    assert_eq!(
        (status, err["error"].as_str()),
        (401, Some("signed_out")),
        "{err}"
    );
    assert_eq!(s.fail_rules().await, json!([]));
}

/// Signed in as ilze-k, who has Triage on the repos not named in her fixture roles: an open issue
/// someone else opened in one of them, and its owner and repo.
async fn someone_elses_issue_she_triages(s: &Stack, b: &mut Browser) -> (i64, String, String) {
    let (_, page) = s.api(b, "/api/issues").await;
    for r in page["rows"].as_array().unwrap() {
        let repo = r["repo"].as_str().unwrap();
        if ["web", "api", "mobile", "cli", "billing", "ops"].contains(&repo) {
            continue;
        }
        let id = r["id"].as_i64().unwrap();
        let (_, d) = s.api(b, &format!("/api/issues/{id}")).await;
        if d["author"]["login"] != "ilze-k" {
            let owner = r["owner"].as_str().unwrap().to_owned();
            return (id, owner, repo.to_owned());
        }
    }
    panic!("no open issue of someone else's in a repo she triages");
}

/// The account's role on `repo`, as `/api/me` has it.
fn role_on(me: &Value, repo: &str) -> Value {
    me["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == repo)
        .unwrap()["role"]
        .clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_403_on_a_write_the_role_allows_says_github_didnt_apply_it() {
    let s = start().await;
    // Admin everywhere.
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    s.fail(ISSUE, 403, 1, None).await;
    let (status, err) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "close", "issue": id, "reason": "completed" }),
        )
        .await;
    assert_eq!(
        (status, err["error"].as_str()),
        (422, Some("refused")),
        "{err}"
    );
    assert_eq!(err["message"], "GitHub didn't apply this change");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refusal_whose_repo_comes_back_without_permissions_says_the_role_may_not_allow_it() {
    let s = start().await;
    let mut b = s.sign_in("ilze-k").await;
    let (id, owner, repo) = someone_elses_issue_she_triages(&s, &mut b).await;
    s.fake(
        "PUT",
        "/permissions",
        json!({ "login": "ilze-k", "repo": repo, "role": "read" }),
    )
    .await;
    // GitHub's repo object, without the `permissions` it gives a user who can see the repo.
    s.fake(
        "POST",
        "/faults/rewrite",
        json!({
            "endpoint": format!("GET /repos/{owner}/{repo}"),
            "raw": json!({ "id": 1, "name": repo, "full_name": format!("{owner}/{repo}") }).to_string(),
        }),
    )
    .await;
    let (status, err) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "close", "issue": id, "reason": "completed" }),
        )
        .await;
    assert_eq!(
        (status, err["error"].as_str()),
        (422, Some("refused")),
        "{err}"
    );
    assert_eq!(
        err["message"],
        format!("your role on {repo} may not allow it")
    );
    // An unknown role isn't stored as Read.
    assert_eq!(role_on(&s.api(&mut b, "/api/me").await.1, &repo), "triage");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_role_reread_slower_than_the_reply_waits_for_is_still_stored() {
    let s = start().await;
    let mut b = s.sign_in("ilze-k").await;
    let (id, owner, repo) = someone_elses_issue_she_triages(&s, &mut b).await;
    s.fake(
        "PUT",
        "/permissions",
        json!({ "login": "ilze-k", "repo": repo, "role": "read" }),
    )
    .await;
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": format!("GET /repos/{owner}/{repo}"), "ms": 3000, "count": 1 }),
    )
    .await;
    let (status, err) = s
        .op(
            &b,
            &uuid(),
            json!({ "kind": "close", "issue": id, "reason": "completed" }),
        )
        .await;
    assert_eq!((status, err["error"].as_str()), (422, Some("refused")));
    assert_eq!(
        err["message"],
        format!("your role on {repo} may not allow it")
    );
    // The re-read carries on after the reply, and the next /api/me has its role.
    let t = Instant::now();
    while role_on(&s.api(&mut b, "/api/me").await.1, &repo) != "read" {
        assert!(t.elapsed() < 5 * SECS, "the re-read's role never arrived");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn sigterm_finishes_the_writes_in_flight_and_refuses_new_ones_before_it_stops() {
    let mut s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    let comment = |body: &str| json!({ "kind": "comment", "issue": id, "body": body });
    let mut stream = s.stream(&b).await;
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": COMMENTS, "ms": 1500, "count": 1 }),
    )
    .await;
    let op_id = uuid();
    let in_flight = {
        let req = s
            .http
            .post(format!("{}/api/ops", s.server))
            .header("cookie", b.header())
            .header("origin", &s.server)
            .json(&json!({ "op_id": op_id, "op": comment("In flight at SIGTERM") }));
        tokio::spawn(async move { req.send().await.map(|r| r.status().as_u16()) })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    let t = Instant::now();
    let stopped = s.sigterm();
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Not ready, and a new write is turned away to try again: beghu is going.
    let ready = s
        .http
        .get(format!("{}/readyz", s.server))
        .send()
        .await
        .unwrap();
    assert_eq!(ready.status(), 503);
    let res = s
        .post_op(&b, Some(&s.server), &uuid(), &comment("After SIGTERM"))
        .await;
    assert_eq!(res.status(), 503);
    assert!(res.headers().contains_key("retry-after"));
    let err: Value = res.json().await.unwrap();
    assert_eq!(err["error"], "unavailable", "{err}");
    // A resend of the write in flight isn't new: it joins it.
    let (status, reply) = s.resend(&b, &op_id, comment("In flight at SIGTERM")).await;
    assert_eq!(status, 200, "{reply}");

    // The write in flight finishes and its answer goes out; the streams close; then it stops.
    assert_eq!(in_flight.await.unwrap().unwrap(), 200);
    while stream.next_within(5 * SECS).await.is_some() {}
    tokio::time::timeout(5 * SECS, stopped)
        .await
        .expect("the server stopped")
        .unwrap()
        .unwrap();
    assert!(t.elapsed() < 10 * SECS, "{:?}", t.elapsed());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_sigterm_during_the_drain_stops_the_server_at_once() {
    let mut s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _) = an_open_issue(&s, &mut b).await;
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": COMMENTS, "ms": 5000, "count": 1 }),
    )
    .await;
    let req = s
        .http
        .post(format!("{}/api/ops", s.server))
        .header("cookie", b.header())
        .header("origin", &s.server)
        .json(
            &json!({ "op_id": uuid(), "op": { "kind": "comment", "issue": id, "body": "Slow" } }),
        );
    let _in_flight = tokio::spawn(async move { req.send().await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    let stopped = s.sigterm();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !stopped.is_finished(),
        "the drain waits for the write in flight"
    );

    let t = Instant::now();
    s.signal_again();
    tokio::time::timeout(SECS, stopped)
        .await
        .expect("stopped at once")
        .unwrap()
        .unwrap();
    assert!(t.elapsed() < SECS, "{:?}", t.elapsed());
}

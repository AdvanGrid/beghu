//! New issues: `POST /api/ops` with a `create` op, Fake GitHub behind it. The issue is in the
//! mirror (its id pushed) when the reply comes, so the tab opens it by its real id and lists find
//! it; GitHub's `issues.opened` for it adds nothing. A create is never sent twice, goes only into
//! a synced repo that isn't archived, and sends labels, assignees and a milestone only with
//! Triage; what GitHub silently leaves out comes back as the writes that would apply it.

mod common;

use common::{Browser, Stack, ids_of, start};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const SECS: Duration = Duration::from_secs(1);
const CREATE: &str = "POST /repos/*/*/issues";

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

/// A word no other issue has: titles are searched by the start of their words.
fn word() -> String {
    format!("zq{:x}", rand::random::<u64>())
}

impl Stack {
    /// `POST /api/ops` from `b`'s tab, as a first send (`resend: false`) or a resend; the status
    /// and the body.
    async fn send(&self, b: &Browser, op_id: &str, op: &Value, resend: bool) -> (u16, Value) {
        let res = self
            .api_write(b, reqwest::Method::POST, "/api/ops")
            .json(&json!({ "op_id": op_id, "op": op, "resend": resend }))
            .send()
            .await
            .unwrap();
        let status = res.status().as_u16();
        (status, res.json().await.unwrap_or(Value::Null))
    }

    /// The id of `b`'s synced repo `name`.
    async fn repo_id(&self, b: &mut Browser, name: &str) -> i64 {
        let (_, me) = self.api(b, "/api/me").await;
        me["repos"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["name"] == name)
            .unwrap_or_else(|| panic!("no synced repo {name}: {me}"))["id"]
            .as_i64()
            .unwrap()
    }

    /// The open issues whose title has `word`, as a list finds them.
    async fn listed(&self, b: &mut Browser, word: &str) -> Vec<i64> {
        let (status, page) = self
            .api(b, &format!("/api/issues?q=is%3Aopen+in%3Atitle+{word}"))
            .await;
        assert_eq!(status, 200, "{page}");
        page["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_i64().unwrap())
            .collect()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_issue_is_in_the_mirror_and_the_list_when_the_reply_comes_and_its_echo_adds_nothing()
{
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let web = s.repo_id(&mut b, "web").await;
    let (_, labels) = s.api(&mut b, &format!("/api/repos/{web}/labels")).await;
    let label = labels[0]["name"].as_str().unwrap().to_owned();
    let (_, milestones) = s.api(&mut b, &format!("/api/repos/{web}/milestones")).await;
    let milestone = milestones[0]["number"].as_i64().unwrap();
    let word = word();

    let (status, reply) = s
        .send(
            &b,
            &uuid(),
            &json!({
                "kind": "create", "repo": web, "title": format!("New {word}"), "body": "Made in **beghu**",
                "labels": [label], "assignees": ["tomsj"], "milestone": milestone,
            }),
            false,
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    assert!(reply.get("unapplied").is_none(), "{reply}");
    let id = reply["issue"].as_i64().unwrap();

    // In the mirror before the reply: its detail reads, a list finds it, and its id was pushed.
    let (status, d) = s.api(&mut b, &format!("/api/issues/{id}")).await;
    assert_eq!(status, 200, "{d}");
    assert_eq!(d["title"], format!("New {word}"));
    assert_eq!(d["repo"], "web");
    assert_eq!(d["state"], "open");
    assert_eq!(d["author"]["login"], "tomsj");
    assert_eq!(d["labels"][0]["name"], label.as_str());
    assert_eq!(d["assignees"][0]["login"], "tomsj");
    assert_eq!(d["milestone"]["number"], milestone);
    assert_eq!(
        d["body"],
        json!([["p", 0, "Made in ", ["strong", 0, "beghu"]]])
    );
    assert_eq!(s.listed(&mut b, &word).await, [id]);
    assert_eq!(ids_of(&st.event_within(SECS).await.unwrap()), [id]);

    // GitHub's issues.opened comes back about a second later: still the one issue, as it was.
    tokio::time::sleep(2 * SECS).await;
    assert_eq!(s.listed(&mut b, &word).await, [id]);
    let (_, again) = s.api(&mut b, &format!("/api/issues/{id}")).await;
    assert_eq!(again["updated_at"], d["updated_at"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_issue_is_never_sent_twice() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let web = s.repo_id(&mut b, "web").await;

    // A 5xx fails at once, after one call: GitHub may have made it, and the failure says so.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": CREATE, "status": 502, "count": 2 }),
    )
    .await;
    let failed = word();
    let op = json!({ "kind": "create", "repo": web, "title": failed, "body": "" });
    let (status, err) = s.send(&b, &uuid(), &op, false).await;
    assert_eq!(status, 410, "{err}");
    assert_eq!(err["error"], "lost");
    assert!(
        err["message"].as_str().unwrap().contains("check the list"),
        "{err}"
    );
    let state = s.fake("GET", "/state", Value::Null).await;
    assert_eq!(state["faults"]["fail"][0]["remaining"], 1, "{state}");
    s.fake("DELETE", "/faults", json!({})).await;

    // A resend of an op_id joins its create, or gets its outcome: one issue on GitHub.
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": CREATE, "ms": 1500 }),
    )
    .await;
    let word = word();
    let op = json!({ "kind": "create", "repo": web, "title": word, "body": "" });
    let op_id = uuid();
    let dropped = s
        .api_write(&b, reqwest::Method::POST, "/api/ops")
        .json(&json!({ "op_id": op_id, "op": op }))
        .timeout(Duration::from_millis(300))
        .send()
        .await;
    assert!(dropped.is_err(), "the client gave up first");
    let (status, first) = s.send(&b, &op_id, &op, true).await;
    assert_eq!(status, 200, "{first}");
    let t = Instant::now();
    let (status, again) = s.send(&b, &op_id, &op, true).await;
    assert_eq!(status, 200);
    assert!(t.elapsed() < SECS, "{:?}", t.elapsed());
    assert_eq!(again["issue"], first["issue"]);
    tokio::time::sleep(2 * SECS).await;
    assert_eq!(
        s.listed(&mut b, &word).await,
        [first["issue"].as_i64().unwrap()]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn read_sends_title_and_body_only_and_an_archived_repo_takes_no_new_issue() {
    let s = start().await;
    // Read on `cli`.
    let mut reader = s.sign_in("ilze-k").await;
    let cli = s.repo_id(&mut reader, "cli").await;
    let (_, labels) = s
        .api(&mut reader, &format!("/api/repos/{cli}/labels"))
        .await;
    let label = labels[0]["name"].clone();

    // Labels are refused before GitHub is asked; title and body alone are made.
    let (status, err) = s
        .send(
            &reader,
            &uuid(),
            &json!({ "kind": "create", "repo": cli, "title": "t", "body": "", "labels": [label] }),
            false,
        )
        .await;
    assert_eq!(status, 422, "{err}");
    assert_eq!(err["error"], "refused");
    assert_eq!(
        err["message"],
        "you have Read on cli, which can't set labels, assignees or a milestone"
    );
    let word = word();
    let (status, reply) = s
        .send(
            &reader,
            &uuid(),
            &json!({ "kind": "create", "repo": cli, "title": word, "body": "From a reader" }),
            false,
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    let (_, d) = s
        .api(&mut reader, &format!("/api/issues/{}", reply["issue"]))
        .await;
    assert_eq!(d["author"]["login"], "ilze-k");

    // A blank title is the tab's mistake, and a repo that isn't synced takes nothing.
    let (status, _) = s
        .send(
            &reader,
            &uuid(),
            &json!({ "kind": "create", "repo": cli, "title": "  ", "body": "" }),
            false,
        )
        .await;
    assert_eq!(status, 400);
    let (status, err) = s
        .send(
            &reader,
            &uuid(),
            &json!({ "kind": "create", "repo": 1, "title": "t", "body": "" }),
            false,
        )
        .await;
    assert_eq!(status, 422, "{err}");
    assert_eq!(err["message"], "This repo isn't synced");

    // Archived: read-only for everyone, owner included, without a call.
    let mut b = s.sign_in("tomsj").await;
    let web = s.repo_id(&mut b, "web").await;
    s.fake(
        "POST",
        "/archive",
        json!({ "repo": "web", "archived": true }),
    )
    .await;
    let deadline = Instant::now() + 5 * SECS;
    loop {
        let (_, me) = s.api(&mut b, "/api/me").await;
        let archived = me["repos"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == web && r["archived"] == true);
        if archived {
            break;
        }
        assert!(Instant::now() < deadline, "the archive never reached beghu");
        tokio::time::sleep(SECS / 10).await;
    }
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": CREATE, "status": 500, "count": 1 }),
    )
    .await;
    let (status, err) = s
        .send(
            &b,
            &uuid(),
            &json!({ "kind": "create", "repo": web, "title": "t", "body": "" }),
            false,
        )
        .await;
    assert_eq!(status, 422, "{err}");
    assert_eq!(err["message"], "web is archived, so it's read-only");
    let state = s.fake("GET", "/state", Value::Null).await;
    assert_eq!(
        state["faults"]["fail"][0]["remaining"], 1,
        "no call: {state}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_title_or_description_github_wont_take_is_refused_before_github_is_asked() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let web = s.repo_id(&mut b, "web").await;
    // Each refusal would use this up, had it gone to GitHub.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": CREATE, "status": 500, "count": 1 }),
    )
    .await;
    let long = "x".repeat(257);
    let refused = [
        (json!(" \t "), json!(""), "A new issue needs a title"),
        (
            json!(long),
            json!(""),
            "A title can be at most 256 characters long, as on GitHub",
        ),
        (
            json!("t"),
            json!("x".repeat(65_537)),
            "A description can be at most 65,536 characters long, as on GitHub",
        ),
    ];
    for (title, body, why) in refused {
        let op = json!({ "kind": "create", "repo": web, "title": title, "body": body });
        let (status, err) = s.send(&b, &uuid(), &op, false).await;
        assert_eq!(status, 400, "{err}");
        assert_eq!(err["message"], why);
    }
    let state = s.fake("GET", "/state", Value::Null).await;
    assert_eq!(
        state["faults"]["fail"][0]["remaining"], 1,
        "no call: {state}"
    );
    s.fake("DELETE", "/faults", json!({ "endpoint": CREATE }))
        .await;

    // 256 characters once trimmed is GitHub's limit: made, under the trimmed title.
    let title = format!("{}{}", word(), "y".repeat(256))
        .chars()
        .take(256)
        .collect::<String>();
    let (status, reply) = s
        .send(
            &b,
            &uuid(),
            &json!({ "kind": "create", "repo": web, "title": format!("  {title}  "), "body": "" }),
            false,
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    let (_, d) = s
        .api(&mut b, &format!("/api/issues/{}", reply["issue"]))
        .await;
    assert_eq!(d["title"], title.as_str());
}

#[tokio::test(flavor = "multi_thread")]
async fn what_github_silently_leaves_out_of_a_new_issue_comes_back_as_failed_writes_on_it() {
    let s = start().await;
    // Write on `web`, as the mirror has it; then an admin takes her down to Read.
    let mut b = s.sign_in("ilze-k").await;
    let web = s.repo_id(&mut b, "web").await;
    let (_, labels) = s.api(&mut b, &format!("/api/repos/{web}/labels")).await;
    let label = labels[0]["name"].as_str().unwrap().to_owned();
    s.fake(
        "PUT",
        "/permissions",
        json!({ "login": "ilze-k", "repo": "web", "role": "read" }),
    )
    .await;

    let word = word();
    let (status, reply) = s
        .send(
            &b,
            &uuid(),
            &json!({ "kind": "create", "repo": web, "title": word, "body": "", "labels": [label] }),
            false,
        )
        .await;
    // Made all the same: the issue is there.
    assert_eq!(status, 200, "{reply}");
    let id = reply["issue"].as_i64().unwrap();
    assert_eq!(s.listed(&mut b, &word).await, [id]);
    assert_eq!(
        reply["unapplied"]["ops"],
        json!([{ "kind": "label_add", "issue": id, "label": label }])
    );
    assert_eq!(reply["unapplied"]["why"], "you have Read on web");
    // The role was read again, for the next write and the next /api/me.
    let (_, me) = s.api(&mut b, "/api/me").await;
    let role = me["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == web)
        .unwrap()["role"]
        .clone();
    assert_eq!(role, "read");
}

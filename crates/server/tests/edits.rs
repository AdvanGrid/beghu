//! Title and body edits: `POST /api/ops` with `title_edit` or `body_edit`, each carrying `base`,
//! the text its editor opened with. The server reads the issue from GitHub first, conditionally on
//! the `ETag` it last got for it, right before each patch attempt, and patches only if the field
//! is still `base`; a field that is the edit's text already is done, and any other answers 409
//! with GitHub's text and patches nothing. Driven against Fake GitHub, with outside
//! edits through its control port.

mod common;

use common::{Browser, Stack, ids_of, start};
use serde_json::{Value, json};
use std::time::Duration;

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
    /// `POST /api/ops` from `b`'s tab with a fresh op id; the status and the body.
    async fn op(&self, b: &Browser, op: Value) -> (u16, Value) {
        let res = self
            .api_write(b, reqwest::Method::POST, "/api/ops")
            .json(&json!({ "op_id": uuid(), "op": op }))
            .send()
            .await
            .unwrap();
        let status = res.status().as_u16();
        (status, res.json().await.unwrap_or(Value::Null))
    }

    /// What Fake GitHub has answered with 304 so far, and the core quota every user token has
    /// spent: a 304 spends none.
    async fn spent(&self) -> (u64, u64) {
        let st = self.fake("GET", "/state", Value::Null).await;
        let used = st["quota"]["used"]
            .as_object()
            .unwrap()
            .iter()
            .filter(|(k, _)| k.starts_with("user:") && k.ends_with(" core"))
            .map(|(_, v)| v.as_u64().unwrap())
            .sum();
        (st["not_modified"].as_u64().unwrap(), used)
    }
}

/// An open issue at the top of `b`'s list: its id, repo and number.
async fn an_issue(s: &Stack, b: &mut Browser) -> (i64, String, i64) {
    let (_, page) = s.api(b, "/api/issues").await;
    let r = &page["rows"][0];
    (
        r["id"].as_i64().unwrap(),
        format!(
            "{}/{}",
            r["owner"].as_str().unwrap(),
            r["repo"].as_str().unwrap()
        ),
        r["number"].as_i64().unwrap(),
    )
}

async fn detail(s: &Stack, b: &mut Browser, id: i64) -> Value {
    let (status, d) = s.api(b, &format!("/api/issues/{id}")).await;
    assert_eq!(status, 200, "{d}");
    d
}

async fn source(s: &Stack, b: &mut Browser, id: i64) -> Value {
    let (status, src) = s.api(b, &format!("/api/issues/{id}/source")).await;
    assert_eq!(status, 200, "{src}");
    src
}

#[tokio::test(flavor = "multi_thread")]
async fn an_outside_edit_after_the_editor_opened_is_a_409_with_github_s_title_and_nothing_is_patched()
 {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, repo, number) = an_issue(&s, &mut b).await;
    let opened_with = detail(&s, &mut b, id).await["title"].clone();
    s.edit(json!({ "repo": repo, "number": number, "as": "ilze-k", "title": "Theirs" }))
        .await;

    let (status, err) = s
        .op(
            &b,
            json!({ "kind": "title_edit", "issue": id, "new": "Mine", "base": opened_with }),
        )
        .await;
    assert_eq!(
        (status, err["error"].as_str()),
        (409, Some("changed")),
        "{err}"
    );
    assert_eq!(err["current"], "Theirs");
    assert_eq!(
        err["message"],
        "Changed on GitHub since you started editing"
    );
    // Nothing was patched, and the mirror has GitHub's title already: a detail read now shows it.
    assert_eq!(detail(&s, &mut b, id).await["title"], "Theirs");
}

#[tokio::test(flavor = "multi_thread")]
async fn overwriting_with_the_new_base_costs_a_304_and_the_patch() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let (id, repo, number) = an_issue(&s, &mut b).await;
    let opened_with = detail(&s, &mut b, id).await["title"].clone();
    s.edit(json!({ "repo": repo, "number": number, "as": "ilze-k", "title": "Theirs" }))
        .await;
    let (status, err) = s
        .op(
            &b,
            json!({ "kind": "title_edit", "issue": id, "new": "Mine", "base": opened_with }),
        )
        .await;
    assert_eq!(status, 409, "{err}");
    // The check wrote GitHub's title to the mirror, which pushed the issue to the tab.
    assert_eq!(ids_of(&st.event_within(SECS).await.unwrap()), [id]);
    // The outside edit's own webhook lands meanwhile: nothing about the issue changes on GitHub.
    tokio::time::sleep(2 * SECS).await;

    // "Overwrite with mine": the same text, over GitHub's title.
    let before = s.spent().await;
    let (status, reply) = s
        .op(
            &b,
            json!({ "kind": "title_edit", "issue": id, "new": "Mine", "base": err["current"] }),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    let after = s.spent().await;
    // GitHub's issue hadn't changed since the check: a 304, which costs nothing, then the patch.
    assert_eq!((after.0 - before.0, after.1 - before.1), (1, 1));
    assert_eq!(detail(&s, &mut b, id).await["title"], "Mine");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_edit_over_an_unchanged_body_is_made_and_answers_with_the_body_rendered() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _, _) = an_issue(&s, &mut b).await;
    let src = source(&s, &mut b, id).await;
    // The editor's text and the detail's body are the same body.
    assert_eq!(
        src["body_digest"],
        detail(&s, &mut b, id).await["body_digest"]
    );

    let (status, reply) = s
        .op(
            &b,
            json!({ "kind": "body_edit", "issue": id, "new": "Edited in **beghu**", "base": src["body"] }),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    assert_eq!(
        reply["body"],
        json!([["p", 0, "Edited in ", ["strong", 0, "beghu"]]])
    );
    let now = source(&s, &mut b, id).await;
    assert_eq!(now["body"], "Edited in **beghu**");
    assert_eq!(
        now["body_digest"],
        detail(&s, &mut b, id).await["body_digest"]
    );
    assert_ne!(now["body_digest"], src["body_digest"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_outside_body_edit_is_a_409_with_github_s_body() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, repo, number) = an_issue(&s, &mut b).await;
    let src = source(&s, &mut b, id).await;
    s.edit(json!({ "repo": repo, "number": number, "as": "ilze-k", "body": "Their words" }))
        .await;

    let (status, err) = s
        .op(
            &b,
            json!({ "kind": "body_edit", "issue": id, "new": "My words", "base": src["body"] }),
        )
        .await;
    assert_eq!(
        (status, &err["current"]),
        (409, &json!("Their words")),
        "{err}"
    );
    let now = source(&s, &mut b, id).await;
    assert_eq!(now["body"], "Their words");
    // Its digest, as the detail will carry it: the editor tells a later change by it.
    assert_eq!(err["digest"], now["body_digest"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_that_differs_from_base_only_in_line_ends_is_unchanged() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, repo, number) = an_issue(&s, &mut b).await;
    // Saved from GitHub's web editor, with a browser's line ends.
    s.edit(json!({ "repo": repo, "number": number, "body": "one\r\ntwo" }))
        .await;
    // A textarea gives `\n`.
    let (status, reply) = s
        .op(
            &b,
            json!({ "kind": "body_edit", "issue": id, "new": "one\ntwo\nthree", "base": "one\ntwo" }),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_title_edit_triage_doesnt_allow_on_someone_else_s_issue_is_refused_in_its_terms() {
    let s = start().await;
    let mut b = s.sign_in("ilze-k").await;
    // ilze-k has Triage on the repos her fixture roles don't name (see ops.rs).
    let (_, page) = s.api(&mut b, "/api/issues").await;
    let (id, repo, title) = page["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| {
            !["web", "api", "mobile", "cli", "billing", "ops"]
                .contains(&r["repo"].as_str().unwrap())
        })
        .map(|r| {
            (
                r["id"].as_i64().unwrap(),
                r["repo"].as_str().unwrap().to_owned(),
                r["title"].clone(),
            )
        })
        .find(|_| true)
        .unwrap();
    let d = detail(&s, &mut b, id).await;
    assert_ne!(d["author"]["login"], "ilze-k");

    let (status, err) = s
        .op(
            &b,
            json!({ "kind": "title_edit", "issue": id, "new": "Renamed", "base": title }),
        )
        .await;
    assert_eq!(
        (status, err["error"].as_str()),
        (422, Some("refused")),
        "{err}"
    );
    assert_eq!(
        err["message"],
        format!("you have Triage on {repo}, which edits only issues you opened")
    );
    assert_eq!(detail(&s, &mut b, id).await["title"], title);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_blank_or_overlong_title_and_an_overlong_body_are_refused_before_github_is_called() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _, _) = an_issue(&s, &mut b).await;
    let before = s.spent().await;
    for (op, why) in [
        (
            json!({ "kind": "title_edit", "issue": id, "new": "  ", "base": "x" }),
            "A title can't be empty",
        ),
        (
            json!({ "kind": "title_edit", "issue": id, "new": "t".repeat(257), "base": "x" }),
            "A title can be at most 256 characters long, as on GitHub",
        ),
        (
            json!({ "kind": "body_edit", "issue": id, "new": "b".repeat(65_537), "base": "x" }),
            "A description can be at most 65,536 characters long, as on GitHub",
        ),
    ] {
        let (status, err) = s.op(&b, op).await;
        assert_eq!((status, err["message"].as_str()), (400, Some(why)), "{err}");
    }
    assert_eq!(s.spent().await, before);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_edit_github_has_already_is_done_without_a_patch() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, repo, number) = an_issue(&s, &mut b).await;
    let opened_with = detail(&s, &mut b, id).await["title"].clone();
    // The edit reached GitHub, but the tab lost track of it: GitHub has "Mine" now.
    s.edit(json!({ "repo": repo, "number": number, "title": "Mine" }))
        .await;

    // Sent again, over the title the editor opened with.
    let before = s.spent().await;
    let (status, reply) = s
        .op(
            &b,
            json!({ "kind": "title_edit", "issue": id, "new": "Mine", "base": opened_with }),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    let after = s.spent().await;
    // The check, and no patch.
    assert_eq!((after.0 - before.0, after.1 - before.1), (0, 1));
    assert_eq!(detail(&s, &mut b, id).await["title"], "Mine");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_edit_github_has_already_answers_with_github_s_body_rendered() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, repo, number) = an_issue(&s, &mut b).await;
    let src = source(&s, &mut b, id).await;
    s.edit(json!({ "repo": repo, "number": number, "body": "Mine, **sent**" }))
        .await;

    let (status, reply) = s
        .op(
            &b,
            json!({ "kind": "body_edit", "issue": id, "new": "Mine, **sent**", "base": src["body"] }),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    assert_eq!(
        reply["body"],
        json!([["p", 0, "Mine, ", ["strong", 0, "sent"]]])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_patch_tried_again_after_a_5xx_checks_again_and_a_change_meanwhile_is_a_409() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, repo, number) = an_issue(&s, &mut b).await;
    let opened_with = detail(&s, &mut b, id).await["title"].clone();
    let patch = format!("PATCH /repos/{repo}/issues/{number}");
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": patch, "count": 1, "status": 502 }),
    )
    .await;

    let op = s.op(
        &b,
        json!({ "kind": "title_edit", "issue": id, "new": "Mine", "base": opened_with }),
    );
    let meanwhile = async {
        // The first patch failed: the server waits a second before it tries again.
        let deadline = tokio::time::Instant::now() + 5 * SECS;
        loop {
            let st = s.fake("GET", "/state", Value::Null).await;
            if st["faults"]["fail"].as_array().unwrap().is_empty() {
                break;
            }
            assert!(tokio::time::Instant::now() < deadline, "no patch was made");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // Meanwhile someone else changes the title.
        s.edit(json!({ "repo": repo, "number": number, "as": "ilze-k", "title": "Theirs" }))
            .await;
    };
    let ((status, err), ()) = tokio::join!(op, meanwhile);
    assert_eq!(
        (status, err["error"].as_str(), err["current"].as_str()),
        (409, Some("changed"), Some("Theirs")),
        "{err}"
    );
    assert_eq!(detail(&s, &mut b, id).await["title"], "Theirs");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_check_of_an_edit_after_one_of_the_tab_s_own_is_a_304() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let (id, _, _) = an_issue(&s, &mut b).await;
    let opened_with = detail(&s, &mut b, id).await["title"].clone();
    let (status, reply) = s
        .op(
            &b,
            json!({ "kind": "title_edit", "issue": id, "new": "First", "base": opened_with }),
        )
        .await;
    assert_eq!(status, 200, "{reply}");

    let before = s.spent().await;
    let (status, reply) = s
        .op(
            &b,
            json!({ "kind": "title_edit", "issue": id, "new": "Second", "base": "First" }),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    let after = s.spent().await;
    // The patch's answer said what GitHub has: the check is a free 304, then the patch.
    assert_eq!((after.0 - before.0, after.1 - before.1), (1, 1));
    assert_eq!(detail(&s, &mut b, id).await["title"], "Second");
}

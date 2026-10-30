//! Relationship writes: `POST /api/ops`'s `sub_add`, `sub_remove`, `sub_reorder`, `block_add`,
//! `block_remove`, `relate_add` and `relate_remove`, with Fake GitHub behind them, and the
//! picker that offers what to relate (`GET /api/issues/{id}/relatable`). A relationship shows on
//! both ends as the reply comes; what GitHub would refuse is refused first, with a reason and no
//! call; one into a repo beghu doesn't sync has a stub at its other end; ops on related issues
//! take turns on both ends; and a create with a parent makes it the new issue's parent.

mod common;

use common::{
    Browser, Issue, Stack, end, full_parent_fixture, ids_of, start, start_on, summary, unlinked,
    until, uuid,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

/// `POST /api/ops` from `b`'s tab with a fresh op id, as the web app sends it.
fn post_op(s: &Stack, b: &Browser, op: Value) -> reqwest::RequestBuilder {
    s.api_write(b, reqwest::Method::POST, "/api/ops")
        .json(&json!({ "op_id": uuid(), "op": op }))
}

/// What a request for an op answered: the status and the body.
async fn answer(req: reqwest::RequestBuilder) -> (u16, Value) {
    let res = req.send().await.unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

async fn op(s: &Stack, b: &Browser, op: Value) -> (u16, Value) {
    answer(post_op(s, b, op)).await
}

/// An op that must go through.
async fn ok(s: &Stack, b: &Browser, o: Value) {
    let (status, body) = op(s, b, o.clone()).await;
    assert_eq!(status, 200, "{o} → {body}");
}

async fn detail(s: &Stack, b: &Browser, id: i64) -> Value {
    let (status, d) = s.api(&mut b.clone(), &format!("/api/issues/{id}")).await;
    assert_eq!(status, 200, "{d}");
    d
}

/// The ids in one of `id`'s detail's relationship lists, in its order.
async fn rel(s: &Stack, b: &Browser, id: i64, list: &str) -> Vec<i64> {
    detail(s, b, id).await["relationships"][list]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect()
}

async fn parent(s: &Stack, b: &Browser, id: i64) -> Option<i64> {
    detail(s, b, id).await["relationships"]["parent"]["id"].as_i64()
}

/// The picker's offers for issue `id`.
async fn relatable(s: &Stack, b: &Browser, id: i64, kind: &str, q: &str) -> Vec<Value> {
    let q: String = q
        .bytes()
        .map(|c| match c {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' => (c as char).to_string(),
            _ => format!("%{c:02X}"),
        })
        .collect();
    let (status, got) = s
        .api(
            &mut b.clone(),
            &format!("/api/issues/{id}/relatable?kind={kind}&q={q}"),
        )
        .await;
    assert_eq!(status, 200, "{got}");
    got.as_array().unwrap().clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn each_relationship_kind_is_added_and_removed_same_repo_and_across_and_shows_on_both_ends() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let mut st = s.stream(&b).await;
    st.reset().await;
    let web = unlinked("web");
    let api = unlinked("api");
    let id = |u: &Issue| u.2;

    // A dependency across repos: one push names both ends, and both details show it as the
    // reply comes.
    ok(
        &s,
        &b,
        json!({ "kind": "block_add", "issue": id(&web[2]), "other": end(&api[1]), "blocking": false }),
    )
    .await;
    let ids = ids_of(&st.event_within(Duration::from_secs(3)).await.unwrap());
    assert!(
        ids.contains(&id(&web[2])) && ids.contains(&id(&api[1])),
        "{ids:?}"
    );
    // The rest: blocking within a repo, sub-issues and relates-to both ways.
    for o in [
        json!({ "kind": "block_add", "issue": id(&web[2]), "other": end(&web[3]), "blocking": true }),
        json!({ "kind": "sub_add", "issue": id(&web[0]), "child": end(&web[1]), "replace_parent": false, "after": null }),
        json!({ "kind": "sub_add", "issue": id(&web[0]), "child": end(&api[0]), "replace_parent": false, "after": null }),
        json!({ "kind": "relate_add", "issue": id(&web[4]), "other": end(&web[5]) }),
        json!({ "kind": "relate_add", "issue": id(&web[4]), "other": end(&api[2]) }),
    ] {
        ok(&s, &b, o).await;
    }
    assert_eq!(rel(&s, &b, id(&web[2]), "blocked_by").await, [id(&api[1])]);
    assert_eq!(rel(&s, &b, id(&api[1]), "blocking").await, [id(&web[2])]);
    assert_eq!(rel(&s, &b, id(&web[2]), "blocking").await, [id(&web[3])]);
    assert_eq!(rel(&s, &b, id(&web[3]), "blocked_by").await, [id(&web[2])]);
    assert_eq!(
        rel(&s, &b, id(&web[0]), "sub_issues").await,
        [id(&web[1]), id(&api[0])]
    );
    assert_eq!(parent(&s, &b, id(&web[1])).await, Some(id(&web[0])));
    assert_eq!(parent(&s, &b, id(&api[0])).await, Some(id(&web[0])));
    let mut related = vec![id(&web[5]), id(&api[2])];
    related.sort_unstable();
    assert_eq!(rel(&s, &b, id(&web[4]), "relates_to").await, related);
    assert_eq!(rel(&s, &b, id(&web[5]), "relates_to").await, [id(&web[4])]);
    assert_eq!(rel(&s, &b, id(&api[2]), "relates_to").await, [id(&web[4])]);

    // And removed again, each from either end where GitHub lets it be.
    for o in [
        json!({ "kind": "block_remove", "issue": id(&api[1]), "other": end(&web[2]), "blocking": true }),
        json!({ "kind": "block_remove", "issue": id(&web[3]), "other": end(&web[2]), "blocking": false }),
        json!({ "kind": "sub_remove", "issue": id(&web[0]), "child": end(&web[1]) }),
        json!({ "kind": "sub_remove", "issue": id(&web[0]), "child": end(&api[0]) }),
        json!({ "kind": "relate_remove", "issue": id(&web[5]), "other": end(&web[4]) }),
        json!({ "kind": "relate_remove", "issue": id(&api[2]), "other": end(&web[4]) }),
    ] {
        ok(&s, &b, o).await;
    }
    for u in [
        &web[0], &web[1], &web[2], &web[3], &web[4], &web[5], &api[0], &api[1], &api[2],
    ] {
        let r = &detail(&s, &b, id(u)).await["relationships"];
        assert_eq!(
            r,
            &json!({ "parent": null, "sub_issues": [], "blocked_by": [], "blocking": [], "relates_to": [] }),
            "{u:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pasted_issue_url_of_an_unsynced_repo_relates_a_stub_and_the_picker_finds_by_number_or_title()
 {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let api = unlinked("api");
    // A partner-sdk issue no relationship reaches: no mirror holds it.
    let n = summary()["unlinked_stubs"][0].as_i64().unwrap();
    let me = web[0].2;

    let url = format!("https://github.com/acme/partner-sdk/issues/{n}");
    let got = relatable(&s, &b, me, "relates", &url).await;
    assert_eq!(got.len(), 1, "{got:?}");
    let stub = &got[0];
    assert_eq!(
        (
            &stub["repo"],
            &stub["number"],
            &stub["stub"],
            &stub["why_not"]
        ),
        (&json!("partner-sdk"), &json!(n), &json!(true), &Value::Null)
    );
    let title = stub["title"].as_str().unwrap().to_owned();
    // `repo#n` names it too, and so does its URL on www.github.com.
    assert_eq!(
        relatable(&s, &b, me, "relates", &format!("partner-sdk#{n}")).await,
        got
    );
    let www = format!("https://www.github.com/acme/partner-sdk/issues/{n}");
    assert_eq!(relatable(&s, &b, me, "relates", &www).await, got);
    // A place that isn't a repo's name is only words: GitHub isn't asked about it.
    for q in [format!("../partner-sdk#{n}"), format!("acme/..#{n}")] {
        assert_eq!(
            relatable(&s, &b, me, "relates", &q).await,
            Vec::<Value>::new(),
            "{q}"
        );
    }

    // Linked by its place alone, as the picker offers it.
    ok(
        &s,
        &b,
        json!({ "kind": "relate_add", "issue": me,
                "other": { "id": null, "owner": "acme", "repo": "partner-sdk", "number": n } }),
    )
    .await;
    let d = detail(&s, &b, me).await;
    let r = &d["relationships"]["relates_to"];
    assert_eq!(r.as_array().unwrap().len(), 1, "{r}");
    assert_eq!(
        (
            &r[0]["repo"],
            &r[0]["number"],
            &r[0]["stub"],
            &r[0]["title"]
        ),
        (
            &json!("partner-sdk"),
            &json!(n),
            &json!(true),
            &json!(title)
        )
    );
    let stub_id = r[0]["id"].as_i64().unwrap();
    assert_eq!(Some(stub_id), stub["id"].as_i64());
    // The picker now says it's linked.
    let again = relatable(&s, &b, me, "relates", &url).await;
    assert_eq!(again[0]["why_not"], "Already linked");

    ok(
        &s,
        &b,
        json!({ "kind": "relate_remove", "issue": me,
                "other": { "id": stub_id, "owner": "acme", "repo": "partner-sdk", "number": n } }),
    )
    .await;
    assert_eq!(rel(&s, &b, me, "relates_to").await, Vec::<i64>::new());

    // A synced issue by `#n`, `repo#n` or title words, its own repo first.
    let mine = &relatable(&s, &b, me, "blocked_by", &format!("#{}", web[1].1)).await;
    assert_eq!(
        (&mine[0]["id"], &mine[0]["stub"]),
        (&json!(web[1].2), &json!(false))
    );
    let theirs = &relatable(&s, &b, me, "blocked_by", &format!("api#{}", api[0].1)).await;
    assert_eq!(theirs[0]["id"], api[0].2);
    let title = detail(&s, &b, web[1].2).await["title"]
        .as_str()
        .unwrap()
        .to_owned();
    let words: String = title
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ");
    let found = relatable(&s, &b, me, "blocked_by", &words).await;
    assert!(
        found.iter().any(|c| c["id"] == web[1].2),
        "{words}: {found:?}"
    );
    let repos: Vec<&str> = found.iter().map(|c| c["repo"].as_str().unwrap()).collect();
    let first_other = repos
        .iter()
        .position(|r| *r != "web")
        .unwrap_or(repos.len());
    assert!(
        repos[first_other..].iter().all(|r| *r != "web"),
        "web's first: {repos:?}"
    );
    // Itself is never linkable.
    let itself = relatable(&s, &b, me, "relates", &format!("#{}", web[0].1)).await;
    assert_eq!(itself[0]["why_not"], "An issue can't be linked to itself");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reorder_sends_after_id_and_a_move_to_another_parent_replaces_it_then_reorders() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    // ilze-k (Write on web) only reads: her mirror hears of no reorder, so what she sees once
    // she opens a parent (which reads its order back) is GitHub's.
    let ilze = s.sign_in("ilze-k").await;
    let web = unlinked("web");
    let (p, q) = (web[0].2, web[4].2);
    let (a, bb, c) = (&web[1], &web[2], &web[3]);
    let (x, y) = (&web[5], &web[6]);
    for (parent, child) in [(p, a), (p, bb), (p, c), (q, x), (q, y)] {
        ok(
            &s,
            &b,
            json!({ "kind": "sub_add", "issue": parent, "child": end(child), "replace_parent": false, "after": null }),
        )
        .await;
    }

    // [a, b, c] → a after c → [b, c, a] → c to the top → [c, b, a]. (Had the first not been
    // made, the second would leave [c, a, b].)
    ok(
        &s,
        &b,
        json!({ "kind": "sub_reorder", "issue": p, "child": a.2, "after": c.2 }),
    )
    .await;
    ok(
        &s,
        &b,
        json!({ "kind": "sub_reorder", "issue": p, "child": c.2, "after": null }),
    )
    .await;
    let want = [c.2, bb.2, a.2];
    until(10.0, "GitHub's order", || async {
        (rel(&s, &ilze, p, "sub_issues").await == want).then_some(())
    })
    .await;
    assert_eq!(rel(&s, &b, p, "sub_issues").await, want);

    // A reorder to where it is already makes no call.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "PATCH /repos/*/*/issues/*/sub_issues/priority", "status": 500, "count": 1 }),
    )
    .await;
    ok(
        &s,
        &b,
        json!({ "kind": "sub_reorder", "issue": p, "child": bb.2, "after": c.2 }),
    )
    .await;
    s.fake("DELETE", "/faults", json!({})).await;

    // b moves to q, after x: replace_parent, then a reorder. It's under q only, between x and y.
    ok(
        &s,
        &b,
        json!({ "kind": "sub_add", "issue": q, "child": end(bb), "replace_parent": true, "after": x.2 }),
    )
    .await;
    assert_eq!(rel(&s, &b, q, "sub_issues").await, [x.2, bb.2, y.2]);
    assert_eq!(rel(&s, &b, p, "sub_issues").await, [c.2, a.2]);
    assert_eq!(parent(&s, &b, bb.2).await, Some(q));
    until(10.0, "GitHub's order under the new parent", || async {
        (rel(&s, &ilze, q, "sub_issues").await == [x.2, bb.2, y.2]).then_some(())
    })
    .await;
    until(10.0, "the old parent without it", || async {
        (rel(&s, &ilze, p, "sub_issues").await == [c.2, a.2]).then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn loops_nesting_past_8_levels_and_a_101st_child_are_refused_with_a_reason_and_no_call() {
    let s = start_on(full_parent_fixture(), |_| {}).await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let api = unlinked("api");
    // web's issue with 100 sub-issues: a row whose progress counts at least that many.
    let full = {
        let mut path = "/api/issues?q=repo:web".to_owned();
        loop {
            let (_, page) = s.api(&mut b.clone(), &path).await;
            let rows = page["rows"].as_array().unwrap();
            let mut found = None;
            for r in rows {
                if r["progress"]["total"].as_i64().unwrap_or(0) >= 100 {
                    let id = r["id"].as_i64().unwrap();
                    if rel(&s, &b, id, "sub_issues").await.len() == 100 {
                        found = Some(id);
                        break;
                    }
                }
            }
            if let Some(id) = found {
                break id;
            }
            let next = page["next"].as_str().expect("a parent with 100 sub-issues");
            path = format!("/api/issues?q=repo:web&after={next}");
        }
    };
    // web#0 > web#1 > … > web#7 (8 levels), and web#0 blocked by api#1, made on GitHub.
    for w in web[..8].windows(2) {
        s.edit(
            json!({ "repo": "web", "number": w[0].1, "add_sub_issue": format!("web#{}", w[1].1) }),
        )
        .await;
    }
    s.edit(
        json!({ "repo": "web", "number": web[0].1, "add_blocked_by": format!("api#{}", api[1].1) }),
    )
    .await;
    until(10.0, "the chain in the mirror", || async {
        let mut all = true;
        for w in web[..8].windows(2) {
            all &= parent(&s, &b, w[1].2).await == Some(w[0].2);
        }
        all &= rel(&s, &b, web[0].2, "blocked_by").await == [api[1].2];
        all.then_some(())
    })
    .await;

    // Any call these made would fail.
    let rules = [
        "POST /repos/*/*/issues/*/sub_issues",
        "POST /repos/*/*/issues/*/dependencies/blocked_by",
        "POST /repos/*/*/issues/*/relates_to",
    ];
    for endpoint in rules {
        s.fake(
            "POST",
            "/faults/fail",
            json!({ "endpoint": endpoint, "status": 500, "count": 1 }),
        )
        .await;
    }
    let sub = |parent: i64, child: &Issue| json!({ "kind": "sub_add", "issue": parent, "child": end(child), "replace_parent": false, "after": null });
    for (o, why) in [
        (
            sub(full, &api[0]),
            "An issue can have at most 100 sub-issues",
        ),
        (
            sub(web[7].2, &web[0]),
            "That would make a loop of sub-issues",
        ),
        (
            sub(web[7].2, &api[0]),
            "Sub-issues nest at most 8 levels deep",
        ),
        (
            json!({ "kind": "block_add", "issue": api[1].2, "other": end(&web[0]), "blocking": false }),
            "That would make a loop of dependencies",
        ),
        (
            json!({ "kind": "relate_add", "issue": web[0].2, "other": end(&web[0]) }),
            "An issue can't be linked to itself",
        ),
        (sub(web[2].2, &web[5]), "Already a sub-issue of web#"),
    ] {
        let (status, body) = op(&s, &b, o.clone()).await;
        assert_eq!(status, 400, "{o} → {body}");
        assert!(
            body["message"].as_str().unwrap().starts_with(why),
            "{o} → {body}"
        );
    }
    let left = s.fake("GET", "/state", Value::Null).await["faults"]["fail"].clone();
    assert_eq!(left.as_array().unwrap().len(), 3, "a call was made: {left}");
    s.fake("DELETE", "/faults", json!({})).await;

    // The picker says the same beside each issue.
    let got = relatable(&s, &b, web[7].2, "sub", &format!("api#{}", api[0].1)).await;
    assert_eq!(got[0]["why_not"], "Sub-issues nest at most 8 levels deep");
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_a_relationship_that_isnt_there_succeeds_and_adding_one_github_already_has_too() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let (a, c) = (&web[0], &web[1]);
    for o in [
        json!({ "kind": "sub_remove", "issue": a.2, "child": end(c) }),
        json!({ "kind": "block_remove", "issue": a.2, "other": end(c), "blocking": true }),
        json!({ "kind": "relate_remove", "issue": a.2, "other": end(c) }),
    ] {
        ok(&s, &b, o).await;
    }

    // GitHub has a link the mirror never heard of (its delivery was lost): adding it is done.
    s.fake("POST", "/faults/webhooks", json!({ "drop": 1 }))
        .await;
    s.edit(json!({ "repo": "web", "number": a.1, "add_relates_to": format!("web#{}", c.1) }))
        .await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(rel(&s, &b, a.2, "relates_to").await, Vec::<i64>::new());
    ok(
        &s,
        &b,
        json!({ "kind": "relate_add", "issue": a.2, "other": end(c) }),
    )
    .await;
    assert_eq!(rel(&s, &b, a.2, "relates_to").await, [c.2]);
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_ops_on_two_linked_issues_never_deadlock() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let (a, c, d) = (&web[0], &web[1], &web[2]);
    // Slow enough that every op is in flight at once.
    s.fake(
        "POST",
        "/faults/latency",
        json!({ "endpoint": "/repos/*/*/issues/*/*", "ms": 300 }),
    )
    .await;
    let ops = [
        json!({ "kind": "relate_add", "issue": a.2, "other": end(c) }),
        json!({ "kind": "relate_add", "issue": c.2, "other": end(d) }),
        json!({ "kind": "block_add", "issue": c.2, "other": end(a), "blocking": true }),
        json!({ "kind": "block_add", "issue": d.2, "other": end(a), "blocking": false }),
        json!({ "kind": "sub_add", "issue": d.2, "child": end(c), "replace_parent": false, "after": null }),
        json!({ "kind": "label_add", "issue": a.2, "label": "bug" }),
        json!({ "kind": "label_add", "issue": c.2, "label": "bug" }),
        json!({ "kind": "relate_remove", "issue": d.2, "other": end(c) }),
    ];
    let started = Instant::now();
    let tasks: Vec<_> = ops
        .into_iter()
        .map(|o| tokio::spawn(answer(post_op(&s, &b, o))))
        .collect();
    for t in tasks {
        let (status, body) = tokio::time::timeout(Duration::from_secs(30), t)
            .await
            .expect("every op answers")
            .unwrap();
        assert_eq!(status, 200, "{body}");
    }
    assert!(started.elapsed() < Duration::from_secs(30));
    s.fake("DELETE", "/faults", json!({})).await;
    assert_eq!(rel(&s, &b, c.2, "blocking").await, [a.2]);
    assert_eq!(rel(&s, &b, a.2, "blocked_by").await, [c.2]);
    assert_eq!(rel(&s, &b, a.2, "blocking").await, [d.2]);
    assert_eq!(parent(&s, &b, c.2).await, Some(d.2));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_move_whose_reorder_fails_is_made_and_its_reorder_comes_back_to_retry() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let (p, q) = (web[0].2, web[1].2);
    let (a, x, y) = (&web[2], &web[3], &web[4]);
    for (parent, child) in [(p, a), (q, x), (q, y)] {
        ok(
            &s,
            &b,
            json!({ "kind": "sub_add", "issue": parent, "child": end(child), "replace_parent": false, "after": null }),
        )
        .await;
    }

    // a moves to q, after x: GitHub takes the move, then refuses the reorder.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "PATCH /repos/*/*/issues/*/sub_issues/priority", "status": 422, "count": 1 }),
    )
    .await;
    let (status, body) = op(
        &s,
        &b,
        json!({ "kind": "sub_add", "issue": q, "child": end(a), "replace_parent": true, "after": x.2 }),
    )
    .await;
    s.fake("DELETE", "/faults", json!({})).await;
    // Made: a is under q, last, and the reorder comes back to be sent again.
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["unapplied"][0]["ops"],
        json!([{ "kind": "sub_reorder", "issue": q, "child": a.2, "after": x.2 }]),
        "{body}"
    );
    assert!(body["unapplied"][0]["why"].is_string(), "{body}");
    assert_eq!(parent(&s, &b, a.2).await, Some(q));
    assert_eq!(rel(&s, &b, q, "sub_issues").await, [x.2, y.2, a.2]);
    assert_eq!(rel(&s, &b, p, "sub_issues").await, Vec::<i64>::new());

    // Its Retry: the reorder.
    ok(&s, &b, body["unapplied"][0]["ops"][0].clone()).await;
    assert_eq!(rel(&s, &b, q, "sub_issues").await, [x.2, a.2, y.2]);

    // The move sent again (to the bottom this time) is only a reorder: no add is made.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "POST /repos/*/*/issues/*/sub_issues", "status": 500, "count": 1 }),
    )
    .await;
    ok(
        &s,
        &b,
        json!({ "kind": "sub_add", "issue": q, "child": end(a), "replace_parent": true, "after": null }),
    )
    .await;
    let left = s.fake("GET", "/state", Value::Null).await["faults"]["fail"].clone();
    assert_eq!(left.as_array().unwrap().len(), 1, "an add was made: {left}");
    s.fake("DELETE", "/faults", json!({})).await;
    assert_eq!(rel(&s, &b, q, "sub_issues").await, [x.2, y.2, a.2]);
}

#[tokio::test(flavor = "multi_thread")]
async fn blocking_an_issue_beghu_doesnt_sync_is_refused_with_a_reason_and_no_call() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let me = unlinked("web")[0].2;
    let n = summary()["unlinked_stubs"][0].as_i64().unwrap();
    let stub = json!({ "id": null, "owner": "acme", "repo": "partner-sdk", "number": n });

    // The picker says so beside it; blocked by it is fine (that write is on this issue).
    let place = format!("partner-sdk#{n}");
    let got = relatable(&s, &b, me, "blocking", &place).await;
    assert_eq!(
        got[0]["why_not"],
        "Not synced: only an issue beghu syncs can be marked blocked here"
    );
    assert_eq!(
        relatable(&s, &b, me, "blocked_by", &place).await[0]["why_not"],
        Value::Null
    );

    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "POST /repos/*/*/issues/*/dependencies/blocked_by", "status": 500, "count": 1 }),
    )
    .await;
    let (status, body) = op(
        &s,
        &b,
        json!({ "kind": "block_add", "issue": me, "other": stub, "blocking": true }),
    )
    .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(
        body["message"],
        format!(
            "partner-sdk#{n} isn't synced: only an issue beghu syncs can take this write; make it on GitHub"
        )
    );
    let left = s.fake("GET", "/state", Value::Null).await["faults"]["fail"].clone();
    assert_eq!(left.as_array().unwrap().len(), 1, "a call was made: {left}");
    s.fake("DELETE", "/faults", json!({})).await;

    ok(
        &s,
        &b,
        json!({ "kind": "block_add", "issue": me, "other": stub, "blocking": false }),
    )
    .await;
    assert_eq!(rel(&s, &b, me, "blocked_by").await.len(), 1);
}

/// The id of `b`'s synced repo `name`.
async fn repo_id(s: &Stack, b: &Browser, name: &str) -> i64 {
    let (_, me) = s.api(&mut b.clone(), "/api/me").await;
    me["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == name)
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_issue_with_a_parent_is_made_its_sub_issue_in_the_same_write_and_a_failed_add_comes_back()
 {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let repo = repo_id(&s, &b, "web").await;
    let web = unlinked("web");
    let p = web[0].2;
    let create = |title: &str| {
        json!({ "kind": "create", "repo": repo, "title": title, "body": "",
                "labels": [], "assignees": [], "milestone": null, "parent": p })
    };

    // Made, and its parent's last sub-issue when the reply comes.
    let (status, body) = op(&s, &b, create("A child made with its parent")).await;
    assert_eq!(status, 200, "{body}");
    assert!(body.get("unapplied").is_none(), "{body}");
    let first = body["issue"].as_i64().unwrap();
    assert_eq!(parent(&s, &b, first).await, Some(p));
    assert_eq!(rel(&s, &b, p, "sub_issues").await, [first]);

    // GitHub refuses the add: the issue is made all the same (once), and the add comes back, by
    // the new issue's id and place, to be sent again.
    s.fake(
        "POST",
        "/faults/fail",
        json!({ "endpoint": "POST /repos/*/*/issues/*/sub_issues", "status": 422, "count": 1 }),
    )
    .await;
    let (status, body) = op(&s, &b, create("A child whose add fails")).await;
    s.fake("DELETE", "/faults", json!({})).await;
    assert_eq!(status, 200, "{body}");
    let second = body["issue"].as_i64().unwrap();
    let number = detail(&s, &b, second).await["number"].as_i64().unwrap();
    assert_eq!(
        body["unapplied"][0]["ops"],
        json!([{ "kind": "sub_add", "issue": p,
                 "child": { "id": second, "owner": "acme", "repo": "web", "number": number },
                 "replace_parent": false, "after": null }]),
        "{body}"
    );
    assert_eq!(parent(&s, &b, second).await, None);
    assert_eq!(rel(&s, &b, p, "sub_issues").await, [first]);
    ok(&s, &b, body["unapplied"][0]["ops"][0].clone()).await;
    assert_eq!(rel(&s, &b, p, "sub_issues").await, [first, second]);
}

//! Focus view: `GET /api/tree?focus=` (and `chain=`), one issue as the root and what's reached down
//! from it along sub-issues or dependencies, with linked PRs as leaves, filtered by the view. Made
//! of the fixture's issues with no relationships, linked through `POST /api/ops` (Fake GitHub
//! behind it), and read back as the web app reads them.

mod common;

use common::{Browser, Issue, Stack, end, start, unlinked, uuid};
use serde_json::{Value, json};

/// An op that must go through.
async fn ok(s: &Stack, b: &Browser, op: Value) {
    let res = s
        .api_write(b, reqwest::Method::POST, "/api/ops")
        .json(&json!({ "op_id": uuid(), "op": op }))
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    assert_eq!(status, 200, "{op} → {body}");
}

/// `child` becomes the last sub-issue of `parent`.
async fn nest(s: &Stack, b: &Browser, parent: &Issue, child: &Issue) {
    ok(
        s,
        b,
        json!({ "kind": "sub_add", "issue": parent.2, "child": end(child), "replace_parent": false, "after": null }),
    )
    .await;
}

/// `blocker` blocks `blocked`.
async fn block(s: &Stack, b: &Browser, blocker: &Issue, blocked: &Issue) {
    ok(
        s,
        b,
        json!({ "kind": "block_add", "issue": blocker.2, "other": end(blocked), "blocking": true }),
    )
    .await;
}

fn enc(q: &str) -> String {
    q.bytes()
        .map(|c| match c {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' => (c as char).to_string(),
            _ => format!("%{c:02X}"),
        })
        .collect()
}

/// `/api/tree` for view `q` with these parameters.
async fn focus(s: &Stack, b: &Browser, q: &str, rest: &str) -> Value {
    let (status, page) = s
        .api(&mut b.clone(), &format!("/api/tree?q={}{rest}", enc(q)))
        .await;
    assert_eq!(status, 200, "{q} {rest}: {page}");
    page
}

/// A node as the assertions read it: `(id, depth, parent, children, open, repeat)`.
type Node = (i64, i64, Option<i64>, i64, bool, bool);

fn nodes(page: &Value) -> Vec<Node> {
    page["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| {
            (
                n["row"]["id"].as_i64().unwrap(),
                n["depth"].as_i64().unwrap(),
                n["parent"].as_i64(),
                n["children"].as_i64().unwrap(),
                n["open"].as_bool().unwrap(),
                n["repeat"].as_bool().unwrap(),
            )
        })
        .collect()
}

fn id(u: &Issue) -> i64 {
    u.2
}

#[tokio::test(flavor = "multi_thread")]
async fn a_parent_chain_is_the_focused_issue_and_its_sub_issues_with_the_root_open() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    // web0 > (web1 > web3, web2).
    nest(&s, &b, &web[0], &web[1]).await;
    nest(&s, &b, &web[0], &web[2]).await;
    nest(&s, &b, &web[1], &web[3]).await;

    // The root is the issue in focus, whatever its parent; it opens by default, the rest don't.
    let page = focus(&s, &b, "", &format!("&focus={}", id(&web[1]))).await;
    assert_eq!(
        nodes(&page),
        vec![
            (id(&web[1]), 0, None, 1, true, false),
            (id(&web[3]), 1, Some(id(&web[1])), 0, false, false),
        ]
    );
    // One page: nothing more to load.
    assert!(page["next"].is_null() && page["last"].is_null());
    // The root has a parent on GitHub: a drag moves it from there.
    assert_eq!(page["nodes"][0]["has_parent"], true);

    // From the top, opened to the bottom (`under` the root with `all`), in GitHub's order.
    let all = focus(
        &s,
        &b,
        "",
        &format!("&focus={}&under={}&all=1", id(&web[0]), id(&web[0])),
    )
    .await;
    assert_eq!(
        nodes(&all),
        vec![
            (id(&web[1]), 0, Some(id(&web[0])), 1, true, false),
            (id(&web[3]), 1, Some(id(&web[1])), 0, false, false),
            (id(&web[2]), 0, Some(id(&web[0])), 0, false, false),
        ]
    );
    // The tab closed the root: it stays closed, and the selection under it shows as it.
    let shut = focus(
        &s,
        &b,
        "",
        &format!(
            "&focus={}&shut={}&sel={}",
            id(&web[0]),
            id(&web[0]),
            id(&web[3])
        ),
    )
    .await;
    assert_eq!(nodes(&shut), vec![(id(&web[0]), 0, None, 2, false, false)]);
    assert_eq!(shut["selected"], id(&web[0]));
    // Open along the way, it shows as itself; one outside the focus shows nowhere.
    let sel = focus(
        &s,
        &b,
        "",
        &format!(
            "&focus={}&open={}&sel={}",
            id(&web[0]),
            id(&web[1]),
            id(&web[3])
        ),
    )
    .await;
    assert_eq!(sel["selected"], id(&web[3]));
    let sel = focus(
        &s,
        &b,
        "",
        &format!("&focus={}&sel={}", id(&web[0]), id(&web[5])),
    )
    .await;
    assert!(sel["selected"].is_null());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_blocking_chain_reads_in_the_order_of_the_work_and_an_issue_reached_twice_opens_once() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    // web0 blocks web1 and web2, both of which block web3, which blocks web4.
    block(&s, &b, &web[0], &web[1]).await;
    block(&s, &b, &web[0], &web[2]).await;
    block(&s, &b, &web[1], &web[3]).await;
    block(&s, &b, &web[2], &web[3]).await;
    block(&s, &b, &web[3], &web[4]).await;
    // A sub-issue isn't on a blocking chain.
    nest(&s, &b, &web[0], &web[5]).await;

    let chain = format!("&focus={}&chain=blocking", id(&web[0]));
    let page = focus(&s, &b, "", &chain).await;
    let (lo, hi) = (id(&web[1]).min(id(&web[2])), id(&web[1]).max(id(&web[2])));
    assert_eq!(
        nodes(&page),
        vec![
            (id(&web[0]), 0, None, 2, true, false),
            (lo, 1, Some(id(&web[0])), 1, false, false),
            (hi, 1, Some(id(&web[0])), 1, false, false),
        ]
    );
    // Opened to the bottom: web3 opens under the first of its blockers and repeats, with
    // nothing under it, under the second.
    let all = focus(&s, &b, "", &format!("{chain}&under={}&all=1", id(&web[0]))).await;
    assert_eq!(
        nodes(&all),
        vec![
            (lo, 0, Some(id(&web[0])), 1, true, false),
            (id(&web[3]), 1, Some(lo), 1, true, false),
            (id(&web[4]), 2, Some(id(&web[3])), 0, false, false),
            (hi, 0, Some(id(&web[0])), 1, true, false),
            (id(&web[3]), 1, Some(hi), 0, false, true),
        ]
    );
    // A blocking chain offers no drag: nothing in it moves a parent.
    assert!(
        all["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|n| n["has_parent"] == false)
    );

    // Focused further down, the chain starts there.
    let mid = focus(
        &s,
        &b,
        "",
        &format!("&focus={}&chain=blocking", id(&web[3])),
    )
    .await;
    assert_eq!(
        nodes(&mid),
        vec![
            (id(&web[3]), 0, None, 1, true, false),
            (id(&web[4]), 1, Some(id(&web[3])), 0, false, false),
        ]
    );

    // A chain the server doesn't know is refused.
    let (status, _) = s
        .api(
            &mut b.clone(),
            &format!("/api/tree?focus={}&chain=sideways", id(&web[0])),
        )
        .await;
    assert_eq!(status, 400);
    // A root the mirror doesn't hold is an empty tree.
    let none = focus(&s, &b, "", "&focus=987654321").await;
    assert_eq!(nodes(&none), vec![]);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_view_filters_a_focus_as_it_does_the_tree_keeping_context_and_the_root() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    // web0 > (web1 > web3, web2); web1 and web2 close, web3 stays open.
    nest(&s, &b, &web[0], &web[1]).await;
    nest(&s, &b, &web[0], &web[2]).await;
    nest(&s, &b, &web[1], &web[3]).await;
    for w in [&web[1], &web[2]] {
        ok(
            &s,
            &b,
            json!({ "kind": "close", "issue": id(w), "reason": "completed" }),
        )
        .await;
    }
    // web2 is hidden; web1 is closed too but shows for web3 under it. Under the root, a match,
    // it isn't context (nothing above it is short of a match) but it isn't a match either.
    let page = focus(&s, &b, "is:open", &format!("&focus={}", id(&web[0]))).await;
    assert_eq!(
        nodes(&page),
        vec![
            (id(&web[0]), 0, None, 1, true, false),
            (id(&web[1]), 1, Some(id(&web[0])), 1, false, false),
        ]
    );
    let look: Vec<(bool, bool)> = page["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| {
            (
                n["context"].as_bool().unwrap(),
                n["matched"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(look, vec![(false, true), (false, false)]);
    // A closed root shows all the same, as context, with its matches under it.
    let closed = focus(&s, &b, "is:open", &format!("&focus={}", id(&web[1]))).await;
    assert_eq!(
        nodes(&closed),
        vec![
            (id(&web[1]), 0, None, 1, true, false),
            (id(&web[3]), 1, Some(id(&web[1])), 0, false, false),
        ]
    );
    assert_eq!(closed["nodes"][0]["context"], true);
    // With nothing under it, a root that doesn't match is all there is.
    let alone = focus(&s, &b, "is:open", &format!("&focus={}", id(&web[2]))).await;
    assert_eq!(nodes(&alone), vec![(id(&web[2]), 0, None, 0, false, false)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn linked_prs_are_leaves_under_their_issue_and_a_focused_pr_has_the_issues_it_closes() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    // A fixture PR that closes an issue.
    let (status, list) = s
        .api(&mut b.clone(), &format!("/api/issues?q={}", enc("is:pr")))
        .await;
    assert_eq!(status, 200);
    let mut found = None;
    for r in list["rows"].as_array().unwrap() {
        let pr = r["id"].as_i64().unwrap();
        let (_, d) = s.api(&mut b.clone(), &format!("/api/issues/{pr}")).await;
        if let Some(issue) = d["closes"].as_array().and_then(|c| c.first())
            && issue["stub"] == false
        {
            found = Some((pr, issue["id"].as_i64().unwrap()));
            break;
        }
    }
    let (pr, issue) = found.expect("a fixture PR that closes a synced issue");

    for chain in ["parent", "blocking"] {
        let page = focus(&s, &b, "", &format!("&focus={issue}&chain={chain}")).await;
        let leaf = page["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["row"]["id"] == pr)
            .unwrap_or_else(|| panic!("{chain}: the PR shows under its issue: {page}"));
        assert_eq!(leaf["row"]["kind"], "pr");
        assert_eq!(leaf["parent"], issue);
        assert_eq!(leaf["children"], 0);
    }
    // Focused on the PR: the issues it closes are under it.
    let page = focus(&s, &b, "", &format!("&focus={pr}")).await;
    let n = nodes(&page);
    assert_eq!(n[0].0, pr);
    assert!(n.iter().any(|x| x.0 == issue && x.2 == Some(pr)), "{page}");
}

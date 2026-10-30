//! Tree mode: `GET /api/tree`, the view's issues nested under their parents (a run of roots, each
//! followed by what it shows open), and `GET /api/tree/drop`, whether a drag may drop an issue
//! under another. Trees are made of the fixture's issues with no relationships, linked through
//! `POST /api/ops` (Fake GitHub behind it), and read back as the web app reads them.

mod common;

use common::{Browser, Issue, Stack, end, full_parent_fixture, start, start_on, unlinked, uuid};
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

fn enc(q: &str) -> String {
    q.bytes()
        .map(|c| match c {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' => (c as char).to_string(),
            _ => format!("%{c:02X}"),
        })
        .collect()
}

/// `/api/tree` with these parameters (`q` encoded here).
async fn tree(s: &Stack, b: &Browser, q: &str, rest: &str) -> Value {
    let (status, page) = s
        .api(&mut b.clone(), &format!("/api/tree?q={}{rest}", enc(q)))
        .await;
    assert_eq!(status, 200, "{q} {rest}: {page}");
    page
}

/// What a node is, as the assertions read it: `(id, depth, parent, children, open, context)`.
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
                n["context"].as_bool().unwrap(),
            )
        })
        .collect()
}

/// Every node of the whole tree of `q`, page by page, with `rest` on each request.
async fn whole(s: &Stack, b: &Browser, q: &str, rest: &str) -> Vec<Value> {
    let mut all = Vec::new();
    let mut after = String::new();
    loop {
        let page = tree(s, b, q, &format!("{rest}{after}")).await;
        all.extend(page["nodes"].as_array().unwrap().iter().cloned());
        match page["next"].as_str() {
            Some(n) => after = format!("&after={n}"),
            None => break all,
        }
    }
}

/// The ids, comma-separated.
fn list(ids: &[i64]) -> String {
    ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
}

#[tokio::test(flavor = "multi_thread")]
async fn sub_issues_nest_under_their_parents_in_githubs_order_and_open_one_level_or_to_the_bottom()
{
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let api = unlinked("api");
    // web0 > (web1 > web3 > api0, web2): four levels, across repos at the bottom.
    nest(&s, &b, &web[0], &web[1]).await;
    nest(&s, &b, &web[0], &web[2]).await;
    nest(&s, &b, &web[1], &web[3]).await;
    nest(&s, &b, &web[3], &api[0]).await;
    let id = |u: &Issue| u.2;

    // Every root is an issue with no parent, in the view's sort, and nothing else is a root.
    let all = whole(&s, &b, "is:open", "").await;
    let roots: Vec<&Value> = all.iter().filter(|n| n["depth"] == 0).collect();
    // Nothing opens unasked but context: a closed parent of an open issue, there for it.
    for n in &all {
        assert_eq!(n["open"], n["context"], "{n}");
        if n["context"] == true {
            assert_eq!(n["row"]["state"], "closed", "{n}");
        }
    }
    let ids: Vec<i64> = roots
        .iter()
        .map(|n| n["row"]["id"].as_i64().unwrap())
        .collect();
    assert!(ids.contains(&id(&web[0])));
    for child in [&web[1], &web[2], &web[3], &api[0]] {
        assert!(!ids.contains(&id(child)), "{child:?} is under a parent");
    }
    assert!(
        roots.iter().all(|n| n["row"]["kind"] == "issue"
            && (n["row"]["state"] == "open" || n["context"] == true))
    );
    let updated: Vec<i64> = roots
        .iter()
        .map(|n| n["row"]["updated_at"].as_i64().unwrap())
        .collect();
    assert!(updated.windows(2).all(|w| w[0] >= w[1]), "newest first");
    let top = roots
        .iter()
        .find(|n| n["row"]["id"] == id(&web[0]))
        .unwrap();
    assert_eq!(top["children"], 2);
    assert_eq!(top["open"], false);
    // Progress counts every descendant.
    assert_eq!(top["row"]["progress"], json!({ "done": 0, "total": 4 }));

    // A chevron opens one level: the node's children, in GitHub's order.
    let one = tree(&s, &b, "is:open", &format!("&under={}", id(&web[0]))).await;
    assert_eq!(
        nodes(&one),
        vec![
            (id(&web[1]), 0, Some(id(&web[0])), 1, false, false),
            (id(&web[2]), 0, Some(id(&web[0])), 0, false, false),
        ]
    );
    // Shift/Alt-click opens the whole subtree.
    let deep = tree(&s, &b, "is:open", &format!("&under={}&all=1", id(&web[0]))).await;
    assert_eq!(
        nodes(&deep),
        vec![
            (id(&web[1]), 0, Some(id(&web[0])), 1, true, false),
            (id(&web[3]), 1, Some(id(&web[1])), 1, true, false),
            (id(&api[0]), 2, Some(id(&web[3])), 0, false, false),
            (id(&web[2]), 0, Some(id(&web[0])), 0, false, false),
        ]
    );
    // What the tab opened opens with the roots, depth first; a refetch through the last root has
    // the same.
    let open = format!("&open={}", list(&[id(&web[0]), id(&web[1])]));
    let mut seen = Vec::new();
    let mut after = String::new();
    let mut last = String::new();
    loop {
        let page = tree(&s, &b, "is:open", &format!("{open}{after}")).await;
        seen.extend(nodes(&page));
        last = page["last"].as_str().unwrap_or(&last).to_owned();
        match page["next"].as_str() {
            Some(n) => after = format!("&after={n}"),
            None => break,
        }
    }
    let at = seen.iter().position(|n| n.0 == id(&web[0])).unwrap();
    assert_eq!(
        seen[at..at + 4],
        [
            (id(&web[0]), 0, None, 2, true, false),
            (id(&web[1]), 1, Some(id(&web[0])), 1, true, false),
            (id(&web[3]), 2, Some(id(&web[1])), 1, false, false),
            (id(&web[2]), 1, Some(id(&web[0])), 0, false, false),
        ]
    );
    let through = tree(&s, &b, "is:open", &format!("{open}&through={last}")).await;
    assert_eq!(nodes(&through), seen);
    assert!(through["next"].is_null());

    // A move made at the top (`first`) lands first among its new siblings.
    ok(
        &s,
        &b,
        json!({ "kind": "sub_add", "issue": id(&web[0]), "child": end(&api[0]), "replace_parent": true, "after": null, "first": true }),
    )
    .await;
    let one = tree(&s, &b, "is:open", &format!("&under={}", id(&web[0]))).await;
    let order: Vec<i64> = nodes(&one).iter().map(|n| n.0).collect();
    assert_eq!(order, vec![id(&api[0]), id(&web[1]), id(&web[2])]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_filtered_tree_shows_matches_inside_context_ancestors_opened_along_each_path() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let id = |u: &Issue| u.2;
    // web0 > web1 > web2 > web3, and web0 > web4. Only web2 is a match: a title nothing else has.
    nest(&s, &b, &web[0], &web[1]).await;
    nest(&s, &b, &web[1], &web[2]).await;
    nest(&s, &b, &web[2], &web[3]).await;
    nest(&s, &b, &web[0], &web[4]).await;
    let (_, d) = s
        .api(&mut b.clone(), &format!("/api/issues/{}", id(&web[2])))
        .await;
    ok(
        &s,
        &b,
        json!({ "kind": "title_edit", "issue": id(&web[2]), "new": "Quokkafrost overflow", "base": d["title"] }),
    )
    .await;
    let q = "is:open quokkafrost";
    let page = tree(&s, &b, q, "").await;
    // The match sits inside its ancestors, which are context and open; the match itself is
    // closed but openable (its subtree stays the issue's, whatever the filter).
    assert_eq!(
        nodes(&page),
        vec![
            (id(&web[0]), 0, None, 1, true, true),
            (id(&web[1]), 1, Some(id(&web[0])), 1, true, true),
            (id(&web[2]), 2, Some(id(&web[1])), 1, false, false),
        ]
    );
    let row = |n: usize| page["nodes"][n]["row"].clone();
    assert_eq!(row(2)["matched"], json!(["title"]));
    assert_eq!(row(0)["matched"], json!([]));
    // Opening the match shows what's under it, though it doesn't match.
    let under = tree(&s, &b, q, &format!("&under={}", id(&web[2]))).await;
    assert_eq!(
        nodes(&under),
        vec![(id(&web[3]), 0, Some(id(&web[2])), 0, false, false)]
    );
    // A context node the tab closed stays closed, and the selection under it shows as it.
    let shut = tree(
        &s,
        &b,
        q,
        &format!("&shut={}&sel={}", id(&web[1]), id(&web[2])),
    )
    .await;
    assert_eq!(
        nodes(&shut),
        vec![
            (id(&web[0]), 0, None, 1, true, true),
            (id(&web[1]), 1, Some(id(&web[0])), 1, false, true),
        ]
    );
    assert_eq!(shut["selected"], id(&web[1]));
    // Open, it shows as itself; one outside the tree shows nowhere.
    let sel = tree(&s, &b, q, &format!("&sel={}", id(&web[2]))).await;
    assert_eq!(sel["selected"], id(&web[2]));
    let sel = tree(&s, &b, q, &format!("&sel={}", id(&web[5]))).await;
    assert!(sel["selected"].is_null());
}

#[tokio::test(flavor = "multi_thread")]
async fn closed_children_are_hidden_under_is_open_but_counted_and_prs_never_show() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let id = |u: &Issue| u.2;
    // web0 > (web1, web2 > web3); web2 closes, web3 stays open.
    nest(&s, &b, &web[0], &web[1]).await;
    nest(&s, &b, &web[0], &web[2]).await;
    nest(&s, &b, &web[2], &web[3]).await;
    ok(
        &s,
        &b,
        json!({ "kind": "close", "issue": id(&web[1]), "reason": "completed" }),
    )
    .await;
    ok(
        &s,
        &b,
        json!({ "kind": "close", "issue": id(&web[2]), "reason": "completed" }),
    )
    .await;
    // web1 is hidden; web2 is closed too but shows, as context, for the open web3 under it.
    let under = tree(&s, &b, "is:open", &format!("&under={}&all=1", id(&web[0]))).await;
    assert_eq!(
        nodes(&under),
        vec![
            (id(&web[2]), 0, Some(id(&web[0])), 1, true, false),
            (id(&web[3]), 1, Some(id(&web[2])), 0, false, false),
        ]
    );
    let all = whole(&s, &b, "is:open", "").await;
    let top = all.iter().find(|n| n["row"]["id"] == id(&web[0])).unwrap();
    assert_eq!(top["children"], 1);
    assert_eq!(top["row"]["progress"], json!({ "done": 2, "total": 3 }));
    // Every state: both show.
    let under = tree(&s, &b, "", &format!("&under={}", id(&web[0]))).await;
    let ids: Vec<i64> = nodes(&under).iter().map(|n| n.0).collect();
    assert_eq!(ids, vec![id(&web[1]), id(&web[2])]);

    // PRs never appear: not among the roots of `is:any`, and `is:pr` has no tree.
    for q in ["is:any", "is:any is:closed"] {
        let all = whole(&s, &b, q, "").await;
        assert!(!all.is_empty(), "{q}");
        assert!(all.iter().all(|n| n["row"]["kind"] == "issue"), "{q}");
    }
    let prs = tree(&s, &b, "is:pr", "").await;
    assert_eq!(prs["nodes"], json!([]));
    assert!(prs["next"].is_null());
}

#[tokio::test(flavor = "multi_thread")]
async fn under_a_ranked_match_mode_a_root_ranks_by_the_best_match_in_its_subtree() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let id = |u: &Issue| u.2;
    // web1 (a title match) is under web0; web2 is a root matching only in its body.
    nest(&s, &b, &web[0], &web[1]).await;
    let title = |u: &Issue| {
        let (s, b) = (&s, &b);
        let u = u.clone();
        async move {
            let (_, d) = s.api(&mut b.clone(), &format!("/api/issues/{}", u.2)).await;
            d["title"].as_str().unwrap().to_owned()
        }
    };
    ok(
        &s,
        &b,
        json!({ "kind": "title_edit", "issue": id(&web[1]), "new": "Wombatgleam crash", "base": title(&web[1]).await }),
    )
    .await;
    let (_, src) = s
        .api(
            &mut b.clone(),
            &format!("/api/issues/{}/source", id(&web[2])),
        )
        .await;
    ok(
        &s,
        &b,
        json!({ "kind": "body_edit", "issue": id(&web[2]), "new": "Seen with wombatgleam on.", "base": src["body"] }),
    )
    .await;
    let roots = |page: &Value| -> Vec<i64> {
        nodes(page)
            .iter()
            .filter(|n| n.1 == 0)
            .map(|n| n.0)
            .collect()
    };
    // Best match: titles first, so web0 (its best is web1's title) leads web2, which body edits
    // made the newer.
    let best = tree(&s, &b, "wombatgleam match:best", "").await;
    assert_eq!(roots(&best), vec![id(&web[0]), id(&web[2])]);
    assert_eq!(best["nodes"][0]["context"], true);
    // Off: plain sort, each root by its own update; web2 was edited last.
    let off = tree(&s, &b, "wombatgleam match:off", "").await;
    assert_eq!(roots(&off)[0], id(&web[2]));
    // A ranked cursor pages on from the root it names.
    let first = best["nodes"][0]["row"]["id"].as_i64().unwrap();
    assert_eq!(first, id(&web[0]));
    let last = best["last"].as_str().unwrap();
    let again = tree(
        &s,
        &b,
        "wombatgleam match:best",
        &format!("&through={last}"),
    )
    .await;
    assert_eq!(roots(&again), roots(&best));
    let past = tree(&s, &b, "wombatgleam match:best", &format!("&after={last}")).await;
    assert_eq!(past["nodes"], json!([]));
    // A cursor of another order is refused.
    let (status, _) = s
        .api(
            &mut b.clone(),
            &format!("/api/tree?q={}&after={last}", enc("wombatgleam match:off")),
        )
        .await;
    assert_eq!(status, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_drop_is_refused_with_githubs_reasons_before_any_write() {
    let s = start_on(full_parent_fixture(), |_| {}).await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let id = |u: &Issue| u.2;
    nest(&s, &b, &web[0], &web[1]).await;
    nest(&s, &b, &web[1], &web[2]).await;
    let check = |child: i64, parent: i64| {
        let (s, b) = (&s, &b);
        async move {
            let (status, got) = s
                .api(
                    &mut b.clone(),
                    &format!("/api/tree/drop?child={child}&parent={parent}"),
                )
                .await;
            assert_eq!(status, 200, "{got}");
            got["why"].clone()
        }
    };
    // Under its own descendant: a loop.
    assert_eq!(
        check(id(&web[0]), id(&web[2])).await,
        "That would make a loop of sub-issues"
    );
    // Under another issue: fine, even with a parent of its own (it moves); under its own parent
    // too (to the end).
    assert!(check(id(&web[2]), id(&web[3])).await.is_null());
    assert!(check(id(&web[2]), id(&web[1])).await.is_null());
    // A 101st sub-issue: the fixture's web issue with 100.
    let full = {
        let all = whole(&s, &b, "repo:web", "").await;
        all.iter()
            .find(|n| n["children"].as_i64().unwrap() >= 100)
            .map(|n| n["row"]["id"].as_i64().unwrap())
            .expect("a parent with 100 sub-issues")
    };
    assert_eq!(
        check(id(&web[4]), full).await,
        "An issue can have at most 100 sub-issues"
    );
    // A PR takes no sub-issues: beghu writes nothing to one.
    let prs = s.api(&mut b.clone(), "/api/issues?q=is%3Apr").await.1;
    let pr = prs["rows"][0]["id"].as_i64().unwrap();
    assert!(check(id(&web[4]), pr).await.as_str().is_some());
}

/// `/api/tree/drop`'s answer: why the drop is refused, or `null`.
async fn drop_why(s: &Stack, b: &Browser, child: i64, parent: i64) -> Value {
    let (status, got) = s
        .api(
            &mut b.clone(),
            &format!("/api/tree/drop?child={child}&parent={parent}"),
        )
        .await;
    assert_eq!(status, 200, "{got}");
    got["why"].clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_drop_past_8_levels_is_refused_and_a_reorder_is_checked_too() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    let api = unlinked("api");
    // web0 > web1 > … > web7: 8 levels.
    for w in web.windows(2) {
        nest(&s, &b, &w[0], &w[1]).await;
    }
    assert_eq!(
        drop_why(&s, &b, api[0].2, web[7].2).await,
        "Sub-issues nest at most 8 levels deep"
    );
    // Under its own parent: a reorder, which nothing refuses here.
    assert!(drop_why(&s, &b, web[2].2, web[1].2).await.is_null());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_drop_into_a_repo_this_server_doesnt_write_to_is_refused_as_its_write_would_be() {
    let s =
        common::start_with(|cfg| cfg.github.writable_repos = Some(vec!["acme/api".into()])).await;
    let b = s.sign_in("tomsj").await;
    let api = unlinked("api");
    let web = unlinked("web");
    let refused = "This beghu writes only to acme/api; acme/web is read-only here";
    // Under a web issue (the parent's repo), or a web issue moved under an api one (the issue's).
    assert_eq!(drop_why(&s, &b, api[1].2, web[0].2).await, refused);
    assert_eq!(drop_why(&s, &b, web[0].2, api[0].2).await, refused);
    assert!(drop_why(&s, &b, api[1].2, api[0].2).await.is_null());
}

#[tokio::test(flavor = "multi_thread")]
async fn each_node_says_whether_it_has_a_parent_and_a_move_takes_it_from_that_one() {
    let s = start().await;
    let b = s.sign_in("tomsj").await;
    let web = unlinked("web");
    nest(&s, &b, &web[0], &web[1]).await;
    // (Fake GitHub can't make a parent beghu doesn't show, a stub: an issue in a repo it doesn't
    // sync takes no sub-issues there. `has_parent` is what the tab moves by either way.)
    let all = whole(&s, &b, "is:open", &format!("&open={}", web[0].2)).await;
    let at = |id: i64| all.iter().find(|n| n["row"]["id"] == id).unwrap().clone();
    assert_eq!(at(web[0].2)["has_parent"], false);
    assert_eq!(at(web[1].2)["has_parent"], true);
    // web1 under web2: a move from web0, which the check and the write agree on.
    assert!(drop_why(&s, &b, web[1].2, web[2].2).await.is_null());
    ok(
        &s,
        &b,
        json!({ "kind": "sub_add", "issue": web[2].2, "child": end(&web[1]), "replace_parent": true, "after": null }),
    )
    .await;
    let under = tree(&s, &b, "is:open", &format!("&under={}", web[2].2)).await;
    assert_eq!(nodes(&under)[0].0, web[1].2);
}

#[tokio::test(flavor = "multi_thread")]
async fn each_account_reads_its_own_tree_of_the_same_view() {
    let s = start().await;
    let tomsj = s.sign_in("tomsj").await;
    let ilze = s.sign_in("ilze-k").await;
    // The same query, `assignee:me`, read by one account and then the other: each sees its own.
    for (b, login) in [(&tomsj, "tomsj"), (&ilze, "ilze-k"), (&tomsj, "tomsj")] {
        let all = whole(&s, b, "is:open assignee:me", "").await;
        let matches: Vec<&Value> = all.iter().filter(|n| n["context"] == false).collect();
        assert!(!matches.is_empty(), "{login}");
        for n in matches {
            let who: Vec<&str> = n["row"]["assignees"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a["login"].as_str().unwrap())
                .collect();
            assert!(who.contains(&login), "{login}: {n}");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_drop_the_role_doesnt_allow_is_refused_with_the_roles_reason() {
    let s = start().await;
    let b = s.sign_in("ilze-k").await;
    // ilze-k has Write on web and Read on cli (the fixture's roles).
    let first = |repo: &'static str| {
        let (s, b) = (&s, &b);
        async move {
            let (_, page) = s
                .api(
                    &mut b.clone(),
                    &format!("/api/issues?q=is%3Aopen+repo%3A{repo}"),
                )
                .await;
            page["rows"][0]["id"].as_i64().unwrap()
        }
    };
    let (cli, web) = (first("cli").await, first("web").await);
    assert_eq!(drop_why(&s, &b, cli, web).await, "needs Triage on cli");
    assert_eq!(drop_why(&s, &b, web, cli).await, "needs Triage on cli");
}

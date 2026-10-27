//! The filter bar's language and sorts through `/api/issues`, and its suggestions through
//! `/api/facets`, on the 1k fixture. The oracles are the rows themselves (their labels,
//! assignees, repo, state, kind and timestamps) and identities between views: an OR of disjoint
//! values is the sum of its parts, and a facet's values partition a view.

mod common;

use common::{Browser, Stack, start};
use serde_json::Value;
use std::collections::BTreeSet;

/// Every row of the view `q` (`None`: no `q` at all), paging through its cursors.
async fn all(s: &Stack, b: &mut Browser, q: Option<&str>) -> Vec<Value> {
    let base = match q {
        Some(q) => format!(
            "/api/issues?{}",
            serde_urlencoded::to_string([("q", q)]).unwrap()
        ),
        None => "/api/issues".into(),
    };
    let mut rows = Vec::new();
    let mut url = base.clone();
    loop {
        let (status, page) = s.api(b, &url).await;
        assert_eq!(status, 200, "{url}: {page}");
        rows.extend(page["rows"].as_array().unwrap().iter().cloned());
        match page["next"].as_str() {
            Some(next) => {
                let sep = if base.contains('?') { '&' } else { '?' };
                url = format!("{base}{sep}after={next}");
            }
            None => break,
        }
    }
    rows
}

async fn ids(s: &Stack, b: &mut Browser, q: &str) -> BTreeSet<i64> {
    all(s, b, Some(q))
        .await
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect()
}

fn names(r: &Value, field: &str, key: &str) -> BTreeSet<String> {
    r[field]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x[key].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn labels_and_assignees_and_together() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;

    let both = all(&s, &mut b, Some("label:bug label:backend")).await;
    let bug = ids(&s, &mut b, "label:bug").await;
    assert!(!both.is_empty());
    assert!(both.len() < bug.len());
    for r in &both {
        let labels = names(r, "labels", "name");
        assert!(labels.contains("bug") && labels.contains("backend"), "{r}");
    }
    // A quoted value holds spaces.
    for r in all(&s, &mut b, Some(r#"label:"good first issue""#)).await {
        assert!(names(&r, "labels", "name").contains("good first issue"));
    }

    // Two people who share an issue somewhere.
    let shared = all(&s, &mut b, Some("")).await;
    let two: Vec<String> = shared
        .iter()
        .map(|r| names(r, "assignees", "login"))
        .find(|w| w.len() == 2)
        .unwrap()
        .into_iter()
        .collect();
    let query = format!("assignee:{} assignee:{}", two[0], two[1]);
    let pair = all(&s, &mut b, Some(&query)).await;
    assert!(!pair.is_empty());
    assert!(pair.len() < ids(&s, &mut b, &format!("assignee:{}", two[0])).await.len());
    for r in &pair {
        let who = names(r, "assignees", "login");
        assert!(who.contains(&two[0]) && who.contains(&two[1]), "{r}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn repos_milestones_and_authors_or_together() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;

    let web = ids(&s, &mut b, "repo:web").await;
    let api = ids(&s, &mut b, "repo:api").await;
    let either = all(&s, &mut b, Some("repo:web repo:api")).await;
    assert_eq!(either.len(), web.len() + api.len());
    let repos: BTreeSet<&str> = either.iter().map(|r| r["repo"].as_str().unwrap()).collect();
    assert_eq!(repos, BTreeSet::from(["api", "web"]));
    assert_eq!(ids(&s, &mut b, "repo:acme/web").await, web);

    let a = ids(&s, &mut b, "author:tomsj").await;
    let c = ids(&s, &mut b, "author:anna-b").await;
    assert!(!a.is_empty() && !c.is_empty());
    let ac = ids(&s, &mut b, "author:tomsj author:anna-b").await;
    assert_eq!(ac, a.union(&c).copied().collect());
    assert!(a.is_disjoint(&c));

    // Milestones by title: every open issue has no milestone or exactly one title, so the
    // titles and `no:milestone` partition the view, and an OR of two titles is their union.
    let (_, facets) = s.api(&mut b, "/api/facets").await;
    let titles: Vec<&str> = facets["milestones"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().unwrap())
        .collect();
    assert!(titles.len() > 2, "{facets}");
    let open = ids(&s, &mut b, "is:open").await;
    let mut covered = ids(&s, &mut b, "is:open no:milestone").await;
    let mut per_title = Vec::new();
    for t in &titles {
        let these = ids(&s, &mut b, &format!("is:open milestone:{t}")).await;
        assert!(covered.is_disjoint(&these), "{t}");
        covered.extend(&these);
        per_title.push(these);
    }
    assert_eq!(covered, open);
    let two = ids(
        &s,
        &mut b,
        &format!("is:open milestone:{} milestone:{}", titles[0], titles[1]),
    )
    .await;
    assert_eq!(two, per_title[0].union(&per_title[1]).copied().collect());
}

#[tokio::test(flavor = "multi_thread")]
async fn me_is_the_active_account() {
    let s = start().await;
    let mut tomsj = s.sign_in("tomsj").await;
    let mut ilze = s.sign_in("ilze-k").await;

    let mine = ids(&s, &mut tomsj, "is:open assignee:me").await;
    assert!(!mine.is_empty());
    assert_eq!(mine, ids(&s, &mut tomsj, "is:open assignee:tomsj").await);
    assert_eq!(
        ids(&s, &mut tomsj, "author:me").await,
        ids(&s, &mut tomsj, "author:tomsj").await
    );
    let hers = ids(&s, &mut ilze, "is:open assignee:me").await;
    assert_eq!(hers, ids(&s, &mut ilze, "is:open assignee:ilze-k").await);
    assert_ne!(mine, hers);
    assert_eq!(
        ids(&s, &mut ilze, "author:me").await,
        ids(&s, &mut ilze, "author:ilze-k").await
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn is_picks_state_and_kind_with_issues_implied() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;

    // No `q` is the Open preset.
    let default = all(&s, &mut b, None).await;
    assert_eq!(
        default
            .iter()
            .map(|r| r["id"].as_i64().unwrap())
            .collect::<BTreeSet<_>>(),
        ids(&s, &mut b, "is:open").await
    );
    assert!(
        default
            .iter()
            .all(|r| r["state"] == "open" && r["kind"] == "issue")
    );

    let closed = all(&s, &mut b, Some("is:closed")).await;
    assert!(!closed.is_empty() && closed.iter().all(|r| r["state"] == "closed"));
    // Both states, or none named, is every state.
    let every = ids(&s, &mut b, "").await;
    assert_eq!(every.len(), default.len() + closed.len());
    assert_eq!(ids(&s, &mut b, "is:open is:closed").await, every);

    let prs = all(&s, &mut b, Some("is:pr")).await;
    assert!(!prs.is_empty() && prs.iter().all(|r| r["kind"] == "pr"));
    let any = ids(&s, &mut b, "is:any").await;
    assert_eq!(any.len(), every.len() + prs.len());
    assert_eq!(ids(&s, &mut b, "is:issue is:pr").await, any);
    let open_prs = all(&s, &mut b, Some("is:pr is:open")).await;
    assert!(
        open_prs
            .iter()
            .all(|r| r["kind"] == "pr" && r["state"] == "open")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn type_filters_by_issue_type_and_types_or_together() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;

    // The fixture's issue types, as `/api/facets` lists them.
    let (_, facets) = s.api(&mut b, "/api/facets").await;
    let types: Vec<&str> = facets["types"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().unwrap())
        .collect();
    assert_eq!(types, ["Bug", "Feature", "Task"], "{facets}");

    // Each type's rows carry it, matched without regard to case; the types and the untyped
    // rows partition the view.
    let every = ids(&s, &mut b, "").await;
    let mut covered = BTreeSet::new();
    for t in &types {
        let rows = all(&s, &mut b, Some(&format!("type:{}", t.to_lowercase()))).await;
        assert!(!rows.is_empty(), "{t}");
        for r in &rows {
            assert_eq!(r["issue_type"], *t, "{r}");
            assert!(covered.insert(r["id"].as_i64().unwrap()));
        }
    }
    let untyped = all(&s, &mut b, Some("")).await;
    let untyped: BTreeSet<i64> = untyped
        .iter()
        .filter(|r| r["issue_type"].is_null())
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    assert!(!untyped.is_empty());
    assert!(covered.is_disjoint(&untyped));
    covered.extend(&untyped);
    assert_eq!(covered, every);

    // Two types OR; `type:` isn't a kind, so `type:pr` matches nothing.
    let bug = ids(&s, &mut b, "type:bug").await;
    let task = ids(&s, &mut b, "type:task").await;
    assert_eq!(
        ids(&s, &mut b, "type:bug type:task").await,
        bug.union(&task).copied().collect()
    );
    assert!(ids(&s, &mut b, "is:any type:pr").await.is_empty());

    // Its counts partition the view like any facet's.
    let (status, counts) = s.api(&mut b, "/api/facets/type/counts?q=is%3Aopen").await;
    assert_eq!(status, 200, "{counts}");
    let open_bugs = ids(&s, &mut b, "is:open type:bug").await;
    let bug_count = counts
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["value"] == "Bug")
        .map(|c| c["count"].as_u64().unwrap() as usize);
    assert_eq!(bug_count, Some(open_bugs.len()));
}

#[tokio::test(flavor = "multi_thread")]
async fn no_leaves_out_rows_with_any_value() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let bare = all(&s, &mut b, Some("is:open no:label no:assignee")).await;
    assert!(!bare.is_empty());
    for r in &bare {
        assert!(r["labels"].as_array().unwrap().is_empty(), "{r}");
        assert!(r["assignees"].as_array().unwrap().is_empty(), "{r}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_half_typed_token_is_dropped_never_guessed_at() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;

    let crash = ids(&s, &mut b, "crash").await;
    assert!(!crash.is_empty());
    // "crash label" while it's still free text: both words, each a word prefix.
    let crash_label = all(&s, &mut b, Some("crash label")).await;
    assert!(!crash_label.is_empty());
    for r in &crash_label {
        assert!(crash.contains(&r["id"].as_i64().unwrap()));
    }
    let label = ids(&s, &mut b, "label").await;
    assert!(crash_label.len() < crash.len().min(label.len()));
    for r in &crash_label {
        assert!(label.contains(&r["id"].as_i64().unwrap()));
    }
    // The colon arrives: `label:` with no value is dropped, leaving "crash".
    assert_eq!(ids(&s, &mut b, "crash label:").await, crash);
    // A value that can't be one yet, or an unknown key, is dropped too.
    assert_eq!(ids(&s, &mut b, "crash is:op").await, crash);
    assert_eq!(ids(&s, &mut b, "crash sort:upd").await, crash);
    assert_eq!(ids(&s, &mut b, "crash nosuch:thing").await, crash);
    // A one-letter word isn't a search yet, nor is a word whose last part is one letter, which
    // the index would see as a one-letter prefix.
    assert_eq!(ids(&s, &mut b, "crash l").await, crash);
    assert_eq!(ids(&s, &mut b, "crash a-b").await, crash);
    // Only the last part is a prefix: a one-letter part before it is matched whole, so the word
    // searches (nothing in the fixture says "e-mail" or "x-ray").
    assert_eq!(ids(&s, &mut b, "crash e-mail").await, BTreeSet::new());
    assert_eq!(ids(&s, &mut b, "crash x-ray").await, BTreeSet::new());
    // While the last part is one letter, the word searches on the parts before it, as it did
    // a keystroke earlier: the list doesn't widen back to "crash" and narrow again.
    let web = ids(&s, &mut b, "crash web").await;
    assert!(!web.is_empty() && web.len() < crash.len());
    assert_eq!(ids(&s, &mut b, "crash web-").await, web);
    assert_eq!(ids(&s, &mut b, "crash web-h").await, web);
    assert_eq!(ids(&s, &mut b, "crash web.h").await, web);
    // Complete, it filters.
    let bugs = all(&s, &mut b, Some("crash label:bug")).await;
    assert!(!bugs.is_empty());
    for r in &bugs {
        assert!(crash.contains(&r["id"].as_i64().unwrap()));
        assert!(names(r, "labels", "name").contains("bug"));
    }
    // `-word` excludes, a quoted phrase matches as written.
    let no_crash = ids(&s, &mut b, "-crash").await;
    assert!(no_crash.is_disjoint(&crash));
    assert_eq!(
        no_crash.len() + crash.len(),
        ids(&s, &mut b, "").await.len()
    );
    for r in all(&s, &mut b, Some(r#""crash in""#)).await {
        let t = r["title"].as_str().unwrap().to_lowercase();
        // The phrase is in the title or the body; the fixture writes it only in titles.
        assert!(t.contains("crash in"), "{t}");
    }
}

/// The value a row sorts on, as the spec defines each key: `None` for a never-closed row under
/// `closed` and an uncommented one under `commented`, which go last both ways.
fn key(r: &Value, sort: &str) -> Option<i64> {
    match sort {
        "updated" => r["updated_at"].as_i64(),
        "created" => r["created_at"].as_i64(),
        "closed" => r["closed_at"].as_i64(),
        "commented" => r["commented_at"].as_i64(),
        "comments" => r["comments"].as_i64(),
        _ => unreachable!(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_sort_orders_both_ways_with_id_tie_breaks_across_pages() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let every = ids(&s, &mut b, "").await;
    for sort in ["updated", "created", "closed", "commented", "comments"] {
        for asc in [false, true] {
            let token = format!("sort:{sort}{}", if asc { "-asc" } else { "" });
            let rows = all(&s, &mut b, Some(&token)).await;
            let got: Vec<i64> = rows.iter().map(|r| r["id"].as_i64().unwrap()).collect();
            assert_eq!(
                got.iter().copied().collect::<BTreeSet<_>>(),
                every,
                "{token}: every row once"
            );
            assert_eq!(got.len(), every.len(), "{token}: no row twice");
            for w in rows.windows(2) {
                let (a, b) = (
                    (key(&w[0], sort), w[0]["id"].as_i64().unwrap()),
                    (key(&w[1], sort), w[1]["id"].as_i64().unwrap()),
                );
                let ordered = match (a.0, b.0) {
                    // Rows without the key last, then by id in the sort's direction.
                    (None, Some(_)) => false,
                    (Some(_), None) => true,
                    _ if asc => a < b,
                    _ => a > b,
                };
                assert!(ordered, "{token}: {a:?} before {b:?}");
            }
            for (sort_on, field) in [("closed", "closed_at"), ("commented", "commented_at")] {
                if sort == sort_on {
                    assert!(rows.last().unwrap()[field].is_null(), "{token}");
                    assert!(!rows[0][field].is_null(), "{token}");
                }
            }
        }
    }
    // `-desc` is the default spelled out, and the last `sort:` wins.
    assert_eq!(
        all(&s, &mut b, Some("sort:created sort:comments-desc")).await,
        all(&s, &mut b, Some("sort:comments")).await
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn facets_list_each_value_once_and_count_only_on_request() {
    let s = start().await;
    let mut b = s.sign_in("tomsj").await;
    let res = s.get(&mut b, "/api/facets").await;
    assert_eq!(res.headers()["cache-control"], "no-store");
    let f: Value = res.json().await.unwrap();
    let list = |k: &str| -> Vec<String> {
        f[k].as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect()
    };
    let labels: Vec<(&str, &str)> = f["labels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| (l["name"].as_str().unwrap(), l["color"].as_str().unwrap()))
        .collect();
    assert_eq!(labels.len(), 12, "each label name once across 10 repos");
    assert!(labels.contains(&("bug", "d73a4a")));
    assert!(labels.contains(&("good first issue", "7057ff")));
    let repos = list("repos");
    assert_eq!(repos.len(), 10);
    assert!(repos.contains(&"web".to_owned()));
    assert!(!repos.contains(&"partner-sdk".to_owned()), "not synced");
    // The team is who gets assigned; anyone may author.
    let assignees = list("assignees");
    assert_eq!(assignees.len(), 8, "{assignees:?}");
    assert!(list("authors").len() > assignees.len());
    assert!(list("milestones").contains(&"v0.3".to_owned()));

    // A label's count is how many rows of the view carry it.
    let (status, counts) = s.api(&mut b, "/api/facets/label/counts?q=is%3Aopen").await;
    assert_eq!(status, 200);
    let count = |counts: &Value, v: &str| {
        counts
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["value"] == v)
            .map(|c| c["count"].as_u64().unwrap() as usize)
    };
    let bug = ids(&s, &mut b, "is:open label:bug").await;
    assert_eq!(count(&counts, "bug"), Some(bug.len()));
    // Repos OR, so the view's own `repo:` doesn't narrow its repo counts.
    let (_, counts) = s
        .api(&mut b, "/api/facets/repo/counts?q=is%3Aopen%20repo%3Aweb")
        .await;
    let api = ids(&s, &mut b, "is:open repo:api").await;
    assert_eq!(count(&counts, "api"), Some(api.len()));
    // Assignees AND, so the view's own `assignee:` does narrow.
    let (_, counts) = s
        .api(
            &mut b,
            "/api/facets/assignee/counts?q=is%3Aopen%20assignee%3Atomsj",
        )
        .await;
    assert_eq!(
        count(&counts, "tomsj"),
        Some(ids(&s, &mut b, "is:open assignee:tomsj").await.len())
    );
    assert_eq!(
        count(&counts, "ilze-k").unwrap_or(0),
        ids(&s, &mut b, "is:open assignee:tomsj assignee:ilze-k")
            .await
            .len()
    );

    assert_eq!(s.api(&mut b, "/api/facets/colour/counts").await.0, 404);
    assert_eq!(s.api(&mut Browser::default(), "/api/facets").await.0, 401);
}

/// Two synced repos named `web`, in two orgs: the suggestions name each `owner/name`, and each
/// one's count is its own rows, under the same name.
#[tokio::test(flavor = "multi_thread")]
async fn repo_counts_tell_apart_two_synced_repos_that_share_a_name() {
    let s = common::start_on(common::twin_repo_fixture(), |_| {}).await;
    let mut b = s.sign_in("tomsj").await;
    let (status, f) = s.api(&mut b, "/api/facets").await;
    assert_eq!(status, 200, "{f}");
    let repos: BTreeSet<&str> = f["repos"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r.as_str().unwrap())
        .collect();
    assert!(repos.contains("acme/web"), "{repos:?}");
    assert!(repos.contains("acme-labs/web"), "{repos:?}");
    assert!(!repos.contains("web"), "{repos:?}");
    assert!(
        repos.contains("api"),
        "a name only one repo has stays bare: {repos:?}"
    );

    let (status, counts) = s.api(&mut b, "/api/facets/repo/counts?q=is%3Aopen").await;
    assert_eq!(status, 200, "{counts}");
    let count = |v: &str| {
        counts
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["value"] == v)
            .map(|c| c["count"].as_u64().unwrap() as usize)
    };
    assert_eq!(
        count("acme-labs/web"),
        Some(fixture::TWIN_REPO_OPEN_ISSUES),
        "{counts}"
    );
    let acme_web = ids(&s, &mut b, "is:open repo:acme/web").await.len();
    assert!(acme_web > fixture::TWIN_REPO_OPEN_ISSUES);
    assert_eq!(count("acme/web"), Some(acme_web), "{counts}");
    assert_eq!(count("web"), None, "{counts}");
    assert_eq!(
        count("api"),
        Some(ids(&s, &mut b, "is:open repo:api").await.len())
    );
}

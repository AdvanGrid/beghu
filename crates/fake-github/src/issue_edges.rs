//! `IssueEdges($id, $sub, $blocks, $relates, $relatesAfter)`, the relationship read-backs' query
//! (crates/server/src/edges.rs), and `SweepEdges($ids, $sub, $blocks, $relates)`, the sweeps'
//! batch of the same for up to 100 issues (`nodes(ids:)`): an issue's relationships of the kinds
//! asked for
//! (`@include(if: …)`), each end with its repository. `relatesTo` is a page of at most 100
//! (GitHub's largest page), newest first as GitHub orders it by default, with its `pageInfo`;
//! `$relatesAfter` is the `endCursor` of the page before. The other lists are whole: GitHub caps
//! them at 100 sub-issues and 50 dependencies of each kind. A token sees what GitHub would let
//! it: an installation token the installation's repos, a user token the repos the user has
//! access to, and either one every public repo. Issues in repos the token can't see are left out
//! of lists without a trace, as GitHub does.

use crate::api::Token;
use base64::Engine as _;
use fake_db::q;
use rusqlite::Connection;
use serde_json::{Value, json};

/// The most nodes GitHub returns in one page of a connection.
const MAX_PAGE: usize = 100;

fn visible(c: &Connection, caller: Token, repo: i64) -> rusqlite::Result<bool> {
    let (inst, user) = match caller {
        Token::Installation(i) => (Some(i), None),
        Token::User(u) => (None, Some(u)),
    };
    q::repo_visible(c, repo, inst, user)
}

/// One end of a relationship, as GraphQL's `Issue` gives it with its repository.
fn end(c: &Connection, id: i64) -> rusqlite::Result<Value> {
    let i = q::graphql_issue(c, id)?;
    Ok(json!({
        "id": i.node_id,
        "databaseId": i.id,
        "number": i.number,
        "title": i.title,
        "state": i.state.to_uppercase(),
        "repository": {
            "databaseId": i.repo_id,
            "id": i.repo_node_id,
            "name": i.repo_name,
            "owner": { "login": i.repo_owner },
            "isPrivate": i.repo_private,
        },
    }))
}

/// The ends among `ids` the caller can see, in order.
fn ends(c: &Connection, caller: Token, ids: Vec<i64>) -> rusqlite::Result<Value> {
    let mut nodes = Vec::new();
    for id in ids {
        if visible(c, caller, q::graphql_issue(c, id)?.repo_id)? {
            nodes.push(end(c, id)?);
        }
    }
    Ok(json!({ "nodes": nodes }))
}

/// `IssueEdges`'s answer: `data`, and the errors beside it. An id GitHub doesn't know (deleted,
/// transferred) or doesn't show the caller is `node: null` with a `NOT_FOUND` error on `node`
/// (docs/research/issue-edge-cases.md, mirror-import-and-reconciliation.md).
pub(crate) fn issue_edges(c: &Connection, caller: Token, vars: &Value) -> rusqlite::Result<Value> {
    let node_id = vars["id"].as_str().unwrap_or_default();
    let not_found = || {
        json!({
            "data": { "node": null },
            "errors": [{
                "type": "NOT_FOUND",
                "path": ["node"],
                "locations": [{ "line": 2, "column": 3 }],
                "message": format!("Could not resolve to a node with the global id of '{node_id}'"),
            }],
        })
    };
    let Some(id) = q::issue_by_node_id(c, node_id)? else {
        return Ok(not_found());
    };
    let issue = q::graphql_issue(c, id)?;
    if !visible(c, caller, issue.repo_id)? {
        return Ok(not_found());
    }
    Ok(json!({ "data": { "node": edges_node(c, caller, id, vars)? } }))
}

/// Issue `id` with the relationships `vars` asks for (`sub`, `blocks`, `relates`, and
/// `relatesAfter` for the page of relates-to after a cursor), each end the caller can see.
pub(crate) fn edges_node(
    c: &Connection,
    caller: Token,
    id: i64,
    vars: &Value,
) -> rusqlite::Result<Value> {
    let mut node = json!({ "__typename": "Issue", "databaseId": id });
    let flag = |k: &str| vars[k].as_bool().unwrap_or(false);
    if flag("sub") {
        node["parent"] = match q::parent_of(c, id)? {
            Some(p) if visible(c, caller, q::graphql_issue(c, p)?.repo_id)? => end(c, p)?,
            _ => Value::Null,
        };
        node["subIssues"] = ends(c, caller, q::sub_issues(c, id)?)?;
    }
    if flag("blocks") {
        node["blockedBy"] = ends(c, caller, q::blocked_by(c, id)?)?;
        node["blocking"] = ends(c, caller, q::blocking(c, id)?)?;
    }
    if flag("relates") {
        // Newest first: GitHub's default order, `RELATES_TO_ADDED_AT DESC`.
        let mut all = q::relates_to(c, id)?;
        all.reverse();
        let mut seen = Vec::new();
        for other in all {
            if visible(c, caller, q::graphql_issue(c, other)?.repo_id)? {
                seen.push(other);
            }
        }
        let from = vars["relatesAfter"]
            .as_str()
            .and_then(from_cursor)
            .unwrap_or(0)
            .min(seen.len());
        let to = (from + MAX_PAGE).min(seen.len());
        let mut page = Vec::new();
        for other in &seen[from..to] {
            page.push(end(c, *other)?);
        }
        node["relatesTo"] = json!({
            "pageInfo": {
                "hasNextPage": to < seen.len(),
                "endCursor": (to > from).then(|| cursor(to)),
            },
            "nodes": page,
        });
    }
    Ok(node)
}

/// An opaque cursor past the first `n` nodes of a list, as GitHub's look (base64).
fn cursor(n: usize) -> String {
    base64::engine::general_purpose::STANDARD.encode(format!("cursor:v2:{n}"))
}

fn from_cursor(c: &str) -> Option<usize> {
    let raw = base64::engine::general_purpose::STANDARD.decode(c).ok()?;
    String::from_utf8(raw)
        .ok()?
        .strip_prefix("cursor:v2:")?
        .parse()
        .ok()
}

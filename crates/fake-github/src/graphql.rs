//! `POST /graphql`: the queries beghu makes, matched by operation name. The fake doesn't parse
//! GraphQL: each operation it knows has one fixed shape, the one beghu's import asks for
//! (crates/server/src/import.rs), and it answers with every field of it, in GitHub's shapes and
//! enum spellings. An operation it doesn't know is GitHub's error for a field that doesn't exist.
//!
//! GitHub's limits hold: a connection's `first` is at most 100 and `nodes(ids:)` takes at most
//! 100 ids, refused the way GitHub refuses them; a node the token can't see comes back `null`
//! with a `NOT_FOUND` error beside the data. Connections page on opaque cursors.
//!
//! - `ImportIssues(owner, name, states, after)`: a repo's issues in those states, oldest update
//!   first, 100 at a time, with `labels(first: 100)`, assignees, milestone, issue type, parent,
//!   the sub-issue and dependency summaries, and `relatesTo(first: 50)`.
//! - `ImportLabels(id, after)`: an issue's labels past its first 100.
//! - `ImportRelationships(ids)`: each issue's `subIssues` (in order), `blockedBy` and `blocking`.
//! - `ImportRelatesTo(id, after)`: an issue's `relatesTo` past its first 50.
//! - `ImportPullDetails(ids)`: each PR's own fields and `closingIssuesReferences(first: 50)`.
//! - `ImportClosingRefs(id, after)`: a PR's closing references past its first 50.
//! - `ImportComments(ids)`: each issue's or PR's first 100 comments.
//! - `ImportMoreComments(id, after)`: the next 100 of one item's comments.
//! - `IssueEdges(id, sub, blocks, relates, relatesAfter)`: the relationship read-backs' query
//!   (`issue_edges.rs`).
//!
//! The control port's `/state` counts the calls made with an installation token and with a
//! user's.

use crate::Fake;
use crate::api::{self, AnyToken, Token, can_see, rfc3339};
use axum::Router;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use base64::Engine as _;
use fake_db::q;
use serde::Deserialize;
use serde_json::{Value, json};

/// GitHub's ceiling on a connection's `first` and on `nodes(ids:)`.
const MAX_PAGE: i64 = 100;
/// The import asks for `relatesTo(first: 50)` and `closingIssuesReferences(first: 50)`.
const RELATES_PAGE: i64 = 50;

pub(crate) fn router() -> Router<Fake> {
    Router::new().route("/graphql", post(graphql))
}

#[derive(Deserialize)]
struct Request {
    query: String,
    #[serde(default)]
    variables: Value,
    #[serde(rename = "operationName")]
    operation_name: Option<String>,
}

/// The operation's name: `operationName`, else the first `query Name` in the document.
fn operation(r: &Request) -> Option<String> {
    if let Some(n) = &r.operation_name {
        return Some(n.clone());
    }
    let rest = r.query.trim_start().strip_prefix("query")?;
    let name: String = rest
        .trim_start()
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    (!name.is_empty()).then_some(name)
}

/// GitHub's top-level error answer: 200 with `errors` and no `data`.
fn errors(list: Vec<Value>) -> Response {
    axum::Json(json!({ "errors": list })).into_response()
}

/// The first connection in the document asking for more than GitHub's 100 records.
fn excessive_first(query: &str) -> Option<(String, i64)> {
    let mut rest = query;
    while let Some(at) = rest.find("first:") {
        let before = &rest[..at];
        let field: String = before
            .trim_end_matches(|c: char| c == '(' || c.is_whitespace())
            .chars()
            .rev()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        rest = &rest[at + "first:".len()..];
        let n: String = rest
            .trim_start()
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if let Ok(n) = n.parse::<i64>()
            && n > MAX_PAGE
        {
            return Some((field, n));
        }
    }
    None
}

fn cursor(parts: &[i64]) -> String {
    let joined: Vec<String> = parts.iter().map(i64::to_string).collect();
    base64::engine::general_purpose::STANDARD.encode(format!("cursor:v2:{}", joined.join(":")))
}

/// A cursor's numbers; `None` for one this fake didn't hand out.
fn uncursor(c: &str) -> Option<Vec<i64>> {
    let raw = base64::engine::general_purpose::STANDARD.decode(c).ok()?;
    let s = String::from_utf8(raw).ok()?;
    s.strip_prefix("cursor:v2:")?
        .split(':')
        .map(|n| n.parse().ok())
        .collect()
}

fn page_info(has_next: bool, end: Option<String>) -> Value {
    json!({ "hasNextPage": has_next, "endCursor": end })
}

fn state_enum(s: &str) -> &'static str {
    if s == "closed" { "CLOSED" } else { "OPEN" }
}

fn upper(s: Option<&str>) -> Value {
    s.map_or(Value::Null, |s| json!(s.to_uppercase()))
}

fn time(t: Option<i64>) -> Value {
    t.map_or(Value::Null, |t| json!(rfc3339(t)))
}

fn actor(c: &rusqlite::Connection, id: Option<i64>) -> rusqlite::Result<Value> {
    Ok(
        match id.map(|id| q::user_row(c, id)).transpose()?.flatten() {
            Some(u) => json!({
                "__typename": "User",
                "login": u.login,
                "avatarUrl": u.avatar_url,
                "databaseId": u.id,
            }),
            None => Value::Null,
        },
    )
}

/// What a relationship says about the issue at its other end; `None` when the token can't see it.
fn target(c: &rusqlite::Connection, token: Token, id: i64) -> rusqlite::Result<Option<Value>> {
    let t = q::target(c, id)?;
    if !can_see(c, token, t.repo_id)? {
        return Ok(None);
    }
    Ok(Some(json!({
        "__typename": if t.kind == "pr" { "PullRequest" } else { "Issue" },
        "id": t.node_id,
        "databaseId": t.id,
        "number": t.number,
        "title": t.title,
        "state": state_enum(&t.state),
        "repository": {
            "id": t.repo_node_id,
            "databaseId": t.repo_id,
            "name": t.name,
            "owner": { "login": t.owner },
            "isPrivate": t.private,
        },
    })))
}

/// The targets of `ids` the token can see, as a connection's `nodes`.
fn targets(c: &rusqlite::Connection, token: Token, ids: &[i64]) -> rusqlite::Result<Vec<Value>> {
    let mut out = Vec::new();
    for id in ids {
        if let Some(t) = target(c, token, *id)? {
            out.push(t);
        }
    }
    Ok(out)
}

/// One page of a connection over `all`: `size` nodes after `after` (a cursor this fake handed
/// out), with `totalCount` and `pageInfo`.
fn page_of(all: Vec<Value>, after: Option<&str>, size: i64) -> Value {
    let from = after
        .and_then(uncursor)
        .and_then(|p| p.first().copied())
        .map_or(0, |i| i + 1) as usize;
    let end = (from + size as usize).min(all.len());
    let nodes = all.get(from..end).unwrap_or_default().to_vec();
    let last = (end > from).then(|| cursor(&[end as i64 - 1]));
    json!({
        "totalCount": all.len(),
        "pageInfo": page_info(end < all.len(), last),
        "nodes": nodes,
    })
}

/// `relatesTo(first: 50, after)` over an issue's related issues, in id order.
fn relates_to(
    c: &rusqlite::Connection,
    token: Token,
    id: i64,
    after: Option<&str>,
) -> rusqlite::Result<Value> {
    Ok(page_of(
        targets(c, token, &q::relates_to(c, id)?)?,
        after,
        RELATES_PAGE,
    ))
}

/// `labels(first: 100, after)` of an issue.
fn labels(c: &rusqlite::Connection, id: i64, after: Option<&str>) -> rusqlite::Result<Value> {
    let all: Vec<Value> = q::issue_labels(c, id)?
        .iter()
        .map(|l| json!({ "name": l.name }))
        .collect();
    Ok(page_of(all, after, MAX_PAGE))
}

/// `closingIssuesReferences(first: 50, after)` of a PR.
fn closing(
    c: &rusqlite::Connection,
    token: Token,
    id: i64,
    after: Option<&str>,
) -> rusqlite::Result<Value> {
    Ok(page_of(
        targets(c, token, &q::closes(c, id)?)?,
        after,
        RELATES_PAGE,
    ))
}

/// An issue as `ImportIssues` asks for it.
fn issue_node(c: &rusqlite::Connection, token: Token, id: i64) -> rusqlite::Result<Value> {
    let i = q::issue(c, id)?;
    let assignees: Vec<Value> = q::issue_assignees(c, id)?
        .iter()
        .map(|u| json!({ "databaseId": u.id, "login": u.login, "avatarUrl": u.avatar_url }))
        .collect();
    let milestone = match i
        .milestone_id
        .map(|m| q::milestone(c, m))
        .transpose()?
        .flatten()
    {
        Some(m) => json!({ "number": m.number }),
        None => Value::Null,
    };
    let parent = match q::parent_of(c, id)? {
        Some(p) => target(c, token, p)?.unwrap_or(Value::Null),
        None => Value::Null,
    };
    Ok(json!({
        "id": i.node_id,
        "databaseId": i.id,
        "number": i.number,
        "title": i.title,
        "body": i.body.unwrap_or_default(),
        "state": state_enum(&i.state),
        "stateReason": upper(i.state_reason.as_deref()),
        "locked": i.locked,
        "createdAt": time(i.created_at),
        "updatedAt": time(i.updated_at),
        "closedAt": time(i.closed_at),
        "author": actor(c, i.author_id)?,
        "milestone": milestone,
        "issueType": i.issue_type.map_or(Value::Null, |t| json!({ "name": t })),
        "comments": { "totalCount": i.comments_count },
        "labels": labels(c, id, None)?,
        "assignees": { "nodes": assignees },
        "parent": parent,
        "subIssuesSummary": { "total": q::sub_issues(c, id)?.len() },
        "issueDependenciesSummary": dependencies_summary(c, id)?,
        "relatesTo": relates_to(c, token, id, None)?,
    }))
}

/// `issueDependenciesSummary`, as GitHub's schema describes it: `blockedBy` and `blocking` count
/// the open issues at the other end, `totalBlockedBy` and `totalBlocking` open and closed alike.
/// The fake answers every field; the query decides which it reads.
fn dependencies_summary(c: &rusqlite::Connection, id: i64) -> rusqlite::Result<Value> {
    let open = |ids: &[i64]| -> rusqlite::Result<usize> {
        let mut n = 0;
        for other in ids {
            if q::target(c, *other)?.state == "open" {
                n += 1;
            }
        }
        Ok(n)
    };
    let (by, blocking) = (q::blocked_by(c, id)?, q::blocking(c, id)?);
    Ok(json!({
        "blockedBy": open(&by)?,
        "blocking": open(&blocking)?,
        "totalBlockedBy": by.len(),
        "totalBlocking": blocking.len(),
    }))
}

fn comment_node(c: &rusqlite::Connection, r: &q::CommentsPageRow) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.node_id,
        "databaseId": r.id,
        "body": r.body,
        "createdAt": rfc3339(r.created_at),
        "updatedAt": rfc3339(r.updated_at),
        "author": actor(c, r.author_id)?,
    }))
}

/// `comments(first: 100, after)` of an issue or PR.
fn comments(c: &rusqlite::Connection, item: i64, after: Option<&str>) -> rusqlite::Result<Value> {
    let (at, id) = match after.and_then(uncursor).as_deref() {
        Some([at, id]) => (*at, *id),
        _ => (i64::MIN, i64::MIN),
    };
    let mut rows = q::comments_page(c, item, at, id, MAX_PAGE + 1)?;
    let more = rows.len() as i64 > MAX_PAGE;
    rows.truncate(MAX_PAGE as usize);
    let end = rows.last().map(|r| cursor(&[r.created_at, r.id]));
    let nodes = rows
        .iter()
        .map(|r| comment_node(c, r))
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({
        "totalCount": q::comment_count(c, item)?,
        "pageInfo": page_info(more, end),
        "nodes": nodes,
    }))
}

/// The item a node id names, if the token can see it.
fn node(
    c: &rusqlite::Connection,
    token: Token,
    node_id: &str,
) -> rusqlite::Result<Option<q::ItemByNodeRow>> {
    let Some(item) = q::item_by_node(c, node_id)? else {
        return Ok(None);
    };
    Ok(can_see(c, token, item.repo_id)?.then_some(item))
}

fn not_found(id: &str, path: Vec<Value>) -> Value {
    json!({
        "type": "NOT_FOUND",
        "path": path,
        "locations": [],
        "message": format!("Could not resolve to a node with the global id of '{id}'"),
    })
}

/// `nodes(ids:)`: each id the token can see through `f`, else null and a NOT_FOUND error.
fn each_node(
    c: &rusqlite::Connection,
    token: Token,
    ids: &[String],
    errs: &mut Vec<Value>,
    f: &mut dyn FnMut(&q::ItemByNodeRow) -> rusqlite::Result<Value>,
) -> rusqlite::Result<Value> {
    let mut out = Vec::new();
    for (i, id) in ids.iter().enumerate() {
        match node(c, token, id)? {
            Some(item) => out.push(f(&item)?),
            None => {
                out.push(Value::Null);
                errs.push(not_found(id, vec![json!("nodes"), json!(i)]));
            }
        }
    }
    Ok(Value::Array(out))
}

/// What one operation answers: its `data`, and errors to send beside it.
type Answer = (Value, Vec<Value>);

fn run(
    c: &rusqlite::Connection,
    token: Token,
    op: &str,
    v: &Value,
) -> rusqlite::Result<Result<Answer, String>> {
    let str_var = |k: &str| v[k].as_str().map(str::to_owned);
    let ids: Vec<String> = v["ids"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|i| i.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let mut errs = Vec::new();
    let data = match op {
        "ImportIssues" => {
            let (Some(owner), Some(name)) = (str_var("owner"), str_var("name")) else {
                return Ok(Err("Variable $owner and $name are required".into()));
            };
            let Some(repo) =
                q::repo_named(c, &owner, &name)?.filter(|r| can_see(c, token, *r).unwrap_or(false))
            else {
                return Ok(Ok((
                    json!({ "repository": null }),
                    vec![json!({
                        "type": "NOT_FOUND",
                        "path": ["repository"],
                        "locations": [],
                        "message": format!("Could not resolve to a Repository with the name '{owner}/{name}'."),
                    })],
                )));
            };
            let state = match v["states"]
                .as_array()
                .and_then(|s| s.first())
                .and_then(Value::as_str)
            {
                Some("CLOSED") => "closed",
                _ => "open",
            };
            let (at, id) = match str_var("after").as_deref().and_then(uncursor).as_deref() {
                Some([at, id]) => (*at, *id),
                _ => (i64::MIN, i64::MIN),
            };
            let mut rows = q::items_page(c, repo, "issue", state, at, id, MAX_PAGE + 1)?;
            let more = rows.len() as i64 > MAX_PAGE;
            rows.truncate(MAX_PAGE as usize);
            let mut nodes = Vec::new();
            let mut end = None;
            for id in &rows {
                let n = issue_node(c, token, *id)?;
                let updated = q::issue(c, *id)?.updated_at.unwrap_or(0);
                end = Some(cursor(&[updated, *id]));
                nodes.push(n);
            }
            json!({ "repository": { "issues": { "pageInfo": page_info(more, end), "nodes": nodes } } })
        }
        "ImportRelationships" => {
            let nodes = each_node(c, token, &ids, &mut errs, &mut |item| {
                Ok(json!({
                    "__typename": "Issue",
                    "id": q::target(c, item.id)?.node_id,
                    "subIssues": { "nodes": targets(c, token, &q::sub_issues(c, item.id)?)? },
                    "blockedBy": { "nodes": targets(c, token, &q::blocked_by(c, item.id)?)? },
                    "blocking": { "nodes": targets(c, token, &q::blocking(c, item.id)?)? },
                }))
            })?;
            json!({ "nodes": nodes })
        }
        "ImportRelatesTo" => {
            let Some(id) = str_var("id") else {
                return Ok(Err("Variable $id is required".into()));
            };
            match node(c, token, &id)? {
                Some(item) => json!({ "node": {
                    "__typename": "Issue",
                    "id": id,
                    "relatesTo": relates_to(c, token, item.id, str_var("after").as_deref())?,
                } }),
                None => {
                    errs.push(not_found(&id, vec![json!("node")]));
                    json!({ "node": null })
                }
            }
        }
        "ImportPullDetails" => {
            let nodes = each_node(c, token, &ids, &mut errs, &mut |item| {
                if item.kind != "pr" {
                    return Ok(
                        json!({ "__typename": "Issue", "id": q::target(c, item.id)?.node_id }),
                    );
                }
                let p = q::pr_details(c, item.id)?;
                Ok(json!({
                    "__typename": "PullRequest",
                    "id": q::target(c, item.id)?.node_id,
                    "databaseId": p.pr_id,
                    "isDraft": p.draft.unwrap_or(false),
                    "mergedAt": time(p.merged_at),
                    "headRefName": p.head_ref,
                    "baseRefName": p.base_ref,
                    "reviewDecision": upper(p.review_decision.as_deref()),
                    "closingIssuesReferences": closing(c, token, item.id, None)?,
                }))
            })?;
            json!({ "nodes": nodes })
        }
        "ImportLabels" => {
            let Some(id) = str_var("id") else {
                return Ok(Err("Variable $id is required".into()));
            };
            match node(c, token, &id)? {
                Some(item) => json!({ "node": {
                    "__typename": "Issue",
                    "id": id,
                    "labels": labels(c, item.id, str_var("after").as_deref())?,
                } }),
                None => {
                    errs.push(not_found(&id, vec![json!("node")]));
                    json!({ "node": null })
                }
            }
        }
        "ImportClosingRefs" => {
            let Some(id) = str_var("id") else {
                return Ok(Err("Variable $id is required".into()));
            };
            match node(c, token, &id)? {
                Some(item) => json!({ "node": {
                    "__typename": "PullRequest",
                    "id": id,
                    "closingIssuesReferences": closing(c, token, item.id, str_var("after").as_deref())?,
                } }),
                None => {
                    errs.push(not_found(&id, vec![json!("node")]));
                    json!({ "node": null })
                }
            }
        }
        "ImportComments" => {
            let nodes = each_node(c, token, &ids, &mut errs, &mut |item| {
                Ok(json!({
                    "__typename": if item.kind == "pr" { "PullRequest" } else { "Issue" },
                    "id": q::target(c, item.id)?.node_id,
                    "comments": comments(c, item.id, None)?,
                }))
            })?;
            json!({ "nodes": nodes })
        }
        "ImportMoreComments" => {
            let Some(id) = str_var("id") else {
                return Ok(Err("Variable $id is required".into()));
            };
            match node(c, token, &id)? {
                Some(item) => json!({ "node": {
                    "__typename": if item.kind == "pr" { "PullRequest" } else { "Issue" },
                    "id": id,
                    "comments": comments(c, item.id, str_var("after").as_deref())?,
                } }),
                None => {
                    errs.push(not_found(&id, vec![json!("node")]));
                    json!({ "node": null })
                }
            }
        }
        other => {
            return Ok(Err(format!(
                "Field '{other}' doesn't exist on type 'Query'"
            )));
        }
    };
    Ok(Ok((data, errs)))
}

async fn graphql(
    State(fake): State<Fake>,
    AnyToken(token): AnyToken,
    body: axum::body::Bytes,
) -> Response {
    let Ok(req) = serde_json::from_slice::<Request>(&body) else {
        return api::error(axum::http::StatusCode::BAD_REQUEST, "Problems parsing JSON");
    };
    if let Some((field, n)) = excessive_first(&req.query) {
        return errors(vec![json!({
            "type": "EXCESSIVE_PAGINATION",
            "locations": [],
            "message": format!("Requesting {n} records on the `{field}` connection exceeds the `first` limit of 100 records."),
        })]);
    }
    if req.variables["ids"]
        .as_array()
        .is_some_and(|a| a.len() as i64 > MAX_PAGE)
    {
        return errors(vec![json!({
            "type": "EXCESSIVE_PAGINATION",
            "locations": [],
            "message": "You may not request more than 100 node IDs; for example, `nodes(ids: [...])`.",
        })]);
    }
    let Some(op) = operation(&req) else {
        return errors(vec![
            json!({ "message": "A query attribute must be specified and must be a string." }),
        ]);
    };
    let calls = &fake.state().graphql;
    match token {
        Token::Installation(_) => &calls.installation,
        Token::User(_) => &calls.user,
    }
    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let vars = req.variables.clone();
    if op == "IssueEdges" {
        let done = fake
            .state()
            .truth
            .read(move |c| crate::issue_edges::issue_edges(c, token, &vars))
            .await;
        return match done {
            Ok(answer) => axum::Json(answer).into_response(),
            Err(e) => api::internal(e),
        };
    }
    let answer = fake
        .state()
        .truth
        .read(move |c| run(c, token, &op, &vars))
        .await;
    match answer {
        Ok(Ok((data, errs))) if errs.is_empty() => {
            axum::Json(json!({ "data": data })).into_response()
        }
        Ok(Ok((data, errs))) => axum::Json(json!({ "data": data, "errors": errs })).into_response(),
        Ok(Err(why)) => errors(vec![json!({ "message": why, "locations": [] })]),
        Err(e) => api::internal(e),
    }
}

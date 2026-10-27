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
//! - `PullReadBack(id, after)`: one PR's own fields and a page of 50 of its closing references,
//!   the PR read-back's query (crates/server/src/pulls.rs).
//! - `IssueLinkedPulls(id, after)`: a page of 50 of an issue's `closedByPullRequestsReferences`
//!   (closed, unmerged PRs only with `includeClosedPrs: true`, as beghu asks; GitHub's default
//!   leaves them out), the issue-side linked-PR read-back's query (crates/server/src/pulls.rs).
//! - `ImportComments(ids)`: each issue's or PR's first 100 comments.
//! - `ImportMoreComments(id, after)`: the next 100 of one item's comments.
//! - `IssueEdges(id, sub, blocks, relates, relatesAfter)`: the relationship read-backs' query
//!   (`issue_edges.rs`).
//! - The sweeps' queries: `SweepCounts(ids)`, each repo's `issues` and `pullRequests`
//!   `totalCount` (every state, as GitHub counts them); `SweepIssueIds(owner, name, after)` and
//!   `SweepPullIds(owner, name, after)`, a repo's issue or PR database ids, 100 at a time; and
//!   `SweepEdges(ids, sub, blocks, relates)`, `IssueEdges` for up to 100 issues at once, each
//!   with its `number` (relates-to its first page of 100).
//!
//! The control port's `/state` counts the calls made with an installation token and with a
//! user's, and the calls of each operation.
//!
//! Each query spends GitHub's documented cost of it from the caller's quota ([`cost`]).

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

/// Whether the document asks `closedByPullRequestsReferences` for closed PRs too
/// (`includeClosedPrs: true`, literal or through a variable); GitHub's default is false.
fn include_closed_prs(query: &str, vars: &Value) -> bool {
    let Some((_, rest)) = query.split_once("includeClosedPrs:") else {
        return false;
    };
    let arg: String = rest
        .trim_start()
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
        .collect();
    match arg.strip_prefix('$') {
        Some(var) => vars[var].as_bool().unwrap_or(false),
        None => arg == "true",
    }
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

/// GitHub's documented cost of a query, in points
/// (`/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api`;
/// docs/research/github-app-mechanics.md §1): add up the requests each connection makes, a
/// connection nested in another making one for each record the outer one may return (its
/// `first` or `last` as asked, as if it were maxed), divide by 100, round, at least 1. The fake
/// reads the query only this far: a connection is a field asked with `first`, `last` or `ids`
/// (`nodes(ids:)`, as many records as ids), or one selecting its `totalCount`; `@include` and
/// `@skip` are honoured, and fragments are followed.
pub(crate) fn cost(query: &str, vars: &Value) -> i64 {
    let tokens = lex(query);
    let mut fragments: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut operation = None;
    let mut i = 0;
    while i < tokens.len() {
        if tokens[i] == "fragment" && i + 1 < tokens.len() {
            let name = tokens[i + 1].clone();
            let Some(open) = tokens[i..].iter().position(|t| t == "{") else {
                break;
            };
            fragments.insert(name, i + open);
            i = skip_block(&tokens, i + open);
        } else if tokens[i] == "{" {
            operation.get_or_insert(i);
            i = skip_block(&tokens, i);
        } else {
            i += 1;
        }
    }
    let Some(start) = operation else { return 1 };
    let walk = Walk {
        tokens: &tokens,
        vars,
        fragments: &fragments,
    };
    let requests = walk.selection(start, 1, 0).0;
    ((requests as f64 / 100.0).round() as i64).max(1)
}

/// A query's tokens: names, numbers, `$`-variables, strings and punctuation; commas and comments
/// dropped.
fn lex(query: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = query.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '#' => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            '"' => {
                let mut s = String::from('"');
                while let Some(c) = chars.next() {
                    s.push(c);
                    if c == '\\' {
                        if let Some(n) = chars.next() {
                            s.push(n);
                        }
                    } else if c == '"' {
                        break;
                    }
                }
                out.push(s);
            }
            '.' => {
                while chars.peek() == Some(&'.') {
                    chars.next();
                }
                out.push("...".into());
            }
            c if c.is_alphanumeric() || c == '_' || c == '$' || c == '-' => {
                let mut s = String::from(c);
                while let Some(&n) = chars.peek() {
                    if n.is_alphanumeric() || n == '_' {
                        s.push(n);
                        chars.next();
                    } else {
                        break;
                    }
                }
                out.push(s);
            }
            c if c.is_whitespace() || c == ',' => {}
            c => out.push(c.to_string()),
        }
    }
    out
}

/// The index just past the bracketed block (`{…}`, `(…)` or `[…]`) opening at `at`.
fn skip_block(tokens: &[String], at: usize) -> usize {
    let mut depth = 0;
    for (i, t) in tokens.iter().enumerate().skip(at) {
        match t.as_str() {
            "{" | "(" | "[" => depth += 1,
            "}" | ")" | "]" => {
                depth -= 1;
                if depth == 0 {
                    return i + 1;
                }
            }
            _ => {}
        }
    }
    tokens.len()
}

struct Walk<'a> {
    tokens: &'a [String],
    vars: &'a Value,
    fragments: &'a std::collections::HashMap<String, usize>,
}

impl Walk<'_> {
    /// A value token as a number: a literal, or a variable's.
    fn number(&self, t: &str) -> Option<i64> {
        match t.strip_prefix('$') {
            Some(v) => self.vars[v].as_i64(),
            None => t.parse().ok(),
        }
    }

    /// A value token as a boolean: a literal, or a variable's.
    fn boolean(&self, t: &str) -> bool {
        match t.strip_prefix('$') {
            Some(v) => self.vars[v].as_bool().unwrap_or(false),
            None => t == "true",
        }
    }

    /// The requests the selection set opening at `at` makes, `mult` times over; and where it ends.
    fn selection(&self, at: usize, mult: i64, depth: usize) -> (i64, usize) {
        let t = self.tokens;
        let end = skip_block(t, at);
        if depth > 32 {
            return (0, end);
        }
        let mut requests = 0;
        let mut i = at + 1;
        while i < end - 1 {
            if t[i] == "..." {
                if t.get(i + 1).is_some_and(|n| n == "on") {
                    // An inline fragment: its type, then its selection.
                    let open = i + 3;
                    let (r, next) = self.selection(open, mult, depth + 1);
                    requests += r;
                    i = next;
                } else {
                    if let Some(open) = t.get(i + 1).and_then(|n| self.fragments.get(n)) {
                        requests += self.selection(*open, mult, depth + 1).0;
                    }
                    i += 2;
                }
                continue;
            }
            // A field: `alias: name`, then its arguments, directives and selection.
            i += 1;
            if t.get(i).is_some_and(|x| x == ":") {
                i += 2;
            }
            let mut size = None;
            let mut has_ids = false;
            if t.get(i).is_some_and(|x| x == "(") {
                let close = skip_block(t, i);
                let mut j = i + 1;
                while j + 2 < close {
                    if t[j + 1] == ":" {
                        match t[j].as_str() {
                            "first" | "last" => size = self.number(&t[j + 2]),
                            "ids" => {
                                has_ids = true;
                                size = Some(match t[j + 2].strip_prefix('$') {
                                    Some(v) => self.vars[v].as_array().map_or(0, Vec::len) as i64,
                                    None => {
                                        let list_end = skip_block(t, j + 2);
                                        (list_end - j - 4) as i64
                                    }
                                });
                            }
                            _ => {}
                        }
                    }
                    j += 1;
                }
                i = close;
            }
            let mut included = true;
            while t.get(i).is_some_and(|x| x == "@") {
                let name = t.get(i + 1).cloned().unwrap_or_default();
                let value = t.get(i + 5).cloned().unwrap_or_default();
                let on = self.boolean(&value);
                included &= if name == "skip" { !on } else { on };
                i += 2;
                if t.get(i).is_some_and(|x| x == "(") {
                    i = skip_block(t, i);
                }
            }
            if !t.get(i).is_some_and(|x| x == "{") {
                continue;
            }
            let close = skip_block(t, i);
            if !included {
                i = close;
                continue;
            }
            // Asked with `first`, `last` or `ids`, or a count of one (`issues { totalCount }`).
            let connection = size.is_some() || has_ids || {
                let mut depth = 0;
                t[i + 1..close - 1].iter().any(|x| {
                    match x.as_str() {
                        "{" | "(" | "[" => depth += 1,
                        "}" | ")" | "]" => depth -= 1,
                        _ => {}
                    }
                    depth == 0 && x == "totalCount"
                })
            };
            if connection {
                requests += mult;
                requests += self
                    .selection(i, mult * size.unwrap_or(1).max(1), depth + 1)
                    .0;
            } else {
                requests += self.selection(i, mult, depth + 1).0;
            }
            i = close;
        }
        (requests, end)
    }
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

/// `closedByPullRequestsReferences(first: 50, after, includeClosedPrs)` of an issue: the PRs
/// the token can see that close it (open or merged, and closed unmerged ones only with
/// `include_closed`), each a `PullRequest` (whose `databaseId` is the PR's own id, not the
/// issue-side one) with its number and repository.
fn closed_by(
    c: &rusqlite::Connection,
    token: Token,
    id: i64,
    after: Option<&str>,
    include_closed: bool,
) -> rusqlite::Result<Value> {
    let mut all = Vec::new();
    for pr in q::closed_by(c, id)? {
        let t = q::target(c, pr)?;
        if !can_see(c, token, t.repo_id)? {
            continue;
        }
        let p = q::pr_details(c, pr)?;
        if !include_closed && t.state == "closed" && p.merged_at.is_none() {
            continue;
        }
        all.push(json!({
            "__typename": "PullRequest",
            "id": t.node_id,
            "databaseId": p.pr_id,
            "number": t.number,
            "title": t.title,
            "state": if p.merged_at.is_some() { "MERGED" } else { state_enum(&t.state) },
            "repository": {
                "id": t.repo_node_id,
                "databaseId": t.repo_id,
                "name": t.name,
                "owner": { "login": t.owner },
                "isPrivate": t.private,
            },
        }));
    }
    Ok(page_of(all, after, RELATES_PAGE))
}

/// A PR's own fields and a page of its closing references (after `after`), as
/// `ImportPullDetails` and `PullReadBack` ask for them; an issue under `... on PullRequest` has
/// only its type and id.
fn pull_details(
    c: &rusqlite::Connection,
    token: Token,
    item: &q::ItemByNodeRow,
    after: Option<&str>,
) -> rusqlite::Result<Value> {
    let node_id = q::target(c, item.id)?.node_id;
    if item.kind != "pr" {
        return Ok(json!({ "__typename": "Issue", "id": node_id }));
    }
    let p = q::pr_details(c, item.id)?;
    Ok(json!({
        "__typename": "PullRequest",
        "id": node_id,
        "databaseId": p.pr_id,
        "isDraft": p.draft.unwrap_or(false),
        "mergedAt": time(p.merged_at),
        "headRefName": p.head_ref,
        "baseRefName": p.base_ref,
        "reviewDecision": upper(p.review_decision.as_deref()),
        "closingIssuesReferences": closing(c, token, item.id, after)?,
    }))
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
    include_closed: bool,
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
        "SweepCounts" => {
            let mut nodes = Vec::new();
            for (i, id) in ids.iter().enumerate() {
                match q::repo_by_node(c, id)?.filter(|r| can_see(c, token, *r).unwrap_or(false)) {
                    Some(repo) => nodes.push(json!({
                        "__typename": "Repository",
                        "id": id,
                        "databaseId": repo,
                        "issues": { "totalCount": q::item_count(c, repo, "issue")? },
                        "pullRequests": { "totalCount": q::item_count(c, repo, "pr")? },
                    })),
                    None => {
                        nodes.push(Value::Null);
                        errs.push(not_found(id, vec![json!("nodes"), json!(i)]));
                    }
                }
            }
            json!({ "nodes": nodes })
        }
        "SweepIssueIds" | "SweepPullIds" => {
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
            let (kind, field) = if op == "SweepIssueIds" {
                ("issue", "issues")
            } else {
                ("pr", "pullRequests")
            };
            let after = match str_var("after").as_deref().and_then(uncursor).as_deref() {
                Some([id]) => *id,
                _ => i64::MIN,
            };
            let mut rows = q::item_ids_page(c, repo, kind, after, MAX_PAGE + 1)?;
            let more = rows.len() as i64 > MAX_PAGE;
            rows.truncate(MAX_PAGE as usize);
            let end = rows.last().map(|id| cursor(&[*id]));
            let mut nodes = Vec::new();
            for id in &rows {
                // A PR's own database id, as GitHub's `PullRequest.databaseId` is.
                let database_id = if kind == "pr" {
                    q::pr_details(c, *id)?.pr_id
                } else {
                    Some(*id)
                };
                nodes.push(json!({ "databaseId": database_id }));
            }
            json!({ "repository": { field: {
                "totalCount": q::item_count(c, repo, kind)?,
                "pageInfo": page_info(more, end),
                "nodes": nodes,
            } } })
        }
        "SweepEdges" => {
            let nodes = each_node(c, token, &ids, &mut errs, &mut |item| {
                let mut n = crate::issue_edges::edges_node(c, token, item.id, v)?;
                let t = q::target(c, item.id)?;
                n["id"] = json!(t.node_id);
                n["number"] = json!(t.number);
                Ok(n)
            })?;
            json!({ "nodes": nodes })
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
                pull_details(c, token, item, None)
            })?;
            json!({ "nodes": nodes })
        }
        "PullReadBack" => {
            let Some(id) = str_var("id") else {
                return Ok(Err("Variable $id is required".into()));
            };
            match node(c, token, &id)? {
                Some(item) => {
                    json!({ "node": pull_details(c, token, &item, str_var("after").as_deref())? })
                }
                None => {
                    errs.push(not_found(&id, vec![json!("node")]));
                    json!({ "node": null })
                }
            }
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
        "IssueLinkedPulls" => {
            let Some(id) = str_var("id") else {
                return Ok(Err("Variable $id is required".into()));
            };
            match node(c, token, &id)? {
                Some(item) if item.kind != "pr" => json!({ "node": {
                    "__typename": "Issue",
                    "closedByPullRequestsReferences":
                        closed_by(c, token, item.id, str_var("after").as_deref(), include_closed)?,
                } }),
                // `... on Issue` selects nothing of a PR.
                Some(_) => json!({ "node": { "__typename": "PullRequest" } }),
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
    let cost = crate::quota::Cost(cost(&req.query, &req.variables));
    let calls = &fake.state().graphql;
    match token {
        Token::Installation(_) => &calls.installation,
        Token::User(_) => &calls.user,
    }
    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    calls.count(&op);
    let vars = req.variables.clone();
    if op == "IssueEdges" {
        let done = fake
            .state()
            .truth
            .read(move |c| crate::issue_edges::issue_edges(c, token, &vars))
            .await;
        let mut res = match done {
            Ok(answer) => axum::Json(answer).into_response(),
            Err(e) => api::internal(e),
        };
        res.extensions_mut().insert(cost);
        return res;
    }
    let include_closed = include_closed_prs(&req.query, &req.variables);
    let answer = fake
        .state()
        .truth
        .read(move |c| run(c, token, &op, &vars, include_closed))
        .await;
    let mut res = match answer {
        Ok(Ok((data, errs))) if errs.is_empty() => {
            axum::Json(json!({ "data": data })).into_response()
        }
        Ok(Ok((data, errs))) => axum::Json(json!({ "data": data, "errors": errs })).into_response(),
        Ok(Err(why)) => errors(vec![json!({ "message": why, "locations": [] })]),
        Err(e) => api::internal(e),
    };
    res.extensions_mut().insert(cost);
    res
}

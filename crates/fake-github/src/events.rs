//! Each repo's issue events feed, `GET /repos/{owner}/{repo}/issues/events`: what happened to the
//! repo's issues and PRs, newest first, paged as GitHub pages its lists (`per_page`, `page`,
//! `Link`). The quota middleware tags each answer with an ETag, so a reader asking again with it
//! gets a 304 while nothing new happened. Each event carries GitHub's fields (`id`, `node_id`,
//! `url`, `actor`, `event`, `commit_id`, `commit_url`, `created_at`, `performed_via_github_app`)
//! and the `issue` it happened to, as REST serialises it.
//!
//! What the fake records (docs/research/github-relationship-apis.md, "Timeline and repo issue
//! events"), each in the feed of the repo whose issue it is:
//!
//! - `sub_issue_added`/`_removed` on the parent and `parent_issue_added`/`_removed` on the child,
//!   each naming the other end as `sub_issue` or `parent_issue`: its number, title, state, state
//!   reason, type and repository, but no id;
//! - `blocked_by_added`/`_removed` on the blocked issue and `blocking_added`/`_removed` on the
//!   blocker, naming the other end the same way as `blocked_by` or `blocking`;
//! - `relates_to_added`/`_removed` on both issues, naming nothing else;
//! - `connected`/`disconnected` on both the PR and the issue when one is linked to the other in
//!   GitHub's Development sidebar (which sends no webhook), naming nothing else;
//! - `closed` and `reopened`.
//!
//! GitHub doesn't promise that a feed's ids follow its order, and its feed can show an event late,
//! behind newer ones (the research saw it trail by tens of seconds). Here ids are a fixed shuffle
//! of the order events happened in, so a reader that keeps a high-water mark instead of the ids
//! it has seen loses the events whose ids come out lower.
//!
//! The control port's `/state` counts each feed's reads, and how many of them were 304s
//! (`feeds`).

use crate::Fake;
use crate::api::{self, AnyToken, can_see, rfc3339};
use crate::webhooks::{issue_json, repo_json, user_json};
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use fake_db::q;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Mutex;

pub(crate) fn router() -> Router<Fake> {
    Router::new().route("/repos/{owner}/{repo}/issues/events", get(feed))
}

/// The id of the `seq`th event: a fixed shuffle of the order, so ids rise and fall along the
/// feed.
fn event_id(seq: i64) -> i64 {
    const BASE: i64 = 30_000_000_000;
    // 7919 and 10,007 are prime: every seq below 10,007 gets an id of its own.
    BASE + (seq * 7919 % 10_007) * 1000 + seq / 10_007
}

/// Records `event` on issue `issue`, in its repo's feed, by `actor`; `other` is the issue a
/// sub-issue or dependency event names.
pub(crate) fn record(
    c: &Connection,
    issue: i64,
    event: &str,
    actor: Option<i64>,
    other: Option<i64>,
    at: i64,
) -> rusqlite::Result<()> {
    let repo = q::issue(c, issue)?.repo_id;
    let seq = q::next_event_seq(c)?;
    q::add_event(c, seq, event_id(seq), repo, issue, event, actor, other, at)?;
    Ok(())
}

/// The other end of a sub-issue or dependency event, as the feed names it: no id, only what the
/// research saw (`number`, `title`, `state`, `state_reason`, `issue_type`, `repository`).
fn named(c: &Connection, id: i64) -> rusqlite::Result<Value> {
    let i = q::issue(c, id)?;
    let r = q::repo(c, i.repo_id)?;
    Ok(json!({
        "number": i.number,
        "title": i.title,
        "state": i.state,
        "state_reason": i.state_reason,
        "issue_type": i.issue_type.as_deref().map_or(Value::Null, crate::webhooks::issue_type_json),
        "repository": repo_json(&r),
    }))
}

/// The key a sub-issue or dependency event names its other end under.
fn other_key(event: &str) -> Option<&'static str> {
    let stem = event
        .strip_suffix("_added")
        .or_else(|| event.strip_suffix("_removed"))?;
    Some(match stem {
        "sub_issue" => "sub_issue",
        "parent_issue" => "parent_issue",
        "blocked_by" => "blocked_by",
        "blocking" => "blocking",
        _ => return None,
    })
}

fn event_json(c: &Connection, full: &str, e: &q::RepoEventsRow) -> rusqlite::Result<Value> {
    let actor = match e.actor_id.map(|a| q::user_row(c, a)).transpose()?.flatten() {
        Some(u) => user_json(u.id, &u.login, u.avatar_url.as_deref()),
        None => Value::Null,
    };
    let mut v = json!({
        "id": e.id,
        "node_id": format!("IE_kw{}", e.id),
        "url": format!("https://api.github.com/repos/{full}/issues/events/{}", e.id),
        "actor": actor,
        "event": e.event,
        "commit_id": null,
        "commit_url": null,
        "created_at": rfc3339(e.created_at),
        "performed_via_github_app": null,
        "issue": issue_json(c, e.issue_id)?,
    });
    if let (Some(key), Some(other)) = (other_key(&e.event), e.other_id) {
        v[key] = named(c, other)?;
    }
    Ok(v)
}

#[derive(Deserialize)]
struct Params {
    per_page: Option<i64>,
    page: Option<i64>,
}

async fn feed(
    State(fake): State<Fake>,
    AnyToken(token): AnyToken,
    headers: HeaderMap,
    Path((owner, name)): Path<(String, String)>,
    Query(p): Query<Params>,
) -> Response {
    let per_page = p.per_page.unwrap_or(30).clamp(1, 100);
    let page = p.page.unwrap_or(1).max(1);
    let full = format!("{owner}/{name}");
    let read = fake
        .state()
        .truth
        .read(move |c| {
            let Some(repo) = q::repo_named(c, &owner, &name)? else {
                return Ok(None);
            };
            if !can_see(c, token, repo)? {
                return Ok(None);
            }
            let rows = q::repo_events(c, repo, per_page, (page - 1) * per_page)?;
            let full = format!("{owner}/{name}");
            rows.iter()
                .map(|e| event_json(c, &full, e))
                .collect::<rusqlite::Result<Vec<_>>>()
                .map(Some)
        })
        .await;
    let items = match read {
        Ok(Some(items)) => items,
        Ok(None) => return api::not_found().await,
        Err(e) => return api::internal(e),
    };
    let more = items.len() as i64 == per_page;
    let mut res = axum::Json(Value::Array(items)).into_response();
    if more {
        let host = headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost");
        let link = format!(
            "<http://{host}/repos/{full}/issues/events?per_page={per_page}&page={}>; rel=\"next\"",
            page + 1
        );
        if let Ok(v) = HeaderValue::from_str(&link) {
            res.headers_mut().insert(header::LINK, v);
        }
    }
    res
}

/// How often each feed was read since the start (or the last reset), and how many of those
/// reads were answered 304.
#[derive(Default)]
pub(crate) struct Reads(Mutex<BTreeMap<String, FeedReads>>);

#[derive(Default, Clone, Serialize)]
pub(crate) struct FeedReads {
    reads: u64,
    not_modified: u64,
}

impl Reads {
    /// Counts a read of `path` if it's a feed's, keyed `owner/repo`.
    pub(crate) fn count(&self, path: &str, not_modified: bool) {
        let Some(full) = path
            .strip_prefix("/repos/")
            .and_then(|p| p.strip_suffix("/issues/events"))
        else {
            return;
        };
        let mut all = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let r = all.entry(full.to_owned()).or_default();
        r.reads += 1;
        r.not_modified += u64::from(not_modified);
    }

    pub(crate) fn snapshot(&self) -> Value {
        json!(*self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }

    pub(crate) fn clear(&self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

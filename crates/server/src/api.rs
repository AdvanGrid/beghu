//! The JSON API this slice serves: `/api/me` and the issue list, filtered and sorted by the
//! filter bar's query (`q`, see `query.rs`); the bar's suggestions are in `facets.rs`. Every response is
//! `no-store` and carries `X-Beghu-Build` (see `lib.rs`). The wire types are exported to the web
//! app as TypeScript by ts-rs (`cargo test` writes `web/src/bindings/`).

use crate::auth::Session;
use crate::error::ApiError;
use crate::{App, query, repos};
use axum::Json;
use axum::extract::{Extension, Query, State};
use mirror_db::list;
use mirror_db::{Caller, q};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use ts_rs::TS;

/// One page of the list.
pub const PAGE: i64 = 100;
/// The most rows a live refetch (`through=`) returns: far more than a tab loads by scrolling.
/// A tab that has scrolled past it gets the first 10,000 rows with `next` set, as any page that
/// stops short would, so its list shrinks to them and the rows beyond load again as it scrolls.
pub const THROUGH_MAX: i64 = 10_000;

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Me {
    pub account: Account,
    /// Every account signed in on this browser, in sign-in order.
    pub accounts: Vec<Account>,
    pub comment_order: CommentOrder,
    /// The synced repos and the account's role on each.
    pub repos: Vec<Repo>,
}

#[derive(Serialize, TS, Clone)]
#[ts(export)]
pub struct Account {
    pub id: i64,
    pub login: String,
}

#[derive(Serialize, TS, Clone, Copy)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum CommentOrder {
    Newest,
    Oldest,
}

impl std::str::FromStr for CommentOrder {
    type Err = ApiError;

    /// `newest` or `oldest`, as on the wire.
    fn from_str(s: &str) -> Result<CommentOrder, ApiError> {
        match s {
            "newest" => Ok(CommentOrder::Newest),
            "oldest" => Ok(CommentOrder::Oldest),
            _ => Err(ApiError::BadRequest(format!("bad order {s:?}"))),
        }
    }
}

impl CommentOrder {
    /// The account's stored preference. None means newest first, and so does one this build
    /// doesn't know (written by a newer build): a preference never fails a read.
    pub fn from_pref(pref: Option<&str>) -> CommentOrder {
        pref.and_then(|p| p.parse().ok())
            .unwrap_or(CommentOrder::Newest)
    }
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Repo {
    pub id: i64,
    pub owner: String,
    pub name: String,
    pub private: bool,
    /// GitHub's role: `read`, `triage`, `write`, `maintain` or `admin`. `null` until read.
    pub role: Option<String>,
    pub archived: bool,
}

pub async fn me(
    State(app): State<App>,
    Extension(s): Extension<Session>,
) -> Result<Json<Me>, ApiError> {
    repos::refresh_roles_if_stale(&app, s.account).await?;
    let (account, hash) = (s.account, s.id_hash.clone());
    let (row, accounts) = app
        .control()
        .read(move |c| {
            Ok((
                control_db::q::account(c, account)?,
                control_db::q::session_accounts(c, &hash)?,
            ))
        })
        .await?;
    let row = row.ok_or(ApiError::SignedOut)?;
    let repos = app
        .mirrors()
        .read(s.account, Caller::Request, |c| q::synced_repos(c))
        .await?;
    Ok(Json(Me {
        account: Account {
            id: row.github_user_id,
            login: row.login,
        },
        accounts: accounts
            .into_iter()
            .map(|a| Account {
                id: a.github_user_id,
                login: a.login,
            })
            .collect(),
        comment_order: CommentOrder::from_pref(row.comment_order.as_deref()),
        repos: repos
            .into_iter()
            .map(|r| Repo {
                id: r.id,
                owner: r.owner,
                name: r.name,
                private: r.private,
                role: r.role,
                archived: r.archived,
            })
            .collect(),
    }))
}

/// A page of the list, and where the next one starts.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct IssuePage {
    pub rows: Vec<IssueRow>,
    /// Pass as `after` for the next page; `null` on the last one.
    pub next: Option<String>,
    /// The last row's cursor, in the view's sort: pass as `through` to refetch the view from the
    /// top through this row. `null` with no rows.
    pub last: Option<String>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct IssueRow {
    pub id: i64,
    /// `issue` or `pr`.
    pub kind: String,
    pub owner: String,
    pub repo: String,
    pub number: i64,
    pub title: String,
    /// `open` or `closed`.
    pub state: String,
    /// `completed`, `not_planned`, … once closed.
    pub state_reason: Option<String>,
    /// Unix seconds.
    pub created_at: i64,
    /// Unix seconds.
    pub updated_at: i64,
    /// Unix seconds; `null` if it was never closed.
    pub closed_at: Option<i64>,
    /// When the last comment came, in Unix seconds; `null` with no comments.
    pub commented_at: Option<i64>,
    pub comments: i64,
    /// The GitHub issue type's name; `null` when untyped, and always for a PR.
    pub issue_type: Option<String>,
    pub labels: Vec<Label>,
    pub assignees: Vec<User>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Label {
    pub name: String,
    /// GitHub's hex colour, without `#`.
    pub color: String,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct User {
    pub login: String,
}

#[derive(Deserialize)]
pub struct ListQuery {
    /// The filter bar's query; absent means the Open preset.
    q: Option<String>,
    /// The next page: the rows after this cursor.
    after: Option<String>,
    /// A live refetch: the rows from the top through this cursor (the last row the tab shows).
    through: Option<String>,
}

/// A page of the list for the query in `q`, in its sort, ties on id. `after` pages on;
/// `through` is a live refetch, in one request, of the view from the top through the last row
/// the tab has loaded. Both cursors are the sort's (`<key>.<id>`, see `list::Cursor`), so a
/// refetch works under every filter and sort.
pub async fn issues(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Query(lq): Query<ListQuery>,
) -> Result<Json<IssuePage>, ApiError> {
    let view = query::parse(lq.q.as_deref().unwrap_or(query::DEFAULT));
    let cursor = |c: &str| {
        c.parse::<list::Cursor>()
            .map_err(|()| ApiError::BadRequest(format!("bad cursor {c:?}")))
    };
    let (span, limit) = match (lq.after.as_deref(), lq.through.as_deref()) {
        (Some(_), Some(_)) => {
            return Err(ApiError::BadRequest(
                "after and through don't go together".into(),
            ));
        }
        (Some(after), None) => (list::Span::After(cursor(after)?), PAGE),
        (None, Some(through)) => (list::Span::Through(cursor(through)?), THROUGH_MAX),
        (None, None) => (list::Span::Top, PAGE),
    };
    let filter = list::filter(&view, s.account);
    let sort = view.sort;
    let (rows, labels, assignees, next, last) = app
        .mirrors()
        .read(s.account, Caller::Request, move |c| {
            // A refetch stops at its cursor, not at a page's end: the list goes on if any row
            // follows the last one it returns, which takes the filter again.
            let probe = matches!(span, list::Span::Through(_)).then(|| filter.clone());
            let mut ids = list::ids(c, sort, filter, span, limit + 1)?;
            let mut more = ids.len() as i64 > limit;
            ids.truncate(limit as usize);
            if let Some(filter) = probe
                && !more
                && let Some(&last) = ids.last()
            {
                more = !list::ids(c, sort, filter, list::Span::After(last), 1)?.is_empty();
            }
            let last = ids.last().copied();
            let next = more.then_some(last).flatten();
            let ids: Vec<i64> = ids.into_iter().map(|row| row.id).collect();
            let rows = q::hydrate(c, &ids)?;
            Ok((
                rows,
                q::hydrate_labels(c, &ids)?,
                q::hydrate_assignees(c, &ids)?,
                next,
                last,
            ))
        })
        .await?;
    let mut by_item: HashMap<i64, (Vec<Label>, Vec<User>)> = HashMap::new();
    for l in labels {
        by_item.entry(l.item_id).or_default().0.push(Label {
            name: l.name,
            color: l.color,
        });
    }
    for a in assignees {
        by_item
            .entry(a.item_id)
            .or_default()
            .1
            .push(User { login: a.login });
    }
    let rows: Vec<IssueRow> = rows
        .into_iter()
        .map(|r| {
            let (labels, assignees) = by_item.remove(&r.id).unwrap_or_default();
            IssueRow {
                id: r.id,
                kind: r.kind,
                owner: r.owner,
                repo: r.repo,
                number: r.number,
                title: r.title,
                state: r.state,
                state_reason: r.state_reason,
                // Never NULL here: only stubs leave the timestamps unset (the item writes take
                // them as `i64`s; GitHub always sends them) and the list skips stubs.
                created_at: r.created_at.unwrap_or(0),
                updated_at: r.updated_at.unwrap_or(0),
                closed_at: r.closed_at,
                commented_at: r.last_commented_at,
                issue_type: r.issue_type,
                comments: r.comments_count,
                labels,
                assignees,
            }
        })
        .collect();
    // The cursors carry the sort key the id query ordered by, so they're exact for every sort.
    Ok(Json(IssuePage {
        rows,
        next: next.map(|c| c.to_string()),
        last: last.map(|c| c.to_string()),
    }))
}

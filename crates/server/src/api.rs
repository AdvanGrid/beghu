//! The JSON API this slice serves: `/api/me` and the default issue list. Every response is
//! `no-store` and carries `X-Beghu-Build` (see `lib.rs`). The wire types are exported to the web
//! app as TypeScript by ts-rs (`cargo test` writes `web/src/bindings/`).

use crate::auth::Session;
use crate::error::ApiError;
use crate::{App, repos};
use axum::Json;
use axum::extract::{Extension, Query, State};
use dbrt::filter::Filter;
use mirror_db::{Caller, frag, q};
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
    pub updated_at: i64,
    pub comments: i64,
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
    /// The next page: the rows after this cursor.
    after: Option<String>,
    /// A live refetch: the rows from the top through this cursor (the last row the tab shows).
    through: Option<String>,
}

/// `<updated_at>.<id>` of the last row shown.
fn parse_cursor(s: &str) -> Option<(i64, i64)> {
    let (u, id) = s.split_once('.')?;
    Some((u.parse().ok()?, id.parse().ok()?))
}

/// The default list: open issues, newest update first, ties on id. Filters and sorts come with
/// the filter bar. `after` pages on; `through` is a live refetch, in one request, of everything
/// from the top through the last row the tab has loaded.
pub async fn issues(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Query(lq): Query<ListQuery>,
) -> Result<Json<IssuePage>, ApiError> {
    let cursor =
        |c: &str| parse_cursor(c).ok_or_else(|| ApiError::BadRequest(format!("bad cursor {c:?}")));
    let mut filter = vec![frag::state("open")];
    let limit = match (lq.after.as_deref(), lq.through.as_deref()) {
        (Some(_), Some(_)) => {
            return Err(ApiError::BadRequest(
                "after and through don't go together".into(),
            ));
        }
        (Some(after), None) => {
            let (u, id) = cursor(after)?;
            filter.push(frag::updated_before(u, id));
            PAGE
        }
        (None, Some(through)) => {
            let (u, id) = cursor(through)?;
            filter.push(frag::updated_through(u, id));
            THROUGH_MAX
        }
        (None, None) => PAGE,
    };
    let refetch = lq.through.is_some();
    let filter = Filter::And(filter);
    let (rows, labels, assignees, more) = app
        .mirrors()
        .read(s.account, Caller::Request, move |c| {
            let mut ids = q::item_ids(c, &filter, "issue", limit + 1)?;
            let mut more = ids.len() as i64 > limit;
            ids.truncate(limit as usize);
            let rows = q::hydrate(c, &ids)?;
            // A refetch stops at its cursor, not at a page's end: the list goes on if any row
            // follows the last one it returns.
            if refetch
                && !more
                && let Some(last) = rows.last()
            {
                let after = Filter::And(vec![
                    frag::state("open"),
                    frag::updated_before(last.updated_at.unwrap_or(0), last.id),
                ]);
                more = !q::item_ids(c, &after, "issue", 1)?.is_empty();
            }
            Ok((
                rows,
                q::hydrate_labels(c, &ids)?,
                q::hydrate_assignees(c, &ids)?,
                more,
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
                // Never NULL here: only stubs leave `updated_at` unset (the item writes take it
                // as an `i64`; GitHub always sends it) and the list skips stubs. The column is
                // nullable for them alone. Were a listed row ever NULL, the cursor's 0 and the
                // SQL's row-value `<` would disagree, so COALESCE both, in the `items_list` index
                // too.
                updated_at: r.updated_at.unwrap_or(0),
                comments: r.comments_count,
                labels,
                assignees,
            }
        })
        .collect();
    let next = more
        .then(|| rows.last().map(|r| format!("{}.{}", r.updated_at, r.id)))
        .flatten();
    Ok(Json(IssuePage { rows, next }))
}

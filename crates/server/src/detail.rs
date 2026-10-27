//! The issue detail: `GET /api/issues/:id` (properties, body, the first page of comments in the
//! account's order, and the comment total) and `GET /api/issues/:id/comments` (the thread, cursor-
//! paged 15 at a time). `?through=<cursor>` on the detail returns every comment from the top of
//! the thread through that position instead of page 1, so a live refetch of an open detail is one
//! request however many pages the tab has loaded.
//!
//! A cursor is a position in the thread, `<created_at>.<id>` of a comment, and the thread is
//! ordered on that pair. A comment that arrives while the user scrolls is newer than every loaded
//! one, so it lands at the top (newest first) or past the last page (oldest first), and never
//! shifts a page boundary: nothing is skipped or repeated. A comment deleted since its cursor was
//! handed out still marks where its page ends, as does any other position no comment holds.
//!
//! The body goes out as raw Markdown, shown as plain text until rendering lands (#98).

use crate::App;
use crate::api::{CommentOrder, Label, User};
use crate::auth::Session;
use crate::error::{ApiError, IssueRef};
use crate::relationships::{self, Relationships};
use axum::Json;
use axum::extract::{Extension, Path, Query, State};
use dbrt::filter::Filter;
use mirror_db::{Caller, QueryResult, Reader, frag, q};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;
use ts_rs::TS;

/// One page of comments.
pub const COMMENTS_PAGE: i64 = 15;

#[derive(Serialize, TS)]
#[ts(export)]
pub struct IssueDetail {
    pub id: i64,
    /// `issue` or `pr`.
    pub kind: String,
    pub owner: String,
    pub repo: String,
    pub number: i64,
    pub title: String,
    /// Raw Markdown.
    pub body: String,
    /// `open` or `closed`.
    pub state: String,
    /// `completed`, `not_planned`, … once closed.
    pub state_reason: Option<String>,
    pub locked: bool,
    /// `null` for a deleted GitHub account.
    pub author: Option<User>,
    /// Unix seconds.
    pub created_at: i64,
    /// Unix seconds.
    pub updated_at: i64,
    /// Unix seconds.
    pub closed_at: Option<i64>,
    pub labels: Vec<Label>,
    pub assignees: Vec<User>,
    pub milestone: Option<Milestone>,
    /// The order `comments` is in: the account's preference.
    pub comment_order: CommentOrder,
    /// Page 1, or with `through=` every comment through that position.
    pub comments: CommentPage,
    /// Every comment the thread has.
    pub comment_total: i64,
    pub relationships: Relationships,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Milestone {
    pub title: String,
    /// `open` or `closed`.
    pub state: String,
    /// Unix seconds.
    pub due_on: Option<i64>,
}

/// Comments in the thread's order, and where the next page starts.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct CommentPage {
    pub comments: Vec<Comment>,
    /// Pass as `after` for the next page: a position, `<created_at>.<id>`. A page's is its last
    /// comment's; `through=`'s is the position it went through. `null` when nothing follows.
    pub next: Option<String>,
}

#[derive(Serialize, TS, Clone)]
#[ts(export)]
pub struct Comment {
    pub id: i64,
    /// `null` for a deleted GitHub account.
    pub author: Option<User>,
    /// Raw Markdown.
    pub body: String,
    /// Unix seconds.
    pub created_at: i64,
    /// Unix seconds.
    pub updated_at: i64,
}

/// Which comments of the thread a read returns.
#[derive(Clone, Copy)]
enum Span {
    /// The first page.
    First,
    /// The page after this position.
    After(Cursor),
    /// Everything from the top through this position.
    Through(Cursor),
}

/// A position in a thread, `<created_at>.<id>` on the wire: a comment's, which may since have
/// been deleted, or any other.
#[derive(Clone, Copy)]
struct Cursor {
    created_at: i64,
    id: i64,
}

impl FromStr for Cursor {
    type Err = ApiError;

    fn from_str(raw: &str) -> Result<Cursor, ApiError> {
        let bad = || ApiError::BadRequest(format!("bad cursor {raw:?}"));
        let (t, id) = raw.split_once('.').ok_or_else(bad)?;
        Ok(Cursor {
            created_at: t.parse().map_err(|_| bad())?,
            id: id.parse().map_err(|_| bad())?,
        })
    }
}

impl fmt::Display for Cursor {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}.{}", self.created_at, self.id)
    }
}

impl From<&Comment> for Cursor {
    fn from(c: &Comment) -> Cursor {
        Cursor {
            created_at: c.created_at,
            id: c.id,
        }
    }
}

#[derive(Deserialize)]
pub struct DetailQuery {
    through: Option<String>,
}

#[derive(Deserialize)]
pub struct CommentsQuery {
    order: Option<String>,
    after: Option<String>,
}

/// An id in the path that isn't a number names no issue.
fn issue_id(raw: &str) -> Result<i64, ApiError> {
    raw.parse().map_err(|_| ApiError::Gone)
}

/// The item, if the account may read it here: Gone if the mirror doesn't hold it, NoAccess if
/// it lies outside the synced repos (a stub, or a repo no longer synced).
fn readable(c: &Reader, id: i64) -> QueryResult<Result<q::ItemDetailRow, ApiError>> {
    Ok(match q::item_detail(c, id)? {
        None => Err(ApiError::Gone),
        Some(item) if item.is_stub || !item.synced => Err(ApiError::NoAccess(IssueRef {
            kind: item.kind,
            owner: item.owner,
            repo: item.repo,
            number: item.number,
            title: item.title,
        })),
        Some(item) => Ok(item),
    })
}

pub async fn issue(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path(raw): Path<String>,
    Query(dq): Query<DetailQuery>,
) -> Result<Json<IssueDetail>, ApiError> {
    let id = issue_id(&raw)?;
    let span = match dq.through.as_deref() {
        Some(t) => Span::Through(t.parse()?),
        None => Span::First,
    };
    let account = s.account;
    // During an import, an issue whose comments haven't landed yet fetches them now.
    crate::import::comments_on_demand(&app, account, id).await;
    let pref = app
        .control()
        .read(move |c| control_db::q::account(c, account))
        .await?
        .ok_or(ApiError::SignedOut)?
        .comment_order;
    let order = CommentOrder::from_pref(pref.as_deref());
    let read = app
        .mirrors()
        .read(s.account, Caller::Request, move |c| {
            let item = match readable(c, id)? {
                Ok(item) => item,
                Err(e) => return Ok(Err(e)),
            };
            Ok(Ok((
                item,
                q::hydrate_labels(c, &[id])?,
                q::hydrate_assignees(c, &[id])?,
                comments(c, id, order, span)?,
                q::comment_total(c, id)?,
                relationships::for_item(c, id)?,
            )))
        })
        .await??;
    let (item, labels, assignees, comments, comment_total, relationships) = read;
    let milestone = match (item.milestone_title, item.milestone_state) {
        (Some(title), Some(state)) => Some(Milestone {
            title,
            state,
            due_on: item.milestone_due_on,
        }),
        _ => None,
    };
    Ok(Json(IssueDetail {
        id: item.id,
        kind: item.kind,
        owner: item.owner,
        repo: item.repo,
        number: item.number,
        title: item.title,
        body: item.body.unwrap_or_default(),
        state: item.state,
        state_reason: item.state_reason,
        locked: item.locked,
        author: item.author.map(|login| User { login }),
        // Only stubs leave these unset, and stubs are refused above.
        created_at: item.created_at.unwrap_or(0),
        updated_at: item.updated_at.unwrap_or(0),
        closed_at: item.closed_at,
        labels: labels
            .into_iter()
            .map(|l| Label {
                name: l.name,
                color: l.color,
            })
            .collect(),
        assignees: assignees
            .into_iter()
            .map(|a| User { login: a.login })
            .collect(),
        milestone,
        comment_order: order,
        comments,
        comment_total,
        relationships,
    }))
}

pub async fn comments_page(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path(raw): Path<String>,
    Query(cq): Query<CommentsQuery>,
) -> Result<Json<CommentPage>, ApiError> {
    let id = issue_id(&raw)?;
    // The client always says which order it pages in; one it doesn't know is a bug there.
    let order = match cq.order.as_deref() {
        None => CommentOrder::Newest,
        Some(o) => o.parse()?,
    };
    let span = match cq.after.as_deref() {
        Some(a) => Span::After(a.parse()?),
        None => Span::First,
    };
    let page = app
        .mirrors()
        .read(s.account, Caller::Request, move |c| {
            Ok(match readable(c, id)? {
                Ok(_) => Ok(comments(c, id, order, span)?),
                Err(e) => Err(e),
            })
        })
        .await??;
    Ok(Json(page))
}

/// The comments of `item` matching `filter`, in `order`, at most `limit` (`-1`: all).
fn thread(
    c: &Reader,
    item: i64,
    order: CommentOrder,
    filter: &Filter,
    limit: i64,
) -> QueryResult<Vec<Comment>> {
    // The two orders are two queries with the same columns: one mapping for both.
    macro_rules! to_comments {
        ($rows:expr) => {
            $rows
                .into_iter()
                .map(|r| Comment {
                    id: r.id,
                    author: r.author.map(|login| User { login }),
                    body: r.body,
                    created_at: r.created_at,
                    updated_at: r.updated_at,
                })
                .collect()
        };
    }
    Ok(match order {
        CommentOrder::Newest => to_comments!(q::comments_newest(c, filter, item, limit)?),
        CommentOrder::Oldest => to_comments!(q::comments_oldest(c, filter, item, limit)?),
    })
}

impl CommentOrder {
    /// How `at` splits the thread in this order: the comments up to and including it, and the
    /// comments after it.
    fn split_at(self, at: Cursor) -> (Filter, Filter) {
        let Cursor { created_at: t, id } = at;
        match self {
            CommentOrder::Newest => (
                frag::comment_at_or_newer(t, id),
                frag::comment_older_than(t, id),
            ),
            CommentOrder::Oldest => (
                frag::comment_at_or_older(t, id),
                frag::comment_newer_than(t, id),
            ),
        }
    }
}

/// A span of `item`'s thread in `order`.
fn comments(c: &Reader, item: i64, order: CommentOrder, span: Span) -> QueryResult<CommentPage> {
    Ok(match span {
        // One more than a page, to know whether another follows.
        Span::First | Span::After(_) => {
            let filter = match span {
                Span::After(at) => order.split_at(at).1,
                _ => Filter::True,
            };
            let mut rows = thread(c, item, order, &filter, COMMENTS_PAGE + 1)?;
            let more = rows.len() as i64 > COMMENTS_PAGE;
            rows.truncate(COMMENTS_PAGE as usize);
            let next = rows
                .last()
                .filter(|_| more)
                .map(|r| Cursor::from(r).to_string());
            CommentPage {
                comments: rows,
                next,
            }
        }
        // No page size: every comment up to the position, then a look past it. The thread goes
        // on from the position itself, so paging continues even when no comment is left
        // before it (every loaded one deleted).
        Span::Through(at) => {
            let (through, after) = order.split_at(at);
            let rows = thread(c, item, order, &through, -1)?;
            let more = !thread(c, item, order, &after, 1)?.is_empty();
            CommentPage {
                comments: rows,
                next: more.then(|| at.to_string()),
            }
        }
    })
}

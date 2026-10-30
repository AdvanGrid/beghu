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
//! Bodies and comments go out as the compact Markdown AST (markdown.rs), each response with the
//! `refs` map for the items its posts refer to and the `media` map for the images they show. A
//! request reads the posts' Markdown, renders it once the mirror connection is back in the pool
//! (through the cache), and then reads `refs` and `media`. Images the mirror has no size for are
//! measured then (`media/probe.rs`), waiting up to 100 ms; what lands later pushes the issue
//! again.

use crate::App;
use crate::api::{CommentOrder, Label, PrStatus, ReviewDecision, User};
use crate::auth::Session;
use crate::error::{ApiError, IssueRef};
use crate::markdown::{self, Digest, Md, Place, Post, PostKind, Refs};
use crate::media::Media;
use crate::media::probe::{self, Todo};
use crate::relationships::{self, Related, Relationships};
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
    /// The repo's id: what its pickers' reads name (`/api/repos/:id/labels`, …).
    pub repo_id: i64,
    pub owner: String,
    pub repo: String,
    pub number: i64,
    pub title: String,
    /// The body, rendered.
    #[ts(type = "import(\"../md/ast\").Md")]
    pub body: Md,
    /// The body's digest (the SHA-256 of its Markdown, hex): an open body editor compares it with
    /// the digest of the text it opened with, to say the body changed meanwhile.
    #[ts(type = "string")]
    pub body_digest: Digest,
    /// The items in the mirror that the body refers to; `comments.refs` has the comments'.
    pub refs: Refs,
    /// What's known of the images the body shows, by `src`; `comments.media` has the comments'.
    pub media: Media,
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
    /// A PR's own fields; `null` for an issue.
    pub pr: Option<PullDetail>,
    /// On a PR, the issues it closes when it merges ("Closes"); empty on an issue.
    pub closes: Vec<Related>,
    /// On an issue, the PRs that close it when they merge ("Linked PRs"); empty on a PR.
    pub linked_prs: Vec<Related>,
    /// What the account may do here, why not the rest, and the role line (roles.rs). A PR
    /// takes no writes.
    #[serde(flatten)]
    pub rules: crate::roles::IssueCan,
}

/// What the detail shows of a PR beside its issue fields.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct PullDetail {
    pub status: PrStatus,
    /// The branch it merges from; `null` if GitHub didn't say.
    pub head: Option<String>,
    /// The branch it merges into.
    pub base: Option<String>,
    /// `null` when the repo requires no review.
    pub review: Option<ReviewDecision>,
    /// Unix seconds; `null` unless merged.
    pub merged_at: Option<i64>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Milestone {
    /// Its number in the repo: what `milestone_set` names.
    pub number: i64,
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
    /// The items in the mirror that these comments refer to.
    pub refs: Refs,
    /// What's known of the images these comments show, by `src`.
    pub media: Media,
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
    /// The comment, rendered.
    #[ts(type = "import(\"../md/ast\").Md")]
    pub body: Md,
    /// Its digest (the SHA-256 of its Markdown, hex): a tab looking for its own maybe-posted
    /// comment compares it.
    #[ts(type = "string")]
    pub digest: Digest,
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

#[derive(Deserialize)]
pub struct DetailQuery {
    through: Option<String>,
    /// The order the tab shows the thread in (`newest` or `oldest`), for a refetch: without it,
    /// the account's. A tab keeps its order until it opens an issue afresh, when another tab
    /// changed the account's.
    order: Option<String>,
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

/// The item, if the account may read it here: NoAccess if it lies outside the synced repos (a
/// stub, or a repo no longer synced); if the mirror doesn't hold it, why not ([`gone`]).
fn readable(c: &Reader, id: i64) -> QueryResult<Result<q::ItemDetailRow, ApiError>> {
    Ok(match q::item_detail(c, id)? {
        None => Err(gone(c, id)?),
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

/// How many transfers in a row [`gone`] follows to where an issue is now.
const MOVES_FOLLOWED: usize = 8;

/// Why the mirror doesn't hold `id`: moved (transferred, to the issue it became, following later
/// transfers of that one), deleted (a webhook said so), or Gone (never there, or gone without a
/// webhook saying how).
fn gone(c: &Reader, id: i64) -> QueryResult<ApiError> {
    let Some(mut m) = q::moved_to(c, id)? else {
        return Ok(if q::is_deleted(c, "item", id)? {
            ApiError::Deleted
        } else {
            ApiError::Gone
        });
    };
    for _ in 0..MOVES_FOLLOWED {
        match q::moved_to(c, m.to_id)? {
            Some(next) => m = next,
            None => break,
        }
    }
    Ok(match q::item_detail(c, m.to_id)? {
        // Where it is now, as the mirror has it.
        Some(item) => ApiError::Moved {
            to: (!item.is_stub && item.synced).then_some(item.id),
            issue: IssueRef {
                kind: item.kind,
                owner: item.owner,
                repo: item.repo,
                number: item.number,
                title: item.title,
            },
        },
        // Where it went, as the transfer said.
        None => ApiError::Moved {
            to: None,
            issue: IssueRef {
                kind: "issue".into(),
                owner: m.owner,
                repo: m.repo,
                number: m.number,
                title: m.title,
            },
        },
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
    // A parent's sub-issue order is read back: a reorder made outside beghu sends nothing.
    crate::reconcile::opened(&app, account, id).await;
    let order = match dq.order.as_deref() {
        Some(o) => o.parse()?,
        None => {
            let pref = app
                .control()
                .read(move |c| control_db::q::account(c, account))
                .await?
                .ok_or(ApiError::SignedOut)?
                .comment_order;
            CommentOrder::from_pref(pref.as_deref())
        }
    };
    let read = app
        .mirrors()
        .read(s.account, Caller::Request, move |c| {
            let item = match readable(c, id)? {
                Ok(item) => item,
                Err(e) => return Ok(Err(e)),
            };
            Ok(Ok((
                q::hydrate_labels(c, &[id])?,
                q::hydrate_assignees(c, &[id])?,
                thread(c, id, order, span)?,
                q::comment_total(c, id)?,
                relationships::for_item(c, id)?,
                item,
            )))
        })
        .await??;
    let (labels, assignees, thread, comment_total, (relationships, linked), mut item) = read;
    let rules = crate::roles::issue_can(
        &crate::roles::RepoAccess::from(&item),
        crate::roles::IssueFacts {
            own: item.author_id == Some(account),
            locked: item.locked,
        },
        item.kind == "pr",
    );
    let pr = (item.kind == "pr").then(|| PullDetail {
        status: PrStatus::of(&item.state, item.draft, item.merged_at),
        head: item.head_ref.take(),
        base: item.base_ref.take(),
        review: ReviewDecision::parse(item.review_decision.as_deref()),
        merged_at: item.merged_at,
    });
    let body = Post {
        kind: PostKind::Body,
        id,
        md: item.body.take().unwrap_or_default(),
    };
    let body_digest = Digest::of(&body.md);
    let (body, comments) =
        rendered(&app, s.account, id, Place::from(&item), Some(body), thread).await?;
    let (body, refs, media) = body.expect("a body was given, so one is rendered");
    let milestone = match (
        item.milestone_number,
        item.milestone_title,
        item.milestone_state,
    ) {
        (Some(number), Some(title), Some(state)) => Some(Milestone {
            number,
            title,
            state,
            due_on: item.milestone_due_on,
        }),
        _ => None,
    };
    Ok(Json(IssueDetail {
        id: item.id,
        kind: item.kind,
        repo_id: item.repo_id,
        owner: item.owner,
        repo: item.repo,
        number: item.number,
        title: item.title,
        body,
        body_digest,
        refs,
        media,
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
        pr,
        closes: linked.closes,
        linked_prs: linked.linked_prs,
        rules,
    }))
}

/// An issue's body as Markdown, for its editor to open with: `GET /api/issues/:id/source`. The
/// detail carries the body rendered, never its Markdown.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct IssueSource {
    /// The body's Markdown as the mirror has it from GitHub (empty for none).
    pub body: String,
    /// Its digest, as the detail's `body_digest`.
    #[ts(type = "string")]
    pub body_digest: Digest,
}

pub async fn source(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Path(raw): Path<String>,
) -> Result<Json<IssueSource>, ApiError> {
    let id = issue_id(&raw)?;
    let body = app
        .mirrors()
        .read(s.account, Caller::Request, move |c| {
            Ok(readable(c, id)?.map(|item| item.body.unwrap_or_default()))
        })
        .await??;
    Ok(Json(IssueSource {
        body_digest: Digest::of(&body),
        body,
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
    let (place, thread) = app
        .mirrors()
        .read(s.account, Caller::Request, move |c| {
            Ok(match readable(c, id)? {
                Ok(item) => Ok((Place::from(&item), thread(c, id, order, span)?)),
                Err(e) => Err(e),
            })
        })
        .await??;
    let (_, page) = rendered(&app, s.account, id, place, None, thread).await?;
    Ok(Json(page))
}

/// A comment as the mirror holds it, its Markdown not rendered yet.
struct RawComment {
    id: i64,
    author: Option<String>,
    body: String,
    created_at: i64,
    updated_at: i64,
}

/// The comments of `item` matching `filter`, in `order`, at most `limit` (`-1`: all).
fn rows(
    c: &Reader,
    item: i64,
    order: CommentOrder,
    filter: &Filter,
    limit: i64,
) -> QueryResult<Vec<RawComment>> {
    // The two orders are two queries with the same columns: one mapping for both.
    macro_rules! raw {
        ($rows:expr) => {
            $rows
                .into_iter()
                .map(|r| RawComment {
                    id: r.id,
                    author: r.author,
                    body: r.body,
                    created_at: r.created_at,
                    updated_at: r.updated_at,
                })
                .collect()
        };
    }
    Ok(match order {
        CommentOrder::Newest => raw!(q::comments_newest(c, filter, item, limit)?),
        CommentOrder::Oldest => raw!(q::comments_oldest(c, filter, item, limit)?),
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

/// A span of a thread as the mirror holds it, and where the next page starts.
struct RawPage {
    comments: Vec<RawComment>,
    next: Option<String>,
}

/// A span of `item`'s thread in `order`, not rendered yet.
fn thread(c: &Reader, item: i64, order: CommentOrder, span: Span) -> QueryResult<RawPage> {
    let position = |r: &RawComment| {
        Cursor {
            created_at: r.created_at,
            id: r.id,
        }
        .to_string()
    };
    let (comments, next) = match span {
        // One more than a page, to know whether another follows.
        Span::First | Span::After(_) => {
            let filter = match span {
                Span::After(at) => order.split_at(at).1,
                _ => Filter::True,
            };
            let mut rows = rows(c, item, order, &filter, COMMENTS_PAGE + 1)?;
            let more = rows.len() as i64 > COMMENTS_PAGE;
            rows.truncate(COMMENTS_PAGE as usize);
            let next = rows.last().filter(|_| more).map(position);
            (rows, next)
        }
        // No page size: every comment up to the position, then a look past it. The thread goes
        // on from the position itself, so paging continues even when no comment is left
        // before it (every loaded one deleted).
        Span::Through(at) => {
            let (through, after) = order.split_at(at);
            let rows_through = rows(c, item, order, &through, -1)?;
            let more = !rows(c, item, order, &after, 1)?.is_empty();
            (rows_through, more.then(|| at.to_string()))
        }
    };
    Ok(RawPage { comments, next })
}

/// `body` (an issue's, if given) and `page`'s comments on `item` rendered, each with the `refs`
/// and `media` its posts need, read from the account's mirror once the rendering is done.
async fn rendered(
    app: &App,
    account: i64,
    item: i64,
    place: Place,
    body: Option<Post>,
    page: RawPage,
) -> Result<(Option<(Md, Refs, Media)>, CommentPage), ApiError> {
    let has_body = body.is_some();
    let posts = body
        .into_iter()
        .chain(page.comments.iter().map(|r| Post {
            kind: PostKind::Comment,
            id: r.id,
            md: r.body.clone(),
        }))
        .collect();
    let mut posts = markdown::render(app, place, posts).await.into_iter();
    let body = if has_body { posts.next() } else { None };
    let comments: Vec<Comment> = page
        .comments
        .into_iter()
        .zip(posts)
        .map(|(r, p)| Comment {
            id: r.id,
            author: r.author.map(|login| User { login }),
            body: p.md,
            digest: p.digest,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
        .collect();
    let (body_md, comment_mds): (Option<Md>, Vec<Md>) = (
        body.map(|b| b.md),
        comments.iter().map(|c| c.body.clone()).collect(),
    );
    let refers = body_md
        .iter()
        .chain(&comment_mds)
        .any(|m| !m.items().is_empty() || !m.images().is_empty());
    let (body_refs, comment_refs, body_media, comment_media) = if refers {
        let ask = (body_md.clone(), comment_mds.clone());
        app.mirrors()
            .read(account, Caller::Request, move |c| {
                let (body, comments) = &ask;
                let comment_images: Vec<_> = comments.iter().flat_map(Md::images).collect();
                Ok((
                    body.as_ref().map(|b| markdown::refs(c, [b])).transpose()?,
                    markdown::refs(c, comments)?,
                    body.as_ref()
                        .map(|b| probe::media_of(c, &b.images().iter().collect::<Vec<_>>()))
                        .transpose()?,
                    probe::media_of(c, &comment_images)?,
                ))
            })
            .await?
    } else {
        // Nothing to look up: no second read.
        let none = body_md.as_ref().map(|_| Refs::new());
        (
            none,
            Refs::new(),
            body_md.as_ref().map(|_| Media::new()),
            Media::new(),
        )
    };
    let (mut body_media, mut comment_media) = (body_media, comment_media);
    // Images with no size anywhere yet: measured now, for a little while.
    let mut todo = Vec::new();
    let mut sizeless = Vec::new();
    for (md, known) in body_md
        .iter()
        .map(|b| (b, body_media.as_ref()))
        .chain(comment_mds.iter().map(|m| (m, Some(&comment_media))))
    {
        for i in md.images().iter().filter(|i| !i.sized) {
            if !known.is_some_and(|k| k.contains_key(&i.src)) {
                todo.push(Todo::of(i, None));
                sizeless.push(i.clone());
            }
        }
    }
    if !todo.is_empty() {
        let wait = app.cfg().media.detail_wait;
        let landed = probe::measure(app, account, Some(item), None, todo, wait).await;
        for i in sizeless {
            let Some(f) = landed.get(&probe::hash(&i.source.key())) else {
                continue;
            };
            let in_body = body_md
                .as_ref()
                .is_some_and(|b| b.images().iter().any(|b| b.src == i.src));
            let map = match (&mut body_media, in_body) {
                (Some(m), true) => m,
                _ => &mut comment_media,
            };
            map.insert(i.src.clone(), f.into());
        }
    }
    Ok((
        body_md
            .zip(body_refs)
            .zip(body_media)
            .map(|((b, r), m)| (b, r, m)),
        CommentPage {
            comments,
            refs: comment_refs,
            media: comment_media,
            next: page.next,
        },
    ))
}

//! The JSON API this slice serves: `/api/me` and the issue list, filtered and sorted by the
//! filter bar's query (`q`, see `query.rs`); the bar's suggestions are in `facets.rs`. Every response is
//! `no-store` and carries `X-Beghu-Build` (see `lib.rs`). The wire types are exported to the web
//! app as TypeScript by ts-rs (`cargo test` writes `web/src/bindings/`).

use crate::auth::Session;
use crate::error::ApiError;
use crate::relationships::{self, Blocker, Progress};
use crate::{App, query, repos};
use axum::Json;
use axum::extract::{Extension, Query, State};
use mirror_db::{Caller, q};
use mirror_db::{list, search};
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
    /// The account's comment order: the detail comes in it.
    pub comment_order: CommentOrder,
    /// The account's own key bindings, by action (prefs.rs); an action left out has the preset's.
    pub keymap: crate::prefs::Keymap,
    /// The synced repos and the account's role on each.
    pub repos: Vec<Repo>,
    /// The import running, if any: the status slot's "Importing… n of m repos".
    pub import: Option<crate::import::ImportStatus>,
    /// Sync degraded, or resyncing; `null` while sync is healthy.
    pub sync: Option<crate::reconcile::SyncStatus>,
}

#[derive(Serialize, TS, Clone)]
#[ts(export)]
pub struct Account {
    pub id: i64,
    pub login: String,
    /// It lost access to GitHub: switching to it signs it in again.
    pub needs_sign_in: bool,
}

#[derive(Serialize, Deserialize, TS, Clone, Copy)]
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
    /// As on the wire, and as `preferences` stores it.
    pub fn name(self) -> &'static str {
        match self {
            CommentOrder::Newest => "newest",
            CommentOrder::Oldest => "oldest",
        }
    }

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
    let (row, accounts, keys) = app
        .control()
        .read(move |c| {
            Ok((
                control_db::q::account(c, account)?,
                control_db::q::session_accounts(c, &hash)?,
                control_db::q::key_bindings(c, account)?,
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
            needs_sign_in: false,
        },
        accounts: accounts
            .into_iter()
            .map(|a| Account {
                id: a.github_user_id,
                login: a.login,
                needs_sign_in: !crate::tokens::AccountStatus::from_db(&a.status).is_usable(),
            })
            .collect(),
        comment_order: CommentOrder::from_pref(row.comment_order.as_deref()),
        keymap: crate::prefs::keymap(keys),
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
        import: app.imports().status(s.account),
        sync: crate::reconcile::status(&app, s.account).await,
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
    /// How many open issues block it.
    pub blocked_by: i64,
    /// The first 8 of them, enough for the chips and the hover card.
    pub blockers: Vec<Blocker>,
    /// Sub-issue progress: every descendant. `null` without sub-issues.
    pub progress: Option<Progress>,
    /// The fields the search's words were found in, in this order; empty without free text.
    pub matched: Vec<SearchField>,
    /// A PR's status and review decision; `null` for an issue.
    pub pr: Option<PullRow>,
}

/// What a PR shows beside its issue fields on a list row: its status icon, and the review chip
/// in the labels column.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct PullRow {
    pub status: PrStatus,
    /// `null` when the repo requires no review.
    pub review: Option<ReviewDecision>,
}

/// A PR's status, as its icon and badge show it: merged, else closed, else a draft, else open.
#[derive(Serialize, TS, Debug, Clone, Copy, PartialEq, Eq)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum PrStatus {
    Open,
    Draft,
    Merged,
    Closed,
}

impl PrStatus {
    pub fn of(state: &str, draft: Option<bool>, merged_at: Option<i64>) -> PrStatus {
        match (merged_at, state, draft) {
            (Some(_), _, _) => PrStatus::Merged,
            (None, "closed", _) => PrStatus::Closed,
            (None, _, Some(true)) => PrStatus::Draft,
            _ => PrStatus::Open,
        }
    }
}

/// A PR's review decision (GitHub's `reviewDecision`).
#[derive(Serialize, TS, Debug, Clone, Copy, PartialEq, Eq)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
}

impl ReviewDecision {
    /// The mirror's spelling; `None` for none (or one it doesn't know).
    pub fn parse(s: Option<&str>) -> Option<ReviewDecision> {
        match s? {
            "approved" => Some(ReviewDecision::Approved),
            "changes_requested" => Some(ReviewDecision::ChangesRequested),
            "review_required" => Some(ReviewDecision::ReviewRequired),
            _ => None,
        }
    }
}

/// A field free text searches (`in:`) and matches in (a row's icons): `search::Field` on the
/// wire.
#[derive(Serialize, TS, Debug, Clone, Copy, PartialEq, Eq)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum SearchField {
    Title,
    Body,
    Comments,
}

impl From<search::Field> for SearchField {
    fn from(f: search::Field) -> SearchField {
        match f {
            search::Field::Title => SearchField::Title,
            search::Field::Body => SearchField::Body,
            search::Field::Comments => SearchField::Comments,
        }
    }
}

/// A Match mode (`list::Match`) as the web app and the `match:` token spell it: the Match
/// dropdown's values are the token's.
#[derive(Serialize, Deserialize, TS, Debug, Clone, Copy, PartialEq, Eq)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum MatchMode {
    Blend,
    Best,
    Off,
}

impl From<MatchMode> for list::Match {
    fn from(m: MatchMode) -> list::Match {
        match m {
            MatchMode::Blend => list::Match::Blend,
            MatchMode::Best => list::Match::Best,
            MatchMode::Off => list::Match::Off,
        }
    }
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Label {
    pub name: String,
    /// GitHub's hex colour, without `#`.
    pub color: String,
}

#[derive(Serialize, TS, Clone)]
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
/// the tab has loaded. Both cursors are the view's order's (`<sort>.<key>.<id>`, or
/// `<mode>-<sort>.<rank>.<key>.<id>` under a Match mode; see `list::Cursor`), so a refetch works
/// under every filter, sort and Match mode. A cursor from another sort or Match mode, or
/// a plain one under a ranked view (or the reverse), is refused. Under free text each row
/// carries the fields it matched in.
pub async fn issues(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Query(lq): Query<ListQuery>,
) -> Result<Json<IssuePage>, ApiError> {
    let view = query::parse(lq.q.as_deref().unwrap_or(query::DEFAULT));
    // A cursor of this view's order: a ranked one names its Match mode and sort.
    let cursor = |c: &str| match c.parse::<list::Cursor>() {
        Ok(cur) if cur.fits(&view) => Ok(cur),
        Ok(_) => Err(ApiError::BadRequest(format!(
            "cursor {c:?} is from another order than this view's"
        ))),
        Err(()) => Err(ApiError::BadRequest(format!(
            "cursor {c:?} isn't one this server writes"
        ))),
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
    let me = s.account;
    let (rows, labels, assignees, mut related, mut matched, next, last) = app
        .mirrors()
        .read(s.account, Caller::Request, move |c| {
            let mut ids = list::page(c, &view, me, span, limit + 1)?;
            let mut more = ids.len() as i64 > limit;
            ids.truncate(limit as usize);
            // A refetch stops at its cursor, not at a page's end: the list goes on if any row
            // follows the last one it returns, which takes the view again.
            if matches!(span, list::Span::Through(_))
                && !more
                && let Some(&last) = ids.last()
            {
                more = !list::page(c, &view, me, list::Span::After(last), 1)?.is_empty();
            }
            let last = ids.last().copied();
            let next = more.then_some(last).flatten();
            let ids: Vec<i64> = ids.into_iter().map(|row| row.id).collect();
            let rows = q::hydrate(c, &ids)?;
            Ok((
                rows,
                q::hydrate_labels(c, &ids)?,
                q::hydrate_assignees(c, &ids)?,
                relationships::for_rows(c, &ids)?,
                search::matched(c, &view, &ids)?,
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
            let rel = related.remove(&r.id).unwrap_or_default();
            let pr = (r.kind == "pr").then(|| PullRow {
                status: PrStatus::of(&r.state, r.draft, r.merged_at),
                review: ReviewDecision::parse(r.review_decision.as_deref()),
            });
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
                blocked_by: rel.blocked_by,
                blockers: rel.blockers,
                progress: rel.progress,
                matched: matched
                    .remove(&r.id)
                    .unwrap_or_default()
                    .into_iter()
                    .map(SearchField::from)
                    .collect(),
                pr,
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

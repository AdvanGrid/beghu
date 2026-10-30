//! Tree mode (#108): `GET /api/tree`, the view's sub-issues nested under their parents, and
//! `GET /api/tree/drop`, whether a drag in the tree may drop an issue under another.
//!
//! The tree over a view (its matches and their ancestors, and its roots in order; see
//! `mirror_db::tree`) is built once per view and mirror `seq` and cached: a request in the same
//! `seq` reads only its page. A page is a run of roots, in the tree's order, each followed by what
//! it shows open, depth first, as the web app lists them. What's open is the tab's (it keeps each
//! query's expand state on its device) and goes with each request: `open` lists the nodes the
//! user opened, `shut` the ones they closed that open by default. Context, the ancestors there
//! only for a match below them, opens by default, so a filtered tree arrives opened along each
//! path to a match; everything else starts closed.
//!
//! The query string is the list's (`q`, `after`, `through`; the cursors are a root's place, in
//! the list's cursor format) plus `open`, `shut`, `under` (only what a node shows under it, to
//! open it; with `all`, opened to the bottom), and `sel` (the selection: the answer says where it
//! shows, itself or the nearest ancestor that does).

use crate::api::{IssueRow, THROUGH_MAX};
use crate::auth::Session;
use crate::error::ApiError;
use crate::relationship_writes::{self, RelationshipKind};
use crate::{App, ops, query};
use axum::Json;
use axum::extract::{Extension, Query, State};
use mirror_db::list::{Cursor, Span, View};
use mirror_db::tree::Tree;
use mirror_db::{Caller, QueryResult, Reader, q};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use ts_rs::TS;

/// Roots per page, as the list's rows.
pub const PAGE: usize = 100;
/// The most nodes one answer holds: past it, nodes that would open stay closed.
pub const NODES_MAX: usize = 3_000;
/// The most ids `open` or `shut` takes, the last given (the tab lists the newest last); the rest
/// are left out. They go in the URL.
const OPENS_MAX: usize = 200;
/// How many trees are cached, across accounts and views. A tree holds its matches, the nodes it's
/// built from and its roots: about 2.5 MB for `is:open` at 50k, 4 MB for every state.
const CACHED: usize = 16;
/// How many of them one account keeps: many accounts' views don't push each other's out.
const CACHED_PER_ACCOUNT: usize = 4;

/// The trees built lately, each for an account's view as of a mirror `seq`, newest used first.
#[derive(Default)]
pub struct Cache(Mutex<Vec<Cached>>);

/// A tree being built, or built: requests for the same view and `seq` wait for the one build.
/// `None` once built is a build that failed (the entry goes, and the next request builds again).
type Cell = Arc<OnceLock<Option<Arc<Tree>>>>;

struct Cached {
    account: i64,
    view: String,
    seq: i64,
    tree: Cell,
}

impl Cache {
    /// The tree of `view` (its key, `view_key`) for `account` as of `seq`, built by `build` if
    /// it isn't cached; a build under way for the same is waited for, not repeated. An account
    /// keeps `CACHED_PER_ACCOUNT` trees and all keep `CACHED`, the least recently used going.
    fn get(
        &self,
        account: i64,
        view: &str,
        seq: i64,
        build: impl FnOnce() -> QueryResult<Tree>,
    ) -> QueryResult<Arc<Tree>> {
        let cell: Cell = {
            let mut all = self.0.lock().unwrap();
            match all
                .iter()
                .position(|c| c.account == account && c.view == view && c.seq == seq)
            {
                Some(i) => {
                    let c = all.remove(i);
                    let cell = c.tree.clone();
                    all.insert(0, c);
                    cell
                }
                None => {
                    // An older `seq`'s tree of the view is no use any more.
                    all.retain(|c| !(c.account == account && c.view == view));
                    let cell = Cell::default();
                    all.insert(
                        0,
                        Cached {
                            account,
                            view: view.to_owned(),
                            seq,
                            tree: cell.clone(),
                        },
                    );
                    let mut mine = 0;
                    all.retain(|c| {
                        mine += usize::from(c.account == account);
                        c.account != account || mine <= CACHED_PER_ACCOUNT
                    });
                    all.truncate(CACHED);
                    cell
                }
            }
        };
        let mut failed = None;
        let tree = cell.get_or_init(|| match build() {
            Ok(t) => Some(Arc::new(t)),
            Err(e) => {
                failed = Some(e);
                None
            }
        });
        match tree {
            Some(t) => Ok(t.clone()),
            None => {
                self.0
                    .lock()
                    .unwrap()
                    .retain(|c| !Arc::ptr_eq(&c.tree, &cell));
                // Another request's build failed: this one says so as its own failure would.
                Err(failed.unwrap_or(rusqlite::Error::QueryReturnedNoRows))
            }
        }
    }
}

/// A view as the cache keys it: the same view however its query's tokens were ordered.
fn view_key(view: &View) -> String {
    let mut v = view.clone();
    let sorted = |xs: &mut Vec<String>| {
        xs.sort_by_key(|x| x.to_lowercase());
        xs.dedup_by_key(|x| x.to_lowercase());
    };
    sorted(&mut v.labels);
    sorted(&mut v.milestones);
    sorted(&mut v.types);
    v.assignees.sort_by_key(|w| format!("{w:?}").to_lowercase());
    v.authors.sort_by_key(|w| format!("{w:?}").to_lowercase());
    v.repos.sort_by_key(|r| format!("{r:?}").to_lowercase());
    v.words.sort_by_key(|w| format!("{w:?}").to_lowercase());
    format!("{v:?}")
}

/// A run of the tree: roots, each followed by what it shows open.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct TreePage {
    /// Depth first, as the tree lists them.
    pub nodes: Vec<TreeNode>,
    /// Pass as `after` for the next roots; `null` after the last.
    pub next: Option<String>,
    /// The last root's place: pass as `through` to refetch the tree through it. `null` with none.
    pub last: Option<String>,
    /// For `sel`: the node it shows as, itself or the nearest ancestor shown (one that's closed
    /// hides it); `null` when it isn't in the tree, or without `sel`.
    pub selected: Option<i64>,
}

/// One issue in the tree.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct TreeNode {
    pub row: IssueRow,
    /// 0 for a root; with `under`, 0 for the node's children.
    pub depth: i64,
    /// The node it's under; `null` for a root.
    pub parent: Option<i64>,
    /// How many children it shows when open; 0 has nothing to open.
    pub children: i64,
    /// Open: its children follow it.
    pub open: bool,
    /// Context: not a match, shown for a match below it (dimmed, and open by default).
    pub context: bool,
    /// It has a parent on GitHub, shown or not (a root's may be a stub, a PR or in a repo the
    /// tree doesn't show): a move under another issue takes it from that parent.
    pub has_parent: bool,
}

#[derive(Deserialize)]
pub struct TreeQuery {
    q: Option<String>,
    after: Option<String>,
    through: Option<String>,
    /// The ids the user opened, comma-separated.
    #[serde(default)]
    open: String,
    /// The ids the user closed that open by default, comma-separated.
    #[serde(default)]
    shut: String,
    /// Only what this node shows under it.
    under: Option<i64>,
    /// With `under`: every node under it open (`1`).
    all: Option<String>,
    sel: Option<i64>,
}

/// Comma-separated ids, the last `OPENS_MAX` (the newest); anything that isn't one is left out.
fn ids(s: &str) -> HashSet<i64> {
    let all: Vec<i64> = s.split(',').filter_map(|p| p.trim().parse().ok()).collect();
    all[all.len().saturating_sub(OPENS_MAX)..]
        .iter()
        .copied()
        .collect()
}

/// What the tab has opened and closed.
struct Opens {
    open: HashSet<i64>,
    shut: HashSet<i64>,
    /// Everything opens (`all`).
    all: bool,
}

impl Opens {
    /// Whether a node shows its children: the user opened it, or it's context they didn't close.
    fn open(&self, id: i64, context: bool) -> bool {
        self.all || self.open.contains(&id) || (context && !self.shut.contains(&id))
    }
}

/// A node placed in the answer, before its row is read.
struct Placed {
    id: i64,
    depth: i64,
    parent: Option<i64>,
    children: i64,
    open: bool,
    context: bool,
}

/// What a node read shows: whether it's open, whether a match is at or above it, and its
/// children, each with whether a match is at or above it.
type Shows = (bool, bool, Vec<(i64, bool)>);

/// `starts` (each with whether a match is at or above it) and what each shows open, depth first,
/// each start at depth 0, at most `NODES_MAX`.
fn flatten(
    c: &Reader,
    tree: &Tree,
    starts: &[(i64, bool)],
    parent: Option<i64>,
    opens: &Opens,
) -> QueryResult<Vec<Placed>> {
    // Read a level at a time, so each level is one query; then laid out depth first.
    // Each node read: open, a match at or above it, and its children (each with the same).
    let mut shows: HashMap<i64, Shows> = HashMap::new();
    let mut level: Vec<(i64, bool)> = starts.to_vec();
    let mut count = starts.len();
    // GitHub nests at most 8 levels; the cap only stops a loop.
    for _ in 0..64 {
        if level.is_empty() {
            break;
        }
        let kids = tree.children(c, &level)?;
        let mut next = Vec::new();
        for &(id, under) in &level {
            let ks: Vec<(i64, bool)> = kids
                .get(&id)
                .map(|ks| ks.iter().map(|&k| (k, under || tree.is_match(k))).collect())
                .unwrap_or_default();
            let open = !ks.is_empty() && opens.open(id, !under) && count + ks.len() <= NODES_MAX;
            if open {
                count += ks.len();
                next.extend(ks.iter().copied());
            }
            shows.insert(id, (open, under, ks));
        }
        level = next;
    }
    let mut out = Vec::new();
    let mut stack: Vec<(i64, i64, Option<i64>)> = starts
        .iter()
        .rev()
        .map(|&(id, _)| (id, 0, parent))
        .collect();
    while let Some((id, depth, parent)) = stack.pop() {
        let (open, under, ks) = shows.remove(&id).unwrap_or((false, true, Vec::new()));
        out.push(Placed {
            id,
            depth,
            parent,
            children: ks.len() as i64,
            open,
            context: !under,
        });
        if open {
            stack.extend(ks.iter().rev().map(|&(k, _)| (k, depth + 1, Some(id))));
        }
    }
    Ok(out)
}

/// Whether a match is at `id` or above it.
fn under_match(c: &Reader, tree: &Tree, id: i64) -> QueryResult<bool> {
    Ok(q::ancestry(c, id)?.iter().any(|a| tree.is_match(a.id)))
}

/// Where `sel` shows: itself if every node above it is open and shows it, else the nearest of them
/// that shows; `None` when no root of the tree is above it.
fn shown_as(c: &Reader, tree: &Tree, sel: i64, opens: &Opens) -> QueryResult<Option<i64>> {
    // Top first.
    let chain: Vec<i64> = q::ancestry(c, sel)?.iter().rev().map(|a| a.id).collect();
    let Some(top) = chain.iter().position(|&id| tree.is_root(id)) else {
        return Ok(None);
    };
    let mut at = chain[top];
    let mut under = tree.is_match(at);
    for &next in &chain[top + 1..] {
        let kids = tree.children(c, &[(at, under)])?;
        let shows = kids.get(&at).is_some_and(|ks| ks.contains(&next));
        if !shows || !opens.open(at, !under) {
            break;
        }
        at = next;
        under = under || tree.is_match(at);
    }
    Ok(Some(at))
}

/// The view's tree, or the part of it the query asks for. See the module's notes.
pub async fn tree(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Query(tq): Query<TreeQuery>,
) -> Result<Json<TreePage>, ApiError> {
    let view = query::parse(tq.q.as_deref().unwrap_or(query::DEFAULT));
    let cursor = |c: &str| match c.parse::<Cursor>() {
        Ok(cur) if cur.fits(&view) => Ok(cur),
        Ok(_) => Err(ApiError::BadRequest(format!(
            "cursor {c:?} is from another order than this view's"
        ))),
        Err(()) => Err(ApiError::BadRequest(format!(
            "cursor {c:?} isn't one this server writes"
        ))),
    };
    let (span, limit) = match (tq.after.as_deref(), tq.through.as_deref()) {
        (Some(_), Some(_)) => {
            return Err(ApiError::BadRequest(
                "after and through don't go together".into(),
            ));
        }
        (Some(after), None) => (Span::After(cursor(after)?), PAGE),
        (None, Some(through)) => (Span::Through(cursor(through)?), THROUGH_MAX as usize),
        (None, None) => (Span::Top, PAGE),
    };
    let opens = Opens {
        open: ids(&tq.open),
        shut: ids(&tq.shut),
        all: tq.under.is_some() && matches!(tq.all.as_deref(), Some("1" | "true")),
    };
    let (account, me) = (s.account, s.account);
    let cache = app.trees().clone();
    let (under, sel) = (tq.under, tq.sel);
    let page = app
        .mirrors()
        .read(account, Caller::Request, move |c| {
            let seq = q::current_seq(c)?;
            let key = view_key(&view);
            let tree = cache.get(account, &key, seq, || Tree::build(c, &view, me))?;
            let (placed, next, last) = match under {
                Some(id) => {
                    let under = under_match(c, &tree, id)?;
                    let kids = tree.children(c, &[(id, under)])?.remove(&id);
                    let starts: Vec<(i64, bool)> = kids
                        .unwrap_or_default()
                        .into_iter()
                        .map(|k| (k, under || tree.is_match(k)))
                        .collect();
                    (flatten(c, &tree, &starts, Some(id), &opens)?, None, None)
                }
                None => {
                    let mut roots = tree.page(span, limit + 1);
                    let mut more = roots.len() > limit;
                    roots.truncate(limit);
                    if let (Span::Through(_), false, Some(&l)) = (span, more, roots.last()) {
                        more = !tree.page(Span::After(l), 1).is_empty();
                    }
                    let last = roots.last().copied();
                    let starts: Vec<(i64, bool)> =
                        roots.iter().map(|r| (r.id, tree.is_match(r.id))).collect();
                    (
                        flatten(c, &tree, &starts, None, &opens)?,
                        more.then_some(last).flatten(),
                        last,
                    )
                }
            };
            let ids: Vec<i64> = placed.iter().map(|p| p.id).collect();
            let mut rows: HashMap<i64, IssueRow> = crate::api::read_rows(c, &view, &ids)?
                .into_iter()
                .map(|r| (r.id, r))
                .collect();
            let nodes = placed
                .into_iter()
                .filter_map(|p| {
                    Some(TreeNode {
                        row: rows.remove(&p.id)?,
                        depth: p.depth,
                        parent: p.parent,
                        children: p.children,
                        open: p.open,
                        context: p.context,
                        has_parent: p.parent.is_some() || tree.has_hidden_parent(p.id),
                    })
                })
                .collect();
            let selected = match sel {
                Some(id) => shown_as(c, &tree, id, &opens)?,
                None => None,
            };
            Ok(TreePage {
                nodes,
                next: next.map(|c| c.to_string()),
                last: last.map(|c| c.to_string()),
                selected,
            })
        })
        .await?;
    Ok(Json(page))
}

#[derive(Deserialize)]
pub struct DropQuery {
    /// The issue dragged.
    child: i64,
    /// Where it would go: under this issue.
    parent: i64,
}

/// Whether a drop may go ahead.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct DropCheck {
    /// Why the drop can't be made, in words for the user, as a write of it would be refused; `null`
    /// when it can.
    pub why: Option<String>,
}

/// `GET /api/tree/drop?child=&parent=`: whether a drop placing `child` under `parent` would be
/// refused, and why. Under the parent it has, it's a reorder there; under another, a move from any
/// parent it has (`replace_parent`, as the tree's drop writes it). The reasons are the write's own,
/// before any call: a parent beghu takes no writes on, the refusals of `relationship_writes` (as
/// the detail's "Move to another parent…" lists them) for a move, and a repo this server doesn't
/// write to. (The role check joins here with #106.)
pub async fn drop_check(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Query(dq): Query<DropQuery>,
) -> Result<Json<DropCheck>, ApiError> {
    if let Err(f) = ops::writable(&app, s.account, dq.parent).await {
        return Ok(Json(DropCheck {
            why: Some(f.words()),
        }));
    }
    let (parent, child) = (dq.parent, dq.child);
    let (why, repos) = app
        .mirrors()
        .read(s.account, Caller::Request, move |c| {
            let old = q::parent_of(c, child)?.map(|p| p.id);
            let repos_of = |ids: &[i64]| -> QueryResult<Vec<(String, String)>> {
                let mut out = Vec::new();
                for &id in ids {
                    out.extend(q::op_target(c, id)?.map(|t| (t.owner, t.repo)));
                }
                Ok(out)
            };
            // Among its own parent's sub-issues already: a reorder, a write on the parent alone,
            // which nothing else refuses.
            if old == Some(parent) {
                return Ok((None, repos_of(&[parent])?));
            }
            // A move under another issue: from the parent it has, if any, as the write moves it
            // (`replace_parent`), and the repos it changes: the new parent's, the issue's, and its
            // old parent's.
            let why = relationship_writes::refusal(
                c,
                RelationshipKind::Sub,
                parent,
                child,
                old.is_some(),
            )?;
            let mut ids = vec![parent, child];
            ids.extend(old);
            Ok((why, repos_of(&ids)?))
        })
        .await?;
    // A repo this server doesn't write to (`BEGHU_DEV_WRITABLE_REPOS`), as the write is refused.
    let why = why.or_else(|| {
        repos
            .iter()
            .find_map(|(owner, repo)| ops::read_only_here(&app, owner, repo).err())
            .map(|f| f.words())
    });
    Ok(Json(DropCheck { why }))
}

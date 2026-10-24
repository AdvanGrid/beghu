// PROTOTYPE for "Prototype the issue list and filter bar" (beghu #52). Throwaway.
// The axum-solid2-router server, with richer rows (author, milestone, relationship hints), more
// filter dimensions (repo, milestone, author, no:, is:blocked, kind, sort) and facets with counts
// for the current view.

use std::{convert::Infallible, env, time::Duration};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use axum_extra::extract::Query;
use futures_util::Stream;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{OptionalExtension, params, params_from_iter, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio_stream::{StreamExt, wrappers::BroadcastStream};
use tower_http::{
    compression::CompressionLayer,
    services::{ServeDir, ServeFile},
};
use ts_rs::TS;

type Pool = r2d2::Pool<SqliteConnectionManager>;

const ME: &str = "anna-b";

#[derive(Clone)]
struct AppState {
    pool: Pool,
    events: broadcast::Sender<Changed>,
    latency: Duration,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Count {
    pub name: String,
    pub color: Option<String>,
    #[ts(type = "number")]
    pub count: i64,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Facets {
    /// The signed-in user, for `assignee:me`.
    pub me: String,
    #[ts(type = "number")]
    pub open: i64,
    #[ts(type = "number")]
    pub closed: i64,
    pub labels: Vec<Count>,
    pub assignees: Vec<Count>,
    pub repos: Vec<Count>,
    pub milestones: Vec<Count>,
    pub authors: Vec<Count>,
    #[ts(type = "number")]
    pub ms: i64,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export)]
pub struct Label {
    pub name: String,
    pub color: String,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ParentRef {
    #[ts(type = "number")]
    pub id: i64,
    pub repo: String,
    #[ts(type = "number")]
    pub number: i64,
    pub title: String,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct IssueRow {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub number: i64,
    pub repo: String,
    pub title: String,
    pub kind: String,
    pub state: String,
    pub state_reason: Option<String>,
    pub draft: bool,
    pub author: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[ts(type = "number")]
    pub comments_count: i64,
    pub labels: Vec<Label>,
    pub assignees: Vec<String>,
    pub milestone: Option<String>,
    pub parent: Option<ParentRef>,
    #[ts(type = "number")]
    pub subs: i64,
    #[ts(type = "number")]
    pub subs_done: i64,
    #[ts(type = "number")]
    pub blocked_by: i64,
    #[ts(type = "number")]
    pub blocking: i64,
    #[ts(type = "number")]
    pub relates: i64,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Comment {
    #[ts(type = "number")]
    pub id: i64,
    pub author: Option<String>,
    pub body: String,
    pub created_at: String,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct IssueDetail {
    #[serde(flatten)]
    pub row: IssueRow,
    pub body: String,
    pub repo_labels: Vec<Label>,
    pub comments: Vec<Comment>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct IssuePage {
    pub rows: Vec<IssueRow>,
    #[ts(type = "number")]
    pub ms: i64,
}

#[derive(Deserialize, TS, Clone, Default)]
#[ts(export)]
pub struct ListQuery {
    /// open (default), closed or all
    pub state: Option<String>,
    /// issue (default), pr or all
    pub kind: Option<String>,
    /// Every label must match.
    #[serde(default)]
    pub label: Vec<String>,
    /// Every assignee must match.
    #[serde(default)]
    pub assignee: Vec<String>,
    /// Any repo matches.
    #[serde(default)]
    pub repo: Vec<String>,
    /// Any milestone matches.
    #[serde(default)]
    pub milestone: Vec<String>,
    /// Any author matches.
    #[serde(default)]
    pub author: Vec<String>,
    /// label, assignee or milestone: has none.
    #[serde(default)]
    pub no: Vec<String>,
    /// blocked: has an open blocker.
    #[serde(default)]
    pub is: Vec<String>,
    pub q: Option<String>,
    /// updated (default), created, oldest, comments
    pub sort: Option<String>,
    /// Tree only: the node whose children to list; none lists the roots.
    #[ts(type = "number | null")]
    pub parent: Option<i64>,
    /// Tree only: also every visible descendant of what's listed.
    pub deep: Option<bool>,
    /// Tree only: `path` adds only what leads to a match; `all` (same as deep) adds everything.
    pub deep_mode: Option<String>,
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct AddLabel {
    pub name: String,
}

/// Pushed to every open tab when issues change.
#[derive(Serialize, Clone, TS)]
#[ts(export)]
pub struct Changed {
    #[ts(type = "number[]")]
    pub ids: Vec<i64>,
}

enum AppError {
    NotFound,
    Unprocessable(&'static str),
    Internal(String),
}

impl<E: std::fmt::Display> From<E> for AppError {
    fn from(e: E) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "not found").into_response(),
            AppError::Unprocessable(m) => (StatusCode::UNPROCESSABLE_ENTITY, m).into_response(),
            AppError::Internal(m) => {
                eprintln!("{m}");
                (StatusCode::INTERNAL_SERVER_ERROR, m).into_response()
            }
        }
    }
}

/// Runs blocking SQLite work off the async runtime.
async fn with_db<T: Send + 'static>(
    pool: &Pool,
    f: impl FnOnce(&mut rusqlite::Connection) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let pool = pool.clone();
    tokio::task::spawn_blocking(move || f(&mut *pool.get()?)).await?
}

const ROW: &str = "SELECT i.id, i.number, r.name, i.title, i.state, i.updated_at, i.comments_count,
  (SELECT json_group_array(json_object('name', l.name, 'color', l.color)) FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = i.id),
  (SELECT json_group_array(u.login) FROM item_assignees ia JOIN users u ON u.id = ia.user_id WHERE ia.item_id = i.id),
  i.kind, i.state_reason, i.draft, (SELECT login FROM users WHERE id = i.author_id), i.created_at,
  (SELECT title FROM milestones WHERE id = i.milestone_id),
  (SELECT json_object('id', p.id, 'repo', pr.name, 'number', p.number, 'title', p.title)
     FROM relationships x JOIN items p ON p.id = x.src_id JOIN repos pr ON pr.id = p.repo_id WHERE x.kind = 'sub' AND x.dst_id = i.id),
  (SELECT count(*) FROM relationships x WHERE x.kind = 'sub' AND x.src_id = i.id),
  (SELECT count(*) FROM relationships x JOIN items c ON c.id = x.dst_id WHERE x.kind = 'sub' AND x.src_id = i.id AND c.state = 'closed'),
  (SELECT count(*) FROM relationships x JOIN items b ON b.id = x.src_id WHERE x.kind = 'blocks' AND x.dst_id = i.id AND b.state = 'open'),
  (SELECT count(*) FROM relationships x WHERE x.kind = 'blocks' AND x.src_id = i.id),
  (SELECT count(*) FROM relationships x WHERE x.kind = 'relates' AND (x.src_id = i.id OR x.dst_id = i.id))
  FROM items i JOIN repos r ON r.id = i.repo_id";

fn row(r: &rusqlite::Row) -> rusqlite::Result<IssueRow> {
    let labels: String = r.get(7)?;
    let assignees: String = r.get(8)?;
    let parent: Option<String> = r.get(15)?;
    Ok(IssueRow {
        id: r.get(0)?,
        number: r.get(1)?,
        repo: r.get(2)?,
        title: r.get(3)?,
        state: r.get(4)?,
        updated_at: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
        comments_count: r.get(6)?,
        labels: serde_json::from_str(&labels).unwrap_or_default(),
        assignees: serde_json::from_str(&assignees).unwrap_or_default(),
        kind: r.get(9)?,
        state_reason: r.get(10)?,
        draft: r.get::<_, Option<i64>>(11)?.unwrap_or(0) != 0,
        author: r.get(12)?,
        created_at: r.get::<_, Option<String>>(13)?.unwrap_or_default(),
        milestone: r.get(14)?,
        parent: parent.and_then(|p| serde_json::from_str(&p).ok()),
        subs: r.get(16)?,
        subs_done: r.get(17)?,
        blocked_by: r.get(18)?,
        blocking: r.get(19)?,
        relates: r.get(20)?,
    })
}

/// The WHERE clause for a view. `skip` leaves out one dimension, so a facet can count what
/// picking another value of it would give (used for the OR dimensions and for state).
fn filter(q: &ListQuery, skip: Option<&str>) -> (String, Vec<SqlValue>) {
    let mut sql = String::from(" WHERE i.is_stub = 0");
    let mut args: Vec<SqlValue> = vec![];
    match q.kind.as_deref() {
        Some("all") => {}
        Some("pr") => sql += " AND i.kind = 'pr'",
        _ => sql += " AND i.kind = 'issue'",
    }
    if skip != Some("state") {
        match q.state.as_deref() {
            Some("all") => {}
            Some("closed") => sql += " AND i.state = 'closed'",
            _ => sql += " AND i.state = 'open'",
        }
    }
    for name in &q.label {
        sql += " AND i.id IN (SELECT item_id FROM item_labels WHERE label_id IN (SELECT id FROM labels WHERE name = ?))";
        args.push(name.clone().into());
    }
    // `me` is the signed-in user; the prototype signs everyone in as anna-b.
    let me = |v: &String| if v == "me" { ME.to_string() } else { v.clone() };
    for login in &q.assignee {
        sql += " AND i.id IN (SELECT item_id FROM item_assignees WHERE user_id IN (SELECT id FROM users WHERE login = ?))";
        args.push(me(login).into());
    }
    let mut any = |dim: &str, values: &[String], col: &str, sub: &str, sql: &mut String| {
        if skip == Some(dim) || values.is_empty() {
            return;
        }
        *sql += &format!(" AND {col} IN ({sub} IN ({}))", vec!["?"; values.len()].join(","));
        args.extend(values.iter().map(|v| SqlValue::from(me(v))));
    };
    any("repo", &q.repo, "i.repo_id", "SELECT id FROM repos WHERE name", &mut sql);
    any("milestone", &q.milestone, "i.milestone_id", "SELECT id FROM milestones WHERE title", &mut sql);
    any("author", &q.author, "i.author_id", "SELECT id FROM users WHERE login", &mut sql);
    for no in &q.no {
        match no.as_str() {
            "label" => sql += " AND NOT EXISTS (SELECT 1 FROM item_labels WHERE item_id = i.id)",
            "assignee" => sql += " AND NOT EXISTS (SELECT 1 FROM item_assignees WHERE item_id = i.id)",
            "milestone" => sql += " AND i.milestone_id IS NULL",
            _ => {}
        }
    }
    if q.is.iter().any(|v| v == "blocked") {
        sql += " AND EXISTS (SELECT 1 FROM relationships x JOIN items b ON b.id = x.src_id WHERE x.kind = 'blocks' AND x.dst_id = i.id AND b.state = 'open')";
    }
    if let Some(text) = q.q.as_ref().filter(|t| !t.is_empty()) {
        sql += " AND instr(lower(i.title), lower(?)) > 0";
        args.push(text.clone().into());
    }
    (sql, args)
}

/// Counts each value within the view, starting from the view's ids, then lists every other value
/// (from `all`) with 0.
fn count_by(c: &rusqlite::Connection, counts: &str, all: &str, q: &ListQuery, skip: Option<&str>) -> Result<Vec<Count>, AppError> {
    let (wh, args) = filter(q, skip);
    let sql = counts.replace("{VIEW}", &format!("SELECT i.id, i.repo_id, i.milestone_id, i.author_id FROM items i{wh}"));
    let mut rows: Vec<Count> = c
        .prepare_cached(&sql)?
        .query_map(params_from_iter(args), |r| Ok(Count { name: r.get(0)?, color: r.get(1)?, count: r.get(2)? }))?
        .collect::<Result<_, _>>()?;
    let rest: Vec<Count> = c
        .prepare_cached(all)?
        .query_map([], |r| Ok(Count { name: r.get(0)?, color: r.get(1)?, count: 0 }))?
        .collect::<Result<_, _>>()?;
    for r in rest {
        if !rows.iter().any(|x| x.name == r.name) {
            rows.push(r);
        }
    }
    Ok(rows)
}

async fn facets(State(s): State<AppState>, Query(q): Query<ListQuery>) -> Result<Json<Facets>, AppError> {
    with_db(&s.pool, move |c| {
        let t = std::time::Instant::now();
        let (wh, args) = filter(&q, Some("state"));
        let (open, closed): (i64, i64) = c.prepare_cached(&format!(
            "SELECT coalesce(sum(i.state = 'open'), 0), coalesce(sum(i.state = 'closed'), 0) FROM items i{wh}"
        ))?
        .query_row(params_from_iter(args), |r| Ok((r.get(0)?, r.get(1)?)))?;
        let labels = count_by(
            c,
            "SELECT l.name, min(l.color), count(*) n FROM ({VIEW}) v JOIN item_labels il ON il.item_id = v.id
             JOIN labels l ON l.id = il.label_id GROUP BY l.name ORDER BY n DESC, l.name",
            "SELECT name, min(color) FROM labels GROUP BY name ORDER BY name",
            &q,
            None,
        )?;
        let assignees = count_by(
            c,
            "SELECT u.login, NULL, count(*) n FROM ({VIEW}) v JOIN item_assignees ia ON ia.item_id = v.id
             JOIN users u ON u.id = ia.user_id GROUP BY u.id ORDER BY n DESC, u.login",
            "SELECT DISTINCT u.login, NULL FROM item_assignees ia JOIN users u ON u.id = ia.user_id ORDER BY u.login",
            &q,
            None,
        )?;
        let repos = count_by(
            c,
            "SELECT r.name, NULL, count(*) n FROM ({VIEW}) v JOIN repos r ON r.id = v.repo_id GROUP BY r.id ORDER BY n DESC, r.name",
            "SELECT name, NULL FROM repos WHERE synced = 1 ORDER BY name",
            &q,
            Some("repo"),
        )?;
        let milestones = count_by(
            c,
            "SELECT m.title, NULL, count(*) n FROM ({VIEW}) v JOIN milestones m ON m.id = v.milestone_id GROUP BY m.title ORDER BY n DESC, m.title",
            "SELECT DISTINCT title, NULL FROM milestones ORDER BY title",
            &q,
            Some("milestone"),
        )?;
        let authors = count_by(
            c,
            "SELECT u.login, NULL, count(*) n FROM ({VIEW}) v JOIN users u ON u.id = v.author_id GROUP BY u.id ORDER BY n DESC, u.login",
            "SELECT DISTINCT u.login, NULL FROM items i JOIN users u ON u.id = i.author_id ORDER BY u.login",
            &q,
            Some("author"),
        )?;
        Ok(Json(Facets {
            me: ME.into(),
            open,
            closed,
            labels,
            assignees,
            repos,
            milestones,
            authors,
            ms: t.elapsed().as_millis() as i64,
        }))
    })
    .await
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct TreeNode {
    #[serde(flatten)]
    pub row: IssueRow,
    #[ts(type = "number | null")]
    pub parent_id: Option<i64>,
    /// Matches the view; false means it's shown only as an ancestor of a match.
    pub matched: bool,
    /// Visible children (matches or ancestors of matches).
    #[ts(type = "number")]
    pub children: i64,
    /// Every descendant at any depth, and how many are closed, ignoring the view.
    #[ts(type = "number")]
    pub total: i64,
    #[ts(type = "number")]
    pub done: i64,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct TreePage {
    pub nodes: Vec<TreeNode>,
    #[ts(type = "number")]
    pub ms: i64,
}

/// The view as a tree: matches sit inside their ancestors. Roots (no parent) are sorted by the
/// view's sort and paged; children keep GitHub's sub-issue order.
async fn tree(State(s): State<AppState>, Query(q): Query<ListQuery>) -> Result<Json<TreePage>, AppError> {
    with_db(&s.pool, move |c| {
        let t = std::time::Instant::now();
        // t_m: matches. t_vis: matches and their ancestors. t_show: t_vis plus every descendant of a
        // match that passes the view's state and kind, so a matching parent can be opened all the
        // way down (non-matching rows show as context).
        c.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS t_m(id INTEGER PRIMARY KEY);
             CREATE TEMP TABLE IF NOT EXISTS t_vis(id INTEGER PRIMARY KEY);
             CREATE TEMP TABLE IF NOT EXISTS t_base(id INTEGER PRIMARY KEY);
             CREATE TEMP TABLE IF NOT EXISTS t_show(id INTEGER PRIMARY KEY);
             DELETE FROM t_m; DELETE FROM t_vis; DELETE FROM t_base; DELETE FROM t_show;",
        )?;
        let (wh, args) = filter(&q, None);
        c.execute(&format!("INSERT INTO t_m SELECT i.id FROM items i{wh}"), params_from_iter(args))?;
        c.execute(
            "INSERT INTO t_vis WITH RECURSIVE up(id) AS (SELECT id FROM t_m UNION SELECT x.src_id FROM up JOIN relationships x ON x.kind = 'sub' AND x.dst_id = up.id) SELECT id FROM up",
            [],
        )?;
        let base = ListQuery { state: q.state.clone(), kind: q.kind.clone(), ..Default::default() };
        let (wh, args) = filter(&base, None);
        c.execute(&format!("INSERT INTO t_base SELECT i.id FROM items i{wh}"), params_from_iter(args))?;
        c.execute(
            "INSERT INTO t_show WITH RECURSIVE dn(id) AS (SELECT id FROM t_m UNION
               SELECT x.dst_id FROM dn CROSS JOIN relationships x ON x.kind = 'sub' AND x.src_id = dn.id CROSS JOIN t_base b ON b.id = x.dst_id)
             SELECT id FROM dn UNION SELECT id FROM t_vis",
            [],
        )?;
        let children = |c: &rusqlite::Connection, id: i64| -> rusqlite::Result<Vec<i64>> {
            c.prepare_cached("SELECT x.dst_id FROM relationships x CROSS JOIN t_show v ON v.id = x.dst_id WHERE x.kind = 'sub' AND x.src_id = ? ORDER BY x.position, x.dst_id")?
                .query_map([id], |r| r.get(0))?
                .collect()
        };
        // On the path to a match: in t_vis with a child in t_vis.
        let on_path = |c: &rusqlite::Connection, id: i64| -> rusqlite::Result<bool> {
            c.prepare_cached("SELECT EXISTS (SELECT 1 FROM relationships x CROSS JOIN t_vis v ON v.id = x.dst_id WHERE x.kind = 'sub' AND x.src_id = ?)")?
                .query_row([id], |r| r.get(0))
        };
        let mut out: Vec<(i64, Option<i64>)> = vec![];
        match q.parent {
            Some(p) => out.extend(children(c, p)?.into_iter().map(|id| (id, Some(p)))),
            None => {
                let order = match q.sort.as_deref() {
                    Some("created") => "i.created_at DESC, i.id DESC",
                    Some("oldest") => "i.created_at ASC, i.id ASC",
                    Some("comments") => "i.comments_count DESC, i.id DESC",
                    _ => "i.updated_at DESC, i.id DESC",
                };
                let roots: Vec<i64> = c
                    .prepare_cached(&format!(
                        "SELECT i.id FROM items i JOIN t_vis v ON v.id = i.id
                         WHERE NOT EXISTS (SELECT 1 FROM relationships x WHERE x.kind = 'sub' AND x.dst_id = i.id)
                         ORDER BY {order} LIMIT ? OFFSET ?"
                    ))?
                    .query_map(params![q.limit.unwrap_or(100).clamp(1, 500), q.offset.unwrap_or(0).max(0)], |r| r.get(0))?
                    .collect::<Result<_, _>>()?;
                out.extend(roots.into_iter().map(|id| (id, None)));
            }
        }
        let mode = q.deep_mode.clone().unwrap_or_default();
        if q.deep == Some(true) || !mode.is_empty() {
            let all = mode != "path";
            // Depth-first, so the client can append each node's children in order.
            let mut i = 0;
            let mut full = vec![];
            let mut stack: Vec<(i64, Option<i64>)> = out.into_iter().rev().collect();
            while let Some((id, parent)) = stack.pop() {
                full.push((id, parent));
                if !all && !on_path(c, id)? {
                    continue;
                }
                for kid in children(c, id)?.into_iter().rev() {
                    stack.push((kid, Some(id)));
                }
                i += 1;
                if i > 5000 {
                    break;
                }
            }
            out = full;
        }
        let mut nodes = Vec::with_capacity(out.len());
        for (id, parent_id) in out {
            let row = c.prepare_cached(&format!("{ROW} WHERE i.id = ?"))?.query_row([id], row)?;
            let matched: bool = c.prepare_cached("SELECT EXISTS (SELECT 1 FROM t_m WHERE id = ?)")?.query_row([id], |r| r.get(0))?;
            let kids: i64 = c
                .prepare_cached("SELECT count(*) FROM relationships x CROSS JOIN t_show v ON v.id = x.dst_id WHERE x.kind = 'sub' AND x.src_id = ?")?
                .query_row([id], |r| r.get(0))?;
            let (total, done): (i64, i64) = c
                .prepare_cached(
                    "WITH RECURSIVE d(id) AS (SELECT dst_id FROM relationships WHERE kind = 'sub' AND src_id = ?1
                       UNION ALL SELECT x.dst_id FROM d JOIN relationships x ON x.kind = 'sub' AND x.src_id = d.id)
                     SELECT count(*), coalesce(sum(i.state = 'closed'), 0) FROM d CROSS JOIN items i ON i.id = d.id",
                )?
                .query_row([id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            nodes.push(TreeNode { row, parent_id, matched, children: kids, total, done });
        }
        Ok(Json(TreePage { nodes, ms: t.elapsed().as_millis() as i64 }))
    })
    .await
}

async fn list_issues(State(s): State<AppState>, Query(q): Query<ListQuery>) -> Result<Json<IssuePage>, AppError> {
    with_db(&s.pool, move |c| {
        let t = std::time::Instant::now();
        let (wh, mut args) = filter(&q, None);
        let order = match q.sort.as_deref() {
            Some("created") => "i.created_at DESC, i.id DESC",
            Some("oldest") => "i.created_at ASC, i.id ASC",
            Some("comments") => "i.comments_count DESC, i.id DESC",
            _ => "i.updated_at DESC, i.id DESC",
        };
        let sql = format!("{ROW}{wh} ORDER BY {order} LIMIT ? OFFSET ?");
        args.push(q.limit.unwrap_or(100).clamp(1, 500).into());
        args.push(q.offset.unwrap_or(0).max(0).into());
        let rows = c.prepare_cached(&sql)?.query_map(params_from_iter(args), row)?.collect::<Result<_, _>>()?;
        Ok(Json(IssuePage { rows, ms: t.elapsed().as_millis() as i64 }))
    })
    .await
}

async fn issue_detail(State(s): State<AppState>, Path(id): Path<i64>) -> Result<Json<IssueDetail>, AppError> {
    with_db(&s.pool, move |c| {
        let Some(row) = c.prepare_cached(&format!("{ROW} WHERE i.id = ?"))?.query_row([id], row).optional()? else {
            return Err(AppError::NotFound);
        };
        let (body, repo_id): (Option<String>, i64) =
            c.prepare_cached("SELECT body, repo_id FROM items WHERE id = ?")?.query_row([id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let repo_labels = c
            .prepare_cached("SELECT name, color FROM labels WHERE repo_id = ? ORDER BY name")?
            .query_map([repo_id], |r| Ok(Label { name: r.get(0)?, color: r.get(1)? }))?
            .collect::<Result<_, _>>()?;
        let comments = c
            .prepare_cached(
                "SELECT c.id, u.login, c.body, c.created_at FROM comments c LEFT JOIN users u ON u.id = c.author_id
                 WHERE c.item_id = ? ORDER BY c.created_at, c.id",
            )?
            .query_map([id], |r| Ok(Comment { id: r.get(0)?, author: r.get(1)?, body: r.get(2)?, created_at: r.get(3)? }))?
            .collect::<Result<_, _>>()?;
        Ok(Json(IssueDetail { row, body: body.unwrap_or_default(), repo_labels, comments }))
    })
    .await
}

fn now() -> String {
    // RFC 3339 in UTC at second precision, without pulling in a date crate.
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem / 60 % 60, rem % 60)
}

async fn add_label(State(s): State<AppState>, Path(id): Path<i64>, Json(body): Json<AddLabel>) -> Result<StatusCode, AppError> {
    tokio::time::sleep(s.latency).await; // stands in for the GitHub API call
    with_db(&s.pool, move |c| {
        let label: Option<i64> = c
            .prepare_cached("SELECT l.id FROM labels l JOIN items i ON i.repo_id = l.repo_id WHERE i.id = ? AND l.name = ?")?
            .query_row(params![id, body.name], |r| r.get(0))
            .optional()?;
        let Some(label) = label else { return Err(AppError::Unprocessable("no such label")) };
        let tx = c.transaction()?;
        tx.execute("INSERT OR IGNORE INTO item_labels VALUES (?, ?, 0)", params![id, label])?;
        tx.execute("UPDATE items SET updated_at = ? WHERE id = ?", params![now(), id])?;
        tx.commit()?;
        Ok(())
    })
    .await?;
    let _ = s.events.send(Changed { ids: vec![id] });
    Ok(StatusCode::OK)
}

// --- webhooks -------------------------------------------------------------------------------

#[derive(Deserialize)]
struct GhUser {
    id: i64,
    login: String,
    #[serde(default)]
    avatar_url: String,
}

#[derive(Deserialize)]
struct GhLabel {
    id: i64,
    name: String,
    color: String,
    description: Option<String>,
}

#[derive(Deserialize)]
struct GhIssue {
    id: i64,
    node_id: String,
    number: i64,
    title: String,
    body: Option<String>,
    state: String,
    state_reason: Option<String>,
    user: Option<GhUser>,
    comments: i64,
    created_at: Option<String>,
    updated_at: String,
    closed_at: Option<String>,
    #[serde(default)]
    labels: Vec<GhLabel>,
    #[serde(default)]
    assignees: Vec<GhUser>,
    pull_request: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct GhRepo {
    id: i64,
}

#[derive(Deserialize)]
struct GhComment {
    id: i64,
    node_id: String,
    user: Option<GhUser>,
    body: String,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
struct Payload {
    action: Option<String>,
    issue: Option<GhIssue>,
    comment: Option<GhComment>,
    repository: Option<GhRepo>,
    parent_issue_id: Option<i64>,
    sub_issue_id: Option<i64>,
}

fn upsert_user(c: &rusqlite::Connection, u: &GhUser) -> rusqlite::Result<()> {
    c.prepare_cached("INSERT INTO users (id, login, avatar_url, seq) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET login = excluded.login")?
        .execute(params![u.id, u.login, u.avatar_url])?;
    Ok(())
}

/// Applies an issue object from a webhook, guarded by updated_at (newer or equal wins).
fn apply_issue(c: &rusqlite::Connection, issue: &GhIssue, repo_id: i64) -> rusqlite::Result<bool> {
    let cur: Option<Option<String>> =
        c.prepare_cached("SELECT updated_at FROM items WHERE id = ?")?.query_row([issue.id], |r| r.get(0)).optional()?;
    if let Some(Some(cur)) = cur {
        if cur.as_str() > issue.updated_at.as_str() {
            return Ok(false);
        }
    }
    if let Some(u) = &issue.user {
        upsert_user(c, u)?;
    }
    c.prepare_cached(
        "INSERT INTO items (id, node_id, repo_id, number, kind, title, body, state, state_reason, author_id, comments_count, created_at, updated_at, closed_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, state = excluded.state, state_reason = excluded.state_reason,
           comments_count = excluded.comments_count, updated_at = excluded.updated_at, closed_at = excluded.closed_at, is_stub = 0",
    )?
    .execute(params![
        issue.id,
        issue.node_id,
        repo_id,
        issue.number,
        if issue.pull_request.is_some() { "pr" } else { "issue" },
        issue.title,
        issue.body,
        issue.state,
        issue.state_reason,
        issue.user.as_ref().map(|u| u.id),
        issue.comments,
        issue.created_at,
        issue.updated_at,
        issue.closed_at,
    ])?;
    c.prepare_cached("DELETE FROM item_labels WHERE item_id = ?")?.execute([issue.id])?;
    for l in &issue.labels {
        c.prepare_cached("INSERT OR IGNORE INTO labels (id, repo_id, name, color, description, seq) VALUES (?, ?, ?, ?, ?, 0)")?
            .execute(params![l.id, repo_id, l.name, l.color, l.description])?;
        c.prepare_cached("INSERT OR IGNORE INTO item_labels VALUES (?, ?, 0)")?.execute([issue.id, l.id])?;
    }
    c.prepare_cached("DELETE FROM item_assignees WHERE item_id = ?")?.execute([issue.id])?;
    for a in &issue.assignees {
        upsert_user(c, a)?;
        c.prepare_cached("INSERT OR IGNORE INTO item_assignees VALUES (?, ?, 0)")?.execute([issue.id, a.id])?;
    }
    Ok(true)
}

async fn webhook(State(s): State<AppState>, headers: HeaderMap, Json(p): Json<Payload>) -> Result<StatusCode, AppError> {
    let event = headers.get("x-github-event").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
    let ids = with_db(&s.pool, move |c| {
        let tx = c.transaction()?;
        let mut ids = vec![];
        let repo_id = p.repository.as_ref().map(|r| r.id).unwrap_or_default();
        match event.as_str() {
            "issues" => {
                if let Some(issue) = &p.issue {
                    if apply_issue(&tx, issue, repo_id)? {
                        ids.push(issue.id);
                    }
                }
            }
            "issue_comment" => {
                if let (Some(comment), Some(issue)) = (&p.comment, &p.issue) {
                    if let Some(u) = &comment.user {
                        upsert_user(&tx, u)?;
                    }
                    tx.execute(
                        "INSERT OR REPLACE INTO comments VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
                        params![comment.id, comment.node_id, issue.id, comment.user.as_ref().map(|u| u.id), comment.body, comment.created_at, comment.updated_at],
                    )?;
                    apply_issue(&tx, issue, repo_id)?;
                    ids.push(issue.id);
                }
            }
            "sub_issues" if p.action.as_deref() == Some("sub_issue_added") => {
                if let (Some(parent), Some(child)) = (p.parent_issue_id, p.sub_issue_id) {
                    tx.execute(
                        "INSERT OR IGNORE INTO relationships VALUES ('sub', ?1, ?2, (SELECT coalesce(max(position), 0) + 1 FROM relationships WHERE kind = 'sub' AND src_id = ?1), 0)",
                        params![parent, child],
                    )?;
                    ids.extend([parent, child]);
                }
            }
            _ => {}
        }
        tx.commit()?;
        Ok(ids)
    })
    .await?;
    if !ids.is_empty() {
        let _ = s.events.send(Changed { ids });
    }
    Ok(StatusCode::ACCEPTED)
}

async fn sse(State(s): State<AppState>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(s.events.subscribe())
        .filter_map(|m| m.ok())
        .map(|changed| Ok(Event::default().json_data(changed).expect("serialisable")));
    Sse::new(stream).keep_alive(KeepAlive::default())
}

#[tokio::main]
async fn main() {
    let port: u16 = env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let latency = Duration::from_millis(env::var("GITHUB_LATENCY_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(300));
    let path = env::var("MIRROR_PATH").unwrap_or_else(|_| "/data/mirror.db".into());
    let public = env::var("PUBLIC_DIR").unwrap_or_else(|_| "public".into());

    let manager = SqliteConnectionManager::file(&path)
        .with_init(|c| c.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;"));
    let pool = r2d2::Pool::builder().max_size(4).build(manager).expect("open mirror");
    // Indexes that let label and assignee filters start from the matching items instead of
    // walking the whole list in order.
    pool.get()
        .unwrap()
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS item_labels_by_label ON item_labels(label_id, item_id);
             CREATE INDEX IF NOT EXISTS item_assignees_by_user ON item_assignees(user_id, item_id);
             CREATE INDEX IF NOT EXISTS items_created ON items(kind, state, created_at DESC, id DESC);
             CREATE INDEX IF NOT EXISTS items_comments ON items(kind, state, comments_count DESC, id DESC);
             CREATE INDEX IF NOT EXISTS items_milestone ON items(milestone_id);
             CREATE INDEX IF NOT EXISTS items_author ON items(author_id);
             CREATE INDEX IF NOT EXISTS items_facets ON items(kind, state, is_stub, repo_id, milestone_id, author_id);
             ANALYZE;",
        )
        .expect("create indexes");
    let (events, _) = broadcast::channel(256);
    let state = AppState { pool, events, latency };

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/api/facets", get(facets))
        .route("/api/issues", get(list_issues))
        .route("/api/tree", get(tree))
        .route("/api/issues/{id}", get(issue_detail))
        .route("/api/issues/{id}/labels", post(add_label))
        .route("/webhook", post(webhook))
        .route("/events", get(sse))
        // Client-side routes (/issues/:id) get the SPA shell.
        .fallback_service(ServeDir::new(&public).fallback(ServeFile::new(format!("{public}/index.html"))))
        .layer(CompressionLayer::new())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.unwrap();
    println!("list-prototype listening on {port}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
            term.recv().await;
        })
        .await
        .unwrap();
}

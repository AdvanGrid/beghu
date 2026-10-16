// Filtering-location benchmark, forked from the axum + Solid 2 candidate. One server, three
// variants picked by BENCH_VARIANT: `server` filters in SQLite per keystroke; `client` and
// `worker` load a compact snapshot of every row into the browser (IndexedDB plus memory) and
// filter there, catching up through `/api/snapshot?since=<seq>`. The Solid SPA (../web) is served
// from ./public, one HTML entry per variant.

use std::{convert::Infallible, env, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{FromRequestParts, Path, State},
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
use tower_http::{compression::CompressionLayer, services::ServeDir};
use ts_rs::TS;

type Pool = r2d2::Pool<SqliteConnectionManager>;

const PRAGMAS: &str = "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;";

/// One mirror per account, as in beghu. `BENCH_ACCOUNTS` sets how many (default 1), and
/// `BENCH_CONN` how requests reach them: `pool` keeps up to 4 connections per account, `open`
/// opens and closes one per request.
#[derive(Clone)]
struct Db {
    paths: Arc<Vec<String>>,
    pools: Option<Arc<Vec<Pool>>>,
}

/// The account a request is for, from `x-account` (default 0). Stands in for the session cookie.
struct Account(usize);

impl<S: Send + Sync> FromRequestParts<S> for Account {
    type Rejection = Infallible;
    async fn from_request_parts(parts: &mut axum::http::request::Parts, _: &S) -> Result<Self, Infallible> {
        Ok(Account(parts.headers.get("x-account").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(0)))
    }
}

#[derive(Clone)]
struct AppState {
    db: Db,
    events: broadcast::Sender<Changed>,
    latency: Duration,
    variant: &'static str,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Facets {
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export)]
pub struct Label {
    pub name: String,
    pub color: String,
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
    pub state: String,
    pub updated_at: String,
    #[ts(type = "number")]
    pub comments_count: i64,
    pub labels: Vec<Label>,
    pub assignees: Vec<String>,
}

/// One page of the server-filtered list, with the total number of matches.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct Page {
    pub rows: Vec<IssueRow>,
    #[ts(type = "number")]
    pub total: i64,
}

/// One cached row: `[id, number, repo, is_pr, title, open, updated_at, comments, labels, assignees]`.
/// `repo`, `labels` and `assignees` index the dictionaries of the snapshot that carries it.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct CacheRow(
    #[ts(type = "number")] pub i64,
    #[ts(type = "number")] pub i64,
    pub u32,
    pub bool,
    pub String,
    pub bool,
    pub String,
    #[ts(type = "number")] pub i64,
    pub Vec<u32>,
    pub Vec<u32>,
);

/// Every row changed after `since` (all rows when `since` is 0), with the dictionaries its indexes
/// point into. The dictionaries are small, so each delta carries them whole. `seq` is the cursor
/// for the next delta.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct Snapshot {
    pub repos: Vec<String>,
    pub labels: Vec<Label>,
    pub users: Vec<String>,
    pub items: Vec<CacheRow>,
    #[ts(type = "number")]
    pub seq: i64,
}

#[derive(Deserialize)]
pub struct SnapshotQuery {
    pub since: Option<i64>,
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

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct ListQuery {
    pub state: Option<String>,
    #[serde(default)]
    pub label: Vec<String>,
    #[serde(default)]
    pub assignee: Vec<String>,
    pub q: Option<String>,
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

/// Runs blocking SQLite work on an account's mirror, off the async runtime.
async fn with_db<T: Send + 'static>(
    db: &Db,
    account: usize,
    f: impl FnOnce(&mut rusqlite::Connection) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let db = db.clone();
    let account = account % db.paths.len();
    tokio::task::spawn_blocking(move || match &db.pools {
        Some(pools) => f(&mut *pools[account].get()?),
        None => {
            let mut c = rusqlite::Connection::open(&db.paths[account])?;
            c.execute_batch(PRAGMAS)?;
            f(&mut c)
        }
    })
    .await?
}

const ROW: &str = "SELECT i.id, i.number, r.name, i.title, i.state, i.updated_at, i.comments_count,
  (SELECT json_group_array(json_object('name', l.name, 'color', l.color)) FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = i.id),
  (SELECT json_group_array(u.login) FROM item_assignees ia JOIN users u ON u.id = ia.user_id WHERE ia.item_id = i.id)
  FROM items i JOIN repos r ON r.id = i.repo_id";

fn row(r: &rusqlite::Row) -> rusqlite::Result<IssueRow> {
    let labels: String = r.get(7)?;
    let assignees: String = r.get(8)?;
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
    })
}

async fn facets(State(s): State<AppState>, Account(a): Account) -> Result<Json<Facets>, AppError> {
    with_db(&s.db, a, |c| {
        let labels = c
            .prepare_cached("SELECT DISTINCT name FROM labels ORDER BY name")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        let assignees = c
            .prepare_cached("SELECT DISTINCT u.login FROM item_assignees ia JOIN users u ON u.id = ia.user_id ORDER BY u.id")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(Json(Facets { labels, assignees }))
    })
    .await
}

async fn list_issues(State(s): State<AppState>, Account(a): Account, Query(q): Query<ListQuery>) -> Result<Json<Page>, AppError> {
    with_db(&s.db, a, move |c| {
        let mut filter = String::from(" WHERE i.kind = 'issue' AND i.is_stub = 0 AND i.state = ?");
        let mut args: Vec<SqlValue> = vec![if q.state.as_deref() == Some("closed") { "closed" } else { "open" }.to_string().into()];
        // `+i.id` keeps SQLite scanning the covering `issue_list` index and probing each label or
        // assignee set, instead of starting from the set and looking every item up by id.
        for name in q.label {
            filter += " AND +i.id IN (SELECT item_id FROM item_labels WHERE label_id IN (SELECT id FROM labels WHERE name = ?))";
            args.push(name.into());
        }
        for login in q.assignee {
            filter += " AND +i.id IN (SELECT item_id FROM item_assignees WHERE user_id IN (SELECT id FROM users WHERE login = ?))";
            args.push(login.into());
        }
        if let Some(text) = q.q.filter(|t| !t.is_empty()) {
            filter += " AND instr(lower(i.title), lower(?)) > 0";
            args.push(text.into());
        }
        let offset = q.offset.unwrap_or(0).max(0);
        // The total only matters for the first page; later pages reuse the client's.
        let total: i64 = if offset == 0 {
            c.prepare_cached(&format!("SELECT count(*) FROM items i{filter}"))?.query_row(params_from_iter(args.iter()), |r| r.get(0))?
        } else {
            -1
        };
        // Page the ids from the covering index first, then build only those rows. Selecting the row
        // columns directly makes SQLite pick the wider index and read every scanned row.
        let sql = format!(
            "WITH page AS (SELECT i.id FROM items i{filter} ORDER BY i.updated_at DESC, i.id DESC LIMIT ? OFFSET ?)
             {ROW} JOIN page ON page.id = i.id ORDER BY i.updated_at DESC, i.id DESC"
        );
        args.push(q.limit.unwrap_or(100).clamp(1, 500).into());
        args.push(offset.into());
        let rows = c.prepare_cached(&sql)?.query_map(params_from_iter(args), row)?.collect::<Result<_, _>>()?;
        Ok(Json(Page { rows, total }))
    })
    .await
}

async fn snapshot(State(s): State<AppState>, Account(a): Account, Query(q): Query<SnapshotQuery>) -> Result<Json<Snapshot>, AppError> {
    let since = q.since.unwrap_or(0);
    with_db(&s.db, a, move |c| {
        let mut repos = vec![];
        let mut repo_ix = std::collections::HashMap::new();
        for r in c.prepare_cached("SELECT id, name FROM repos ORDER BY id")?.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
            let (id, name) = r?;
            repo_ix.insert(id, repos.len() as u32);
            repos.push(name);
        }
        let mut labels = vec![];
        let mut label_ix = std::collections::HashMap::new();
        for r in c.prepare_cached("SELECT id, name, color FROM labels ORDER BY id")?.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get(1)?, r.get(2)?)))? {
            let (id, name, color) = r?;
            label_ix.insert(id, labels.len() as u32);
            labels.push(Label { name, color });
        }
        let mut users = vec![];
        let mut user_ix = std::collections::HashMap::new();
        for r in c.prepare_cached("SELECT id, login FROM users ORDER BY id")?.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
            let (id, login) = r?;
            user_ix.insert(id, users.len() as u32);
            users.push(login);
        }
        // Label and assignee ids per item, grouped in SQL, mapped to dictionary indexes here.
        let mut items: Vec<CacheRow> = vec![];
        let mut stmt = c.prepare_cached(
            "SELECT i.id, i.number, i.repo_id, i.kind = 'pr', i.title, i.state = 'open', coalesce(i.updated_at, ''), i.comments_count,
               (SELECT group_concat(label_id) FROM item_labels WHERE item_id = i.id),
               (SELECT group_concat(user_id) FROM item_assignees WHERE item_id = i.id)
             FROM items i WHERE i.is_stub = 0 AND i.seq > ? ORDER BY i.updated_at DESC, i.id DESC",
        )?;
        let ids = |v: Option<String>, ix: &std::collections::HashMap<i64, u32>| -> Vec<u32> {
            v.map(|v| v.split(',').filter_map(|x| x.parse().ok()).filter_map(|x| ix.get(&x).copied()).collect()).unwrap_or_default()
        };
        let mut rows = stmt.query([since])?;
        while let Some(r) = rows.next()? {
            items.push(CacheRow(
                r.get(0)?,
                r.get(1)?,
                repo_ix.get(&r.get::<_, i64>(2)?).copied().unwrap_or(0),
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                ids(r.get(8)?, &label_ix),
                ids(r.get(9)?, &user_ix),
            ));
        }
        let seq: i64 = c.prepare_cached("SELECT coalesce(max(seq), 0) FROM items")?.query_row([], |r| r.get(0))?;
        Ok(Json(Snapshot { repos, labels, users, items, seq }))
    })
    .await
}

async fn issue_detail(State(s): State<AppState>, Account(a): Account, Path(id): Path<i64>) -> Result<Json<IssueDetail>, AppError> {
    with_db(&s.db, a, move |c| {
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

async fn add_label(State(s): State<AppState>, Account(a): Account, Path(id): Path<i64>, Json(body): Json<AddLabel>) -> Result<StatusCode, AppError> {
    tokio::time::sleep(s.latency).await; // stands in for the GitHub API call
    with_db(&s.db, a, move |c| {
        let label: Option<i64> = c
            .prepare_cached("SELECT l.id FROM labels l JOIN items i ON i.repo_id = l.repo_id WHERE i.id = ? AND l.name = ?")?
            .query_row(params![id, body.name], |r| r.get(0))
            .optional()?;
        let Some(label) = label else { return Err(AppError::Unprocessable("no such label")) };
        let tx = c.transaction()?;
        tx.execute("INSERT OR IGNORE INTO item_labels VALUES (?, ?, 0)", params![id, label])?;
        tx.execute("UPDATE items SET updated_at = ? WHERE id = ?", params![now(), id])?;
        bump(&tx, id)?;
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

/// Moves an item past every cached cursor, so the next `/api/snapshot?since=` carries it.
fn bump(c: &rusqlite::Connection, id: i64) -> rusqlite::Result<()> {
    c.prepare_cached("UPDATE items SET seq = (SELECT max(seq) FROM items) + 1 WHERE id = ?")?.execute([id])?;
    Ok(())
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
    bump(c, issue.id)?;
    Ok(true)
}

async fn webhook(State(s): State<AppState>, headers: HeaderMap, Json(p): Json<Payload>) -> Result<StatusCode, AppError> {
    let event = Arc::new(headers.get("x-github-event").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned());
    let p = Arc::new(p);
    // Every account sees every fixture repo, so each mirror gets the write, one after another.
    let mut ids = vec![];
    for a in 0..s.db.paths.len() {
        let (event, p) = (event.clone(), p.clone());
        ids = with_db(&s.db, a, move |c| apply_webhook(c, &event, &p)).await?;
    }
    if !ids.is_empty() {
        let _ = s.events.send(Changed { ids });
    }
    Ok(StatusCode::ACCEPTED)
}

fn apply_webhook(c: &mut rusqlite::Connection, event: &str, p: &Payload) -> Result<Vec<i64>, AppError> {
    let tx = c.transaction()?;
    let mut ids = vec![];
    let repo_id = p.repository.as_ref().map(|r| r.id).unwrap_or_default();
    match event {
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
    let variant: &'static str = match env::var("BENCH_VARIANT").as_deref() {
        Ok("client") => "client",
        Ok("worker") => "worker",
        _ => "server",
    };

    let accounts: usize = env::var("BENCH_ACCOUNTS").ok().and_then(|v| v.parse().ok()).unwrap_or(1).max(1);
    let pooled = env::var("BENCH_CONN").as_deref() != Ok("open");

    // Indexes for the server variant's filters. `issue_list` covers the list's state, order and
    // title, so counts and title searches never touch the table; `item_cache` covers the
    // snapshot, which would otherwise read every body page and sort.
    let c = rusqlite::Connection::open(&path).expect("open mirror");
    c.execute_batch(PRAGMAS).expect("pragmas");
    c.execute_batch(
        "CREATE INDEX IF NOT EXISTS item_labels_by_label ON item_labels(label_id, item_id);
         CREATE INDEX IF NOT EXISTS item_assignees_by_user ON item_assignees(user_id, item_id);
         CREATE INDEX IF NOT EXISTS issue_list ON items(state, updated_at DESC, id DESC, title) WHERE kind = 'issue' AND is_stub = 0;
         CREATE INDEX IF NOT EXISTS item_cache ON items(updated_at DESC, id DESC, number, repo_id, kind, title, state, comments_count, seq) WHERE is_stub = 0;
         ANALYZE;
         PRAGMA wal_checkpoint(TRUNCATE);",
    )
    .expect("create indexes");
    drop(c);
    // Account 0 is the harness's mirror; the others are copies of it (reflinks where supported).
    let paths: Vec<String> = (0..accounts)
        .map(|a| {
            if a == 0 {
                return path.clone();
            }
            let p = path.replace(".db", &format!("-{a}.db"));
            std::fs::copy(&path, &p).expect("copy mirror");
            p
        })
        .collect();
    let pools = pooled.then(|| {
        Arc::new(
            paths
                .iter()
                .map(|p| {
                    let manager = SqliteConnectionManager::file(p).with_init(|c| c.execute_batch(PRAGMAS));
                    r2d2::Pool::builder().max_size(4).min_idle(Some(1)).build(manager).expect("open mirror")
                })
                .collect(),
        )
    });
    let (events, _) = broadcast::channel(256);
    let state = AppState { db: Db { paths: Arc::new(paths), pools }, events, latency, variant };

    let pages: &'static [(&'static str, String)] = Box::leak(
        ["server", "client", "worker"]
            .map(|v| (v, std::fs::read_to_string(format!("{public}/{v}.html")).unwrap_or_default()))
            .into(),
    );
    let index = move |State(s): State<AppState>| async move {
        let html = pages.iter().find(|(v, _)| *v == s.variant).map(|(_, h)| h.clone()).unwrap_or_default();
        axum::response::Html(html)
    };
    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/", get(index))
        .route("/api/facets", get(facets))
        .route("/api/issues", get(list_issues))
        .route("/api/snapshot", get(snapshot))
        .route("/api/issues/{id}", get(issue_detail))
        .route("/api/issues/{id}/labels", post(add_label))
        .route("/webhook", post(webhook))
        .route("/events", get(sse))
        .fallback_service(ServeDir::new(&public))
        .layer(CompressionLayer::new())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.unwrap();
    println!("filtering ({variant}, {accounts} accounts, {}) listening on {port}", if pooled { "pooled" } else { "open per request" });
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
            term.recv().await;
        })
        .await
        .unwrap();
}

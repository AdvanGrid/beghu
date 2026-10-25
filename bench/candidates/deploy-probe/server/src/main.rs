// axum + Solid candidate: an axum server owns the SQLite mirror, filters on the server and pushes
// changed ids over server-sent events. The Solid SPA (../web) is served from ./public.

use std::{
    convert::Infallible,
    env,
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{Path, State},
    body::Body,
    http::{HeaderMap, HeaderValue, Request, StatusCode, header},
    middleware::{self, Next},
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
use tower_http::compression::CompressionLayer;
use ts_rs::TS;

type Pool = r2d2::Pool<SqliteConnectionManager>;

#[derive(Clone)]
struct AppState {
    pool: Pool,
    deploy: Arc<RwLock<Deploy>>,
    log: Arc<Mutex<Vec<serde_json::Value>>>,
    events: broadcast::Sender<Changed>,
    latency: Duration,
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
    pub number: i64,
    pub repo: String,
    pub title: String,
    pub state: String,
    pub updated_at: String,
    pub comments_count: i64,
    pub labels: Vec<Label>,
    pub assignees: Vec<String>,
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

async fn facets(State(s): State<AppState>) -> Result<Json<Facets>, AppError> {
    with_db(&s.pool, |c| {
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

async fn list_issues(State(s): State<AppState>, Query(q): Query<ListQuery>) -> Result<Json<Vec<IssueRow>>, AppError> {
    with_db(&s.pool, move |c| {
        let mut sql = format!("{ROW} WHERE i.kind = 'issue' AND i.is_stub = 0 AND i.state = ?");
        let mut args: Vec<SqlValue> = vec![if q.state.as_deref() == Some("closed") { "closed" } else { "open" }.to_string().into()];
        for name in q.label {
            sql += " AND i.id IN (SELECT item_id FROM item_labels WHERE label_id IN (SELECT id FROM labels WHERE name = ?))";
            args.push(name.into());
        }
        for login in q.assignee {
            sql += " AND i.id IN (SELECT item_id FROM item_assignees WHERE user_id IN (SELECT id FROM users WHERE login = ?))";
            args.push(login.into());
        }
        if let Some(text) = q.q.filter(|t| !t.is_empty()) {
            sql += " AND instr(lower(i.title), lower(?)) > 0";
            args.push(text.into());
        }
        sql += " ORDER BY i.updated_at DESC, i.id DESC LIMIT ? OFFSET ?";
        args.push(q.limit.unwrap_or(100).clamp(1, 500).into());
        args.push(q.offset.unwrap_or(0).max(0).into());
        let rows = c.prepare_cached(&sql)?.query_map(params_from_iter(args), row)?.collect::<Result<_, _>>()?;
        Ok(Json(rows))
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
    let public = env::var("BUILDS_DIR").unwrap_or_else(|_| "../builds".into());

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
             ANALYZE;",
        )
        .expect("create indexes");
    let (events, _) = broadcast::channel(256);
    let current = env::var("BUILD").unwrap_or_else(|_| "A".into());
    let builds = Deploy { root: public, keep: vec![current.clone()], current };
    let state = AppState { pool, events, latency, deploy: Arc::new(RwLock::new(builds)), log: Default::default() };

    let api = Router::new()
        .route("/api/me", get(me))
        .route("/api/facets", get(facets))
        .route("/api/issues", get(list_issues))
        .route("/api/issues/{id}", get(issue_detail))
        .route("/api/issues/{id}/labels", post(add_label))
        .route("/events", get(sse))
        .route_layer(middleware::from_fn(require_session));
    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .merge(api)
        .route("/webhook", post(webhook))
        .route("/auth/login", get(login))
        .route("/auth/callback", get(callback))
        .route("/auth/logout", post(logout))
        .route("/assets/{file}", get(asset))
        .route("/__deploy", post(deploy))
        .route("/__log", get(read_log).delete(clear_log))
        // Every other path (/, /issues/:id) gets the current build's shell.
        .fallback(shell)
        .layer(middleware::from_fn_with_state(state.clone(), log_requests))
        .layer(CompressionLayer::new())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.unwrap();
    println!("axum-solid listening on {port}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
            term.recv().await;
        })
        .await
        .unwrap();
}

// ---- Deploy probe: builds, shell caching, sign-in -------------------------------------------

/// Which build's shell is served, and whose hashed assets are still on disk. A deploy swaps
/// `current`; `keep` lists the builds whose assets survive it (current is always served).
struct Deploy {
    root: String,
    current: String,
    keep: Vec<String>,
}

fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.into())
}

fn session(headers: &HeaderMap) -> Option<String> {
    let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
    cookies.split(';').find_map(|c| c.trim().strip_prefix("sid=").map(str::to_owned)).filter(|v| !v.is_empty())
}

async fn require_session(req: Request<Body>, next: Next) -> Response {
    if session(req.headers()).is_none() {
        return (StatusCode::UNAUTHORIZED, "signed out").into_response();
    }
    let mut res = next.run(req).await;
    // API_CACHE_CONTROL unset leaves the header off, as the candidate does today.
    if let Ok(cc) = env::var("API_CACHE_CONTROL") {
        res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_str(&cc).unwrap());
    }
    res
}

async fn log_requests(State(s): State<AppState>, req: Request<Body>, next: Next) -> Response {
    let path = req.uri().to_string();
    let account = session(req.headers());
    let inm = req.headers().get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let res = next.run(req).await;
    if !path.starts_with("/__") {
        let entry = serde_json::json!({ "path": path, "account": account, "if_none_match": inm, "status": res.status().as_u16() });
        s.log.lock().unwrap().push(entry);
    }
    res
}

async fn read_log(State(s): State<AppState>) -> Json<Vec<serde_json::Value>> {
    Json(s.log.lock().unwrap().clone())
}

async fn clear_log(State(s): State<AppState>) -> StatusCode {
    s.log.lock().unwrap().clear();
    StatusCode::NO_CONTENT
}

#[derive(Deserialize)]
struct DeployQuery {
    build: String,
    /// Comma-separated builds whose assets stay available; empty deletes every old build's.
    #[serde(default)]
    keep: String,
}

async fn deploy(State(s): State<AppState>, Query(q): Query<DeployQuery>) -> StatusCode {
    let mut d = s.deploy.write().unwrap();
    d.keep = q.keep.split(',').filter(|b| !b.is_empty()).map(str::to_owned).collect();
    d.current = q.build;
    StatusCode::NO_CONTENT
}

async fn me(headers: HeaderMap) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "account": session(&headers) }))
}

/// The account-free shell. SHELL_MAX_AGE (default 300) sets `max-age`; the build id is the ETag, so
/// a revalidation after a deploy gets the new shell and before one gets a 304. VARY_COOKIE=1 adds
/// `Vary: Cookie`.
async fn shell(State(s): State<AppState>, headers: HeaderMap) -> Response {
    let (root, current) = {
        let d = s.deploy.read().unwrap();
        (d.root.clone(), d.current.clone())
    };
    let etag = format!("\"{current}\"");
    let mut res = if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        match tokio::fs::read_to_string(format!("{root}/{current}/index.html")).await {
            Ok(html) => ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response(),
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    };
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_str(&format!("max-age={}", env_or("SHELL_MAX_AGE", "300"))).unwrap());
    h.insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
    if env::var("VARY_COOKIE").is_ok_and(|v| v == "1") {
        h.insert(header::VARY, HeaderValue::from_static("Cookie"));
    }
    res
}

/// Hashed assets: immutable, looked up in the current build and then every kept one. A missing
/// asset is a 404, never the shell.
async fn asset(State(s): State<AppState>, Path(file): Path<String>) -> Response {
    if file.contains('/') || file.contains("..") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let (root, builds) = {
        let d = s.deploy.read().unwrap();
        (d.root.clone(), std::iter::once(d.current.clone()).chain(d.keep.iter().cloned()).collect::<Vec<_>>())
    };
    for b in builds {
        if let Ok(bytes) = tokio::fs::read(format!("{root}/{b}/assets/{file}")).await {
            let ct = if file.ends_with(".css") { "text/css" } else { "text/javascript" };
            return ([(header::CONTENT_TYPE, ct), (header::CACHE_CONTROL, "public, max-age=31536000, immutable")], bytes).into_response();
        }
    }
    StatusCode::NOT_FOUND.into_response()
}

#[derive(Deserialize)]
struct LoginQuery {
    account: Option<String>,
    next: Option<String>,
}

/// Stands in for GitHub's authorize page: with `account` it "approves" at once and redirects to the
/// callback, as GitHub does for an app the user already authorised.
async fn login(Query(q): Query<LoginQuery>) -> Response {
    let next = q.next.unwrap_or_else(|| "/".into());
    match q.account {
        Some(a) => {
            let to = format!("/auth/callback?code={a}&next={}", urlencode(&next));
            (StatusCode::FOUND, [(header::LOCATION, to)]).into_response()
        }
        None => (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-store")],
            format!(
                "<!doctype html><title>Sign in</title><p id=signin-page>Sign in: <a id=as-a href=\"/auth/login?account=a&next={n}\">a</a> <a id=as-b href=\"/auth/login?account=b&next={n}\">b</a>",
                n = urlencode(&next)
            ),
        )
            .into_response(),
    }
}

async fn callback(Query(q): Query<std::collections::HashMap<String, String>>) -> Response {
    let code = q.get("code").cloned().unwrap_or_default();
    let next = q.get("next").filter(|n| n.starts_with('/') && !n.starts_with("//")).cloned().unwrap_or_else(|| "/".into());
    let cookie = format!("sid={code}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000");
    (StatusCode::FOUND, [(header::SET_COOKIE, cookie), (header::LOCATION, next)]).into_response()
}

async fn logout() -> Response {
    let mut res = (StatusCode::SEE_OTHER, [(header::LOCATION, "/"), (header::SET_COOKIE, "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0")]).into_response();
    // CLEAR_SITE_DATA, e.g. "cache", is sent as-is.
    if let Ok(v) = env::var("CLEAR_SITE_DATA") {
        res.headers_mut().insert("clear-site-data", HeaderValue::from_str(&v).unwrap());
    }
    res
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}


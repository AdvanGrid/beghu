// Proa candidate for "Frontend benchmark: Proa": the axum + Solid server's SQL behind Proa SSR
// pages. No hand-written app JavaScript: Turbo Drive (filters, search, detail), lazy Turbo Frames
// (paging), a Turbo Stream source (live refresh) and two RSJS islands. Throwaway.

mod db;
mod labels;
mod opts;
mod pages;
mod search;
mod shell;

use std::{collections::HashMap, convert::Infallible, env, sync::Arc, time::Duration};

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use axum_extra::extract::Query;
use futures_util::Stream;
use proa_framework_axum::{router_from_spec, IslandManifest, Route, RouteContextLayer, RouteResponse};
use r2d2_sqlite::SqliteConnectionManager;
use tokio::sync::broadcast;
use tokio_stream::{wrappers::BroadcastStream, StreamExt};
use tower_http::{compression::CompressionLayer, services::ServeDir};

use db::{Facets, ListQuery, Pool};
use pages::{ListPage, RowsFrame};
use shell::{DetailPage, Document};

#[derive(Clone)]
struct AppState {
    pool: Pool,
    facets: Arc<Facets>,
    changed: broadcast::Sender<()>,
    latency: Duration,
}

struct AppError(StatusCode, String);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        if self.0.is_server_error() {
            eprintln!("{}", self.1);
        }
        (self.0, self.1).into_response()
    }
}

fn internal(e: impl std::fmt::Display) -> AppError {
    AppError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

/// Runs blocking SQLite work off the async runtime.
async fn with_db<T: Send + 'static>(
    pool: &Pool,
    f: impl FnOnce(&mut db::Conn) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let pool = pool.clone();
    tokio::task::spawn_blocking(move || f(&mut *pool.get().map_err(internal)?)).await.map_err(internal)?
}

async fn list_page(State(s): State<AppState>, Query(q): Query<ListQuery>) -> Result<impl IntoResponse, AppError> {
    let q = ListQuery { offset: None, ..q };
    let rows = with_db(&s.pool, {
        let q = q.clone();
        move |c| db::list(c, &q, opts::OPTS.page).map_err(internal)
    })
    .await?;
    Ok(RouteResponse::ssr_async(Document { title: "Issues".into(), content: proa_core::to_async(ListPage { facets: s.facets.clone(), q, rows }) }))
}

async fn rows_frame(State(s): State<AppState>, Query(q): Query<ListQuery>) -> Result<impl IntoResponse, AppError> {
    let offset = q.offset.unwrap_or(0).max(0);
    let rows = with_db(&s.pool, {
        let q = q.clone();
        move |c| db::list(c, &q, opts::OPTS.page).map_err(internal)
    })
    .await?;
    Ok(RouteResponse::ssr(RowsFrame { q, offset, rows }))
}

async fn detail_page(State(s): State<AppState>, Path(id): Path<i64>) -> Result<impl IntoResponse, AppError> {
    let d = with_db(&s.pool, move |c| db::detail(c, id).map_err(internal))
        .await?
        .ok_or_else(|| AppError(StatusCode::NOT_FOUND, "not found".into()))?;
    let title = d.row.title.clone();
    Ok(RouteResponse::ssr_async(Document { title, content: DetailPage { d } }))
}

/// The label island's mutation: a JSON string `"<issue id>\t<label name>"`.
async fn add_label(State(s): State<AppState>, Json(key): Json<String>) -> Result<StatusCode, AppError> {
    let (id, name) = key
        .split_once('\t')
        .and_then(|(id, name)| Some((id.parse::<i64>().ok()?, name.to_string())))
        .ok_or_else(|| AppError(StatusCode::UNPROCESSABLE_ENTITY, "bad label key".into()))?;
    tokio::time::sleep(s.latency).await; // stands in for the GitHub API call
    let ok = with_db(&s.pool, move |c| db::add_label(c, id, &name).map_err(internal)).await?;
    if !ok {
        return Err(AppError(StatusCode::UNPROCESSABLE_ENTITY, "no such label".into()));
    }
    let _ = s.changed.send(());
    Ok(StatusCode::OK)
}

async fn webhook(State(s): State<AppState>, headers: HeaderMap, Json(p): Json<db::Payload>) -> Result<StatusCode, AppError> {
    let event = headers.get("x-github-event").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
    let ids = with_db(&s.pool, move |c| db::apply_webhook(c, &event, p).map_err(internal)).await?;
    if !ids.is_empty() {
        let _ = s.changed.send(());
    }
    Ok(StatusCode::ACCEPTED)
}

/// A Turbo Stream source: every change asks open pages for a morphing refresh of their URL.
async fn stream(State(s): State<AppState>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let refreshes = BroadcastStream::new(s.changed.subscribe())
        .filter_map(|m| m.ok())
        .map(|()| Ok(Event::default().data(r#"<turbo-stream action="refresh"></turbo-stream>"#)));
    Sse::new(refreshes).keep_alive(KeepAlive::default())
}

// --- RSJS assets --------------------------------------------------------------------------------
// Stable URLs, served `public, no-cache` with an ETag, as "Page caching" asks for unhashed URLs.

fn etag(source: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    source.hash(&mut h);
    format!("\"{:016x}\"", h.finish())
}

fn js(headers: &HeaderMap, source: &'static str) -> Response {
    let tag = etag(source);
    if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(tag.as_str()) {
        return (StatusCode::NOT_MODIFIED, [(header::ETAG, tag)]).into_response();
    }
    (
        [
            (header::CONTENT_TYPE, "application/javascript; charset=utf-8".to_string()),
            (header::CACHE_CONTROL, "public, no-cache".to_string()),
            (header::ETAG, tag),
        ],
        source,
    )
        .into_response()
}

async fn island(Path(file): Path<String>, headers: HeaderMap) -> Response {
    let asset_id = file.strip_suffix(".js").unwrap_or(file.as_str());
    let fragment_id = asset_id.strip_prefix("component_").unwrap_or(asset_id);
    let manifest = rsjs::manifest();
    let source = manifest.islands.iter().find(|e| e.asset_id == asset_id).map(|e| e.js_source).or_else(|| {
        manifest.component_fragments.iter().find(|e| e.asset_id == asset_id || e.asset_id == fragment_id).map(|e| e.js_source)
    });
    match source {
        Some(source) => js(&headers, source),
        None => (StatusCode::NOT_FOUND, "unknown rsjs asset").into_response(),
    }
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
    // The axum + Solid candidate's indexes: label and assignee filters start from the matching items.
    pool.get()
        .unwrap()
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS item_labels_by_label ON item_labels(label_id, item_id);
             CREATE INDEX IF NOT EXISTS item_assignees_by_user ON item_assignees(user_id, item_id);
             ANALYZE;",
        )
        .expect("create indexes");
    let facets = Arc::new(db::facets(&pool.get().unwrap()).expect("facets"));
    let (changed, _) = broadcast::channel(256);
    let state = AppState { pool, facets, changed, latency };

    let (router, metadata) = router_from_spec(vec![
        Route::endpoint("/", get(list_page)),
        Route::endpoint("/rows", get(rows_frame)),
        Route::endpoint("/issues/:id", get(detail_page)),
    ]);
    let manifest = Arc::new(IslandManifest { islands: HashMap::new(), assets: Default::default(), import_map: HashMap::new(), ssr_bundle: None });
    let app: Router = router
        .route("/healthz", get(|| async { "ok" }))
        .route("/api/labels", post(add_label))
        .route("/webhook", post(webhook))
        .route("/stream", get(stream))
        .route("/rsjs-runtime.js", get(|h: HeaderMap| async move { js(&h, rsjs::runtime_assets::CORE_JS) }))
        .route("/rsjs-runtime-query.js", get(|h: HeaderMap| async move { js(&h, rsjs::runtime_assets::QUERY_JS) }))
        .route("/rsjs/island/:file", get(island))
        .nest_service("/static", ServeDir::new(public))
        .with_state(state)
        .layer(RouteContextLayer::new(manifest, metadata))
        .layer(CompressionLayer::new());

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.unwrap();
    println!("proa listening on {port}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
            term.recv().await;
        })
        .await
        .unwrap();
}

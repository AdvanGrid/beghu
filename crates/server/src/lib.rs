//! The beghu server: sign-in, the browser session, the shell, and the JSON API. Webhooks and
//! jobs land here as later slices add them.

mod api;
mod auth;
mod config;
mod crypto;
mod error;
mod github;
mod repos;
mod shell;
mod tokens;

pub use config::{Config, GitHubConfig, MirrorsConfig};

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use control_db::Control;
use mirror_db::Mirrors;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// The running server's shared state.
#[derive(Clone)]
pub struct App(Arc<Inner>);

struct Inner {
    cfg: Config,
    control: Arc<Control>,
    mirrors: Mirrors,
    github: github::GitHub,
    keys: Arc<crypto::Keys>,
    tokens: tokens::Tokens,
    shell: Option<String>,
    /// Each account's role re-reads from GitHub.
    roles: repos::Roles,
}

impl App {
    /// Opens the control DB (migrating it after a `VACUUM INTO` backup) and the mirrors under
    /// `BEGHU_DATA_DIR`, and reads the shell template. Any error should stop startup.
    pub async fn open(cfg: Config) -> Result<App, String> {
        let (path, backups) = (cfg.control_db(), cfg.backups());
        let control = tokio::task::spawn_blocking(move || Control::open(&path, &backups))
            .await
            .map_err(|_| "opening the control DB panicked".to_owned())?
            .map_err(|e| format!("can't open the control DB: {e}"))?
            .0;
        let control = Arc::new(control);
        let mirrors = Mirrors::new(cfg.mirrors_dir(), cfg.mirrors.clone());
        let shell = match &cfg.web_dir {
            Some(dir) => {
                let path = dir.join("index.html");
                let html = std::fs::read_to_string(&path)
                    .map_err(|e| format!("BEGHU_WEB_DIR: can't read {}: {e}", path.display()))?;
                if !html.contains(shell::MARKER) {
                    return Err(format!(
                        "BEGHU_WEB_DIR: {} has no {} marker",
                        path.display(),
                        shell::MARKER
                    ));
                }
                Some(html)
            }
            None => None,
        };
        let github = github::GitHub::new(&cfg.github);
        let keys = Arc::new(crypto::Keys::derive(&cfg.token_key));
        let tokens = tokens::Tokens::new(control.clone(), github.clone(), keys.clone());
        Ok(App(Arc::new(Inner {
            cfg,
            control,
            mirrors,
            github,
            keys,
            tokens,
            shell,
            roles: repos::Roles::default(),
        })))
    }

    fn cfg(&self) -> &Config {
        &self.0.cfg
    }

    fn control(&self) -> &Control {
        &self.0.control
    }

    fn mirrors(&self) -> &Mirrors {
        &self.0.mirrors
    }

    fn github(&self) -> &github::GitHub {
        &self.0.github
    }

    fn keys(&self) -> &crypto::Keys {
        &self.0.keys
    }

    fn tokens(&self) -> &tokens::Tokens {
        &self.0.tokens
    }

    fn shell_template(&self) -> Option<&str> {
        self.0.shell.as_deref()
    }

    fn roles(&self) -> &repos::Roles {
        &self.0.roles
    }
}

/// Compressed bodies, br or gzip by the browser's `accept-encoding`, with `vary` set. The edge
/// passes encodings through unchanged, so beghu compresses for itself: the API and the shell on
/// the fly at the default levels (br 4, gzip 6), and the hashed assets from the `.br` and `.gz`
/// files the web build writes at maximum compression.
fn compression() -> tower_http::compression::CompressionLayer {
    tower_http::compression::CompressionLayer::new()
        .br(true)
        .gzip(true)
        .no_deflate()
        .no_zstd()
}

pub fn router(app: App) -> Router {
    // Nested, so its fallback answers only under `/api`, and with the session gate as a route
    // layer, so an unknown API path is a 404 whether or not the browser is signed in.
    let api = Router::new()
        .route("/me", get(api::me))
        .route("/issues", get(api::issues))
        .route_layer(middleware::from_fn_with_state(
            app.clone(),
            auth::require_session,
        ))
        .fallback(|| async { error::ApiError::NotFound })
        .layer(middleware::from_fn_with_state(app.clone(), api_headers))
        .layer(compression());
    // The shell answers only the SPA's own routes (web/src/router.tsx); any other path is a
    // plain 404 from the router's default fallback.
    let shell = Router::new()
        .route("/", get(shell::shell))
        .route("/issues/{id}", get(shell::shell))
        .layer(compression());
    let mut r = Router::new()
        .route("/healthz", get(healthz))
        .route("/auth/login", get(auth::login))
        .route("/auth/callback", get(auth::callback))
        .merge(shell)
        .nest("/api", api);
    if let Some(dir) = &app.cfg().web_dir {
        // Hashed build assets: immutable, and served from their precompressed siblings when the
        // browser takes one. An unknown path is a 404, never the shell.
        let files = tower_http::services::ServeDir::new(dir.join("assets"))
            .precompressed_br()
            .precompressed_gzip();
        let assets = Router::new()
            .fallback_service(files)
            .layer(middleware::map_response(asset_headers));
        r = r.nest("/assets", assets);
    }
    r.with_state(app)
}

/// A found asset is immutable (its name has the content hash) and may come as its `.br` or
/// `.gz` sibling, so it varies by `accept-encoding`. A 304 carries the same headers, as it
/// stands in for the 200 a cache would keep.
async fn asset_headers(mut res: Response) -> Response {
    if res.status().is_success() || res.status() == StatusCode::NOT_MODIFIED {
        let h = res.headers_mut();
        h.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
        h.append(header::VARY, HeaderValue::from_static("accept-encoding"));
    }
    res
}

/// Every API response, errors included, is `no-store` and names the build.
async fn api_headers(State(app): State<App>, req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(v) = HeaderValue::from_str(&app.cfg().build_id) {
        h.insert("x-beghu-build", v);
    }
    res
}

/// Serves until the listener fails or the task is dropped.
pub async fn serve(listener: tokio::net::TcpListener, app: App) -> std::io::Result<()> {
    axum::serve(listener, router(app)).await
}

/// Liveness: the build id, and no database.
async fn healthz(State(app): State<App>) -> impl IntoResponse {
    let build = &app.cfg().build_id;
    let v = HeaderValue::from_str(build).unwrap_or(HeaderValue::from_static("invalid"));
    (
        [("x-beghu-build", v)],
        axum::Json(serde_json::json!({ "build": build })),
    )
}

/// Unix seconds.
pub(crate) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

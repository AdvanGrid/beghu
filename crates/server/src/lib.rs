//! The beghu server: sign-in, the browser session, the shell, the JSON API, webhooks (with the
//! relationship read-backs that follow them) and the live stream. Jobs land here as later slices
//! add them.

mod api;
mod auth;
mod config;
mod crypto;
mod detail;
mod edges;
mod error;
mod facets;
mod github;
mod import;
mod installations;
mod live;
mod ops;
mod query;
mod relationships;
mod repos;
mod shell;
mod tokens;
mod webhook;

pub use config::{Config, GitHubConfig, MirrorsConfig, default_read_back_retries};

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use control_db::Control;
use mirror_db::Mirrors;
use std::future::IntoFuture as _;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    shell: Option<shell::Shell>,
    /// Each account's role re-reads from GitHub.
    roles: repos::Roles,
    /// Each account's live streams.
    hub: Arc<live::Hub>,
    /// Webhook deliveries on their way to the mirrors.
    webhooks: webhook::Queue,
    /// The App's JWT and installation tokens, shared by the import and the read-backs.
    installations: Arc<installations::Installations>,
    /// Each account's import.
    imports: import::Imports,
    /// Writes in flight and lately done.
    ops: ops::Ops,
    /// True once SIGTERM has started the drain (see [`serve_until`]).
    draining: tokio::sync::watch::Sender<bool>,
}

impl App {
    /// Opens the control DB (migrating it after a `VACUUM INTO` backup) and the mirrors under
    /// `BEGHU_DATA_DIR`, reads the shell template and the build's Vite manifest, and resumes the
    /// webhook deliveries acked but not processed before. Any error should stop startup.
    pub async fn open(cfg: Config) -> Result<App, String> {
        let (path, backups) = (cfg.control_db(), cfg.backups());
        let control = tokio::task::spawn_blocking(move || Control::open(&path, &backups))
            .await
            .map_err(|_| "opening the control DB panicked".to_owned())?
            .map_err(|e| format!("can't open the control DB: {e}"))?
            .0;
        let control = Arc::new(control);
        let mirrors = Mirrors::new(cfg.mirrors_dir(), cfg.mirrors.clone());
        let shell = cfg.web_dir.as_deref().map(shell::Shell::load).transpose()?;
        let github = github::GitHub::new(
            &cfg.github,
            cfg.github_probe_every,
            cfg.github_write_timeout,
        );
        let keys = Arc::new(crypto::Keys::derive(&cfg.token_key));
        let tokens = tokens::Tokens::new(control.clone(), github.clone(), keys.clone());
        let hub = Arc::new(live::Hub::default());
        let installations = installations::Installations::new(github.clone(), &cfg.github)?;
        let edges = Arc::new(edges::Refetcher::new(
            control.clone(),
            mirrors.clone(),
            hub.clone(),
            installations.clone(),
            cfg.read_back_retries.clone(),
        ));
        let (installs, installs_rx) = tokio::sync::mpsc::unbounded_channel();
        let webhooks = webhook::resume(
            webhook::Sinks {
                control: control.clone(),
                mirrors: mirrors.clone(),
                hub: hub.clone(),
                installs,
                edges,
            },
            cfg.deliveries_kept_for,
        )
        .await
        .map_err(|e| format!("can't read the unprocessed webhook deliveries: {e}"))?;
        let notices = mirrors.notices();
        let app = App(Arc::new(Inner {
            cfg,
            control,
            mirrors,
            github,
            keys,
            tokens,
            shell,
            roles: repos::Roles::default(),
            hub,
            webhooks,
            installations,
            imports: import::Imports::default(),
            ops: ops::Ops::default(),
            draining: tokio::sync::watch::channel(false).0,
        }));
        tokio::spawn(follow_notices(app.clone(), notices));
        tokio::spawn(follow_installations(app.clone(), installs_rx));
        Ok(app)
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

    fn shell(&self) -> Option<&shell::Shell> {
        self.0.shell.as_ref()
    }

    fn roles(&self) -> &repos::Roles {
        &self.0.roles
    }

    fn hub(&self) -> &Arc<live::Hub> {
        &self.0.hub
    }

    fn webhooks(&self) -> &webhook::Queue {
        &self.0.webhooks
    }

    fn installations(&self) -> &installations::Installations {
        &self.0.installations
    }

    fn imports(&self) -> &import::Imports {
        &self.0.imports
    }

    fn ops(&self) -> &ops::Ops {
        &self.0.ops
    }

    /// True once the drain has started.
    fn draining(&self) -> bool {
        *self.0.draining.borrow()
    }

    /// The drain flag as it changes.
    fn drain_watch(&self) -> tokio::sync::watch::Receiver<bool> {
        self.0.draining.subscribe()
    }
}

/// A mirror created empty (none on disk, or a rebuild) gets the account's synced repos imported:
/// the re-read of its repos brings the new mirror in line with its pick.
async fn follow_notices(app: App, mut rx: tokio::sync::broadcast::Receiver<mirror_db::Notice>) {
    use tokio::sync::broadcast::error::RecvError;
    loop {
        match rx.recv().await {
            Ok(mirror_db::Notice::NeedsImport { account, why }) => {
                eprintln!("account {account}: {why}; importing its synced repos");
                let app = app.clone();
                tokio::spawn(async move { repos::refresh_roles_now(&app, account).await });
            }
            Ok(_) | Err(RecvError::Lagged(_)) => {}
            Err(RecvError::Closed) => return,
        }
    }
}

/// An installation changed (installed, uninstalled, suspended, repos added or removed): every
/// account's visible repos are due for a re-read; the accounts syncing a repo that left get
/// theirs now, so its rows leave their mirrors at once, and so does whoever made the change, so
/// the picker they're on shows it.
async fn follow_installations(
    app: App,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<webhook::InstallChange>,
) {
    while let Some(change) = rx.recv().await {
        app.roles().all_stale();
        let mut accounts = std::collections::BTreeSet::new();
        if let Some(sender) = change.sender {
            let known = app
                .control()
                .read(move |c| control_db::q::account(c, sender))
                .await;
            if matches!(known, Ok(Some(_))) {
                accounts.insert(sender);
            }
        }
        for repo in change.removed {
            match app
                .control()
                .read(move |c| control_db::q::fan_out_targets(c, repo))
                .await
            {
                Ok(t) => accounts.extend(t),
                Err(e) => eprintln!("installation change: reading who syncs {repo}: {e}"),
            }
        }
        for account in accounts {
            let app = app.clone();
            tokio::spawn(async move { repos::refresh_roles_now(&app, account).await });
        }
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
        .route("/facets", get(facets::facets))
        .route("/facets/{facet}/counts", get(facets::counts))
        .route("/issues/{id}", get(detail::issue))
        .route("/issues/{id}/comments", get(detail::comments_page))
        .route("/repos", get(repos::list).put(repos::pick))
        .route("/stream", get(live::stream))
        .route("/ops", post(ops::post))
        .route_layer(middleware::from_fn_with_state(
            app.clone(),
            auth::require_session,
        ))
        .fallback(|| async { error::ApiError::NotFound })
        // Outermost of the API's own layers: a request from another site is refused before
        // anything else looks at it.
        .layer(middleware::from_fn_with_state(
            app.clone(),
            auth::require_same_origin,
        ))
        .layer(middleware::from_fn_with_state(app.clone(), api_headers))
        .layer(compression());
    // The shell answers only the SPA's own routes (web/src/router.tsx); any other path is a
    // plain 404 from the router's default fallback.
    let shell = Router::new()
        .route("/", get(shell::shell))
        .route("/issues/{id}", get(shell::shell))
        .route("/repos", get(shell::shell))
        .layer(compression());
    let mut r = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/auth/login", get(auth::login))
        .route("/auth/callback", get(auth::callback))
        .route("/auth/setup", get(auth::setup))
        .route(
            "/webhook",
            post(webhook::receive).layer(axum::extract::DefaultBodyLimit::max(webhook::MAX_BODY)),
        )
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

/// The longest a drain takes before the server stops anyway.
const DRAIN: Duration = Duration::from_secs(25);

/// Serves until the first of `signals` (SIGTERM, in `main`), then drains for up to [`DRAIN`]:
/// `/readyz` answers 503, the live streams close and new writes are turned away (503 with
/// `retry-after`) while the writes in flight finish; then the server stops taking connections,
/// sends the answers still on their way and returns. A second signal during the drain returns at
/// once.
///
/// The drain waits for writes only, not for webhook deliveries or the relationship read-backs
/// that hold them (see [`edges`]). A write has no durable queue, so one cut off is lost; a
/// delivery is marked processed only once its read-back has landed, so one cut off is replayed,
/// and read back, at the next start, and replaying is idempotent. A read-back can also wait out
/// retries for about 10 minutes, far past the drain's 25 s.
pub async fn serve_until(
    listener: tokio::net::TcpListener,
    app: App,
    mut signals: tokio::sync::mpsc::UnboundedReceiver<()>,
) -> std::io::Result<()> {
    let (count, received) = tokio::sync::watch::channel(0_u32);
    tokio::spawn(async move {
        while signals.recv().await.is_some() {
            count.send_modify(|n| *n += 1);
        }
    });
    // Resolves once `n` signals have come; never, if no more will.
    let signalled = |n: u32| {
        let mut received = received.clone();
        async move {
            if received.wait_for(|k| *k >= n).await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    };
    let (drained, deadline) = tokio::sync::oneshot::channel();
    let drain = {
        let app = app.clone();
        let stop = signalled(1);
        async move {
            stop.await;
            let until = tokio::time::Instant::now() + DRAIN;
            eprintln!(
                "draining: waiting up to {} s for writes in flight",
                DRAIN.as_secs()
            );
            app.0.draining.send_replace(true);
            if tokio::time::timeout_at(until, app.ops().idle())
                .await
                .is_err()
            {
                eprintln!(
                    "draining: writes still in flight after {} s",
                    DRAIN.as_secs()
                );
            }
            let _ = drained.send(until);
        }
    };
    let server = axum::serve(listener, router(app)).with_graceful_shutdown(drain);
    let give_up = async {
        match deadline.await {
            Ok(until) => tokio::time::sleep_until(until).await,
            Err(_) => std::future::pending().await,
        }
    };
    tokio::select! {
        r = server.into_future() => r,
        () = give_up => {
            eprintln!("draining: stopping with requests still open");
            Ok(())
        }
        () = signalled(2) => {
            eprintln!("draining: signalled again; stopping now");
            Ok(())
        }
    }
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

/// Readiness: 503 once the drain has started.
async fn readyz(State(app): State<App>) -> Response {
    if app.draining() {
        (StatusCode::SERVICE_UNAVAILABLE, "draining").into_response()
    } else {
        "ready".into_response()
    }
}

/// Unix seconds.
pub(crate) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

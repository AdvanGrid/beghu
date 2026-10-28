//! The beghu server: sign-in, the browser session, the shell, the JSON API, webhooks (with the
//! relationship read-backs that follow them), the live stream, reconciliation (redelivery and
//! sweeps) and the jobs: the import, the hourly control-DB backup and asset pruning. Jobs land
//! here as later slices add them. Every background task is spawned through [`jobs::Jobs`], so the
//! drain stops it and waits for it; `jobs.rs` has the contract a job keeps, and the few tasks
//! outside it.

mod accounts;
mod api;
mod assets;
mod auth;
mod backups;
mod config;
mod crypto;
mod detail;
mod edges;
mod error;
mod facets;
mod github;
mod import;
mod installations;
mod jobs;
mod live;
mod markdown;
mod media;
mod ops;
mod pickers;
mod pulls;
mod query;
mod reconcile;
mod relationships;
mod repos;
mod shell;
mod tokens;
mod volume;
mod webhook;

pub use config::{
    Config, GitHubConfig, MediaConfig, MirrorsConfig, ReconcileConfig,
    default_accounts_check_every, default_assets_kept_for, default_backup_every, default_drain_for,
    default_read_back_retries,
};

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

/// An [`App`] that doesn't keep it alive: for a part the app holds that needs the app back.
#[derive(Clone)]
pub(crate) struct WeakApp(std::sync::Weak<Inner>);

impl WeakApp {
    /// The app, while it runs.
    pub(crate) fn upgrade(&self) -> Option<App> {
        self.0.upgrade().map(App)
    }
}

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
    /// Who can be assigned, per repo, as GitHub last listed it (see `pickers.rs`).
    assignable: pickers::Assignable,
    /// Redelivery, sweeps and each account's sync state.
    reconcile: reconcile::Reconcile,
    /// The read-backs from GitHub, debounced per issue: relationships (webhooks', sweeps', and
    /// an opened parent's) and the issues themselves (a same-second re-read).
    edges: Arc<edges::Refetcher>,
    /// Rendered bodies and comments.
    renders: markdown::Cache,
    /// The attachment route's, the image proxy's and the probes' shared state.
    media: media::State,
    /// True once SIGTERM has started the drain (see [`serve_until`]).
    draining: tokio::sync::watch::Sender<bool>,
    /// True once the startup is done ([`Opened::start`]): `/readyz` answers 503 until then.
    started: std::sync::atomic::AtomicBool,
    /// The background jobs, which the drain stops.
    jobs: jobs::Jobs,
    /// Where `/assets/*` is served from: the volume's copy of this build's assets and the
    /// previous builds' (`None` without a web build).
    assets_dir: Option<std::path::PathBuf>,
}

/// An app opened up to listening, nothing running in the background yet. Startup's steps (#86,
/// "Startup order") split at listening:
///
/// 1. migrate the control DB (after a `VACUUM INTO` backup);
/// 2. copy this build's assets to the volume and prune the old ones;
/// 3. delete the mirror files of accounts that aren't active (they lost access; dormant ones
///    too, once #114 makes any);
/// 4. listen;
/// 5. resume the webhook deliveries acked but not processed, then redeliver for the downtime
///    (#92);
/// 6. start the migration walker (#114, not built yet);
///
/// then the other jobs. [`App::open`] runs 1 to 3; the caller listens and serves
/// ([`Opened::app`] to [`serve_until`]); then [`Opened::start`] runs 5, 6 and the jobs, while the
/// server already answers. A webhook delivery that comes in before step 5 waits in the queue
/// behind the resumed ones (see [`webhook::resume`]), and `/readyz` answers 503 until `start`
/// is done.
pub struct Opened {
    app: App,
    sinks: webhook::Sinks,
    notices: tokio::sync::broadcast::Receiver<mirror_db::Notice>,
    installs: tokio::sync::mpsc::UnboundedReceiver<webhook::InstallChange>,
    /// Accounts that lost access, on their way to `accounts::lost_access`.
    lost: tokio::sync::mpsc::UnboundedReceiver<i64>,
    /// The volume's assets, and when their next prune is due (`None` without a web build, or
    /// with no build superseded, when there's none to wait for).
    assets: Option<(assets::Assets, i64)>,
}

impl App {
    /// Startup up to listening (steps 1 to 3, see [`Opened`]): refuses a data directory on a
    /// network filesystem, opens the control DB (migrating it after a `VACUUM INTO` backup),
    /// reads the shell template and the build's Vite manifest, copies the build's assets to the
    /// volume and prunes the old ones, and opens the mirrors. Nothing runs in the background
    /// yet: [`Opened::start`] starts it once the server listens. Any error should stop startup.
    pub async fn open(cfg: Config) -> Result<Opened, String> {
        let dir = cfg.data_dir.clone();
        tokio::task::spawn_blocking(move || volume::check(&dir))
            .await
            .map_err(|_| "checking the data directory panicked".to_owned())??;
        let (path, backups) = (cfg.control_db(), cfg.backups());
        let control = tokio::task::spawn_blocking(move || Control::open(&path, &backups))
            .await
            .map_err(|_| "opening the control DB panicked".to_owned())?
            .map_err(|e| format!("can't open the control DB: {e}"))?
            .0;
        let control = Arc::new(control);
        let shell = cfg.web_dir.as_deref().map(shell::Shell::load).transpose()?;
        let assets = assets::Assets::new(&cfg.data_dir, cfg.assets_kept_for);
        let prune_next = match cfg.web_dir.clone() {
            None => None,
            Some(web) => {
                let (a, build) = (assets.clone(), cfg.build_id.clone());
                tokio::task::spawn_blocking(move || a.install(&web, &build, now()))
                    .await
                    .map_err(|_| "copying the assets panicked".to_owned())?
                    .map_err(|e| format!("can't copy the build's assets to the volume: {e}"))?
            }
        };
        let mirrors = Mirrors::new(cfg.mirrors_dir(), cfg.mirrors.clone());
        let jobs = jobs::Jobs::default();
        let github = github::GitHub::new(
            &cfg.github,
            cfg.github_probe_every,
            cfg.github_write_timeout,
        );
        let keys = Arc::new(crypto::Keys::derive(&cfg.token_key));
        let renders = markdown::Cache::new(markdown::CACHE_BYTES, keys.images.clone());
        let cfg_media = cfg.media.clone();
        let (lost, lost_rx) = tokio::sync::mpsc::unbounded_channel();
        let tokens = tokens::Tokens::new(
            control.clone(),
            github.clone(),
            keys.clone(),
            jobs.clone(),
            lost.clone(),
        );
        let hub = Arc::new(live::Hub::default());
        let installations = installations::Installations::new(github.clone(), &cfg.github)?;
        let budgets = Arc::new(reconcile::Budgets::default());
        let edges = Arc::new(edges::Refetcher::new(
            control.clone(),
            mirrors.clone(),
            hub.clone(),
            installations.clone(),
            budgets.clone(),
            cfg.read_back_retries.clone(),
            jobs.clone(),
        ));
        let (installs, installs_rx) = tokio::sync::mpsc::unbounded_channel();
        let notices = mirrors.notices();
        let assets_dir = cfg.web_dir.is_some().then(|| assets.dir.clone());
        let reconcile = reconcile::Reconcile::new(cfg.reconcile.clone(), budgets);
        let sinks = webhook::Sinks {
            control: control.clone(),
            mirrors: mirrors.clone(),
            hub: hub.clone(),
            installs,
            lost,
            edges: edges.clone(),
            jobs: jobs.clone(),
            app: None,
        };
        let app = App(Arc::new(Inner {
            reconcile,
            edges,
            cfg,
            control,
            mirrors,
            github,
            keys,
            tokens,
            shell,
            roles: repos::Roles::default(),
            hub,
            webhooks: webhook::Queue::new(),
            installations,
            imports: import::Imports::default(),
            ops: ops::Ops::default(),
            assignable: pickers::Assignable::default(),
            renders,
            media: media::State::new(cfg_media),
            draining: tokio::sync::watch::channel(false).0,
            started: Default::default(),
            jobs,
            assets_dir,
        }));
        // A read-back measures the images in the comments it writes, which needs the whole app.
        app.edges().set_app(WeakApp(Arc::downgrade(&app.0)));
        // A webhook's push waits for its images to be measured, which needs the whole app.
        let sinks = webhook::Sinks {
            app: Some(app.clone()),
            ..sinks
        };
        // Step 3: delete the mirror files of accounts that aren't active, before anything can
        // open one. TODO(#114): dormant accounts are among them once dormancy exists.
        accounts::delete_unused_mirrors(&app).await?;
        Ok(Opened {
            app,
            sinks,
            notices,
            installs: installs_rx,
            lost: lost_rx,
            assets: prune_next.map(|next| (assets, next)),
        })
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

    fn renders(&self) -> &markdown::Cache {
        &self.0.renders
    }

    fn media(&self) -> &media::State {
        &self.0.media
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

    fn assignable(&self) -> &pickers::Assignable {
        &self.0.assignable
    }

    fn reconcile(&self) -> &reconcile::Reconcile {
        &self.0.reconcile
    }

    fn edges(&self) -> &edges::Refetcher {
        &self.0.edges
    }

    fn jobs(&self) -> &jobs::Jobs {
        &self.0.jobs
    }

    /// Runs `job` as a job (see [`jobs::Jobs::spawn`]), handing it its own clone of the app.
    fn spawn<F, Fut>(&self, job: F) -> tokio::task::JoinHandle<Option<Fut::Output>>
    where
        F: FnOnce(App) -> Fut,
        Fut: std::future::Future + Send + 'static,
        Fut::Output: Send + 'static,
    {
        self.jobs().spawn(job(self.clone()))
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

impl Opened {
    /// The app to serve, from step 4 on.
    pub fn app(&self) -> App {
        self.app.clone()
    }

    /// Startup once the server listens (steps 5 and 6, see [`Opened`]), then the other jobs.
    /// Any error should stop startup.
    pub async fn start(self) -> Result<(), String> {
        let Opened {
            app,
            sinks,
            notices,
            installs,
            lost,
            assets,
        } = self;
        // Step 5: the deliveries acked but not processed go first, ahead of any that came in
        // since listening.
        webhook::resume(app.webhooks(), sinks, app.cfg().deliveries_kept_for)
            .await
            .map_err(|e| format!("can't read the unprocessed webhook deliveries: {e}"))?;
        // Then redelivery for the downtime (its first run) and the sweeps' scheduler: jobs,
        // spawned and never awaited here. `start` isn't a job, so the drain couldn't stop what it
        // awaits, and readiness and the jobs below would wait on GitHub.
        reconcile::start(&app);
        // Step 6. TODO(#114): start the migration walker here.
        app.spawn(backups::job);
        if let Some((assets, next)) = assets {
            app.jobs().spawn(assets::job(assets, Some(next)));
        }
        app.spawn(|app| follow_notices(app, notices));
        app.spawn(|app| follow_installations(app, installs));
        app.spawn(|app| accounts::follow_lost(app, lost));
        app.spawn(accounts::daily);
        app.0
            .started
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
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
                app.spawn(move |app| async move { repos::refresh_roles_now(&app, account).await });
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
            // Only an account in use: one that must sign in again (or disconnected) has no
            // tokens to read with, and its mirror is gone.
            if matches!(known, Ok(Some(a)) if a.status == tokens::account_status::ACTIVE) {
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
            app.spawn(move |app| async move { repos::refresh_roles_now(&app, account).await });
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
        .route("/issues/{id}/source", get(detail::source))
        .route("/repos", get(repos::list).put(repos::pick))
        .route("/repos/{id}/labels", get(pickers::labels))
        .route("/repos/{id}/milestones", get(pickers::milestones))
        .route("/repos/{id}/assignees", get(pickers::assignees))
        .route("/ops", post(ops::post))
        .route("/resync", post(reconcile::resync))
        .route_layer(middleware::from_fn_with_state(
            app.clone(),
            auth::require_session,
        ))
        // Outside the gate: the stream lets itself in, to answer in its own terms.
        .route("/stream", get(live::stream))
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
    // The media routes stream bytes through with their own caching headers: outside the API's
    // `no-store` and its compression, behind the same session gate.
    let media = Router::new()
        .route("/api/attachments/{uuid}", get(media::attachment))
        .route("/api/img", get(media::image))
        .route_layer(middleware::from_fn_with_state(
            app.clone(),
            auth::require_session,
        ))
        .layer(middleware::from_fn_with_state(
            app.clone(),
            auth::require_same_origin,
        ));
    // Signing out, switching and Disconnect: form posts from beghu's own pages only.
    let session_forms = Router::new()
        .route("/auth/switch", post(accounts::switch))
        .route("/auth/logout", post(accounts::logout))
        .route("/auth/disconnect", post(accounts::disconnect))
        .layer(middleware::from_fn_with_state(
            app.clone(),
            auth::require_same_origin,
        ));
    let mut r = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/auth/login", get(auth::login))
        .route("/auth/callback", get(auth::callback))
        .route("/auth/setup", get(auth::setup))
        .route("/auth/signed-out", get(accounts::signed_out))
        .merge(session_forms)
        .route(
            "/webhook",
            post(webhook::receive).layer(axum::extract::DefaultBodyLimit::max(webhook::MAX_BODY)),
        )
        .merge(shell)
        .merge(media)
        .nest("/api", api);
    if let Some(dir) = &app.0.assets_dir {
        // Hashed build assets, this build's and the previous builds' still kept on the volume:
        // immutable, and served from their precompressed siblings when the browser takes one. An
        // unknown path is a 404, never the shell.
        let files = tower_http::services::ServeDir::new(dir)
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

/// The part of the drain kept for the final WAL checkpoint, after [`Config::drain_for`] (22 s)
/// for steps 1 to 5's stop: 25 s in all. docs/deploy.md ("Stopping") has these figures and the
/// stop grace period (30 s) they need.
const CHECKPOINT: Duration = Duration::from_secs(3);

/// Serves until the first of `signals` (SIGTERM, in `main`), then drains for up to
/// [`Config::drain_for`] and [`CHECKPOINT`] (25 s):
///
/// 1. `/readyz` answers 503;
/// 2. the live streams close;
/// 3. new writes are turned away (503 with `retry-after`) while the writes in flight finish;
/// 4. the jobs stop at their next await (see [`jobs`]);
/// 5. the server stops taking connections and sends the answers still on their way, then the
///    control DB and the mirrors are sealed (a write from anything still running fails, and a
///    request it was for answers 503 with `retry-after`), and their WALs checkpointed into their
///    files, all at once; and it returns.
///
/// Steps 1 to 5's stop take up to [`Config::drain_for`], the checkpoint up to [`CHECKPOINT`].
/// Steps 3 and 4 share one deadline, `drain_for` after the signal: writes that use most of it
/// leave the jobs only the rest, and the server's stop in step 5 is cut off at it too. A
/// checkpoint that overruns is left running: the caller should exit once this returns (`main`
/// does), since a blocking thread still in SQLite would hold up a runtime's shutdown.
///
/// A second signal during the drain returns at once, without the checkpoint.
///
/// The drain waits for writes, not for webhook deliveries or the relationship read-backs that
/// hold them (see [`edges`]): those are jobs, stopped. A write has no durable queue, so one cut
/// off is lost; a delivery is marked processed only once its read-back has landed, so one cut
/// off is replayed, and read back, at the next start, and replaying is idempotent. A read-back
/// can also wait out retries for about 10 minutes, far past the drain's 25 s.
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
            let wait = app.cfg().drain_for;
            let until = tokio::time::Instant::now() + wait;
            eprintln!("draining: waiting up to {wait:?} for writes in flight");
            app.0.draining.send_replace(true);
            if tokio::time::timeout_at(until, app.ops().idle())
                .await
                .is_err()
            {
                eprintln!("draining: writes still in flight after {wait:?}");
            }
            if !app.jobs().stop(until).await {
                eprintln!("draining: jobs still running after {wait:?}");
            }
            let _ = drained.send(until);
        }
    };
    let server = axum::serve(listener, router(app.clone())).with_graceful_shutdown(drain);
    let give_up = async {
        match deadline.await {
            Ok(until) => tokio::time::sleep_until(until).await,
            Err(_) => std::future::pending().await,
        }
    };
    let stopped = async {
        tokio::select! {
            r = server.into_future() => r,
            () = give_up => {
                eprintln!("draining: stopping with requests still open");
                Ok(())
            }
        }
    };
    tokio::select! {
        r = async {
            let r = stopped.await;
            if tokio::time::timeout(CHECKPOINT, checkpoint(&app)).await.is_err() {
                eprintln!("draining: checkpoint unfinished after {} s", CHECKPOINT.as_secs());
            }
            r
        } => r,
        () = signalled(2) => {
            eprintln!("draining: signalled again; stopping now");
            Ok(())
        }
    }
}

/// The drain's last step: seals the control DB and the mirrors, so nothing still running (a job
/// that didn't stop in time, a transaction a stopped job left on its blocking thread) can write
/// once it's done, lets each one's write in flight finish, and folds their WALs into their
/// files, so the volume holds whole databases. All at once, so one database kept waiting holds
/// up none of the others within the budget. One a reader kept from completing says so
/// (`CheckpointBusy`); its WAL stays beside it, whole, for the next start to replay.
async fn checkpoint(app: &App) {
    let (control, mirrors) = tokio::join!(app.control().checkpoint(), app.mirrors().checkpoint());
    if let Err(e) = control {
        eprintln!("draining: checkpointing the control DB: {e}");
    }
    for (account, e) in mirrors {
        eprintln!("draining: checkpointing account {account}'s mirror: {e}");
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

/// Readiness: 503 until the startup is done, and once the drain has started.
async fn readyz(State(app): State<App>) -> Response {
    if app.draining() {
        (StatusCode::SERVICE_UNAVAILABLE, "draining").into_response()
    } else if !app.0.started.load(std::sync::atomic::Ordering::SeqCst) {
        (StatusCode::SERVICE_UNAVAILABLE, "starting").into_response()
    } else {
        "ready".into_response()
    }
}

/// A file's I/O error as `can't <what> <path>: <error>`, the words every one of beghu's uses.
pub(crate) fn io_failed(
    what: &'static str,
    path: &std::path::Path,
) -> impl Fn(std::io::Error) -> String + use<> {
    let path = path.display().to_string();
    move |e| format!("can't {what} {path}: {e}")
}

/// Unix seconds.
pub(crate) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Now, in Unix milliseconds: for ordering events closer together than a second.
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

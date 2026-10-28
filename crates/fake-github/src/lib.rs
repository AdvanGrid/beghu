//! Fake GitHub: a stand-in for GitHub in local dev and tests. beghu's `GITHUB_API_URL` and
//! `GITHUB_WEB_URL` both point at its API listener, so the real client code runs against it.
//!
//! - The API listener serves the OAuth web flow (`/login/oauth/…`), the REST endpoints beghu
//!   calls (reads in `api.rs` and `repos.rs`, each repo's issue events feed in `events.rs`,
//!   writes in `writes.rs`), the App's grant and token revocation, the
//!   App's installation tokens and the GraphQL queries beghu makes. Later tickets add endpoints as
//!   they need them.
//! - The control listener takes runtime faults (latency, the next N calls failing, down, and
//!   webhook drops, delays, duplicates and reorders), outside edits, token lifetimes,
//!   revocations and a reset, and reports the fake's state.
//! - About a second after each change, the fake POSTs the matching webhook, signed, to the App's
//!   webhook URL (`webhook_url`, or the one set on the control port), and logs the attempt for
//!   the App's delivery listing and redelivery (`hook_deliveries.rs`).
//!
//! GitHub's truth is the fake's own copy of a fixture mirror (`fake_db::Truth`).

// Handlers return their early answers as `Err(Response)`; boxing them buys nothing here.
#![allow(clippy::result_large_err)]

mod accounts;
mod api;
mod app;
mod attachments;
mod control;
mod edits;
mod events;
mod faults;
mod graphql;
mod hook_deliveries;
mod issue_edges;
mod moves;
mod oauth;
mod pulls;
mod quota;
mod relationship_writes;
mod relationships;
mod repos;
mod triage;
mod web_hosts;
mod webhooks;
mod writes;

pub use accounts::{ACCOUNTS, Role, pristine_mirrors};
pub use api::rfc3339;
pub use app::{DEV_APP_ID, DEV_APP_KEY, SLUG as APP_SLUG};
pub use webhooks::{DELAY as WEBHOOK_DELAY, sign as sign_webhook};

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub struct Config {
    /// The fixture mirror the truth is copied from.
    pub fixture: PathBuf,
    /// Where the truth lives. Kept across restarts; copied again when the fixture changes.
    pub db: PathBuf,
    pub client_id: String,
    pub client_secret: String,
    /// User access token lifetime (GitHub: 8 h). Settable down to seconds.
    pub access_ttl: Duration,
    /// Refresh token lifetime (GitHub: 6 months).
    pub refresh_ttl: Duration,
    /// Where webhooks go (the App's webhook URL); none sends nothing until the control port sets
    /// one.
    pub webhook_url: Option<String>,
    /// The App's webhook secret, which signs every delivery.
    pub webhook_secret: String,
    /// The App's setup URL, where GitHub sends the browser after an install (`None`: nowhere,
    /// until the control port sets one).
    pub setup_url: Option<String>,
}

/// GitHub's own lifetimes.
pub const ACCESS_TTL: Duration = Duration::from_secs(28_800);
pub const REFRESH_TTL: Duration = Duration::from_secs(15_897_600);

#[derive(Clone)]
pub struct Fake(Arc<State>);

pub(crate) struct State {
    truth: fake_db::Truth,
    cfg: Config,
    setup_url: Mutex<Option<String>>,
    ttl: Mutex<Ttl>,
    faults: faults::Faults,
    refreshes: Refreshes,
    graphql: GraphqlCalls,
    assignees: AssigneeCalls,
    webhooks: webhooks::Webhooks,
    /// Each installation token minted, with its permissions.
    app_tokens: app::Minted,
    /// Each token owner's primary rate limit.
    quotas: quota::Quotas,
    /// How many conditional requests were answered 304 since the start (or the last reset).
    not_modified: std::sync::atomic::AtomicU64,
    /// Each issue events feed's reads, and its 304s.
    feeds: events::Reads,
    /// Seconds the fake's clock runs ahead of the real one (`PUT /clock`): token and code
    /// expiry, and the times edits stamp, follow it.
    clock: std::sync::atomic::AtomicI64,
    /// Minted attachment URLs' key, and the media requests' counts (`attachments.rs`).
    media: attachments::Media,
}

/// What the token endpoint did with refresh tokens since the start (or the last reset): how
/// many it honoured, and how many arrived already spent. A client that refreshes twice with one
/// token shows up in `reused`.
#[derive(Default)]
pub(crate) struct Refreshes {
    pub ok: std::sync::atomic::AtomicU64,
    pub reused: std::sync::atomic::AtomicU64,
}

impl Refreshes {
    pub(crate) fn snapshot(&self) -> serde_json::Value {
        use std::sync::atomic::Ordering::Relaxed;
        serde_json::json!({ "ok": self.ok.load(Relaxed), "reused": self.reused.load(Relaxed) })
    }

    pub(crate) fn clear(&self) {
        use std::sync::atomic::Ordering::Relaxed;
        self.ok.store(0, Relaxed);
        self.reused.store(0, Relaxed);
    }
}

/// How many GraphQL calls came with an installation token, and how many with a user's, since the
/// start (or the last reset); and how many of each operation.
#[derive(Default)]
pub(crate) struct GraphqlCalls {
    pub installation: std::sync::atomic::AtomicU64,
    pub user: std::sync::atomic::AtomicU64,
    pub operations: Mutex<std::collections::BTreeMap<String, u64>>,
}

impl GraphqlCalls {
    pub(crate) fn count(&self, op: &str) {
        *self
            .operations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(op.to_owned())
            .or_default() += 1;
    }

    pub(crate) fn snapshot(&self) -> serde_json::Value {
        use std::sync::atomic::Ordering::Relaxed;
        serde_json::json!({
            "installation": self.installation.load(Relaxed),
            "user": self.user.load(Relaxed),
            "operations": *self.operations.lock().unwrap_or_else(|e| e.into_inner()),
        })
    }

    pub(crate) fn clear(&self) {
        use std::sync::atomic::Ordering::Relaxed;
        self.installation.store(0, Relaxed);
        self.user.store(0, Relaxed);
        self.operations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

/// How `GET /repos/{o}/{r}/assignees` was answered since the start (or the last reset): in full,
/// which GitHub counts against the rate limit, or 304 to the client's own ETag, which it doesn't.
#[derive(Default)]
pub(crate) struct AssigneeCalls {
    pub full: std::sync::atomic::AtomicU64,
    pub not_modified: std::sync::atomic::AtomicU64,
}

impl AssigneeCalls {
    pub(crate) fn snapshot(&self) -> serde_json::Value {
        use std::sync::atomic::Ordering::Relaxed;
        serde_json::json!({
            "full": self.full.load(Relaxed),
            "not_modified": self.not_modified.load(Relaxed),
        })
    }

    pub(crate) fn clear(&self) {
        use std::sync::atomic::Ordering::Relaxed;
        self.full.store(0, Relaxed);
        self.not_modified.store(0, Relaxed);
    }
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
pub(crate) struct Ttl {
    access_ttl: u64,
    refresh_ttl: u64,
}

impl Ttl {
    fn of(cfg: &Config) -> Ttl {
        Ttl {
            access_ttl: cfg.access_ttl.as_secs().max(1),
            refresh_ttl: cfg.refresh_ttl.as_secs().max(1),
        }
    }
}

impl Fake {
    /// Opens the truth, copying the fixture if needed. Blocks.
    pub fn open(cfg: Config) -> Result<Fake, fake_db::Error> {
        let truth = fake_db::Truth::open(&cfg.db, &cfg.fixture, Box::new(accounts::seed))?;
        Ok(Fake(Arc::new(State {
            truth,
            setup_url: Mutex::new(cfg.setup_url.clone()),
            ttl: Mutex::new(Ttl::of(&cfg)),
            webhooks: webhooks::Webhooks::new(cfg.webhook_url.clone(), cfg.webhook_secret.clone()),
            cfg,
            faults: faults::Faults::default(),
            refreshes: Refreshes::default(),
            graphql: GraphqlCalls::default(),
            assignees: AssigneeCalls::default(),
            app_tokens: app::Minted::default(),
            quotas: quota::Quotas::default(),
            not_modified: Default::default(),
            feeds: Default::default(),
            clock: Default::default(),
            media: attachments::Media::default(),
        })))
    }

    /// Serves the GitHub side on `api` and the control port on `ctl` until either fails.
    pub async fn serve(
        self,
        api: tokio::net::TcpListener,
        ctl: tokio::net::TcpListener,
    ) -> std::io::Result<()> {
        let api_app = axum::Router::new()
            .merge(oauth::router())
            .merge(api::router())
            .merge(writes::router())
            .merge(triage::router())
            .merge(relationship_writes::router())
            .merge(app::router())
            .merge(hook_deliveries::router())
            .merge(graphql::router())
            .merge(repos::router())
            .merge(events::router())
            .merge(attachments::router())
            // Not GitHub: the web's image hosts, which posts name (`web_hosts.rs`).
            .merge(web_hosts::router())
            .fallback(api::not_found)
            .layer(axum::middleware::from_fn_with_state(
                self.clone(),
                quota::middleware,
            ))
            .layer(axum::middleware::from_fn_with_state(
                self.clone(),
                faults::middleware,
            ))
            .layer(axum::middleware::from_fn_with_state(
                self.clone(),
                attachments::count,
            ))
            .with_state(self.clone());
        let api = faults::DownAware::new(api, self.clone());
        let ctl_app = control::router().with_state(self.clone());
        if let Some(rx) = self.state().webhooks.take_receiver() {
            tokio::spawn(webhooks::run(self.clone(), rx));
        }
        tokio::try_join!(async { axum::serve(api, api_app).await }, async {
            axum::serve(ctl, ctl_app).await
        },)?;
        Ok(())
    }

    fn state(&self) -> &State {
        &self.0
    }

    /// The fake's time in Unix seconds: the real time plus the clock's offset.
    pub(crate) fn now(&self) -> i64 {
        now() + self.clock_offset()
    }

    fn clock_offset(&self) -> i64 {
        self.0.clock.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn set_clock_offset(&self, secs: i64) {
        self.0
            .clock
            .store(secs, std::sync::atomic::Ordering::Relaxed);
    }

    fn ttl(&self) -> Ttl {
        *self.0.ttl.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub(crate) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A random token body in GitHub's alphabet.
pub(crate) fn random(len: usize) -> String {
    use rand::Rng as _;
    use rand::distr::Alphanumeric;
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

//! Fake GitHub: a stand-in for GitHub in local dev and tests. beghu's `GITHUB_API_URL` and
//! `GITHUB_WEB_URL` both point at its API listener, so the real client code runs against it.
//!
//! - The API listener serves the OAuth web flow (`/login/oauth/…`), the REST endpoints beghu
//!   calls, and the App's grant and token revocation. Later tickets add endpoints as they need
//!   them.
//! - The control listener takes runtime faults (latency, the next N calls failing, down), token
//!   lifetimes, revocations and a reset, and reports the fake's state.
//!
//! GitHub's truth is the fake's own copy of a fixture mirror (`fake_db::Truth`).

// Handlers return their early answers as `Err(Response)`; boxing them buys nothing here.
#![allow(clippy::result_large_err)]

mod accounts;
mod api;
mod control;
mod faults;
mod oauth;

pub use accounts::{ACCOUNTS, Role, pristine_mirrors};

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
}

/// GitHub's own lifetimes.
pub const ACCESS_TTL: Duration = Duration::from_secs(28_800);
pub const REFRESH_TTL: Duration = Duration::from_secs(15_897_600);

#[derive(Clone)]
pub struct Fake(Arc<State>);

pub(crate) struct State {
    truth: fake_db::Truth,
    cfg: Config,
    ttl: Mutex<Ttl>,
    faults: faults::Faults,
    refreshes: Refreshes,
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
            ttl: Mutex::new(Ttl::of(&cfg)),
            cfg,
            faults: faults::Faults::default(),
            refreshes: Refreshes::default(),
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
            .fallback(api::not_found)
            .layer(axum::middleware::from_fn_with_state(
                self.clone(),
                faults::middleware,
            ))
            .with_state(self.clone());
        let api = faults::DownAware::new(api, self.clone());
        let ctl_app = control::router().with_state(self.clone());
        tokio::try_join!(async { axum::serve(api, api_app).await }, async {
            axum::serve(ctl, ctl_app).await
        },)?;
        Ok(())
    }

    fn state(&self) -> &State {
        &self.0
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

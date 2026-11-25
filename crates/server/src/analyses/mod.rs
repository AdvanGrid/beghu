//! The PR view's analysis runs and analyses (#176): starting a run, pinning the PR, serving the
//! run's files, taking uploads, storing the latest analysis per PR in the account's
//! `analyses.db`, and serving its graph and claims to the view.
//!
//! **The run.** One agent's session against one PR for one connected account
//! ([`runs`](self::runs)). The browser starts one (`POST /api/{owner}/{repo}/pulls/{n}/runs`,
//! answering the prompt to copy), and so will the beghu CLI (`POST /api/cli/runs`); from then on
//! every producer goes through the run API under `/api/runs/{token}/` ([`run_api`]). One run per
//! account and PR is live: a start supersedes the live one. A run waits until the first fetch of
//! any run file pins the PR ([`pin`]); unused for 24 h it expires, and once attached it expires
//! after 2 h with no call, and 7 days after its start at the most. Each live run has a timer that
//! expires it on time ([`runs::watch`]), woken when the run ends otherwise, and re-armed at
//! startup. It's revoked when the user ends it, or its account signs out of every browser, goes
//! dormant, must sign in again, or can no longer read the repo: every call checks all of these
//! first ([`runs::admit`]). Uploads are unlimited within the run, each accepted one replacing the
//! PR's analysis ([`upload`]), and stored only while the run is still live. An ended run's row and
//! token are kept 30 days, to tell a call with its token why, then pruned by the daily check.
//!
//! **The token** is 256 random bits, URL-safe. Only its SHA-256 is stored, in the control DB
//! (`run_tokens`), beside the run's ID and account: a run call must resolve to an account
//! before beghu knows whose `analyses.db` to open. The run itself, its pinned `pr.json` and the
//! analyses are in `analyses.db` ([`analysis_db`]), one per account, deleted when it goes
//! dormant or disconnects. An account that loses Read on a repo loses its analyses and runs
//! there ([`runs::lost_repo`]).
//!
//! **Stored analyses** are split once, at upload, into the graph (everything but the claims'
//! bodies) and the claims, each compressed at brotli 9 and gzip 9 on the blocking pool and served
//! as stored ([`stored`], [`serve`]). A read that finds one behind this build's schema migrates
//! it and writes it back first, under a per-analysis lock; a migration that fails is a bug: a 500
//! of its own kind, the stored analysis untouched.
//!
//! **Live:** every change of a run's state (started, attached, refused, ended, expired) and every
//! accepted upload sends the account's streams an `analysis` event (live.rs).

pub(crate) mod pin;
pub(crate) mod run_api;
pub(crate) mod runs;
pub(crate) mod serve;
pub(crate) mod stored;
pub(crate) mod upload;

use crate::App;
use crate::live::{Push, StreamAnalysis};
use axum::body::Bytes;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};

/// Changed files past which a run is refused: GitHub lists no more (`/pulls/{n}/files`), so
/// "every changed file placed" couldn't hold.
pub(crate) const MAX_FILES: i64 = 3_000;
/// An upload's largest body on the wire.
pub(crate) const MAX_WIRE: usize = 8 * 1024 * 1024;
/// An upload's largest body once inflated, enforced while inflating.
pub(crate) const MAX_INFLATED: usize = 32 * 1024 * 1024;

/// A PR, as runs and analyses key it: the account's repo by id, and the number.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct PrKey {
    pub account: i64,
    pub repo_id: i64,
    pub number: i64,
}

/// Uploads whose inflating, checks, split and compression run at once. Each holds the upload
/// in several forms at a time (up to 32 MB of JSON, its parsed tree, the typed analysis, the
/// split and its four compressed blobs), a few hundred MB at the cap, and keeps a blocking thread
/// busy for seconds: two bound that whatever the number of uploads arriving, and let a small
/// PR's upload pass a large one's. The others wait their turn, having read their bodies (8 MB
/// each at most).
const UPLOADS_AT_ONCE: usize = 2;

/// The analyses side of the app: each account's `analyses.db`, the agent's tools, the migration
/// chain, one lock per PR's analysis, the uploads' turns, and the live runs' timers.
pub(crate) struct Store {
    pub dbs: analysis_db::Analyses,
    tools: Option<Tools>,
    pub chain: &'static analysis::Chain<'static>,
    locks: Mutex<HashMap<PrKey, Weak<tokio::sync::Mutex<()>>>>,
    /// An upload's turn at the heavy work: see [`UPLOADS_AT_ONCE`]. Owned by the upload's job,
    /// so a client that leaves doesn't hand its turn on while its work goes on.
    pub uploads: Arc<tokio::sync::Semaphore>,
    /// Each live run's timer ([`runs::watch`]), by run ID, with its account: woken when the run
    /// ends otherwise, so it stops then rather than at its deadline.
    timers: Mutex<HashMap<String, (i64, Arc<tokio::sync::Notify>)>>,
}

/// `validate.mjs` and `merge.mjs`, read once at startup and served as they are, uncopied.
pub(crate) struct Tools {
    pub validate: Bytes,
    pub merge: Bytes,
}

impl Store {
    /// Opens nothing yet: each account's file opens (or is created) on first use. Reads the
    /// agent's tools from `tools`, when given; a missing one refuses startup.
    pub fn new(
        dir: &Path,
        tools: Option<&Path>,
        chain: &'static analysis::Chain<'static>,
    ) -> Result<Store, String> {
        let tools = match tools {
            None => None,
            Some(t) => {
                let read = |name: &str| {
                    let path = t.join(name);
                    std::fs::read(&path)
                        .map(Bytes::from)
                        .map_err(crate::io_failed("read the agent's tool", &path))
                };
                Some(Tools {
                    validate: read("validate.mjs")?,
                    merge: read("merge.mjs")?,
                })
            }
        };
        Ok(Store {
            dbs: analysis_db::Analyses::new(dir, analysis_db::Config::default()),
            tools,
            chain,
            locks: Mutex::default(),
            uploads: Arc::new(tokio::sync::Semaphore::new(UPLOADS_AT_ONCE)),
            timers: Mutex::default(),
        })
    }

    /// A new timer for the live run: what wakes it. `None` when the run has one already.
    fn timer(&self, account: i64, run: &str) -> Option<Arc<tokio::sync::Notify>> {
        let mut all = self.timers.lock().unwrap_or_else(|e| e.into_inner());
        if all.contains_key(run) {
            return None;
        }
        let woken = Arc::new(tokio::sync::Notify::new());
        all.insert(run.to_owned(), (account, woken.clone()));
        Some(woken)
    }

    /// The run's timer stopped: it's forgotten.
    fn timer_done(&self, run: &str, woken: &Arc<tokio::sync::Notify>) {
        let mut all = self.timers.lock().unwrap_or_else(|e| e.into_inner());
        if all.get(run).is_some_and(|(_, w)| Arc::ptr_eq(w, woken)) {
            all.remove(run);
        }
    }

    /// The run ended, or its row went: its timer looks again, and stops.
    pub fn wake(&self, run: &str) {
        let all = self.timers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, w)) = all.get(run) {
            // A permit when the timer isn't waiting yet: it wakes as soon as it does.
            w.notify_one();
        }
    }

    /// The account's `analyses.db` is being deleted: every timer of its runs looks again, and
    /// stops.
    pub fn wake_account(&self, account: i64) {
        let all = self.timers.lock().unwrap_or_else(|e| e.into_inner());
        for (a, w) in all.values() {
            if *a == account {
                w.notify_one();
            }
        }
    }

    pub fn tools(&self) -> Option<&Tools> {
        self.tools.as_ref()
    }

    /// The PR's analysis lock: a migration on read, and an upload's check and write, hold it, so
    /// concurrent reads wait on one migration and an upload checks against the analysis it
    /// replaces.
    pub async fn lock(&self, pr: &PrKey) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut all = self.locks.lock().unwrap_or_else(|e| e.into_inner());
            all.retain(|_, l| l.strong_count() > 0);
            match all.get(pr).and_then(Weak::upgrade) {
                Some(l) => l,
                None => {
                    let l = Arc::new(tokio::sync::Mutex::new(()));
                    all.insert(pr.clone(), Arc::downgrade(&l));
                    l
                }
            }
        };
        lock.lock_owned().await
    }
}

/// Tells the account's streams that the PR's run or analysis changed: `analysis` is the PR's
/// analysis when an upload was just accepted.
pub(crate) fn announce(app: &App, account: i64, repo: &str, number: i64, analysis: Option<String>) {
    app.hub().publish(
        account,
        Push::Analysis(StreamAnalysis {
            repo: repo.to_owned(),
            number,
            analysis,
        }),
    );
}

/// Where a test stops the run ([`crate::Config::analysis_pause`]); nothing in a deploy.
pub(crate) async fn pause(app: &App, at: crate::RunPausePoint) {
    if let Some(p) = &app.cfg().analysis_pause {
        p(at).await;
    }
}

/// 256 random bits, URL-safe: a run's token.
pub(crate) fn new_token() -> String {
    crate::crypto::random_token(32)
}

/// 128 random bits, URL-safe: a run's or an analysis's ID.
pub(crate) fn new_id() -> String {
    crate::crypto::random_token(16)
}

//! The connected account's Resync (`POST /api/resync`), and the account repairs that work the same way: a
//! full sweep of every repo the account syncs.

use super::{Error, Repair, SyncStatus, status};
use crate::App;
use crate::error::ApiError;
use crate::live::Push;
use serde::Serialize;
use std::collections::BTreeSet;
use std::time::Duration;
use ts_rs::TS;

/// `POST /api/resync`'s answer: the sync state, now resyncing.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct ResyncReply {
    pub sync: Option<SyncStatus>,
}

/// `POST /api/resync`: a full sweep of the account's synced repos, at most once per
/// [`ReconcileConfig::resync_every`]; sooner is a 429 saying when. Asked again while one runs
/// (from another tab, say), or while a repair runs, it's the same one: 202.
pub async fn resync(
    axum::extract::State(app): axum::extract::State<App>,
    axum::extract::Extension(s): axum::extract::Extension<crate::auth::Session>,
) -> Result<(axum::http::StatusCode, axum::Json<ResyncReply>), ApiError> {
    let account = s.account;
    let r = app.reconcile();
    let every = r.cfg.resync_every.as_secs() as i64;
    let running = r.with(|st| {
        let a = st.accounts.entry(account).or_default();
        let running = !a.waiting.is_empty() || a.starting;
        a.starting |= !running;
        // A repair under way is this Resync: once it ends, sync is healthy, as after any Resync.
        a.asked |= !a.waiting.is_empty();
        running
    });
    if !running {
        // A job of its own: a request dropped half-way (a closed tab) still starts the Resync
        // it claimed, and however the start ends, the next ask may start one again.
        let starting = Starting(app.clone(), account);
        let started = app.spawn(move |app| async move {
            let _starting = starting;
            start_resync(&app, account, every).await
        });
        match started.await {
            Ok(Some(started)) => started?,
            Ok(None) => {
                return Err(ApiError::Unavailable {
                    retry_after: Duration::from_secs(5),
                    why: "the server is stopping".into(),
                });
            }
            Err(e) => return Err(ApiError::Internal(format!("starting a Resync: {e}"))),
        }
    }
    app.hub().publish(account, Push::Sync);
    Ok((
        axum::http::StatusCode::ACCEPTED,
        axum::Json(ResyncReply {
            sync: status(&app, account).await,
        }),
    ))
}

/// A Resync being started for the account: once dropped, the next ask starts one again.
struct Starting(App, i64);

impl Drop for Starting {
    fn drop(&mut self) {
        let account = self.1;
        self.0
            .reconcile()
            .with(|st| st.accounts.entry(account).or_default().starting = false);
    }
}

/// Takes the account's hourly Resync (kept in the control DB, so a restart doesn't hand out
/// another) and starts it; `TooSoon` when the last was within the hour. One that fails to start
/// is given back.
async fn start_resync(app: &App, account: i64, every: i64) -> Result<(), ApiError> {
    let now = crate::now();
    let (taken, previous) = app
        .control()
        .write(move |tx| {
            let previous = control_db::q::account(tx, account)?.and_then(|a| a.resync_asked_at);
            Ok((
                control_db::q::claim_resync(tx, account, now, now - every)?,
                previous,
            ))
        })
        .await?;
    if taken == 0 {
        let at = app
            .control()
            .read(move |c| control_db::q::account(c, account))
            .await?
            .and_then(|a| a.resync_asked_at)
            .unwrap_or(now);
        let wait = (at + every - now).max(1);
        return Err(ApiError::TooSoon {
            retry_after: Duration::from_secs(wait as u64),
            why: format!("Resync is available again in {} min", (wait + 59) / 60),
        });
    }
    eprintln!("reconcile: account {account} asked for a resync");
    let Err(e) = resync_account(app, account, true).await else {
        return Ok(());
    };
    // Not started: the hour's Resync isn't spent.
    if let Err(e) = app
        .control()
        .write(move |tx| control_db::q::release_resync(tx, account, now, previous))
        .await
    {
        eprintln!("reconcile: account {account}: giving its Resync back: {e}");
    }
    Err(match e {
        Error::Db(e) => e.into(),
        e => ApiError::Internal(e.to_string()),
    })
}

/// Asks for a full sweep of every repo the account syncs, which its resync waits for: the
/// marks it had are what this repairs, cleared once every repo has been swept. The connected
/// account's Resync (`asked`) sweeps every repo now; a repair skips those still backing off after failing.
pub(super) async fn resync_account(app: &App, account: i64, asked: bool) -> Result<(), Error> {
    let repos: BTreeSet<i64> = app
        .mirrors()
        .read(account, mirror_db::Caller::Sweep, |c| {
            mirror_db::q::sweep_repos(c)
        })
        .await?
        .into_iter()
        .map(|r| r.id)
        .collect();
    let marks = app
        .control()
        .read(move |c| control_db::q::resync_marks(c, account))
        .await?;
    if repos.is_empty() {
        // Nothing to sweep: done at once.
        app.control()
            .write(move |tx| control_db::q::clear_needs_resync(tx, account, marks))
            .await?;
        app.reconcile().with(|s| {
            let a = s.accounts.entry(account).or_default();
            a.asked = false;
            a.dirty.clear();
            s.suspects.retain(|x| x.account != account);
        });
        return Ok(());
    }
    let r = app.reconcile();
    let due: Vec<i64> = if asked {
        repos.iter().copied().collect()
    } else {
        r.repairable(&repos)
    };
    r.with(|s| {
        let a = s.accounts.entry(account).or_default();
        a.asked |= asked;
        a.repair = Some(Repair { marks, left: repos });
    });
    r.ask_full(&due, Some(account));
    Ok(())
}

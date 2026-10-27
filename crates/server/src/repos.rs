//! The account's view of its repos: the role on each synced repo, re-read from GitHub's
//! `permissions` with the user's token at sign-in and then every `repo_refresh_every` (15
//! minutes) while the account is in use.
//!
//! Until repo picking writes `synced_repos` itself, each re-read also records there the visible
//! repos the account's mirror syncs, so webhooks for them fan out to it, and removes from there
//! every repo the account can no longer see, so they stop.
//!
//! One re-read per account runs at a time: a request that finds one running waits on it rather
//! than starting another. A sign-in always gets a re-read of its own, after any running one. A
//! failed re-read is tried again no sooner than `roles_retry_after_failure` (a minute) later, so
//! while GitHub fails, an account costs it one call a minute, and requests in between serve the
//! roles they have without waiting.

use crate::error::ApiError;
use crate::{App, tokens};
use mirror_db::{Caller, q};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::watch;

/// How long a request (`/api/me`, or the sign-in callback) waits for a re-read before going on
/// with the roles it has; the re-read carries on in the background.
const WAIT: Duration = Duration::from_secs(2);

/// How a re-read ended.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Outcome {
    Fresh,
    /// The account must sign in again.
    SignedOut,
    /// GitHub or the mirror failed, or the re-read panicked.
    Failed,
}

/// Each account's last re-read and the one running, if any.
#[derive(Default)]
pub struct Roles(Mutex<HashMap<i64, Account>>);

#[derive(Default)]
struct Account {
    /// When the last re-read finished, and how.
    last: Option<(Instant, Outcome)>,
    /// The running re-read: its number and its outcome, once it has one.
    running: Option<(u64, watch::Receiver<Option<Outcome>>)>,
    /// The number the next re-read gets.
    next: u64,
}

/// What [`Roles::join_or_start`] found.
enum Found {
    /// A re-read is running (perhaps just started): wait on it.
    Running(watch::Receiver<Option<Outcome>>),
    /// None is due; the last one ended this way.
    Settled(Option<Outcome>),
}

impl Roles {
    /// The running re-read for `account`, or a new one if it's due. With `force` (a sign-in),
    /// always a new one: if one is already running, perhaps with the token the sign-in just
    /// replaced, the new one starts once it ends.
    fn join_or_start(&self, app: &App, account: i64, force: bool) -> Found {
        let mut all = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let a = all.entry(account).or_default();
        // A re-read whose task died without finishing dropped its sender: forget it.
        let running = a
            .running
            .as_ref()
            .filter(|(_, rx)| rx.has_changed().is_ok())
            .map(|(_, rx)| rx.clone());
        if let (Some(rx), false) = (&running, force) {
            return Found::Running(rx.clone());
        }
        let due = match a.last {
            None => true,
            Some((at, Outcome::Fresh)) => at.elapsed() >= app.cfg().repo_refresh_every,
            Some((at, _)) => at.elapsed() >= app.cfg().roles_retry_after_failure,
        };
        if !(due || force) {
            return Found::Settled(a.last.map(|(_, o)| o));
        }
        let (tx, rx) = watch::channel(None);
        let id = a.next;
        a.next += 1;
        a.running = Some((id, rx.clone()));
        let app = app.clone();
        tokio::spawn(async move {
            if let Some(before) = running {
                outcome(before, None).await;
            }
            // Its own task, so a panic ends as `Failed` (and backs off) instead of unwinding
            // through the bookkeeping below.
            let reread = {
                let app = app.clone();
                tokio::spawn(async move { refresh_roles(&app, account).await })
            };
            let outcome = match reread.await {
                Ok(Ok(())) => Outcome::Fresh,
                Ok(Err(ApiError::SignedOut)) => Outcome::SignedOut,
                Ok(Err(e)) => {
                    eprintln!("account {account}: refreshing roles failed: {e:?}");
                    Outcome::Failed
                }
                Err(e) => {
                    eprintln!("account {account}: refreshing roles panicked: {e}");
                    Outcome::Failed
                }
            };
            app.roles().finish(account, id, outcome);
            let _ = tx.send(Some(outcome));
        });
        Found::Running(rx)
    }

    /// Records how re-read `id` ended; it stops being the running one unless a newer one has
    /// taken its place.
    fn finish(&self, account: i64, id: u64, outcome: Outcome) {
        let mut all = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let a = all.entry(account).or_default();
        a.last = Some((Instant::now(), outcome));
        if a.running.as_ref().is_some_and(|(r, _)| *r == id) {
            a.running = None;
        }
    }
}

/// Waits up to `wait` for a re-read; `None` if it's still running.
async fn outcome(
    mut rx: watch::Receiver<Option<Outcome>>,
    wait: Option<Duration>,
) -> Option<Outcome> {
    let done = rx.wait_for(Option::is_some);
    let got = match wait {
        Some(w) => tokio::time::timeout(w, done).await.ok()?,
        None => done.await,
    };
    got.ok().and_then(|o| *o)
}

/// Re-reads the repos the account can see and writes its role on each into its mirror.
async fn refresh_roles(app: &App, account: i64) -> Result<(), ApiError> {
    let gh = app.github().clone();
    let repos = app
        .tokens()
        .with_token(account, |token| {
            let gh = gh.clone();
            async move { gh.visible_repos(&token).await }
        })
        .await
        .map_err(|e| match e {
            tokens::Error::SignInAgain => ApiError::SignedOut,
            e => ApiError::Internal(format!("refreshing the repo set: {e}")),
        })?;
    let visible: std::collections::HashSet<i64> = repos.iter().map(|r| r.id).collect();
    let synced = app
        .mirrors()
        .write(account, Caller::Request, move |tx, _seq| {
            for r in &repos {
                q::set_repo_role(tx, r.id, r.role)?;
            }
            q::synced_repos(tx)
        })
        .await?;
    let synced: Vec<i64> = synced
        .into_iter()
        .map(|r| r.id)
        .filter(|id| visible.contains(id))
        .collect();
    let now = crate::now();
    app.control()
        .write(move |tx| {
            // A repo the account can no longer see stops fanning out to it.
            for id in control_db::q::synced_repo_ids(tx, account)? {
                if !visible.contains(&id) {
                    control_db::q::remove_synced_repo(tx, account, id)?;
                }
            }
            for id in &synced {
                control_db::q::add_synced_repo(tx, account, *id, now)?;
            }
            Ok(())
        })
        .await?;
    Ok(())
}

/// At sign-in: starts a fresh re-read of the roles and waits up to 2 s for it, so the first
/// page usually has them; a slower re-read carries on in the background. A failure only delays
/// fresh roles to the next try.
pub async fn refresh_roles_now(app: &App, account: i64) {
    if let Found::Running(rx) = app.roles().join_or_start(app, account, true) {
        outcome(rx, Some(WAIT)).await;
    }
}

/// Re-reads the roles if they're due. Waits up to 2 s for it, so `/api/me` serves fresh roles
/// when GitHub is quick and the old ones when it isn't; the re-read carries on either way.
/// While the last re-read found the account signed out, so is every request.
pub async fn refresh_roles_if_stale(app: &App, account: i64) -> Result<(), ApiError> {
    let ended = match app.roles().join_or_start(app, account, false) {
        Found::Running(rx) => outcome(rx, Some(WAIT)).await,
        Found::Settled(last) => last,
    };
    match ended {
        Some(Outcome::SignedOut) => Err(ApiError::SignedOut),
        _ => Ok(()),
    }
}

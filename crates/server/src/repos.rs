//! The account's repos: the ones it can see, the ones it picked to sync, and its role on each.
//!
//! The visible repos (every repo of every installation the user can reach) are re-read with the
//! user's token at sign-in, at the App's setup URL, when an installation changes, and then every
//! `repo_refresh_every` (15 minutes) while the account is in use. They live in the mirror's
//! `repos` table: a visible repo has its `installation_id` and role set, synced or not, and a
//! repo stubs point into has neither. That's the set the isolation rule asks about.
//!
//! `synced_repos` in the control DB is the source of truth for which repos the account syncs, and
//! decides webhook fan-out. Repo picking (`GET`/`PUT /api/repos`) writes it first; then the
//! mirror is brought in line ([`reconcile`]): a repo that joined starts its import (import.rs),
//! and one that left is unsynced, its rows deleted except those a relationship from a synced item
//! still reaches, which become stubs. A repo the account can no longer see leaves `synced_repos` at
//! the next re-read, so webhooks for it stop reaching the account, and is unsynced the same way,
//! keeping stubs only when it's public. Nothing is recorded as deleted: syncing the repo again
//! brings the same ids back.
//!
//! A mirror can exist before its account does (the dev stack's pristine mirrors, made before
//! anyone signed in): an account created at sign-in takes the repos its mirror already syncs as
//! its first pick ([`adopt_mirror_pick`]). Only then; an account that exists keeps its pick,
//! empty or not.
//!
//! One re-read per account runs at a time: a request that finds one running waits on it rather
//! than starting another. A sign-in always gets a re-read of its own, after any running one. A
//! failed re-read is tried again no sooner than `roles_retry_after_failure` (a minute) later, so
//! while GitHub fails, an account costs it one call a minute, and requests in between serve the
//! roles they have without waiting.

use crate::auth::Session;
use crate::error::ApiError;
use crate::github::Role;
use crate::import::ImportStatus;
use crate::live::Push;
use crate::{App, tokens};
use axum::Json;
use axum::extract::{Extension, State};
use mirror_db::{Caller, q};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::watch;
use ts_rs::TS;

/// How long a request (`/api/me`, or the sign-in callback) waits for a re-read before going on
/// with the roles it has; the re-read carries on in the background.
pub(crate) const WAIT: Duration = Duration::from_secs(2);

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

/// How fresh a caller wants the roles.
#[derive(Clone, Copy)]
enum Want {
    /// As fresh as `repo_refresh_every` keeps them.
    Due,
    /// Re-read unless the last one is younger than this (or failed under its backoff).
    NewerThan(Duration),
    /// A re-read of its own, after any running one: a sign-in.
    Fresh,
}

/// What [`Roles::join_or_start`] found.
enum Found {
    /// A re-read is running (perhaps just started): wait on it.
    Running(watch::Receiver<Option<Outcome>>),
    /// None is due; the last one ended this way.
    Settled(Option<Outcome>),
}

impl Roles {
    /// The running re-read for `account`, or a new one if it's due. With [`Want::Fresh`] (a
    /// sign-in), always a new one: if one is already running, perhaps with the token the sign-in
    /// just replaced, the new one starts once it ends.
    fn join_or_start(&self, app: &App, account: i64, want: Want) -> Found {
        let force = matches!(want, Want::Fresh);
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
        let fresh_for = match want {
            Want::NewerThan(age) => age.min(app.cfg().repo_refresh_every),
            Want::Due | Want::Fresh => app.cfg().repo_refresh_every,
        };
        let due = match a.last {
            None => true,
            Some((at, Outcome::Fresh)) => at.elapsed() >= fresh_for,
            Some((at, _)) => at.elapsed() >= app.cfg().roles_retry_after_failure,
        };
        if !(due || force) {
            return Found::Settled(a.last.map(|(_, o)| o));
        }
        let (tx, rx) = watch::channel(None);
        let id = a.next;
        a.next += 1;
        a.running = Some((id, rx.clone()));
        app.spawn(move |app| async move {
            if let Some(before) = running {
                outcome(before, None).await;
            }
            // Its own task, so a panic ends as `Failed` (and backs off) instead of unwinding
            // through the bookkeeping below.
            let reread = app.spawn(move |app| async move { refresh_roles(&app, account).await });
            let outcome = match reread.await {
                // The drain stopped it, and this with it.
                Ok(None) => return,
                Ok(Some(Ok(()))) => Outcome::Fresh,
                Ok(Some(Err(ApiError::SignedOut))) => Outcome::SignedOut,
                Ok(Some(Err(e))) => {
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

    /// Every account's repos are due for a re-read: an installation changed.
    pub fn all_stale(&self) {
        let mut all = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for a in all.values_mut() {
            a.last = None;
        }
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

/// Re-reads the repos the account can see into its mirror, drops from its pick the ones it can
/// no longer see, and brings the mirror in line with the pick.
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
            tokens::Error::Restarting => ApiError::restarting(),
            e => ApiError::Internal(format!("refreshing the repo set: {e}")),
        })?;
    let visible: HashSet<i64> = repos.iter().map(|r| r.id).collect();
    let changed = app
        .mirrors()
        .write(account, Caller::Request, move |tx, _seq| {
            let before = q::visible_repos(tx)?;
            for r in &repos {
                // A repo whose role GitHub didn't say keeps the one stored.
                q::upsert_visible_repo(
                    tx,
                    r.id,
                    &r.node_id,
                    &r.owner,
                    &r.name,
                    r.private,
                    r.installation_id,
                    r.role.map(Role::as_str),
                    r.archived,
                )?;
            }
            for r in &before {
                if !repos.iter().any(|v| v.id == r.id) {
                    q::forget_visible_repo(tx, r.id)?;
                }
            }
            // What the repos are, and apart from that what the account may do in them.
            let after = q::visible_repos(tx)?;
            let differ = |key: &dyn Fn(&q::VisibleReposRow) -> String| {
                let mut was: Vec<_> = before.iter().map(key).collect();
                let mut now: Vec<_> = after.iter().map(key).collect();
                was.sort();
                now.sort();
                was != now
            };
            let repos = differ(&|r| format!("{} {:?} {}", r.id, r.installation_id, r.name));
            // A repo that stays visible with another role or archived flag; one that comes or
            // goes is the reset's.
            let roles = after.iter().any(|now| {
                before.iter().any(|was| {
                    was.id == now.id && (was.role != now.role || was.archived != now.archived)
                })
            });
            Ok((repos, roles))
        })
        .await?;
    let (changed, roles_changed) = changed;

    app.control()
        .write(move |tx| {
            // A repo the account can no longer see stops fanning out to it.
            for id in control_db::q::synced_repo_ids(tx, account)? {
                if !visible.contains(&id) {
                    control_db::q::remove_synced_repo(tx, account, id)?;
                }
            }
            Ok(())
        })
        .await?;
    // The picker refetches: one reset, the unsync's if it pushed one.
    let pushed = reconcile(app, account).await?;
    if changed && !pushed {
        app.hub().publish(account, Push::Reset);
    }
    // A role or an archived flag changed: the tabs read `/api/me` and the open detail again.
    if roles_changed {
        app.hub().publish(account, Push::Roles);
    }
    Ok(())
}

/// A new account takes the repos its mirror already syncs as its first pick: a mirror made
/// before the account was (the dev stack's pristine mirrors). Called once, as sign-in creates the
/// account; a new account in production has no mirror, so nothing to take.
pub async fn adopt_mirror_pick(app: &App, account: i64) -> Result<(), ApiError> {
    let synced = app
        .mirrors()
        .read(account, Caller::Request, |c| q::synced_repos(c))
        .await?;
    let now = crate::now();
    app.control()
        .write(move |tx| {
            for r in &synced {
                control_db::q::add_synced_repo(tx, account, r.id, now)?;
            }
            Ok(())
        })
        .await?;
    Ok(())
}

/// Brings the mirror in line with the account's pick: imports what joined (and resumes an import
/// a restart cut short), unsyncs what left (and finishes an unsync a restart or a failed chunk
/// cut short). An unsync that fails is logged and left to a later reconcile. Whether it pushes a
/// `reset` (it does when a repo left, once that repo's unsync has run).
pub async fn reconcile(app: &App, account: i64) -> Result<bool, ApiError> {
    let picked: HashSet<i64> = app
        .control()
        .read(move |c| control_db::q::synced_repo_ids(c, account))
        .await?
        .into_iter()
        .collect();
    let (joined, resumed, unsynced, unfinished) = app
        .mirrors()
        .write(account, Caller::Request, move |tx, seq| {
            let visible = q::visible_repos(tx)?;
            let (mut joined, mut resumed) = (Vec::new(), Vec::new());
            for r in &visible {
                if !picked.contains(&r.id) {
                    continue;
                }
                if !r.synced {
                    q::start_repo_import(tx, r.id, seq)?;
                    joined.push(r.id);
                } else if r.importing {
                    resumed.push(r.id);
                }
            }
            // Synced but no longer picked, whether or not the account still sees the repo.
            let mut unsynced = Vec::new();
            for id in q::synced_repos(tx)?.into_iter().map(|r| r.id) {
                if picked.contains(&id) {
                    continue;
                }
                let Some(r) = q::repo_state(tx, id)? else {
                    continue;
                };
                start_unsync(tx, seq, id, keeps_stubs(&r))?;
                unsynced.push(id);
            }
            // Unsyncs an earlier process (or a failed chunk) left partway.
            let unfinished: Vec<i64> = q::unfinished_unsyncs(tx)?
                .into_iter()
                .filter(|id| !picked.contains(id) && !unsynced.contains(id))
                .collect();
            Ok((joined, resumed, unsynced, unfinished))
        })
        .await?;
    // Who can be assigned is read afresh if the repo is picked again.
    for &repo in &unsynced {
        app.assignable().forget(repo);
    }
    // One request, so the resumed repos go through the phases with the ones that joined. Before
    // the unsync, so a slow or failing one never keeps a picked repo from importing.
    crate::import::request(app, account, joined, resumed);
    let finishing: Vec<i64> = unsynced.iter().chain(&unfinished).copied().collect();
    let pushes = !unsynced.is_empty();
    if !finishing.is_empty() {
        // Its own task, so a request that goes away doesn't stop it partway. One that fails (or a
        // restart) leaves the rest to a later reconcile, which finds it in `unfinished_unsyncs`.
        let done = app.spawn(move |app| async move {
            for repo in finishing {
                if let Err(e) = finish_unsync(&app, account, repo).await {
                    eprintln!("account {account}: unsyncing repo {repo}: {e:?}");
                }
            }
            if pushes {
                app.hub().publish(account, Push::Reset);
            }
        });
        if let Err(e) = done.await {
            eprintln!("account {account}: unsyncing panicked: {e}");
        }
    }
    // What the sweeps read may have changed.
    app.reconcile().repos_changed();
    Ok(pushes)
}

/// Whether an unsynced repo's items a relationship still reaches stay as stubs: only while the
/// account can see the repo, or anyone can.
fn keeps_stubs(r: &q::RepoStateRow) -> bool {
    r.installation_id.is_some() || !r.private
}

/// How many of an unsynced repo's items go in one transaction.
const UNSYNC_CHUNK: i64 = 500;

/// Starts taking a repo out of the mirror: the relationships that go, the items a relationship
/// from a full item in another synced repo still reaches made stubs (with `keep_stubs`; without
/// it every relationship into the repo goes), and the repo no longer synced, so nothing writes
/// into it from here on. Its rows go in [`finish_unsync`]. Nothing is recorded in `deleted`.
fn start_unsync(
    tx: &rusqlite::Transaction,
    seq: i64,
    repo: i64,
    keep_stubs: bool,
) -> rusqlite::Result<()> {
    q::unsync_relationships(tx, repo, keep_stubs)?;
    q::unsync_to_stubs(tx, repo, seq)?;
    q::unsync_repo(tx, repo)?;
    Ok(())
}

/// The rest of an unsync: the repo's items a chunk at a time, each chunk its own transaction so
/// the account's other writes go between them, then its labels and milestones and the stubs no
/// relationship reaches any more. Each chunk first makes stubs of its items a relationship
/// written since [`start_unsync`] reaches. Stops if the repo is picked again meanwhile (its import
/// writes over what's left).
async fn finish_unsync(app: &App, account: i64, repo: i64) -> Result<(), ApiError> {
    let mut after = i64::MIN;
    loop {
        let last = app
            .mirrors()
            .write(account, Caller::Request, move |tx, seq| {
                let Some(r) = q::repo_state(tx, repo)? else {
                    return Ok(None);
                };
                if r.synced {
                    return Ok(None);
                }
                let ids = q::repo_items_after(tx, repo, after, UNSYNC_CHUNK)?;
                // A relationship written to one of them since the unsync started keeps it as a
                // stub, by the same rule as `start_unsync`.
                q::unsync_relationships_of(tx, &ids, repo, keeps_stubs(&r))?;
                q::unsync_to_stubs_of(tx, &ids, seq)?;
                q::unsync_labels_of(tx, &ids)?;
                q::unsync_assignees_of(tx, &ids)?;
                q::unsync_comments_of(tx, &ids)?;
                q::unsync_full_items(tx, &ids)?;
                Ok(ids.last().copied())
            })
            .await?;
        match last {
            Some(id) => after = id,
            None => break,
        }
    }
    app.mirrors()
        .write(account, Caller::Request, move |tx, _| {
            if !crate::import::synced(tx, repo)? {
                q::unsync_labels(tx, repo)?;
                q::unsync_milestones(tx, repo)?;
            }
            q::drop_orphan_stubs(tx)?;
            Ok(())
        })
        .await?;
    Ok(())
}

/// While an account has a live session (a tab's stream open), its repos and roles are re-read
/// every `repo_refresh_every`, whether or not the tab asks `/api/me`: a role changed on GitHub
/// sends no webhook, and reaches the tabs as a `roles` push. Looks every minute (or every
/// `repo_refresh_every`, if that's sooner, and at most every second); never waits on a re-read.
pub async fn keep_live_roles_fresh(app: App) {
    let tick = app
        .cfg()
        .repo_refresh_every
        .clamp(Duration::from_secs(1), Duration::from_secs(60));
    loop {
        tokio::time::sleep(tick).await;
        for account in app.hub().live_accounts() {
            drop(app.roles().join_or_start(&app, account, Want::Due));
        }
    }
}

/// At sign-in: starts a fresh re-read of the roles and waits up to 2 s for it, so the first
/// page usually has them; a slower re-read carries on in the background. A failure only delays
/// fresh roles to the next try.
pub async fn refresh_roles_now(app: &App, account: i64) {
    if let Found::Running(rx) = app.roles().join_or_start(app, account, Want::Fresh) {
        outcome(rx, Some(WAIT)).await;
    }
}

/// Re-reads the roles if they're due. Waits up to 2 s for it, so `/api/me` serves fresh roles
/// when GitHub is quick and the old ones when it isn't; the re-read carries on either way.
/// While the last re-read found the account signed out, so is every request.
pub async fn refresh_roles_if_stale(app: &App, account: i64) -> Result<(), ApiError> {
    refresh_roles_wanting(app, account, Want::Due).await
}

/// As [`refresh_roles_if_stale`], but the roles are stale once the last re-read is `age` old.
/// One re-read per account still runs at a time, and a failed one still backs off, so a caller
/// anyone can trigger costs GitHub at most one call per `age`.
pub async fn refresh_roles_if_older_than(
    app: &App,
    account: i64,
    age: Duration,
) -> Result<(), ApiError> {
    refresh_roles_wanting(app, account, Want::NewerThan(age)).await
}

async fn refresh_roles_wanting(app: &App, account: i64, want: Want) -> Result<(), ApiError> {
    let ended = match app.roles().join_or_start(app, account, want) {
        Found::Running(rx) => outcome(rx, Some(WAIT)).await,
        Found::Settled(last) => last,
    };
    match ended {
        Some(Outcome::SignedOut) => Err(ApiError::SignedOut),
        _ => Ok(()),
    }
}

/// The picker: every repo the account can see, whether it's synced, and how to install the App
/// on more.
#[derive(Serialize, TS)]
#[ts(export)]
pub struct RepoPicker {
    pub repos: Vec<PickableRepo>,
    /// Where installing the App on another account starts; `null` when GitHub didn't say and no
    /// slug is configured.
    pub install_url: Option<String>,
    /// The import running, if any.
    pub import: Option<ImportStatus>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct PickableRepo {
    pub id: i64,
    pub owner: String,
    pub name: String,
    pub private: bool,
    pub archived: bool,
    /// The account's role on it; `null` if the mirror holds one this build doesn't know.
    pub role: Option<Role>,
    pub synced: bool,
    /// Synced, and its import hasn't finished.
    pub importing: bool,
}

/// `PUT /api/repos`: the repos to sync, all of them.
#[derive(Deserialize, TS)]
#[ts(export)]
pub struct PickRepos {
    pub repos: Vec<i64>,
}

async fn picker(app: &App, account: i64) -> Result<RepoPicker, ApiError> {
    let rows = app
        .mirrors()
        .read(account, Caller::Request, |c| q::visible_repos(c))
        .await?;
    let install_url = app
        .installations()
        .install_url(app.cfg().github.app_slug.as_deref())
        .await;
    Ok(RepoPicker {
        repos: rows
            .into_iter()
            .map(|r| PickableRepo {
                id: r.id,
                owner: r.owner,
                name: r.name,
                private: r.private,
                archived: r.archived,
                role: r.role.as_deref().and_then(Role::parse),
                synced: r.synced,
                importing: r.synced && r.importing,
            })
            .collect(),
        install_url,
        import: app.imports().status(account),
    })
}

/// `GET /api/repos`.
pub async fn list(
    State(app): State<App>,
    Extension(s): Extension<Session>,
) -> Result<Json<RepoPicker>, ApiError> {
    refresh_roles_if_stale(&app, s.account).await?;
    Ok(Json(picker(&app, s.account).await?))
}

/// `PUT /api/repos`: the account's pick, written to `synced_repos` before the mirror follows.
/// Only repos the account can see may be picked; like every write under `/api`, only from
/// beghu's own pages (the Origin layer).
pub async fn pick(
    State(app): State<App>,
    Extension(s): Extension<Session>,
    Json(p): Json<PickRepos>,
) -> Result<Json<RepoPicker>, ApiError> {
    let account = s.account;
    let visible: HashSet<i64> = app
        .mirrors()
        .read(account, Caller::Request, |c| q::visible_repos(c))
        .await?
        .into_iter()
        .map(|r| r.id)
        .collect();
    let wanted: HashSet<i64> = p.repos.into_iter().collect();
    if let Some(id) = wanted.iter().find(|id| !visible.contains(id)) {
        return Err(ApiError::BadRequest(format!(
            "repo {id} isn't one you can see"
        )));
    }
    let now = crate::now();
    app.control()
        .write(move |tx| {
            for id in control_db::q::synced_repo_ids(tx, account)? {
                if !wanted.contains(&id) {
                    control_db::q::remove_synced_repo(tx, account, id)?;
                }
            }
            for id in &wanted {
                control_db::q::add_synced_repo(tx, account, *id, now)?;
            }
            Ok(())
        })
        .await?;
    // Its own task: a browser that goes away mid-pick still gets it carried out whole.
    let rec = app.spawn(move |app| async move { reconcile(&app, account).await });
    rec.await
        .map_err(|e| ApiError::Internal(format!("reconciling the pick panicked: {e}")))?
        .ok_or_else(ApiError::restarting)??;
    Ok(Json(picker(&app, account).await?))
}

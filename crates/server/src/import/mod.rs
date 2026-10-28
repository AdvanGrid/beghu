//! The import: what fills a mirror with a repo the account starts syncing, whether it was just
//! picked, the mirror was rebuilt or lost, or a restart cut an import short. One code path for
//! all of them.
//!
//! It reads with the repo's installation token, in four phases, each across every repo being
//! imported before the next starts, up to [`STREAMS`] repos at a time:
//!
//! 1. Open issues (the app is usable from here), by paged GraphQL (`ImportIssues`, 100 a page,
//!    oldest update first) with labels, assignees, milestone, issue type and the relationship
//!    summaries inline, after the repo's labels and milestones (REST: GraphQL has no database id
//!    for either). Sub-issue and dependency lists come from a `nodes(ids:)` batch
//!    (`ImportRelationships`) for the issues whose summaries say they have any, and for each
//!    parent; relates-to comes inline (`relatesTo(first: 50)`), paged through `ImportRelatesTo`
//!    past 50.
//! 2. Open PRs: REST's issue list (it has the issue-side id GraphQL lacks), then a `nodes(ids:)`
//!    batch (`ImportPullDetails`) for the branches, review decision and the issues each is a
//!    linked PR of (GitHub's `closingIssuesReferences`).
//! 3. Comments on open items, 100 items a call (`ImportComments`), paged past 100 comments
//!    (`ImportMoreComments`).
//! 4. Closed issues and PRs, as in 1 and 2, then their comments through the repo-wide REST pass
//!    (#86). The pass lists every comment in the repo, so it writes only the threads still short
//!    (the closed items'; phase 3 read the open ones'), and a repo with none short skips it.
//!
//! Every page is one mirror transaction through the webhook upserts, so webhooks apply from the
//! start and the `updated_at` guard decides between a webhook and an older page, and an id a
//! webhook deleted never comes back. Each page pushes its ids, so rows appear as they land. A
//! write for a repo no longer synced (unsynced mid-import) is skipped.
//!
//! GitHub failing doesn't stop it: a rate limit waits as long as GitHub asks (a secondary limit
//! that doesn't say, at least a minute, doubling), and 5xx, timeouts and network errors retry
//! with backoff, up to ten tries or five minutes a call, all while the status slot says what it
//! waits for. A failure that won't pass (a repo gone, say, or GitHub failing past that budget)
//! ends that repo's part of the round: the repos that got through every phase
//! finish, and the failed one stays `importing`, named in the status slot, and is tried again
//! later (a minute, doubling with each failure in a row, up to six hours; a restart keeps the
//! count and the time). A round finishes only the imports it began: a repo unsynced and picked
//! again meanwhile is imported again whole.
//!
//! Relationships keep the isolation rule: one to an issue outside the synced repos becomes a stub
//! only when its repo is visible to the account (an installation it can reach shows it) or
//! public; otherwise the relationship is dropped. Two ends outside the synced repos are never
//! stored. Linked PRs (`closes`) are kept in the same table, under the same rule.

mod paging;
pub(crate) mod shapes;
pub(crate) mod writes;

use crate::App;
use crate::github::CallError;
use crate::installations::Scope;
use crate::live::Push;
use mirror_db::{Caller, q};
use serde::Serialize;
use shapes::RestComment;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;
use ts_rs::TS;
pub(crate) use writes::synced;
use writes::{CommentData, publish, write_comments, write_synced};

/// Repos imported at once within a phase.
pub const STREAMS: usize = 4;
/// GitHub's page size, and `nodes(ids:)`'s limit.
const PAGE: usize = 100;
/// The longest wait between retries of a failing call (a rate limit waits as long as it asks).
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// A call that keeps failing with a 401 after fresh tokens is given up.
const AUTH_TRIES: u32 = 3;
/// How long opening an issue waits for its comments to be fetched on demand.
const ON_DEMAND_WAIT: Duration = Duration::from_secs(5);

/// The four phases, in the order they run, each across every repo of the round.
#[derive(Serialize, TS, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ImportPhase {
    /// Open issues: the app is usable from here.
    OpenIssues,
    OpenPrs,
    /// Comments on open issues and PRs.
    OpenComments,
    /// Closed issues and PRs, and their comments.
    Closed,
}

impl ImportPhase {
    pub const ALL: [ImportPhase; 4] = [
        ImportPhase::OpenIssues,
        ImportPhase::OpenPrs,
        ImportPhase::OpenComments,
        ImportPhase::Closed,
    ];
}

/// What the status slot shows while an account imports.
#[derive(Serialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct ImportStatus {
    /// The phase running; `null` between rounds, while only repos whose import failed wait for
    /// their next try.
    pub phase: Option<ImportPhase>,
    /// Repos of the round through this phase.
    pub done: usize,
    /// Repos in the round.
    pub of: usize,
    /// What holds the import up: a rate limit or an outage; `null` while it runs.
    pub waiting: Option<String>,
    /// The repos (`owner/name`) whose import failed and will be tried again.
    pub failed: Vec<String>,
    /// Between rounds, when the first failed repo is tried again (Unix seconds).
    #[ts(type = "number | null")]
    pub retry_at: Option<i64>,
}

/// Each account's import: the repos waiting for one, and the one running.
#[derive(Default)]
pub struct Imports(Mutex<HashMap<i64, Account>>);

#[derive(Default)]
struct Account {
    /// Repos waiting for the next round.
    pending: BTreeSet<i64>,
    /// The round running: asking again for one of these waits for nothing.
    current: BTreeSet<i64>,
    /// The job is on: running a round, or waiting for a failed repo's next try.
    running: bool,
    /// The running round's phase and progress.
    round: Option<Round>,
    /// What each repo's stream waits on (a rate limit, an outage), by repo.
    waits: BTreeMap<i64, String>,
    /// Repos whose import failed, and when each is tried again.
    failed: BTreeMap<i64, Failed>,
    /// Wakes a job waiting for a failed repo's next try when more repos are asked for.
    wake: Arc<Notify>,
    /// The status last pushed to the account's tabs.
    pushed: Option<ImportStatus>,
    /// Cancelled when the account loses access ([`Imports::stop`]): its job and round end.
    stop: tokio_util::sync::CancellationToken,
}

/// A round's phase, and how many of its repos are through it.
#[derive(Clone, Copy, Debug)]
struct Round {
    phase: ImportPhase,
    done: usize,
    of: usize,
}

/// A repo whose import failed: its `owner/name`, and when it's tried again (Unix seconds).
#[derive(Clone, Debug)]
pub(super) struct Failed {
    name: String,
    retry_at: i64,
}

impl Account {
    fn status(&self) -> Option<ImportStatus> {
        if !self.running {
            return None;
        }
        Some(ImportStatus {
            phase: self.round.map(|r| r.phase),
            done: self.round.map_or(0, |r| r.done),
            of: self.round.map_or(0, |r| r.of),
            waiting: match self.round {
                Some(_) => self.waits.values().next().cloned(),
                None => None,
            },
            failed: self.failed.values().map(|f| f.name.clone()).collect(),
            retry_at: match self.round {
                Some(_) => None,
                None => self.next_retry(),
            },
        })
    }

    /// When the first failed repo is tried again.
    fn next_retry(&self) -> Option<i64> {
        self.failed.values().map(|f| f.retry_at).min()
    }
}

impl Imports {
    fn with<T>(&self, f: impl FnOnce(&mut HashMap<i64, Account>) -> T) -> T {
        f(&mut self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// The account's import status; `None` when it isn't importing.
    pub fn status(&self, account: i64) -> Option<ImportStatus> {
        self.with(|all| all.get(&account).and_then(Account::status))
    }

    pub fn running(&self, account: i64) -> bool {
        self.with(|all| all.get(&account).is_some_and(|a| a.running))
    }

    /// Stops the account's import (it lost access, so its mirror is about to go) and forgets it:
    /// the job and its round end at their next await, and a later [`request`] starts afresh.
    pub fn stop(&self, account: i64) {
        if let Some(a) = self.with(|all| all.remove(&account)) {
            a.stop.cancel();
        }
    }

    /// Changes the account's import state with `f`, then pushes the status to its tabs if it
    /// changed.
    fn update<T>(&self, app: &App, account: i64, f: impl FnOnce(&mut Account) -> T) -> T {
        let (out, push) = self.with(|all| {
            let a = all.entry(account).or_default();
            let out = f(a);
            let now = a.status();
            let push = (now != a.pushed).then(|| {
                a.pushed = now.clone();
                now
            });
            (out, push)
        });
        if let Some(s) = push {
            app.hub().publish(account, Push::Status(s));
        }
        out
    }
}

/// Imports into the account's mirror the repos that `joined` the synced set and those whose
/// import a restart cut short (`resumed`): now, or after the round running, if any, all in one
/// round, so they go through the phases together. A resumed repo the running round already
/// imports, or one waiting out a failure, isn't asked for again; a repo that joined is, since
/// it joined afresh (unsynced meanwhile, what the round wrote of it is gone).
pub fn request(app: &App, account: i64, joined: Vec<i64>, resumed: Vec<i64>) {
    let start = app.imports().update(app, account, |a| {
        for id in &joined {
            a.failed.remove(id);
        }
        let resumed = resumed
            .into_iter()
            .filter(|r| !a.current.contains(r) && !a.failed.contains_key(r));
        a.pending.extend(joined.into_iter().chain(resumed));
        if a.pending.is_empty() {
            return None;
        }
        if a.running {
            a.wake.notify_one();
            return None;
        }
        a.running = true;
        // Importing from now on, before the job's first phase begins.
        a.round = Some(Round {
            phase: ImportPhase::OpenIssues,
            done: 0,
            of: a.pending.len(),
        });
        Some(a.stop.clone())
    });
    if let Some(stop) = start {
        app.spawn(move |app| async move {
            tokio::select! {
                () = stop.cancelled() => {}
                () = job(app, account, stop.clone()) => {}
            }
        });
    }
}

/// What the job does next.
enum Next {
    /// Run a round over these repos.
    Round(Vec<i64>),
    /// Wait for a failed repo's next try (or for more repos), then look again.
    Wait(Instant, Arc<Notify>),
    Done,
}

/// Runs rounds of the import for the account until none is waiting, a failed repo's included,
/// or `stop` (the account lost access). Every change to the account's state checks `stop` under
/// the lock first, so once [`Imports::stop`] has forgotten the account, this job leaves alone
/// whatever a later request starts for it.
async fn job(app: App, account: i64, stop: tokio_util::sync::CancellationToken) {
    loop {
        let next = app.imports().update(&app, account, |a| {
            if stop.is_cancelled() {
                return Next::Done;
            }
            let now = crate::now();
            let due: Vec<i64> = a
                .failed
                .iter()
                .filter(|(_, f)| f.retry_at <= now)
                .map(|(id, _)| *id)
                .collect();
            a.pending.extend(due);
            a.current = std::mem::take(&mut a.pending);
            if !a.current.is_empty() {
                a.round = Some(Round {
                    phase: ImportPhase::OpenIssues,
                    done: 0,
                    of: a.current.len(),
                });
                return Next::Round(a.current.iter().copied().collect());
            }
            a.round = None;
            a.waits.clear();
            match a.next_retry() {
                Some(at) => {
                    let wait = Duration::from_secs((at - now).max(0) as u64);
                    Next::Wait(Instant::now() + wait, a.wake.clone())
                }
                None => {
                    a.running = false;
                    Next::Done
                }
            }
        });
        let ids = match next {
            Next::Round(ids) => ids,
            Next::Wait(at, wake) => {
                let _ = tokio::time::timeout_at(at.into(), wake.notified()).await;
                continue;
            }
            Next::Done => return,
        };
        // Its own task: a panic ends this round, not the account's imports. A job, so the drain
        // stops it between two pages; the next start resumes the import.
        let round_stop = stop.clone();
        let run = app.spawn(move |app| async move {
            tokio::select! {
                () = round_stop.cancelled() => Ok(Outcome::default()),
                r = paging::round(app, account, ids) => r,
            }
        });
        let outcome = match run.await {
            Ok(None) => return,
            Ok(Some(Ok(o))) => o,
            Ok(Some(Err(e))) => {
                eprintln!("import: account {account}: {e}");
                Outcome::default()
            }
            Err(e) => {
                eprintln!("import: account {account} panicked: {e}");
                Outcome::default()
            }
        };
        app.imports().update(&app, account, |a| {
            if stop.is_cancelled() {
                return;
            }
            // A repo of the round is done, failed again, or no longer to import (unsynced, or
            // picked again: then it's pending).
            for id in std::mem::take(&mut a.current) {
                match outcome.failed.get(&id) {
                    Some(f) => {
                        a.failed.insert(id, f.clone());
                    }
                    None => {
                        a.failed.remove(&id);
                    }
                }
            }
            a.waits.clear();
        });
    }
}

/// How a round ended: the repos whose import failed, and when each is tried again.
#[derive(Default)]
pub(super) struct Outcome {
    failed: HashMap<i64, Failed>,
}

/// How long after `failures` failures in a row a repo's import is tried again: `first`,
/// doubling, up to six hours.
fn retry_after(first: Duration, failures: i64) -> Duration {
    const MOST: Duration = Duration::from_secs(6 * 60 * 60);
    let doublings = failures.clamp(0, 20) as u32;
    first
        .saturating_mul(2u32.saturating_pow(doublings))
        .min(MOST)
}

/// Opening an issue during the import, before phase 3 reached it: its comments are fetched now
/// (REST, with the installation token), waiting up to [`ON_DEMAND_WAIT`]. Outside an import, or
/// when the mirror holds every comment, it does nothing; a failure leaves the detail with what
/// the mirror has.
pub async fn comments_on_demand(app: &App, account: i64, item: i64) {
    if !app.imports().running(account) {
        return;
    }
    let held = app
        .mirrors()
        .read(account, Caller::Request, move |c| q::comments_held(c, item))
        .await;
    let Ok(Some(h)) = held else { return };
    let Some(installation) = h.installation_id else {
        return;
    };
    if h.held >= h.comments_count {
        return;
    }
    let fetch = async {
        let gh = app.github();
        let mut all = Vec::new();
        for page in 1.. {
            let token = app
                .installations()
                .token(installation, Scope::Import)
                .await?;
            let path = format!(
                "/repos/{}/{}/issues/{}/comments?per_page=100&page={page}",
                h.owner, h.name, h.number
            );
            let got = gh.rest(&token, &path).await?;
            let items: Vec<RestComment> =
                serde_json::from_value(got).map_err(|e| CallError::Malformed(e.to_string()))?;
            let n = items.len();
            all.extend(items.into_iter().map(|c| CommentData::from_rest(item, c)));
            if n < PAGE {
                break;
            }
        }
        Ok::<_, CallError>(all)
    };
    let comments = match tokio::time::timeout(ON_DEMAND_WAIT, fetch).await {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => {
            eprintln!("import: account {account}: comments of {item} on demand: {e}");
            return;
        }
        Err(_) => return,
    };
    let repo = h.repo_id;
    let written = write_synced(app, account, Caller::Request, repo, move |tx, seq| {
        write_comments(tx, seq, &comments)
    })
    .await;
    match written {
        Ok(ids) => publish(app, account, ids),
        Err(e) => eprintln!("import: account {account}: writing comments of {item}: {e}"),
    }
}

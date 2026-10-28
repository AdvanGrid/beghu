//! Reconciliation: the mirror heals itself when webhooks are lost, and the status slot says when
//! sync is degraded (spec #86, "Webhooks, reconciliation and fan-out"; the scheme is
//! docs/research/mirror-import-and-reconciliation.md §4).
//!
//! - **Redelivery** (`redeliver.rs`): once the server listens (#86: listen, resume deliveries,
//!   then redeliver), and then every [`ReconcileConfig::redeliver_every`], the App's delivery log
//!   is read back to where each installation was last checked, or to its oldest delivery still
//!   outstanding. Any GUID with no OK attempt that never reached beghu is redelivered, and stays
//!   outstanding until a later run sees it arrive, so a failed redelivery is asked for again. At
//!   most [`ReconcileConfig::redeliver_cap`] a run; GitHub's rate limit is waited out. An
//!   installation whose oldest such delivery is older than [`ReconcileConfig::outage_after`]
//!   (2.5 days, inside GitHub's 3-day log), or that hasn't been checked for that long, or that
//!   missed more than the cap, gets a full sweep of its repos instead; so does one with no
//!   checkpoint at all at startup.
//! - **Sweeps** (`sweep/`, scheduled by `schedule.rs`), per repo, with the installation's token, fanned out to every active
//!   account syncing the repo. A repo no active account syncs gets none. A sweep pauses while the
//!   installation's quota for what it reads is below a fifth (webhook follow-ups never do), and
//!   leaves alone what a webhook wrote after it began reading:
//!   - every [`ReconcileConfig::probe_every`]: a `since` probe of the issues and PRs, and one of
//!     the comments, each conditional on the ETag of its last answer, so an unchanged list is a
//!     free 304;
//!   - every [`ReconcileConfig::count_every`], for every repo: a count check, with an id sweep on
//!     a new mismatch, and a sub-issue order sweep over the parents (reorders send no webhook).
//!     Neither skips a repo that looks idle: beghu's own writes can't show what GitHub changed
//!     without a webhook, and both cost about a GraphQL point per 100 repos or parents;
//!   - a full sweep with diff: nightly per installation (at a time of day of its own), on the
//!     outage trigger, at startup without a checkpoint, as an account's repair, and on the
//!     connected account's Resync (at most once per [`ReconcileConfig::resync_every`], kept in the control DB). At most
//!     [`ReconcileConfig::full_sweeps_at_once`] run at once. What it removes comes only from
//!     GitHub's cursor-paged id lists (or a comment's 404), and is never recorded as deleted.
//!     An installation's sweep of every repo (nightly, outage, startup) is checkpointed only
//!     once each repo's has got through: a repo whose sweep failed is swept again after
//!     [`ReconcileConfig::failure_backoff`], doubling. The next night asks for every repo
//!     again all the same, so one that keeps failing holds no other back.
//! - **Sync degraded**: an account shows "sync degraded · Resync" while it's marked
//!   `needs_resync` (a webhook's change is known to be missing from its mirror), and once a sweep
//!   has repaired a change the webhooks missed in one of its repos (one GitHub made more than
//!   [`ReconcileConfig::webhook_grace`] earlier; for a relationship added or removed, or a label
//!   changed, which carry no time, one no delivery stamped within that grace; never a sub-issue
//!   reorder), until a later
//!   full sweep of that repo repairs nothing for it, or its Resync ends (`status.rs`). A marked
//!   account's repair (a full sweep of its repos, `resync.rs`) runs
//!   [`ReconcileConfig::repair_after`] after the first mark; the mark is cleared only once every
//!   repo has been swept and no mark came meanwhile, so a repair cut short by a restart is still
//!   owed. A repo whose full sweep fails is repaired again only after
//!   [`ReconcileConfig::failure_backoff`], doubling. While a Resync or a repair runs, it shows
//!   "resyncing…".
//! - **The events-feed poller** (`feed.rs`): every [`ReconcileConfig::feed_every`], each synced
//!   repo's issue events feed, while an account syncing it has a live stream (the 5-minute probe
//!   reads it for the others), for what no webhook says: a PR linked to an issue in GitHub's
//!   Development sidebar, and a backup for dropped `sub_issues` deliveries.
//! - Opening an issue with sub-issues reads their order back from GitHub, at most every 30 s per
//!   parent: a reorder made outside beghu sends nothing.
//!
//! Redelivery, the scheduler and each installation's sweeps are jobs (`jobs.rs`): the drain stops
//! them at their next await. Each saves a cursor (a probe's `since`, redelivery's checkpoint, an
//! installation's full-sweep checkpoint) only once what it covers is written, so a stop between
//! the two only reads it again. A write the drain's seal refuses ends the job without counting
//! as a failure (no mark, no backoff). What they'd have repaired waits for the next start, whose
//! redelivery, marks and sweeps find it again.

mod feed;
mod redeliver;
mod resync;
mod schedule;
mod status;
mod sweep;

pub use resync::resync;
pub use status::{SyncStatus, status};
pub(crate) use sweep::SECONDARY_WAIT;

use crate::App;
use crate::config::ReconcileConfig;
use crate::github::Quota;
use crate::live::Push;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use sweep::{Sweeper, Target};

/// Why a reconciliation step failed.
#[derive(Debug)]
pub(crate) enum Error {
    /// The control DB or a mirror failed.
    Db(control_db::Error),
    /// GitHub refused or failed a call made with the App's JWT.
    GitHub(crate::github::Error),
    /// GitHub refused or failed a sweep's call.
    Call(crate::github::CallError),
    /// GitHub answered something the sweep can't read.
    Malformed(String),
    /// GitHub has no such repo for the installation (deleted, transferred, or out of its sight).
    NoRepo(String),
}

impl Error {
    /// The drain sealed the databases (`dbrt::Error::Sealed`): not a failure, but the end of the
    /// job that met it. Nothing is marked, retried or backed off for it; the next start's
    /// redelivery and sweeps pick up what it left.
    pub(crate) fn sealed(&self) -> bool {
        matches!(self, Error::Db(control_db::Error::Sealed))
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Db(e) => write!(f, "database: {e}"),
            Error::GitHub(e) => write!(f, "{e}"),
            Error::Call(e) => write!(f, "{e}"),
            Error::Malformed(e) => write!(f, "unreadable answer: {e}"),
            Error::NoRepo(r) => write!(f, "{r}: no such repo"),
        }
    }
}

impl From<control_db::Error> for Error {
    fn from(e: control_db::Error) -> Self {
        Error::Db(e)
    }
}

impl From<crate::github::Error> for Error {
    fn from(e: crate::github::Error) -> Self {
        Error::GitHub(e)
    }
}

impl From<crate::github::CallError> for Error {
    fn from(e: crate::github::CallError) -> Self {
        Error::Call(e)
    }
}

/// How often one parent's sub-issue order is read back when it's opened.
const OPENED_EVERY: Duration = Duration::from_secs(30);

/// Reconciliation's state: what each repo's sweeps last did, the full sweeps asked for, each
/// installation's quota, and each account's sync.
pub struct Reconcile {
    cfg: ReconcileConfig,
    state: Mutex<State>,
    wake: tokio::sync::Notify,
    /// How many full sweeps may run at once, across installations.
    full_slots: tokio::sync::Semaphore,
    /// What the events-feed poller keeps of each repo's feed.
    feed: feed::Feed,
    /// Each installation's quota, as last seen; shared with the read-backs (`edges.rs`).
    budgets: Arc<Budgets>,
}

/// Each installation's [`Budget`], shared by every background reader: sweeps, probes, the
/// events-feed poller and the read-backs.
#[derive(Default)]
pub(crate) struct Budgets(Mutex<HashMap<i64, Budget>>);

impl Budgets {
    fn with<T>(&self, f: impl FnOnce(&mut HashMap<i64, Budget>) -> T) -> T {
        f(&mut self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }

    pub(crate) fn get(&self, installation: i64) -> Budget {
        self.with(|b| b.get(&installation).copied().unwrap_or_default())
    }

    pub(crate) fn set(&self, installation: i64, f: impl FnOnce(&mut Budget)) {
        self.with(|b| f(b.entry(installation).or_default()));
    }

    /// GitHub asked `installation` to wait `wait` (a rate limit, primary or secondary): every
    /// background reader of it holds off until then.
    pub(crate) fn pause(&self, installation: i64, wait: std::time::Duration) {
        let until = Instant::now() + wait;
        self.set(installation, |b| {
            if b.paused_until.is_none_or(|u| u < until) {
                eprintln!(
                    "reconcile: installation {installation}: rate limited; background reads wait {wait:?}"
                );
                b.paused_until = Some(until);
            }
        });
    }

    fn retain(&self, keep: impl Fn(i64) -> bool) {
        self.with(|b| b.retain(|i, _| keep(*i)));
    }
}

#[derive(Default)]
struct State {
    /// When each repo was last probed and counted, in this process.
    repos: HashMap<i64, Clock>,
    /// Full sweeps asked for and not yet begun, by repo: the accounts whose resync waits on each.
    full: HashMap<i64, BTreeSet<i64>>,
    /// Installations whose every repo's full sweep was asked for at once (nightly, outage,
    /// startup). A repo whose sweep failed keeps it pending, and is swept again after its
    /// backoff.
    whole: HashMap<i64, Whole>,
    /// Installations with a sweep job running.
    busy: HashSet<i64>,
    accounts: HashMap<i64, AccountSync>,
    /// Repos whose last full sweeps failed: how many in a row, and when a repair may try again.
    failing: HashMap<i64, Failing>,
    /// When each parent's order was last read back on opening.
    opened: HashMap<i64, Instant>,
    /// Changes sweeps made, carrying no time, whose webhooks may still be on the way.
    suspects: Vec<Suspect>,
    /// By repo, the labels a mirror held that its last full sweep's list (of more than a page)
    /// didn't have: one is removed only once two lists in a row lack it.
    unlisted_labels: HashMap<i64, HashSet<i64>>,
    /// The repos sweeps read, and when they were read.
    targets: Option<(Instant, Arc<Targets>)>,
    /// When the repos synced last changed: a read of the targets begun before is stale.
    targets_changed: Option<Instant>,
}

/// The repos sweeps read, by installation.
pub(crate) type Targets = BTreeMap<i64, Vec<Target>>;

#[derive(Default, Clone, Copy)]
struct Clock {
    probed: Option<Instant>,
    counted: Option<Instant>,
    /// The counts that differed at its last id sweep.
    id_swept: Option<sweep::Counts>,
}

/// Changes a sweep made in `account`'s mirror of `repo`, in transaction `seq`, that carry no time
/// of their own: missed by the webhooks unless a delivery stamps one of what they touched before
/// `due`.
struct Suspect {
    account: i64,
    repo: i64,
    seq: i64,
    touched: Touched,
    due: Instant,
}

/// What a sweep's untimed changes touched.
pub(crate) enum Touched {
    /// The ends of relationships added or removed: a delivery (or its read-back) stamps them.
    Ends(Vec<i64>),
    /// Labels renamed, added or deleted: a `label` delivery rewrites (or deletes) them.
    Labels(Vec<i64>),
}

/// An installation's sweep of every repo, pending.
#[derive(Clone, Copy)]
struct Whole {
    /// When the first ask still pending came: its checkpoint once every repo is done.
    at: i64,
    /// When every repo was last asked for: the next night's ask counts from it.
    asked: i64,
}

#[derive(Clone, Copy)]
struct Failing {
    times: u32,
    until: Instant,
}

#[derive(Default)]
struct AccountSync {
    /// The repos whose full sweep the account's resync (or repair) waits for now.
    waiting: BTreeSet<i64>,
    /// The repair (or Resync) under way, until every repo of it has been swept.
    repair: Option<Repair>,
    /// The resync is the connected account's Resync: once it ends, sync is healthy.
    asked: bool,
    /// A Resync is being started: a second ask meanwhile is the same one.
    starting: bool,
    /// The repos where a sweep repaired changes the webhooks missed, since the last full sweep
    /// of each that repaired nothing.
    dirty: BTreeSet<i64>,
}

impl AccountSync {
    /// Nothing about the account worth keeping.
    fn idle(&self) -> bool {
        self.waiting.is_empty()
            && self.repair.is_none()
            && !self.asked
            && !self.starting
            && self.dirty.is_empty()
    }
}

/// A repair of an account's repos: the full sweeps it still needs, and how many times the
/// account had been marked when it began. The mark is cleared once every repo has been swept,
/// unless a mark came since.
struct Repair {
    marks: i64,
    left: BTreeSet<i64>,
}

/// How a full sweep ended.
#[derive(Clone, Copy, PartialEq)]
enum Outcome {
    /// It got through.
    Done,
    /// GitHub (or a mirror) failed it.
    Failed,
    /// The drain's seal cut it short: what it owed waits for the next start.
    Cut,
}

/// An installation's primary rate limits, as GitHub last stated them.
#[derive(Default, Clone, Copy)]
pub(crate) struct Budget {
    pub core: Option<Quota>,
    pub graphql: Option<Quota>,
    /// When `/rate_limit` was last asked.
    pub read: Option<Instant>,
    /// Until when GitHub asked the installation to wait (a rate limit's answer): sweeps, probes
    /// and the events-feed poller all hold off until then.
    pub paused_until: Option<Instant>,
}

impl Budget {
    /// How long GitHub still asks the installation to wait, if at all.
    pub fn paused(&self) -> Option<std::time::Duration> {
        self.paused_until
            .and_then(|u| u.checked_duration_since(Instant::now()))
            .filter(|d| !d.is_zero())
    }

    /// Whether background reads (sweeps, probes, the poller) hold off now: GitHub asked the
    /// installation to wait, or its core quota is below a fifth until its reset.
    pub fn holds_off_core(&self) -> bool {
        self.paused().is_some() || self.core.is_some_and(|q| q.low() && q.reset > crate::now())
    }
}

impl Reconcile {
    pub fn new(cfg: ReconcileConfig, budgets: Arc<Budgets>) -> Reconcile {
        Reconcile {
            budgets,
            full_slots: tokio::sync::Semaphore::new(cfg.full_sweeps_at_once.max(1)),
            cfg,
            state: Mutex::default(),
            wake: tokio::sync::Notify::new(),
            feed: feed::Feed::default(),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        f(&mut self.state.lock().unwrap_or_else(|e| e.into_inner()))
    }

    pub(crate) fn cfg(&self) -> &ReconcileConfig {
        &self.cfg
    }

    /// The repos synced changed (a pick, an import's end): sweeps read the targets again.
    pub(crate) fn repos_changed(&self) {
        self.with(|s| {
            s.targets = None;
            s.targets_changed = Some(Instant::now());
        });
    }

    pub(crate) fn budget(&self, installation: i64) -> Budget {
        self.budgets.get(installation)
    }

    pub(crate) fn set_budget(&self, installation: i64, f: impl FnOnce(&mut Budget)) {
        self.budgets.set(installation, f);
    }

    /// GitHub asked `installation` to wait `wait`: see [`Budgets::pause`].
    pub(crate) fn pause(&self, installation: i64, wait: std::time::Duration) {
        self.budgets.pause(installation, wait);
    }

    /// The account lost access and its mirror is deleted: nothing of its sync is left to repair
    /// or to say, and the import after it signs in again reads everything afresh.
    pub(crate) fn forget(&self, account: i64) {
        self.with(|s| {
            s.accounts.remove(&account);
            s.suspects.retain(|x| x.account != account);
        });
    }

    /// A sweep of `repo` repaired a change the webhooks missed in `account`'s mirror.
    pub(crate) fn missed(&self, app: &App, account: i64, repo: i64) {
        let first = self.with(|s| {
            let a = s.accounts.entry(account).or_default();
            a.dirty.insert(repo) && a.dirty.len() == 1
        });
        if first {
            eprintln!("reconcile: account {account}: a sweep repaired changes the webhooks missed");
            app.hub().publish(account, Push::Sync);
        }
    }

    /// A sweep made changes that `touched` this in `account`'s mirror of `repo`, in transaction
    /// `seq`. Relationship and label changes carry no time, so whether their webhooks were missed
    /// is settled once [`ReconcileConfig::webhook_grace`] has passed ([`settle`]): by then a
    /// delivery on its way has stamped what they touched. With no grace, it's a miss now: true.
    pub(crate) fn suspect(
        &self,
        app: &App,
        account: i64,
        repo: i64,
        seq: i64,
        touched: Touched,
    ) -> bool {
        let grace = self.cfg.webhook_grace;
        if grace.is_zero() {
            self.missed(app, account, repo);
            return true;
        }
        self.with(|s| {
            s.suspects.push(Suspect {
                account,
                repo,
                seq,
                touched,
                due: Instant::now() + grace,
            })
        });
        false
    }

    /// A full sweep of `repo` repaired nothing for `account`.
    fn clean(&self, app: &App, account: i64, repo: i64) {
        let healthy = self.with(|s| {
            s.accounts
                .get_mut(&account)
                .is_some_and(|a| a.dirty.remove(&repo) && a.dirty.is_empty())
        });
        if healthy {
            app.hub().publish(account, Push::Sync);
        }
    }

    /// Asks for a full sweep of `repos`; with `account`, its resync waits for them.
    fn ask_full(&self, repos: &[i64], account: Option<i64>) {
        self.with(|s| {
            for r in repos {
                let by = s.full.entry(*r).or_default();
                if let Some(a) = account {
                    by.insert(a);
                    s.accounts.entry(a).or_default().waiting.insert(*r);
                }
            }
        });
        self.wake.notify_one();
    }

    /// Asks for a full sweep of every repo of `installation`, at `at`. One still pending from an
    /// earlier ask keeps that one's time as its checkpoint.
    fn ask_installation(&self, installation: i64, repos: &[i64], at: i64) {
        self.with(|s| {
            s.whole
                .entry(installation)
                .and_modify(|w| w.asked = at)
                .or_insert(Whole { at, asked: at });
        });
        self.ask_full(repos, None);
    }

    /// The full sweep of `repo` is starting: who waits on it.
    fn take_full(&self, repo: i64) -> Option<BTreeSet<i64>> {
        self.with(|s| s.full.remove(&repo))
    }

    /// The full sweep of `repo` ended. Each waiting account whose resync is now over gets its
    /// status pushed; one whose repair has swept every repo has its mark cleared (unless a mark
    /// came since), and the connected account's Resync leaves sync healthy. A repo that failed isn't tried by a
    /// repair again until a backoff has passed: [`ReconcileConfig::failure_backoff`], doubling
    /// with each failure in a row, at most a day.
    async fn done_full(&self, app: &App, repo: i64, by: BTreeSet<i64>, outcome: Outcome) {
        let base = self.cfg.failure_backoff;
        let mut cleared = Vec::new();
        self.with(|s| {
            match outcome {
                Outcome::Done => {
                    s.failing.remove(&repo);
                }
                Outcome::Failed => {
                    let times = s.failing.get(&repo).map_or(0, |f| f.times) + 1;
                    let wait = base
                        .saturating_mul(1 << (times - 1).min(16))
                        .min(Duration::from_secs(24 * 3600));
                    s.failing.insert(
                        repo,
                        Failing {
                            times,
                            until: Instant::now() + wait,
                        },
                    );
                }
                Outcome::Cut => {}
            }
            for a in &by {
                let acc = s.accounts.entry(*a).or_default();
                acc.waiting.remove(&repo);
                if outcome == Outcome::Done
                    && let Some(r) = acc.repair.as_mut()
                {
                    r.left.remove(&repo);
                }
                if !acc.waiting.is_empty() {
                    continue;
                }
                if acc.repair.as_ref().is_some_and(|r| r.left.is_empty()) {
                    if let Some(r) = acc.repair.take() {
                        cleared.push((*a, r.marks));
                    }
                    if acc.asked {
                        acc.dirty.clear();
                        s.suspects.retain(|x| x.account != *a);
                    }
                }
                acc.asked = false;
            }
        });
        for (a, marks) in cleared {
            match app
                .control()
                .write(move |tx| control_db::q::clear_needs_resync(tx, a, marks))
                .await
            {
                Ok(_) => eprintln!("reconcile: account {a}: resync done"),
                Err(e) => eprintln!("reconcile: account {a}: clearing its mark: {e}"),
            }
        }
        for a in by {
            app.hub().publish(a, Push::Sync);
        }
    }

    /// Of `repos`, those a repair may sweep now: not failing, or past their backoff.
    fn repairable(&self, repos: &BTreeSet<i64>) -> Vec<i64> {
        let now = Instant::now();
        self.with(|s| {
            repos
                .iter()
                .filter(|r| s.failing.get(r).is_none_or(|f| f.until <= now))
                .copied()
                .collect()
        })
    }
}

/// Opening issue `id`: if it has sub-issues, their order is read back from GitHub (at most every
/// 30 s per parent), since a reorder made outside beghu sends nothing.
pub async fn opened(app: &App, account: i64, id: i64) {
    let due = app.reconcile().with(|s| {
        let now = Instant::now();
        s.opened
            .retain(|_, t| now.duration_since(*t) < OPENED_EVERY);
        if s.opened.contains_key(&id) {
            return false;
        }
        s.opened.insert(id, now);
        true
    });
    if !due {
        return;
    }
    let info = app
        .mirrors()
        .read(account, mirror_db::Caller::Request, move |c| {
            mirror_db::q::item_sweep_info(c, id)
        })
        .await;
    let Ok(Some(info)) = info else { return };
    let Some(installation) = info.installation_id else {
        return;
    };
    if !info.parent {
        return;
    }
    // Its answer lands on its own; nothing waits for it here.
    drop(app.edges().schedule(
        crate::edges::Subject {
            id,
            node_id: info.node_id,
            number: info.number,
            repo: info.repo_id,
            installation,
        },
        crate::edges::ReadBack::Edges(crate::edges::Kind::Sub),
        true,
    ));
}

/// Starts reconciliation, once the server listens and the deliveries acked but not processed
/// are resumed (`Opened::start`): the redelivery job (its first run covers the downtime), the
/// sweeps' scheduler and the events-feed poller. All are jobs, spawned and not awaited: the drain stops them, and the
/// sweeps they start, at their next await.
pub fn start(app: &App) {
    app.spawn(redeliver::job);
    app.spawn(schedule::schedule);
    app.spawn(feed::poller);
}

/// The repos sweeps read, by installation: every repo an active account syncs, as the mirrors of
/// the accounts syncing it know it (through an installation, and not importing), with the
/// accounts whose mirrors hold it so. Read again at
/// most every [`ReconcileConfig::probe_every`], or when the repos synced change
/// ([`Reconcile::repos_changed`]).
pub(crate) async fn targets(app: &App) -> Result<Arc<Targets>, Error> {
    let r = app.reconcile();
    let fresh = r.cfg.probe_every;
    if let Some((_, t)) = r.with(|s| s.targets.clone().filter(|(at, _)| at.elapsed() < fresh)) {
        return Ok(t);
    }
    let read = Instant::now();
    let rows = app.control().read(control_db::q::swept_repos).await?;
    let mut accounts_of: BTreeMap<i64, Vec<i64>> = BTreeMap::new();
    for r in rows {
        accounts_of
            .entry(r.repo_id)
            .or_default()
            .push(r.github_user_id);
    }
    let accounts: BTreeSet<i64> = accounts_of.values().flatten().copied().collect();
    let mut known: HashMap<i64, mirror_db::q::SweepReposRow> = HashMap::new();
    // What each account's mirror holds as sweeps read it (not importing, say).
    let mut swept: HashSet<(i64, i64)> = HashSet::new();
    for account in accounts {
        match app
            .mirrors()
            .read(account, mirror_db::Caller::Sweep, |c| {
                mirror_db::q::sweep_repos(c)
            })
            .await
        {
            Ok(rows) => {
                for r in rows {
                    swept.insert((account, r.id));
                    known.entry(r.id).or_insert(r);
                }
            }
            Err(e) => eprintln!("reconcile: reading account {account}'s repos: {e}"),
        }
    }
    let mut out: Targets = BTreeMap::new();
    for (repo, mut accounts) in accounts_of {
        let Some(r) = known.remove(&repo) else {
            continue;
        };
        accounts.retain(|a| swept.contains(&(*a, repo)));
        out.entry(r.installation_id).or_default().push(Target {
            id: r.id,
            node_id: r.node_id,
            owner: r.owner,
            name: r.name,
            accounts,
        });
    }
    let out = Arc::new(out);
    r.with(|s| {
        // Unless the repos changed while this read.
        if s.targets_changed.is_none_or(|c| c < read) {
            s.targets = Some((read, out.clone()));
        }
    });
    Ok(out)
}

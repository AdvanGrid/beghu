//! Every account's mirror, opened on first use behind its gate, with one writer lane and up to
//! two readers each, all within one process-wide connection budget.

use crate::gate::{self, Caller, Effect, Event, Gate, Refusal};
use crate::migrations::{self, MigError, Migration};
use crate::pool::{Budget, Check, Lane, LaneKey, Patience, Shared};
use crate::{AccountId, Error, Unavailable};
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, oneshot};
use tokio::time::Instant;

#[derive(Debug, Clone)]
pub struct Config {
    pub budget: Budget,
    pub readers_per_account: usize,
    pub gate: gate::Config,
    /// The indexes `pool::sample` analyzes in full when a writer closes: the schema's, not a
    /// setting.
    pub sampled_indexes: &'static [&'static str],
}

impl Default for Config {
    fn default() -> Self {
        Config {
            budget: Budget::default(),
            readers_per_account: 2,
            gate: gate::Config::default(),
            sampled_indexes: &[],
        }
    }
}

impl Config {
    /// The defaults, with the mirror connection cap from `BEGHU_MIRROR_CONNECTIONS` if set.
    pub fn from_env() -> Result<Config, String> {
        let mut cfg = Config::default();
        if let Ok(v) = std::env::var("BEGHU_MIRROR_CONNECTIONS") {
            cfg.budget.max = v.parse().ok().filter(|n| *n > 0).ok_or_else(|| {
                format!("BEGHU_MIRROR_CONNECTIONS must be a positive integer, got {v:?}")
            })?;
        }
        Ok(cfg)
    }
}

/// Something an account's status slot, or its import, should hear about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notice {
    Status {
        account: AccountId,
        status: Option<gate::Status>,
    },
    /// An empty mirror was created (no file, or a `.rebuild.sql` migration): import it.
    NeedsImport { account: AccountId, why: String },
}

#[derive(Clone)]
pub struct Mirrors {
    inner: Arc<Inner>,
}

struct Inner {
    dir: PathBuf,
    migs: &'static [Migration],
    cfg: Config,
    shared: Arc<Shared>,
    start: Instant,
    accounts: Mutex<HashMap<AccountId, Arc<Account>>>,
    notices: broadcast::Sender<Notice>,
}

struct Account {
    id: AccountId,
    path: PathBuf,
    lane: Lane,
    gate: Mutex<Shell>,
}

/// The gate and the waiters it's holding.
struct Shell {
    gate: Gate,
    next_id: u64,
    waiters: HashMap<u64, oneshot::Sender<Result<Answer, Refusal>>>,
    timer: Option<tokio::task::JoinHandle<()>>,
    /// The checks of the conditional deletes pending ([`Mirrors::delete_if`]), by waiter, run
    /// once the delete starts.
    checks: Vec<(u64, Check)>,
    /// A plain delete is pending too: the file goes whatever the checks would say.
    unconditional: bool,
    /// The conditional deletes a plain one overruled: each hears [`Decision::Overruled`], not
    /// that its check deleted the file.
    overruled: HashSet<u64>,
}

/// What [`Mirrors::delete_if`] did with a mirror.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// The check said to go ahead, and the file was deleted.
    Deleted,
    /// The check said to keep the file: nothing was deleted.
    Kept,
    /// A plain delete ([`Mirrors::delete`]) asked meanwhile deleted the file, whatever the check
    /// said, or before it ran.
    Overruled,
}

/// What [`Mirrors::catch_up`] did with a mirror.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatchUp {
    /// The mirror is at the build's version: it was, or it migrated in place.
    Ready,
    /// There's no file, or a `.rebuild.sql` migration would replace it with an empty one: that's
    /// left for the account's first use, and nothing was created.
    LeftForFirstUse,
}

/// A deleter's answer when the delete went ahead: done as asked, or, for a conditional one, by a
/// plain delete that overruled its check.
enum Answer {
    Done,
    Overruled,
}

/// The checks of the deletes pending, for the delete starting now, with whose they are: none
/// when a plain delete is among them (the conditional ones are then overruled), each of them
/// otherwise.
fn take_checks(sh: &mut Shell) -> (Vec<u64>, Vec<Check>) {
    let pending = std::mem::take(&mut sh.checks);
    if std::mem::take(&mut sh.unconditional) {
        sh.overruled.extend(pending.into_iter().map(|(id, _)| id));
        (Vec::new(), Vec::new())
    } else {
        pending.into_iter().unzip()
    }
}

/// Why the gate turned a caller away, or that its answer was lost (the job panicked).
enum Turned {
    Away(Refusal),
    Lost,
}

impl Mirrors {
    /// Must be called inside a tokio runtime: it starts the idle-connection reaper.
    pub fn new(dir: impl Into<PathBuf>, migs: &'static [Migration], cfg: Config) -> Mirrors {
        let (notices, _) = broadcast::channel(256);
        let shared = Shared::new(cfg.budget.clone(), cfg.sampled_indexes);
        Mirrors {
            inner: Arc::new(Inner {
                dir: dir.into(),
                migs,
                cfg,
                shared,
                start: Instant::now(),
                accounts: Mutex::default(),
                notices,
            }),
        }
    }

    pub fn path(&self, account: AccountId) -> PathBuf {
        self.inner.dir.join(format!("{account}.db"))
    }

    pub fn notices(&self) -> broadcast::Receiver<Notice> {
        self.inner.notices.subscribe()
    }

    /// Open mirror connections, for one account or in total.
    pub fn open_connections(&self, account: Option<AccountId>) -> usize {
        self.inner.shared.open_connections(account)
    }

    /// Runs `f` on one of the account's read-only connections, once its mirror is ready.
    pub async fn read<T, F>(&self, account: AccountId, caller: Caller, f: F) -> Result<T, Error>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        let acct = self.ready(account, caller).await?;
        acct.lane.read(caller.into(), f).await
    }

    /// Runs `f` on the account's writer, after every write that arrived before it.
    pub async fn write<T, F>(&self, account: AccountId, caller: Caller, f: F) -> Result<T, Error>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        // Refused before the gate, which would otherwise open (or create) a mirror for nothing.
        self.inner.shared.unsealed()?;
        let acct = self.ready(account, caller).await?;
        acct.lane.write(caller.into(), f).await
    }

    /// Deletes the account's mirror (its file, WAL and shared memory), once the open, migration
    /// or creation under way and the reads and write in flight are done. From then on every use
    /// of it is refused with [`Error::Deleted`], so no webhook, import or request brings it back,
    /// until [`Mirrors::revive`]. Refused with [`Error::Sealed`] once the drain has sealed the
    /// mirrors: the file stays, and the startup after it deletes it again.
    ///
    /// The delete is asked for as this is called, before the returned future is first polled:
    /// a [`Mirrors::revive`] that comes after the call, however soon, reopens the mirror once
    /// the delete is done.
    pub fn delete(
        &self,
        account: AccountId,
    ) -> impl Future<Output = Result<(), Error>> + Send + 'static {
        let asked = self.ask_delete(account, None);
        let shared = self.inner.shared.clone();
        async move {
            match asked?.await {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(_)) if shared.is_sealed() => Err(Error::Sealed),
                Ok(Err(why)) => Err(refused(why)),
                Err(_) => Err(Error::Panicked),
            }
        }
    }

    /// [`Mirrors::delete`], if `check` still says so once the delete can start: once the open,
    /// migration or creation under way is done, and while the account's writer and every reader
    /// are held, so no read or write is in flight and none starts until it's decided.
    /// [`Decision::Deleted`] when the check said yes and the file was deleted;
    /// [`Decision::Kept`] when it said to keep it, and the mirror is then used as before (its
    /// next use opens it, as a first use after startup does). Every use is refused with
    /// [`Error::Deleted`] from the call until it's decided, as during any delete. A plain delete
    /// asked meanwhile, before the check or while it runs, wins: the file goes whatever the
    /// check says ([`Decision::Overruled`]). A check that panics keeps the file.
    pub fn delete_if(
        &self,
        account: AccountId,
        check: impl Future<Output = bool> + Send + 'static,
    ) -> impl Future<Output = Result<Decision, Error>> + Send + 'static {
        let asked = self.ask_delete(account, Some(Box::pin(check)));
        let shared = self.inner.shared.clone();
        async move {
            match asked?.await {
                Ok(Ok(Answer::Done)) => Ok(Decision::Deleted),
                Ok(Ok(Answer::Overruled)) => Ok(Decision::Overruled),
                Ok(Err(Refusal::Kept)) => Ok(Decision::Kept),
                Ok(Err(_)) if shared.is_sealed() => Err(Error::Sealed),
                Ok(Err(why)) => Err(refused(why)),
                Err(_) => Err(Error::Panicked),
            }
        }
    }

    /// Asks the account's gate for a delete, now, with `check` if it's conditional.
    fn ask_delete(
        &self,
        account: AccountId,
        check: Option<Check>,
    ) -> Result<oneshot::Receiver<Result<Answer, Refusal>>, Error> {
        self.inner.shared.unsealed()?;
        let acct = self.account(account);
        let mut sh = acct.gate.lock().unwrap();
        let id = sh.next_id;
        sh.next_id += 1;
        let (tx, rx) = oneshot::channel();
        sh.waiters.insert(id, tx);
        match check {
            Some(c) => sh.checks.push((id, c)),
            None => sh.unconditional = true,
        }
        let fx = sh.gate.handle(self.now(), Event::Delete { id });
        self.apply(&acct, &mut sh, fx);
        Ok(rx)
    }

    /// The migration walker's step: brings the account's mirror up to the build's version if an
    /// in-place migration can, as its first use would, but at the walker's pace (it waits for a
    /// place under the connection cap rather than give up). A mirror with no file, or one a
    /// `.rebuild.sql` migration would replace, is left alone for the account's first use. A
    /// mirror whose migration failed, or that is waiting out a backoff, deleted or newer than
    /// the build, is refused as for anyone else: the walker passes it by. A file at the build's
    /// version already is passed by without the gate or a pool connection: reading its header
    /// opens nothing for the account.
    pub async fn catch_up(&self, account: AccountId) -> Result<CatchUp, Error> {
        let (path, migs) = (self.path(account), self.inner.migs);
        let current = tokio::task::spawn_blocking(move || {
            matches!(migrations::file_version(&path), Ok(v) if migrations::plan(v, migs) == migrations::Plan::Current)
        })
        .await
        .unwrap_or(false);
        if current {
            return Ok(CatchUp::Ready);
        }
        match self.use_gate(account, Caller::Walker).await {
            Ok(_) => Ok(CatchUp::Ready),
            Err(Turned::Away(Refusal::LeftForFirstUse)) => Ok(CatchUp::LeftForFirstUse),
            Err(Turned::Away(why)) => Err(refused(why)),
            Err(Turned::Lost) => Err(Error::Panicked),
        }
    }

    /// The account may use its mirror again (it signed in again): its next use creates an
    /// empty mirror and asks for its import. Nothing for a mirror that wasn't deleted.
    pub fn revive(&self, account: AccountId) {
        let acct = self.inner.accounts.lock().unwrap().get(&account).cloned();
        if let Some(acct) = acct {
            self.feed(&acct, Event::Revive);
        }
    }

    /// The drain's last step: seals every mirror, so each write from now on fails with
    /// [`Error::Sealed`] and no mirror is created, then lets each one's write in flight finish,
    /// folds its WAL into its file and closes its idle connections. The mirrors go all at once,
    /// so one kept waiting (a long write in flight, a reader holding its WAL) holds up none of
    /// the others. A mirror with no connection open has no WAL left to fold (closing its last
    /// connection did that). The mirrors that failed, and why.
    pub async fn checkpoint(&self) -> Vec<(AccountId, Error)> {
        self.inner.shared.seal();
        let all: Vec<Arc<Account>> = {
            let map = self.inner.accounts.lock().unwrap();
            map.values().cloned().collect()
        };
        // Dropped with this future, a set aborts its tasks: a checkpoint the caller stops
        // waiting for stops at its next await (one already in SQLite runs to its end).
        let mut set = tokio::task::JoinSet::new();
        let mut accounts = HashMap::new();
        for a in all {
            let id = a.id;
            let task = set.spawn(async move { a.lane.checkpoint().await });
            accounts.insert(task.id(), id);
        }
        let mut failed = Vec::new();
        while let Some(done) = set.join_next_with_id().await {
            let (task, r) = match done {
                Ok((task, r)) => (task, r),
                Err(e) => (e.id(), Err(Error::Panicked)),
            };
            if let Err(e) = r {
                failed.push((accounts[&task], e));
            }
        }
        failed
    }

    fn account(&self, id: AccountId) -> Arc<Account> {
        let mut map = self.inner.accounts.lock().unwrap();
        map.entry(id)
            .or_insert_with(|| {
                let path = self.path(id);
                Arc::new(Account {
                    id,
                    lane: Lane::new(
                        LaneKey::Account(id),
                        path.clone(),
                        self.inner.cfg.readers_per_account,
                        self.inner.shared.clone(),
                    ),
                    path,
                    gate: Mutex::new(Shell {
                        gate: Gate::new(self.inner.migs, self.inner.cfg.gate.clone()),
                        next_id: 1,
                        waiters: HashMap::new(),
                        timer: None,
                        checks: Vec::new(),
                        unconditional: false,
                        overruled: HashSet::new(),
                    }),
                })
            })
            .clone()
    }

    async fn ready(&self, id: AccountId, caller: Caller) -> Result<Arc<Account>, Error> {
        self.use_gate(id, caller).await.map_err(|t| match t {
            Turned::Away(why) => refused(why),
            Turned::Lost => Error::Panicked,
        })
    }

    /// The account, once its gate lets `caller` through.
    async fn use_gate(&self, id: AccountId, caller: Caller) -> Result<Arc<Account>, Turned> {
        let acct = self.account(id);
        let rx = {
            let mut sh = acct.gate.lock().unwrap();
            if sh.gate.is_ready() {
                drop(sh);
                return Ok(acct);
            }
            let wid = sh.next_id;
            sh.next_id += 1;
            let (tx, rx) = oneshot::channel();
            sh.waiters.insert(wid, tx);
            let fx = sh.gate.handle(self.now(), Event::Use { id: wid, caller });
            self.apply(&acct, &mut sh, fx);
            rx
        };
        match rx.await {
            Ok(Ok(_)) => Ok(acct),
            Ok(Err(why)) => Err(Turned::Away(why)),
            Err(_) => Err(Turned::Lost),
        }
    }

    fn now(&self) -> Duration {
        self.inner.start.elapsed()
    }

    fn feed(&self, acct: &Arc<Account>, ev: Event) {
        let mut sh = acct.gate.lock().unwrap();
        let fx = sh.gate.handle(self.now(), ev);
        self.apply(acct, &mut sh, fx);
    }

    /// Runs the gate's effects. Called with the shell locked; slow work goes to blocking tasks
    /// that feed their result back.
    fn apply(&self, acct: &Arc<Account>, sh: &mut Shell, fx: Vec<Effect>) {
        for e in fx {
            match e {
                Effect::Serve { id } => {
                    let answer = if sh.overruled.remove(&id) {
                        Answer::Overruled
                    } else {
                        Answer::Done
                    };
                    if let Some(tx) = sh.waiters.remove(&id) {
                        let _ = tx.send(Ok(answer));
                    }
                }
                Effect::Refuse { id, why } => {
                    sh.overruled.remove(&id);
                    if let Some(tx) = sh.waiters.remove(&id) {
                        let _ = tx.send(Err(why));
                    }
                }
                Effect::Status(status) => {
                    let _ = self.inner.notices.send(Notice::Status {
                        account: acct.id,
                        status,
                    });
                }
                Effect::NeedsImport { why } => {
                    let _ = self.inner.notices.send(Notice::NeedsImport {
                        account: acct.id,
                        why,
                    });
                }
                // Opening and migrating use the account's lane, so they count against the cap
                // and leave their connections for the requests waiting on them. They're queued
                // work: at the cap they wait, and the gate times out the requests behind them.
                Effect::Open => {
                    let a = acct.clone();
                    self.job(acct, async move { Event::Opened(a.version().await) })
                }
                Effect::Migrate { from, to } => {
                    let (a, migs) = (acct.clone(), self.inner.migs);
                    self.job(acct, async move {
                        Event::Migrated(a.migrate(migs, from, to).await)
                    })
                }
                Effect::Delete => {
                    let (a, me) = (acct.clone(), self.clone());
                    let (mut running, mut checks) = take_checks(sh);
                    tokio::spawn(async move {
                        loop {
                            // Its own task, so a check that panics keeps the file rather than
                            // leave the gate deleting for good.
                            let r = tokio::spawn({
                                let (a, checks) = (a.clone(), checks);
                                async move { a.delete(checks).await }
                            })
                            .await
                            .unwrap_or(Ok(false));
                            let mut sh = a.gate.lock().unwrap();
                            let ev = match r {
                                // A plain delete asked while the checks ran wins: delete again,
                                // with none, still holding off every use.
                                Ok(false) if sh.unconditional => {
                                    sh.overruled.extend(running);
                                    (running, checks) = take_checks(&mut sh);
                                    continue;
                                }
                                Ok(true) => Event::Deleted(Ok(())),
                                Ok(false) => Event::Kept,
                                Err(e) => Event::Deleted(Err(e)),
                            };
                            // The deletes asked while this one ran joined it, and hear its
                            // result: their checks never run, so the conditional ones that
                            // hear the file went were overruled.
                            let joined: Vec<u64> = sh.checks.drain(..).map(|(id, _)| id).collect();
                            if matches!(ev, Event::Deleted(Ok(()))) {
                                sh.overruled.extend(joined);
                            }
                            sh.unconditional = false;
                            let fx = sh.gate.handle(me.now(), ev);
                            me.apply(&a, &mut sh, fx);
                            break;
                        }
                    });
                }
                Effect::Create { .. } => {
                    // Nothing of this account's is in use: the gate only creates on first use.
                    self.inner.shared.close_idle(LaneKey::Account(acct.id));
                    let (a, path, migs) = (acct.clone(), acct.path.clone(), self.inner.migs);
                    self.job(acct, async move {
                        let created = a.lane.replace(Patience::Wait, move || {
                            path.parent().map_or(Ok(()), std::fs::create_dir_all)?;
                            migrations::create_fresh(&path, migs)
                        });
                        Event::Created(created.await.map_err(migrations::classify_job))
                    })
                }
            }
        }
        self.schedule(acct, sh);
    }

    fn job(&self, acct: &Arc<Account>, work: impl Future<Output = Event> + Send + 'static) {
        let (me, acct) = (self.clone(), acct.clone());
        tokio::spawn(async move {
            let ev = work.await;
            me.feed(&acct, ev);
        });
    }

    /// Keeps one timer per account for the gate's next deadline.
    fn schedule(&self, acct: &Arc<Account>, sh: &mut Shell) {
        if let Some(t) = sh.timer.take() {
            t.abort();
        }
        if let Some(at) = sh.gate.next_deadline() {
            let (me, acct2) = (self.clone(), acct.clone());
            let when = self.inner.start + at;
            sh.timer = Some(tokio::spawn(async move {
                tokio::time::sleep_until(when).await;
                me.feed(&acct2, Event::Tick);
            }));
        }
    }
}

impl Account {
    /// The file's `user_version` on a lane reader, or `None` when there's no file.
    async fn version(&self) -> Result<Option<u32>, MigError> {
        if !self.path.exists() {
            return Ok(None);
        }
        self.lane
            .read(Patience::Wait, |c| migrations::user_version(c).map(Some))
            .await
    }

    /// Closes every connection to the file and deletes it, with its WAL and shared memory, once
    /// each of `checks` says so (`false`, and nothing is deleted, when one doesn't).
    async fn delete(&self, checks: Vec<Check>) -> Result<bool, String> {
        let path = self.path.clone();
        self.lane
            .remove(checks, move || {
                for p in [
                    path.clone(),
                    PathBuf::from(format!("{}-wal", path.display())),
                    PathBuf::from(format!("{}-shm", path.display())),
                ] {
                    match std::fs::remove_file(&p) {
                        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
                        _ => {}
                    }
                }
                Ok(())
            })
            .await
            .map_err(|e| e.to_string())
    }

    async fn migrate(
        &self,
        migs: &'static [Migration],
        from: u32,
        to: u32,
    ) -> Result<(), MigError> {
        self.lane
            .write(Patience::Wait, move |c| {
                migrations::migrate_in_place(c, migs, from, to)
            })
            .await
    }
}

fn refused(why: Refusal) -> Error {
    match why {
        Refusal::StillUpdating { retry_after } => Error::Unavailable {
            retry_after,
            reason: Unavailable::Updating,
        },
        Refusal::Retrying { error, retry_after } => Error::Unavailable {
            retry_after,
            reason: Unavailable::MigrationRetrying(error),
        },
        Refusal::Failed { error } => Error::MigrationFailed(error),
        Refusal::TooNew { db, build } => Error::TooNew { db, build },
        Refusal::Deleted => Error::Deleted,
        // Neither reaches a read or a write: only the walker is left a mirror for its first use,
        // and only a conditional delete is told the file was kept. Were one to, it would be the
        // mirror not being ready yet.
        Refusal::LeftForFirstUse | Refusal::Kept => Error::Unavailable {
            retry_after: Duration::from_secs(1),
            reason: Unavailable::Updating,
        },
    }
}

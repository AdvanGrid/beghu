//! Every account's mirror, opened on first use behind its gate, with one writer lane and up to
//! two readers each, all within one process-wide connection budget.

use crate::gate::{self, Caller, Effect, Event, Gate, Refusal};
use crate::migrations::{self, MigError, Migration};
use crate::pool::{Budget, ConnKind, Lane, LaneKey, Patience, Shared, Slot};
use crate::{AccountId, Error, Unavailable};
use rusqlite::Connection;
use std::collections::HashMap;
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
}

impl Default for Config {
    fn default() -> Self {
        Config {
            budget: Budget::default(),
            readers_per_account: 2,
            gate: gate::Config::default(),
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
    waiters: HashMap<u64, oneshot::Sender<Result<(), Refusal>>>,
    timer: Option<tokio::task::JoinHandle<()>>,
}

impl Mirrors {
    /// Must be called inside a tokio runtime: it starts the idle-connection reaper.
    pub fn new(dir: impl Into<PathBuf>, migs: &'static [Migration], cfg: Config) -> Mirrors {
        let (notices, _) = broadcast::channel(256);
        let shared = Shared::new(cfg.budget.clone());
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
        let acct = self.ready(account, caller).await?;
        acct.lane.write(caller.into(), f).await
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
                    }),
                })
            })
            .clone()
    }

    async fn ready(&self, id: AccountId, caller: Caller) -> Result<Arc<Account>, Error> {
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
            Ok(Ok(())) => Ok(acct),
            Ok(Err(why)) => Err(refused(why)),
            Err(_) => Err(Error::Panicked),
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
                    if let Some(tx) = sh.waiters.remove(&id) {
                        let _ = tx.send(Ok(()));
                    }
                }
                Effect::Refuse { id, why } => {
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
                Effect::Create { .. } => {
                    // Nothing of this account's is in use: the gate only creates on first use.
                    let lane = LaneKey::Account(acct.id);
                    self.inner.shared.close_idle(lane);
                    let (shared, path, migs) = (
                        self.inner.shared.clone(),
                        acct.path.clone(),
                        self.inner.migs,
                    );
                    let slot = Slot {
                        lane,
                        kind: ConnKind::Writer,
                    };
                    self.job(acct, async move {
                        let created = shared.with_slot(slot, Patience::Wait, move || {
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
    }
}

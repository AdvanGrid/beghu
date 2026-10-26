//! Connection management without a pool crate.
//!
//! A `Lane` is one database file: one writer connection, through which every write passes in
//! arrival order, and up to `readers` `query_only` connections. Lanes draw their connections
//! from a `Shared` budget. For mirrors that budget is process-wide (256 by default): at the cap
//! it closes the least-recently-used idle connection of any lane, otherwise waits. A request
//! gives up after `wait` with `Error::Unavailable` (503 with `retry-after`); queued work
//! (webhook applies, sweeps, migrations) keeps waiting, as it does behind the gate. Idle
//! connections close after `reader_idle` / `writer_idle`. Queries run on `spawn_blocking`.

use crate::gate::Caller;
use crate::{AccountId, Error};
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::sync::{Notify, Semaphore};
use tokio::time::Instant;

/// Which of a lane's connections: its writer or one of its `query_only` readers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ConnKind {
    Writer,
    Reader,
}

/// Whose file a lane is: the control DB's, or one account's mirror.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum LaneKey {
    Control,
    Account(AccountId),
}

/// One kind of connection to one lane's file: what the budget counts, and what an idle
/// connection is matched by on checkout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct Slot {
    pub(crate) lane: LaneKey,
    pub(crate) kind: ConnKind,
}

/// What a checkout does at the cap when there's no idle connection to close.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Patience {
    /// Give up after `Budget::wait` with `Error::Unavailable`: a request's 503.
    GiveUp,
    /// Wait until a connection frees up: queued work that has no one to answer 503 to.
    Wait,
}

impl From<Caller> for Patience {
    fn from(c: Caller) -> Patience {
        match c {
            Caller::Request => Patience::GiveUp,
            Caller::Webhook | Caller::Sweep => Patience::Wait,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Budget {
    /// Open connections across every lane drawing on this budget.
    pub max: usize,
    /// How long a request waits for a connection at the cap before giving up.
    pub wait: Duration,
    /// `retry-after` when giving up.
    pub retry_after: Duration,
    pub reader_idle: Duration,
    pub writer_idle: Duration,
}

impl Default for Budget {
    fn default() -> Self {
        Budget {
            max: 256,
            wait: Duration::from_secs(2),
            retry_after: Duration::from_secs(1),
            reader_idle: Duration::from_secs(60),
            writer_idle: Duration::from_secs(5 * 60),
        }
    }
}

struct Idle {
    slot: Slot,
    conn: Connection,
    since: Instant,
}

#[derive(Default)]
struct BudgetState {
    open: usize,
    /// Open per slot, for `open_connections`.
    per_slot: std::collections::HashMap<Slot, usize>,
    idle: Vec<Idle>,
}

/// A place under the cap, from `Shared::claim` or `Shared::claim_new`.
struct Claim {
    place: Place,
    /// The idle connection closed to make room, to drop off the runtime.
    evicted: Option<Connection>,
}

/// A place `Shared::wait_for` found under the cap.
struct Found {
    /// The idle connection of the slot it reuses, if any.
    reused: Option<Connection>,
    /// The idle connection closed to make room, if any.
    evicted: Option<Connection>,
}

/// A place under the cap, and its connection once there is one. Dropped, it closes the
/// connection and gives the place back, however the work holding it ended: done, failed,
/// panicked, or abandoned by a caller that went away. `checkin` keeps the connection as idle
/// instead.
struct Place {
    shared: Arc<Shared>,
    slot: Slot,
    conn: Option<Connection>,
    held: bool,
}

impl Place {
    /// The place's connection, opening it to `path` if it's a new place.
    fn conn(&mut self, path: &Path) -> rusqlite::Result<&mut Connection> {
        match &mut self.conn {
            Some(conn) => Ok(conn),
            none => Ok(none.insert(open(path, self.slot.kind)?)),
        }
    }

    /// Keeps the connection open and idle, still holding its place, for the next checkout.
    fn checkin(mut self) {
        if let Some(conn) = self.conn.take() {
            self.held = false;
            self.shared.checkin(self.slot, conn);
        }
    }
}

impl Drop for Place {
    fn drop(&mut self) {
        if self.held {
            // Close before giving the place back, so the cap is never exceeded.
            drop(self.conn.take());
            self.shared.release(self.slot);
        }
    }
}

pub(crate) struct Shared {
    budget: Budget,
    state: Mutex<BudgetState>,
    freed: Notify,
}

impl Shared {
    /// A budget and its reaper, which closes idle connections until the budget is dropped.
    pub(crate) fn new(budget: Budget) -> Arc<Shared> {
        let shared = Arc::new(Shared {
            budget,
            state: Mutex::default(),
            freed: Notify::new(),
        });
        let weak = Arc::downgrade(&shared);
        tokio::spawn(reap(weak));
        shared
    }

    pub(crate) fn open_connections(&self, account: Option<AccountId>) -> usize {
        let st = self.state.lock().unwrap();
        match account {
            None => st.open,
            Some(a) => st
                .per_slot
                .iter()
                .filter(|(s, _)| s.lane == LaneKey::Account(a))
                .map(|(_, n)| n)
                .sum(),
        }
    }

    /// Closes every idle connection of `lane` (before replacing or deleting its file).
    pub(crate) fn close_idle(&self, lane: LaneKey) {
        drop(self.take_idle(|i| i.slot.lane == lane));
    }

    /// Removes the idle connections `which` picks from the budget and hands them back to close.
    fn take_idle(&self, which: impl Fn(&Idle) -> bool) -> Vec<Idle> {
        let gone = {
            let mut st = self.state.lock().unwrap();
            let (gone, keep): (Vec<Idle>, Vec<Idle>) =
                std::mem::take(&mut st.idle).into_iter().partition(which);
            st.idle = keep;
            for i in &gone {
                forget(&mut st, i.slot);
            }
            gone
        };
        if !gone.is_empty() {
            self.freed.notify_waiters();
        }
        gone
    }

    /// A place for `slot`: an idle connection of that slot, else a new place (see `claim_new`).
    async fn claim(self: &Arc<Self>, slot: Slot, patience: Patience) -> Result<Claim, Error> {
        self.wait_for(slot, patience, |st| {
            // Most recently used first, so the others age out.
            match st.idle.iter().rposition(|i| i.slot == slot) {
                Some(pos) => Some(Found {
                    reused: Some(st.idle.remove(pos).conn),
                    evicted: None,
                }),
                None => new_place(st, slot, self.budget.max),
            }
        })
        .await
    }

    /// A new place for `slot`, without a connection: under the cap, or by closing the
    /// least-recently-used idle connection at the cap, else after waiting for one to free up.
    async fn claim_new(self: &Arc<Self>, slot: Slot, patience: Patience) -> Result<Claim, Error> {
        self.wait_for(slot, patience, |st| new_place(st, slot, self.budget.max))
            .await
    }

    /// Tries `take` until it finds a place, waiting for connections to free up between tries.
    async fn wait_for(
        self: &Arc<Self>,
        slot: Slot,
        patience: Patience,
        take: impl Fn(&mut BudgetState) -> Option<Found>,
    ) -> Result<Claim, Error> {
        let deadline = Instant::now() + self.budget.wait;
        loop {
            let freed = self.freed.notified();
            tokio::pin!(freed);
            freed.as_mut().enable();
            if let Some(Found { reused, evicted }) = take(&mut self.state.lock().unwrap()) {
                return Ok(Claim {
                    place: Place {
                        shared: self.clone(),
                        slot,
                        conn: reused,
                        held: true,
                    },
                    evicted,
                });
            }
            match patience {
                Patience::GiveUp => {
                    if tokio::time::timeout_at(deadline, freed).await.is_err() {
                        return Err(Error::Unavailable {
                            retry_after: self.budget.retry_after,
                            reason: crate::Unavailable::AtCapacity,
                        });
                    }
                }
                Patience::Wait => freed.await,
            }
        }
    }

    /// Runs `work` on a blocking thread in the claimed place, first closing the connection
    /// evicted to make room. The place goes with `work`, so it's given back (or checked in)
    /// even if the caller stops waiting.
    async fn run_in<T, E>(
        claim: Claim,
        work: impl FnOnce(Place) -> Result<T, E> + Send + 'static,
    ) -> Result<T, E>
    where
        T: Send + 'static,
        E: From<Error> + Send + 'static,
    {
        let Claim { place, evicted } = claim;
        tokio::task::spawn_blocking(move || {
            drop(evicted);
            work(place)
        })
        .await
        .unwrap_or_else(|_| Err(Error::Panicked.into()))
    }

    /// Runs `work` on a blocking thread holding a new place for `slot` under the cap, for a
    /// connection no lane keeps (building a fresh mirror file beside the lane's).
    pub(crate) async fn with_slot<T, E>(
        self: &Arc<Self>,
        slot: Slot,
        patience: Patience,
        work: impl FnOnce() -> Result<T, E> + Send + 'static,
    ) -> Result<T, E>
    where
        T: Send + 'static,
        E: From<Error> + Send + 'static,
    {
        let claim = self.claim_new(slot, patience).await?;
        Shared::run_in(claim, move |_place| work()).await
    }

    fn checkin(&self, slot: Slot, conn: Connection) {
        self.state.lock().unwrap().idle.push(Idle {
            slot,
            conn,
            since: Instant::now(),
        });
        self.freed.notify_waiters();
    }

    /// Gives back a place whose connection is gone (closed, never opened, or its query panicked).
    fn release(&self, slot: Slot) {
        forget(&mut self.state.lock().unwrap(), slot);
        self.freed.notify_waiters();
    }
}

/// A new place for `slot`: under the cap, or in the place of the least-recently-used idle
/// connection, which it hands back to close.
fn new_place(st: &mut BudgetState, slot: Slot, max: usize) -> Option<Found> {
    if st.open < max {
        reserve(st, slot);
        return Some(Found {
            reused: None,
            evicted: None,
        });
    }
    let pos = st
        .idle
        .iter()
        .enumerate()
        .min_by_key(|(_, i)| i.since)
        .map(|(p, _)| p)?;
    let victim = st.idle.remove(pos);
    forget(st, victim.slot);
    reserve(st, slot);
    Some(Found {
        reused: None,
        evicted: Some(victim.conn),
    })
}

fn reserve(st: &mut BudgetState, slot: Slot) {
    st.open += 1;
    *st.per_slot.entry(slot).or_default() += 1;
}

fn forget(st: &mut BudgetState, slot: Slot) {
    st.open -= 1;
    if let Some(n) = st.per_slot.get_mut(&slot) {
        *n -= 1;
        if *n == 0 {
            st.per_slot.remove(&slot);
        }
    }
}

async fn reap(shared: Weak<Shared>) {
    loop {
        let every = match shared.upgrade() {
            Some(s) => s.budget.reader_idle.min(s.budget.writer_idle) / 4,
            None => return,
        };
        tokio::time::sleep(every.max(Duration::from_millis(10))).await;
        let Some(s) = shared.upgrade() else { return };
        let now = Instant::now();
        let idle_for = |k: ConnKind| {
            if k == ConnKind::Reader {
                s.budget.reader_idle
            } else {
                s.budget.writer_idle
            }
        };
        let expired = s.take_idle(|i| now >= i.since + idle_for(i.slot.kind));
        if !expired.is_empty() {
            // Closing the last connection to a WAL file checkpoints it: keep that off the runtime.
            tokio::task::spawn_blocking(move || drop(expired));
        }
    }
}

/// Opens a connection to an existing file with the settings every beghu connection uses.
pub fn open(path: &Path, kind: ConnKind) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    configure(&conn, kind)?;
    Ok(conn)
}

/// The settings every beghu connection uses. Foreign keys are on explicitly: the control DB's
/// cascades rely on them, and only the bundled SQLite build turns them on by default. Mirrors
/// declare no foreign keys, so for them it changes nothing.
pub fn configure(conn: &Connection, kind: ConnKind) -> rusqlite::Result<()> {
    conn.busy_timeout(Duration::from_secs(5))?;
    if kind == ConnKind::Writer {
        conn.pragma_update(None, "journal_mode", "WAL")?;
    }
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", true)?;
    if kind == ConnKind::Reader {
        conn.pragma_update(None, "query_only", true)?;
    }
    Ok(())
}

/// One database file's writer lane and readers. `read` and `write` take work that fails with
/// its own error `W` and return the caller's `E`, which both `W` and a pool error convert
/// into, so callers get one `Result` back. A dropped caller's work keeps its turn until it ends.
pub(crate) struct Lane {
    key: LaneKey,
    path: PathBuf,
    shared: Arc<Shared>,
    writer: Arc<tokio::sync::Mutex<()>>,
    readers: Arc<Semaphore>,
}

impl Lane {
    pub(crate) fn new(key: LaneKey, path: PathBuf, readers: usize, shared: Arc<Shared>) -> Lane {
        Lane {
            key,
            path,
            shared,
            writer: Arc::default(),
            readers: Arc::new(Semaphore::new(readers)),
        }
    }

    pub(crate) async fn read<T, E, W, F>(&self, patience: Patience, f: F) -> Result<T, E>
    where
        T: Send + 'static,
        E: From<Error> + From<W> + Send + 'static,
        F: FnOnce(&Connection) -> Result<T, W> + Send + 'static,
    {
        let permit = self
            .readers
            .clone()
            .acquire_owned()
            .await
            .expect("never closed");
        self.run(ConnKind::Reader, patience, permit, move |c| f(c))
            .await
    }

    pub(crate) async fn write<T, E, W, F>(&self, patience: Patience, f: F) -> Result<T, E>
    where
        T: Send + 'static,
        E: From<Error> + From<W> + Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, W> + Send + 'static,
    {
        let turn = self.writer.clone().lock_owned().await;
        self.run(ConnKind::Writer, patience, turn, f).await
    }

    /// Runs `f` holding `turn` (the writer's lock or a reader's permit) until the query ends
    /// and its connection is checked in or closed, even if the caller stops waiting first.
    async fn run<T, E, W, F>(
        &self,
        kind: ConnKind,
        patience: Patience,
        turn: impl Send + 'static,
        f: F,
    ) -> Result<T, E>
    where
        T: Send + 'static,
        E: From<Error> + From<W> + Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, W> + Send + 'static,
    {
        let claim = self
            .shared
            .claim(
                Slot {
                    lane: self.key,
                    kind,
                },
                patience,
            )
            .await?;
        let path = self.path.clone();
        Shared::run_in(claim, move |place| {
            // Declared first, so it's dropped after `place` on every path, a panic's included.
            let _turn = turn;
            let mut place = place;
            let r = f(place.conn(&path).map_err(Error::Sqlite)?).map_err(E::from);
            place.checkin();
            r
        })
        .await
    }
}

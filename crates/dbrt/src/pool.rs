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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::sync::{Notify, OwnedMutexGuard, Semaphore};
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
            Caller::Webhook | Caller::Sweep | Caller::Walker => Patience::Wait,
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
    /// A writer's lane's turn, which the reaper takes before analyzing and closing it.
    turn: Option<Turn>,
}

/// A lane's writer turn: whoever holds it is the only one writing to the lane's file.
type Turn = Arc<tokio::sync::Mutex<()>>;

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
    /// The lane's writer turn, kept with the connection when it's checked in.
    turn: Option<Turn>,
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
            self.shared.checkin(self.slot, conn, self.turn.take());
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
    /// The indexes `sample` analyzes in full when a writer closes.
    sampled: &'static [&'static str],
    state: Mutex<BudgetState>,
    freed: Notify,
    /// Set by the drain's checkpoint: every lane on this budget refuses writes from then on.
    sealed: AtomicBool,
}

impl Shared {
    /// A budget and its reaper, which closes idle connections until the budget is dropped.
    pub(crate) fn new(budget: Budget, sampled: &'static [&'static str]) -> Arc<Shared> {
        let shared = Arc::new(Shared {
            budget,
            sampled,
            state: Mutex::default(),
            freed: Notify::new(),
            sealed: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&shared);
        tokio::spawn(reap(weak));
        shared
    }

    /// From now on, every write on this budget's lanes fails with [`Error::Sealed`] (a write
    /// already holding its lane's turn runs to its end). The drain's checkpoint calls it first,
    /// so the WAL it folds stays folded.
    pub(crate) fn seal(&self) {
        self.sealed.store(true, Ordering::SeqCst);
    }

    pub(crate) fn is_sealed(&self) -> bool {
        self.sealed.load(Ordering::SeqCst)
    }

    /// [`Error::Sealed`] once [`Shared::seal`] has been called: for a write to check before it
    /// starts.
    pub(crate) fn unsealed(&self) -> Result<(), Error> {
        match self.is_sealed() {
            true => Err(Error::Sealed),
            false => Ok(()),
        }
    }

    /// Open connections to one lane's file.
    fn open_in(&self, lane: LaneKey) -> usize {
        let st = self.state.lock().unwrap();
        st.per_slot
            .iter()
            .filter(|(s, _)| s.lane == lane)
            .map(|(_, n)| n)
            .sum()
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

    /// The expired idle writers whose lane's turn is free, each still holding its place under
    /// the cap and now its lane's turn, so analyzing and closing it runs beside no write.
    /// A writer whose turn is taken is about to be reused: it stays.
    fn take_idle_writers(
        self: &Arc<Self>,
        expired: impl Fn(&Idle) -> bool,
    ) -> Vec<(Place, OwnedMutexGuard<()>)> {
        let mut st = self.state.lock().unwrap();
        let mut taken = Vec::new();
        let mut keep = Vec::new();
        for i in std::mem::take(&mut st.idle) {
            let turn = match &i.turn {
                Some(t) if expired(&i) => t.clone().try_lock_owned().ok(),
                _ => None,
            };
            match turn {
                Some(turn) => taken.push((
                    Place {
                        shared: self.clone(),
                        slot: i.slot,
                        conn: Some(i.conn),
                        held: true,
                        turn: None,
                    },
                    turn,
                )),
                None => keep.push(i),
            }
        }
        st.idle = keep;
        taken
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
                        turn: None,
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

    fn checkin(&self, slot: Slot, conn: Connection, turn: Option<Turn>) {
        self.state.lock().unwrap().idle.push(Idle {
            slot,
            conn,
            since: Instant::now(),
            turn,
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
        let expired = |i: &Idle| now >= i.since + idle_for(i.slot.kind);
        // A writer is analyzed before it closes, so it keeps its place and its lane's turn
        // until then: no other writer opens beside it, over the cap or into `SQLITE_BUSY`.
        let writers = s.take_idle_writers(expired);
        let readers = s.take_idle(|i| i.turn.is_none() && expired(i));
        if !writers.is_empty() || !readers.is_empty() {
            let sampled = s.sampled;
            // Closing the last connection to a WAL file checkpoints it: keep that off the runtime.
            tokio::task::spawn_blocking(move || {
                drop(readers);
                for (place, turn) in writers {
                    if let Some(conn) = &place.conn {
                        // Statistics only steer the planner: a failure keeps the old ones.
                        let _ = optimize(conn).and_then(|()| sample(conn, sampled));
                    }
                    // Closes the connection and gives its place back, then the turn.
                    drop(place);
                    drop(turn);
                }
            });
        }
    }
}

pub use crate::stats::{optimize, sample};

/// Opens a connection to an existing file with the settings every beghu connection uses.
pub fn open(path: &Path, kind: ConnKind) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    configure(&conn, kind)?;
    Ok(conn)
}

/// A connection to an existing file outside any lane, for work that needs neither a lane's writer
/// nor a `query_only` reader (a `VACUUM INTO` backup). The caller holds its place under the cap.
pub(crate) fn open_unpooled(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_secs(5))?;
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

/// A conditional delete's check ([`Lane::remove`]): whether to go ahead.
pub(crate) type Check = std::pin::Pin<Box<dyn Future<Output = bool> + Send>>;

/// One database file's writer lane and readers. `read` and `write` take work that fails with
/// its own error `W` and return the caller's `E`, which both `W` and a pool error convert
/// into, so callers get one `Result` back. A dropped caller's work keeps its turn until it ends.
pub(crate) struct Lane {
    key: LaneKey,
    path: PathBuf,
    shared: Arc<Shared>,
    writer: Turn,
    readers: Arc<Semaphore>,
    /// How many readers it allows at once: the permits `readers` started with.
    reader_count: u32,
}

impl Lane {
    pub(crate) fn new(key: LaneKey, path: PathBuf, readers: usize, shared: Arc<Shared>) -> Lane {
        Lane {
            key,
            path,
            shared,
            writer: Arc::default(),
            readers: Arc::new(Semaphore::new(readers)),
            reader_count: readers as u32,
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

    /// Runs `f` on the writer once every write that arrived before it is done; fails with
    /// [`Error::Sealed`] once the drain has checkpointed the lane's budget.
    pub(crate) async fn write<T, E, W, F>(&self, patience: Patience, f: F) -> Result<T, E>
    where
        T: Send + 'static,
        E: From<Error> + From<W> + Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, W> + Send + 'static,
    {
        let turn = self.write_turn().await?;
        self.run(ConnKind::Writer, patience, turn, f).await
    }

    /// The lane's writer turn, once every write that arrived before is done; then
    /// [`Error::Sealed`] if the drain sealed the budget meanwhile.
    async fn write_turn(&self) -> Result<OwnedMutexGuard<()>, Error> {
        let turn = self.writer.clone().lock_owned().await;
        self.shared.unsealed()?;
        Ok(turn)
    }

    /// Runs `work` holding the lane's writer turn and a writer's place under the cap, but on no
    /// connection of the lane's: building a fresh file to put in place of the lane's. Sealed as
    /// [`Lane::write`] is.
    pub(crate) async fn replace<T, E>(
        &self,
        patience: Patience,
        work: impl FnOnce() -> Result<T, E> + Send + 'static,
    ) -> Result<T, E>
    where
        T: Send + 'static,
        E: From<Error> + Send + 'static,
    {
        let turn = self.write_turn().await?;
        let slot = Slot {
            lane: self.key,
            kind: ConnKind::Writer,
        };
        self.shared
            .with_slot(slot, patience, move || {
                let _turn = turn;
                work()
            })
            .await
    }

    /// Runs `work` (deleting the lane's file) once no connection of the lane is in use, and with
    /// none left open: it holds the writer's turn and every reader's permit, so the write and
    /// reads in flight finish first and none starts meanwhile, then closes the idle connections.
    /// Each of `checks` is awaited first, holding all that, in order: the first that says no
    /// keeps the file, and `work` doesn't run (`Ok(false)`). Sealed as [`Lane::write`] is.
    pub(crate) async fn remove(
        &self,
        checks: Vec<Check>,
        work: impl FnOnce() -> std::io::Result<()> + Send + 'static,
    ) -> Result<bool, Error> {
        let turn = self.write_turn().await?;
        let readers = self
            .readers
            .clone()
            .acquire_many_owned(self.reader_count)
            .await
            .expect("never closed");
        for check in checks {
            if !check.await {
                return Ok(false);
            }
        }
        let (shared, key) = (self.shared.clone(), self.key);
        tokio::task::spawn_blocking(move || {
            let (_turn, _readers) = (turn, readers);
            shared.close_idle(key);
            work()
        })
        .await
        .map_err(|_| Error::Panicked)?
        .map_err(Error::Io)?;
        Ok(true)
    }

    /// The drain's last step, once the budget is sealed: waits for the write in flight (every
    /// write queued behind it is refused), folds the WAL into the database file
    /// (`wal_checkpoint(TRUNCATE)`), then closes the lane's idle connections. A lane with no
    /// connection open has no WAL to fold: closing its last one did that. A connection still in
    /// use stays open; a reader still holding part of the WAL is [`Error::CheckpointBusy`].
    pub(crate) async fn checkpoint(&self) -> Result<(), Error> {
        debug_assert!(self.shared.is_sealed(), "a checkpoint before the seal");
        let turn = self.writer.clone().lock_owned().await;
        if self.shared.open_in(self.key) == 0 {
            return Ok(());
        }
        // `busy` is 1 when the checkpoint couldn't finish (`PRAGMA wal_checkpoint`).
        let busy: i64 = self
            .run::<_, Error, rusqlite::Error, _>(ConnKind::Writer, Patience::Wait, turn, |c| {
                c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))
            })
            .await?;
        let (shared, key) = (self.shared.clone(), self.key);
        tokio::task::spawn_blocking(move || shared.close_idle(key))
            .await
            .map_err(|_| Error::Panicked)?;
        match busy {
            0 => Ok(()),
            _ => Err(Error::CheckpointBusy),
        }
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
        let mut claim = self
            .shared
            .claim(
                Slot {
                    lane: self.key,
                    kind,
                },
                patience,
            )
            .await?;
        if kind == ConnKind::Writer {
            claim.place.turn = Some(self.writer.clone());
        }
        let path = self.path.clone();
        // Inside a perf scope (`scans::counted`), the query's full-scan steps are read after it.
        let counting = crate::scans::counting();
        let (r, scans) = Shared::run_in(claim, move |place| {
            // Declared first, so it's dropped after `place` on every path, a panic's included.
            let _turn = turn;
            let mut place = place;
            let conn = place.conn(&path).map_err(Error::Sqlite)?;
            if counting {
                // What uncounted queries (jobs, webhooks) left on this connection's statements
                // isn't this query's.
                crate::scans::take(conn);
            }
            let r = f(&mut *conn).map_err(E::from);
            let scans = if counting {
                crate::scans::take(conn)
            } else {
                Vec::new()
            };
            place.checkin();
            Ok::<_, E>((r, scans))
        })
        .await?;
        crate::scans::record(scans);
        r
    }
}

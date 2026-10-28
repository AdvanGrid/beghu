//! The per-account mirror. `q` and `frag` are generated at build time from `queries/` by
//! `sqlcheck`, against the schema `migrations/` builds; `MIGRATIONS` and `SCHEMA_VERSION` too.
//! App code reads and writes a mirror only through `Mirrors` and those functions.
#![allow(clippy::disallowed_methods)] // a database crate: raw rusqlite calls are allowed here

include!(concat!(env!("OUT_DIR"), "/db.rs"));

pub mod list;
pub mod rank;
pub mod search;

pub use dbrt::AccountId;
pub use dbrt::mirrors::{Config, Notice};
pub use dbrt::{Caller, Error};
/// The connection and result types `q`'s functions take and return, for app code that wraps
/// them.
pub use rusqlite::{Connection, Result as QueryResult};

use rusqlite::{Transaction, TransactionBehavior};
use std::path::PathBuf;

/// A read's connection, as [`Mirrors::read`] hands it over. It derefs to the connection the
/// generated queries take, so app code can split a read into helper functions without naming
/// rusqlite.
pub struct Reader<'a>(&'a Connection);

impl std::ops::Deref for Reader<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        self.0
    }
}

/// Every account's mirror under one directory (`<dir>/<github_user_id>.db`), opened and
/// migrated on first use, within the process-wide connection budget.
#[derive(Clone)]
pub struct Mirrors(dbrt::Mirrors);

impl Mirrors {
    /// Must be called inside a tokio runtime.
    pub fn new(dir: impl Into<PathBuf>, cfg: Config) -> Mirrors {
        let cfg = Config {
            sampled_indexes: SAMPLED_INDEXES,
            ..cfg
        };
        Mirrors(dbrt::Mirrors::new(dir, MIGRATIONS, cfg))
    }

    pub fn path(&self, account: AccountId) -> PathBuf {
        self.0.path(account)
    }

    pub fn notices(&self) -> tokio::sync::broadcast::Receiver<Notice> {
        self.0.notices()
    }

    pub fn open_connections(&self, account: Option<AccountId>) -> usize {
        self.0.open_connections(account)
    }

    /// Deletes the account's mirror once the work in flight on it is done, and refuses every
    /// use of it ([`Error::Deleted`]) until [`Mirrors::revive`]: an account that lost access.
    /// [`Error::Sealed`] once the drain has sealed the mirrors, leaving the file.
    pub async fn delete(&self, account: AccountId) -> Result<(), Error> {
        self.0.delete(account).await
    }

    /// The account may use its mirror again: its next use creates an empty one and asks for its
    /// import (`Notice::NeedsImport`).
    pub fn revive(&self, account: AccountId) {
        self.0.revive(account)
    }

    /// The drain's last step: refuses every write from now on (`Error::Sealed`), lets each
    /// mirror's write in flight finish, folds its WAL into its file and closes its idle
    /// connections. The mirrors that failed, and why.
    pub async fn checkpoint(&self) -> Vec<(AccountId, Error)> {
        self.0.checkpoint().await
    }

    /// Runs `f` on a `query_only` connection.
    pub async fn read<T, F>(&self, account: AccountId, caller: Caller, f: F) -> Result<T, Error>
    where
        T: Send + 'static,
        F: FnOnce(&Reader<'_>) -> rusqlite::Result<T> + Send + 'static,
    {
        self.0.read(account, caller, move |c| f(&Reader(c))).await
    }

    /// Runs `f` in one write transaction on the account's writer lane, after the writes queued
    /// before it. The transaction's `seq` is bumped once, first, and handed to `f` for the rows
    /// it writes. `f`'s error rolls everything back, `seq` included.
    pub async fn write<T, F>(&self, account: AccountId, caller: Caller, f: F) -> Result<T, Error>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction, i64) -> rusqlite::Result<T> + Send + 'static,
    {
        self.0
            .write(account, caller, move |conn| {
                let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let seq = q::bump_seq(&tx)?;
                let out = f(&tx, seq)?;
                tx.commit()?;
                Ok(out)
            })
            .await
    }
}

/// Builds an empty mirror at this build's version at `path`, replacing any file there. For
/// tools that write a mirror directly (the fixture generator).
pub fn create(path: &std::path::Path) -> Result<(), Error> {
    dbrt::migrations::create_fresh(path, MIGRATIONS)
}

/// The indexes whose values the planner must tell apart (`dbrt::pool::sample`): an issue type
/// can be on no issue (`type:epic`) or on a third of them (`type:bug`).
const SAMPLED_INDEXES: &[&str] = &["items_issue_type"];

/// Brings the planner's statistics up to date (`dbrt::pool::optimize`, then
/// `dbrt::pool::sample`), for tools that write a mirror directly: the fixture generator, so the
/// mirrors copied from it plan as an imported mirror does once its writer has closed.
pub fn optimize(conn: &Connection) -> rusqlite::Result<()> {
    dbrt::pool::optimize(conn)?;
    dbrt::pool::sample(conn, SAMPLED_INDEXES)
}

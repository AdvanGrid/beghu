//! The per-account mirror. `q` and `frag` are generated at build time from `queries/` by
//! `sqlcheck`, against the schema `migrations/` builds; `MIGRATIONS` and `SCHEMA_VERSION` too.
//! App code reads and writes a mirror only through `Mirrors` and those functions.
#![allow(clippy::disallowed_methods)] // a database crate: raw rusqlite calls are allowed here

include!(concat!(env!("OUT_DIR"), "/db.rs"));

pub use dbrt::AccountId;
pub use dbrt::mirrors::{Config, Notice};
pub use dbrt::{Caller, Error};
/// What a mirror query returns.
pub use rusqlite::Result as QueryResult;

use rusqlite::{Connection, Transaction, TransactionBehavior};
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

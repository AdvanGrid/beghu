//! Each account's analyses: its analysis runs and its latest analysis per PR, in `analyses.db`
//! beside its mirror. `q` is generated at build time from `queries/` by `sqlcheck`, against the
//! schema `migrations/` builds; `MIGRATIONS` and `SCHEMA_VERSION` too. App code reads and writes
//! the file only through `Analyses` and those functions.
//!
//! The files are managed as the mirrors are (`dbrt::Mirrors`: opened and migrated on first use
//! behind a per-account gate, one writer and two readers each), under a connection budget of
//! their own. Unlike a mirror, nothing here can be had from GitHub again, so the schema migrates
//! in place only, and a file is deleted only when its account goes dormant.
#![allow(clippy::disallowed_methods)] // a database crate: raw rusqlite calls are allowed here

include!(concat!(env!("OUT_DIR"), "/db.rs"));

pub use dbrt::mirrors::Config;
pub use dbrt::{AccountId, Error};
/// The connection and result types `q`'s functions take and return.
pub use rusqlite::{Connection, Result as QueryResult, Transaction};

use dbrt::Caller;
use rusqlite::TransactionBehavior;
use std::path::PathBuf;

/// Every account's `analyses.db`, under one directory (`<dir>/<github_user_id>.db`).
#[derive(Clone)]
pub struct Analyses(dbrt::Mirrors);

impl Analyses {
    /// Must be called inside a tokio runtime.
    pub fn new(dir: impl Into<PathBuf>, cfg: Config) -> Analyses {
        Analyses(dbrt::Mirrors::new(dir, MIGRATIONS, cfg))
    }

    pub fn path(&self, account: AccountId) -> PathBuf {
        self.0.path(account)
    }

    /// Deletes the account's file once the work in flight on it is done, and refuses every use
    /// of it ([`Error::Deleted`]) until [`Analyses::revive`]: an account gone dormant.
    pub async fn delete(&self, account: AccountId) -> Result<(), Error> {
        self.0.delete(account).await
    }

    /// The account may use its file again (it woke, or signed in): its next use creates an empty
    /// one. Nothing for a file that wasn't deleted.
    pub fn revive(&self, account: AccountId) {
        self.0.revive(account)
    }

    /// The drain's last step, as for the mirrors: refuses every write from now on, lets each
    /// file's write in flight finish and folds its WAL into it. The files that failed, and why.
    pub async fn checkpoint(&self) -> Vec<(AccountId, Error)> {
        self.0.checkpoint().await
    }

    /// Runs `f` on a `query_only` connection.
    pub async fn read<T, F>(&self, account: AccountId, f: F) -> Result<T, Error>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        self.0.read(account, Caller::Request, f).await
    }

    /// Runs `f` in one `BEGIN IMMEDIATE` transaction on the account's writer, after the writes
    /// queued before it. `f`'s error rolls everything back.
    pub async fn write<T, F>(&self, account: AccountId, f: F) -> Result<T, Error>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction) -> rusqlite::Result<T> + Send + 'static,
    {
        self.0
            .write(account, Caller::Request, move |conn| {
                let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let out = f(&tx)?;
                tx.commit()?;
                Ok(out)
            })
            .await
    }
}

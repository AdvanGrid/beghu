//! The control DB. `q` and `frag` are generated at build time from `queries/` by `sqlcheck`,
//! against the schema `migrations/` builds; `MIGRATIONS` and `SCHEMA_VERSION` too.
#![allow(clippy::disallowed_methods)] // a database crate: raw rusqlite calls are allowed here

include!(concat!(env!("OUT_DIR"), "/db.rs"));

pub use dbrt::Error;
pub use dbrt::migrations::ControlOutcome;

use rusqlite::{Connection, Transaction, TransactionBehavior};
use std::path::Path;

pub const READERS: usize = 4;

pub struct Control(dbrt::Db);

impl Control {
    /// Opens the control DB at startup, before `/readyz`: creates it if missing, takes a
    /// `VACUUM INTO` backup in `backup_dir` before migrating, and refuses a database newer than
    /// this build (`Error::TooNew`). Any error should stop startup. Must be called inside a tokio runtime.
    pub fn open(path: &Path, backup_dir: &Path) -> Result<(Control, ControlOutcome), Error> {
        let (db, outcome) = dbrt::Db::open_migrated(path, MIGRATIONS, backup_dir, READERS)?;
        Ok((Control(db), outcome))
    }

    /// Writes a consistent copy of the control DB to `dest` (`VACUUM INTO`), never leaving
    /// `dest` half written, on a connection of its own: writes carry on meanwhile.
    pub async fn backup(&self, dest: &Path) -> Result<(), Error> {
        self.0.vacuum_into(dest).await
    }

    /// The drain's last step: refuses every write from now on (`Error::Sealed`), lets the one in
    /// flight finish, folds the WAL into the file and closes the idle connections.
    pub async fn checkpoint(&self) -> Result<(), Error> {
        self.0.checkpoint().await
    }

    pub async fn read<T, F>(&self, f: F) -> Result<T, Error>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        self.0.read(f).await
    }

    /// Runs `f` in one `BEGIN IMMEDIATE` transaction on the writer.
    pub async fn write<T, F>(&self, f: F) -> Result<T, Error>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction) -> rusqlite::Result<T> + Send + 'static,
    {
        self.0
            .write(move |conn| {
                let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let out = f(&tx)?;
                tx.commit()?;
                Ok(out)
            })
            .await
    }
}

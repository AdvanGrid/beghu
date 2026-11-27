//! Each account's analyses: its analysis runs and its latest analysis per PR, in `analyses.db`
//! beside its mirror. `q` is generated at build time from `queries/` by `sqlcheck`, against the
//! schema `migrations/` builds; `MIGRATIONS` and `SCHEMA_VERSION` too. App code reads and writes
//! the file only through `Analyses` and those functions.
//!
//! The files are managed as the mirrors are (`dbrt::Mirrors`: opened and migrated on first use
//! behind a per-account gate, one writer and two readers each), under a connection budget of
//! their own. Unlike a mirror, nothing here can be had from GitHub again, so the schema migrates
//! in place only, and a file is deleted only when its account goes dormant or disconnects.
#![allow(clippy::disallowed_methods)] // a database crate: raw rusqlite calls are allowed here

include!(concat!(env!("OUT_DIR"), "/db.rs"));

pub use dbrt::mirrors::Config;
pub use dbrt::{AccountId, Error};
/// The connection and result types `q`'s functions take and return.
pub use rusqlite::{Connection, Result as QueryResult, Transaction};

use dbrt::Caller;
use rusqlite::TransactionBehavior;
use std::path::PathBuf;

/// A consistent copy of the `analyses.db` at `path`, in memory, through SQLite's online backup:
/// for tools that read a file a live server may be writing (`analysis-fixtures record`). The
/// file is opened read-only and left as it was, WAL and all; a missing one is an error. A file
/// SQLite can't read so (`CANTOPEN` or `READONLY`: in a read-only directory or mount, where a WAL
/// reader can't make its `-wal` and `-shm`) is read as immutable instead, when it has no WAL to
/// fold in; with one, the error stands, as the WAL holds its latest commits.
pub fn snapshot(path: &std::path::Path) -> QueryResult<Connection> {
    match backup(path, false) {
        Err(e)
            if matches!(
                e.sqlite_error_code(),
                Some(rusqlite::ErrorCode::CannotOpen | rusqlite::ErrorCode::ReadOnly)
            ) =>
        {
            let mut wal = path.as_os_str().to_owned();
            wal.push("-wal");
            let wal = std::fs::metadata(&wal).is_ok_and(|m| m.len() > 0);
            if wal { Err(e) } else { backup(path, true) }
        }
        r => r,
    }
}

fn backup(path: &std::path::Path, immutable: bool) -> QueryResult<Connection> {
    use rusqlite::OpenFlags;
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let src = if immutable {
        // A URI's path ends at `?` or `#`, and `%` escapes: those three are escaped in it.
        let mut uri = String::from("file:");
        for c in path
            .to_str()
            .ok_or_else(|| rusqlite::Error::InvalidPath(path.to_owned()))?
            .chars()
        {
            match c {
                '%' | '?' | '#' => uri.push_str(&format!("%{:02X}", c as u32)),
                c => uri.push(c),
            }
        }
        uri.push_str("?immutable=1");
        Connection::open_with_flags(uri, flags | OpenFlags::SQLITE_OPEN_URI)?
    } else {
        Connection::open_with_flags(path, flags)?
    };
    let mut copy = Connection::open_in_memory()?;
    // Every page in one step: one snapshot, which a writer meanwhile can't restart.
    rusqlite::backup::Backup::new(&src, &mut copy)?.run_to_completion(
        i32::MAX,
        std::time::Duration::ZERO,
        None,
    )?;
    Ok(copy)
}

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
    /// of it ([`Error::Deleted`]) until [`Analyses::revive`]: an account gone dormant, or
    /// disconnected. Asked for as this is called, before the future is first polled, as
    /// [`dbrt::Mirrors::delete`] is: a revive that comes after the call brings an empty file
    /// back once the delete is done.
    pub fn delete(
        &self,
        account: AccountId,
    ) -> impl Future<Output = Result<(), Error>> + Send + 'static {
        self.0.delete(account)
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

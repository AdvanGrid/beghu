//! The database runtime under `mirror-db`, `control-db` and `fake-db`: migration runners, the
//! per-account gate, the `Filter` glue for checked fragments, and connection management. It's the
//! only place unchecked SQL is composed.
#![allow(clippy::disallowed_methods)] // a database crate: raw rusqlite calls are allowed here

pub mod copy;
pub mod db;
pub mod filter;
pub mod gate;
pub mod migrations;
pub mod mirrors;
pub mod plan;
pub mod pool;

pub use db::Db;
pub use gate::{Caller, Status};
pub use migrations::{Kind, Migration};
pub use mirrors::{Mirrors, Notice};

use std::time::Duration;

/// A connected account's GitHub user id. Its mirror is `<dir>/<id>.db`.
pub type AccountId = i64;

#[derive(Debug)]
pub enum Error {
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    /// Try again later: answer 503 with `retry-after`.
    Unavailable {
        retry_after: Duration,
        reason: Unavailable,
    },
    /// A migration failed and the file is unchanged: a mirror refuses requests, the control DB
    /// stops startup.
    MigrationFailed(String),
    /// The control DB's `VACUUM INTO` backup before migrating failed; nothing was migrated.
    BackupFailed(String),
    /// The database is newer than this build and won't be opened.
    TooNew {
        db: u32,
        build: u32,
    },
    /// Fake GitHub's fixture isn't at the mirror schema version this build expects, so copying
    /// it would migrate across a rebuild or fail. Regenerate the fixture (or rebuild).
    FixtureVersion {
        fixture: u32,
        build: u32,
    },
    /// A query or job panicked.
    Panicked,
    /// The database takes no more writes: the drain has checkpointed it (`Db::checkpoint`,
    /// `Mirrors::checkpoint`), and a write now would bring back the WAL it folded.
    Sealed,
    /// The drain's checkpoint couldn't fold the whole WAL into the file: a reader still held
    /// part of it (`wal_checkpoint`'s busy column). The WAL is intact, so nothing is lost; the
    /// next open replays it.
    CheckpointBusy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unavailable {
    /// Every connection under the cap is busy.
    AtCapacity,
    /// The mirror is still opening, migrating or being created.
    Updating,
    /// A transient migration failure; it retries after the backoff.
    MigrationRetrying(String),
}

impl Error {
    /// `retry-after` for errors that should become a 503.
    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            Error::Unavailable { retry_after, .. } => Some(*retry_after),
            _ => None,
        }
    }

    /// A failure that may pass if the same work is tried again soon: at capacity or updating
    /// (anything with a [`retry_after`](Self::retry_after)), or SQLite busy or locked by
    /// another writer.
    pub fn is_transient(&self) -> bool {
        match self {
            Error::Unavailable { .. } => true,
            Error::Sqlite(e) => matches!(
                e.sqlite_error_code(),
                Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
            ),
            _ => false,
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Sqlite(e) => write!(f, "{e}"),
            Error::Io(e) => write!(f, "{e}"),
            Error::Unavailable {
                retry_after,
                reason,
            } => write!(
                f,
                "unavailable ({reason:?}); retry after {} s",
                retry_after.as_secs_f32()
            ),
            Error::MigrationFailed(e) => write!(f, "migration failed: {e}"),
            Error::BackupFailed(e) => write!(f, "backup before migrating failed: {e}"),
            Error::TooNew { db, build } => {
                write!(f, "database is at v{db}, newer than this build (v{build})")
            }
            Error::FixtureVersion { fixture, build } if fixture > build => write!(
                f,
                "the fixture is at mirror schema v{fixture}, newer than this build (v{build}): \
                 rebuild, or use a fixture made by this build"
            ),
            Error::FixtureVersion { fixture, build } => write!(
                f,
                "the fixture is stale: it is at mirror schema v{fixture} and this build expects \
                 v{build}; regenerate it"
            ),
            Error::Panicked => f.write_str("a database task panicked"),
            Error::Sealed => f.write_str(
                "the database takes no more writes: the drain has checkpointed it",
            ),
            Error::CheckpointBusy => f.write_str(
                "the checkpoint didn't complete: a reader held the WAL, which stays beside the file",
            ),
        }
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Sqlite(e)
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

//! A single database file with a fixed lane: the control DB's 1 writer and 4 readers.

use crate::Error;
use crate::migrations::{self, ControlOutcome, Migration};
use crate::pool::{self, Budget, ConnKind, Lane, LaneKey, Patience, Shared};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct Db {
    lane: Lane,
    shared: Arc<Shared>,
}

impl Db {
    /// Opens (creating if needed) and migrates the database at `path`, the way the control DB is
    /// opened at startup: a `VACUUM INTO` backup in `backup_dir` before any migration, and a
    /// refusal (`Error::TooNew`) if the file is newer than `migs`. Every connection, the
    /// migration's included, has foreign keys on. Blocks; must be called inside a tokio runtime.
    pub fn open_migrated(
        path: &Path,
        migs: &[Migration],
        backup_dir: &Path,
        readers: usize,
    ) -> Result<(Db, ControlOutcome), Error> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut conn = Connection::open(path)?;
        pool::configure(&conn, ConnKind::Writer)?;
        let outcome = migrations::migrate_control(&mut conn, migs, backup_dir)?;
        drop(conn);
        let budget = Budget {
            max: readers + 1,
            ..Budget::default()
        };
        // The budget fits every reader and the writer, so a checkout never waits at its cap.
        let shared = Shared::new(budget);
        let lane = Lane::new(
            LaneKey::Control,
            PathBuf::from(path),
            readers,
            shared.clone(),
        );
        Ok((Db { lane, shared }, outcome))
    }

    pub async fn read<T, F>(&self, f: F) -> Result<T, Error>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        self.lane.read(Patience::Wait, f).await
    }

    pub async fn write<T, F>(&self, f: F) -> Result<T, Error>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        self.lane.write(Patience::Wait, f).await
    }

    pub fn open_connections(&self) -> usize {
        self.shared.open_connections(None)
    }
}

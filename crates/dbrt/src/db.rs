//! A single database file with a fixed lane: the control DB's 1 writer and 4 readers.

use crate::Error;
use crate::migrations::{self, ControlOutcome, Migration};
use crate::pool::{self, Budget, ConnKind, Lane, LaneKey, Patience, Shared, Slot};
use rusqlite::{Connection, InterruptHandle};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub struct Db {
    path: PathBuf,
    lane: Lane,
    shared: Arc<Shared>,
    /// The backup under way ([`Db::vacuum_into`]), which the drain's checkpoint interrupts.
    backup: Arc<Mutex<Option<InterruptHandle>>>,
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
        let shared = Shared::new(budget, &[]);
        let lane = Lane::new(
            LaneKey::Control,
            PathBuf::from(path),
            readers,
            shared.clone(),
        );
        Ok((
            Db {
                path: path.to_owned(),
                lane,
                shared,
                backup: Arc::default(),
            },
            outcome,
        ))
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

    /// Writes a consistent copy of the database to `dest` (`VACUUM INTO`), replacing any file
    /// there whole (see [`crate::copy::write_whole`]). It reads one snapshot on a connection of
    /// its own, under the budget but beside the lane's: writes carry on meanwhile. Refused with
    /// [`Error::Sealed`] once the drain has checkpointed the database, and cut short (an error,
    /// `dest` untouched) if the checkpoint comes while it runs.
    pub async fn vacuum_into(&self, dest: &Path) -> Result<(), Error> {
        self.shared.unsealed()?;
        let (src, dest) = (self.path.clone(), dest.to_owned());
        let (shared, backup) = (self.shared.clone(), self.backup.clone());
        let slot = Slot {
            lane: LaneKey::Control,
            kind: ConnKind::Reader,
        };
        self.shared
            .with_slot(slot, Patience::Wait, move || {
                // Not a `query_only` reader: `VACUUM INTO` writes, if only to the new file.
                let c = pool::open_unpooled(&src)?;
                {
                    // Checked under the lock the checkpoint interrupts under: it either finds
                    // this backup registered, or this backup finds the seal.
                    let mut running = backup.lock().unwrap_or_else(|e| e.into_inner());
                    shared.unsealed()?;
                    *running = Some(c.get_interrupt_handle());
                }
                let copied = crate::copy::write_whole(&dest, |tmp| {
                    c.execute("VACUUM INTO ?1", [tmp.to_string_lossy()])?;
                    Ok::<_, Error>(())
                });
                *backup.lock().unwrap_or_else(|e| e.into_inner()) = None;
                copied
            })
            .await
    }

    /// The drain's last step: seals the database, so every write from now on fails with
    /// [`Error::Sealed`], interrupts a backup under way (its snapshot would keep the WAL from
    /// being folded until it ends), lets the write in flight finish, folds the WAL into the file
    /// and closes the idle connections (see [`Lane::checkpoint`]).
    ///
    /// [`Lane::checkpoint`]: crate::pool
    pub async fn checkpoint(&self) -> Result<(), Error> {
        self.shared.seal();
        if let Some(running) = &*self.backup.lock().unwrap_or_else(|e| e.into_inner()) {
            running.interrupt();
        }
        self.lane.checkpoint().await
    }

    pub fn open_connections(&self) -> usize {
        self.shared.open_connections(None)
    }
}

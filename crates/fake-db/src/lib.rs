//! Fake GitHub's truth: what "GitHub" holds in local dev and tests. It starts as a copy of a
//! fixture mirror (GitHub's repos, users, issues, comments and relationships, in the mirror
//! schema) with the fake's own tables migrated on top: the accounts that can sign in, their roles,
//! the App's installations, and OAuth codes and tokens. `q` is generated at build time from
//! `queries/` by `sqlcheck`, against both schemas.
#![allow(clippy::disallowed_methods)] // a database crate: raw rusqlite calls are allowed here

include!(concat!(env!("OUT_DIR"), "/db.rs"));

pub use dbrt::Error;

use dbrt::migrations::{self, Plan};
use dbrt::pool::{self, ConnKind};
use rusqlite::{Connection, Transaction, TransactionBehavior};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Fills the fake's own tables in a fresh copy of the fixture.
pub type Seed = Box<dyn Fn(&Transaction) -> rusqlite::Result<()> + Send + Sync>;

/// The truth file, behind one connection. The fake is a dev tool serving a few users, so every
/// call takes turns on that connection, off the async runtime.
#[derive(Clone)]
pub struct Truth(Arc<Inner>);

struct Inner {
    path: PathBuf,
    fixture: PathBuf,
    seed: Seed,
    conn: Mutex<Connection>,
}

impl Truth {
    /// Opens the truth at `path`. When there's none, or it was copied from another fixture or by
    /// another build, it copies `fixture` there first, migrates the copy and runs `seed` on it.
    /// Blocks.
    pub fn open(path: &Path, fixture: &Path, seed: Seed) -> Result<Truth, Error> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = match open_current(path, fixture)? {
            Some(conn) => conn,
            None => copy_fixture(path, fixture, &seed)?,
        };
        Ok(Truth(Arc::new(Inner {
            path: path.to_owned(),
            fixture: fixture.to_owned(),
            seed,
            conn: Mutex::new(conn),
        })))
    }

    /// Throws away everything since the copy: copies the fixture again and re-seeds it. Blocks.
    pub fn reset(&self) -> Result<(), Error> {
        let mut conn = self.0.conn.lock().unwrap_or_else(|e| e.into_inner());
        // Close the file before replacing it.
        *conn = Connection::open_in_memory()?;
        match copy_fixture(&self.0.path, &self.0.fixture, &self.0.seed) {
            Ok(fresh) => {
                *conn = fresh;
                Ok(())
            }
            Err(e) => {
                // The old truth is still there: keep serving it.
                *conn = open_writer(&self.0.path)?;
                Err(e)
            }
        }
    }

    pub fn fixture(&self) -> &Path {
        &self.0.fixture
    }

    pub async fn read<T, F>(&self, f: F) -> Result<T, Error>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let conn = inner.conn.lock().unwrap_or_else(|e| e.into_inner());
            f(&conn).map_err(Error::from)
        })
        .await
        .map_err(|_| Error::Panicked)?
    }

    /// Runs `f` in one `BEGIN IMMEDIATE` transaction.
    pub async fn write<T, F>(&self, f: F) -> Result<T, Error>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction) -> rusqlite::Result<T> + Send + 'static,
    {
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = inner.conn.lock().unwrap_or_else(|e| e.into_inner());
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let out = f(&tx)?;
            tx.commit()?;
            Ok(out)
        })
        .await
        .map_err(|_| Error::Panicked)?
    }
}

/// The truth at `path` if it's at this build's version and was copied from `fixture`.
fn open_current(path: &Path, fixture: &Path) -> Result<Option<Connection>, Error> {
    let Ok(version) = migrations::file_version(path) else {
        return Ok(None);
    };
    if migrations::plan(version, MIGRATIONS) != Plan::Current {
        return Ok(None);
    }
    let conn = open_writer(path)?;
    let from = q::fixture(&conn)?;
    Ok((from.as_deref() == Some(&*fixture.to_string_lossy())).then_some(conn))
}

/// Copies `fixture` over `path`, migrating the fake's own tables onto the copy and seeding them.
/// The fixture must be at exactly this build's mirror schema version: an older one could need a
/// mirror rebuild, which can't run on a copy, and a newer one can't be migrated.
fn copy_fixture(path: &Path, fixture: &Path, seed: &Seed) -> Result<Connection, Error> {
    // Refuse before copying: a fixture can be large.
    let from = migrations::file_version(fixture)
        .map_err(|e| std::io::Error::other(format!("reading {}: {e}", fixture.display())))?
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("no fixture at {}", fixture.display()),
            )
        })?;
    if from != BASE_VERSION {
        return Err(Error::FixtureVersion {
            fixture: from,
            build: BASE_VERSION,
        });
    }
    // A finished fixture has no WAL left: the generator's last connection folded it in.
    dbrt::copy::copy_over(fixture, path, |conn| {
        pool::configure(conn, ConnKind::Writer)?;
        let to = MIGRATIONS.len() as u32;
        migrations::migrate_in_place(conn, MIGRATIONS, from, to)
            .map_err(|e| Error::MigrationFailed(e.to_string()))?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        seed(&tx)?;
        q::set_fixture(&tx, &fixture.to_string_lossy())?;
        tx.commit()?;
        Ok::<_, Error>(())
    })?;
    open_writer(path)
}

fn open_writer(path: &Path) -> Result<Connection, Error> {
    let conn = Connection::open(path)?;
    pool::configure(&conn, ConnKind::Writer)?;
    Ok(conn)
}

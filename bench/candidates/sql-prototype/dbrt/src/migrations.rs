use rusqlite::{Connection, ErrorCode, OpenFlags};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    /// Runs on the existing file.
    InPlace,
    /// Mirrors only: the change needs data the mirror doesn't hold, so a mirror behind it is
    /// deleted, created fresh and re-imported.
    Rebuild,
}

#[derive(Debug)]
pub struct Migration {
    pub version: u32,
    pub name: &'static str,
    pub kind: Kind,
    /// Control DB only: `-- compat: additive` in the file means an older build may run on a
    /// database that has it (new tables, new nullable columns).
    pub additive: bool,
    pub sql: &'static str,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    Current,
    InPlace { from: u32, to: u32 },
    Rebuild { why: String },
}

/// What a mirror at `file` needs to reach `to`. Pure.
pub fn plan(file: Option<u32>, kinds: &[Kind], to: u32) -> Plan {
    match file {
        None | Some(0) => Plan::Rebuild { why: "no mirror file".into() },
        Some(v) if v == to => Plan::Current,
        Some(v) if v > to => Plan::Rebuild { why: format!("mirror is v{v}, newer than this build (v{to}): a rollback") },
        Some(v) => match (v + 1..=to).find(|n| kinds[*n as usize - 1] == Kind::Rebuild) {
            Some(n) => Plan::Rebuild { why: format!("migration {n} needs a re-import") },
            None => Plan::InPlace { from: v, to },
        },
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum MigError {
    /// Disk full, I/O, busy: the same migration may work later. The file stays as it was.
    Transient(String),
    /// Constraint, syntax, anything the data or the SQL causes: it will fail again.
    Deterministic(String),
}

fn classify(e: rusqlite::Error) -> MigError {
    match e.sqlite_error_code() {
        Some(ErrorCode::DiskFull | ErrorCode::SystemIoFailure | ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked | ErrorCode::CannotOpen) => MigError::Transient(e.to_string()),
        _ => MigError::Deterministic(e.to_string()),
    }
}

pub fn file_version(path: &Path) -> rusqlite::Result<Option<u32>> {
    if !path.exists() {
        return Ok(None);
    }
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    c.query_row("PRAGMA user_version", [], |r| r.get(0)).map(Some)
}

/// Every pending migration in one `BEGIN IMMEDIATE` transaction, `user_version` included, so a
/// failure leaves the file exactly as it was. `inject` fails just before COMMIT (for the demo).
pub fn migrate_in_place(conn: &mut Connection, migs: &[Migration], from: u32, to: u32, inject: Option<MigError>) -> Result<(), MigError> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(classify)?;
    for m in &migs[from as usize..to as usize] {
        tx.execute_batch(m.sql).map_err(|e| match classify(e) {
            MigError::Deterministic(s) => MigError::Deterministic(format!("{:04}_{}: {s}", m.version, m.name)),
            t => t,
        })?;
    }
    tx.pragma_update(None, "user_version", to).map_err(classify)?;
    if let Some(e) = inject {
        return Err(e); // dropping `tx` rolls back
    }
    tx.commit().map_err(classify)
}

/// A new mirror at `to`: built beside the old file, then renamed over it, so a crash mid-way
/// leaves either the old file or the new one. Callers must have closed every connection first.
pub fn create_fresh(path: &Path, migs: &[Migration], to: u32) -> rusqlite::Result<()> {
    let tmp = PathBuf::from(format!("{}.new", path.display()));
    let _ = std::fs::remove_file(&tmp);
    let mut c = Connection::open(&tmp)?;
    c.pragma_update(None, "journal_mode", "WAL")?;
    let tx = c.transaction()?;
    for m in &migs[..to as usize] {
        tx.execute_batch(m.sql)?;
    }
    tx.pragma_update(None, "user_version", to)?;
    tx.commit()?;
    drop(c);
    for ext in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", path.display()));
    }
    std::fs::rename(&tmp, path).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
}

#[derive(Debug, PartialEq)]
pub enum ControlOutcome {
    Current(u32),
    Migrated { from: u32, to: u32, backup: PathBuf },
    /// An older build on a newer control DB whose extra migrations are all additive.
    OnNewer { db: u32, build: u32 },
}

/// The control DB isn't disposable, so it never rebuilds: it migrates at startup, before
/// `/readyz`, after a `VACUUM INTO` backup, and records each migration in `_migrations` so an
/// older build can tell whether it may run on what a newer one left.
pub fn migrate_control(conn: &mut Connection, migs: &[Migration], to: u32, backup_dir: &Path) -> Result<ControlOutcome, String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, additive INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))").map_err(|e| e.to_string())?;
    let applied: Vec<(u32, String, bool)> = conn
        .prepare("SELECT version, name, additive FROM _migrations ORDER BY version").unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap()
        .collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    let db = applied.last().map_or(0, |a| a.0);
    if db > to {
        let blocking: Vec<String> = applied.iter().filter(|a| a.0 > to && !a.2).map(|a| format!("{:04}_{}", a.0, a.1)).collect();
        return if blocking.is_empty() {
            Ok(ControlOutcome::OnNewer { db, build: to })
        } else {
            Err(format!("control DB is v{db}; this build knows v{to}, and {} isn't additive", blocking.join(", ")))
        };
    }
    if db == to {
        return Ok(ControlOutcome::Current(db));
    }
    std::fs::create_dir_all(backup_dir).unwrap();
    let backup = backup_dir.join(format!("control-v{db}.sqlite"));
    let _ = std::fs::remove_file(&backup);
    conn.execute("VACUUM INTO ?1", [backup.to_str().unwrap()]).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for m in &migs[db as usize..to as usize] {
        tx.execute_batch(m.sql).map_err(|e| format!("{:04}_{}: {e}", m.version, m.name))?;
        tx.execute("INSERT INTO _migrations (version, name, additive) VALUES (?1, ?2, ?3)", (m.version, m.name, m.additive)).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ControlOutcome::Migrated { from: db, to, backup })
}

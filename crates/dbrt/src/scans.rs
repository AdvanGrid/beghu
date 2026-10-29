//! Full-scan accounting, for the perf gates' "no full scans": how many rows each statement stepped
//! through on a loop with no index constraint (SQLite's `SQLITE_STMTSTATUS_FULLSCAN_STEP`: a scan
//! of a whole table, or a walk of an index with nothing to seek on), summed over a scope.
//!
//! Only a future run inside [`counted`] is counted: every lane query it awaits resets the counters
//! of the statements its connection holds before it runs (what uncounted queries left there, a
//! job's or a webhook's, isn't its) and reads them once it ends. Outside a scope nothing is read,
//! so the counters cost nothing beyond SQLite's own increment.
//!
//! Blind spot: a query in a task the scoped future spawns (`tokio::spawn`) isn't counted, since
//! the task-local scope doesn't follow it there. Queries awaited in the request's own task,
//! `join!`ed ones included, are.

use rusqlite::Connection;
use std::cell::RefCell;
use std::future::Future;

/// One statement's full-scan steps during a query.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scan {
    pub steps: u64,
    /// The statement's SQL, as prepared (parameters unbound).
    pub sql: String,
}

tokio::task_local! {
    static SCANS: RefCell<Vec<Scan>>;
}

/// Runs `f`, returning its output and the full-scan steps of every query it awaited, in order.
pub async fn counted<F: Future>(f: F) -> (F::Output, Vec<Scan>) {
    SCANS
        .scope(RefCell::new(Vec::new()), async move {
            let out = f.await;
            let scans = SCANS.with(|s| s.take());
            (out, scans)
        })
        .await
}

/// Whether the current task is inside [`counted`]: the query it's about to run reads its
/// counters afterwards.
pub(crate) fn counting() -> bool {
    SCANS.try_with(|_| ()).is_ok()
}

/// Adds a query's scans to the current scope, if any.
pub(crate) fn record(scans: Vec<Scan>) {
    if scans.is_empty() {
        return;
    }
    let _ = SCANS.try_with(|s| s.borrow_mut().extend(scans));
}

/// Reads and resets the full-scan counter of every statement `conn` holds prepared (the
/// generated queries' cached statements among them), returning those that stepped.
pub(crate) fn take(conn: &Connection) -> Vec<Scan> {
    use rusqlite::ffi;
    let mut out = Vec::new();
    // SAFETY: `conn` is borrowed for the whole walk, on this thread only, so no statement is
    // finalized or prepared under it; each pointer comes from `sqlite3_next_stmt` on this
    // connection and is used before the next call. `sqlite3_sql` returns a string owned by the
    // statement, copied out at once.
    unsafe {
        let db = conn.handle();
        let mut stmt = ffi::sqlite3_next_stmt(db, std::ptr::null_mut());
        while !stmt.is_null() {
            let steps = ffi::sqlite3_stmt_status(stmt, ffi::SQLITE_STMTSTATUS_FULLSCAN_STEP, 1);
            if steps > 0 {
                let sql = ffi::sqlite3_sql(stmt);
                let sql = if sql.is_null() {
                    String::new()
                } else {
                    std::ffi::CStr::from_ptr(sql).to_string_lossy().into_owned()
                };
                out.push(Scan {
                    steps: steps as u64,
                    sql,
                });
            }
            stmt = ffi::sqlite3_next_stmt(db, stmt);
        }
    }
    out
}

//! The planner's statistics: what `PRAGMA optimize` and full analyses the pool runs. Kept in a
//! file of its own because the fixture's cache key hashes it (`perf/fixture/build.rs`, and CI's
//! fixture cache in `.github/workflows/perf.yml`): an edit elsewhere in dbrt doesn't regenerate
//! the fixtures.

use rusqlite::Connection;

/// Refreshes the query planner's statistics (`sqlite_stat1`) where they're missing or stale:
/// SQLite's `PRAGMA optimize` over every table (`0x10000`), which analyzes (`0x02`) a table that
/// has none yet or has grown or shrunk tenfold since, and does nothing otherwise. Each analysis
/// samples about 2000 rows per index (`0x10`, the limit `PRAGMA analysis_limit` sets) rather
/// than reading every row, so it skips STAT4 too: about 170 ms on an unanalyzed 50k mirror,
/// against about 600 ms unlimited. The planner then knows each index's size and how many rows a
/// value matches on average, but not which values are rare: `sample` adds that where it
/// matters. Run on a writer: after migrations, and when an idle writer closes (SQLite's advice
/// for long-lived connections), which is after an import or a burst of webhook writes. The
/// fixture's cache key hashes this file (`perf/fixture/build.rs`, and CI's fixture cache key in
/// `.github/workflows/perf.yml`): a new mask regenerates the cached fixtures.
pub fn optimize(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "optimize", OPTIMIZE)
}

/// `PRAGMA optimize`'s mask: every table, analysis limited, analyze what needs it.
const OPTIMIZE: i64 = 0x10000 | 0x10 | 0x02;

/// Analyzes `indexes` in full, which `optimize`'s limited pass doesn't: their per-value samples
/// (`sqlite_stat4`) tell the planner a rare value from a common one, where an average can't
/// (`type:epic` looked up through its index, `type:bug` walked in the sort's order). About 8 ms
/// for the issue-type index of a 50k mirror. Run after `optimize`, which drops the samples of
/// any table it analyzes: the reaper runs both when a writer closes, so it also restores what a
/// migration's `optimize` dropped.
pub fn sample(conn: &Connection, indexes: &[&str]) -> rusqlite::Result<()> {
    for idx in indexes {
        conn.execute_batch(&format!("ANALYZE \"{}\"", idx.replace('"', "\"\"")))?;
    }
    Ok(())
}

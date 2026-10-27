//! Query plans, for the checks that a hot query reads through an index (perf/fixture's plan
//! test). The SQL comes from a generated query's own run, caught by SQLite's trace hook, so this
//! composes nothing new: it asks SQLite how it would run a statement the app already runs.

use rusqlite::Connection;

/// `EXPLAIN QUERY PLAN` for `sql` (a statement with its parameters bound in, as
/// `Statement::expanded_sql` gives it): one line per step, SQLite's `detail` text, in order.
/// The plan is for that expanded SQL, so each bound parameter is a constant in it: SQLite may
/// plan a constant differently from a `?` (a LIKE prefix, a partial index's WHERE), though the
/// detail text still shows `?` for each index constraint.
pub fn explain(conn: &Connection, sql: &str) -> rusqlite::Result<Vec<String>> {
    let mut st = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
    st.query_map([], |r| r.get::<_, String>(3))?.collect()
}

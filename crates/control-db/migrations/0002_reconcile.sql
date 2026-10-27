-- Reconciliation (crates/server/src/reconcile): what heals a mirror when webhooks are lost.

-- When the account was marked `needs_resync`: a sweep repairs it once it has waited a while, so
-- a burst of misses costs one sweep. NULL while it isn't marked.
ALTER TABLE accounts ADD COLUMN needs_resync_at INTEGER;

-- Each synced repo's 5-minute probes: the `since` each list is read from (Unix seconds) and the
-- ETag GitHub last answered it with, so an unchanged list is a 304 that costs nothing. Kept
-- across restarts; a repo no account syncs any more keeps its row until it's synced again.
CREATE TABLE repo_probes (
  repo_id INTEGER PRIMARY KEY,
  issues_since INTEGER,
  issues_etag TEXT,
  comments_since INTEGER,
  comments_etag TEXT
);

-- One connected account's analysis runs and its latest analysis per PR (`analyses.db`, beside its
-- mirror). Not in the mirror: a `.rebuild.sql` migration empties the mirror, and an analysis
-- can't be had from GitHub again. Migrated in place only. Not backed up: an analysis is made
-- again by running the agent again. Deleted with the mirror when the account goes dormant.
-- Timestamps are Unix seconds. A PR is keyed by its repo's id and its number; `owner` and `name`
-- are the repo's as they were when the row was written, for logs and URLs.

-- Every analysis run: one agent's session against one PR. At most one per PR is live (not
-- `ended`): starting a run ends the live one (`superseded`). The run's token is in the control DB
-- (`run_tokens`), as only its SHA-256.
CREATE TABLE runs (
  id TEXT NOT NULL PRIMARY KEY,
  repo_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  number INTEGER NOT NULL,
  producer TEXT NOT NULL CHECK (producer IN ('button', 'cli', 'beghu')),
  -- `waiting` until the first fetch of a run file pins the PR (`attached`), then `ended`.
  state TEXT NOT NULL CHECK (state IN ('waiting', 'attached', 'ended')),
  created_at INTEGER NOT NULL,
  -- When the first fetch pinned the PR.
  attached_at INTEGER,
  -- The last authenticated call on the run (its start counts).
  last_heard_at INTEGER NOT NULL,
  ended_at INTEGER,
  ended_reason TEXT CHECK (ended_reason IN ('ended', 'superseded', 'expired', 'signed_out',
    'dormant', 'sign_in_again', 'no_read', 'too_large')),
  -- `pr.json` as the run pinned it.
  pinned TEXT,
  -- Uploads refused (422, 409, 413), and the last one's error report.
  refused INTEGER NOT NULL DEFAULT 0,
  last_report TEXT,
  CHECK ((state = 'ended') = (ended_at IS NOT NULL)),
  CHECK (state <> 'waiting' OR pinned IS NULL),
  CHECK (state <> 'attached' OR pinned IS NOT NULL)
);
CREATE UNIQUE INDEX runs_live ON runs(repo_id, number) WHERE state <> 'ended';

-- The latest analysis per PR, and only that: an accepted upload replaces it. Split at upload
-- into the graph (everything but the claims' bodies) and the claims, each stored at brotli 9 and
-- gzip 9 and served as stored. `version` is the schema version the blobs follow: a read finds it
-- behind the build, migrates, and writes the blobs back at the build's version.
CREATE TABLE analyses (
  id TEXT NOT NULL PRIMARY KEY,
  repo_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  number INTEGER NOT NULL,
  version INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  merge_base TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  -- The upload's `Beghu-Snippets`: whether the uploader's tool checked every snippet.
  snippets TEXT NOT NULL CHECK (snippets IN ('checked', 'not-checked')),
  -- The validator's warnings, as JSON: stored and returned, never shown.
  warnings TEXT NOT NULL,
  parts INTEGER NOT NULL,
  purposes INTEGER NOT NULL,
  conflicts INTEGER NOT NULL,
  -- IDs the schema migrations renamed (`[{old, new, step}]`), as JSON: old URLs forward by them.
  migrated_ids TEXT NOT NULL,
  graph_br BLOB NOT NULL,
  graph_gz BLOB NOT NULL,
  claims_br BLOB NOT NULL,
  claims_gz BLOB NOT NULL,
  UNIQUE (repo_id, number)
);

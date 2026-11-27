-- The latest analysis per PR.

-- What the graph's and the claims' answers need, without the blobs.
-- name: analysis_meta :opt
-- param: repo_id i64
-- param: number i64
SELECT id, version, head_sha, merge_base, created_at, run_id, snippets, warnings, parts, purposes,
       conflicts, migrated_ids
FROM analyses WHERE repo_id = :repo_id AND number = :number;

-- name: graph_br :opt
-- param: id &str
SELECT graph_br AS blob FROM analyses WHERE id = :id;

-- name: graph_gz :opt
-- param: id &str
SELECT graph_gz AS blob FROM analyses WHERE id = :id;

-- name: claims_br :opt
-- param: id &str
SELECT claims_br AS blob FROM analyses WHERE id = :id;

-- name: claims_gz :opt
-- param: id &str
SELECT claims_gz AS blob FROM analyses WHERE id = :id;

-- The whole analysis, as its two gzip blobs: for a migration, or the next upload's check.
-- name: analysis_whole :opt
-- param: repo_id i64
-- param: number i64
SELECT id, version, owner, name, head_sha, merge_base, created_at, snippets, migrated_ids,
       previous_id, graph_gz, claims_gz
FROM analyses WHERE repo_id = :repo_id AND number = :number;

-- An accepted upload: the PR's analysis, replacing the one it had (`previous_id`, or NULL).
-- name: put_analysis :exec
-- param: id &str
-- param: repo_id i64
-- param: owner &str
-- param: name &str
-- param: number i64
-- param: version i64
-- param: head_sha &str
-- param: merge_base &str
-- param: now i64
-- param: run_id &str
-- param: snippets &str
-- param: warnings &str
-- param: parts i64
-- param: purposes i64
-- param: conflicts i64
-- param: migrated_ids &str
-- param: previous_id Option<&str>
-- param: graph_br &[u8]
-- param: graph_gz &[u8]
-- param: claims_br &[u8]
-- param: claims_gz &[u8]
-- param: upload_gz &[u8]
INSERT INTO analyses (id, repo_id, owner, name, number, version, head_sha, merge_base, created_at,
  run_id, snippets, warnings, parts, purposes, conflicts, migrated_ids, previous_id, graph_br,
  graph_gz, claims_br, claims_gz, upload_gz)
VALUES (:id, :repo_id, :owner, :name, :number, :version, :head_sha, :merge_base, :now, :run_id,
  :snippets, :warnings, :parts, :purposes, :conflicts, :migrated_ids, :previous_id, :graph_br,
  :graph_gz, :claims_br, :claims_gz, :upload_gz)
ON CONFLICT (repo_id, number) DO UPDATE SET id = excluded.id, owner = excluded.owner,
  name = excluded.name, version = excluded.version, head_sha = excluded.head_sha,
  merge_base = excluded.merge_base, created_at = excluded.created_at, run_id = excluded.run_id,
  snippets = excluded.snippets, warnings = excluded.warnings, parts = excluded.parts,
  purposes = excluded.purposes, conflicts = excluded.conflicts,
  migrated_ids = excluded.migrated_ids, previous_id = excluded.previous_id,
  graph_br = excluded.graph_br,
  graph_gz = excluded.graph_gz, claims_br = excluded.claims_br, claims_gz = excluded.claims_gz,
  upload_gz = excluded.upload_gz;

-- A read that migrated the analysis writes it back at the build's version: only over the version
-- it read (0 rows when an upload replaced it, or another read migrated it, meanwhile).
-- name: migrated_analysis :exec
-- param: id &str
-- param: from i64
-- param: version i64
-- param: migrated_ids &str
-- param: graph_br &[u8]
-- param: graph_gz &[u8]
-- param: claims_br &[u8]
-- param: claims_gz &[u8]
UPDATE analyses SET version = :version, migrated_ids = :migrated_ids, graph_br = :graph_br,
  graph_gz = :graph_gz, claims_br = :claims_br, claims_gz = :claims_gz
WHERE id = :id AND version = :from;

-- The account lost Read on the repo: its analyses there go, with what was counted of them.
-- name: delete_repo_analyses :exec
-- param: repo_id i64
DELETE FROM analyses WHERE repo_id = :repo_id;

-- name: delete_repo_behind :exec
-- param: repo_id i64
DELETE FROM behind WHERE repo_id = :repo_id;

-- What the PR panel shows of the PR's analysis.
-- name: analysis_summary :opt
-- param: repo_id i64
-- param: number i64
SELECT id, head_sha, created_at, parts, purposes, conflicts
FROM analyses WHERE repo_id = :repo_id AND number = :number;

-- How far `head` is past `analysed` on the PR, once counted: a row with `behind` NULL is
-- "outdated"; no row, not counted yet.
-- name: behind_of :opt
-- param: repo_id i64
-- param: number i64
-- param: analysed &str
-- param: head &str
SELECT behind FROM behind
WHERE repo_id = :repo_id AND number = :number AND analysed = :analysed AND head = :head;

-- name: put_behind :exec
-- param: repo_id i64
-- param: number i64
-- param: analysed &str
-- param: head &str
-- param: behind Option<i64>
INSERT INTO behind (repo_id, number, analysed, head, behind)
VALUES (:repo_id, :number, :analysed, :head, :behind)
ON CONFLICT (repo_id, number, analysed, head) DO UPDATE SET behind = excluded.behind;

-- An upload replaced the PR's analysis: what was counted against the old one goes.
-- name: delete_pr_behind :exec
-- param: repo_id i64
-- param: number i64
DELETE FROM behind WHERE repo_id = :repo_id AND number = :number;

-- The analysis an upload to run `id` made (or the analysis `id`), while it's still the PR's, with
-- the upload's body (NULL for one stored before bodies were kept): what
-- `./dev-ctl analysis record` saves as a fixture. A dev tool's read: it scans the few rows an
-- account has.
-- name: recorded_analysis :opt
-- param: id &str
SELECT id, run_id, version, head_sha, upload_gz FROM analyses WHERE run_id = :id OR id = :id;

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
       graph_gz, claims_gz
FROM analyses WHERE repo_id = :repo_id AND number = :number;

-- An accepted upload: the PR's analysis, replacing the one it had.
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
-- param: graph_br &[u8]
-- param: graph_gz &[u8]
-- param: claims_br &[u8]
-- param: claims_gz &[u8]
INSERT INTO analyses (id, repo_id, owner, name, number, version, head_sha, merge_base, created_at,
  run_id, snippets, warnings, parts, purposes, conflicts, migrated_ids, graph_br, graph_gz,
  claims_br, claims_gz)
VALUES (:id, :repo_id, :owner, :name, :number, :version, :head_sha, :merge_base, :now, :run_id,
  :snippets, :warnings, :parts, :purposes, :conflicts, :migrated_ids, :graph_br, :graph_gz,
  :claims_br, :claims_gz)
ON CONFLICT (repo_id, number) DO UPDATE SET id = excluded.id, owner = excluded.owner,
  name = excluded.name, version = excluded.version, head_sha = excluded.head_sha,
  merge_base = excluded.merge_base, created_at = excluded.created_at, run_id = excluded.run_id,
  snippets = excluded.snippets, warnings = excluded.warnings, parts = excluded.parts,
  purposes = excluded.purposes, conflicts = excluded.conflicts,
  migrated_ids = excluded.migrated_ids, graph_br = excluded.graph_br,
  graph_gz = excluded.graph_gz, claims_br = excluded.claims_br, claims_gz = excluded.claims_gz;

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

-- The account lost Read on the repo: its analyses there go.
-- name: delete_repo_analyses :exec
-- param: repo_id i64
DELETE FROM analyses WHERE repo_id = :repo_id;

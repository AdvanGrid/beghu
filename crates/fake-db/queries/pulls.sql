-- A PR's head, commits and files beyond what derives from its id (`pulls.rs`).

-- name: pull_head :opt
-- param: issue_id i64
SELECT head_sha, pushes, files_set AS "files_set: bool", rewrites, base_sha FROM fake_pull_heads
WHERE issue_id = :issue_id;

-- name: set_pull_head :exec
-- param: issue_id i64
-- param: head_sha &str
-- param: pushes i64
-- param: files_set bool
-- param: rewrites i64
INSERT INTO fake_pull_heads (issue_id, head_sha, pushes, files_set, rewrites)
VALUES (:issue_id, :head_sha, :pushes, :files_set, :rewrites)
ON CONFLICT (issue_id) DO UPDATE SET head_sha = excluded.head_sha, pushes = excluded.pushes,
  files_set = excluded.files_set, rewrites = excluded.rewrites;

-- The base a push or the seed names; NULL goes back to the derived one.
-- name: set_pull_base :exec
-- param: issue_id i64
-- param: base_sha Option<&str>
UPDATE fake_pull_heads SET base_sha = :base_sha WHERE issue_id = :issue_id;

-- The SHA of the PR's `k`th commit, when a push named it.
-- name: pull_commit :opt
-- param: issue_id i64
-- param: k i64
SELECT sha FROM fake_pull_commits WHERE issue_id = :issue_id AND k = :k;

-- name: add_pull_commit :exec
-- param: issue_id i64
-- param: k i64
-- param: sha &str
INSERT INTO fake_pull_commits (issue_id, k, sha) VALUES (:issue_id, :k, :sha)
ON CONFLICT (issue_id, k) DO UPDATE SET sha = excluded.sha;

-- A force push: the PR's pushed commits go with its old history.
-- name: clear_pull_commits :exec
-- param: issue_id i64
DELETE FROM fake_pull_commits WHERE issue_id = :issue_id;

-- A push bumps the PR's `updated_at`, as GitHub's does.
-- name: touch_pull :exec
-- param: issue_id i64
-- param: at i64
UPDATE items SET updated_at = :at WHERE id = :issue_id;

-- name: clear_pull_files :exec
-- param: issue_id i64
DELETE FROM fake_pull_files WHERE issue_id = :issue_id;

-- name: add_pull_file :exec
-- param: issue_id i64
-- param: position i64
-- param: filename &str
-- param: previous_filename Option<&str>
-- param: status &str
-- param: additions i64
-- param: deletions i64
INSERT INTO fake_pull_files (issue_id, position, filename, previous_filename, status, additions, deletions)
VALUES (:issue_id, :position, :filename, :previous_filename, :status, :additions, :deletions);

-- A page of the PR's stored files, in order.
-- name: pull_files :many
-- param: issue_id i64
-- param: limit i64
-- param: offset i64
SELECT filename, previous_filename, status, additions, deletions
FROM fake_pull_files WHERE issue_id = :issue_id
ORDER BY position LIMIT :limit OFFSET :offset;

-- name: pull_file_totals :one
-- param: issue_id i64
SELECT COUNT(*) AS "files!: i64", COALESCE(SUM(additions), 0) AS "additions!: i64",
       COALESCE(SUM(deletions), 0) AS "deletions!: i64"
FROM fake_pull_files WHERE issue_id = :issue_id;

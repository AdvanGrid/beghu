-- The account's role on a repo, re-read from GitHub's `permissions`.
-- name: set_repo_role :exec
-- param: id i64
-- param: role &str
UPDATE repos SET role = :role WHERE id = :id;

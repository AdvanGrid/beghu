-- The account's role on a repo, re-read from GitHub's `permissions`.
-- name: set_repo_role :exec
-- param: id i64
-- param: role &str
UPDATE repos SET role = :role WHERE id = :id;

-- The synced repos and the account's role on each, for `/api/me`.
-- name: synced_repos :many
SELECT r.id, r.owner, r.name, r.private AS "private: bool", r.role, r.archived AS "archived: bool"
FROM repos r WHERE r.synced = 1 ORDER BY r.owner, r.name;

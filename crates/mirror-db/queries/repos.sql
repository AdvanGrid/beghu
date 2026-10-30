-- The account's role on a repo, re-read from GitHub's `permissions`.
-- name: set_repo_role :exec
-- param: id i64
-- param: role &str
UPDATE repos SET role = :role WHERE id = :id;

-- The account's role on a repo and its archived flag, re-read from GitHub after a refusal: how
-- many rows changed (0 when both were as stored).
-- name: set_repo_access :exec
-- param: id i64
-- param: role &str
-- param: archived bool
UPDATE repos SET role = :role, archived = :archived
WHERE id = :id AND (role IS NOT :role OR archived IS NOT :archived);

-- A repo as the roles rule module sees it: its name, the account's role on it (`NULL` until
-- read, and for a repo only stubs point into) and whether it's archived.
-- name: repo_access :opt
-- param: id i64
SELECT r.id, r.owner, r.name, r.role, r.archived AS "archived: bool", r.synced AS "synced: bool"
FROM repos r WHERE r.id = :id;

-- The same, by `owner/name` as a relationship picker names a repo.
-- name: repo_access_named :opt
-- param: owner &str
-- param: name &str
SELECT r.id, r.owner, r.name, r.role, r.archived AS "archived: bool", r.synced AS "synced: bool"
FROM repos r WHERE r.owner = :owner COLLATE NOCASE AND r.name = :name COLLATE NOCASE;

-- The synced repos and the account's role on each, for `/api/me`.
-- name: synced_repos :many
SELECT r.id, r.owner, r.name, r.private AS "private: bool", r.role, r.archived AS "archived: bool"
FROM repos r WHERE r.synced = 1 ORDER BY r.owner, r.name;

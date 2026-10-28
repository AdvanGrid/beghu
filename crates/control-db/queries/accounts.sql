-- name: upsert_account :exec
-- param: github_user_id i64
-- param: login &str
-- param: now i64
INSERT INTO accounts (github_user_id, login, created_at, last_active_at)
VALUES (:github_user_id, :login, :now, :now)
ON CONFLICT (github_user_id) DO UPDATE SET login = excluded.login, last_active_at = excluded.last_active_at;

-- name: account :opt
-- param: github_user_id i64
SELECT a.github_user_id, a.login, a.status, a.last_active_at, a.dormant_at, a.needs_resync AS "needs_resync: bool",
       a.resync_asked_at, p.comment_order
FROM accounts a
LEFT JOIN preferences p ON p.github_user_id = a.github_user_id
WHERE a.github_user_id = :github_user_id;

-- name: set_comment_order :exec
-- param: github_user_id i64
-- param: comment_order Option<&str>
INSERT INTO preferences (github_user_id, comment_order) VALUES (:github_user_id, :comment_order)
ON CONFLICT (github_user_id) DO UPDATE SET comment_order = excluded.comment_order;

-- Disconnect: the account's preferences go.
-- name: delete_preferences :exec
-- param: github_user_id i64
DELETE FROM preferences WHERE github_user_id = :github_user_id;

-- Accounts that must sign in again (or are dormant): their mirrors are deleted at startup.
-- name: accounts_without_mirrors :many
SELECT a.github_user_id FROM accounts a WHERE a.status <> 'active' ORDER BY a.github_user_id;

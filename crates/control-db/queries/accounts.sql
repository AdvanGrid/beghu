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

-- Accounts that must sign in again, or are dormant: their mirrors are deleted at startup.
-- name: accounts_without_mirrors :many
SELECT a.github_user_id FROM accounts a WHERE a.status <> 'active' ORDER BY a.github_user_id;

-- Dormancy (crates/server/src/accounts.rs). `last_active_at` is bumped at most hourly by
-- requests with the account active and by its open streams.

-- An active account in use: when it was last used moves to :now.
-- name: touch_account :exec
-- param: github_user_id i64
-- param: now i64
UPDATE accounts SET last_active_at = :now
WHERE github_user_id = :github_user_id AND status = 'active';

-- A dormant account in use again: it's active from :now. 1 row when it was dormant, so whoever
-- woke it revives its mirror.
-- name: wake_account :exec
-- param: github_user_id i64
-- param: now i64
UPDATE accounts SET status = 'active', dormant_at = NULL, last_active_at = :now
WHERE github_user_id = :github_user_id AND status = 'dormant';

-- The active accounts unused since :before, and when each was last used.
-- name: dormancy_candidates :many
-- param: before i64
SELECT a.github_user_id, a.last_active_at FROM accounts a
WHERE a.status = 'active' AND a.last_active_at <= :before
ORDER BY a.github_user_id;

-- The account goes dormant, if it's still active and unused since :seen (when the daily job
-- read it): a use since then keeps it. 1 row when it went dormant.
-- name: go_dormant :exec
-- param: github_user_id i64
-- param: seen i64
-- param: now i64
UPDATE accounts SET status = 'dormant', dormant_at = :now
WHERE github_user_id = :github_user_id AND status = 'active' AND last_active_at = :seen;

-- The migration walker's order: the active accounts, the most recently used first.
-- name: walk_order :many
SELECT a.github_user_id FROM accounts a WHERE a.status = 'active'
ORDER BY a.last_active_at DESC, a.github_user_id;

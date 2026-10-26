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
       p.comment_order
FROM accounts a
LEFT JOIN preferences p ON p.github_user_id = a.github_user_id
WHERE a.github_user_id = :github_user_id;

-- name: set_comment_order :exec
-- param: github_user_id i64
-- param: comment_order Option<&str>
INSERT INTO preferences (github_user_id, comment_order) VALUES (:github_user_id, :comment_order)
ON CONFLICT (github_user_id) DO UPDATE SET comment_order = excluded.comment_order;

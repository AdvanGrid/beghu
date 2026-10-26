-- name: account :opt
-- param: id i64
SELECT a.github_user_id, a.login, a.last_session_at, p.comment_order
FROM accounts a
LEFT JOIN preferences p ON p.github_user_id = a.github_user_id
WHERE a.github_user_id = :id;

-- name: dormant_accounts :many
-- param: before &str
SELECT github_user_id, login FROM accounts
WHERE last_session_at IS NULL OR last_session_at < :before;

-- name: session :opt
-- param: id &str
SELECT s.id, s.github_user_id, a.login
FROM sessions s JOIN accounts a ON a.github_user_id = s.github_user_id
WHERE s.id = :id;

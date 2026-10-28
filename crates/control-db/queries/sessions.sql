-- Sign-in and browser sessions. A browser session is keyed by the SHA-256 of its
-- `__Host-beghu_sid` cookie; the cookie itself is never stored.

-- Signing in counts as use. It doesn't make an account that must sign in again active: storing
-- its new tokens does (`put_tokens` and `set_account_status`, in one transaction under the
-- account's token lock), so nothing finds it active with the old, dead tokens meanwhile.
-- name: sign_in_account :exec
-- param: github_user_id i64
-- param: login &str
-- param: now i64
INSERT INTO accounts (github_user_id, login, created_at, last_active_at)
VALUES (:github_user_id, :login, :now, :now)
ON CONFLICT (github_user_id) DO UPDATE SET login = excluded.login,
  last_active_at = excluded.last_active_at;

-- Any status but dormant clears when the account went dormant.
-- name: set_account_status :exec
-- param: github_user_id i64
-- param: status &str
UPDATE accounts SET status = :status,
  dormant_at = CASE WHEN :status = 'dormant' THEN dormant_at END
WHERE github_user_id = :github_user_id;

-- name: create_session :exec
-- param: id_hash &[u8]
-- param: account i64
-- param: now i64
-- param: expires_at i64
INSERT INTO browser_sessions (id_hash, active_account_id, created_at, last_seen_at, expires_at)
VALUES (:id_hash, :account, :now, :now, :expires_at);

-- An unexpired session and its active account, if any, with when that account was last used.
-- name: session :opt
-- param: id_hash &[u8]
-- param: now i64
SELECT s.active_account_id, s.last_seen_at, a.status, a.last_active_at
FROM browser_sessions s
LEFT JOIN accounts a ON a.github_user_id = s.active_account_id
WHERE s.id_hash = :id_hash AND s.expires_at > :now;

-- Sign-in rotates the session id: the accounts move to the new one, then the old one goes.
-- name: move_session_accounts :exec
-- param: old &[u8]
-- param: new &[u8]
UPDATE browser_session_accounts SET session_id = :new WHERE session_id = :old;

-- name: delete_session :exec
-- param: id_hash &[u8]
DELETE FROM browser_sessions WHERE id_hash = :id_hash;

-- name: add_session_account :exec
-- param: id_hash &[u8]
-- param: account i64
-- param: now i64
INSERT INTO browser_session_accounts (session_id, github_user_id, added_at)
VALUES (:id_hash, :account, :now)
ON CONFLICT (session_id, github_user_id) DO NOTHING;

-- name: set_active_account :exec
-- param: id_hash &[u8]
-- param: account i64
UPDATE browser_sessions SET active_account_id = :account WHERE id_hash = :id_hash;

-- Sliding expiry: bumped at most hourly.
-- name: touch_session :exec
-- param: id_hash &[u8]
-- param: now i64
-- param: expires_at i64
UPDATE browser_sessions SET last_seen_at = :now, expires_at = :expires_at WHERE id_hash = :id_hash;

-- The accounts signed in on a browser session, in sign-in order.
-- name: session_accounts :many
-- param: id_hash &[u8]
SELECT a.github_user_id, a.login, a.status
FROM browser_session_accounts sa
JOIN accounts a ON a.github_user_id = sa.github_user_id
WHERE sa.session_id = :id_hash
ORDER BY sa.added_at, a.github_user_id;

-- Signing an account out of one browser.
-- name: remove_session_account :exec
-- param: id_hash &[u8]
-- param: account i64
DELETE FROM browser_session_accounts WHERE session_id = :id_hash AND github_user_id = :account;

-- Every browser session an account is signed in on, and each one's active account.
-- name: sessions_of_account :many
-- param: account i64
SELECT s.id_hash, s.active_account_id
FROM browser_session_accounts sa
JOIN browser_sessions s ON s.id_hash = sa.session_id
WHERE sa.github_user_id = :account
ORDER BY s.id_hash;

-- Disconnect: the account leaves every browser.
-- name: remove_account_from_sessions :exec
-- param: account i64
DELETE FROM browser_session_accounts WHERE github_user_id = :account;

-- The daily job: sessions unused for 30 days go.
-- name: prune_expired_sessions :exec
-- param: now i64
DELETE FROM browser_sessions WHERE expires_at <= :now;

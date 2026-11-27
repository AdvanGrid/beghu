-- The beghu CLI's sign-ins and credentials (migration 0014).

-- A new `beghu login`. Logins past their expiry go first, so a dead one's code can come again.
-- name: prune_cli_logins :exec
-- param: now i64
DELETE FROM cli_logins WHERE expires_at <= :now;

-- name: insert_cli_login :exec
-- param: device_hash &[u8]
-- param: code_hash &[u8]
-- param: name &str
-- param: now i64
-- param: expires_at i64
INSERT INTO cli_logins (device_hash, code_hash, name, created_at, expires_at)
VALUES (:device_hash, :code_hash, :name, :now, :expires_at);

-- A login as `/cli/login` shows it, by its code, while it lives.
-- name: cli_login_by_code :opt
-- param: code_hash &[u8]
-- param: now i64
SELECT name, created_at, expires_at, state FROM cli_logins
WHERE code_hash = :code_hash AND expires_at > :now;

-- Approve (`approved`, with the account) or Deny (`denied`, no account) a login still pending
-- and alive. 1 row when this decided it.
-- name: decide_cli_login :exec
-- param: code_hash &[u8]
-- param: state &str
-- param: account Option<i64>
-- param: now i64
UPDATE cli_logins SET state = :state, github_user_id = :account
WHERE code_hash = :code_hash AND state = 'pending' AND expires_at > :now;

-- A login as the CLI's poll finds it, by its device secret.
-- name: cli_login_by_device :opt
-- param: device_hash &[u8]
SELECT state, github_user_id, name, expires_at FROM cli_logins
WHERE device_hash = :device_hash;

-- The poll that mints the token, or finds the login denied, ends it.
-- name: delete_cli_login :exec
-- param: device_hash &[u8]
DELETE FROM cli_logins WHERE device_hash = :device_hash;

-- name: insert_cli_token :exec
-- param: id &str
-- param: token_hash &[u8]
-- param: account i64
-- param: name &str
-- param: now i64
INSERT INTO cli_tokens (id, token_hash, github_user_id, name, created_at, last_used_at)
VALUES (:id, :token_hash, :account, :name, :now, :now);

-- A CLI call's credential: the token, its account, and the account's login, status and last use.
-- name: cli_token :opt
-- param: token_hash &[u8]
SELECT t.id, t.github_user_id, t.name, t.created_at, t.last_used_at,
  a.login, a.status, a.last_active_at
FROM cli_tokens t JOIN accounts a ON a.github_user_id = t.github_user_id
WHERE t.token_hash = :token_hash;

-- name: touch_cli_token :exec
-- param: id &str
-- param: now i64
UPDATE cli_tokens SET last_used_at = :now WHERE id = :id;

-- The setup page's "CLI sign-ins": the account's tokens, the newest first. One past its 90 days
-- unused is left out (the daily check deletes it).
-- name: cli_tokens_of :many
-- param: account i64
-- param: used_after i64
SELECT id, name, created_at, last_used_at FROM cli_tokens
WHERE github_user_id = :account AND last_used_at > :used_after
ORDER BY created_at DESC, id;

-- Revoke (the setup page) and `beghu logout`: the account's token `id`. 1 row when it was there.
-- name: delete_cli_token :exec
-- param: account i64
-- param: id &str
DELETE FROM cli_tokens WHERE github_user_id = :account AND id = :id;

-- Dormancy and Disconnect: every login the account approved that no poll has collected yet, so
-- none mints a token after.
-- name: delete_account_cli_logins :exec
-- param: account i64
DELETE FROM cli_logins WHERE github_user_id = :account;

-- Dormancy and Disconnect: every one of the account's tokens.
-- name: delete_account_cli_tokens :exec
-- param: account i64
DELETE FROM cli_tokens WHERE github_user_id = :account;

-- The daily check: the tokens unused since :before (90 days).
-- name: prune_cli_tokens :exec
-- param: before i64
DELETE FROM cli_tokens WHERE last_used_at <= :before;

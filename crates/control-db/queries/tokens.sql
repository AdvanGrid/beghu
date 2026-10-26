-- Each connected account's user token pair, AES-256-GCM encrypted by the server.

-- name: put_tokens :exec
-- param: github_user_id i64
-- param: access_enc &[u8]
-- param: access_expires_at i64
-- param: refresh_enc &[u8]
-- param: refresh_expires_at i64
INSERT INTO account_tokens (github_user_id, access_enc, access_expires_at, refresh_enc, refresh_expires_at, status)
VALUES (:github_user_id, :access_enc, :access_expires_at, :refresh_enc, :refresh_expires_at, 'active')
ON CONFLICT (github_user_id) DO UPDATE SET access_enc = excluded.access_enc,
  access_expires_at = excluded.access_expires_at, refresh_enc = excluded.refresh_enc,
  refresh_expires_at = excluded.refresh_expires_at, status = 'active';

-- name: tokens :opt
-- param: github_user_id i64
SELECT t.access_enc, t.access_expires_at, t.refresh_enc, t.refresh_expires_at, t.status
FROM account_tokens t WHERE t.github_user_id = :github_user_id;

-- name: set_tokens_status :exec
-- param: github_user_id i64
-- param: status &str
UPDATE account_tokens SET status = :status WHERE github_user_id = :github_user_id;

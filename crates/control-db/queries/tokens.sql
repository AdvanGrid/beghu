-- Each connected account's user token pair, AES-256-GCM encrypted by the server.

-- name: put_tokens :exec
-- param: github_user_id i64
-- param: access_enc &[u8]
-- param: access_expires_at i64
-- param: refresh_enc &[u8]
-- param: refresh_expires_at i64
-- param: issued_at i64
INSERT INTO account_tokens (github_user_id, access_enc, access_expires_at, refresh_enc, refresh_expires_at, status, issued_at)
VALUES (:github_user_id, :access_enc, :access_expires_at, :refresh_enc, :refresh_expires_at, 'active', :issued_at)
ON CONFLICT (github_user_id) DO UPDATE SET access_enc = excluded.access_enc,
  access_expires_at = excluded.access_expires_at, refresh_enc = excluded.refresh_enc,
  refresh_expires_at = excluded.refresh_expires_at, status = 'active', issued_at = excluded.issued_at;

-- name: tokens :opt
-- param: github_user_id i64
SELECT t.access_enc, t.access_expires_at, t.refresh_enc, t.refresh_expires_at, t.status, t.issued_at
FROM account_tokens t WHERE t.github_user_id = :github_user_id;

-- GitHub revoked the grant: an active account whose tokens were issued before `before` (when
-- beghu received the revoke) must sign in again, and those tokens are dead. An account that
-- signed in since, or is signed out already, is left alone. 1 row when marked; then
-- `revoke_tokens` follows.
-- name: lose_access_if_issued_before :exec
-- param: github_user_id i64
-- param: before i64
UPDATE accounts SET status = 'needs_sign_in'
WHERE github_user_id = :github_user_id AND status = 'active'
  AND EXISTS (SELECT 1 FROM account_tokens t
              WHERE t.github_user_id = :github_user_id AND t.issued_at < :before);

-- GitHub refused the tokens issued at `issued_at` (-1: there were none): an active account
-- whose tokens are still those must sign in again. One that signed in since (new tokens), or
-- is signed out already, is left alone. 1 row when marked.
-- name: lose_access_if_tokens_unchanged :exec
-- param: github_user_id i64
-- param: issued_at i64
UPDATE accounts SET status = 'needs_sign_in'
WHERE github_user_id = :github_user_id AND status = 'active'
  AND COALESCE((SELECT t.issued_at FROM account_tokens t
                WHERE t.github_user_id = :github_user_id), -1) = :issued_at;

-- The account's tokens no longer work: GitHub revoked or refused them.
-- name: revoke_tokens :exec
-- param: github_user_id i64
UPDATE account_tokens SET status = 'revoked' WHERE github_user_id = :github_user_id;

-- Disconnect: the grant is revoked, so its tokens go.
-- name: delete_tokens :exec
-- param: github_user_id i64
DELETE FROM account_tokens WHERE github_user_id = :github_user_id;

-- Active accounts whose refresh token has lapsed: they can't get a new access token.
-- name: lapsed_accounts :many
-- param: now i64
SELECT t.github_user_id
FROM account_tokens t
JOIN accounts a ON a.github_user_id = t.github_user_id
WHERE t.refresh_expires_at <= :now AND a.status = 'active'
ORDER BY t.github_user_id;

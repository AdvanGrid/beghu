-- The OAuth web flow: authorization codes, then access/refresh token pairs.

-- name: insert_code :exec
-- param: code &str
-- param: user_id i64
-- param: redirect_uri Option<&str>
-- param: code_challenge Option<&str>
-- param: code_challenge_method Option<&str>
-- param: expires_at i64
INSERT INTO fake_codes (code, user_id, redirect_uri, code_challenge, code_challenge_method, expires_at)
VALUES (:code, :user_id, :redirect_uri, :code_challenge, :code_challenge_method, :expires_at);

-- Marks the code used; nothing comes back for a used, expired or unknown code.
-- name: take_code :opt
-- param: code &str
-- param: now i64
UPDATE fake_codes SET used_at = :now
WHERE code = :code AND used_at IS NULL AND expires_at > :now
RETURNING user_id, redirect_uri, code_challenge, code_challenge_method;

-- name: insert_token :exec
-- param: token &str
-- param: kind &str
-- param: user_id i64
-- param: pair &str
-- param: now i64
-- param: expires_at i64
INSERT INTO fake_tokens (token, kind, user_id, pair, created_at, expires_at)
VALUES (:token, :kind, :user_id, :pair, :now, :expires_at);

-- The user behind a live access token.
-- name: access_token_user :opt
-- param: token &str
-- param: now i64
SELECT t.user_id FROM fake_tokens t
WHERE t.token = :token AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > :now;

-- Uses up a live refresh token, returning its user and pair; nothing for a used, expired,
-- revoked or unknown one.
-- name: use_refresh_token :opt
-- param: token &str
-- param: now i64
UPDATE fake_tokens SET revoked_at = :now
WHERE token = :token AND kind = 'refresh' AND revoked_at IS NULL AND expires_at > :now
RETURNING user_id, pair;

-- name: revoke_pair :exec
-- param: pair &str
-- param: now i64
UPDATE fake_tokens SET revoked_at = :now WHERE pair = :pair AND revoked_at IS NULL;

-- name: revoke_token :exec
-- param: token &str
-- param: now i64
UPDATE fake_tokens SET revoked_at = :now WHERE token = :token AND revoked_at IS NULL;

-- Revokes the user's grant: every token it issued.
-- name: revoke_user :exec
-- param: user_id i64
-- param: now i64
UPDATE fake_tokens SET revoked_at = :now WHERE user_id = :user_id AND revoked_at IS NULL;

-- The user a token (live or not) was issued to.
-- name: token_owner :opt
-- param: token &str
SELECT t.user_id FROM fake_tokens t WHERE t.token = :token;

-- Accounts holding a live refresh token: signed in to an app.
-- name: signed_in :many
-- param: now i64
SELECT u.login FROM users u
WHERE u.id IN (SELECT t.user_id FROM fake_tokens t
               WHERE t.kind = 'refresh' AND t.revoked_at IS NULL AND t.expires_at > :now)
ORDER BY u.login;

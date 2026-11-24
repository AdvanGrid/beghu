-- Analysis runs' tokens. The run itself is in the account's `analyses.db`.

-- name: insert_run_token :exec
-- param: token_hash &[u8]
-- param: run_id &str
-- param: account i64
-- param: now i64
INSERT INTO run_tokens (token_hash, run_id, github_user_id, created_at)
VALUES (:token_hash, :run_id, :account, :now);

-- The run a token names, with its account and that account's status.
-- name: run_token :opt
-- param: token_hash &[u8]
SELECT t.run_id, t.github_user_id, a.status
FROM run_tokens t JOIN accounts a ON a.github_user_id = t.github_user_id
WHERE t.token_hash = :token_hash;

-- A run whose start failed past its token's insert takes the token back.
-- name: delete_run_token :exec
-- param: run_id &str
DELETE FROM run_tokens WHERE run_id = :run_id;

-- Whether the account is signed in on any browser session that hasn't expired: a button run ends
-- once it's signed out of every one.
-- name: signed_in_anywhere :one
-- param: account i64
-- param: now i64
SELECT EXISTS (
  SELECT 1 FROM browser_session_accounts sa
  JOIN browser_sessions s ON s.id_hash = sa.session_id
  WHERE sa.github_user_id = :account AND s.expires_at > :now
) AS "signed_in!: bool";

-- The dormant accounts: their analyses are deleted with their mirrors (startup deletes any a
-- drain cut off).
-- name: dormant_accounts :many
SELECT github_user_id FROM accounts WHERE status = 'dormant';

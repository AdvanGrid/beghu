-- Analysis runs' tokens. The run itself is in the account's `analyses.db`.

-- name: insert_run_token :exec
-- param: token_hash &[u8]
-- param: run_id &str
-- param: account i64
-- param: producer &str
-- param: now i64
INSERT INTO run_tokens (token_hash, run_id, github_user_id, producer, created_at)
VALUES (:token_hash, :run_id, :account, :producer, :now);

-- The run a token names, with its account and that account's status, who started it, and why it
-- ended when its row is gone.
-- name: run_token :opt
-- param: token_hash &[u8]
SELECT t.run_id, t.github_user_id, a.status, t.producer, t.ended_reason
FROM run_tokens t JOIN accounts a ON a.github_user_id = t.github_user_id
WHERE t.token_hash = :token_hash;

-- A run whose start failed past its token's insert takes the token back; and the daily check
-- prunes the token of a run that ended long ago.
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

-- The accounts whose `analyses.db` startup deletes: the dormant ones (their analyses go with
-- their mirrors, and a drain may have cut that off), and the ones whose disconnect may not have
-- finished deleting theirs (`disconnected_at`, with its value, to clear once it's done). With each
-- one's status: an account active again is let use its file once it's gone.
-- name: analyses_to_delete :many
SELECT github_user_id, status, disconnected_at FROM accounts
WHERE status = 'dormant' OR disconnected_at IS NOT NULL
ORDER BY github_user_id;

-- Disconnect, in the write that marks the account `needs_sign_in`: its `analyses.db` is to be
-- deleted, whatever happens to the process before that's done.
-- name: mark_disconnected :exec
-- param: github_user_id i64
-- param: now i64
UPDATE accounts SET disconnected_at = :now WHERE github_user_id = :github_user_id;

-- The disconnect's delete marked at :at is done. A newer disconnect's mark stays.
-- name: clear_disconnected :exec
-- param: github_user_id i64
-- param: at i64
UPDATE accounts SET disconnected_at = NULL
WHERE github_user_id = :github_user_id AND disconnected_at = :at;

-- The run's row is about to be deleted with its repo's analyses: its token keeps why it ended.
-- name: set_run_token_ended :exec
-- param: run_id &str
-- param: reason &str
UPDATE run_tokens SET ended_reason = :reason WHERE run_id = :run_id;

-- The accounts with runs' tokens: the daily check prunes their long-ended runs.
-- name: run_token_accounts :many
SELECT DISTINCT github_user_id FROM run_tokens ORDER BY github_user_id;

-- Why the run ended, as its token keeps it once its row is gone with its repo's analyses: NULL
-- while the row says.
-- name: run_token_ended :opt
-- param: run_id &str
SELECT ended_reason FROM run_tokens WHERE run_id = :run_id;

-- Tokens of runs started before :before: a run lasts at most its 7 days from its start, so these
-- are of runs that ended before `before` + 7 days, whatever their rows (gone with a deleted
-- `analyses.db`, or with their repo's analyses) say.
-- name: prune_old_run_tokens :exec
-- param: before i64
DELETE FROM run_tokens WHERE created_at < :before;

-- The active accounts: the daily check retries, for each, a loss of Read whose delete of its
-- analyses failed or was cut off.
-- name: active_accounts :many
SELECT github_user_id FROM accounts WHERE status = 'active' ORDER BY github_user_id;

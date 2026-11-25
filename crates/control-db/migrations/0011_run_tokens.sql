-- Each analysis run's token (PR view, #176): only its SHA-256, beside the run's ID and account. A
-- run API request must resolve to an account here before beghu knows which account's
-- `analyses.db` to open (the run itself lives there). Kept after the run ends, so a call with an
-- ended run's token is told why (410), not refused as unknown (401).
CREATE TABLE run_tokens (
  token_hash BLOB PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  github_user_id INTEGER NOT NULL REFERENCES accounts(github_user_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX run_tokens_by_account ON run_tokens(github_user_id);

-- The beghu CLI's sign-ins (#179): beghu's own device flow, never GitHub's.
--
-- `cli_logins`: a `beghu login` waiting for a person to approve it at `/cli/login`, for 10
-- minutes. The CLI keeps the device secret and polls with it; the person types (or follows a link
-- with) the short code. Only each one's SHA-256 is stored: of the device secret's 32 random
-- bytes (not of its base64 text), and of the code's 8 letters, upper case without the dash.
-- Approving names the account; the CLI's next poll mints the token and deletes the row, so the
-- token itself is never stored. A login past `expires_at` is dead whatever its state, and goes
-- at the next login's start.
CREATE TABLE cli_logins (
  device_hash BLOB PRIMARY KEY,
  code_hash BLOB NOT NULL UNIQUE,
  -- The machine's name, as `beghu login --name` gave it (its hostname by default).
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'denied')),
  -- Who approved it; NULL until then.
  github_user_id INTEGER REFERENCES accounts(github_user_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX cli_logins_by_expiry ON cli_logins(expires_at);
-- Dormancy and Disconnect delete the logins an account approved.
CREATE INDEX cli_logins_by_account ON cli_logins(github_user_id);

-- `cli_tokens`: each CLI credential (`beghu_cli_`, then 256 random bits in URL-safe base64), by
-- the SHA-256 of those 32 random bytes: not of the prefix, nor of the base64 text. `id` is public: the setup page lists and revokes by it. A token expires 90 days
-- after its last use, with no absolute cap, and goes with its account at dormancy and at
-- Disconnect, as do the logins it approved that no poll has collected. Signing out in a browser
-- leaves it.
CREATE TABLE cli_tokens (
  id TEXT PRIMARY KEY,
  token_hash BLOB NOT NULL UNIQUE,
  github_user_id INTEGER NOT NULL REFERENCES accounts(github_user_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- Moved at most once a minute by the token's calls.
  last_used_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX cli_tokens_by_account ON cli_tokens(github_user_id, created_at);
CREATE INDEX cli_tokens_by_use ON cli_tokens(last_used_at);

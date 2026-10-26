-- The control DB: accounts, tokens, sessions, repo selection, webhook bookkeeping and account
-- preferences. Not disposable: it's backed up, migrated in place only (never rebuilt), and only
-- ever rolled forward. Timestamps are Unix seconds.

CREATE TABLE accounts (
  github_user_id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dormant', 'needs_sign_in')),
  created_at INTEGER NOT NULL,
  -- Bumped at most hourly by authenticated requests and open streams.
  last_active_at INTEGER NOT NULL,
  dormant_at INTEGER,
  -- A fan-out write to this account's mirror failed: a sweep must repair it.
  needs_resync INTEGER NOT NULL DEFAULT 0
);

-- Each connected account's GitHub tokens, AES-256-GCM encrypted (nonce included in each blob).
CREATE TABLE account_tokens (
  github_user_id INTEGER PRIMARY KEY REFERENCES accounts(github_user_id) ON DELETE CASCADE,
  access_enc BLOB NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_enc BLOB NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  -- active | revoked | expired
  status TEXT NOT NULL DEFAULT 'active'
);

-- One per browser. Only the SHA-256 of the `__Host-beghu_sid` cookie is stored.
CREATE TABLE browser_sessions (
  id_hash BLOB PRIMARY KEY,
  active_account_id INTEGER REFERENCES accounts(github_user_id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX browser_sessions_expiry ON browser_sessions(expires_at);

-- The accounts signed in on a browser session.
CREATE TABLE browser_session_accounts (
  session_id BLOB NOT NULL REFERENCES browser_sessions(id_hash) ON DELETE CASCADE,
  github_user_id INTEGER NOT NULL REFERENCES accounts(github_user_id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, github_user_id)
) WITHOUT ROWID;
CREATE INDEX browser_session_accounts_by_account ON browser_session_accounts(github_user_id);

-- Each account's repo selection: the source of truth for which repos its mirror syncs.
CREATE TABLE synced_repos (
  github_user_id INTEGER NOT NULL REFERENCES accounts(github_user_id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (github_user_id, repo_id)
) WITHOUT ROWID;
-- Fan-out: which accounts sync a repo.
CREATE INDEX synced_repos_by_repo ON synced_repos(repo_id, github_user_id);

-- Webhook deliveries, deduped by `X-GitHub-Delivery`. Acked at once, processed after;
-- `processed_at IS NULL` is the queue resumed at startup.
CREATE TABLE deliveries (
  guid TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  installation_id INTEGER,
  payload BLOB NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX deliveries_pending ON deliveries(received_at) WHERE processed_at IS NULL;

-- Per-installation sync checkpoints.
CREATE TABLE checkpoints (
  installation_id INTEGER PRIMARY KEY,
  -- The newest delivery received for this installation: the start of any gap.
  last_webhook_at INTEGER,
  -- Where the redelivery job got to in `GET /app/hook/deliveries`.
  redelivery_checked_at INTEGER,
  last_full_sweep_at INTEGER
);

-- Account preferences: one row per account, one nullable column per preference and per key
-- action (the keymap adds its columns). NULL means the default; '' means deliberately unbound.
CREATE TABLE preferences (
  github_user_id INTEGER PRIMARY KEY REFERENCES accounts(github_user_id) ON DELETE CASCADE,
  comment_order TEXT CHECK (comment_order IN ('newest', 'oldest'))
);

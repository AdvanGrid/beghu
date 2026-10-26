-- Fake GitHub's own state, on top of the fixture mirror it was copied from (the mirror schema's
-- repos, users, items and so on are GitHub's data). Timestamps are Unix seconds.

-- Which fixture file this truth was copied from: a different one means copy again.
CREATE TABLE fake_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fixture TEXT NOT NULL
);

-- The fixture users who can sign in (a subset of `users`), in the order the authorize page lists them.
CREATE TABLE fake_accounts (
  user_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL
);

-- Each account's role on a repo. No row: the repo isn't visible to that account.
CREATE TABLE fake_permissions (
  user_id INTEGER NOT NULL,
  repo_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('read', 'triage', 'write', 'maintain', 'admin')),
  PRIMARY KEY (user_id, repo_id)
) WITHOUT ROWID;

-- App installations. A repo's installation is `repos.installation_id`.
CREATE TABLE fake_installations (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('Organization', 'User')),
  created_at INTEGER NOT NULL
);

-- OAuth authorization codes from the web flow. Single-use: `used_at` is set by the exchange.
CREATE TABLE fake_codes (
  code TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  redirect_uri TEXT,
  code_challenge TEXT,
  code_challenge_method TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) WITHOUT ROWID;

-- User access tokens (`ghu_`) and refresh tokens (`ghr_`), issued in pairs (`pair` is the
-- access token). Using a refresh token revokes it and its pair's access token.
CREATE TABLE fake_tokens (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  user_id INTEGER NOT NULL,
  pair TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) WITHOUT ROWID;
CREATE INDEX fake_tokens_user ON fake_tokens(user_id, kind);
CREATE INDEX fake_tokens_pair ON fake_tokens(pair);

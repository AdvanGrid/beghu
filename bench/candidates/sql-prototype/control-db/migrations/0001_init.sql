CREATE TABLE accounts (
  github_user_id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  last_session_at TEXT
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  github_user_id INTEGER NOT NULL REFERENCES accounts(github_user_id),
  legacy_token TEXT,
  created_at TEXT NOT NULL
);

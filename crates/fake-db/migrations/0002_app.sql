-- The App's installation access tokens (`ghs_`), minted with the App's JWT and good for an hour.
-- Uninstalling revokes them.
CREATE TABLE fake_installation_tokens (
  token TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX fake_installation_tokens_by_installation ON fake_installation_tokens(installation_id);

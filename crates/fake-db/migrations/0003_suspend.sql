-- An installation's suspension (by the account's owner, or by GitHub). While `suspended_at` is
-- set the installation still lists for its users, with `suspended_at` and `suspended_by`, but it
-- mints no tokens and the tokens it minted stop working.
ALTER TABLE fake_installations ADD COLUMN suspended_at INTEGER;

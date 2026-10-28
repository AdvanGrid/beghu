-- The relationship pickers' key actions (web/src/keys.ts): `blockedBy`, `blocking` and
-- `relatesTo`, each NULL (the GitHub preset's) for every account until it sets one, as 0006's
-- columns are.
ALTER TABLE preferences ADD COLUMN key_blocked_by TEXT;
ALTER TABLE preferences ADD COLUMN key_blocking TEXT;
ALTER TABLE preferences ADD COLUMN key_relates_to TEXT;

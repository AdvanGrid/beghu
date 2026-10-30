-- Tree mode's key actions (web/src/keys.ts): `collapse` and `expand`, ← and → in the tree as
-- ARIA's tree pattern has them, each NULL (the preset's) for every account until it sets one, as
-- 0006's columns are.
ALTER TABLE preferences ADD COLUMN key_collapse TEXT;
ALTER TABLE preferences ADD COLUMN key_expand TEXT;

-- The issue panel's scroll keys (web/src/keys.ts): `scrollDown` and `scrollUp`, which scroll the
-- open issue from the list or the panel, each NULL (the preset's) for every account until it sets
-- one, as 0006's columns are.
ALTER TABLE preferences ADD COLUMN key_scroll_down TEXT;
ALTER TABLE preferences ADD COLUMN key_scroll_up TEXT;

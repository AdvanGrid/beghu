-- The PR view's canvas keys for its lines (web/src/keys.ts, the `canvas` area): select the
-- selected part's next or previous line, NULL (the preset's) for every account until it sets one,
-- as 0016's columns are.
ALTER TABLE preferences ADD COLUMN key_next_line TEXT;
ALTER TABLE preferences ADD COLUMN key_previous_line TEXT;

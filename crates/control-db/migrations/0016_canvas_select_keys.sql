-- The PR view's canvas keys for the keyboard's selection (web/src/keys.ts, the `canvas` area):
-- open or fold the selection, and select the nearest part left, right, up or down (the arrow
-- keys are fixed there too), NULL (the preset's) for every account until it sets one, as 0015's
-- columns are.
ALTER TABLE preferences ADD COLUMN key_open_fold TEXT;
ALTER TABLE preferences ADD COLUMN key_part_left TEXT;
ALTER TABLE preferences ADD COLUMN key_part_right TEXT;
ALTER TABLE preferences ADD COLUMN key_part_up TEXT;
ALTER TABLE preferences ADD COLUMN key_part_down TEXT;

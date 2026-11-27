-- Diff mode's keys (web/src/keys.ts), in the issue panel: `diff` turns it on and off, `fromOlder`
-- and `fromNewer` step the older end, `toOlder` and `toNewer` the newer end, and `nextChange` and
-- `previousChange` step through the changes. Each NULL (the preset's) for every account until it
-- sets one, as 0006's columns are.
ALTER TABLE preferences ADD COLUMN key_diff TEXT;
ALTER TABLE preferences ADD COLUMN key_from_older TEXT;
ALTER TABLE preferences ADD COLUMN key_from_newer TEXT;
ALTER TABLE preferences ADD COLUMN key_to_older TEXT;
ALTER TABLE preferences ADD COLUMN key_to_newer TEXT;
ALTER TABLE preferences ADD COLUMN key_next_change TEXT;
ALTER TABLE preferences ADD COLUMN key_previous_change TEXT;

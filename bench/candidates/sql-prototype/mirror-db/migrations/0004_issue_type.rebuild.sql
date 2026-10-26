-- Rebuild: a newly synced field. Existing rows can't be filled without refetching every issue
-- from GitHub, so a mirror behind this version is deleted, created fresh and re-imported.
ALTER TABLE items ADD COLUMN issue_type TEXT;

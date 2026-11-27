-- The upload's body as it arrived, gzipped (a gzip body as it came, a plain one compressed at
-- gzip 9): what the agent wrote, byte for byte, so `./dev-ctl analysis record` can save an
-- accepted analysis as a fixture untouched (#178). Never served, and never migrated: a migration
-- reshapes the graph and claims only. NULL for an analysis stored before this column.
ALTER TABLE analyses ADD COLUMN upload_gz BLOB;

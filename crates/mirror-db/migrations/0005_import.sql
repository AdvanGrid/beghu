-- The import (crates/server/src/import.rs). A repo's import runs in phases, across every repo
-- being imported, and a restart can stop it anywhere: `importing` is 1 from when the repo joins
-- the synced set until its last phase lands, so the next use of the account resumes it. A repo
-- the mirror already holds whole (every repo of a mirror from before this migration, and every
-- fixture repo) is 0.
ALTER TABLE repos ADD COLUMN importing INTEGER NOT NULL DEFAULT 0;

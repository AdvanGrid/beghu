-- Faults the server's tests put into a mirror, where nothing short of the mirror itself can
-- fail: no app code calls these.

-- From now on, deleting an item of a repo that isn't synced fails, so every unsync stops at its
-- first chunk, as one would on a persistent failure.
-- name: fault_stall_unsyncs :exec
CREATE TRIGGER fault_stall_unsyncs BEFORE DELETE ON items
WHEN old.repo_id IN (SELECT r.id FROM repos r WHERE r.synced = 0)
BEGIN SELECT RAISE(ABORT, 'unsyncs stalled'); END;

-- name: fault_unstall_unsyncs :exec
DROP TRIGGER IF EXISTS fault_stall_unsyncs;

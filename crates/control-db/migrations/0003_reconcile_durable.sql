-- Reconciliation's state that must outlive a restart (crates/server/src/reconcile).

-- The first delivery time of the oldest delivery the redelivery job asked GitHub to send again
-- (or couldn't) and hasn't yet seen arrive: the next check reads the log back to it, so a
-- redelivery that fails is asked for again. NULL when nothing is outstanding.
ALTER TABLE checkpoints ADD COLUMN redelivery_from INTEGER;

-- How many times the account has been marked `needs_resync`: a repair clears the mark only if
-- no new mark came while it ran.
ALTER TABLE accounts ADD COLUMN resync_marks INTEGER NOT NULL DEFAULT 0;

-- When the user last asked for a Resync, which they may do once an hour.
ALTER TABLE accounts ADD COLUMN resync_asked_at INTEGER;

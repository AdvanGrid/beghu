-- Guards that keep a sweep (crates/server/src/reconcile) from undoing what a webhook wrote while
-- it read GitHub. A sweep records the mirror's `seq` before it reads, and leaves alone what was
-- written after.

-- The transaction that last wrote the label: from a `label` delivery, an issue payload, the
-- import or a sweep. 0 for labels written before this column.
ALTER TABLE labels ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

-- The transaction that last changed the item's relationships from a delivery or its read-back
-- (a relationship added or removed leaves no row to carry a `seq` when it's gone). 0 for none
-- since this column.
ALTER TABLE items ADD COLUMN edges_seq INTEGER NOT NULL DEFAULT 0;

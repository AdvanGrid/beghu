-- Webhooks arrive late and out of order. A milestone carries GitHub's `updated_at`, so an older
-- milestone delivery is refused as an older item or comment is. NULL until a delivery sets it.
ALTER TABLE milestones ADD COLUMN updated_at INTEGER;

-- The ids webhooks deleted, by kind, so that an older delivery arriving after the delete can't
-- bring the row back. GitHub never reuses an id. Not the client-facing tombstones the spec
-- dropped: nothing outside the server reads these.
CREATE TABLE deleted (
  kind TEXT NOT NULL CHECK (kind IN ('item', 'comment', 'label', 'milestone')),
  id INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
) WITHOUT ROWID;

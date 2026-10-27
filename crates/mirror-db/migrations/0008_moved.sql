-- Issues transferred away (`issues.transferred`, or `issues.opened` with `changes.old_issue`),
-- by their old id: where each went, so the detail of the old id says so ("moved to …"), and opens
-- the new one when the mirror holds it. Like `deleted`, server-side only; the old id is also in
-- `deleted`, so no older delivery brings it back.
CREATE TABLE moved (
  id INTEGER PRIMARY KEY,
  to_id INTEGER NOT NULL,
  -- Where the new issue was when it moved, for when the mirror doesn't hold it.
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL
);

-- An issue's or PR's body history (crates/server/src/history.rs): its earlier versions, read from
-- GitHub's `userContentEdits` when Diff mode opens on it and kept here, so the next open reads no
-- GitHub. `for_digest` is the digest (hex) of the mirror's body the history was read for: once the
-- body changes, the history is read again. Server-side only, never synced: a cache, rebuilt from
-- GitHub whenever it's missing.
CREATE TABLE body_history (
  item_id INTEGER PRIMARY KEY,
  for_digest TEXT NOT NULL,
  -- Unix seconds.
  fetched_at INTEGER NOT NULL,
  -- The oldest revision kept is the body as it was created (GitHub's `includesCreatedEdit`).
  includes_created INTEGER NOT NULL,
  -- When the current body came about (Unix seconds) and who made it (login; NULL for a deleted
  -- GitHub account): the oldest of the newest revisions that are the mirror's body. Both NULL
  -- when GitHub lists none such (never edited, or the mirror ahead of what GitHub listed).
  current_edited_at INTEGER,
  current_editor TEXT
);

-- The revisions, newest first by `position` (0 the newest). Not keyed on `edited_at`: two edits
-- in one second are two revisions. `body` is NULL for a revision deleted from the history.
CREATE TABLE body_revisions (
  item_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  -- Unix seconds.
  edited_at INTEGER NOT NULL,
  -- The editor's login; NULL for a deleted GitHub account.
  editor TEXT,
  body TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, position)
) WITHOUT ROWID;

-- An item that goes takes its history with it.
CREATE TRIGGER body_history_delete AFTER DELETE ON items BEGIN
  DELETE FROM body_history WHERE item_id = old.id;
  DELETE FROM body_revisions WHERE item_id = old.id;
END;

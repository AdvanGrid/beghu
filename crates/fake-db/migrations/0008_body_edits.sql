-- Each issue's and PR's body revisions (`history.rs`), as GraphQL's `userContentEdits` lists
-- them: one per body change, the whole body as of it, by whom and when, `seq` their order (the
-- newest highest). `created` marks the body as the issue was created, recorded with the first
-- change (`includesCreatedEdit`). A revision deleted from the history keeps its row with
-- `deleted_at` set and no body. An item never edited has none.
CREATE TABLE fake_body_edits (
  seq INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL,
  editor_id INTEGER,
  edited_at INTEGER NOT NULL,
  body TEXT,
  created INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  deleted_by INTEGER
);
CREATE INDEX fake_body_edits_item ON fake_body_edits(item_id, seq);

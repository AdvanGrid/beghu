-- An issue's or PR's body history (crates/server/src/history.rs), cached per item and keyed by
-- the digest of the body it was read for.

-- The item's GraphQL node id, which `userContentEdits` is read through.
-- name: item_node_id :opt
-- param: id i64
SELECT i.node_id FROM items i WHERE i.id = :id;

-- What's cached of the item's history: the digest it was read for, whether it reaches back to
-- the body as created, and when and by whom the current body came about.
-- name: body_history :opt
-- param: item_id i64
SELECT h.for_digest, h.includes_created AS "includes_created: bool", h.current_edited_at,
  h.current_editor
FROM body_history h WHERE h.item_id = :item_id;

-- The cached revisions, newest first.
-- name: body_revisions :many
-- param: item_id i64
SELECT r.edited_at, r.editor, r.body, r.deleted AS "deleted: bool"
FROM body_revisions r WHERE r.item_id = :item_id ORDER BY r.position;

-- Only while the item is in the mirror: one deleted while GitHub was read leaves no history.
-- name: put_body_history :exec
-- param: item_id i64
-- param: for_digest &str
-- param: fetched_at i64
-- param: includes_created bool
-- param: current_edited_at Option<i64>
-- param: current_editor Option<&str>
INSERT INTO body_history (item_id, for_digest, fetched_at, includes_created, current_edited_at,
  current_editor)
SELECT :item_id, :for_digest, :fetched_at, :includes_created, :current_edited_at, :current_editor
WHERE EXISTS (SELECT 1 FROM items i WHERE i.id = :item_id)
ON CONFLICT (item_id) DO UPDATE SET
  for_digest = excluded.for_digest, fetched_at = excluded.fetched_at,
  includes_created = excluded.includes_created, current_edited_at = excluded.current_edited_at,
  current_editor = excluded.current_editor;

-- name: clear_body_revisions :exec
-- param: item_id i64
DELETE FROM body_revisions WHERE item_id = :item_id;

-- Only while the item is in the mirror, as `put_body_history`.
-- name: put_body_revision :exec
-- param: item_id i64
-- param: position i64
-- param: edited_at i64
-- param: editor Option<&str>
-- param: body Option<&str>
-- param: deleted bool
INSERT INTO body_revisions (item_id, position, edited_at, editor, body, deleted)
SELECT :item_id, :position, :edited_at, :editor, :body, :deleted
WHERE EXISTS (SELECT 1 FROM items i WHERE i.id = :item_id);

-- Body revisions (`fake_body_edits`, `history.rs`).

-- name: has_body_edits :one
-- param: item_id i64
SELECT EXISTS (SELECT 1 FROM fake_body_edits e WHERE e.item_id = :item_id) AS "x!: bool";

-- name: includes_created_edit :one
-- param: item_id i64
SELECT EXISTS (SELECT 1 FROM fake_body_edits e WHERE e.item_id = :item_id AND e.created = 1)
  AS "x!: bool";

-- name: add_body_edit :exec
-- param: item_id i64
-- param: editor_id Option<i64>
-- param: edited_at i64
-- param: body Option<&str>
-- param: created bool
INSERT INTO fake_body_edits (item_id, editor_id, edited_at, body, created)
VALUES (:item_id, :editor_id, :edited_at, :body, :created);

-- A page of an item's revisions, newest first, older than `before` (a `seq`).
-- name: body_edits_page :many
-- param: item_id i64
-- param: before i64
-- param: limit i64
SELECT e.seq, e.editor_id, e.edited_at, e.body, e.deleted_at, e.deleted_by
FROM fake_body_edits e
WHERE e.item_id = :item_id AND e.seq < :before
ORDER BY e.seq DESC LIMIT :limit;

-- name: body_edit_count :one
-- param: item_id i64
SELECT count(*) AS "n!: i64" FROM fake_body_edits e WHERE e.item_id = :item_id;

-- The item's `n`th revision, newest first from 0.
-- name: nth_body_edit :opt
-- param: item_id i64
-- param: n i64
SELECT e.seq FROM fake_body_edits e WHERE e.item_id = :item_id
ORDER BY e.seq DESC LIMIT 1 OFFSET :n;

-- A revision deleted from the history, as its "Delete revision from history" does on GitHub.
-- name: delete_body_edit :exec
-- param: seq i64
-- param: deleted_by i64
-- param: at i64
UPDATE fake_body_edits SET body = NULL, deleted_at = :at, deleted_by = :deleted_by
WHERE seq = :seq AND deleted_at IS NULL;

-- name: delete_item_body_edits :exec
-- param: item_id i64
DELETE FROM fake_body_edits WHERE item_id = :item_id;

-- The items the fixture's body history is seeded on: in the synced repos, numbers 3, 8, 13, …
-- up to 58 of each, issues and PRs, with a body of three or more paragraphs.
-- name: history_seed_items :many
SELECT i.id, i.body AS "body!", i.author_id, i.created_at AS "created_at!", i.updated_at AS "updated_at!"
FROM repos r JOIN items i ON i.repo_id = r.id
WHERE r.synced = 1 AND r.installation_id IS NOT NULL AND i.is_stub = 0
  AND i.number <= 58 AND i.number % 5 = 3 AND i.body IS NOT NULL
  AND i.created_at IS NOT NULL AND i.updated_at IS NOT NULL
  AND length(i.body) - length(replace(i.body, char(10) || char(10), '')) >= 4
ORDER BY i.id;

-- A transferred issue keeps its body history under its new id.
-- name: move_body_edits :exec
-- param: old i64
-- param: new i64
UPDATE fake_body_edits SET item_id = :new WHERE item_id = :old;

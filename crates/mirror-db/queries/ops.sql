-- Writes (`POST /api/ops`): the issue an op names, with what its GitHub call needs. A stub, or an
-- item whose repo isn't synced, comes back too: the caller refuses it.

-- name: op_target :opt
-- param: id i64
SELECT i.id, i.kind, i.is_stub AS "is_stub: bool", r.synced AS "synced: bool", i.repo_id,
       r.owner, r.name AS repo, i.number, i.author_id AS "author_id?"
FROM items i JOIN repos r ON r.id = i.repo_id
WHERE i.id = :id;

-- The newest comment the mirror holds on an item, 0 for none: a comment that may have been
-- posted after it was read can only be one with a greater id.
-- name: newest_comment_id :one
-- param: item_id i64
SELECT coalesce(max(c.id), 0) AS "id!: i64" FROM comments c WHERE c.item_id = :item_id;

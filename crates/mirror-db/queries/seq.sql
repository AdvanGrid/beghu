-- The first statement of every write transaction (see `Mirrors::write`).
-- name: bump_seq :one
UPDATE seq SET value = value + 1 WHERE id = 1 RETURNING value;

-- Items written after transaction `since`, for caches keyed on `seq`.
-- name: items_changed_since :many
-- param: since i64
SELECT i.id, i.seq FROM items i WHERE i.seq > :since ORDER BY i.seq, i.id;

-- The list: one id query per sort and direction, each with the fragment that starts the page
-- after a cursor (`after_*`) and the one that ends a live refetch at it, inclusive
-- (`through_*`, its complement). A query returns each row's sort key beside its id, the same
-- expression it orders by, so the cursor (`<key>.<id>`) and the fragments' row-value
-- comparisons agree.
-- Descending is the default; `-asc` reverses the key and the id tie-break together, so one index
-- (0003_list_sorts.sql) serves both directions. `closed` and `commented` are the exceptions:
-- never-closed and uncommented items go last both ways, so their ascending keys differ.
--
-- `updated_at` and `created_at` are ordered by as they are, no COALESCE, so `items_list` and
-- the 0003 indexes serve them. They're never NULL here: only stubs leave the timestamps unset
-- (the item writes take them as `i64`s; GitHub always sends them) and the list skips stubs. Were
-- a listed row ever NULL, reading its key as an `i64` fails the request rather than writing a
-- cursor the comparison would disagree with.
--
-- A key under COALESCE (`closed`, `commented`) also gets a plain range before its row value:
-- SQLite uses a row-value comparison as an index range only over plain columns, so without it
-- a deep page walks every row before the cursor, and a refetch every row after it. The range
-- is the row value's first half, so it changes no result.
--
-- With no kind (`is:any`, or `is:issue is:pr`) only `sort:updated` has an index
-- (`items_updated_any_kind`). Every other sort reads all the view's rows and sorts them: about
-- 20 ms at 50k. An accepted cost, rather than 8 more indexes every item write pays for; the
-- plan check (perf/fixture/tests/plans.rs) holds it apart.

-- `sort:updated`: newest update first.
-- name: ids_updated :many
-- param: limit i64
SELECT i.id, i.updated_at AS "key!: i64"
FROM items i
WHERE i.is_stub = 0 AND /* filter */
ORDER BY i.updated_at DESC, i.id DESC
LIMIT :limit;

-- name: after_updated :fragment
-- param: key i64
-- param: id i64
(i.updated_at, i.id) < (:key, :id)

-- name: through_updated :fragment
-- param: key i64
-- param: id i64
(i.updated_at, i.id) >= (:key, :id)

-- `sort:updated-asc`: the reverse.
-- name: ids_updated_asc :many
-- param: limit i64
SELECT i.id, i.updated_at AS "key!: i64"
FROM items i
WHERE i.is_stub = 0 AND /* filter */
ORDER BY i.updated_at ASC, i.id ASC
LIMIT :limit;

-- name: after_updated_asc :fragment
-- param: key i64
-- param: id i64
(i.updated_at, i.id) > (:key, :id)

-- name: through_updated_asc :fragment
-- param: key i64
-- param: id i64
(i.updated_at, i.id) <= (:key, :id)

-- `sort:created`: newest first.
-- name: ids_created :many
-- param: limit i64
SELECT i.id, i.created_at AS "key!: i64"
FROM items i
WHERE i.is_stub = 0 AND /* filter */
ORDER BY i.created_at DESC, i.id DESC
LIMIT :limit;

-- name: after_created :fragment
-- param: key i64
-- param: id i64
(i.created_at, i.id) < (:key, :id)

-- name: through_created :fragment
-- param: key i64
-- param: id i64
(i.created_at, i.id) >= (:key, :id)

-- `sort:created-asc`: the reverse.
-- name: ids_created_asc :many
-- param: limit i64
SELECT i.id, i.created_at AS "key!: i64"
FROM items i
WHERE i.is_stub = 0 AND /* filter */
ORDER BY i.created_at ASC, i.id ASC
LIMIT :limit;

-- name: after_created_asc :fragment
-- param: key i64
-- param: id i64
(i.created_at, i.id) > (:key, :id)

-- name: through_created_asc :fragment
-- param: key i64
-- param: id i64
(i.created_at, i.id) <= (:key, :id)

-- `sort:closed`: most recently closed first; never closed last.
-- name: ids_closed :many
-- param: limit i64
SELECT i.id, COALESCE(i.closed_at, 0) AS "key!: i64"
FROM items i
WHERE i.is_stub = 0 AND /* filter */
ORDER BY COALESCE(i.closed_at, 0) DESC, i.id DESC
LIMIT :limit;

-- name: after_closed :fragment
-- param: key i64
-- param: id i64
COALESCE(i.closed_at, 0) <= :key AND (COALESCE(i.closed_at, 0), i.id) < (:key, :id)

-- name: through_closed :fragment
-- param: key i64
-- param: id i64
COALESCE(i.closed_at, 0) >= :key AND (COALESCE(i.closed_at, 0), i.id) >= (:key, :id)

-- `sort:closed-asc`: least recently closed first; never closed still last.
-- name: ids_closed_asc :many
-- param: limit i64
SELECT i.id, COALESCE(i.closed_at, 9223372036854775807) AS "key!: i64"
FROM items i
WHERE i.is_stub = 0 AND /* filter */
ORDER BY COALESCE(i.closed_at, 9223372036854775807) ASC, i.id ASC
LIMIT :limit;

-- name: after_closed_asc :fragment
-- param: key i64
-- param: id i64
COALESCE(i.closed_at, 9223372036854775807) >= :key
  AND (COALESCE(i.closed_at, 9223372036854775807), i.id) > (:key, :id)

-- name: through_closed_asc :fragment
-- param: key i64
-- param: id i64
COALESCE(i.closed_at, 9223372036854775807) <= :key
  AND (COALESCE(i.closed_at, 9223372036854775807), i.id) <= (:key, :id)

-- `sort:commented`: most recently commented first; uncommented last.
-- name: ids_commented :many
-- param: limit i64
SELECT i.id, COALESCE(i.last_commented_at, 0) AS "key!: i64"
FROM items i
WHERE i.is_stub = 0 AND /* filter */
ORDER BY COALESCE(i.last_commented_at, 0) DESC, i.id DESC
LIMIT :limit;

-- name: after_commented :fragment
-- param: key i64
-- param: id i64
COALESCE(i.last_commented_at, 0) <= :key
  AND (COALESCE(i.last_commented_at, 0), i.id) < (:key, :id)

-- name: through_commented :fragment
-- param: key i64
-- param: id i64
COALESCE(i.last_commented_at, 0) >= :key
  AND (COALESCE(i.last_commented_at, 0), i.id) >= (:key, :id)

-- `sort:commented-asc`: least recently commented first; uncommented still last.
-- name: ids_commented_asc :many
-- param: limit i64
SELECT i.id, COALESCE(i.last_commented_at, 9223372036854775807) AS "key!: i64"
FROM items i
WHERE i.is_stub = 0 AND /* filter */
ORDER BY COALESCE(i.last_commented_at, 9223372036854775807) ASC, i.id ASC
LIMIT :limit;

-- name: after_commented_asc :fragment
-- param: key i64
-- param: id i64
COALESCE(i.last_commented_at, 9223372036854775807) >= :key
  AND (COALESCE(i.last_commented_at, 9223372036854775807), i.id) > (:key, :id)

-- name: through_commented_asc :fragment
-- param: key i64
-- param: id i64
COALESCE(i.last_commented_at, 9223372036854775807) <= :key
  AND (COALESCE(i.last_commented_at, 9223372036854775807), i.id) <= (:key, :id)

-- `sort:comments`: most comments first.
-- name: ids_comments :many
-- param: limit i64
SELECT i.id, i.comments_count AS "key!: i64"
FROM items i
WHERE i.is_stub = 0 AND /* filter */
ORDER BY i.comments_count DESC, i.id DESC
LIMIT :limit;

-- name: after_comments :fragment
-- param: key i64
-- param: id i64
(i.comments_count, i.id) < (:key, :id)

-- name: through_comments :fragment
-- param: key i64
-- param: id i64
(i.comments_count, i.id) >= (:key, :id)

-- `sort:comments-asc`: the reverse.
-- name: ids_comments_asc :many
-- param: limit i64
SELECT i.id, i.comments_count AS "key!: i64"
FROM items i
WHERE i.is_stub = 0 AND /* filter */
ORDER BY i.comments_count ASC, i.id ASC
LIMIT :limit;

-- name: after_comments_asc :fragment
-- param: key i64
-- param: id i64
(i.comments_count, i.id) > (:key, :id)

-- name: through_comments_asc :fragment
-- param: key i64
-- param: id i64
(i.comments_count, i.id) <= (:key, :id)

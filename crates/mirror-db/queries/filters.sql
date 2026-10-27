-- Filter-bar fragments. Each is a predicate over `items i`, checked as
-- `SELECT 1 FROM items i WHERE (<fragment>)`, and composed at run time with dbrt's
-- `Filter::{And, Or, Not}` into a `/* filter */` mark. Filters use `id IN (SELECT …)` over
-- covering indexes, never correlated EXISTS or catch-all `(? IS NULL OR …)` statics.

-- name: label :fragment
-- param: name &str
i.id IN (SELECT il.item_id FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE l.name = :name COLLATE NOCASE)

-- name: assignee :fragment
-- param: login &str
i.id IN (SELECT ia.item_id FROM item_assignees ia JOIN users u ON u.id = ia.user_id WHERE u.login = :login COLLATE NOCASE)

-- name: repo :fragment
-- param: name &str
i.repo_id IN (SELECT r.id FROM repos r WHERE r.name = :name COLLATE NOCASE)

-- name: state :fragment
-- param: state &str
i.state = :state

-- name: no_milestone :fragment
i.milestone_id IS NULL

-- Title or body text, as an FTS5 query.
-- name: text :fragment
-- param: q &str
i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH :q)

-- Comment text, as an FTS5 query.
-- name: comment_text :fragment
-- param: q &str
i.id IN (SELECT c.item_id FROM comments c WHERE c.id IN (SELECT rowid FROM comments_fts WHERE comments_fts MATCH :q))

-- The list's ids: issues and PRs, never stubs, newest update first.
-- name: item_ids :many
-- param: kind &str
-- param: limit i64
SELECT i.id
FROM items i
WHERE i.kind = :kind AND i.is_stub = 0 AND /* filter */
ORDER BY i.updated_at DESC, i.id DESC
LIMIT :limit;

-- Where the next page starts in the default order (newest update first, ties on id): the rows
-- after the last one shown.
-- name: updated_before :fragment
-- param: updated_at i64
-- param: id i64
(i.updated_at, i.id) < (:updated_at, :id)

-- The rows for ids a filter returned, in their order.
-- name: hydrate :many
-- param: ids &[i64]
SELECT i.id, i.kind, i.number, i.title, i.state, i.state_reason, i.updated_at, i.comments_count,
       r.owner, r.name AS repo
FROM json_each(:ids) j
JOIN items i ON i.id = j.value
JOIN repos r ON r.id = i.repo_id
ORDER BY j.key;

-- The labels on each of `ids`, for the list's rows.
-- name: hydrate_labels :many
-- param: ids &[i64]
SELECT il.item_id, l.name, l.color
FROM json_each(:ids) j
JOIN item_labels il ON il.item_id = j.value
JOIN labels l ON l.id = il.label_id
ORDER BY j.key, l.name COLLATE NOCASE;

-- The assignees of each of `ids`, for the list's rows.
-- name: hydrate_assignees :many
-- param: ids &[i64]
SELECT ia.item_id, u.login, u.avatar_url
FROM json_each(:ids) j
JOIN item_assignees ia ON ia.item_id = j.value
JOIN users u ON u.id = ia.user_id
ORDER BY j.key, u.login COLLATE NOCASE;

-- A live refetch: from the top of the default order through the last row the client shows.
-- name: updated_through :fragment
-- param: updated_at i64
-- param: id i64
(i.updated_at, i.id) >= (:updated_at, :id)

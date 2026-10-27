-- Full-text search: which of a page's rows matched in which field (the row's icons), and the
-- comment side of a search. The FTS5 query strings come from `src/search.rs`, which also holds
-- the item text fragments (`text` in filters.sql takes a column filter in its query: `{title} :
-- (…)`). Every set here is materialised once per statement (`IN (SELECT …)`), never probed per
-- row: on an index as the triggers leave it, a lookup per row costs 10–100× the set even for a
-- 25-row page (measured in `search::matched`), and a whole set of 50k rowids ~10 ms.

-- The rows of `ids` whose title or body (as the query's column filter says) matches `q`.
-- name: item_hits :many
-- param: q &str
-- param: ids &[i64]
SELECT j.value AS "id!: i64"
FROM json_each(:ids) j
WHERE j.value IN (SELECT rowid FROM items_fts WHERE items_fts MATCH :q);

-- The rows of `ids` with a comment matching `q`.
-- name: comment_hits :many
-- param: q &str
-- param: ids &[i64]
SELECT DISTINCT c.item_id AS "id!: i64"
FROM json_each(:ids) j
JOIN comments c ON c.item_id = j.value
WHERE c.id IN (SELECT rowid FROM comments_fts WHERE comments_fts MATCH :q);

-- How many rows match `q`, counting no further than `cap`: whether a word is common enough
-- that the list should walk its sort in order rather than start from the word's matches.
-- name: count_item_matches :one
-- param: q &str
-- param: cap i64
SELECT count(*) AS "n!: i64" FROM (SELECT 1 FROM items_fts WHERE items_fts MATCH :q LIMIT :cap);

-- name: count_comment_matches :one
-- param: q &str
-- param: cap i64
SELECT count(*) AS "n!: i64" FROM (SELECT 1 FROM comments_fts WHERE comments_fts MATCH :q LIMIT :cap);

-- `text` and `comment_text` (filters.sql) for a common word: the `+` keeps the planner from
-- starting at the word's matches (and sorting all of them) so that it walks the sort's index
-- and stops at the page's end, checking each row against the set, built once. A row that the
-- title and body match never builds the comment set at all.
-- name: text_walk :fragment
-- param: q &str
+i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH :q)

-- name: comment_text_walk :fragment
-- param: q &str
+i.id IN (SELECT c.item_id FROM comments_fts f CROSS JOIN comments c ON c.id = f.rowid WHERE comments_fts MATCH :q)

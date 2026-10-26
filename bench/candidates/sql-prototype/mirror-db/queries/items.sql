-- name: list_page :many
-- param: state &str
-- param: limit i64
SELECT i.id, i.number, i.title, i.state, i.updated_at, i.comments_count,
       r.name AS repo, m.title AS milestone
FROM items i
JOIN repos r ON r.id = i.repo_id
LEFT JOIN milestones m ON m.id = i.milestone_id
WHERE i.kind = 'issue' AND i.is_stub = 0 AND i.state = :state
ORDER BY i.updated_at DESC, i.id DESC
LIMIT :limit;

-- The filter bar's id query: the checker swaps `/* filter */` for `1`, and the generated
-- function takes a `&Filter` built at run time from checked fragments.
-- name: issue_ids :many
-- param: limit i64
SELECT i.id
FROM items i
WHERE i.kind = 'issue' AND i.is_stub = 0 AND /* filter */
ORDER BY i.updated_at DESC, i.id DESC
LIMIT :limit;

-- Hydrates the ids the filter returned, in their order.
-- name: hydrate :many
-- param: ids &[i64]
SELECT i.id, i.number, i.title, i.state, r.name AS repo,
       (SELECT count(*) FROM item_labels il WHERE il.item_id = i.id) AS "label_count!: i64"
FROM json_each(:ids) j
JOIN items i ON i.id = j.value
JOIN repos r ON r.id = i.repo_id
ORDER BY j.key;

-- name: item_labels :many
-- param: item_id i64
SELECT l.name, l.color
FROM item_labels il
JOIN labels l ON l.id = il.label_id
WHERE il.item_id = :item_id
ORDER BY l.name;

-- Every label of an item, with items that have none still listed once.
-- name: items_with_labels :many
-- param: repo_id i64
SELECT i.id, i.title, l.name AS label
FROM items i
LEFT JOIN item_labels il ON il.item_id = i.id
LEFT JOIN labels l ON l.id = il.label_id
WHERE i.repo_id = :repo_id
ORDER BY i.id, l.name;

-- name: detail :opt
-- param: id i64
SELECT i.id, i.number, i.title, i.body, i.state, i.updated_at,
       m.title AS milestone, p.number AS parent_number
FROM items i
LEFT JOIN milestones m ON m.id = i.milestone_id
LEFT JOIN items p ON p.id = i.parent_id
WHERE i.id = :id;

-- name: search :many
-- param: q &str
-- param: limit i64
SELECT i.id, i.title,
       bm25(items_fts, 4.0, 2.0) AS "rank!: f64",
       snippet(items_fts, 1, '[', ']', '…', 8) AS "snippet!: String"
FROM items_fts
JOIN items i ON i.id = items_fts.rowid
WHERE items_fts MATCH :q
ORDER BY 3
LIMIT :limit;

-- Sub-issues under one root, any depth.
-- name: subtree :many
-- param: root i64
WITH RECURSIVE tree(id, depth) AS (
  SELECT id, 0 FROM items WHERE id = :root
  UNION ALL
  SELECT c.id, t.depth + 1 FROM items c JOIN tree t ON c.parent_id = t.id
)
SELECT i.id, i.title, t.depth AS "depth!: i64"
FROM tree t JOIN items i ON i.id = t.id
ORDER BY t.depth, i.id;

-- Open children counted per parent, parents with none included: a CTE on the nullable side.
-- name: open_children :many
WITH counts AS (
  SELECT parent_id, count(*) AS n FROM items WHERE state = 'open' AND parent_id IS NOT NULL GROUP BY parent_id
), parents AS (
  SELECT id, title FROM items WHERE parent_id IS NULL
)
SELECT p.id, p.title, c.parent_id, c.n AS "open_children: i64"
FROM parents p
LEFT JOIN counts c ON c.parent_id = p.id
ORDER BY p.id;

-- name: upsert_item :one
-- param: id i64
-- param: repo_id i64
-- param: number i64
-- param: title &str
-- param: body Option<&str>
-- param: state &str
-- param: updated_at &str
INSERT INTO items (id, repo_id, number, kind, state, title, body, updated_at)
VALUES (:id, :repo_id, :number, 'issue', :state, :title, :body, :updated_at)
ON CONFLICT (id) DO UPDATE SET title = excluded.title, body = excluded.body,
  state = excluded.state, updated_at = excluded.updated_at
RETURNING id, updated_at;

-- name: set_state :exec
-- param: id i64
-- param: state &str
UPDATE items SET state = :state WHERE id = :id;

-- A CTE whose body has an outer join: every column read through it is nullable.
-- name: labelled_titles :many
WITH labelled AS (
  SELECT i.id, i.title, l.name AS label
  FROM items i LEFT JOIN item_labels il ON il.item_id = i.id LEFT JOIN labels l ON l.id = il.label_id
)
SELECT x.id, x.title, x.label FROM labelled x ORDER BY x.id;

-- Aggregate with no GROUP BY: one row even on an empty table, so `title` can be NULL here.
-- name: newest :one
SELECT max(i.updated_at) AS "newest: String", i.title FROM items i;

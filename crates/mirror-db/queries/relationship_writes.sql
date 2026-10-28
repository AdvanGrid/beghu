-- Relationship writes (`POST /api/ops`) and their picker: what GitHub would refuse, read from the
-- mirror before any call (loops, nesting past 8 levels, a 101st sub-issue, a 51st dependency),
-- where a reorder lands, and the issues a picker offers. GitHub caps nesting at 8 levels, so
-- every walk stops at 64 only to survive a loop a bad delivery could leave behind.

-- An item and its ancestors, nearest first, each with its level counted from the item (1).
-- name: ancestry :many
-- param: id i64
WITH RECURSIVE up(id, level) AS (
  SELECT :id, 1
  UNION
  SELECT e.src_id, u.level + 1 FROM up u CROSS JOIN relationships e
  WHERE e.kind = 'sub' AND e.dst_id = u.id AND u.level < 64
)
SELECT u.id AS "id!: i64", u.level AS "level!: i64" FROM up u ORDER BY u.level;

-- How many levels the sub-issue tree under an item has, the item itself being one.
-- name: subtree_height :one
-- param: id i64
WITH RECURSIVE down(id, level) AS (
  SELECT :id, 1
  UNION
  SELECT e.dst_id, d.level + 1 FROM down d CROSS JOIN relationships e
  WHERE e.kind = 'sub' AND e.src_id = d.id AND d.level < 64
)
SELECT max(d.level) AS "n!: i64" FROM down d;

-- How many issues block `blocked`, how many `blocker` blocks, and how many sub-issues `parent`
-- has.
-- name: relationship_counts :one
-- param: blocked i64
-- param: blocker i64
-- param: parent i64
SELECT (SELECT count(*) FROM relationships e WHERE e.kind = 'blocks' AND e.dst_id = :blocked) AS "blocked_by!: i64",
       (SELECT count(*) FROM relationships e WHERE e.kind = 'blocks' AND e.src_id = :blocker) AS "blocking!: i64",
       (SELECT count(*) FROM relationships e WHERE e.kind = 'sub' AND e.src_id = :parent) AS "children!: i64";

-- name: has_relationship :one
-- param: kind &str
-- param: src_id i64
-- param: dst_id i64
SELECT EXISTS (SELECT 1 FROM relationships e
               WHERE e.kind = :kind AND e.src_id = :src_id AND e.dst_id = :dst_id) AS "x!: bool";

-- An item's parent, with how the user knows it (`repo#n`).
-- name: parent_of :opt
-- param: child i64
SELECT e.src_id AS "id!: i64", r.name AS "repo!: String", i.number AS "number!: i64"
FROM relationships e JOIN items i ON i.id = e.src_id JOIN repos r ON r.id = i.repo_id
WHERE e.kind = 'sub' AND e.dst_id = :child;

-- A parent's sub-issues in order, with their positions.
-- name: sub_positions :many
-- param: parent i64
SELECT e.dst_id AS "id!: i64", e.position AS "position!: f64"
FROM relationships e WHERE e.kind = 'sub' AND e.src_id = :parent
ORDER BY e.position, e.dst_id;

-- An issue or PR the mirror holds by its place, a stub included, with whether its repo is synced.
-- name: item_at :opt
-- param: owner &str
-- param: repo &str
-- param: number i64
SELECT i.id, i.kind, i.is_stub AS "is_stub: bool", r.synced AS "synced: bool", i.title, i.state,
       r.owner, r.name AS repo, i.number
FROM repos r JOIN items i ON i.repo_id = r.id
WHERE r.owner = :owner COLLATE NOCASE AND r.name = :repo COLLATE NOCASE AND i.number = :number;

-- The owners of the repos the mirror knows by this name: `repo#12` names one of them.
-- name: owners_of_repo :many
-- param: name &str
SELECT r.owner, r.synced AS "synced: bool" FROM repos r WHERE r.name = :name COLLATE NOCASE
ORDER BY r.synced DESC, r.id;

-- The issues in synced repos whose title matches `q` (an `items_fts` query), the repo `first`
-- first, then most recently updated: what a relationship picker offers for title words.
-- name: relatable_matches :many
-- param: q &str
-- param: first i64
-- param: limit i64
SELECT i.id, i.kind, i.is_stub AS "is_stub: bool", r.synced AS "synced: bool", i.title, i.state,
       r.owner, r.name AS repo, i.number
FROM items i JOIN repos r ON r.id = i.repo_id
WHERE i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH :q)
  AND i.kind = 'issue' AND i.is_stub = 0 AND r.synced = 1
ORDER BY r.id <> :first, i.updated_at DESC, i.id DESC
LIMIT :limit;

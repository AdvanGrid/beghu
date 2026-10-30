-- Tree mode (`mirror_db::tree`): the sub-issue tree over a view. Its nodes are issues the list
-- could show (synced, not stubs, never PRs). Every walk is a recursive CTE over `relationships`
-- joined with `CROSS JOIN`, which keeps the planner's join order: the walk outer, each step a
-- lookup by the edge's indexes (`relationships_one_parent` up, the primary key down). A plain JOIN
-- let the planner scan every edge or item and look each up in the walk (perf/fixture's plan test).

-- `ids` (the view's matches) and every ancestor of them the tree can show, each with its parent:
-- the match and ancestor sets the tree is built from. The walk up stops at an ancestor the tree
-- can't show (a stub, a PR, an unsynced repo's issue), which so becomes no node. UNION drops a
-- node seen already, so a loop a bad delivery left behind ends the walk rather than spinning.
-- `parent` is the node's parent whether or not the tree shows it: the caller keeps only those it
-- does.
-- name: tree_up :many
-- param: ids &[i64]
WITH RECURSIVE up(id) AS (
  SELECT j.value FROM json_each(:ids) j
  UNION
  SELECT e.src_id FROM up u CROSS JOIN relationships e CROSS JOIN items i ON i.id = e.src_id
  WHERE e.kind = 'sub' AND e.dst_id = u.id AND i.is_stub = 0 AND i.kind = 'issue'
    AND EXISTS (SELECT 1 FROM repos r WHERE r.id = i.repo_id AND r.synced = 1)
)
SELECT u.id AS "id!: i64", e.src_id AS "parent?: i64", e.position AS "position?: f64"
FROM up u LEFT JOIN relationships e ON e.kind = 'sub' AND e.dst_id = u.id;

-- The children of each of `ids` the tree can show, in GitHub's order, each with its state (the
-- caller hides the closed ones under `is:open` unless a match is under them).
-- name: tree_children :many
-- param: ids &[i64]
SELECT e.src_id AS "parent!: i64", e.dst_id AS "id!: i64", i.state AS "state!: String"
FROM json_each(:ids) j
CROSS JOIN relationships e
CROSS JOIN items i ON i.id = e.dst_id
WHERE e.kind = 'sub' AND e.src_id = j.value AND i.is_stub = 0 AND i.kind = 'issue'
  AND EXISTS (SELECT 1 FROM repos r WHERE r.id = i.repo_id AND r.synced = 1)
ORDER BY j.key, e.position, e.dst_id;

-- What each of `ids` sorts by, for ordering roots that aren't matches themselves by their own
-- place in the view's sort (`tree::sort_key` reads these as the list's id queries do).
-- name: tree_sort_keys :many
-- param: ids &[i64]
SELECT i.id AS "id!: i64", i.updated_at AS "updated_at?: i64", i.created_at AS "created_at?: i64",
       i.closed_at AS "closed_at?: i64", i.last_commented_at AS "last_commented_at?: i64",
       i.comments_count AS "comments_count!: i64"
FROM json_each(:ids) j CROSS JOIN items i ON i.id = j.value;

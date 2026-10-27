-- Relationships: sub-issues (parent → child), dependencies (blocker → blocked) and relates-to
-- (smaller id → larger id), read for the list and the detail, and written from webhooks and
-- their refetches. An edge's other end may be a stub: an issue in a repo that isn't synced. An
-- item id in `deleted` never gets an edge again.

-- The open blockers of each of `ids`, at most 8 per row, with what the list's chips and hover
-- card show of each: who has it, and how many open issues block it in turn. `open_total` is how
-- many open blockers the row has in all.
-- name: row_blockers :many
-- param: ids &[i64]
SELECT b.item_id AS "item_id!: i64", b.id AS "id!: i64", b.number AS "number!: i64",
       b.title AS "title!: String", b.is_stub AS "is_stub!: bool", b.synced AS "synced!: bool",
       b.owner AS "owner!: String", b.repo AS "repo!: String", b.updated_at AS "updated_at?: i64",
       b.assignee AS "assignee?: String", b.open_blockers AS "open_blockers!: i64",
       b.open_total AS "open_total!: i64"
FROM (
  SELECT j.value AS item_id, i.id, i.number, i.title, i.is_stub, r.synced, r.owner, r.name AS repo,
         i.updated_at,
         (SELECT u.login FROM item_assignees ia JOIN users u ON u.id = ia.user_id
          WHERE ia.item_id = i.id ORDER BY u.login COLLATE NOCASE LIMIT 1) AS assignee,
         (SELECT count(*) FROM relationships x JOIN items xi ON xi.id = x.src_id
          WHERE x.kind = 'blocks' AND x.dst_id = i.id AND xi.state = 'open') AS open_blockers,
         row_number() OVER (PARTITION BY j.value ORDER BY e.seq, i.id) AS n,
         count(*) OVER (PARTITION BY j.value) AS open_total,
         j.key AS at
  FROM json_each(:ids) j
  JOIN relationships e ON e.dst_id = j.value AND e.kind = 'blocks'
  JOIN items i ON i.id = e.src_id
  JOIN repos r ON r.id = i.repo_id
  WHERE i.state = 'open'
) b
WHERE b.n <= 8
ORDER BY b.at, b.n;

-- Sub-issue progress of each of `ids` that has sub-issues: every descendant, however deep,
-- closed against total. GitHub nests at most 8 levels; the depth cap only stops a loop a bad
-- delivery could leave behind.
-- name: progress :many
-- param: ids &[i64]
WITH RECURSIVE tree(root, id, depth) AS (
  SELECT j.value, e.dst_id, 1
  FROM json_each(:ids) j CROSS JOIN relationships e
  WHERE e.kind = 'sub' AND e.src_id = j.value
  UNION
  SELECT t.root, e.dst_id, t.depth + 1
  FROM tree t CROSS JOIN relationships e
  WHERE e.kind = 'sub' AND e.src_id = t.id AND t.depth < 16
)
SELECT t.root AS "item_id!: i64", count(DISTINCT t.id) AS "total!: i64",
       count(DISTINCT CASE WHEN i.state = 'closed' THEN t.id END) AS "done!: i64"
-- CROSS JOIN keeps the tree outer: the planner would otherwise scan every item and look each up
-- in the tree (perf/fixture/tests/plans.rs).
FROM tree t CROSS JOIN items i ON i.id = t.id
GROUP BY t.root;

-- Everything an item is related to, one row per edge, as `rel`: its `parent`, its `sub` issues
-- in GitHub's order, what it is `blocked_by` and `blocking`, and what it `relates` to. With each,
-- who has it and how many open issues block it.
-- name: item_relationships :many
-- param: id i64
SELECT e.rel AS "rel!: String", i.id AS "id!: i64", i.kind AS "kind!: String",
       i.number AS "number!: i64", i.title AS "title!: String", i.state AS "state!: String",
       i.state_reason AS "state_reason?: String", i.is_stub AS "is_stub!: bool",
       r.synced AS "synced!: bool", r.owner AS "owner!: String", r.name AS "repo!: String",
       (SELECT u.login FROM item_assignees ia JOIN users u ON u.id = ia.user_id
        WHERE ia.item_id = i.id ORDER BY u.login COLLATE NOCASE LIMIT 1) AS "assignee?: String",
       (SELECT count(*) FROM relationships x JOIN items xi ON xi.id = x.src_id
        WHERE x.kind = 'blocks' AND x.dst_id = i.id AND xi.state = 'open') AS "open_blockers!: i64"
FROM (
  SELECT 'parent' AS rel, p.src_id AS other, 0.0 AS position, p.seq AS seq
  FROM relationships p WHERE p.kind = 'sub' AND p.dst_id = :id
  UNION ALL
  SELECT 'sub', c.dst_id, c.position, c.seq FROM relationships c WHERE c.kind = 'sub' AND c.src_id = :id
  UNION ALL
  SELECT 'blocked_by', b.src_id, 0.0, b.seq FROM relationships b WHERE b.kind = 'blocks' AND b.dst_id = :id
  UNION ALL
  SELECT 'blocking', b.dst_id, 0.0, b.seq FROM relationships b WHERE b.kind = 'blocks' AND b.src_id = :id
  UNION ALL
  SELECT 'relates', x.dst_id, 0.0, x.seq FROM relationships x WHERE x.kind = 'relates' AND x.src_id = :id
  UNION ALL
  SELECT 'relates', x.src_id, 0.0, x.seq FROM relationships x WHERE x.kind = 'relates' AND x.dst_id = :id
) e
JOIN items i ON i.id = e.other
JOIN repos r ON r.id = i.repo_id
ORDER BY e.rel, e.position, e.seq, i.id;

-- The edges of `kind` that touch `id`, either way round.
-- name: edges_of :many
-- param: kind &str
-- param: id i64
SELECT e.src_id AS "src_id!: i64", e.dst_id AS "dst_id!: i64", e.position AS "position?: f64"
FROM relationships e WHERE e.kind = :kind AND e.src_id = :id
UNION ALL
SELECT e.src_id, e.dst_id, e.position FROM relationships e WHERE e.kind = :kind AND e.dst_id = :id;

-- Adds an edge unless either end was deleted. Reports 0 when it was already there. A new
-- sub-issue goes last under its parent; a child's old parent must be detached first.
-- name: add_edge :exec
-- param: kind &str
-- param: src_id i64
-- param: dst_id i64
-- param: seq i64
INSERT INTO relationships (kind, src_id, dst_id, position, seq)
SELECT :kind, :src_id, :dst_id,
  CASE WHEN :kind = 'sub' THEN coalesce(
    (SELECT max(s.position) FROM relationships s WHERE s.kind = 'sub' AND s.src_id = :src_id), 0) + 1
  END,
  :seq
WHERE NOT EXISTS (SELECT 1 FROM deleted d WHERE d.kind = 'item' AND d.id IN (:src_id, :dst_id))
ON CONFLICT (kind, src_id, dst_id) DO NOTHING;

-- name: remove_edge :exec
-- param: kind &str
-- param: src_id i64
-- param: dst_id i64
DELETE FROM relationships WHERE kind = :kind AND src_id = :src_id AND dst_id = :dst_id;

-- A child has one parent: the edge to any other is dropped before a new one is added. The old
-- parent, if there was one.
-- name: detach_child :opt
-- param: child i64
-- param: parent i64
DELETE FROM relationships WHERE kind = 'sub' AND dst_id = :child AND src_id <> :parent
RETURNING src_id;

-- A refetch places a sub-issue at GitHub's position among its siblings.
-- name: set_position :exec
-- param: parent i64
-- param: child i64
-- param: position f64
-- param: seq i64
UPDATE relationships SET position = :position, seq = :seq
WHERE kind = 'sub' AND src_id = :parent AND dst_id = :child AND position <> :position;

-- A stub for an issue in a repo that isn't synced: its title and state refresh whenever an edge
-- to it is read. A synced item with the id is left alone, and a deleted id stays deleted.
-- Reports 0 when the stub was already as given.
--
-- In two steps, as `upsert_item` is (see `webhooks.sql`): a stub is in none of the list's partial
-- indexes nor FTS, so of what changes only `repo_id`/`number` are indexed (the UNIQUE place
-- index). This upsert SETs the unindexed columns; `set_stub_place` then moves it, matching no
-- row when it's already there.
-- name: upsert_stub :exec
-- param: id i64
-- param: node_id &str
-- param: repo_id i64
-- param: number i64
-- param: title &str
-- param: state &str
-- param: seq i64
INSERT INTO items (id, node_id, repo_id, number, kind, is_stub, title, state, seq)
SELECT :id, :node_id, :repo_id, :number, 'issue', 1, :title, :state, :seq
WHERE NOT EXISTS (SELECT 1 FROM deleted d WHERE d.kind = 'item' AND d.id = :id)
ON CONFLICT (id) DO UPDATE SET node_id = excluded.node_id, title = excluded.title,
  state = excluded.state, seq = excluded.seq
WHERE items.is_stub = 1 AND (items.title IS NOT excluded.title OR items.state IS NOT excluded.state
  OR items.node_id IS NOT excluded.node_id)
ON CONFLICT DO NOTHING;

-- A stub's repo and number (a transfer, or a renumbered read): stubs only.
-- name: set_stub_place :exec
-- param: id i64
-- param: repo_id i64
-- param: number i64
-- param: seq i64
UPDATE items SET repo_id = :repo_id, number = :number, seq = :seq
WHERE id = :id AND is_stub = 1 AND (repo_id IS NOT :repo_id OR number IS NOT :number);

-- The repo a stub lives in, as an unsynced repo, unless the mirror already knows it. A rename
-- updates the name.
-- name: upsert_stub_repo :exec
-- param: id i64
-- param: node_id &str
-- param: owner &str
-- param: name &str
-- param: private bool
INSERT INTO repos (id, node_id, owner, name, private, synced)
VALUES (:id, :node_id, :owner, :name, :private, 0)
ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, name = excluded.name,
  private = excluded.private;

-- Deletes the stubs among `ids` that no edge references any more.
-- name: prune_stubs :many
-- param: ids &[i64]
DELETE FROM items
WHERE is_stub = 1 AND id IN (SELECT j.value FROM json_each(:ids) j)
  AND NOT EXISTS (SELECT 1 FROM relationships e WHERE e.src_id = items.id)
  AND NOT EXISTS (SELECT 1 FROM relationships e WHERE e.dst_id = items.id)
RETURNING id;

-- The items whose rows or detail show something of `ids`: every ancestor (their progress counts
-- these), and what these block and are blocked by (the chips, and "itself blocked by n").
-- name: neighbours :many
-- param: ids &[i64]
WITH RECURSIVE up(id, depth) AS (
  SELECT e.src_id, 1 FROM json_each(:ids) j CROSS JOIN relationships e
  WHERE e.kind = 'sub' AND e.dst_id = j.value
  UNION
  SELECT e.src_id, u.depth + 1 FROM up u CROSS JOIN relationships e
  WHERE e.kind = 'sub' AND e.dst_id = u.id AND u.depth < 16
)
SELECT u.id AS "id!: i64" FROM up u
UNION
SELECT e.dst_id FROM json_each(:ids) j CROSS JOIN relationships e
WHERE e.kind = 'blocks' AND e.src_id = j.value
UNION
SELECT e.src_id FROM json_each(:ids) j CROSS JOIN relationships e
WHERE e.kind = 'blocks' AND e.dst_id = j.value;

-- The repo of each of `ids`: whether it is private, whether the account syncs it, and the App
-- installation it's synced through (none for a stub's repo).
-- name: item_repos :many
-- param: ids &[i64]
SELECT i.id AS "id!: i64", r.id AS "repo_id!: i64", r.private AS "private!: bool",
       r.installation_id AS "installation_id?: i64", r.synced AS "synced!: bool"
FROM json_each(:ids) j
JOIN items i ON i.id = j.value
JOIN repos r ON r.id = i.repo_id;

-- Whether the mirror syncs a private repo through an App installation other than
-- `installation_id`: one that installation's token can't see, so a read-back with it can't see
-- an edge into that repo either.
-- name: syncs_beyond_installation :one
-- param: installation_id i64
SELECT EXISTS (
  SELECT 1 FROM repos r
  WHERE r.synced = 1 AND r.private = 1 AND r.installation_id <> :installation_id
) AS "x!: bool";

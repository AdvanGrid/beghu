-- Focus view (`mirror_db::focus`): the issues reached down from one issue, along sub-issues
-- (parent → child) or dependencies (blocker → blocked), with each issue's linked PRs as leaves
-- and, for a PR in focus, the issues it closes. Synced issues and PRs only, never stubs. Each
-- step starts from the ids it's given, each edge a lookup by its indexes (the primary key down,
-- `relationships_by_dst` for a linked PR), joined with `CROSS JOIN` to keep that order.

-- What the focus starts from: each of `ids` the view can show, with its kind and state.
-- name: focus_items :many
-- param: ids &[i64]
SELECT i.id AS "id!: i64", i.kind AS "kind!: String", i.state AS "state!: String"
FROM json_each(:ids) j CROSS JOIN items i ON i.id = j.value
WHERE i.is_stub = 0 AND EXISTS (SELECT 1 FROM repos r WHERE r.id = i.repo_id AND r.synced = 1);

-- The children of each of `ids` in a focus along `kind` (`sub` or `blocks`): its sub-issues in
-- GitHub's order or the issues it blocks by id, then its linked PRs by id; a PR's are the issues
-- it closes, by id. Each with its kind and state.
-- name: focus_children :many
-- param: ids &[i64]
-- param: kind &str
SELECT x.parent AS "parent!: i64", i.id AS "id!: i64", i.kind AS "kind!: String",
       i.state AS "state!: String"
FROM (
  SELECT j.key AS at, 0 AS grp, e.position AS pos, e.src_id AS parent, e.dst_id AS id
  FROM json_each(:ids) j CROSS JOIN relationships e
  WHERE e.kind = :kind AND e.src_id = j.value
  UNION ALL
  SELECT j.key, 1, NULL, e.dst_id, e.src_id
  FROM json_each(:ids) j CROSS JOIN relationships e
  WHERE e.kind = 'closes' AND e.dst_id = j.value
  UNION ALL
  SELECT j.key, 0, NULL, e.src_id, e.dst_id
  FROM json_each(:ids) j CROSS JOIN relationships e
  WHERE e.kind = 'closes' AND e.src_id = j.value
) x
CROSS JOIN items i ON i.id = x.id
WHERE i.is_stub = 0 AND EXISTS (SELECT 1 FROM repos r WHERE r.id = i.repo_id AND r.synced = 1)
ORDER BY x.at, x.grp, x.pos, x.id;

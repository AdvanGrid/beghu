-- GitHub's relationships between issues, in the mirror schema's `relationships` table: sub-issues
-- (parent → child, ordered by `position`), dependencies (blocker → blocked) and relates-to
-- (smaller id → larger id). Outside edits change them; the GraphQL API reads them back. Issues
-- in repos the App isn't installed on (the fixture's stubs) are real issues here.

-- Any repo GitHub has, by `owner/name`, installed or not.
-- name: any_repo_by_full_name :opt
-- param: owner &str
-- param: name &str
SELECT r.id FROM repos r WHERE r.owner = :owner COLLATE NOCASE AND r.name = :name COLLATE NOCASE;

-- name: any_repos_by_name :many
-- param: name &str
SELECT r.id FROM repos r WHERE r.name = :name COLLATE NOCASE ORDER BY r.id;

-- Any issue, in any repo, by number.
-- name: any_issue_id :opt
-- param: repo_id i64
-- param: number i64
SELECT i.id FROM items i WHERE i.repo_id = :repo_id AND i.number = :number AND i.kind = 'issue';

-- Any issue or PR, in any repo, by number: GitHub's issues API answers a PR's number too.
-- name: any_item_id :opt
-- param: repo_id i64
-- param: number i64
SELECT i.id FROM items i WHERE i.repo_id = :repo_id AND i.number = :number;

-- name: issue_by_node_id :opt
-- param: node_id &str
SELECT i.id FROM items i WHERE i.node_id = :node_id AND i.kind = 'issue';

-- name: has_edge :one
-- param: kind &str
-- param: src_id i64
-- param: dst_id i64
SELECT EXISTS (SELECT 1 FROM relationships e
               WHERE e.kind = :kind AND e.src_id = :src_id AND e.dst_id = :dst_id) AS "x!: bool";

-- name: parent_of :opt
-- param: child i64
SELECT e.src_id FROM relationships e WHERE e.kind = 'sub' AND e.dst_id = :child;

-- How many sub-issues an issue has.
-- name: child_count :one
-- param: parent i64
SELECT count(*) AS "n!: i64" FROM relationships e WHERE e.kind = 'sub' AND e.src_id = :parent;

-- An issue and its ancestors, nearest first, each with its level counted from the issue (1).
-- name: ancestry :many
-- param: id i64
WITH RECURSIVE up(id, level) AS (
  SELECT :id, 1
  UNION
  SELECT e.src_id, u.level + 1 FROM up u CROSS JOIN relationships e
  WHERE e.kind = 'sub' AND e.dst_id = u.id AND u.level < 64
)
SELECT u.id AS "id!: i64", u.level AS "level!: i64" FROM up u ORDER BY u.level;

-- How many levels the sub-issue tree under an issue has, the issue itself being one.
-- name: subtree_height :one
-- param: id i64
WITH RECURSIVE down(id, level) AS (
  SELECT :id, 1
  UNION
  SELECT e.dst_id, d.level + 1 FROM down d CROSS JOIN relationships e
  WHERE e.kind = 'sub' AND e.src_id = d.id AND d.level < 64
)
SELECT max(d.level) AS "n!: i64" FROM down d;

-- Whether `from` blocks `to`, directly or through other issues.
-- name: blocks_transitively :one
-- param: from i64
-- param: to i64
WITH RECURSIVE reach(id, depth) AS (
  SELECT e.dst_id, 1 FROM relationships e WHERE e.kind = 'blocks' AND e.src_id = :from
  UNION
  SELECT e.dst_id, r.depth + 1 FROM reach r CROSS JOIN relationships e
  WHERE e.kind = 'blocks' AND e.src_id = r.id AND r.depth < 64
)
SELECT EXISTS (SELECT 1 FROM reach r WHERE r.id = :to) AS "x!: bool";

-- How many issues block `blocked`, and how many `blocker` blocks.
-- name: dependency_counts :one
-- param: blocked i64
-- param: blocker i64
SELECT (SELECT count(*) FROM relationships e WHERE e.kind = 'blocks' AND e.dst_id = :blocked) AS "blocked_by!: i64",
       (SELECT count(*) FROM relationships e WHERE e.kind = 'blocks' AND e.src_id = :blocker) AS "blocking!: i64";

-- A new sub-issue goes last; other kinds have no position.
-- name: add_edge :exec
-- param: kind &str
-- param: src_id i64
-- param: dst_id i64
INSERT INTO relationships (kind, src_id, dst_id, position, seq)
VALUES (:kind, :src_id, :dst_id,
  CASE WHEN :kind = 'sub' THEN coalesce(
    (SELECT max(s.position) FROM relationships s WHERE s.kind = 'sub' AND s.src_id = :src_id), 0) + 1
  END,
  -- The order edges were added in: dependencies and relates-to list oldest first.
  (SELECT coalesce(max(o.seq), 0) + 1 FROM relationships o));

-- name: remove_edge :exec
-- param: kind &str
-- param: src_id i64
-- param: dst_id i64
DELETE FROM relationships WHERE kind = :kind AND src_id = :src_id AND dst_id = :dst_id;

-- Whether a token sees a repo: the App's installation on it, the user's access to it, or its
-- being public.
-- name: repo_visible :one
-- param: repo_id i64
-- param: installation_id Option<i64>
-- param: user_id Option<i64>
SELECT EXISTS (
  SELECT 1 FROM repos r WHERE r.id = :repo_id AND (
    r.private = 0
    OR r.installation_id = :installation_id
    OR EXISTS (SELECT 1 FROM fake_permissions p WHERE p.repo_id = r.id AND p.user_id = :user_id))
) AS "x!: bool";

-- One issue as GraphQL's `Issue` shows it, with its repository.
-- name: graphql_issue :one
-- param: id i64
SELECT i.id, i.node_id, i.number, i.title, i.state, i.state_reason, i.repo_id, r.node_id AS repo_node_id,
       r.name AS repo_name, r.owner AS repo_owner, r.private AS "repo_private: bool"
FROM items i JOIN repos r ON r.id = i.repo_id
WHERE i.id = :id;

-- The issue's first assignee, if any.
-- name: first_assignee :opt
-- param: item_id i64
SELECT u.id, u.login, u.avatar_url FROM item_assignees ia JOIN users u ON u.id = ia.user_id
WHERE ia.item_id = :item_id ORDER BY u.login LIMIT 1;

-- The issues at the other end of an issue's relationships of one kind, in GitHub's order: a
-- parent's sub-issues by position, dependencies and relates-to oldest first.
-- name: sub_issues :many
-- param: parent i64
SELECT e.dst_id AS id FROM relationships e WHERE e.kind = 'sub' AND e.src_id = :parent
ORDER BY e.position, e.dst_id;

-- name: blocked_by :many
-- param: blocked i64
SELECT e.src_id AS id FROM relationships e WHERE e.kind = 'blocks' AND e.dst_id = :blocked
ORDER BY e.seq, e.src_id;

-- name: blocking :many
-- param: blocker i64
SELECT e.dst_id AS id FROM relationships e WHERE e.kind = 'blocks' AND e.src_id = :blocker
ORDER BY e.seq, e.dst_id;

-- name: relates_to :many
-- param: id i64
SELECT x.id AS "id!: i64" FROM (
  SELECT e.dst_id AS id, e.seq FROM relationships e WHERE e.kind = 'relates' AND e.src_id = :id
  UNION ALL
  SELECT e.src_id, e.seq FROM relationships e WHERE e.kind = 'relates' AND e.dst_id = :id
) x ORDER BY x.seq, x.id;

-- GitHub's "reprioritize a sub-issue", to the top: the child goes before its siblings.
-- name: move_sub_issue_first :exec
-- param: parent_id i64
-- param: child_id i64
UPDATE relationships SET position = (
  SELECT min(s.position) FROM relationships s WHERE s.kind = 'sub' AND s.src_id = :parent_id
) - 1
WHERE kind = 'sub' AND src_id = :parent_id AND dst_id = :child_id;

-- Any issue or PR by its id, with its repo: what a relationship write's body names.
-- name: item_place :opt
-- param: id i64
SELECT i.id, i.repo_id, i.number, i.kind FROM items i WHERE i.id = :id;

-- A sub-issue's place among its parent's, as GitHub's "reprioritize a sub-issue" leaves it.
-- name: set_sub_position :exec
-- param: parent_id i64
-- param: child_id i64
-- param: position f64
UPDATE relationships SET position = :position
WHERE kind = 'sub' AND src_id = :parent_id AND dst_id = :child_id;

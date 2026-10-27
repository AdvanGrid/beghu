-- Sweeps (crates/server/src/reconcile): what the mirror holds of a synced repo, to compare with
-- what GitHub has.

-- The synced repos a sweep reads: through an installation, and not importing (the import is
-- reading them already).
-- name: sweep_repos :many
SELECT r.id, r.node_id, r.owner, r.name, r.private AS "private: bool",
       r.installation_id AS "installation_id!: i64"
FROM repos r
WHERE r.synced = 1 AND r.importing = 0 AND r.installation_id IS NOT NULL
ORDER BY r.id;

-- How many issues and PRs the mirror holds of a repo, for the count check.
-- name: item_counts :one
-- param: repo_id i64
SELECT coalesce(sum(i.kind = 'issue'), 0) AS "issues!: i64",
       coalesce(sum(i.kind = 'pr'), 0) AS "prs!: i64"
FROM items i WHERE i.repo_id = :repo_id AND i.is_stub = 0;

-- Every issue and PR the mirror holds of a repo, with the transaction that last wrote it: an id
-- sweep deletes those GitHub no longer has, unless a write since the sweep began touched them.
-- name: repo_item_ids :many
-- param: repo_id i64
SELECT i.id, i.pr_id, i.kind, i.seq FROM items i
WHERE i.repo_id = :repo_id AND i.is_stub = 0
ORDER BY i.id;

-- Every comment the mirror holds on a repo's issues and PRs, for the full sweep's diff.
-- name: repo_comment_ids :many
-- param: repo_id i64
SELECT c.id, c.item_id, c.seq FROM comments c
JOIN items i ON i.id = c.item_id
WHERE i.repo_id = :repo_id AND i.is_stub = 0
ORDER BY c.id;

-- The repo's labels, with the transaction that last wrote each: a sweep removes one GitHub no
-- longer lists only if it held it before reading, and nothing wrote it since.
-- name: repo_labels :many
-- param: repo_id i64
SELECT l.id, l.name, l.seq FROM labels l WHERE l.repo_id = :repo_id ORDER BY l.id;

-- name: repo_milestones :many
-- param: repo_id i64
SELECT m.id, m.number FROM milestones m WHERE m.repo_id = :repo_id ORDER BY m.id;

-- The repo's issues that have relationships in the mirror (as either end), of the kinds
-- `kinds` names (a JSON array of `sub`, `blocks`, `relates`): whose relationships a sweep reads
-- back.
-- With only `sub`, the parents and the children: an order sweep's work list.
-- name: repo_items_with_edges :many
-- param: repo_id i64
-- param: kinds &str
SELECT i.id, i.node_id FROM items i
WHERE i.repo_id = :repo_id AND i.is_stub = 0 AND i.kind = 'issue'
  AND EXISTS (
    SELECT 1 FROM relationships e
    WHERE e.kind IN (SELECT k.value FROM json_each(:kinds) k)
      AND (e.src_id = i.id OR e.dst_id = i.id)
  )
ORDER BY i.id;

-- The parents among a repo's issues: whose children's order an order sweep reads.
-- name: repo_parents :many
-- param: repo_id i64
SELECT i.id, i.node_id FROM items i
WHERE i.repo_id = :repo_id AND i.is_stub = 0
  AND EXISTS (SELECT 1 FROM relationships e WHERE e.kind = 'sub' AND e.src_id = i.id)
ORDER BY i.id;

-- An item's repo and node id, and whether it has sub-issues: opening a parent refetches their
-- order.
-- name: item_sweep_info :opt
-- param: id i64
SELECT i.node_id, i.number, i.repo_id, r.installation_id AS "installation_id?: i64",
       EXISTS (SELECT 1 FROM relationships e WHERE e.kind = 'sub' AND e.src_id = i.id) AS "parent!: bool"
FROM items i JOIN repos r ON r.id = i.repo_id
WHERE i.id = :id AND i.is_stub = 0 AND r.synced = 1;

-- The newest `updated_at` the mirror holds of a repo's issues and PRs, and of their comments:
-- where a probe with no record of its own starts.
-- name: repo_newest :one
-- param: repo_id i64
SELECT (SELECT max(i.updated_at) FROM items i WHERE i.repo_id = :repo_id AND i.is_stub = 0) AS "items?: i64",
       (SELECT max(c.updated_at) FROM comments c JOIN items i ON i.id = c.item_id
        WHERE i.repo_id = :repo_id AND i.is_stub = 0) AS "comments?: i64";

-- The mirror's last write transaction: a sweep that deletes what GitHub no longer has keeps
-- anything written after it began.
-- name: current_seq :one
SELECT s.value FROM seq s WHERE s.id = 1;

-- What the mirror holds of an item: a sweep writes it only if GitHub's is newer (or the mirror
-- holds only a stub, or nothing), so an unchanged item is no change.
-- name: item_updated :opt
-- param: id i64
SELECT i.updated_at, i.is_stub AS "is_stub: bool" FROM items i WHERE i.id = :id;

-- name: comment_updated :opt
-- param: id i64
SELECT c.updated_at FROM comments c WHERE c.id = :id;

-- A label as GitHub listed it, read after transaction :since: renames land, unless a write since
-- then (a `label` delivery) holds something newer than the list. Reports 0 when the mirror had it
-- as it is, or kept its own.
-- name: sweep_label :exec
-- param: id i64
-- param: repo_id i64
-- param: name &str
-- param: color &str
-- param: description Option<&str>
-- param: seq i64
-- param: since i64
INSERT INTO labels (id, repo_id, name, color, description, seq)
SELECT :id, :repo_id, :name, :color, :description, :seq
WHERE NOT EXISTS (SELECT 1 FROM deleted d WHERE d.kind = 'label' AND d.id = :id)
ON CONFLICT (id) DO UPDATE SET repo_id = excluded.repo_id, name = excluded.name,
  color = excluded.color, description = excluded.description, seq = excluded.seq
WHERE labels.seq <= :since
  AND (labels.repo_id IS NOT excluded.repo_id OR labels.name IS NOT excluded.name
    OR labels.color IS NOT excluded.color OR labels.description IS NOT excluded.description);

-- A milestone as GitHub lists it now, under the `updated_at` guard. Reports 0 when the mirror
-- had it as it shows it: GitHub moves `updated_at` alone (an issue joining or closing in it, say)
-- without a webhook, and that's no change. Its `updated_at` then stays as the mirror had it.
-- name: sweep_milestone :exec
-- param: id i64
-- param: repo_id i64
-- param: number i64
-- param: title &str
-- param: state &str
-- param: due_on Option<i64>
-- param: updated_at Option<i64>
INSERT INTO milestones (id, repo_id, number, title, state, due_on, updated_at)
SELECT :id, :repo_id, :number, :title, :state, :due_on, :updated_at
WHERE NOT EXISTS (SELECT 1 FROM deleted d WHERE d.kind = 'milestone' AND d.id = :id)
ON CONFLICT (id) DO UPDATE SET repo_id = excluded.repo_id, number = excluded.number,
  title = excluded.title, state = excluded.state, due_on = excluded.due_on,
  updated_at = excluded.updated_at
WHERE (milestones.updated_at IS NULL OR excluded.updated_at >= milestones.updated_at)
  AND (milestones.repo_id IS NOT excluded.repo_id OR milestones.number IS NOT excluded.number
    OR milestones.title IS NOT excluded.title OR milestones.state IS NOT excluded.state
    OR milestones.due_on IS NOT excluded.due_on);

-- A delivery or its read-back changed (or confirmed) the item's relationships in transaction
-- :seq: a sweep that read them before leaves them alone.
-- name: touch_edges :exec
-- param: id i64
-- param: seq i64
UPDATE items SET edges_seq = :seq WHERE id = :id;

-- The transaction that last changed the item's relationships from a delivery or its read-back.
-- name: edges_seq :one
-- param: id i64
SELECT coalesce((SELECT i.edges_seq FROM items i WHERE i.id = :id), 0) AS "x!: i64";

-- Whether a `label` delivery wrote the label after transaction :seq, or deleted it.
-- name: label_landed :one
-- param: id i64
-- param: seq i64
SELECT EXISTS (SELECT 1 FROM labels l WHERE l.id = :id AND l.seq > :seq)
    OR EXISTS (SELECT 1 FROM deleted d WHERE d.kind = 'label' AND d.id = :id) AS "x!: bool";

-- Every row a mirror holds of GitHub's data, in key order and without `seq` (which counts this
-- mirror's own transactions): two mirrors of the same GitHub data read the same through these.
-- The CI check that an import through Fake GitHub rebuilds the generator's mirror exactly
-- (crates/server/tests/import.rs) compares them table by table.

-- name: dump_repos :many
SELECT r.id, r.node_id, r.owner, r.name, r.private, r.installation_id, r.synced, r.role,
       r.archived, r.importing
FROM repos r ORDER BY r.id;

-- name: dump_users :many
SELECT u.id, u.login, u.avatar_url FROM users u ORDER BY u.id;

-- name: dump_labels :many
SELECT l.id, l.repo_id, l.name, l.color, l.description FROM labels l ORDER BY l.id;

-- name: dump_milestones :many
SELECT m.id, m.repo_id, m.number, m.title, m.state, m.due_on, m.updated_at
FROM milestones m ORDER BY m.id;

-- name: dump_items :many
SELECT i.id, i.node_id, i.repo_id, i.number, i.kind, i.is_stub, i.title, i.body, i.state,
       i.state_reason, i.locked, i.author_id, i.milestone_id, i.created_at, i.updated_at,
       i.closed_at, i.last_commented_at, i.comments_count, i.pr_id, i.draft, i.merged_at,
       i.head_ref, i.base_ref, i.review_decision, i.issue_type
FROM items i ORDER BY i.id;

-- name: dump_item_labels :many
SELECT il.item_id, il.label_id FROM item_labels il ORDER BY il.item_id, il.label_id;

-- name: dump_item_assignees :many
SELECT ia.item_id, ia.user_id FROM item_assignees ia ORDER BY ia.item_id, ia.user_id;

-- name: dump_relationships :many
SELECT r.kind, r.src_id, r.dst_id, r.position FROM relationships r
ORDER BY r.kind, r.src_id, r.dst_id;

-- name: dump_comments :many
SELECT c.id, c.node_id, c.item_id, c.author_id, c.body, c.created_at, c.updated_at
FROM comments c ORDER BY c.id;

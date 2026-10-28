-- Outside edits (`POST /edit` on the control port) and the webhook payloads they send: GitHub's
-- issues, their labels, assignees and milestones, read back as GitHub would serialise them.

-- name: repo_by_full_name :opt
-- param: owner &str
-- param: name &str
SELECT r.id
FROM repos r WHERE r.owner = :owner COLLATE NOCASE AND r.name = :name COLLATE NOCASE AND r.synced = 1;

-- name: repos_by_name :many
-- param: name &str
SELECT r.id
FROM repos r WHERE r.name = :name COLLATE NOCASE AND r.synced = 1 ORDER BY r.id;

-- The repo, with its owner's type from the App's installation on it (NULL without one).
-- name: repo :one
-- param: id i64
SELECT r.id, r.node_id, r.owner, r.name, r.private AS "private: bool", r.archived AS "archived: bool",
       r.installation_id, inst.account_type AS owner_type
FROM repos r LEFT JOIN fake_installations inst ON inst.id = r.installation_id
WHERE r.id = :id;

-- The user's role on the repo, if they have access to it.
-- name: permission :opt
-- param: user_id i64
-- param: repo_id i64
SELECT p.role FROM fake_permissions p WHERE p.user_id = :user_id AND p.repo_id = :repo_id;

-- name: issue_id :opt
-- param: repo_id i64
-- param: number i64
SELECT i.id FROM items i WHERE i.repo_id = :repo_id AND i.number = :number AND i.is_stub = 0;

-- name: issue :one
-- param: id i64
SELECT i.id, i.node_id, i.repo_id, i.number, i.kind, i.title, i.body, i.state, i.state_reason,
       i.locked AS "locked: bool", i.author_id, i.milestone_id, i.created_at, i.updated_at,
       i.closed_at, i.comments_count, i.merged_at, i.draft AS "draft: bool", i.issue_type
FROM items i WHERE i.id = :id;

-- name: issue_labels :many
-- param: item_id i64
SELECT l.id, l.name, l.color, l.description
FROM item_labels il JOIN labels l ON l.id = il.label_id
WHERE il.item_id = :item_id ORDER BY l.name;

-- name: issue_assignees :many
-- param: item_id i64
SELECT u.id, u.login, u.avatar_url
FROM item_assignees ia JOIN users u ON u.id = ia.user_id
WHERE ia.item_id = :item_id ORDER BY u.login;

-- name: milestone :opt
-- param: id i64
SELECT m.id, m.number, m.title, m.state, m.due_on, m.updated_at FROM milestones m WHERE m.id = :id;

-- name: user_row :opt
-- param: id i64
SELECT u.id, u.login, u.avatar_url FROM users u WHERE u.id = :id;

-- name: update_issue :exec
-- param: id i64
-- param: title &str
-- param: body Option<&str>
-- param: state &str
-- param: state_reason Option<&str>
-- param: closed_at Option<i64>
-- param: updated_at i64
UPDATE items SET title = :title, body = :body, state = :state, state_reason = :state_reason,
  closed_at = :closed_at, updated_at = :updated_at
WHERE id = :id;

-- name: set_issue_type :exec
-- param: id i64
-- param: issue_type Option<&str>
-- param: updated_at i64
UPDATE items SET issue_type = :issue_type, updated_at = :updated_at WHERE id = :id;

-- name: label_by_name :opt
-- param: repo_id i64
-- param: name &str
SELECT l.id, l.name, l.color, l.description FROM labels l
WHERE l.repo_id = :repo_id AND l.name = :name COLLATE NOCASE;

-- name: next_label_id :one
SELECT coalesce(max(l.id), 0) + 1 AS "x!: i64" FROM labels l;

-- name: create_label :exec
-- param: id i64
-- param: repo_id i64
-- param: name &str
-- param: color &str
-- param: description Option<&str>
INSERT INTO labels (id, repo_id, name, color, description)
VALUES (:id, :repo_id, :name, :color, :description);

-- name: add_issue_label :exec
-- param: item_id i64
-- param: label_id i64
INSERT OR IGNORE INTO item_labels (item_id, label_id) VALUES (:item_id, :label_id);

-- name: remove_issue_label :exec
-- param: item_id i64
-- param: label_id i64
DELETE FROM item_labels WHERE item_id = :item_id AND label_id = :label_id;

-- name: next_comment_id :one
SELECT coalesce(max(c.id), 0) + 1 AS "id!: i64" FROM comments c;

-- name: add_comment :exec
-- param: id i64
-- param: node_id &str
-- param: item_id i64
-- param: author_id i64
-- param: body &str
-- param: at i64
INSERT INTO comments (id, node_id, item_id, author_id, body, created_at, updated_at, seq)
VALUES (:id, :node_id, :item_id, :author_id, :body, :at, :at, 0);

-- name: count_comment :exec
-- param: item_id i64
-- param: at i64
UPDATE items SET comments_count = comments_count + 1, last_commented_at = :at, updated_at = :at
WHERE id = :item_id;

-- name: add_issue_assignee :exec
-- param: item_id i64
-- param: user_id i64
INSERT OR IGNORE INTO item_assignees (item_id, user_id) VALUES (:item_id, :user_id);

-- name: remove_issue_assignee :exec
-- param: item_id i64
-- param: user_id i64
DELETE FROM item_assignees WHERE item_id = :item_id AND user_id = :user_id;

-- A repo's milestone by its number, as GitHub's REST API names it.
-- name: milestone_by_number :opt
-- param: repo_id i64
-- param: number i64
SELECT m.id FROM milestones m WHERE m.repo_id = :repo_id AND m.number = :number;

-- name: set_issue_milestone :exec
-- param: id i64
-- param: milestone_id Option<i64>
UPDATE items SET milestone_id = :milestone_id WHERE id = :id;

-- The users with a role on the repo, and the role.
-- name: repo_members :many
-- param: repo_id i64
SELECT u.id, u.login, u.avatar_url, p.role
FROM fake_permissions p JOIN users u ON u.id = p.user_id
WHERE p.repo_id = :repo_id ORDER BY u.login;

-- The users assigned to an issue or PR of the repo.
-- name: repo_assigned_users :many
-- param: repo_id i64
SELECT DISTINCT u.id, u.login, u.avatar_url
FROM items i JOIN item_assignees ia ON ia.item_id = i.id JOIN users u ON u.id = ia.user_id
WHERE i.repo_id = :repo_id AND i.is_stub = 0 ORDER BY u.login;

-- name: update_label :exec
-- param: id i64
-- param: name &str
-- param: color &str
-- param: description Option<&str>
UPDATE labels SET name = :name, color = :color, description = :description WHERE id = :id;

-- An issue deleted (by an admin, in its sidebar): its rows go, its number is remembered.
-- name: record_deleted_issue :exec
-- param: repo_id i64
-- param: number i64
INSERT OR IGNORE INTO fake_deleted_issues (repo_id, number) VALUES (:repo_id, :number);

-- name: deleted_issue :opt
-- param: repo_id i64
-- param: number i64
SELECT d.number FROM fake_deleted_issues d WHERE d.repo_id = :repo_id AND d.number = :number;

-- An issue deleted (GitHub's `deleteIssue`): it, its labels, assignees, comments and
-- relationships go.
-- name: delete_issue :exec
-- param: id i64
DELETE FROM items WHERE id = :id;

-- name: delete_issue_labels :exec
-- param: id i64
DELETE FROM item_labels WHERE item_id = :id;

-- name: delete_issue_assignees :exec
-- param: id i64
DELETE FROM item_assignees WHERE item_id = :id;

-- name: delete_issue_comments :exec
-- param: id i64
DELETE FROM comments WHERE item_id = :id;

-- name: delete_issue_relationships :exec
-- param: id i64
DELETE FROM relationships WHERE src_id = :id OR dst_id = :id;

-- A new issue, as `POST /repos/{owner}/{repo}/issues` makes it: open, by `author_id`, created and
-- updated `at`, with no comments yet. Its labels, assignees and milestone are set after.
-- name: create_issue :exec
-- param: id i64
-- param: node_id &str
-- param: repo_id i64
-- param: number i64
-- param: title &str
-- param: body Option<&str>
-- param: author_id i64
-- param: at i64
INSERT INTO items (id, node_id, repo_id, number, kind, is_stub, title, body, state, state_reason,
                   locked, author_id, created_at, updated_at, closed_at, last_commented_at,
                   comments_count, issue_type, seq)
VALUES (:id, :node_id, :repo_id, :number, 'issue', 0, :title, :body, 'open', NULL,
        0, :author_id, :at, :at, NULL, NULL, 0, NULL, 0);

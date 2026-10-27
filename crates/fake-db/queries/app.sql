-- The GitHub App's side: installation tokens, installing on and uninstalling from an account,
-- and the reads the import makes (GraphQL and REST) with an installation or user token.

-- name: insert_installation_token :exec
-- param: token &str
-- param: installation_id i64
-- param: now i64
-- param: expires_at i64
INSERT INTO fake_installation_tokens (token, installation_id, created_at, expires_at)
VALUES (:token, :installation_id, :now, :expires_at);

-- The installation behind a live installation token. A suspended installation's tokens are dead
-- (a 401 "Bad credentials"). Unverified: GitHub's docs don't say what an existing token gets
-- once its installation is suspended; check with `--github` (#118).
-- name: installation_token :opt
-- param: token &str
-- param: now i64
SELECT t.installation_id FROM fake_installation_tokens t
JOIN fake_installations i ON i.id = t.installation_id
WHERE t.token = :token AND t.expires_at > :now AND i.suspended_at IS NULL;

-- name: installation :opt
-- param: id i64
SELECT i.id, i.account_id, i.account_login, i.account_type, i.created_at, i.suspended_at
FROM fake_installations i WHERE i.id = :id;

-- The installation is suspended (at `at`), or with NULL, unsuspended.
-- name: set_installation_suspended :exec
-- param: id i64
-- param: at Option<i64>
UPDATE fake_installations SET suspended_at = :at WHERE id = :id;

-- The App's installation on an account, by the account's login.
-- name: installation_on :opt
-- param: login &str
SELECT i.id FROM fake_installations i WHERE i.account_login = :login COLLATE NOCASE;

-- name: next_installation_id :one
SELECT coalesce(max(i.id), 0) + 1 AS "id!: i64" FROM fake_installations i;

-- The repos an account owns: what installing the App on it covers ("All repositories").
-- name: owned_repos :many
-- param: owner &str
SELECT r.id FROM repos r WHERE r.owner = :owner COLLATE NOCASE AND r.synced = 1 ORDER BY r.id;

-- name: set_repo_installation :exec
-- param: repo_id i64
-- param: installation_id Option<i64>
UPDATE repos SET installation_id = :installation_id WHERE id = :repo_id;

-- name: installation_repos :many
-- param: installation_id i64
SELECT r.id FROM repos r WHERE r.installation_id = :installation_id ORDER BY r.id;

-- name: delete_installation :exec
-- param: id i64
DELETE FROM fake_installations WHERE id = :id;

-- name: revoke_installation_tokens :exec
-- param: installation_id i64
DELETE FROM fake_installation_tokens WHERE installation_id = :installation_id;

-- A repo by `owner/name`, whether or not the App is installed on it.
-- name: repo_named :opt
-- param: owner &str
-- param: name &str
SELECT r.id FROM repos r WHERE r.owner = :owner COLLATE NOCASE AND r.name = :name COLLATE NOCASE;

-- --- the import's reads ---------------------------------------------------------------------

-- An issue or PR by its node id, stubs included (GitHub has every one of them).
-- name: item_by_node :opt
-- param: node_id &str
SELECT i.id, i.repo_id, i.kind FROM items i WHERE i.node_id = :node_id;

-- A repo's issues (or PRs) in one state, oldest update first, after a (updated_at, id) cursor.
-- name: items_page :many
-- param: repo_id i64
-- param: kind &str
-- param: state &str
-- param: after_updated i64
-- param: after_id i64
-- param: limit i64
SELECT i.id FROM items i
WHERE i.repo_id = :repo_id AND i.kind = :kind AND i.state = :state AND i.is_stub = 0
  AND (i.updated_at, i.id) > (:after_updated, :after_id)
ORDER BY i.updated_at, i.id LIMIT :limit;

-- REST's issue list (issues and PRs together), in `updated` order ascending, updated after
-- `since` (GitHub's `since` is exclusive).
-- name: rest_issues_page :many
-- param: repo_id i64
-- param: open bool
-- param: closed bool
-- param: since i64
-- param: limit i64
-- param: offset i64
SELECT i.id FROM items i
WHERE i.repo_id = :repo_id AND i.is_stub = 0 AND i.updated_at > :since
  AND ((i.state = 'open' AND :open) OR (i.state = 'closed' AND :closed))
ORDER BY i.updated_at, i.id LIMIT :limit OFFSET :offset;

-- What an edge says about the issue at its other end, wherever it lives.
-- name: target :one
-- param: id i64
SELECT i.id, i.node_id, i.number, i.title, i.state, i.kind, r.id AS repo_id, r.node_id AS repo_node_id,
       r.owner, r.name, r.private AS "private: bool"
FROM items i JOIN repos r ON r.id = i.repo_id WHERE i.id = :id;

-- The issues a PR closes when it merges.
-- name: closes :many
-- param: pr_id i64
SELECT r.dst_id AS other FROM relationships r WHERE r.kind = 'closes' AND r.src_id = :pr_id ORDER BY r.dst_id;

-- name: pr_details :one
-- param: id i64
SELECT i.pr_id, i.draft AS "draft: bool", i.merged_at, i.head_ref, i.base_ref, i.review_decision
FROM items i WHERE i.id = :id;

-- An item's comments, oldest first, after a (created_at, id) cursor.
-- name: comments_page :many
-- param: item_id i64
-- param: after_created i64
-- param: after_id i64
-- param: limit i64
SELECT c.id, c.node_id, c.author_id, c.body, c.created_at, c.updated_at FROM comments c
WHERE c.item_id = :item_id AND (c.created_at, c.id) > (:after_created, :after_id)
ORDER BY c.created_at, c.id LIMIT :limit;

-- name: comment_count :one
-- param: item_id i64
SELECT count(*) AS "n!: i64" FROM comments c WHERE c.item_id = :item_id;

-- An issue's comments as REST pages them.
-- name: issue_comments_page :many
-- param: item_id i64
-- param: limit i64
-- param: offset i64
SELECT c.id, c.node_id, c.author_id, c.body, c.created_at, c.updated_at, i.number
FROM comments c JOIN items i ON i.id = c.item_id
WHERE c.item_id = :item_id ORDER BY c.created_at, c.id LIMIT :limit OFFSET :offset;

-- A repo's comments, on issues and PRs alike, in `updated` order ascending, updated after
-- `since` (exclusive, as GitHub's).
-- name: repo_comments_page :many
-- param: repo_id i64
-- param: since i64
-- param: limit i64
-- param: offset i64
SELECT c.id, c.node_id, c.author_id, c.body, c.created_at, c.updated_at, i.number
FROM comments c JOIN items i ON i.id = c.item_id
WHERE i.repo_id = :repo_id AND i.is_stub = 0 AND c.updated_at > :since
ORDER BY c.updated_at, c.id LIMIT :limit OFFSET :offset;

-- One of a repo's comments, by id, as `GET /repos/{owner}/{repo}/issues/comments/{id}` reads it.
-- name: repo_comment :opt
-- param: repo_id i64
-- param: id i64
SELECT c.id, c.node_id, c.author_id, c.body, c.created_at, c.updated_at, i.number
FROM comments c JOIN items i ON i.id = c.item_id
WHERE i.repo_id = :repo_id AND i.is_stub = 0 AND c.id = :id;

-- name: repo_labels :many
-- param: repo_id i64
-- param: limit i64
-- param: offset i64
SELECT l.id, l.name, l.color, l.description FROM labels l WHERE l.repo_id = :repo_id
ORDER BY l.name, l.id LIMIT :limit OFFSET :offset;

-- name: repo_milestone :opt
-- param: repo_id i64
-- param: number i64
SELECT m.id, m.number, m.title, m.state, m.due_on, m.updated_at FROM milestones m
WHERE m.repo_id = :repo_id AND m.number = :number;

-- name: repo_milestones :many
-- param: repo_id i64
-- param: limit i64
-- param: offset i64
SELECT m.id, m.number, m.title, m.state, m.due_on, m.updated_at FROM milestones m
WHERE m.repo_id = :repo_id ORDER BY m.number LIMIT :limit OFFSET :offset;

-- The sweeps' reads (`SweepCounts`, `SweepIssueIds`, `SweepPullIds`).
-- name: repo_by_node :opt
-- param: node_id &str
SELECT r.id FROM repos r WHERE r.node_id = :node_id;

-- name: item_count :one
-- param: repo_id i64
-- param: kind &str
SELECT count(*) AS "n!: i64" FROM items i
WHERE i.repo_id = :repo_id AND i.kind = :kind AND i.is_stub = 0;

-- A repo's issues (or PRs) by id, after `after_id`.
-- name: item_ids_page :many
-- param: repo_id i64
-- param: kind &str
-- param: after_id i64
-- param: limit i64
SELECT i.id FROM items i
WHERE i.repo_id = :repo_id AND i.kind = :kind AND i.is_stub = 0 AND i.id > :after_id
ORDER BY i.id LIMIT :limit;

-- Fixture accounts, their roles and the App's installations.

-- name: user_by_login :opt
-- param: login &str
SELECT u.id, u.login, u.avatar_url FROM users u WHERE u.login = :login;

-- name: user :opt
-- param: id i64
SELECT u.id, u.login, u.avatar_url, a.name FROM users u LEFT JOIN fake_accounts a ON a.user_id = u.id
WHERE u.id = :id;

-- name: add_account :exec
-- param: user_id i64
-- param: name &str
-- param: position i64
INSERT INTO fake_accounts (user_id, name, position) VALUES (:user_id, :name, :position);

-- name: accounts :many
SELECT u.id, u.login, a.name, u.avatar_url
FROM fake_accounts a JOIN users u ON u.id = a.user_id
ORDER BY a.position;

-- name: account_by_login :opt
-- param: login &str
SELECT u.id, u.login, a.name
FROM fake_accounts a JOIN users u ON u.id = a.user_id
WHERE u.login = :login;

-- Repos the fixture syncs: the ones the App is installed on.
-- name: installed_repos :many
SELECT r.id, r.owner, r.name, r.installation_id AS "installation_id!" FROM repos r
WHERE r.synced = 1 AND r.installation_id IS NOT NULL ORDER BY r.id;

-- name: add_permission :exec
-- param: user_id i64
-- param: repo_id i64
-- param: role &str
INSERT INTO fake_permissions (user_id, repo_id, role) VALUES (:user_id, :repo_id, :role);

-- name: add_installation :exec
-- param: id i64
-- param: account_id i64
-- param: account_login &str
-- param: account_type &str
-- param: created_at i64
INSERT INTO fake_installations (id, account_id, account_login, account_type, created_at)
VALUES (:id, :account_id, :account_login, :account_type, :created_at);

-- Installations holding at least one repo the user can see.
-- name: user_installations :many
-- param: user_id i64
SELECT i.id, i.account_id, i.account_login, i.account_type, i.created_at
FROM fake_installations i
WHERE i.id IN (SELECT r.installation_id FROM fake_permissions p JOIN repos r ON r.id = p.repo_id
               WHERE p.user_id = :user_id)
ORDER BY i.id;

-- name: user_installation_repo_count :one
-- param: user_id i64
-- param: installation_id i64
SELECT count(*) AS "n!: i64" FROM fake_permissions p JOIN repos r ON r.id = p.repo_id
WHERE p.user_id = :user_id AND r.installation_id = :installation_id;

-- name: user_installation_repos :many
-- param: user_id i64
-- param: installation_id i64
-- param: limit i64
-- param: offset i64
SELECT r.id, r.node_id, r.owner, r.name, r.private AS "private: bool", r.archived AS "archived: bool", p.role
FROM fake_permissions p JOIN repos r ON r.id = p.repo_id
WHERE p.user_id = :user_id AND r.installation_id = :installation_id
ORDER BY r.id
LIMIT :limit OFFSET :offset;

-- name: account_roles :many
-- param: user_id i64
SELECT p.repo_id, p.role FROM fake_permissions p WHERE p.user_id = :user_id ORDER BY p.repo_id;

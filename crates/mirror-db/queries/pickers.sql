-- What the detail's pickers offer: a synced repo's labels and milestones, as the mirror holds
-- them (imported whole, and kept current by `label` and `milestone` deliveries).

-- The repo, if the account syncs it.
-- name: synced_repo :opt
-- param: id i64
SELECT r.owner, r.name FROM repos r WHERE r.id = :id AND r.synced = 1;

-- name: picker_labels :many
-- param: repo_id i64
SELECT l.name, l.color, l.description FROM labels l
WHERE l.repo_id = :repo_id ORDER BY l.name COLLATE NOCASE, l.id;

-- Open ones first, each by due date (none last), then title.
-- name: picker_milestones :many
-- param: repo_id i64
SELECT m.number, m.title, m.state, m.due_on AS "due_on?" FROM milestones m
WHERE m.repo_id = :repo_id
ORDER BY m.state = 'closed', m.due_on IS NULL, m.due_on, m.title COLLATE NOCASE, m.number;

-- One of the repo's labels by name, as GitHub compares names (ignoring case), the one spelled
-- exactly so first: the one lookup by name, for the pickers' ops, the import and webhooks.
-- name: repo_label_named :opt
-- param: repo_id i64
-- param: name &str
SELECT l.id, l.name FROM labels l
WHERE l.repo_id = :repo_id AND l.name = :name COLLATE NOCASE
ORDER BY l.name = :name DESC, l.id LIMIT 1;

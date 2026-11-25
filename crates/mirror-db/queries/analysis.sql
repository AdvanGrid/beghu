-- The PR view's analysis runs (#176): the repo a run is for, the account's role on it, and the
-- issues a run serves its agent.

-- A repo the account can see (synced or not), by name: its id, its name as GitHub spells it, and
-- the account's role on it (NULL when it can't read it).
-- name: run_repo :opt
-- param: owner &str
-- param: name &str
SELECT r.id, r.owner, r.name, r.role
FROM repos r
WHERE r.name = :name COLLATE NOCASE AND r.owner = :owner COLLATE NOCASE AND r.installation_id IS NOT NULL;

-- The account's role on a repo now: NULL (or no row) once it can't read it.
-- name: repo_role :opt
-- param: id i64
SELECT r.role FROM repos r WHERE r.id = :id AND r.installation_id IS NOT NULL;

-- The issues a PR closes, as the mirror holds its closing references.
-- name: pull_closes :many
-- param: repo_id i64
-- param: number i64
SELECT r.owner AS "owner!: String", r.name AS "name!: String", i.number AS "number!: i64"
FROM items p
JOIN relationships e ON e.kind = 'closes' AND e.src_id = p.id
JOIN items i ON i.id = e.dst_id
JOIN repos r ON r.id = i.repo_id
WHERE p.repo_id = :repo_id AND p.number = :number
ORDER BY i.repo_id, i.number;

-- An issue a PR links to, by where GitHub has it: what it is, and whether the account syncs its
-- repo. No row when the mirror holds nothing there.
-- name: linked_item :opt
-- param: owner &str
-- param: name &str
-- param: number i64
SELECT i.id, i.kind, i.is_stub AS "is_stub: bool", r.synced AS "synced: bool", r.owner, r.name,
       i.number, i.title, i.body
FROM repos r JOIN items i ON i.repo_id = r.id
WHERE r.name = :name COLLATE NOCASE AND r.owner = :owner COLLATE NOCASE AND i.number = :number;

-- A linked issue's comments, oldest first, with their authors' logins.
-- name: linked_comments :many
-- param: item_id i64
SELECT u.login AS "author?", c.body
FROM comments c
LEFT JOIN users u ON u.id = c.author_id
WHERE c.item_id = :item_id
ORDER BY c.created_at, c.id;

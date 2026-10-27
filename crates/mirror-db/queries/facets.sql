-- The filter bar's suggestions: each facet's values across the synced repos, and, only for a
-- value list that stays open, how many items in the current view carry each value. The counts,
-- like the list (list.sql), read only synced repos' items: an unsync cut short leaves rows of a
-- repo no longer synced until the next reconcile finishes it.

-- Label names, one per name (case-insensitive) with one of its colours.
-- name: facet_labels :many
SELECT l.name, MIN(l.color) AS "color!: String"
FROM labels l JOIN repos r ON r.id = l.repo_id
WHERE r.synced = 1
GROUP BY l.name COLLATE NOCASE
ORDER BY l.name COLLATE NOCASE;

-- Everyone assigned to something in a synced repo. Per user, through
-- `item_assignees_by_user`, stopping at the first.
-- name: facet_assignees :many
SELECT u.login FROM users u
WHERE EXISTS (SELECT 1 FROM item_assignees ia JOIN items i ON i.id = ia.item_id
              JOIN repos r ON r.id = i.repo_id
              WHERE ia.user_id = u.id AND i.is_stub = 0 AND r.synced = 1)
ORDER BY u.login COLLATE NOCASE;

-- Everyone who opened an issue or PR in a synced repo. Per user, through `items_author`,
-- stopping at the first.
-- name: facet_authors :many
SELECT u.login FROM users u
WHERE EXISTS (SELECT 1 FROM items i JOIN repos r ON r.id = i.repo_id
              WHERE i.author_id = u.id AND i.is_stub = 0 AND r.synced = 1)
ORDER BY u.login COLLATE NOCASE;

-- Milestone titles, open ones first.
-- name: facet_milestones :many
SELECT m.title, MAX(m.state = 'open') AS "open!: bool"
FROM milestones m JOIN repos r ON r.id = m.repo_id
WHERE r.synced = 1
GROUP BY m.title COLLATE NOCASE
ORDER BY 2 DESC, m.title COLLATE NOCASE;

-- Issue type names, one per name (case-insensitive).
-- name: facet_types :many
SELECT MIN(i.issue_type) AS "name!: String" FROM items i
WHERE i.is_stub = 0 AND i.issue_type IS NOT NULL
  AND EXISTS (SELECT 1 FROM repos r WHERE r.id = i.repo_id AND r.synced = 1)
GROUP BY i.issue_type COLLATE NOCASE
ORDER BY 1 COLLATE NOCASE;

-- How many items in the view carry each label.
-- name: count_labels :many
SELECT l.name, COUNT(*) AS "count!: i64"
FROM items i
JOIN item_labels il ON il.item_id = i.id
JOIN labels l ON l.id = il.label_id
WHERE i.is_stub = 0 AND EXISTS (SELECT 1 FROM repos r WHERE r.id = i.repo_id AND r.synced = 1)
  AND /* filter */
GROUP BY l.name COLLATE NOCASE;

-- name: count_assignees :many
SELECT u.login AS name, COUNT(*) AS "count!: i64"
FROM items i
JOIN item_assignees ia ON ia.item_id = i.id
JOIN users u ON u.id = ia.user_id
WHERE i.is_stub = 0 AND EXISTS (SELECT 1 FROM repos r WHERE r.id = i.repo_id AND r.synced = 1)
  AND /* filter */
GROUP BY u.login COLLATE NOCASE;

-- name: count_authors :many
SELECT u.login AS name, COUNT(*) AS "count!: i64"
FROM items i
JOIN users u ON u.id = i.author_id
WHERE i.is_stub = 0 AND EXISTS (SELECT 1 FROM repos r WHERE r.id = i.repo_id AND r.synced = 1)
  AND /* filter */
GROUP BY u.login COLLATE NOCASE;

-- Per repo, not per name: two orgs' repos may share a name, and the server names each one as
-- the facet list does.
-- name: count_repos :many
SELECT r.owner, r.name, COUNT(*) AS "count!: i64"
FROM items i
JOIN repos r ON r.id = i.repo_id
WHERE i.is_stub = 0 AND r.synced = 1 AND /* filter */
GROUP BY r.id;

-- name: count_milestones :many
SELECT m.title AS name, COUNT(*) AS "count!: i64"
FROM items i
JOIN milestones m ON m.id = i.milestone_id
WHERE i.is_stub = 0 AND EXISTS (SELECT 1 FROM repos r WHERE r.id = i.repo_id AND r.synced = 1)
  AND /* filter */
GROUP BY m.title COLLATE NOCASE;

-- name: count_types :many
SELECT MIN(i.issue_type) AS "name!: String", COUNT(*) AS "count!: i64"
FROM items i
WHERE i.is_stub = 0 AND i.issue_type IS NOT NULL
  AND EXISTS (SELECT 1 FROM repos r WHERE r.id = i.repo_id AND r.synced = 1) AND /* filter */
GROUP BY i.issue_type COLLATE NOCASE;

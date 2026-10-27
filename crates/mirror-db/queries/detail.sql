-- The issue detail: one item's properties and body, and its comments a page at a time. Comment
-- pages are cursor-paged on (created_at, id), newest or oldest first, so a comment that arrives
-- while the user scrolls lands before page 1 (newest first) or after the last page (oldest
-- first), and never shifts the pages in between. The cursor is the position itself, not a
-- comment's id, so it holds after its comment is deleted.

-- An item's properties and body. A stub, or an item whose repo isn't synced, comes back too:
-- the caller refuses it.
-- name: item_detail :opt
-- param: id i64
SELECT i.id, i.kind, i.is_stub AS "is_stub: bool", r.synced AS "synced: bool", i.number, i.title,
       i.body, i.state, i.state_reason, i.locked AS "locked: bool", i.created_at, i.updated_at,
       i.closed_at, r.owner, r.name AS repo, u.login AS "author?",
       m.title AS "milestone_title?", m.state AS "milestone_state?", m.due_on AS "milestone_due_on?"
FROM items i
JOIN repos r ON r.id = i.repo_id
LEFT JOIN users u ON u.id = i.author_id
LEFT JOIN milestones m ON m.id = i.milestone_id
WHERE i.id = :id;

-- How many comments the mirror holds for an item.
-- name: comment_total :one
-- param: item_id i64
SELECT COUNT(*) AS "n!: i64" FROM comments c WHERE c.item_id = :item_id;

-- An item's comments, newest first, ties on id.
-- name: comments_newest :many
-- param: item_id i64
-- param: limit i64
SELECT c.id, c.body, c.created_at, c.updated_at, u.login AS "author?"
FROM comments c
LEFT JOIN users u ON u.id = c.author_id
WHERE c.item_id = :item_id AND /* filter */
ORDER BY c.created_at DESC, c.id DESC
LIMIT :limit;

-- An item's comments, oldest first, ties on id.
-- name: comments_oldest :many
-- param: item_id i64
-- param: limit i64
SELECT c.id, c.body, c.created_at, c.updated_at, u.login AS "author?"
FROM comments c
LEFT JOIN users u ON u.id = c.author_id
WHERE c.item_id = :item_id AND /* filter */
ORDER BY c.created_at, c.id
LIMIT :limit;

-- The comments that come after one in newest-first order.
-- name: comment_older_than :fragment
-- base: comments c
-- param: created_at i64
-- param: id i64
(c.created_at, c.id) < (:created_at, :id)

-- The comments from the top of a newest-first thread through one.
-- name: comment_at_or_newer :fragment
-- base: comments c
-- param: created_at i64
-- param: id i64
(c.created_at, c.id) >= (:created_at, :id)

-- The comments that come after one in oldest-first order.
-- name: comment_newer_than :fragment
-- base: comments c
-- param: created_at i64
-- param: id i64
(c.created_at, c.id) > (:created_at, :id)

-- The comments from the top of an oldest-first thread through one.
-- name: comment_at_or_older :fragment
-- base: comments c
-- param: created_at i64
-- param: id i64
(c.created_at, c.id) <= (:created_at, :id)

-- The items in the account's synced repos that a body or comment refers to, for the detail's
-- `refs` map. `refs` is a JSON array of `[owner, repo, number]`, as written: GitHub's names are
-- case-insensitive. A stub, or an item in a repo the account doesn't sync, isn't one: those link
-- out to GitHub.
-- name: referenced_items :many
-- param: refs &str
SELECT r.owner AS "owner!: String", r.name AS "repo!: String", i.number AS "number!: i64",
       i.id AS "id!: i64", i.kind AS "kind!: String", i.title AS "title!: String",
       i.state AS "state!: String", i.state_reason AS "state_reason?: String"
FROM json_each(:refs) j
JOIN repos r ON r.owner = json_extract(j.value, '$[0]') COLLATE NOCASE
            AND r.name = json_extract(j.value, '$[1]') COLLATE NOCASE
JOIN items i ON i.repo_id = r.id AND i.number = json_extract(j.value, '$[2]')
WHERE r.synced = 1 AND i.is_stub = 0;

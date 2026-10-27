-- Filter-bar fragments. Each is a predicate over `items i`, checked as
-- `SELECT 1 FROM items i WHERE (<fragment>)`, and composed at run time with dbrt's
-- `Filter::{And, Or, Not}` into a `/* filter */` mark. Filters use `id IN (SELECT …)` over
-- covering indexes, never correlated EXISTS or catch-all `(? IS NULL OR …)` statics.

-- name: label :fragment
-- param: name &str
i.id IN (SELECT il.item_id FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE l.name = :name COLLATE NOCASE)

-- name: assignee :fragment
-- param: login &str
i.id IN (SELECT ia.item_id FROM item_assignees ia JOIN users u ON u.id = ia.user_id WHERE u.login = :login COLLATE NOCASE)

-- name: repo :fragment
-- param: name &str
i.repo_id IN (SELECT r.id FROM repos r WHERE r.name = :name COLLATE NOCASE)

-- name: state :fragment
-- param: state &str
i.state = :state

-- `is:open`/`is:closed` with no kind (`is:any`, `is:issue is:pr`): checked on each row of the
-- kind-less walk in the sort's order (`items_updated_any_kind`), never looked up. The `+` keeps
-- the planner off `items_list`: with statistics it would skip-scan that over both kinds and then
-- sort every row of the state, 4 ms against 0.1 ms at 50k.
-- name: state_any_kind :fragment
-- param: state &str
+i.state = :state

-- name: kind :fragment
-- param: kind &str
i.kind = :kind

-- name: assignee_id :fragment
-- param: id i64
i.id IN (SELECT ia.item_id FROM item_assignees ia WHERE ia.user_id = :id)

-- name: author :fragment
-- param: login &str
i.author_id IN (SELECT u.id FROM users u WHERE u.login = :login COLLATE NOCASE)

-- name: author_id :fragment
-- param: id i64
i.author_id = :id

-- `repo:owner/name`.
-- name: repo_full :fragment
-- param: owner &str
-- param: name &str
i.repo_id IN (SELECT r.id FROM repos r WHERE r.name = :name COLLATE NOCASE AND r.owner = :owner COLLATE NOCASE)

-- By title: the same title in several repos is one milestone to the filter bar.
-- name: milestone :fragment
-- param: title &str
i.milestone_id IN (SELECT m.id FROM milestones m WHERE m.title = :title COLLATE NOCASE)

-- `type:`, by the issue type's name.
-- name: issue_type :fragment
-- param: name &str
i.issue_type = :name COLLATE NOCASE

-- For `no:label` and `no:assignee`, under NOT.
-- name: has_label :fragment
i.id IN (SELECT il.item_id FROM item_labels il)

-- name: has_assignee :fragment
i.id IN (SELECT ia.item_id FROM item_assignees ia)

-- name: no_milestone :fragment
i.milestone_id IS NULL

-- Title or body text, as an FTS5 query.
-- name: text :fragment
-- param: q &str
i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH :q)

-- Comment text, as an FTS5 query. The matches are joined to their comments in the order FTS5
-- returns them (`CROSS JOIN` keeps it), never first collected as a set of their own: for a common
-- word at 50k that halves the cost (~0.15 s for 280k comments).
-- name: comment_text :fragment
-- param: q &str
i.id IN (SELECT c.item_id FROM comments_fts f CROSS JOIN comments c ON c.id = f.rowid WHERE comments_fts MATCH :q)

-- The rows for ids a filter returned, in their order.
-- name: hydrate :many
-- param: ids &[i64]
SELECT i.id, i.kind, i.number, i.title, i.state, i.state_reason, i.created_at, i.updated_at,
       i.closed_at, i.last_commented_at, i.comments_count, i.issue_type, r.owner, r.name AS repo
FROM json_each(:ids) j
JOIN items i ON i.id = j.value
JOIN repos r ON r.id = i.repo_id
ORDER BY j.key;

-- The labels on each of `ids`, for the list's rows.
-- name: hydrate_labels :many
-- param: ids &[i64]
SELECT il.item_id, l.name, l.color
FROM json_each(:ids) j
JOIN item_labels il ON il.item_id = j.value
JOIN labels l ON l.id = il.label_id
ORDER BY j.key, l.name COLLATE NOCASE;

-- The assignees of each of `ids`, for the list's rows.
-- name: hydrate_assignees :many
-- param: ids &[i64]
SELECT ia.item_id, u.login, u.avatar_url
FROM json_each(:ids) j
JOIN item_assignees ia ON ia.item_id = j.value
JOIN users u ON u.id = ia.user_id
ORDER BY j.key, u.login COLLATE NOCASE;

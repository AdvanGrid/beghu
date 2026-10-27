-- Issues moving: transferred to another repo of the same owner, converted to a discussion, and
-- repos archived. See `crates/fake-github/src/moves.rs`.

-- An id GitHub gives no other issue again: the issue was deleted, or transferred away.
-- name: retire_id :exec
-- param: id i64
INSERT OR IGNORE INTO fake_retired_ids (id) VALUES (:id);

-- The id a new issue gets: past every issue's, and past every retired one.
-- name: next_issue_id :one
SELECT max(coalesce((SELECT max(i.id) FROM items i), 0),
           coalesce((SELECT max(r.id) FROM fake_retired_ids r), 0)) + 1 AS "id!: i64";

-- The number a new issue or discussion gets in a repo: past every number the repo has used, its
-- issues', PRs' and discussions', and those of issues deleted or transferred away.
-- name: next_number :one
-- param: repo_id i64
SELECT max(
  coalesce((SELECT max(i.number) FROM items i WHERE i.repo_id = :repo_id), 0),
  coalesce((SELECT max(d.number) FROM fake_deleted_issues d WHERE d.repo_id = :repo_id), 0),
  coalesce((SELECT max(t.number) FROM fake_transferred_issues t WHERE t.repo_id = :repo_id), 0),
  coalesce((SELECT max(s.number) FROM fake_discussions s WHERE s.repo_id = :repo_id), 0)
) + 1 AS "n!: i64";

-- The issue a transfer makes: a copy of `old_id` (its text, state, author, dates and counts) as
-- a new issue of `repo_id`, with a new id, node id and number, updated `at` the transfer. GitHub
-- keeps `created_at`.
-- name: copy_issue :exec
-- param: old_id i64
-- param: new_id i64
-- param: node_id &str
-- param: repo_id i64
-- param: number i64
-- param: at i64
INSERT INTO items (id, node_id, repo_id, number, kind, is_stub, title, body, state, state_reason,
                   locked, author_id, created_at, updated_at, closed_at, last_commented_at,
                   comments_count, issue_type, seq)
SELECT :new_id, :node_id, :repo_id, :number, o.kind, 0, o.title, o.body, o.state, o.state_reason,
       o.locked, o.author_id, o.created_at, :at, o.closed_at, o.last_commented_at,
       o.comments_count, o.issue_type, 0
FROM items o WHERE o.id = :old_id;

-- The labels a transfer keeps: those the destination has a label of the same name for.
-- name: copy_labels_by_name :exec
-- param: old_id i64
-- param: new_id i64
-- param: repo_id i64
INSERT OR IGNORE INTO item_labels (item_id, label_id)
SELECT :new_id, d.id
FROM item_labels il JOIN labels l ON l.id = il.label_id
JOIN labels d ON d.repo_id = :repo_id AND d.name = l.name COLLATE NOCASE
WHERE il.item_id = :old_id;

-- The milestone a transfer keeps: the destination's of the same title and due date, if any.
-- name: copy_milestone_by_title :exec
-- param: old_id i64
-- param: new_id i64
-- param: repo_id i64
UPDATE items SET milestone_id = (
  SELECT d.id FROM items o JOIN milestones m ON m.id = o.milestone_id
  JOIN milestones d ON d.repo_id = :repo_id AND d.title = m.title AND d.due_on IS m.due_on
  WHERE o.id = :old_id
  ORDER BY d.id LIMIT 1)
WHERE id = :new_id;

-- name: copy_assignees :exec
-- param: old_id i64
-- param: new_id i64
INSERT OR IGNORE INTO item_assignees (item_id, user_id)
SELECT :new_id, a.user_id FROM item_assignees a WHERE a.item_id = :old_id;

-- A transferred issue's comments go with it.
-- name: move_comments :exec
-- param: old_id i64
-- param: new_id i64
UPDATE comments SET item_id = :new_id WHERE item_id = :old_id;

-- The transferred issue's sub-issues are the new issue's: moved in place, ahead of
-- `repoint_relationships`, since a child has one parent and a copy would collide with its row for
-- the old one.
-- name: repoint_children :exec
-- param: old_id i64
-- param: new_id i64
UPDATE OR IGNORE relationships SET src_id = :new_id
WHERE kind = 'sub' AND src_id = :old_id AND dst_id <> :new_id;

-- A transferred issue's relationships all name the new issue (measured: every link survives, and
-- each linked issue now points at the new one). Relates-to keeps its smaller id first.
-- name: repoint_relationships :exec
-- param: old_id i64
-- param: new_id i64
INSERT INTO relationships (kind, src_id, dst_id, position, seq)
SELECT x.kind,
       CASE WHEN x.kind = 'relates' THEN min(x.s, x.d) ELSE x.s END,
       CASE WHEN x.kind = 'relates' THEN max(x.s, x.d) ELSE x.d END,
       x.position, x.seq
FROM (SELECT e.kind,
             CASE WHEN e.src_id = :old_id THEN :new_id ELSE e.src_id END AS s,
             CASE WHEN e.dst_id = :old_id THEN :new_id ELSE e.dst_id END AS d,
             e.position, e.seq
      FROM relationships e WHERE e.src_id = :old_id OR e.dst_id = :old_id) x
WHERE x.s <> x.d
ON CONFLICT DO NOTHING;

-- name: record_transferred_issue :exec
-- param: repo_id i64
-- param: number i64
-- param: old_id i64
-- param: new_id i64
INSERT OR REPLACE INTO fake_transferred_issues (repo_id, number, old_id, new_id)
VALUES (:repo_id, :number, :old_id, :new_id);

-- Where a transferred issue's old number now leads: the issue it became, wherever that is now.
-- name: transferred_issue :opt
-- param: repo_id i64
-- param: number i64
SELECT t.new_id FROM fake_transferred_issues t WHERE t.repo_id = :repo_id AND t.number = :number;

-- The new issue's repo and number, if it's still an issue (not deleted since).
-- name: issue_place :opt
-- param: id i64
SELECT r.id AS repo_id, r.owner, r.name, i.number FROM items i JOIN repos r ON r.id = i.repo_id
WHERE i.id = :id;

-- The edges of an issue a transfer announces again, in the order GitHub sent them: what blocks
-- it, what it blocks, then what it relates to. Sub-issue links get no delivery.
-- name: announced_edges :many
-- param: id i64
SELECT x.kind AS "kind!: String", x.src_id AS "src_id!: i64", x.dst_id AS "dst_id!: i64" FROM (
  SELECT e.kind, e.src_id, e.dst_id, 0 AS ord, e.seq FROM relationships e
  WHERE e.kind = 'blocks' AND e.dst_id = :id
  UNION ALL
  SELECT e.kind, e.src_id, e.dst_id, 1, e.seq FROM relationships e
  WHERE e.kind = 'blocks' AND e.src_id = :id
  UNION ALL
  SELECT e.kind, e.src_id, e.dst_id, 2, e.seq FROM relationships e
  WHERE e.kind = 'relates' AND (e.src_id = :id OR e.dst_id = :id)
) x ORDER BY x.ord, x.seq;

-- An issue converted to a discussion: closed (if it was open) and locked.
-- name: lock_and_close :exec
-- param: id i64
-- param: at i64
UPDATE items SET locked = 1,
  state_reason = CASE WHEN state = 'open' THEN 'completed' ELSE state_reason END,
  closed_at = CASE WHEN state = 'open' THEN :at ELSE closed_at END,
  state = 'closed', updated_at = :at
WHERE id = :id;

-- name: add_discussion :exec
-- param: repo_id i64
-- param: number i64
-- param: issue_id i64
-- param: title &str
INSERT INTO fake_discussions (repo_id, number, issue_id, title)
VALUES (:repo_id, :number, :issue_id, :title);

-- name: set_repo_archived :exec
-- param: id i64
-- param: archived bool
UPDATE repos SET archived = :archived WHERE id = :id;

-- A repo's milestone by title, as someone editing it in the web UI picks it.
-- name: milestone_by_title :opt
-- param: repo_id i64
-- param: title &str
SELECT m.id, m.number, m.title, m.state, m.due_on FROM milestones m
WHERE m.repo_id = :repo_id AND m.title = :title;

-- name: update_milestone :exec
-- param: id i64
-- param: title &str
-- param: state &str
-- param: updated_at i64
UPDATE milestones SET title = :title, state = :state, updated_at = :updated_at WHERE id = :id;

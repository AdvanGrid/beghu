-- Webhook applies. Items, comments and milestones are guarded by `updated_at`: newer or equal
-- wins, so a replay or an out-of-order older delivery never overwrites a newer row. An id in
-- `deleted` is never written again. Each `:exec` upsert reports 0 rows when a guard kept the
-- row as it was.

-- An issue or PR as a REST payload has it, in two steps so that an update rewrites only the
-- indexes over columns whose values changed. An UPDATE rewrites every index over a column it
-- SETs, changed or not (see 0003_list_sorts.sql): a DO UPDATE setting the whole row would
-- rewrite all of an item's ~15 indexes and its FTS entry on every delivery.
--
-- First `upsert_item`: a new item is inserted whole (every index written once, unavoidably);
-- an existing one passes the `updated_at` guard or not (0 rows), and if it does, only its
-- unindexed columns and `seq` are SET. Then, only when it applied, one `set_item_*` per indexed
-- column group, each of which matches no row (and so writes nothing) when its values are
-- already the payload's. `crates/server/src/webhook.rs` (`upsert_issue`) runs them all; a
-- column added to `items` belongs in exactly one of the two steps.
--
-- `issue_type` is the REST payload's `issue.type.name` (`type` is null for an untyped issue),
-- NULL for a PR: see 0004_issue_type.rebuild.sql.
-- name: upsert_item :exec
-- param: id i64
-- param: node_id &str
-- param: repo_id i64
-- param: number i64
-- param: kind &str
-- param: title &str
-- param: body Option<&str>
-- param: state &str
-- param: state_reason Option<&str>
-- param: locked bool
-- param: author_id Option<i64>
-- param: milestone_id Option<i64>
-- param: created_at Option<i64>
-- param: updated_at i64
-- param: closed_at Option<i64>
-- param: comments_count i64
-- param: issue_type Option<&str>
-- param: seq i64
INSERT INTO items (id, node_id, repo_id, number, kind, is_stub, title, body, state, state_reason,
  locked, author_id, milestone_id, created_at, updated_at, closed_at, comments_count,
  issue_type, seq)
SELECT :id, :node_id, :repo_id, :number, :kind, 0, :title, :body, :state, :state_reason,
  :locked, :author_id,
  -- A milestone deleted since is gone from the issue too.
  CASE WHEN EXISTS (SELECT 1 FROM deleted d WHERE d.kind = 'milestone' AND d.id = :milestone_id)
    THEN NULL ELSE :milestone_id END,
  :created_at, :updated_at, :closed_at, :comments_count, :issue_type, :seq
WHERE NOT EXISTS (SELECT 1 FROM deleted d WHERE d.kind = 'item' AND d.id = :id)
ON CONFLICT (id) DO UPDATE SET node_id = excluded.node_id,
  state_reason = excluded.state_reason, locked = excluded.locked,
  milestone_id = excluded.milestone_id, seq = excluded.seq
WHERE items.updated_at IS NULL OR excluded.updated_at >= items.updated_at;

-- The UNIQUE (repo_id, number) index.
-- name: set_item_place :exec
-- param: id i64
-- param: repo_id i64
-- param: number i64
UPDATE items SET repo_id = :repo_id, number = :number
WHERE id = :id AND (repo_id IS NOT :repo_id OR number IS NOT :number);

-- A stub the payload fills in becomes a full item: every partial index, and FTS.
-- name: unstub_item :exec
-- param: id i64
UPDATE items SET is_stub = 0 WHERE id = :id AND is_stub <> 0;

-- FTS (the `items_fts_update` trigger fires on an UPDATE OF either).
-- name: set_item_text :exec
-- param: id i64
-- param: title &str
-- param: body Option<&str>
UPDATE items SET title = :title, body = :body
WHERE id = :id AND (title IS NOT :title OR body IS NOT :body);

-- Every list index.
-- name: set_item_kind :exec
-- param: id i64
-- param: kind &str
UPDATE items SET kind = :kind WHERE id = :id AND kind IS NOT :kind;

-- The list indexes under a state, and the `closed` sort's.
-- name: set_item_state :exec
-- param: id i64
-- param: state &str
-- param: closed_at Option<i64>
UPDATE items SET state = :state, closed_at = :closed_at
WHERE id = :id AND (state IS NOT :state OR closed_at IS NOT :closed_at);

-- name: set_item_created :exec
-- param: id i64
-- param: created_at Option<i64>
UPDATE items SET created_at = :created_at WHERE id = :id AND created_at IS NOT :created_at;

-- name: set_item_updated :exec
-- param: id i64
-- param: updated_at i64
UPDATE items SET updated_at = :updated_at WHERE id = :id AND updated_at IS NOT :updated_at;

-- name: set_item_author :exec
-- param: id i64
-- param: author_id Option<i64>
UPDATE items SET author_id = :author_id WHERE id = :id AND author_id IS NOT :author_id;

-- name: set_item_comments :exec
-- param: id i64
-- param: comments_count i64
UPDATE items SET comments_count = :comments_count
WHERE id = :id AND comments_count IS NOT :comments_count;

-- Set by `issues` deliveries of every action, `typed` and `untyped` among them.
-- name: set_item_type :exec
-- param: id i64
-- param: issue_type Option<&str>
UPDATE items SET issue_type = :issue_type WHERE id = :id AND issue_type IS NOT :issue_type;

-- name: upsert_user :exec
-- param: id i64
-- param: login &str
-- param: avatar_url Option<&str>
INSERT INTO users (id, login, avatar_url) VALUES (:id, :login, :avatar_url)
ON CONFLICT (id) DO UPDATE SET login = excluded.login,
  avatar_url = coalesce(excluded.avatar_url, users.avatar_url);

-- A `label` delivery: it names the label as it is now. Labels carry no `updated_at`, so the
-- latest delivery applied wins.
-- name: upsert_label :exec
-- param: id i64
-- param: repo_id i64
-- param: name &str
-- param: color &str
-- param: description Option<&str>
INSERT INTO labels (id, repo_id, name, color, description)
SELECT :id, :repo_id, :name, :color, :description
WHERE NOT EXISTS (SELECT 1 FROM deleted d WHERE d.kind = 'label' AND d.id = :id)
ON CONFLICT (id) DO UPDATE SET repo_id = excluded.repo_id, name = excluded.name,
  color = excluded.color, description = excluded.description;

-- A label on an issue payload: added if the mirror lacks it, never renamed. The payload may be
-- older than a rename the mirror already has, and only `label` deliveries say what a label is
-- called now. A rename whose delivery is lost waits for a sweep.
-- name: add_label :exec
-- param: id i64
-- param: repo_id i64
-- param: name &str
-- param: color &str
-- param: description Option<&str>
INSERT INTO labels (id, repo_id, name, color, description)
SELECT :id, :repo_id, :name, :color, :description
WHERE NOT EXISTS (SELECT 1 FROM deleted d WHERE d.kind = 'label' AND d.id = :id)
ON CONFLICT (id) DO NOTHING;

-- name: delete_label :exec
-- param: id i64
DELETE FROM labels WHERE id = :id;

-- name: unlink_label :exec
-- param: label_id i64
DELETE FROM item_labels WHERE label_id = :label_id;

-- The items carrying a label: a rename changes how their rows read.
-- name: label_items :many
-- param: label_id i64
SELECT il.item_id FROM item_labels il WHERE il.label_id = :label_id ORDER BY il.item_id;

-- name: upsert_milestone :exec
-- param: id i64
-- param: repo_id i64
-- param: number i64
-- param: title &str
-- param: state &str
-- param: due_on Option<i64>
-- param: updated_at Option<i64>
INSERT INTO milestones (id, repo_id, number, title, state, due_on, updated_at)
SELECT :id, :repo_id, :number, :title, :state, :due_on, :updated_at
WHERE NOT EXISTS (SELECT 1 FROM deleted d WHERE d.kind = 'milestone' AND d.id = :id)
ON CONFLICT (id) DO UPDATE SET repo_id = excluded.repo_id, number = excluded.number,
  title = excluded.title, state = excluded.state, due_on = excluded.due_on,
  updated_at = excluded.updated_at
WHERE milestones.updated_at IS NULL OR excluded.updated_at >= milestones.updated_at;

-- name: delete_milestone :exec
-- param: id i64
DELETE FROM milestones WHERE id = :id;

-- name: clear_milestone :exec
-- param: milestone_id i64
-- param: seq i64
UPDATE items SET milestone_id = NULL, seq = :seq WHERE milestone_id = :milestone_id;

-- name: milestone_items :many
-- param: milestone_id i64
SELECT i.id FROM items i WHERE i.milestone_id = :milestone_id ORDER BY i.id;

-- name: clear_item_labels :exec
-- param: item_id i64
DELETE FROM item_labels WHERE item_id = :item_id;

-- name: link_item_label :exec
-- param: item_id i64
-- param: label_id i64
INSERT OR IGNORE INTO item_labels (item_id, label_id)
SELECT :item_id, :label_id
WHERE NOT EXISTS (SELECT 1 FROM deleted d WHERE d.kind = 'label' AND d.id = :label_id);

-- name: clear_item_assignees :exec
-- param: item_id i64
DELETE FROM item_assignees WHERE item_id = :item_id;

-- name: upsert_comment :exec
-- param: id i64
-- param: node_id &str
-- param: item_id i64
-- param: author_id Option<i64>
-- param: body &str
-- param: created_at i64
-- param: updated_at i64
-- param: seq i64
INSERT INTO comments (id, node_id, item_id, author_id, body, created_at, updated_at, seq)
SELECT :id, :node_id, :item_id, :author_id, :body, :created_at, :updated_at, :seq
WHERE NOT EXISTS (SELECT 1 FROM deleted d WHERE d.kind = 'comment' AND d.id = :id)
  AND NOT EXISTS (SELECT 1 FROM deleted d WHERE d.kind = 'item' AND d.id = :item_id)
ON CONFLICT (id) DO UPDATE SET node_id = excluded.node_id, item_id = excluded.item_id,
  author_id = excluded.author_id, body = excluded.body, created_at = excluded.created_at,
  updated_at = excluded.updated_at, seq = excluded.seq
WHERE excluded.updated_at >= comments.updated_at;

-- name: delete_comment :exec
-- param: id i64
DELETE FROM comments WHERE id = :id;

-- When the item last got a comment, from the comments the mirror holds.
-- name: recount_last_commented :exec
-- param: item_id i64
-- param: seq i64
UPDATE items SET seq = :seq,
  last_commented_at = (SELECT max(c.created_at) FROM comments c WHERE c.item_id = :item_id)
WHERE id = :item_id;

-- name: bump_last_commented :exec
-- param: item_id i64
-- param: at i64
-- param: seq i64
UPDATE items SET seq = :seq, last_commented_at = max(coalesce(last_commented_at, 0), :at)
WHERE id = :item_id;

-- `issues.deleted`: the row and everything hanging off it.
-- name: delete_item :exec
-- param: id i64
DELETE FROM items WHERE id = :id;

-- name: delete_item_comments :exec
-- param: item_id i64
DELETE FROM comments WHERE item_id = :item_id;

-- name: delete_item_edges :exec
-- param: item_id i64
DELETE FROM relationships WHERE src_id = :item_id OR dst_id = :item_id;

-- A delete from a webhook: the id stays deleted whatever arrives after it.
-- name: record_deleted :exec
-- param: kind &str
-- param: id i64
INSERT OR IGNORE INTO deleted (kind, id) VALUES (:kind, :id);

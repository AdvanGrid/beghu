-- Plain inserts for the fixture generator (perf/fixture), which writes a whole mirror in one
-- transaction. Import and webhook applies use their own upserts.

-- name: insert_repo :exec
-- param: id i64
-- param: node_id &str
-- param: owner &str
-- param: name &str
-- param: private bool
-- param: installation_id Option<i64>
-- param: synced bool
-- param: role Option<&str>
INSERT INTO repos (id, node_id, owner, name, private, installation_id, synced, role)
VALUES (:id, :node_id, :owner, :name, :private, :installation_id, :synced, :role);

-- name: insert_user :exec
-- param: id i64
-- param: login &str
-- param: avatar_url &str
INSERT INTO users (id, login, avatar_url) VALUES (:id, :login, :avatar_url);

-- name: insert_label :exec
-- param: id i64
-- param: repo_id i64
-- param: name &str
-- param: color &str
-- param: description &str
INSERT INTO labels (id, repo_id, name, color, description) VALUES (:id, :repo_id, :name, :color, :description);

-- name: insert_milestone :exec
-- param: id i64
-- param: repo_id i64
-- param: number i64
-- param: title &str
-- param: state &str
-- param: due_on i64
INSERT INTO milestones (id, repo_id, number, title, state, due_on) VALUES (:id, :repo_id, :number, :title, :state, :due_on);

-- name: insert_item :exec
-- param: id i64
-- param: node_id &str
-- param: repo_id i64
-- param: number i64
-- param: kind &str
-- param: title &str
-- param: body &str
-- param: state &str
-- param: state_reason Option<&str>
-- param: author_id i64
-- param: milestone_id Option<i64>
-- param: created_at i64
-- param: updated_at i64
-- param: closed_at Option<i64>
-- param: pr_id Option<i64>
-- param: draft Option<bool>
-- param: merged_at Option<i64>
-- param: head_ref Option<&str>
-- param: base_ref Option<&str>
-- param: review_decision Option<&str>
-- param: seq i64
INSERT INTO items (id, node_id, repo_id, number, kind, title, body, state, state_reason, author_id,
  milestone_id, created_at, updated_at, closed_at, pr_id, draft, merged_at, head_ref, base_ref,
  review_decision, seq)
VALUES (:id, :node_id, :repo_id, :number, :kind, :title, :body, :state, :state_reason, :author_id,
  :milestone_id, :created_at, :updated_at, :closed_at, :pr_id, :draft, :merged_at, :head_ref, :base_ref,
  :review_decision, :seq);

-- name: insert_stub :exec
-- param: id i64
-- param: node_id &str
-- param: repo_id i64
-- param: number i64
-- param: title &str
-- param: state &str
-- param: seq i64
INSERT INTO items (id, node_id, repo_id, number, kind, is_stub, title, state, seq)
VALUES (:id, :node_id, :repo_id, :number, 'issue', 1, :title, :state, :seq);

-- name: add_item_label :exec
-- param: item_id i64
-- param: label_id i64
INSERT INTO item_labels (item_id, label_id) VALUES (:item_id, :label_id);

-- name: add_item_assignee :exec
-- param: item_id i64
-- param: user_id i64
INSERT OR IGNORE INTO item_assignees (item_id, user_id) VALUES (:item_id, :user_id);

-- Returns 0 when the edge (or a child's one parent) is already there.
-- name: add_relationship :exec
-- param: kind &str
-- param: src_id i64
-- param: dst_id i64
-- param: position Option<f64>
-- param: seq i64
INSERT OR IGNORE INTO relationships (kind, src_id, dst_id, position, seq) VALUES (:kind, :src_id, :dst_id, :position, :seq);

-- name: insert_comment :exec
-- param: id i64
-- param: node_id &str
-- param: item_id i64
-- param: author_id i64
-- param: body &str
-- param: created_at i64
-- param: seq i64
INSERT INTO comments (id, node_id, item_id, author_id, body, created_at, updated_at, seq)
VALUES (:id, :node_id, :item_id, :author_id, :body, :created_at, :created_at, :seq);

-- name: set_comment_stats :exec
-- param: id i64
-- param: count i64
-- param: last_commented_at i64
UPDATE items SET comments_count = :count, last_commented_at = :last_commented_at WHERE id = :id;

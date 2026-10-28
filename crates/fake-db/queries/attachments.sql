-- Attachments (Fake GitHub's `attachments.rs`).

-- name: add_attachment :exec
-- param: uuid &str
-- param: uploader_id i64
-- param: name &str
-- param: content_type &str
-- param: bytes &[u8]
INSERT INTO fake_attachments (uuid, uploader_id, name, content_type, bytes)
VALUES (:uuid, :uploader_id, :name, :content_type, :bytes);

-- name: attachment :opt
-- param: uuid &str
SELECT a.uuid, a.uploader_id, a.name, a.content_type, a.bytes FROM fake_attachments a
WHERE a.uuid = :uuid;

-- A comment by its node id, with the repo it's in.
-- name: comment_by_node :opt
-- param: node_id &str
SELECT c.id, c.body, i.repo_id FROM comments c JOIN items i ON i.id = c.item_id
WHERE c.node_id = :node_id AND i.is_stub = 0;

-- An issue's or PR's body.
-- name: item_body :one
-- param: id i64
SELECT i.body FROM items i WHERE i.id = :id;

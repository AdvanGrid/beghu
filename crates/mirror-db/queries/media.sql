-- Images and attachments in posts (crates/server/src/media): what the probes measured, and which
-- posts hold an attachment.

-- What's known of the images `hashes` names: a JSON array of SHA-256 hashes of their URLs, in
-- hex.
-- name: image_dims :many
-- param: hashes &str
SELECT d.url_hash AS "url_hash!: Vec<u8>", d.width, d.height, d.content_type, d.unavailable_reason
FROM image_dims d
WHERE d.url_hash IN (SELECT unhex(j.value) FROM json_each(:hashes) j);

-- A probe's finding: the image's size and type, or why it can't be shown.
-- name: put_image_dims :exec
-- param: url_hash &[u8]
-- param: width Option<i64>
-- param: height Option<i64>
-- param: content_type Option<&str>
-- param: unavailable_reason Option<&str>
INSERT INTO image_dims (url_hash, width, height, content_type, unavailable_reason)
VALUES (:url_hash, :width, :height, :content_type, :unavailable_reason)
ON CONFLICT (url_hash) DO UPDATE SET
  width = excluded.width, height = excluded.height, content_type = excluded.content_type,
  unavailable_reason = excluded.unavailable_reason;

-- The posts in the synced repos that hold attachment `needle` (`user-attachments/assets/<uuid>`),
-- bodies first, then comments, oldest first: the full-text index finds the candidates by the
-- UUID's words (`phrase`, an FTS5 phrase of them), and the text itself confirms each. `comment_id`
-- is null for a body.
-- name: attachment_holders :many
-- param: phrase &str
-- param: needle &str
SELECT h.item_id AS "item_id!: i64", h.comment_id AS "comment_id?: i64",
       h.node_id AS "node_id!: String", h.owner AS "owner!: String", h.repo AS "repo!: String",
       h.number AS "number!: i64"
FROM (
  SELECT i.id AS item_id, NULL AS comment_id, i.node_id, r.owner, r.name AS repo, i.number,
         0 AS k, i.created_at AS at
  FROM items i JOIN repos r ON r.id = i.repo_id
  WHERE i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH :phrase)
    AND instr(i.body, :needle) > 0 AND i.is_stub = 0 AND r.synced = 1
  UNION ALL
  SELECT c.item_id, c.id, c.node_id, r.owner, r.name, i.number, 1, c.created_at
  FROM comments c JOIN items i ON i.id = c.item_id JOIN repos r ON r.id = i.repo_id
  WHERE c.id IN (SELECT rowid FROM comments_fts WHERE comments_fts MATCH :phrase)
    AND instr(c.body, :needle) > 0 AND i.is_stub = 0 AND r.synced = 1
) h
ORDER BY h.k, h.at
LIMIT 5;

-- Where an item's posts are (their place) and the installation that mints their attachments.
-- name: item_place :opt
-- param: id i64
SELECT r.owner AS "owner!: String", r.name AS "repo!: String", i.number AS "number!: i64",
       r.installation_id AS "installation_id?: i64"
FROM items i JOIN repos r ON r.id = i.repo_id
WHERE i.id = :id AND i.is_stub = 0;

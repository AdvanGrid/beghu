-- Files uploaded to the fake (`POST /attachments` on the control port), as GitHub's editor
-- uploads them: images and videos, served from minted URLs (`private-user-images`) to whoever
-- reads a post that holds them.
CREATE TABLE fake_attachments (
  uuid TEXT PRIMARY KEY,
  uploader_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes BLOB NOT NULL
) WITHOUT ROWID;

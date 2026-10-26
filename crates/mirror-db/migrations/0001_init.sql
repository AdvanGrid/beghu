-- The v1 mirror: one connected account's copy of its GitHub data. Disposable: losing it means a
-- re-import. Ids are GitHub's database ids. Timestamps are Unix seconds (GitHub's precision).
-- No foreign keys: webhooks arrive in any order, and a row may name one that hasn't landed yet.

-- A per-mirror counter, bumped once per write transaction (the first statement of every write).
-- The items, relationships and comments rows a transaction writes carry its value. Used inside
-- the server only (tree caches, ordering), never on the wire.
CREATE TABLE seq (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL
);
INSERT INTO seq (id, value) VALUES (1, 0);

-- The account's visible repos, keyed by id so a rename only updates the name, plus unsynced
-- repos that stubs point into (synced = 0, no installation).
CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  node_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  private INTEGER NOT NULL,
  installation_id INTEGER,
  synced INTEGER NOT NULL,
  -- The account's role: read | triage | write | maintain | admin. NULL when unknown (unsynced).
  role TEXT CHECK (role IN ('read', 'triage', 'write', 'maintain', 'admin')),
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX repos_name ON repos(name COLLATE NOCASE);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  avatar_url TEXT
);
CREATE INDEX users_login ON users(login COLLATE NOCASE);

CREATE TABLE labels (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT
);
CREATE INDEX labels_repo_name ON labels(repo_id, name COLLATE NOCASE);
CREATE INDEX labels_name ON labels(name COLLATE NOCASE);

CREATE TABLE milestones (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  due_on INTEGER
);
CREATE INDEX milestones_repo ON milestones(repo_id, number);

-- Issues, PRs and stubs, keyed by the issue-side database id (a PR's `pr_id` is the other one).
-- Never keyed on number: (repo_id, number) is only a lookup.
-- A stub (is_stub = 1) is an issue in a repo that isn't synced, reached through a relationship.
-- It holds only id, node_id, repo, number, title, state and kind.
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  node_id TEXT NOT NULL,
  repo_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'pr')),
  is_stub INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  body TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  state_reason TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  author_id INTEGER,
  milestone_id INTEGER,
  created_at INTEGER,
  updated_at INTEGER,
  closed_at INTEGER,
  last_commented_at INTEGER,
  comments_count INTEGER NOT NULL DEFAULT 0,
  -- PRs only.
  pr_id INTEGER,
  draft INTEGER,
  merged_at INTEGER,
  head_ref TEXT,
  base_ref TEXT,
  review_decision TEXT CHECK (review_decision IN ('approved', 'changes_requested', 'review_required')),
  seq INTEGER NOT NULL,
  UNIQUE (repo_id, number)
);
CREATE INDEX items_list ON items(kind, state, updated_at DESC, id DESC) WHERE is_stub = 0;
CREATE INDEX items_seq ON items(seq);

-- Normalised, because a label or user rename bumps no issue.
CREATE TABLE item_labels (
  item_id INTEGER NOT NULL,
  label_id INTEGER NOT NULL,
  PRIMARY KEY (item_id, label_id)
) WITHOUT ROWID;
CREATE INDEX item_labels_by_label ON item_labels(label_id, item_id);

CREATE TABLE item_assignees (
  item_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (item_id, user_id)
) WITHOUT ROWID;
CREATE INDEX item_assignees_by_user ON item_assignees(user_id, item_id);

-- kind  src      dst
-- sub   parent   child    (a child has one parent; `position` orders siblings)
-- blocks blocker blocked
-- relates smaller id, larger id
-- closes PR      issue
CREATE TABLE relationships (
  kind TEXT NOT NULL CHECK (kind IN ('sub', 'blocks', 'relates', 'closes')),
  src_id INTEGER NOT NULL,
  dst_id INTEGER NOT NULL,
  position REAL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (kind, src_id, dst_id),
  CHECK (kind <> 'relates' OR src_id < dst_id),
  CHECK ((kind = 'sub') = (position IS NOT NULL))
) WITHOUT ROWID;
CREATE UNIQUE INDEX relationships_one_parent ON relationships(dst_id) WHERE kind = 'sub';
CREATE INDEX relationships_by_dst ON relationships(dst_id, kind, src_id);
CREATE INDEX relationships_seq ON relationships(seq);

-- Fully synced, not lazy.
CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  node_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  author_id INTEGER,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX comments_item ON comments(item_id, created_at, id);
CREATE INDEX comments_seq ON comments(seq);

-- Full-text search over item titles and bodies (PRs included, stubs not) and over comment
-- bodies. External content: the text lives once, in items and comments, and the triggers keep
-- the index current in the same transaction as the row.
CREATE VIRTUAL TABLE items_fts USING fts5(
  title, body,
  content = 'items', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);
CREATE TRIGGER items_fts_insert AFTER INSERT ON items WHEN new.is_stub = 0 BEGIN
  INSERT INTO items_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER items_fts_delete AFTER DELETE ON items WHEN old.is_stub = 0 BEGIN
  INSERT INTO items_fts (items_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER items_fts_update AFTER UPDATE OF title, body, is_stub ON items BEGIN
  INSERT INTO items_fts (items_fts, rowid, title, body) SELECT 'delete', old.id, old.title, old.body WHERE old.is_stub = 0;
  INSERT INTO items_fts (rowid, title, body) SELECT new.id, new.title, new.body WHERE new.is_stub = 0;
END;

CREATE VIRTUAL TABLE comments_fts USING fts5(
  body,
  content = 'comments', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);
CREATE TRIGGER comments_fts_insert AFTER INSERT ON comments BEGIN
  INSERT INTO comments_fts (rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER comments_fts_delete AFTER DELETE ON comments BEGIN
  INSERT INTO comments_fts (comments_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER comments_fts_update AFTER UPDATE OF body ON comments BEGIN
  INSERT INTO comments_fts (comments_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO comments_fts (rowid, body) VALUES (new.id, new.body);
END;

-- Measured image sizes, so the client can reserve space before an image loads. `url_hash` is
-- the SHA-256 of the image URL. `unavailable_reason` is set when it couldn't be fetched.
CREATE TABLE image_dims (
  url_hash BLOB PRIMARY KEY,
  width INTEGER,
  height INTEGER,
  content_type TEXT,
  unavailable_reason TEXT
) WITHOUT ROWID;

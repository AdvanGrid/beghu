-- The fixture mirror's schema, as bench/fixture builds it. IF NOT EXISTS lets the migrator adopt a
-- mirror that was built before it ran.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  private INTEGER NOT NULL,
  installation_id INTEGER,
  synced INTEGER NOT NULL,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  avatar_url TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  due_on TEXT,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  node_id TEXT NOT NULL,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'pr')),
  is_stub INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  body TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  state_reason TEXT,
  author_id INTEGER REFERENCES users(id),
  milestone_id INTEGER REFERENCES milestones(id),
  comments_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  closed_at TEXT,
  pr_id INTEGER,
  draft INTEGER,
  merged_at TEXT,
  seq INTEGER NOT NULL,
  UNIQUE (repo_id, number)
);
CREATE TABLE IF NOT EXISTS item_labels (
  item_id INTEGER NOT NULL REFERENCES items(id),
  label_id INTEGER NOT NULL REFERENCES labels(id),
  seq INTEGER NOT NULL,
  PRIMARY KEY (item_id, label_id)
);
CREATE TABLE IF NOT EXISTS item_assignees (
  item_id INTEGER NOT NULL REFERENCES items(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  seq INTEGER NOT NULL,
  PRIMARY KEY (item_id, user_id)
);
CREATE TABLE IF NOT EXISTS relationships (
  kind TEXT NOT NULL CHECK (kind IN ('sub', 'blocks', 'relates')),
  src_id INTEGER NOT NULL REFERENCES items(id),
  dst_id INTEGER NOT NULL REFERENCES items(id),
  position REAL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (kind, src_id, dst_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  node_id TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id),
  author_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tombstones (
  tbl TEXT NOT NULL,
  key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (tbl, key)
);
CREATE UNIQUE INDEX IF NOT EXISTS relationships_one_parent ON relationships(dst_id) WHERE kind = 'sub';
CREATE INDEX IF NOT EXISTS items_list ON items(kind, state, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS items_seq ON items(seq);
CREATE INDEX IF NOT EXISTS comments_item ON comments(item_id, created_at);
CREATE INDEX IF NOT EXISTS comments_seq ON comments(seq);
CREATE INDEX IF NOT EXISTS item_labels_label ON item_labels(label_id);
CREATE INDEX IF NOT EXISTS item_assignees_user ON item_assignees(user_id);
CREATE INDEX IF NOT EXISTS relationships_dst ON relationships(dst_id, kind);
CREATE INDEX IF NOT EXISTS relationships_seq ON relationships(seq);

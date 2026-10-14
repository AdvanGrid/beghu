-- A mirror file shaped like the decision in "Mirror schema and per-account isolation"
-- (https://github.com/tomsjansons/beghu/issues/8). One account's data; the control DB is not
-- part of the benchmark fixture.

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  private INTEGER NOT NULL,
  installation_id INTEGER,
  synced INTEGER NOT NULL,
  seq INTEGER NOT NULL
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  avatar_url TEXT NOT NULL,
  seq INTEGER NOT NULL
);

CREATE TABLE labels (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT,
  seq INTEGER NOT NULL
);

CREATE TABLE milestones (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  due_on TEXT,
  seq INTEGER NOT NULL
);

-- Issues, PRs and stubs. The PK is the issue-side database id.
CREATE TABLE items (
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

CREATE TABLE item_labels (
  item_id INTEGER NOT NULL REFERENCES items(id),
  label_id INTEGER NOT NULL REFERENCES labels(id),
  seq INTEGER NOT NULL,
  PRIMARY KEY (item_id, label_id)
);

CREATE TABLE item_assignees (
  item_id INTEGER NOT NULL REFERENCES items(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  seq INTEGER NOT NULL,
  PRIMARY KEY (item_id, user_id)
);

-- kind: sub (src = parent, dst = child), blocks (src = blocker, dst = blocked),
-- relates (src = min id, dst = max id).
CREATE TABLE relationships (
  kind TEXT NOT NULL CHECK (kind IN ('sub', 'blocks', 'relates')),
  src_id INTEGER NOT NULL REFERENCES items(id),
  dst_id INTEGER NOT NULL REFERENCES items(id),
  position REAL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (kind, src_id, dst_id)
);
CREATE UNIQUE INDEX relationships_one_parent ON relationships(dst_id) WHERE kind = 'sub';

CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  node_id TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id),
  author_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  seq INTEGER NOT NULL
);

CREATE TABLE tombstones (
  tbl TEXT NOT NULL,
  key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (tbl, key)
);

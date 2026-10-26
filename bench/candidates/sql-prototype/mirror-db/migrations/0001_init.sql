CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  avatar_url TEXT
);
CREATE TABLE milestones (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  title TEXT NOT NULL
);
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  milestone_id INTEGER REFERENCES milestones(id),
  parent_id INTEGER REFERENCES items(id),
  comments_count INTEGER NOT NULL DEFAULT 0,
  is_stub INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE labels (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL
);
CREATE TABLE item_labels (
  item_id INTEGER NOT NULL REFERENCES items(id),
  label_id INTEGER NOT NULL REFERENCES labels(id),
  PRIMARY KEY (item_id, label_id)
) WITHOUT ROWID;
CREATE TABLE item_assignees (
  item_id INTEGER NOT NULL REFERENCES items(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (item_id, user_id)
) WITHOUT ROWID;
CREATE INDEX item_labels_by_label ON item_labels(label_id, item_id);
CREATE INDEX item_assignees_by_user ON item_assignees(user_id, item_id);
CREATE INDEX issue_list ON items(state, updated_at DESC, id DESC) WHERE kind = 'issue' AND is_stub = 0;

-- compat: additive
CREATE TABLE preferences (
  github_user_id INTEGER PRIMARY KEY REFERENCES accounts(github_user_id),
  comment_order TEXT,
  key_next TEXT
);

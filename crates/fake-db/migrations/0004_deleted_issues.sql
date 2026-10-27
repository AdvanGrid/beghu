-- Issues deleted on the fake (`POST /delete` on the control port): their numbers stay taken, and
-- GitHub answers 410 for them rather than 404.
CREATE TABLE fake_deleted_issues (
  repo_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  PRIMARY KEY (repo_id, number)
) WITHOUT ROWID;

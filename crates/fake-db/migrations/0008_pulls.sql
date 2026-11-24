-- A PR's commits and changed files (`GET /repos/{owner}/{repo}/pulls/{number}`, `…/files`,
-- `…/commits`), for the PR view's analysis runs. A fixture PR has no row: its head SHA, commits
-- and files derive from its id (`pulls.rs`). A push on the control port (`POST /push`) gives it a
-- row: the commits it added on top of the derived ones, its new head SHA, and, when the push says
-- so, the files the PR now changes. Part of the truth, so `/reset` starts it again.
CREATE TABLE fake_pull_heads (
  issue_id INTEGER PRIMARY KEY,
  head_sha TEXT NOT NULL,
  pushes INTEGER NOT NULL,
  -- 1 when the PR's files are the rows in `fake_pull_files`, 0 when they still derive from its id.
  files_set INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE fake_pull_files (
  issue_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  filename TEXT NOT NULL,
  previous_filename TEXT,
  status TEXT NOT NULL,
  additions INTEGER NOT NULL,
  deletions INTEGER NOT NULL,
  PRIMARY KEY (issue_id, position)
) WITHOUT ROWID;

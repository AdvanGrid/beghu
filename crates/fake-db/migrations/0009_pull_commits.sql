-- Each commit a push on the control port added to a PR (`POST /push`), by its place in the PR's
-- commit list (1-based), so a pushed SHA stays in the list under later pushes, as on GitHub. A
-- commit with no row derives from the PR's id (`pulls.rs`). A force push (`force`) replaces the
-- PR's history: its rows go, and `rewrites` counts it, so every derived SHA the PR had before is
-- gone from its list too.
CREATE TABLE fake_pull_commits (
  issue_id INTEGER NOT NULL,
  k INTEGER NOT NULL,
  sha TEXT NOT NULL,
  PRIMARY KEY (issue_id, k)
) WITHOUT ROWID;

ALTER TABLE fake_pull_heads ADD COLUMN rewrites INTEGER NOT NULL DEFAULT 0;

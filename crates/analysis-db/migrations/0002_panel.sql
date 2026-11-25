-- What the PR panel's Analyse button shows (#177), read with the PR's detail.

-- The run's pinned head SHA (`pr.json`'s `headSha`), set as the run pins the PR: the panel says
-- "An agent is working at ‹SHA›" without reading `pr.json`. And how many errors the last upload's
-- report had, while the last upload was refused (NULL once one is accepted, or before any).
ALTER TABLE runs ADD COLUMN pinned_head TEXT;
ALTER TABLE runs ADD COLUMN refused_errors INTEGER;

-- The PR's latest run, live or ended: whether the last one expired.
CREATE INDEX runs_by_pr ON runs(repo_id, number, created_at);

-- "N behind": how far the PR's head (as the mirror has it) is past the head its analysis was
-- made at, counted once per pair from GitHub's list of the PR's commits. `behind` is NULL when
-- the analysed head isn't in that list (force-pushed away) or GitHub wouldn't list it: the panel
-- says "outdated". A PR's rows go when an upload replaces its analysis.
CREATE TABLE behind (
  repo_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  analysed TEXT NOT NULL,
  head TEXT NOT NULL,
  behind INTEGER,
  PRIMARY KEY (repo_id, number, analysed, head)
) WITHOUT ROWID;

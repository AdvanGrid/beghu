-- Issues that left a repo other than by being deleted, and the ids GitHub never hands out again.

-- Issues transferred to another repo (`POST /transfer` on the control port): the old number
-- answers 301 to the issue it became, which has a new id, node id and number.
CREATE TABLE fake_transferred_issues (
  repo_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  old_id INTEGER NOT NULL,
  new_id INTEGER NOT NULL,
  PRIMARY KEY (repo_id, number)
) WITHOUT ROWID;

-- Discussions issues were converted to (`POST /convert`). A discussion takes the next number in
-- its repo's issue sequence; the issue stays, closed and locked.
CREATE TABLE fake_discussions (
  repo_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  issue_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  PRIMARY KEY (repo_id, number)
) WITHOUT ROWID;

-- The ids of issues no longer in `items` (deleted, or transferred away): GitHub never reuses an
-- id, so a new issue's id is past all of them.
CREATE TABLE fake_retired_ids (
  id INTEGER PRIMARY KEY
);

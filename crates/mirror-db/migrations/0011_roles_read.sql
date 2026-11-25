-- When the re-read of the account's visible repos last wrote them here (PR view, #176). A mirror
-- that lists no repo is either one whose repos were never read (just created or revived) or one
-- whose account can see none: the daily check's retry of a lost Read's delete of its analyses
-- tells the two apart by this row, which the first re-read writes. One row at most.
CREATE TABLE roles_read (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  at INTEGER NOT NULL
);

-- The ids of comments deleted: GitHub never gives a comment's id to another, so a new comment's id
-- is past all of them, as a new issue's is past `fake_retired_ids` (a mirror that saw a comment
-- deleted refuses its id ever after). A data dir from before this can't know its deleted ones.
CREATE TABLE fake_retired_comment_ids (
  id INTEGER PRIMARY KEY
);

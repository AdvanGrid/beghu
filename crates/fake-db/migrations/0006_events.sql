-- Each repo's issue events feed (`GET /repos/{owner}/{repo}/issues/events`): what happened to its
-- issues and PRs, newest first. `seq` is the order the events happened in; `id` is GitHub's,
-- which the feed doesn't promise to keep in that order (see `events.rs`). `other_id` is the issue
-- a sub-issue or dependency event names; NULL for the rest.
CREATE TABLE fake_events (
  seq INTEGER PRIMARY KEY,
  id INTEGER NOT NULL UNIQUE,
  repo_id INTEGER NOT NULL,
  issue_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  actor_id INTEGER,
  other_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX fake_events_by_repo ON fake_events(repo_id, created_at, seq);

-- Each PR's reviews, in the order they were submitted: their ids (a `pull_request_review`
-- delivery's `review.id`, offset as `pulls.rs` says), the head commit each was made on (a
-- dismissal's delivery names it), and which one a dismissal dismisses. Part of the truth, so
-- `/reset` starts it again.
CREATE TABLE fake_reviews (
  id INTEGER PRIMARY KEY,
  pr_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  submitted_at INTEGER NOT NULL
);
CREATE INDEX fake_reviews_by_pr ON fake_reviews(pr_id, id);

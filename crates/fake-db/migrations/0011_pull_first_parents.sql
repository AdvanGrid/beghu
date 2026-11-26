-- The parent of a PR's first commit: the commit its branch starts from. GitHub's `base.sha` is the
-- base branch's tip, which moves as main does (`POST /push`'s `base_sha`) without moving the PR's
-- history; only a new history (the seed, or a force push, as after a rebase) starts somewhere
-- else. NULL: the derived tip of the base branch, which never moves.
ALTER TABLE fake_pull_heads ADD COLUMN first_parent TEXT;

-- The tip of a PR's base branch as GitHub reports it (`base.sha` in `GET …/pulls/{number}`), when
-- it isn't the one derived from the repo and branch name (`pulls.rs`): the recorded PR's real
-- merge base, seeded from its `pr-v1.json`, and the base a push names (`POST /push`'s
-- `base_sha`, as main moved meanwhile). NULL: derived.
ALTER TABLE fake_pull_heads ADD COLUMN base_sha TEXT;

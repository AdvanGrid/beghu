-- In place, and can fail on real data: a mirror holding two rows for one (repo, number), for
-- example after a transfer the import didn't tombstone, violates the new index.
CREATE UNIQUE INDEX items_repo_number ON items(repo_id, number);

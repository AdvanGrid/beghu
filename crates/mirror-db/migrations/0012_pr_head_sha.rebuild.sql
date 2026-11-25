-- A PR's head commit (PR view, #177): what the PR panel compares an analysis's head with, to say
-- "N behind". A rebuild: a mirror behind this version never fetched it (GraphQL's `headRefOid`),
-- so its rows can't be filled without re-importing every PR.
--
-- NULL for an issue and a stub, and for a PR GitHub named no head for. Every writer of a PR's
-- own columns sets it (`set_item_pr`): the import, the PR read-back that `pull_request`
-- deliveries start (`synchronize` among them, for a push to the branch) and the sweeps' probes.
ALTER TABLE items ADD COLUMN head_sha TEXT;

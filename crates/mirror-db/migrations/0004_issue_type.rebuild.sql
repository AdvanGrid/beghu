-- GitHub issue types (`type:` in the filter bar): the issue's type name (`issueType { name }`),
-- NULL for an untyped issue and for every PR. A rebuild: a mirror behind this version never
-- fetched the field, so its rows can't be filled without re-importing every issue.
--
-- Nullable, and stays so: a writer that doesn't know the type (a stub, a PR, an older payload)
-- leaves it NULL. Every writer that upserts an issue must set it, or `type:` and its facet go
-- stale: from REST payloads (webhooks, `GET /repos/{owner}/{repo}/issues`) it's
-- `issue.type.name` (`type` is null for an untyped issue); from GraphQL (the import) it's
-- `issueType { name }`. An upsert that sets every column must pass it, or it writes NULL over
-- the type; one that sets only what changed must include it when the type changed (the
-- `issues` webhook's `typed` / `untyped` actions).
ALTER TABLE items ADD COLUMN issue_type TEXT;
-- The bar's `type:` values, read from the index alone.
CREATE INDEX items_issue_type ON items(issue_type COLLATE NOCASE) WHERE is_stub = 0 AND issue_type IS NOT NULL;

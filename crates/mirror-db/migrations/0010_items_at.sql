-- An issue's URL names it by where GitHub has it (`/acme/web/issues/12`), not by id, and so does
-- Focus view's `?focus=acme/web/12`: opening one looks the issue up by its repo and number
-- (`item_at`), as the relationship picker and the import's comment pass already did. Without this
-- each such lookup read every item. Stubs included: a URL can name one, and is told it's outside
-- the synced repos.
CREATE INDEX items_at ON items(repo_id, number);

-- The list shows issues and PRs unless `is:issue` or `is:pr` narrows it, so the view with no
-- kind is the default, and every sort of it reads in order. The sort indexes no longer lead with
-- `kind`; `kind` trails, so `is:issue` or `is:pr` skips the other kind's rows inside the index
-- (PRs are about a fifth of the items in the fixture) in the same order.
--
-- Each sort has two: one led by state, which `is:open` or `is:closed` (the default view among
-- them) seeks to and then reads in the sort's order, and one led by the sort key for a view of
-- every state, walked in order from the top or sought from a cursor. A key that can be NULL is
-- indexed through the same COALESCE as in 0003, one per direction. 0001's `items_list` and all
-- of 0003's sort indexes go.
--
-- 14 list indexes where there were 11: an insert, a close or a reopen, and a full-row upsert
-- (0003) write 3 more.
DROP INDEX items_list;
DROP INDEX items_updated_any_state;
DROP INDEX items_updated_any_kind;
DROP INDEX items_created;
DROP INDEX items_closed;
DROP INDEX items_closed_asc;
DROP INDEX items_closed_any_state;
DROP INDEX items_closed_asc_any_state;
DROP INDEX items_commented;
DROP INDEX items_commented_asc;
DROP INDEX items_comments;

CREATE INDEX items_updated ON items(state, updated_at, id, kind) WHERE is_stub = 0;
CREATE INDEX items_updated_any_state ON items(updated_at, id, state, kind) WHERE is_stub = 0;
CREATE INDEX items_created ON items(state, created_at, id, kind) WHERE is_stub = 0;
CREATE INDEX items_created_any_state ON items(created_at, id, state, kind) WHERE is_stub = 0;
CREATE INDEX items_closed_asc ON items(state, COALESCE(closed_at, 9223372036854775807), id, kind) WHERE is_stub = 0;
CREATE INDEX items_closed_any_state ON items(COALESCE(closed_at, 0), id, state, kind) WHERE is_stub = 0;
CREATE INDEX items_closed_asc_any_state ON items(COALESCE(closed_at, 9223372036854775807), id, state, kind) WHERE is_stub = 0;
CREATE INDEX items_commented ON items(state, COALESCE(last_commented_at, 0), id, kind) WHERE is_stub = 0;
CREATE INDEX items_commented_asc ON items(state, COALESCE(last_commented_at, 9223372036854775807), id, kind) WHERE is_stub = 0;
CREATE INDEX items_commented_any_state ON items(COALESCE(last_commented_at, 0), id, state, kind) WHERE is_stub = 0;
CREATE INDEX items_commented_asc_any_state ON items(COALESCE(last_commented_at, 9223372036854775807), id, state, kind) WHERE is_stub = 0;
CREATE INDEX items_comments ON items(state, comments_count, id, kind) WHERE is_stub = 0;
CREATE INDEX items_comments_any_state ON items(comments_count, id, state, kind) WHERE is_stub = 0;
-- Last on purpose. A read of a state in no order (the facet counts under `is:open`) can seek any
-- of the state-led indexes at the same cost, and SQLite takes the one created last. This one
-- holds every open item under the same key (no `closed_at`), so it reads them in id order, and
-- each row's lookups (the item, its labels) go through the tables in order: 100 ms at 50k against
-- 145 ms through `items_comments`. The plan test holds it (`facet_counts_read_only_the_views_rows`).
CREATE INDEX items_closed ON items(state, COALESCE(closed_at, 0), id, kind) WHERE is_stub = 0;

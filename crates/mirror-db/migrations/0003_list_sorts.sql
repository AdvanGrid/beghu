-- The list's sorts and the filter bar's lookups: every sort, both ways, under `is:open`,
-- `is:closed` or no state, reads its rows in order and stops at the page's end. Ties break on
-- id, in the sort's direction. A key that can be NULL is indexed through the same COALESCE the
-- queries in `list.sql` order by: never-closed (`closed`) and uncommented (`commented`) items go
-- last in both directions, so those keys have one index per direction.
--
-- State trails the key: a view under `is:open` or `is:closed` walks the kind's rows in key order
-- and skips the other state's inside the index, so one index serves a state and none. `closed`
-- is the exception: every open item's key is the same NULL, so under `is:open` it would first
-- skip every closed row. State leads there, with a second pair for no state.
--
-- The cost is on writes. With 0001's `items_list` an item is in 11 list indexes (plus the
-- author's, the issue type's and FTS). An insert writes every one of them. An UPDATE rewrites
-- each index over a column it SETs, whether or not the value changed: a narrow UPDATE of only
-- `updated_at` rewrites 3, a comment's (`updated_at` and the comment stats) 6, a close or
-- reopen all 11. A full-row upsert (`INSERT … ON CONFLICT DO UPDATE` setting every column, as
-- an import or a webhook apply that writes the whole item does) SETs every indexed column, so
-- it rewrites all of them on every write, changed or not. That is where the write cost falls:
-- a writer that wants it lower sets only the columns that changed.
CREATE INDEX items_created ON items(kind, created_at, id, state) WHERE is_stub = 0;
CREATE INDEX items_closed ON items(kind, state, COALESCE(closed_at, 0), id) WHERE is_stub = 0;
CREATE INDEX items_closed_asc ON items(kind, state, COALESCE(closed_at, 9223372036854775807), id) WHERE is_stub = 0;
CREATE INDEX items_closed_any_state ON items(kind, COALESCE(closed_at, 0), id) WHERE is_stub = 0;
CREATE INDEX items_closed_asc_any_state ON items(kind, COALESCE(closed_at, 9223372036854775807), id) WHERE is_stub = 0;
CREATE INDEX items_commented ON items(kind, COALESCE(last_commented_at, 0), id, state) WHERE is_stub = 0;
CREATE INDEX items_commented_asc ON items(kind, COALESCE(last_commented_at, 9223372036854775807), id, state) WHERE is_stub = 0;
CREATE INDEX items_comments ON items(kind, comments_count, id, state) WHERE is_stub = 0;
-- The default sort with no `is:open`/`is:closed`: every state, newest update first.
CREATE INDEX items_updated_any_state ON items(kind, updated_at, id) WHERE is_stub = 0;
-- The default sort with no kind (`is:any`, or `is:issue is:pr`), under a state or none.
-- Partial, like the others: an index that led with `is_stub` instead would match every list and
-- facet query's `is_stub = 0` and win over the index a query should use (the facets', above
-- all). Only this sort has a kind-less index; the others sort every row of the view (an
-- accepted cost, see `list.sql`).
CREATE INDEX items_updated_any_kind ON items(updated_at, id, state) WHERE is_stub = 0;

-- `author:` values for the bar's suggestions, and `milestone:` by title.
CREATE INDEX items_author ON items(author_id) WHERE is_stub = 0;
CREATE INDEX milestones_title ON milestones(title COLLATE NOCASE);

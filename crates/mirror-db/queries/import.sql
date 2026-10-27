-- Repo picking and the import (crates/server/src/import.rs, crates/server/src/repos.rs). Items
-- and comments go through the webhook upserts in webhooks.sql, so the import and webhooks share
-- one `updated_at` guard and one respect for `deleted`; stubs go through relationships.sql's.
-- What's here: the account's visible repos, the relationships the import reads, the PR columns,
-- and unsyncing a repo.

-- A repo the account can see through an installation, as the re-read of its visible repos found
-- it. Whether it's synced is the account's choice and stays as it was; a role GitHub didn't say
-- (`NULL`) keeps the one stored.
-- name: upsert_visible_repo :exec
-- param: id i64
-- param: node_id &str
-- param: owner &str
-- param: name &str
-- param: private bool
-- param: installation_id i64
-- param: role Option<&str>
-- param: archived bool
INSERT INTO repos (id, node_id, owner, name, private, installation_id, synced, role, archived)
VALUES (:id, :node_id, :owner, :name, :private, :installation_id, 0, :role, :archived)
ON CONFLICT (id) DO UPDATE SET node_id = excluded.node_id, owner = excluded.owner,
  name = excluded.name, private = excluded.private, installation_id = excluded.installation_id,
  role = COALESCE(excluded.role, repos.role), archived = excluded.archived;

-- Every repo the account could see at the last re-read, synced or not, for the picker.
-- name: visible_repos :many
SELECT r.id, r.owner, r.name, r.private AS "private: bool", r.archived AS "archived: bool",
       r.role, r.synced AS "synced: bool", r.importing AS "importing: bool",
       r.installation_id AS "installation_id!"
FROM repos r WHERE r.installation_id IS NOT NULL ORDER BY r.owner, r.name;

-- The account can no longer see the repo: no installation, no role. Its row stays while stubs
-- point into it.
-- name: forget_visible_repo :exec
-- param: id i64
UPDATE repos SET installation_id = NULL, role = NULL WHERE id = :id;

-- What the import and the relationship writes need to know about a repo.
-- name: repo_state :opt
-- param: id i64
SELECT r.id, r.owner, r.name, r.private AS "private: bool", r.synced AS "synced: bool",
       r.importing AS "importing: bool", r.installation_id, r.import_started,
       r.import_failures, r.import_retry_at
FROM repos r WHERE r.id = :id;

-- A repo joins the synced set: its import starts (or starts again), in transaction `seq`.
-- name: start_repo_import :exec
-- param: id i64
-- param: seq i64
UPDATE repos SET synced = 1, importing = 1, import_started = :seq, import_failures = 0,
  import_retry_at = NULL
WHERE id = :id AND installation_id IS NOT NULL;

-- Its last phase landed, in the import that started at `started`; 0 rows when another import
-- of the repo has started since (or it was unsynced).
-- name: finish_repo_import :exec
-- param: id i64
-- param: started i64
UPDATE repos SET importing = 0, import_failures = 0, import_retry_at = NULL
WHERE id = :id AND synced = 1 AND importing = 1 AND import_started = :started;

-- A phase of the import that started at `started` failed for good: the repo stays `importing`
-- and is tried again at `retry_at`. 0 rows when another import of it has started since.
-- name: fail_repo_import :exec
-- param: id i64
-- param: started i64
-- param: retry_at i64
UPDATE repos SET import_failures = import_failures + 1, import_retry_at = :retry_at
WHERE id = :id AND synced = 1 AND importing = 1 AND import_started = :started;

-- A PR's own columns, none of them indexed: from the import's PR details.
-- name: set_item_pr :exec
-- param: id i64
-- param: pr_id i64
-- param: draft bool
-- param: merged_at Option<i64>
-- param: head_ref Option<&str>
-- param: base_ref Option<&str>
-- param: review_decision Option<&str>
UPDATE items SET pr_id = :pr_id, draft = :draft, merged_at = :merged_at, head_ref = :head_ref,
  base_ref = :base_ref, review_decision = :review_decision
WHERE id = :id AND (pr_id IS NOT :pr_id OR draft IS NOT :draft OR merged_at IS NOT :merged_at
  OR head_ref IS NOT :head_ref OR base_ref IS NOT :base_ref
  OR review_decision IS NOT :review_decision);

-- The import names an issue's milestone by number and its labels by name (GitHub's GraphQL has
-- no database id for either); the repo's labels and milestones land first.
-- name: milestone_by_number :opt
-- param: repo_id i64
-- param: number i64
SELECT m.id FROM milestones m WHERE m.repo_id = :repo_id AND m.number = :number;

-- A comment from the repo-wide REST pass names its issue by number.
-- name: item_by_number :opt
-- param: repo_id i64
-- param: number i64
SELECT i.id, i.is_stub AS "is_stub: bool" FROM items i
WHERE i.repo_id = :repo_id AND i.number = :number;

-- A relationship the import read. Never one to or from a deleted id. A sub-issue has one
-- parent: `drop_other_parents` runs first.
-- name: import_relationship :exec
-- param: kind &str
-- param: src_id i64
-- param: dst_id i64
-- param: position Option<f64>
-- param: seq i64
INSERT INTO relationships (kind, src_id, dst_id, position, seq)
SELECT :kind, :src_id, :dst_id, :position, :seq
WHERE NOT EXISTS (SELECT 1 FROM deleted d WHERE d.kind = 'item' AND d.id IN (:src_id, :dst_id))
ON CONFLICT (kind, src_id, dst_id) DO UPDATE SET position = excluded.position, seq = excluded.seq
WHERE relationships.position IS NOT excluded.position;

-- name: drop_other_parents :exec
-- param: child_id i64
-- param: parent_id i64
DELETE FROM relationships WHERE kind = 'sub' AND dst_id = :child_id AND src_id <> :parent_id;

-- The open (or closed) items of the repos being imported whose comments the mirror doesn't
-- hold yet: phase 3's work list.
-- name: items_missing_comments :many
-- param: repo_ids &[i64]
-- param: state &str
SELECT i.id, i.node_id, i.repo_id FROM items i
WHERE i.repo_id IN (SELECT j.value FROM json_each(:repo_ids) j) AND i.is_stub = 0
  AND i.state = :state AND i.comments_count > 0
  AND i.comments_count > (SELECT count(*) FROM comments c WHERE c.item_id = i.id)
ORDER BY i.id;

-- For the detail: an item, its repo, and how many of its comments the mirror holds.
-- name: comments_held :opt
-- param: id i64
SELECT i.number, i.comments_count, r.id AS repo_id, r.owner, r.name, r.installation_id,
       (SELECT count(*) FROM comments c WHERE c.item_id = i.id) AS "held!: i64"
FROM items i JOIN repos r ON r.id = i.repo_id
WHERE i.id = :id AND i.is_stub = 0 AND r.synced = 1;

-- Unsyncing a repo: its rows go, except those a relationship from a full item in another synced
-- repo still reaches, which become stubs. With `keep_stubs` off (the account can no longer see a
-- private repo) every relationship into it goes too. Nothing is recorded in `deleted`: syncing
-- the repo again brings the same ids back. A big repo goes in several transactions, so the
-- account's other writes aren't held up behind one: first `unsync_relationships`,
-- `unsync_to_stubs` and `unsync_repo` (from then on webhooks and import pages for it are
-- dropped); then its items a chunk at a time (`repo_items_after`, `unsync_relationships_of` and
-- `unsync_to_stubs_of` again for anything written to them meanwhile, the `unsync_*_of` deletes
-- and `unsync_full_items`); then `unsync_labels`, `unsync_milestones` and `drop_orphan_stubs`.

-- The relationships into the repo that no full item of another synced repo holds: between two
-- of its own items, or to a stub or another unsynced repo. With `keep_stubs` off, all of them.
-- name: unsync_relationships :exec
-- param: repo_id i64
-- param: keep_stubs bool
DELETE FROM relationships
WHERE (src_id IN (SELECT i.id FROM items i WHERE i.repo_id = :repo_id)
       OR dst_id IN (SELECT i.id FROM items i WHERE i.repo_id = :repo_id))
  AND (NOT :keep_stubs
       OR NOT (src_id IN (SELECT i.id FROM items i JOIN repos r ON r.id = i.repo_id
                          WHERE i.is_stub = 0 AND r.synced = 1 AND r.id <> :repo_id)
               OR dst_id IN (SELECT i.id FROM items i JOIN repos r ON r.id = i.repo_id
                             WHERE i.is_stub = 0 AND r.synced = 1 AND r.id <> :repo_id)));

-- The repo's items a relationship still reaches become stubs: id, node_id, repo, number, title,
-- state and kind, nothing else.
-- name: unsync_to_stubs :exec
-- param: repo_id i64
-- param: seq i64
UPDATE items SET is_stub = 1, body = NULL, state_reason = NULL, locked = 0, author_id = NULL,
  milestone_id = NULL, created_at = NULL, updated_at = NULL, closed_at = NULL,
  last_commented_at = NULL, comments_count = 0, pr_id = NULL, draft = NULL, merged_at = NULL,
  head_ref = NULL, base_ref = NULL, review_decision = NULL, issue_type = NULL, seq = :seq
WHERE repo_id = :repo_id AND is_stub = 0
  AND (id IN (SELECT r.src_id FROM relationships r) OR id IN (SELECT r.dst_id FROM relationships r));

-- A chunk of the repo's items, stubs too, in id order after `after_id`.
-- name: repo_items_after :many
-- param: repo_id i64
-- param: after_id i64
-- param: limit i64
SELECT i.id FROM items i WHERE i.repo_id = :repo_id AND i.id > :after_id ORDER BY i.id
LIMIT :limit;

-- As `unsync_relationships` and `unsync_to_stubs`, for one chunk's ids just before they're deleted: a
-- relationship written to one of them since the unsync started (a webhook, another repo's
-- import) would otherwise outlive its end.
-- name: unsync_relationships_of :exec
-- param: ids &[i64]
-- param: repo_id i64
-- param: keep_stubs bool
DELETE FROM relationships
WHERE (src_id IN (SELECT j.value FROM json_each(:ids) j)
       OR dst_id IN (SELECT j.value FROM json_each(:ids) j))
  AND (NOT :keep_stubs
       OR NOT (src_id IN (SELECT i.id FROM items i JOIN repos r ON r.id = i.repo_id
                          WHERE i.is_stub = 0 AND r.synced = 1 AND r.id <> :repo_id)
               OR dst_id IN (SELECT i.id FROM items i JOIN repos r ON r.id = i.repo_id
                             WHERE i.is_stub = 0 AND r.synced = 1 AND r.id <> :repo_id)));

-- name: unsync_to_stubs_of :exec
-- param: ids &[i64]
-- param: seq i64
UPDATE items SET is_stub = 1, body = NULL, state_reason = NULL, locked = 0, author_id = NULL,
  milestone_id = NULL, created_at = NULL, updated_at = NULL, closed_at = NULL,
  last_commented_at = NULL, comments_count = 0, pr_id = NULL, draft = NULL, merged_at = NULL,
  head_ref = NULL, base_ref = NULL, review_decision = NULL, issue_type = NULL, seq = :seq
WHERE id IN (SELECT j.value FROM json_each(:ids) j) AND is_stub = 0
  AND (id IN (SELECT r.src_id FROM relationships r) OR id IN (SELECT r.dst_id FROM relationships r));

-- name: unsync_labels_of :exec
-- param: ids &[i64]
DELETE FROM item_labels WHERE item_id IN (SELECT j.value FROM json_each(:ids) j);

-- name: unsync_assignees_of :exec
-- param: ids &[i64]
DELETE FROM item_assignees WHERE item_id IN (SELECT j.value FROM json_each(:ids) j);

-- name: unsync_comments_of :exec
-- param: ids &[i64]
DELETE FROM comments WHERE item_id IN (SELECT j.value FROM json_each(:ids) j);

-- The chunk's full items; its stubs stay while relationships reach them.
-- name: unsync_full_items :exec
-- param: ids &[i64]
DELETE FROM items WHERE id IN (SELECT j.value FROM json_each(:ids) j) AND is_stub = 0;

-- name: unsync_labels :exec
-- param: repo_id i64
DELETE FROM labels WHERE repo_id = :repo_id;

-- name: unsync_milestones :exec
-- param: repo_id i64
DELETE FROM milestones WHERE repo_id = :repo_id;

-- A stub no relationship reaches any more is gone.
-- name: drop_orphan_stubs :exec
DELETE FROM items WHERE is_stub = 1
  AND id NOT IN (SELECT r.src_id FROM relationships r)
  AND id NOT IN (SELECT r.dst_id FROM relationships r);

-- Repos whose unsync stopped partway (the process stopped, or a chunk failed): no longer synced,
-- yet still holding full items, labels or milestones. Nothing lists them meanwhile (the list
-- and the facet counts read only synced repos); the next reconcile finishes them.
-- name: unfinished_unsyncs :many
SELECT r.id FROM repos r
WHERE r.synced = 0
  AND (EXISTS (SELECT 1 FROM items i WHERE i.repo_id = r.id AND i.is_stub = 0)
       OR EXISTS (SELECT 1 FROM labels l WHERE l.repo_id = r.id)
       OR EXISTS (SELECT 1 FROM milestones m WHERE m.repo_id = r.id))
ORDER BY r.id;

-- name: unsync_repo :exec
-- param: repo_id i64
UPDATE repos SET synced = 0, importing = 0, import_failures = 0, import_retry_at = NULL
WHERE id = :repo_id;

-- Webhook deliveries and fan-out. A delivery is stored (deduped by its GUID) before it's acked,
-- and marked processed once every account it fans out to has it.

-- Records a delivery; 0 rows when its GUID was seen before.
-- name: insert_delivery :exec
-- param: guid &str
-- param: event &str
-- param: installation_id Option<i64>
-- param: payload &[u8]
-- param: now i64
INSERT INTO deliveries (guid, event, installation_id, payload, received_at)
VALUES (:guid, :event, :installation_id, :payload, :now)
ON CONFLICT (guid) DO NOTHING;

-- The newest delivery for an installation: where any gap starts.
-- name: touch_checkpoint :exec
-- param: installation_id i64
-- param: now i64
INSERT INTO checkpoints (installation_id, last_webhook_at) VALUES (:installation_id, :now)
ON CONFLICT (installation_id) DO UPDATE SET last_webhook_at = excluded.last_webhook_at;

-- Acked but not yet processed, received at or before :received_by, oldest first: resumed at
-- startup, and queued again when nothing holds them.
-- name: pending_deliveries :many
-- param: received_by i64
SELECT d.guid AS "guid!", d.event, d.payload FROM deliveries d
WHERE d.processed_at IS NULL AND d.received_at <= :received_by
ORDER BY d.received_at, d.rowid;

-- The GUIDs `pending_deliveries` would return, without their payloads: the requeue reads these
-- every minute, and the payload only of each delivery it takes.
-- name: pending_delivery_guids :many
-- param: received_by i64
SELECT d.guid AS "guid!" FROM deliveries d
WHERE d.processed_at IS NULL AND d.received_at <= :received_by
ORDER BY d.received_at, d.rowid;

-- A delivery not yet processed, to queue again; none once it has been.
-- name: pending_delivery :opt
-- param: guid &str
SELECT d.event, d.payload FROM deliveries d WHERE d.guid = :guid AND d.processed_at IS NULL;

-- Applied everywhere it fans out to: only the GUID is still needed, to dedupe redeliveries.
-- name: mark_processed :exec
-- param: guid &str
-- param: now i64
UPDATE deliveries SET processed_at = :now, payload = X'' WHERE guid = :guid;

-- Processed deliveries received at or before :before, past GitHub's redelivery window.
-- name: prune_deliveries :exec
-- param: before i64
DELETE FROM deliveries WHERE processed_at IS NOT NULL AND received_at <= :before;

-- Fan-out: the active accounts that sync a repo.
-- name: fan_out_targets :many
-- param: repo_id i64
SELECT a.github_user_id FROM synced_repos s
JOIN accounts a ON a.github_user_id = s.github_user_id
WHERE s.repo_id = :repo_id AND a.status = 'active'
ORDER BY a.github_user_id;

-- A fan-out write to the account's mirror failed: a sweep must repair it. `needs_resync_at`
-- keeps the first mark's time.
-- name: set_needs_resync :exec
-- param: github_user_id i64
-- param: now i64
UPDATE accounts SET needs_resync = 1, needs_resync_at = coalesce(needs_resync_at, :now),
  resync_marks = resync_marks + 1
WHERE github_user_id = :github_user_id;

-- name: add_synced_repo :exec
-- param: github_user_id i64
-- param: repo_id i64
-- param: now i64
INSERT INTO synced_repos (github_user_id, repo_id, added_at) VALUES (:github_user_id, :repo_id, :now)
ON CONFLICT (github_user_id, repo_id) DO NOTHING;

-- name: synced_repo_ids :many
-- param: github_user_id i64
SELECT s.repo_id FROM synced_repos s WHERE s.github_user_id = :github_user_id ORDER BY s.repo_id;

-- The account can no longer see the repo: webhooks for it stop fanning out to the account.
-- name: remove_synced_repo :exec
-- param: github_user_id i64
-- param: repo_id i64
DELETE FROM synced_repos WHERE github_user_id = :github_user_id AND repo_id = :repo_id;

-- Reconciliation (crates/server/src/reconcile).

-- The accounts marked `needs_resync`, since when, and how many marks they have had.
-- name: needs_resync_accounts :many
SELECT a.github_user_id, a.needs_resync_at, a.resync_marks FROM accounts a
WHERE a.needs_resync = 1 AND a.status = 'active'
ORDER BY a.github_user_id;

-- The account's mark, as of a repair that began when it had had :marks marks: repaired, unless a
-- mark came since.
-- name: clear_needs_resync :exec
-- param: github_user_id i64
-- param: marks i64
UPDATE accounts SET needs_resync = 0, needs_resync_at = NULL
WHERE github_user_id = :github_user_id AND resync_marks = :marks;

-- How many marks the account has had, as a repair begins.
-- name: resync_marks :one
-- param: github_user_id i64
SELECT coalesce((SELECT a.resync_marks FROM accounts a WHERE a.github_user_id = :github_user_id), 0) AS "x!: i64";

-- The user asks for a Resync: taken only if the last was at or before :earliest. 0 rows when it
-- was later (too soon).
-- name: claim_resync :exec
-- param: github_user_id i64
-- param: now i64
-- param: earliest i64
UPDATE accounts SET resync_asked_at = :now
WHERE github_user_id = :github_user_id
  AND (resync_asked_at IS NULL OR resync_asked_at <= :earliest);

-- A Resync claimed at :claimed failed to start: the claim is given back, the last Resync
-- :previous again (unless another claim came since).
-- name: release_resync :exec
-- param: github_user_id i64
-- param: claimed i64
-- param: previous Option<i64>
UPDATE accounts SET resync_asked_at = :previous
WHERE github_user_id = :github_user_id AND resync_asked_at = :claimed;

-- Every repo some active account syncs, and who syncs it: the repos sweeps read. A repo with
-- no active account (all dormant, or signed out for good) gets none.
-- name: swept_repos :many
SELECT s.repo_id, s.github_user_id FROM synced_repos s
JOIN accounts a ON a.github_user_id = s.github_user_id
WHERE a.status = 'active'
ORDER BY s.repo_id, s.github_user_id;

-- name: checkpoints :many
SELECT c.installation_id AS "installation_id!", c.last_webhook_at, c.redelivery_checked_at,
       c.last_full_sweep_at, c.redelivery_from
FROM checkpoints c ORDER BY c.installation_id;

-- The redelivery job checked the installation's deliveries through :at; :from is the oldest it
-- still waits to see arrive (NULL: none).
-- name: set_redelivery_checked :exec
-- param: installation_id i64
-- param: at i64
-- param: from Option<i64>
INSERT INTO checkpoints (installation_id, redelivery_checked_at, redelivery_from)
VALUES (:installation_id, :at, :from)
ON CONFLICT (installation_id) DO UPDATE SET redelivery_checked_at = excluded.redelivery_checked_at,
  redelivery_from = excluded.redelivery_from;

-- A full sweep (or an import) read the installation's repos whole, starting at :at.
-- name: set_full_sweep :exec
-- param: installation_id i64
-- param: at i64
INSERT INTO checkpoints (installation_id, last_full_sweep_at) VALUES (:installation_id, :at)
ON CONFLICT (installation_id) DO UPDATE SET
  last_full_sweep_at = max(coalesce(checkpoints.last_full_sweep_at, 0), excluded.last_full_sweep_at);

-- name: repo_probe :opt
-- param: repo_id i64
SELECT p.issues_since, p.issues_etag, p.comments_since, p.comments_etag
FROM repo_probes p WHERE p.repo_id = :repo_id;

-- name: set_issues_probe :exec
-- param: repo_id i64
-- param: since Option<i64>
-- param: etag Option<&str>
INSERT INTO repo_probes (repo_id, issues_since, issues_etag) VALUES (:repo_id, :since, :etag)
ON CONFLICT (repo_id) DO UPDATE SET issues_since = excluded.issues_since,
  issues_etag = excluded.issues_etag;

-- name: set_comments_probe :exec
-- param: repo_id i64
-- param: since Option<i64>
-- param: etag Option<&str>
INSERT INTO repo_probes (repo_id, comments_since, comments_etag) VALUES (:repo_id, :since, :etag)
ON CONFLICT (repo_id) DO UPDATE SET comments_since = excluded.comments_since,
  comments_etag = excluded.comments_etag;

-- Whether a delivery reached beghu (and was stored), whatever GitHub's log says of it.
-- name: delivery_received :one
-- param: guid &str
SELECT EXISTS (SELECT 1 FROM deliveries d WHERE d.guid = :guid) AS "x!: bool";

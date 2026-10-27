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

-- A fan-out write to the account's mirror failed: a sweep must repair it.
-- name: set_needs_resync :exec
-- param: github_user_id i64
UPDATE accounts SET needs_resync = 1 WHERE github_user_id = :github_user_id;

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

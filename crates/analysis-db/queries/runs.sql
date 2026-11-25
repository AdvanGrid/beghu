-- Analysis runs.

-- name: run :opt
-- param: id &str
SELECT id, repo_id, owner, name, number, producer, state, created_at, attached_at, last_heard_at,
       ended_at, ended_reason, pinned, refused, last_report
FROM runs WHERE id = :id;

-- The PR's latest run, live or ended, as the PR panel shows it.
-- name: latest_run :opt
-- param: repo_id i64
-- param: number i64
SELECT id, producer, state, created_at, attached_at, last_heard_at, ended_reason, pinned_head,
       refused_errors
FROM runs WHERE repo_id = :repo_id AND number = :number
ORDER BY created_at DESC, id DESC LIMIT 1;

-- The PR's live run, if any.
-- name: live_run :opt
-- param: repo_id i64
-- param: number i64
SELECT id, state FROM runs WHERE repo_id = :repo_id AND number = :number AND state <> 'ended';

-- name: insert_run :exec
-- param: id &str
-- param: repo_id i64
-- param: owner &str
-- param: name &str
-- param: number i64
-- param: producer &str
-- param: now i64
INSERT INTO runs (id, repo_id, owner, name, number, producer, state, created_at, last_heard_at)
VALUES (:id, :repo_id, :owner, :name, :number, :producer, 'waiting', :now, :now);

-- Ends a run that is still live: how many rows changed (0 when it had ended already).
-- name: end_run :exec
-- param: id &str
-- param: reason &str
-- param: now i64
UPDATE runs SET state = 'ended', ended_at = :now, ended_reason = :reason
WHERE id = :id AND state <> 'ended';

-- The first fetch of a run file pins the PR: only a waiting run (0 rows when another fetch pinned
-- it first, or it ended).
-- name: attach_run :exec
-- param: id &str
-- param: pinned &str
-- param: pinned_head &str
-- param: now i64
UPDATE runs SET state = 'attached', attached_at = :now, last_heard_at = :now, pinned = :pinned,
  pinned_head = :pinned_head
WHERE id = :id AND state = 'waiting';

-- name: heard_run :exec
-- param: id &str
-- param: now i64
UPDATE runs SET last_heard_at = :now WHERE id = :id AND state <> 'ended';

-- name: refuse_upload :exec
-- param: id &str
-- param: report &str
-- param: errors i64
UPDATE runs SET refused = refused + 1, last_report = :report, refused_errors = :errors
WHERE id = :id;

-- An upload was accepted: the run's last upload is no longer a refused one.
-- name: accept_upload :exec
-- param: id &str
UPDATE runs SET refused_errors = NULL WHERE id = :id;

-- Every live run: startup re-arms each one's expiry.
-- name: live_runs :many
SELECT id FROM runs WHERE state <> 'ended';

-- The daily check: runs that ended before :before are kept no longer (they only told a call with
-- their token why they ended). Their IDs, for their tokens.
-- name: prune_ended_runs :many
-- param: before i64
DELETE FROM runs WHERE state = 'ended' AND ended_at < :before RETURNING id;

-- The account lost Read on the repo: its runs there, each with why it ended (NULL: still live).
-- name: repo_runs :many
-- param: repo_id i64
SELECT id, number, ended_reason FROM runs WHERE repo_id = :repo_id;

-- name: delete_repo_runs :exec
-- param: repo_id i64
DELETE FROM runs WHERE repo_id = :repo_id;

-- Every repo the account has runs or analyses of, as the run or analysis names it: the daily
-- check deletes them for any repo the account's mirror says it can't read, retrying a loss of
-- Read whose delete failed or was cut off.
-- name: repos :many
SELECT repo_id AS "repo_id!: i64", owner AS "owner!: String", name AS "name!: String"
FROM (SELECT repo_id, owner, name FROM runs UNION SELECT repo_id, owner, name FROM analyses)
GROUP BY repo_id ORDER BY repo_id;

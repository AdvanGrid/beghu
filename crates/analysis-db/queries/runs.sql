-- Analysis runs.

-- name: run :opt
-- param: id &str
SELECT id, repo_id, owner, name, number, producer, state, created_at, attached_at, last_heard_at,
       ended_at, ended_reason, pinned, refused, last_report
FROM runs WHERE id = :id;

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
-- param: now i64
UPDATE runs SET state = 'attached', attached_at = :now, last_heard_at = :now, pinned = :pinned
WHERE id = :id AND state = 'waiting';

-- name: heard_run :exec
-- param: id &str
-- param: now i64
UPDATE runs SET last_heard_at = :now WHERE id = :id AND state <> 'ended';

-- name: refuse_upload :exec
-- param: id &str
-- param: report &str
UPDATE runs SET refused = refused + 1, last_report = :report WHERE id = :id;

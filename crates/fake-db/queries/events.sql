-- The repos' issue events feeds (`fake_events`, `events.rs`).

-- name: next_event_seq :one
SELECT coalesce(max(e.seq), 0) + 1 AS "n!: i64" FROM fake_events e;

-- name: add_event :exec
-- param: seq i64
-- param: id i64
-- param: repo_id i64
-- param: issue_id i64
-- param: event &str
-- param: actor_id Option<i64>
-- param: other_id Option<i64>
-- param: created_at i64
INSERT INTO fake_events (seq, id, repo_id, issue_id, event, actor_id, other_id, created_at)
VALUES (:seq, :id, :repo_id, :issue_id, :event, :actor_id, :other_id, :created_at);

-- A page of a repo's feed, newest first. An event whose issue is gone (deleted since) is left
-- out, as GitHub leaves it out.
-- name: repo_events :many
-- param: repo_id i64
-- param: limit i64
-- param: offset i64
SELECT e.id, e.issue_id, e.event, e.actor_id, e.other_id, e.created_at
FROM fake_events e JOIN items i ON i.id = e.issue_id
WHERE e.repo_id = :repo_id
ORDER BY e.created_at DESC, e.seq DESC LIMIT :limit OFFSET :offset;

-- A PR's closing references: the issues it closes when it merges.
-- name: add_closes :exec
-- param: pr_id i64
-- param: issue_id i64
INSERT OR IGNORE INTO relationships (kind, src_id, dst_id, position, seq)
VALUES ('closes', :pr_id, :issue_id, NULL, (SELECT coalesce(max(o.seq), 0) + 1 FROM relationships o));

-- name: remove_closes :exec
-- param: pr_id i64
-- param: issue_id i64
DELETE FROM relationships WHERE kind = 'closes' AND src_id = :pr_id AND dst_id = :issue_id;

-- A PR's review decision, set by a review (`NULL`: none needed).
-- name: set_review_decision :exec
-- param: id i64
-- param: decision Option<&str>
-- param: updated_at i64
UPDATE items SET review_decision = :decision, updated_at = :updated_at WHERE id = :id;

-- The PRs that close an issue when they merge (GitHub's `closedByPullRequestsReferences`).
-- name: closed_by :many
-- param: issue_id i64
SELECT r.src_id AS pr FROM relationships r WHERE r.kind = 'closes' AND r.dst_id = :issue_id ORDER BY r.src_id;

-- A review submitted on PR `pr_id` (its issue-side id): its id.
-- name: add_review :one
-- param: pr_id i64
-- param: user_id i64
-- param: state &str
-- param: commit_id &str
-- param: submitted_at i64
INSERT INTO fake_reviews (pr_id, user_id, state, commit_id, submitted_at)
VALUES (:pr_id, :user_id, :state, :commit_id, :submitted_at) RETURNING id;

-- The PR's latest review that a dismissal can dismiss (an approval or a request for changes).
-- name: last_dismissable_review :opt
-- param: pr_id i64
SELECT r.id, r.user_id, r.commit_id, r.submitted_at FROM fake_reviews r
WHERE r.pr_id = :pr_id AND r.state IN ('approved', 'changes_requested')
ORDER BY r.id DESC LIMIT 1;

-- name: dismiss_review :exec
-- param: id i64
UPDATE fake_reviews SET state = 'dismissed' WHERE id = :id;

-- Each reviewer's latest approval or request for changes still standing on the PR.
-- name: standing_reviews :many
-- param: pr_id i64
SELECT r.state FROM fake_reviews r
WHERE r.pr_id = :pr_id AND r.id = (
  SELECT max(o.id) FROM fake_reviews o
  WHERE o.pr_id = r.pr_id AND o.user_id = r.user_id AND o.state <> 'commented')
  AND r.state IN ('approved', 'changes_requested');

-- Account preferences: one row per account, made by its first change. Each change sets one
-- field (`PATCH /api/prefs`), and the last write wins.

-- name: set_comment_order :exec
-- param: github_user_id i64
-- param: comment_order Option<&str>
INSERT INTO preferences (github_user_id, comment_order) VALUES (:github_user_id, :comment_order)
ON CONFLICT (github_user_id) DO UPDATE SET comment_order = excluded.comment_order;

-- The row a key change updates, if the account has none yet.
-- name: ensure_preferences :exec
-- param: github_user_id i64
INSERT INTO preferences (github_user_id) VALUES (:github_user_id) ON CONFLICT (github_user_id) DO NOTHING;

-- One action's bindings (`action` as the web app names it): NULL for the preset's, '' for none.
-- Every other column stays as it is. An action without its CASE arm here, and in the list after
-- WHERE, changes nothing: the count is 0, which the server takes as a failure, not a write.
-- name: set_key :exec
-- param: github_user_id i64
-- param: action &str
-- param: binding Option<&str>
UPDATE preferences SET
  key_next = CASE :action WHEN 'next' THEN :binding ELSE key_next END,
  key_previous = CASE :action WHEN 'previous' THEN :binding ELSE key_previous END,
  key_first = CASE :action WHEN 'first' THEN :binding ELSE key_first END,
  key_last = CASE :action WHEN 'last' THEN :binding ELSE key_last END,
  key_open_issue = CASE :action WHEN 'openIssue' THEN :binding ELSE key_open_issue END,
  key_to_list = CASE :action WHEN 'toList' THEN :binding ELSE key_to_list END,
  key_focus_filter = CASE :action WHEN 'focusFilter' THEN :binding ELSE key_focus_filter END,
  key_create = CASE :action WHEN 'create' THEN :binding ELSE key_create END,
  key_toggle_mode = CASE :action WHEN 'toggleMode' THEN :binding ELSE key_toggle_mode END,
  key_collapse = CASE :action WHEN 'collapse' THEN :binding ELSE key_collapse END,
  key_expand = CASE :action WHEN 'expand' THEN :binding ELSE key_expand END,
  key_labels = CASE :action WHEN 'labels' THEN :binding ELSE key_labels END,
  key_assignees = CASE :action WHEN 'assignees' THEN :binding ELSE key_assignees END,
  key_milestone = CASE :action WHEN 'milestone' THEN :binding ELSE key_milestone END,
  key_blocked_by = CASE :action WHEN 'blockedBy' THEN :binding ELSE key_blocked_by END,
  key_blocking = CASE :action WHEN 'blocking' THEN :binding ELSE key_blocking END,
  key_relates_to = CASE :action WHEN 'relatesTo' THEN :binding ELSE key_relates_to END,
  key_comment = CASE :action WHEN 'comment' THEN :binding ELSE key_comment END,
  key_edit_title = CASE :action WHEN 'editTitle' THEN :binding ELSE key_edit_title END,
  key_close_reopen = CASE :action WHEN 'closeReopen' THEN :binding ELSE key_close_reopen END,
  key_send = CASE :action WHEN 'send' THEN :binding ELSE key_send END,
  key_save_edit = CASE :action WHEN 'saveEdit' THEN :binding ELSE key_save_edit END,
  key_cancel_edit = CASE :action WHEN 'cancelEdit' THEN :binding ELSE key_cancel_edit END,
  key_image_open = CASE :action WHEN 'imageOpen' THEN :binding ELSE key_image_open END,
  key_image_close = CASE :action WHEN 'imageClose' THEN :binding ELSE key_image_close END,
  key_help = CASE :action WHEN 'help' THEN :binding ELSE key_help END
WHERE github_user_id = :github_user_id AND :action IN ('next', 'previous', 'first', 'last',
  'openIssue', 'toList', 'focusFilter', 'create', 'toggleMode', 'collapse', 'expand', 'labels', 'assignees',
  'milestone', 'blockedBy', 'blocking', 'relatesTo', 'comment', 'editTitle', 'closeReopen', 'send', 'saveEdit', 'cancelEdit',
  'imageOpen', 'imageClose', 'help');

-- The account's own bindings, by action (as the web app names it): only those it set, '' for
-- one it left unbound. An action not listed has the preset's.
-- name: key_bindings :many
-- param: github_user_id i64
SELECT 'next' AS "action!: String", key_next AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_next IS NOT NULL
UNION ALL SELECT 'previous' AS "action!: String", key_previous AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_previous IS NOT NULL
UNION ALL SELECT 'first' AS "action!: String", key_first AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_first IS NOT NULL
UNION ALL SELECT 'last' AS "action!: String", key_last AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_last IS NOT NULL
UNION ALL SELECT 'openIssue' AS "action!: String", key_open_issue AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_open_issue IS NOT NULL
UNION ALL SELECT 'toList' AS "action!: String", key_to_list AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_to_list IS NOT NULL
UNION ALL SELECT 'focusFilter' AS "action!: String", key_focus_filter AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_focus_filter IS NOT NULL
UNION ALL SELECT 'create' AS "action!: String", key_create AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_create IS NOT NULL
UNION ALL SELECT 'toggleMode' AS "action!: String", key_toggle_mode AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_toggle_mode IS NOT NULL
UNION ALL SELECT 'collapse' AS "action!: String", key_collapse AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_collapse IS NOT NULL
UNION ALL SELECT 'expand' AS "action!: String", key_expand AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_expand IS NOT NULL
UNION ALL SELECT 'labels' AS "action!: String", key_labels AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_labels IS NOT NULL
UNION ALL SELECT 'assignees' AS "action!: String", key_assignees AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_assignees IS NOT NULL
UNION ALL SELECT 'milestone' AS "action!: String", key_milestone AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_milestone IS NOT NULL
UNION ALL SELECT 'blockedBy' AS "action!: String", key_blocked_by AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_blocked_by IS NOT NULL
UNION ALL SELECT 'blocking' AS "action!: String", key_blocking AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_blocking IS NOT NULL
UNION ALL SELECT 'relatesTo' AS "action!: String", key_relates_to AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_relates_to IS NOT NULL
UNION ALL SELECT 'comment' AS "action!: String", key_comment AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_comment IS NOT NULL
UNION ALL SELECT 'editTitle' AS "action!: String", key_edit_title AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_edit_title IS NOT NULL
UNION ALL SELECT 'closeReopen' AS "action!: String", key_close_reopen AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_close_reopen IS NOT NULL
UNION ALL SELECT 'send' AS "action!: String", key_send AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_send IS NOT NULL
UNION ALL SELECT 'saveEdit' AS "action!: String", key_save_edit AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_save_edit IS NOT NULL
UNION ALL SELECT 'cancelEdit' AS "action!: String", key_cancel_edit AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_cancel_edit IS NOT NULL
UNION ALL SELECT 'imageOpen' AS "action!: String", key_image_open AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_image_open IS NOT NULL
UNION ALL SELECT 'imageClose' AS "action!: String", key_image_close AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_image_close IS NOT NULL
UNION ALL SELECT 'help' AS "action!: String", key_help AS "binding!" FROM preferences WHERE github_user_id = :github_user_id AND key_help IS NOT NULL;

-- Disconnect: the account's preferences go.
-- name: delete_preferences :exec
-- param: github_user_id i64
DELETE FROM preferences WHERE github_user_id = :github_user_id;

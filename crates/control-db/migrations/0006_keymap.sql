-- The keymap: one column per key action (web/src/keys.ts, `ACTIONS`), each the account's own
-- bindings for it, one per line (a binding is a key, a chord such as `Mod+Enter`, or a two-key
-- sequence such as `g i`). NULL means the GitHub preset's; '' means deliberately unbound.
--
-- A new action later is a migration adding its column, NULL for every row: existing accounts
-- get its default. A default key that an account already gave another action stays theirs, and
-- the new action starts unbound (the web app resolves the keymap that way).
ALTER TABLE preferences ADD COLUMN key_next TEXT;
ALTER TABLE preferences ADD COLUMN key_previous TEXT;
ALTER TABLE preferences ADD COLUMN key_first TEXT;
ALTER TABLE preferences ADD COLUMN key_last TEXT;
ALTER TABLE preferences ADD COLUMN key_open_issue TEXT;
ALTER TABLE preferences ADD COLUMN key_to_list TEXT;
ALTER TABLE preferences ADD COLUMN key_focus_filter TEXT;
ALTER TABLE preferences ADD COLUMN key_create TEXT;
ALTER TABLE preferences ADD COLUMN key_toggle_mode TEXT;
ALTER TABLE preferences ADD COLUMN key_labels TEXT;
ALTER TABLE preferences ADD COLUMN key_assignees TEXT;
ALTER TABLE preferences ADD COLUMN key_milestone TEXT;
ALTER TABLE preferences ADD COLUMN key_comment TEXT;
ALTER TABLE preferences ADD COLUMN key_edit_title TEXT;
ALTER TABLE preferences ADD COLUMN key_close_reopen TEXT;
ALTER TABLE preferences ADD COLUMN key_send TEXT;
ALTER TABLE preferences ADD COLUMN key_save_edit TEXT;
ALTER TABLE preferences ADD COLUMN key_cancel_edit TEXT;
ALTER TABLE preferences ADD COLUMN key_image_open TEXT;
ALTER TABLE preferences ADD COLUMN key_image_close TEXT;
ALTER TABLE preferences ADD COLUMN key_help TEXT;

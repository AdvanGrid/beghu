-- The indexes the rusqlite server creates at startup (see src/main.rs), so both layers query the
-- same plans.
CREATE INDEX IF NOT EXISTS item_labels_by_label ON item_labels(label_id, item_id);
CREATE INDEX IF NOT EXISTS item_assignees_by_user ON item_assignees(user_id, item_id);
CREATE INDEX IF NOT EXISTS issue_list ON items(state, updated_at DESC, id DESC, title) WHERE kind = 'issue' AND is_stub = 0;
CREATE INDEX IF NOT EXISTS items_by_seq ON items(seq);
CREATE INDEX IF NOT EXISTS item_cache ON items(updated_at DESC, id DESC, number, repo_id, kind, title, state, comments_count, seq) WHERE is_stub = 0;
ANALYZE;

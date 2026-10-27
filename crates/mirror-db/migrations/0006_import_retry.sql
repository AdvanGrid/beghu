-- The import's bookkeeping beside `importing` (0005). `import_started` is the `seq` of the
-- transaction that last started the repo's import: a round of the import finishes (or records a
-- failure for) only the import it began, so a repo unsynced and picked again while a round ran
-- is imported again whole. A repo whose import failed for good stays `importing`, with
-- `import_failures` in a row and `import_retry_at` (Unix seconds), when it's tried again; both
-- clear when its import starts afresh or finishes.
ALTER TABLE repos ADD COLUMN import_started INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repos ADD COLUMN import_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repos ADD COLUMN import_retry_at INTEGER;

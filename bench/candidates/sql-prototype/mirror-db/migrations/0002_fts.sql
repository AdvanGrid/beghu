-- In place: builds the title/body index from rows already in the mirror. At 50k this is the
-- slow kind of in-place migration (seconds), which is what makes waiters visible.
CREATE VIRTUAL TABLE items_fts USING fts5(title, body, content='items', content_rowid='id');
INSERT INTO items_fts(rowid, title, body) SELECT id, title, coalesce(body, '') FROM items;

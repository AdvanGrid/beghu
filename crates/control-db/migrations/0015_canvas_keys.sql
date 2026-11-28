-- The PR view's canvas keys (web/src/keys.ts, the `canvas` area): zoom in, zoom out, reset zoom,
-- fit, out one level, and Escape's unpin-or-clear, NULL (the preset's) for every account until it
-- sets one, as 0006's columns are.
ALTER TABLE preferences ADD COLUMN key_zoom_in TEXT;
ALTER TABLE preferences ADD COLUMN key_zoom_out TEXT;
ALTER TABLE preferences ADD COLUMN key_zoom_reset TEXT;
ALTER TABLE preferences ADD COLUMN key_zoom_fit TEXT;
ALTER TABLE preferences ADD COLUMN key_out_level TEXT;
ALTER TABLE preferences ADD COLUMN key_canvas_escape TEXT;

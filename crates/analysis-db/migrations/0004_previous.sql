-- The ID of the analysis an upload replaced: the PR view shows "Since the last analysis" when
-- there was one, even when every ID survived (an empty `carried`). NULL for the PR's first
-- analysis, and for an analysis stored before this column.
ALTER TABLE analyses ADD COLUMN previous_id TEXT;

-- What a run's token answers before, or without, the run's row in `analyses.db`:
-- - `producer`: a CLI run's every call carries the CLI's credential, checked before anything else
--   about the run, so its token alone learns nothing (not even that the run ended);
-- - `ended_reason`: why the run ended, for a run whose row was deleted with its repo's analyses
--   (the account lost Read on the repo), so its token is still told why (410). NULL while the
--   run's row says.
ALTER TABLE run_tokens ADD COLUMN producer TEXT NOT NULL DEFAULT 'button'
  CHECK (producer IN ('button', 'cli', 'beghu'));
ALTER TABLE run_tokens ADD COLUMN ended_reason TEXT;

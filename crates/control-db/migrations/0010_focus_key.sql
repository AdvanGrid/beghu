-- Focus view's key (web/src/keys.ts): `focusIssue`, which puts the open issue in focus, NULL (the
-- preset's) for every account until it sets one, as 0006's columns are.
ALTER TABLE preferences ADD COLUMN key_focus_issue TEXT;

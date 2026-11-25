-- A disconnect's delete of the account's `analyses.db` (PR view, #176), recorded in the write
-- that marks the account `needs_sign_in`: when it disconnected (Unix ms, no two marks the same,
-- so a clear takes only the mark it saw), until the delete is done. A startup finishes the
-- delete for every account still marked (a crash cut it off), and so does a sign-in before it
-- activates the account and revives the file: no account is active with the mark on. Either
-- clears the mark once the file is gone. A plain sign-out by GitHub (refused or lapsed tokens, a
-- revoke) never sets it: those keep the analyses.
ALTER TABLE accounts ADD COLUMN disconnected_at INTEGER;

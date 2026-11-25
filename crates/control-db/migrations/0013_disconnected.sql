-- A disconnect's delete of the account's `analyses.db` (PR view, #176), recorded in the write
-- that marks the account `needs_sign_in`: when it disconnected, until the delete is done. A
-- startup finishes the delete for every account still marked (a crash cut it off), and so does a
-- sign-in before it revives the file; either clears the mark once the file is gone. A plain
-- sign-out by GitHub (refused or lapsed tokens, a revoke) never sets it: those keep the analyses.
ALTER TABLE accounts ADD COLUMN disconnected_at INTEGER;

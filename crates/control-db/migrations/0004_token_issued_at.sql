-- When each account's token pair was issued (a sign-in or a refresh), in Unix milliseconds: a
-- revoke GitHub sent before then was about an older grant, and leaves these tokens alone.
-- Pairs stored before this column existed count as issued at 0, the oldest.
ALTER TABLE account_tokens ADD COLUMN issued_at INTEGER NOT NULL DEFAULT 0;

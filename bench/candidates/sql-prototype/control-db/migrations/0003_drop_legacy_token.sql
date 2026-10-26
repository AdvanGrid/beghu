-- Not additive: a build that still reads sessions.legacy_token can't run after this.
ALTER TABLE sessions DROP COLUMN legacy_token;

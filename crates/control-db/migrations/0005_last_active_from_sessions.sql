-- Dormancy (#114): `last_active_at` was moved only by signing in until now; from here requests and
-- open streams move it too. An account used since it last signed in would look unused for as long
-- as it has been signed in, and go dormant at the first daily check. So each account starts from
-- the latest use of any browser session it's signed in on (`last_seen_at`, which moves hourly),
-- when that's later.
UPDATE accounts SET last_active_at = max(last_active_at, coalesce((
  SELECT max(s.last_seen_at) FROM browser_session_accounts sa
  JOIN browser_sessions s ON s.id_hash = sa.session_id
  WHERE sa.github_user_id = accounts.github_user_id), 0));

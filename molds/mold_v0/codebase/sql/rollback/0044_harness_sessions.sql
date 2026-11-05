-- Rolling back past 0044_harness_sessions (mold_v0-243), for a release from before it (and before rolling back
-- 0043_credential_last_used, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0044_harness_sessions.sql
-- The workspace agent's tables go, and the link from a run to its session. Sessions are conversations people had and
-- money they spent: refused while any session exists unless the operator says to drop them anyway
--   psql ... -c "SET app.harness_rollback_drop = 'on'" -f sql/rollback/0044_harness_sessions.sql   (one session: use -1)
-- The wakes stay in `runs` (their spend with them), as runs of a kind the older release does not have: never claimed.
-- Found by its name, so it also undoes it where it was recorded under another number. Refused when a later migration
-- is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'harness_sessions');
  n BIGINT;
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'harness_sessions is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (harness_sessions): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  n := (SELECT count(*) FROM harness_sessions);
  IF n > 0 AND coalesce(current_setting('app.harness_rollback_drop', true), '') <> 'on' THEN
    RAISE EXCEPTION 'the workspace agent holds % session(s): not dropped (SET app.harness_rollback_drop = ''on'' in the same session to drop them)', n;
  END IF;
  DROP TABLE IF EXISTS platform_setting_changes;
  DROP TABLE IF EXISTS harness_wake_spend;
  DROP TABLE IF EXISTS harness_budget_grants;
  DROP TABLE IF EXISTS harness_session_requests;
  DROP TABLE IF EXISTS harness_session_messages;
  DROP TABLE IF EXISTS harness_sessions;
  DROP INDEX IF EXISTS runs_harness_session_idx;
  ALTER TABLE runs DROP COLUMN IF EXISTS harness_session_id;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;

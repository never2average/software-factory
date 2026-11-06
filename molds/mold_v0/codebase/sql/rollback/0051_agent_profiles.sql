-- Rolling back past 0051_agent_profiles (mold_v0-261), for a release from before it (and before rolling back
-- 0050_teams_and_visibility, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0051_agent_profiles.sql
-- Drops the agent profiles, their versions and their change history, and what a session carried of them (its profile,
-- version and record). The sessions themselves stay, with their frozen policy, spend and transcript: the older release
-- runs each as it was started (the frozen policy holds the profile's instructions, model and limits). Found by its name,
-- so it also undoes it where it was recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'agent_profiles');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'agent_profiles is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (agent_profiles): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP INDEX IF EXISTS harness_sessions_record_idx;
  ALTER TABLE harness_sessions DROP CONSTRAINT IF EXISTS harness_sessions_record_both;
  ALTER TABLE harness_sessions DROP CONSTRAINT IF EXISTS harness_sessions_profile_both;
  ALTER TABLE harness_sessions DROP COLUMN IF EXISTS record_key;
  ALTER TABLE harness_sessions DROP COLUMN IF EXISTS record_area;
  ALTER TABLE harness_sessions DROP COLUMN IF EXISTS profile_version;
  ALTER TABLE harness_sessions DROP COLUMN IF EXISTS profile_id;
  DROP TABLE IF EXISTS agent_profile_changes;
  DROP TABLE IF EXISTS agent_profile_versions;
  DROP TABLE IF EXISTS agent_profiles;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;

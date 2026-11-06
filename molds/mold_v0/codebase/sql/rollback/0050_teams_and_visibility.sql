-- Rolling back past 0050_teams_and_visibility (mold_v0-259), for a release from before it (and before rolling back
-- 0049_record_changes, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0050_teams_and_visibility.sql
-- Drops the teams, their members and their history, the visibility policy, and each record's visibility, team, owner and
-- collaborators: every record is open to its whole workspace again, as the older release shows it. The records themselves
-- stay. Found by its name, so it also undoes it where it was recorded under another number. Refused when a later migration
-- is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'teams_and_visibility');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'teams_and_visibility is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (teams_and_visibility): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP POLICY IF EXISTS record_visibility ON workspace_records;
  DROP INDEX IF EXISTS workspace_records_team_idx;
  ALTER TABLE workspace_records DROP CONSTRAINT IF EXISTS workspace_records_visibility_check;
  ALTER TABLE workspace_records DROP COLUMN IF EXISTS collaborators;
  ALTER TABLE workspace_records DROP COLUMN IF EXISTS owner_id;
  ALTER TABLE workspace_records DROP COLUMN IF EXISTS team_id;
  ALTER TABLE workspace_records DROP COLUMN IF EXISTS visibility;
  DROP TABLE IF EXISTS workspace_team_changes;
  DROP TABLE IF EXISTS workspace_team_members;
  DROP TABLE IF EXISTS workspace_teams;
  DROP FUNCTION IF EXISTS app_viewer();
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;

-- Rolling back past 0054_team_role_names (mold_v0-262), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0054_team_role_names.sql
-- Drops each membership's role name (its level stays: a lead is a lead, everyone else a member, as the older release
-- reads them) and the 'role_set' changes (a role changed within its level, which the older release has no word for).
-- Found by its name, so it also undoes it where it was recorded under another number. Refused when a later migration
-- is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'team_role_names');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'team_role_names is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (team_role_names): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DELETE FROM workspace_team_changes WHERE action = 'role_set';
  ALTER TABLE workspace_team_changes DROP CONSTRAINT IF EXISTS workspace_team_changes_action_check;
  ALTER TABLE workspace_team_changes ADD CONSTRAINT workspace_team_changes_action_check
    CHECK (action IN ('created', 'renamed', 'deleted', 'member_added', 'member_removed', 'lead_set', 'lead_unset'));
  ALTER TABLE workspace_team_members DROP COLUMN IF EXISTS role_name;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;

-- Rolling back past 0053_inherited_visibility (mold_v0-262), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0053_inherited_visibility.sql
-- Puts back 0050's visibility policy and constraint and drops the parent's columns and lookup: a record that inherited
-- its parent's visibility becomes private to its owner (or open to the workspace when it has none), which the older
-- release shows as it shows any private record. Found by its name, so it also undoes it where it was recorded under
-- another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'inherited_visibility');
  r TEXT := app_tenant_role();
  rule TEXT := $rule$(visibility IS NULL OR visibility = 'workspace' OR app_viewer() = '*'
    OR (owner_id IS NOT NULL AND owner_id = app_viewer()) OR app_viewer() = ANY (coalesce(collaborators, '{}'::text[]))
    OR (visibility = 'team' AND team_id IS NOT NULL AND EXISTS (SELECT 1 FROM workspace_team_members m
          WHERE m.org_id = workspace_records.org_id AND m.team_id = workspace_records.team_id AND m.user_id = app_viewer())))$rule$;
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'inherited_visibility is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (inherited_visibility): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP POLICY IF EXISTS record_visibility ON workspace_records;
  ALTER TABLE workspace_records DROP CONSTRAINT IF EXISTS workspace_records_inherit_check;
  ALTER TABLE workspace_records DROP CONSTRAINT IF EXISTS workspace_records_visibility_check;
  UPDATE workspace_records SET visibility = CASE WHEN owner_id IS NULL THEN 'workspace' ELSE 'private' END WHERE visibility = 'inherit';
  ALTER TABLE workspace_records ADD CONSTRAINT workspace_records_visibility_check CHECK (visibility IN ('workspace', 'team', 'private'));
  DROP INDEX IF EXISTS workspace_records_area_key_idx;
  ALTER TABLE workspace_records DROP COLUMN IF EXISTS inherit_key;
  ALTER TABLE workspace_records DROP COLUMN IF EXISTS inherit_area;
  DROP FUNCTION IF EXISTS app_record_visible(TEXT, TEXT);
  EXECUTE format('CREATE POLICY record_visibility ON workspace_records AS RESTRICTIVE TO %I USING %s WITH CHECK %s', r, rule, rule);
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;

-- Rolling back past 0056_workspace_recipes (mold_v0-271), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0056_workspace_recipes.sql
-- Drops the workspace recipes, their versions, uploads and proposals: the older release has no recipes, and an agent
-- profile that picked one starts its sessions with its own files only (the older release does not read `recipe`). The
-- uploads' bytes stay in the object store under recipes/uploads/ (remove that prefix by hand to free the space). Found by
-- its name, so it also undoes it where it was recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'workspace_recipes');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'workspace_recipes is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (workspace_recipes): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DROP TABLE IF EXISTS workspace_recipe_proposals;
  DROP TABLE IF EXISTS workspace_recipe_versions;
  DROP TABLE IF EXISTS workspace_recipe_uploads;
  DROP TABLE IF EXISTS workspace_recipes;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;

-- Rolling back past 0057_freestyle_vault (mold_v0-274), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0057_freestyle_vault.sql
-- Refused, changing nothing, while the runs' sandboxes come from Freestyle (the platform setting APP_RUN_SANDBOX says
-- freestyle: the older release has no Freestyle provider, and its runs would wait) or the key vault holds a Freestyle key
-- (the older release could not list or delete it): choose another sandbox provider in Agent configuration, let the runs
-- in Freestyle VMs finish, delete the key on Key vault, then roll back. Otherwise the provider row goes, and the ledger
-- row. Found by its name, so it also undoes it where it was recorded under another number. Refused when a later
-- migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'freestyle_vault');
  n BIGINT;
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'freestyle_vault is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (freestyle_vault): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  IF EXISTS (SELECT 1 FROM platform_settings WHERE key = 'APP_RUN_SANDBOX' AND value = to_jsonb('freestyle'::text)) THEN
    RAISE EXCEPTION 'the runs'' sandboxes come from Freestyle (Agent configuration, Sandbox provider): choose another provider and let the runs in Freestyle VMs finish, then roll back';
  END IF;
  SELECT count(*) FROM vault_credentials WHERE provider = 'freestyle' INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'the key vault holds a Freestyle key the older release cannot use: delete it on Key vault, then roll back';
  END IF;
  DELETE FROM vault_providers WHERE slug = 'freestyle';
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;

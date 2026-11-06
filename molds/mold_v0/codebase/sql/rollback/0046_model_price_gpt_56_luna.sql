-- Rolling back past 0046_model_price_gpt_56_luna (mold_v0-248), for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0046_model_price_gpt_56_luna.sql
-- Forgets that the migration ran. The gpt-5.6-luna price row stays: the older release reads it like any other row.
-- Found by its name. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'model_price_gpt_56_luna');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'model_price_gpt_56_luna is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (model_price_gpt_56_luna): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  DELETE FROM schema_migrations WHERE version = v;
END
$rb$;

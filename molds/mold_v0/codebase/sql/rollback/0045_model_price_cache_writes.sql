-- Rolling back past 0045_model_price_cache_writes (mold_v0-246), for a release from before it (and before rolling back
-- 0044_harness_sessions, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0045_model_price_cache_writes.sql
-- Drops the cache-write prices and the day's count of cache-write tokens; the older release prices cache writes as
-- plain input again. The Haiku price rows stay: the older release reads them like any other row (and meters Haiku at
-- its price instead of $0); a database at 0044 that never had them reads the same apart from those two rows. Found by
-- its name, so it also undoes it where it was recorded under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'model_price_cache_writes');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'model_price_cache_writes is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (model_price_cache_writes): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  ALTER TABLE gateway_model_usage DROP COLUMN IF EXISTS cache_write_tokens;
  ALTER TABLE model_prices DROP COLUMN IF EXISTS cache_write_1h_per_mtok;
  ALTER TABLE model_prices DROP COLUMN IF EXISTS cache_write_per_mtok;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;

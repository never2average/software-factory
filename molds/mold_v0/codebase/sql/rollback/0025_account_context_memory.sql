-- Rolling back past 0025_account_context_memory (mold_v0-142), for a release from before it (and before rolling back
-- 0024, which refuses while a later migration is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0025_account_context_memory.sql
-- Where 0025 was ADOPTED (a host pack made the tables: schema_adoptions has its row) the tables, their rows, policies and
-- grants are left exactly as they are: they are that host pack's again in the older release, whose migration that made
-- them is still recorded at its own checksum. Only 0025's ledger rows go. Where 0025 MADE the tables, they are dropped,
-- and only when all three are empty (an older release never wrote them); otherwise it refuses and changes nothing.
-- Refused when a later migration is applied.
DO $rb$
DECLARE
  adopted BOOLEAN;
  n BIGINT;
BEGIN
  IF (SELECT max(version) FROM schema_migrations) <> 25 THEN
    RAISE EXCEPTION 'this database is at migration %, not 0025: roll back the later migrations first', (SELECT max(version) FROM schema_migrations);
  END IF;
  adopted := to_regclass('public.schema_adoptions') IS NOT NULL
    AND EXISTS (SELECT 1 FROM schema_adoptions WHERE pack = '' AND version = 25);
  IF NOT adopted THEN
    SELECT (SELECT count(*) FROM account_context) + (SELECT count(*) FROM user_context) + (SELECT count(*) FROM context_memories) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'account_context, user_context and context_memories hold % row(s) written by this release: not dropped. Keep them (an older release ignores them) and only delete schema_migrations version 25 if you must start an older release', n;
    END IF;
    DROP TABLE context_memories, user_context, account_context;
  END IF;
  IF to_regclass('public.schema_adoptions') IS NOT NULL THEN
    DELETE FROM schema_adoptions WHERE pack = '' AND version = 25;
  END IF;
  DELETE FROM schema_migrations WHERE version = 25;
END $rb$;

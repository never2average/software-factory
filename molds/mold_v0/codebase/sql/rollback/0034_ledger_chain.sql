-- Rolling back past 0034_ledger_chain (mold_v0-195), for a release from before it (and before rolling back an earlier
-- migration, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0034_ledger_chain.sql
-- The chain's columns, triggers and functions go, with the heads, and the ledger row. The chain's hashes can be
-- recomputed from the entries at any time; signed checkpoints cannot (the key that signed them is not the database's).
-- A database that holds a checkpoint is refused unless the operator says to drop them anyway (export them first:
-- npm run operator:verify-ledger -- --export <file>):
--   psql ... -c "SET app.ledger_rollback_drop = 'on'" -f sql/rollback/0034_ledger_chain.sql   (one session: use -1)
-- A chained area's records stay, as ordinary records. Found by its name, so it also undoes it where it was recorded
-- under another number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'ledger_chain');
  n BIGINT;
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'ledger_chain is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (ledger_chain): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  n := (SELECT count(*) FROM ledger_checkpoints);
  IF n > 0 AND coalesce(current_setting('app.ledger_rollback_drop', true), '') <> 'on' THEN
    RAISE EXCEPTION 'the ledger holds % signed checkpoint(s): not dropped (export them, then SET app.ledger_rollback_drop = ''on'' in the same session to drop them)', n;
  END IF;
  DROP TRIGGER IF EXISTS audit_data_events_chain ON audit_data_events;
  DROP TRIGGER IF EXISTS audit_platform_events_chain ON audit_platform_events;
  DROP TRIGGER IF EXISTS workspace_records_chain ON workspace_records;
  DROP TRIGGER IF EXISTS workspace_records_chain_frozen ON workspace_records;
  DROP TABLE IF EXISTS ledger_checkpoints;
  DROP TABLE IF EXISTS ledger_heads;
  DROP FUNCTION IF EXISTS app_ledger_append_only();
  DROP FUNCTION IF EXISTS app_ledger_record_frozen();
  DROP FUNCTION IF EXISTS app_ledger_chain_record();
  DROP FUNCTION IF EXISTS app_ledger_chain_trail();
  DROP FUNCTION IF EXISTS app_ledger_head(INT, TEXT);
  DROP FUNCTION IF EXISTS app_ledger_fields_data(audit_data_events);
  DROP FUNCTION IF EXISTS app_ledger_fields_platform(audit_platform_events);
  DROP FUNCTION IF EXISTS app_ledger_fields_record(workspace_records);
  DROP FUNCTION IF EXISTS app_ledger_hash(BYTEA, TEXT[]);
  DROP FUNCTION IF EXISTS app_ledger_us(TIMESTAMPTZ);
  DROP FUNCTION IF EXISTS app_ledger_canon(TEXT[]);
  DROP INDEX IF EXISTS workspace_records_chain_idx;
  ALTER TABLE workspace_records DROP COLUMN IF EXISTS chained, DROP COLUMN IF EXISTS chain_seq, DROP COLUMN IF EXISTS prev_hash, DROP COLUMN IF EXISTS hash;
  ALTER TABLE audit_data_events DROP COLUMN IF EXISTS prev_hash, DROP COLUMN IF EXISTS hash;
  ALTER TABLE audit_platform_events DROP COLUMN IF EXISTS prev_hash, DROP COLUMN IF EXISTS hash;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;

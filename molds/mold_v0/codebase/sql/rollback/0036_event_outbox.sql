-- Rolling back past 0036_event_outbox (mold_v0-202), for a release from before it (and before rolling back an earlier
-- migration, whose rollback refuses while this one is applied).
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0036_event_outbox.sql
-- The outbox, its functions and the runs trigger go, and the ledger row. An older release queues events after commit
-- (and scans the runs that ended for run.finished). Events still pending in the outbox would be lost: they are relayed
-- into webhook_deliveries first, here, for every enabled endpoint that takes them (the older release sends those), so
-- nothing already committed goes unsent; its run.finished scan starts from now. Found by its name, so it also undoes it where it was recorded under another
-- number. Refused when a later migration is applied.
DO $rb$
DECLARE
  v INT := (SELECT version FROM schema_migrations WHERE name = 'event_outbox');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'event_outbox is not applied here: nothing to roll back';
  END IF;
  IF (SELECT max(version) FROM schema_migrations) <> v THEN
    RAISE EXCEPTION 'this database is at migration %, not % (event_outbox): roll back the later migrations first', (SELECT max(version) FROM schema_migrations), v;
  END IF;
  INSERT INTO webhook_deliveries (id, org_id, endpoint_id, event_type, dedupe_key, payload, next_attempt_at)
  SELECT 'msg_' || substr(md5(random()::text || clock_timestamp()::text || e.id || o.id::text), 1, 24), o.org_id, e.id, o.event_type, o.dedupe_key, o.payload, now()
    FROM event_outbox o JOIN webhook_endpoints e ON e.org_id = o.org_id AND e.status = 'enabled' AND (cardinality(e.events) = 0 OR o.event_type = ANY (e.events))
   WHERE o.relayed_at IS NULL
  ON CONFLICT (endpoint_id, dedupe_key) DO NOTHING;
  -- The older release's run.finished scan starts from here: the runs that ended meanwhile were told through the outbox.
  UPDATE developer_marks SET at = now() WHERE name = 'run.finished';
  DROP TRIGGER IF EXISTS runs_event_outbox ON runs;
  DROP FUNCTION IF EXISTS app_event_outbox_run_finished();
  DROP FUNCTION IF EXISTS app_event_outbox_put(INT, TEXT, TEXT, JSONB);
  DROP FUNCTION IF EXISTS app_event_iso(TIMESTAMPTZ);
  DROP TABLE IF EXISTS developer_events;
  DROP TABLE IF EXISTS event_outbox;
  DELETE FROM schema_migrations WHERE version = v;
END $rb$;

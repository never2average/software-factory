-- The developer surface's event outbox (mold_v0-202; src/developer-webhooks.ts, molds/mold_v0/MOLD.md "Developer
-- surface"). An event (record.*, run.finished, clock.overdue) is written here in the same transaction as the change it
-- tells of, so a change that commits always has its event and a change rolled back never does; a crash right after the
-- commit loses nothing. The scheduler's step (a server's 15-second loop, the Vercel cron entry) relays each pending
-- event into webhook_deliveries, once per event and endpoint, and marks it relayed in that same transaction; a relay
-- that fails is retried with a backoff.
--
-- Nothing is written in a build without a developer surface (a tool app): the record store asks for its transaction
-- only when the app declares a record event for the area, and both writers below write only when the workspace has an
-- enabled endpoint that takes the event.
--
--   event_outbox       the pending and relayed events of every workspace (platform bookkeeping for one workspace each:
--                      row-level security on, the tenant role's grants revoked; relayed rows go after 30 days)
--   developer_events   the events the running build declares, kept by src/developer-webhooks.ts syncDeclaredEvents
--                      (read by the runs trigger, which has no other way to know them). Platform, no workspace.
--   app_event_outbox_put(org, type, key, payload)
--                      the one way an event is written: inside the caller's transaction, once per (workspace, key);
--                      callable by the tenant role for its own workspace only (a record write runs as the tenant)
--   runs_event_outbox  run.finished, written by the transaction that ends a run (src/runs.ts untouched)

CREATE TABLE IF NOT EXISTS event_outbox (
  id              BIGSERIAL PRIMARY KEY,
  org_id          INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  relayed_at      TIMESTAMPTZ,
  UNIQUE (org_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS event_outbox_pending_idx ON event_outbox (next_attempt_at, id) WHERE relayed_at IS NULL;
CREATE INDEX IF NOT EXISTS event_outbox_relayed_idx ON event_outbox (relayed_at) WHERE relayed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS developer_events (
  name  TEXT PRIMARY KEY
);

-- An event, written in the caller's transaction (nothing when no enabled endpoint of the workspace takes it; once per
-- key). A tenant transaction writes its own workspace's only.
CREATE OR REPLACE FUNCTION app_event_outbox_put(p_org INT, p_type TEXT, p_key TEXT, p_payload JSONB) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  t INT := app_tenant_org();
  out BIGINT;
BEGIN
  IF t IS NOT NULL AND t IS DISTINCT FROM p_org THEN
    RAISE EXCEPTION 'an event of another workspace: refused' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM webhook_endpoints e
                  WHERE e.org_id = p_org AND e.status = 'enabled' AND (cardinality(e.events) = 0 OR p_type = ANY (e.events))) THEN
    RETURN NULL;
  END IF;
  INSERT INTO event_outbox (org_id, event_type, dedupe_key, payload) VALUES (p_org, p_type, p_key, p_payload)
    ON CONFLICT (org_id, dedupe_key) DO NOTHING RETURNING id INTO out;
  RETURN out;
END $fn$;

CREATE OR REPLACE FUNCTION app_event_iso(t TIMESTAMPTZ) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $fn$
  SELECT to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$fn$;

-- run.finished: once per run and attempt, in the transaction that ended it, when the build declares the event.
CREATE OR REPLACE FUNCTION app_event_outbox_run_finished() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NEW.status IN ('succeeded', 'failed', 'cancelled') AND NEW.ended_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status OR OLD.attempt IS DISTINCT FROM NEW.attempt)
     AND EXISTS (SELECT 1 FROM developer_events WHERE name = 'run.finished') THEN
    PERFORM app_event_outbox_put(NEW.org_id, 'run.finished', 'run.finished:' || NEW.id || ':' || NEW.attempt,
      jsonb_build_object('type', 'run.finished', 'timestamp', app_event_iso(clock_timestamp()), 'data', jsonb_build_object('run', jsonb_build_object(
        'id', NEW.id, 'pack', NEW.pack, 'kind', NEW.kind, 'status', NEW.status, 'error_kind', NEW.error_kind, 'cost_usd', NEW.cost_usd::float8,
        'attempt', NEW.attempt, 'created_at', app_event_iso(NEW.created_at), 'ended_at', app_event_iso(NEW.ended_at)))));
  END IF;
  RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS runs_event_outbox ON runs;
CREATE TRIGGER runs_event_outbox AFTER INSERT OR UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION app_event_outbox_run_finished();

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
BEGIN
  ALTER TABLE event_outbox ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON event_outbox;
  EXECUTE format('CREATE POLICY tenant_isolation ON event_outbox TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', r);
  EXECUTE format('REVOKE ALL ON event_outbox FROM %I', r);
  EXECUTE format('REVOKE ALL ON SEQUENCE event_outbox_id_seq FROM %I', r);
  EXECUTE format('REVOKE ALL ON developer_events FROM %I', r);
  REVOKE ALL ON FUNCTION app_event_outbox_put(INT, TEXT, TEXT, JSONB) FROM PUBLIC;
  EXECUTE format('GRANT EXECUTE ON FUNCTION app_event_outbox_put(INT, TEXT, TEXT, JSONB) TO %I', r);
  REVOKE ALL ON FUNCTION app_event_outbox_run_finished() FROM PUBLIC;
END $mig$;

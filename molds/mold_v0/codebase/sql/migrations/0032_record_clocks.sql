-- Clocks on a workspace area's records, with reminders and escalation (mold_v0-191; src/clock-math.ts,
-- src/record-clocks.ts, molds/mold_v0/MOLD.md "Clocks, reminders and escalation"). A pack declares the clocks in
-- pack.json (record_areas[].clocks); the shell keeps what it has seen of each record's clock here.
--
-- workspace_record_clocks  one row per record and clock: the deadline last computed, when the current pause began, the
--                          time paused before, when it stopped. Rewritten by the scheduler's clock check (and read by
--                          every page and tool that shows a deadline, so a pause it saw keeps counting).
-- workspace_clock_events   what happened to a record's clock, append-only: started, paused, resumed, stopped, reopened,
--                          each reminder and escalation step (remind:<i>, escalate:<j>) once per record, clock and
--                          deadline (`mark`), with what the step did (who it told, a person or a value it changed).
-- workspace_notices        gains kind 'clock': one in-app notice per record and deadline, raised again by each step.
--
-- Tenant work reads its own workspace's rows. The clock check runs one workspace at a time inside that workspace's
-- tenant scope, so it may write its own workspace's clock rows and events (never another's: the policy's WITH CHECK)
-- and never change or delete an event.
CREATE TABLE IF NOT EXISTS workspace_record_clocks (
  org_id        INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  pack          TEXT NOT NULL,
  area          TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  clock         TEXT NOT NULL,
  status        TEXT NOT NULL,                     -- not_started, on_track, due_soon, overdue, paused, met, missed
  started_at    TIMESTAMPTZ,
  due_at        TIMESTAMPTZ,
  paused_ms     BIGINT NOT NULL DEFAULT 0,         -- time paused before the current pause (the clock's kind of time)
  paused_since  TIMESTAMPTZ,                       -- the current pause began (null: running)
  stopped_at    TIMESTAMPTZ,
  evaluated_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, pack, area, record_key, clock)
);
CREATE INDEX IF NOT EXISTS workspace_record_clocks_due_idx ON workspace_record_clocks (org_id, pack, area, clock, due_at);
CREATE TABLE IF NOT EXISTS workspace_clock_events (
  id          BIGSERIAL PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  pack        TEXT NOT NULL,
  area        TEXT NOT NULL,
  record_key  TEXT NOT NULL,
  clock       TEXT NOT NULL,
  step        TEXT NOT NULL,                       -- started, paused, resumed, stopped, reopened, remind:<i>, escalate:<j>
  mark        TEXT NOT NULL,                       -- a step: the deadline it was for; a change: when it happened
  due_at      TIMESTAMPTZ,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- told (roles, assignee), reassigned / raised (field, from, to), skipped
  at          TIMESTAMPTZ NOT NULL,
  UNIQUE (org_id, pack, area, record_key, clock, step, mark)
);
CREATE INDEX IF NOT EXISTS workspace_clock_events_record_idx ON workspace_clock_events (org_id, pack, area, record_key, at DESC);
ALTER TABLE workspace_notices DROP CONSTRAINT IF EXISTS workspace_notices_kind_check;
ALTER TABLE workspace_notices ADD CONSTRAINT workspace_notices_kind_check CHECK (kind IN ('due', 'clock'));

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_record_clocks', 'workspace_clock_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', t, r);
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
  END LOOP;
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON workspace_record_clocks TO %I', r);
  EXECUTE format('GRANT SELECT, INSERT ON workspace_clock_events TO %I', r);
  EXECUTE format('GRANT USAGE ON SEQUENCE workspace_clock_events_id_seq TO %I', r);
END $mig$;

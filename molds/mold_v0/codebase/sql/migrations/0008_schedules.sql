-- Schedules per workspace and due-date notices (mold_v0-035; src/schedules.ts, molds/mold_v0/MOLD.md).
--
-- workspace_schedules  one workspace's schedules: a pack's job kind, a cron expression (UTC), the asset records it runs
--                      over. A pack's default schedules are copied into every workspace (is_default); owners turn them
--                      off and on, change them (customized) and add their own. `next_at` is the next due time; `seq`
--                      changes on every write, so of two ticks that read the same due row only one moves it on and
--                      starts its runs (a missed tick runs at most once).
-- workspace_notices    in-app notices for one workspace (a check record due within its area's window), one per record
--                      and due date; `emailed_at` once the workspace's people were emailed about it.
-- scheduler_marks      platform bookkeeping (the day the daily due-date check last ran): no workspace's data.
--
-- Tenant work may read its own workspace's schedules and notices and write neither: the shell's own code writes them,
-- with the workspace taken from the caller's session (the console) or from the row itself (the scheduler).

CREATE TABLE IF NOT EXISTS workspace_schedules (
  id             BIGSERIAL PRIMARY KEY,
  org_id         INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  pack           TEXT NOT NULL,
  name           TEXT NOT NULL,
  label          TEXT,
  job_kind       TEXT NOT NULL,
  cron           TEXT NOT NULL,
  asset_area     TEXT,                              -- null: one run for the workspace
  asset_keys     TEXT[],                            -- null: every record of asset_area
  environment    TEXT,
  scope          JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  is_default     BOOLEAN NOT NULL DEFAULT false,    -- copied from the pack's definePack schedules
  customized     BOOLEAN NOT NULL DEFAULT false,    -- an owner changed it: the pack's later changes no longer apply
  next_at        TIMESTAMPTZ NOT NULL,              -- the next due time (a match of cron after the last tick)
  seq            INT NOT NULL DEFAULT 0,            -- bumped by every write: the tick's compare-and-set
  last_slot_at   TIMESTAMPTZ,                       -- the due time the last tick ran
  last_fired_at  TIMESTAMPTZ,                       -- when (by the scheduler's clock)
  last_skipped   INT NOT NULL DEFAULT 0,            -- due times missed before it, run once with it, not again
  last_runs      TEXT[] NOT NULL DEFAULT '{}',
  last_error     TEXT,
  created_by     TEXT,
  updated_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A pack's default and an owner's own schedule never share a row, whatever their names (a default added later with
  -- the name of an owner's schedule is still copied in).
  UNIQUE (org_id, pack, name, is_default)
);
CREATE INDEX IF NOT EXISTS workspace_schedules_due_idx ON workspace_schedules (next_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS workspace_notices (
  id            BIGSERIAL PRIMARY KEY,
  org_id        INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'due' CHECK (kind IN ('due')),
  pack          TEXT NOT NULL,
  area          TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  title         TEXT,
  due_on        DATE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  emailed_at    TIMESTAMPTZ,
  dismissed_at  TIMESTAMPTZ,
  dismissed_by  TEXT,
  UNIQUE (org_id, kind, pack, area, record_key, due_on)
);
CREATE INDEX IF NOT EXISTS workspace_notices_org_idx ON workspace_notices (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS scheduler_marks (
  name  TEXT PRIMARY KEY,
  day   DATE NOT NULL,
  at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $mig$
DECLARE
  r TEXT := octillion_tenant_role();
  t TEXT;
BEGIN
  -- Read only for tenant work: its own workspace's schedules and notices.
  FOREACH t IN ARRAY ARRAY['workspace_schedules', 'workspace_notices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (org_id = octillion_tenant_org()) WITH CHECK (org_id = octillion_tenant_org())', t, r);
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
    EXECUTE format('GRANT SELECT ON %I TO %I', t, r);
  END LOOP;
  -- Platform bookkeeping: no access for tenant work.
  EXECUTE format('REVOKE ALL ON scheduler_marks FROM %I', r);
END $mig$;

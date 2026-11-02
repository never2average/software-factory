-- The audit trails (mold_v0-197; src/audit-trail.ts, the only writer): two append-only tables, written only when the
-- app's profile turns a trail on (profile.json audit.data, audit.platform; both off by default, and then nothing is
-- written here at all).
--
--   audit_data_events      a workspace's data trail: who listed, read, revealed, exported, created, changed, moved or
--                          deleted which record, file or run's results, when and through which door. Never a value: the
--                          area or store, the record's key or the file's path, and how many rows.
--   audit_platform_events  the platform trail: every API and MCP request and sign-in (the key's id, never the key; the
--                          actor, the scopes it acted with, the result code and the latency) and every staff action on
--                          an account. org_id is the workspace the entry belongs to, null for the platform's own.
--   audit_sequences        each workspace's (scope_id; 0: the platform's entries with no workspace) next number per
--                          trail: entries are numbered by a monotonic, gapless sequence taken under this row's lock, in
--                          the writer's transaction, so a workspace's entries are numbered in commit order (the order a
--                          hash chain, mold_v0-195, will follow). Platform bookkeeping: tenant work never reaches it.
--
-- Append-only: a trigger refuses every UPDATE, and every DELETE except the retention prune's (src/audit-trail.ts
-- pruneAudit sets app.audit_prune in its own transaction) and a removed workspace's cascade (its organization row gone).
-- Each workspace reads its own entries under row-level security (SELECT only: tenant work never writes or removes one).

CREATE TABLE IF NOT EXISTS audit_sequences (
  scope_id   INT NOT NULL,
  trail      TEXT NOT NULL CHECK (trail IN ('data', 'platform')),
  last_seq   BIGINT NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  PRIMARY KEY (scope_id, trail)
);

CREATE TABLE IF NOT EXISTS audit_data_events (
  org_id      INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  seq         BIGINT NOT NULL CHECK (seq > 0),
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('user', 'key', 'staff', 'agent_run', 'system')),
  actor_id    TEXT,                 -- a person's id, key:<id>, staff:<pseudonym>, a run's id; null for the system
  key_id      INT,                  -- the API key the request came with (its id, never the key)
  action      TEXT NOT NULL CHECK (action IN ('list', 'read', 'reveal', 'export', 'create', 'update', 'move', 'delete')),
  target      TEXT NOT NULL CHECK (target IN ('record', 'file', 'run_result')),
  pack        TEXT,
  area        TEXT,                 -- the record area, the file store or the run's kind
  record_key  TEXT,                 -- the record's key, the file's path or the run's id; null for a list
  rows        INT,                  -- how many a list, export or batch touched
  channel     TEXT NOT NULL CHECK (channel IN ('console', 'api', 'mcp', 'admin_console', 'admin_mcp', 'run', 'system')),
  PRIMARY KEY (org_id, seq)
);
CREATE INDEX IF NOT EXISTS audit_data_events_at_idx ON audit_data_events (at);

CREATE TABLE IF NOT EXISTS audit_platform_events (
  scope_id    INT NOT NULL,         -- org_id, or 0 for an entry of no workspace: the sequence it is numbered in
  seq         BIGINT NOT NULL CHECK (seq > 0),
  org_id      INT REFERENCES organizations (id) ON DELETE CASCADE,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind        TEXT NOT NULL CHECK (kind IN ('request', 'sign_in', 'staff')),
  channel     TEXT NOT NULL CHECK (channel IN ('console', 'api', 'mcp', 'admin_console', 'admin_mcp', 'run', 'system')),
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,        -- the route (no query string), an MCP request's methods and tool names (never arguments)
  key_id      INT,
  actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('user', 'key', 'staff', 'agent_run', 'system')),
  actor_id    TEXT,
  scopes      TEXT[] NOT NULL DEFAULT '{}',
  status      INT,
  latency_ms  INT,
  ip          TEXT,
  PRIMARY KEY (scope_id, seq),
  CHECK (scope_id = coalesce(org_id, 0))
);
CREATE INDEX IF NOT EXISTS audit_platform_events_at_idx ON audit_platform_events (at);
CREATE INDEX IF NOT EXISTS audit_platform_events_org_idx ON audit_platform_events (org_id, at DESC) WHERE org_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND (current_setting('app.audit_prune', true) = 'on'
      OR (OLD.org_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id))) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only: an entry is never changed or removed (the retention prune and a removed workspace aside)', TG_TABLE_NAME
    USING ERRCODE = '42501';
END $fn$;
DROP TRIGGER IF EXISTS audit_data_events_append_only ON audit_data_events;
CREATE TRIGGER audit_data_events_append_only BEFORE UPDATE OR DELETE ON audit_data_events FOR EACH ROW EXECUTE FUNCTION app_audit_append_only();
DROP TRIGGER IF EXISTS audit_platform_events_append_only ON audit_platform_events;
CREATE TRIGGER audit_platform_events_append_only BEFORE UPDATE OR DELETE ON audit_platform_events FOR EACH ROW EXECUTE FUNCTION app_audit_append_only();

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_data_events', 'audit_platform_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', t, r);
    EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
    EXECUTE format('GRANT SELECT ON %I TO %I', t, r);
  END LOOP;
  EXECUTE format('REVOKE ALL ON audit_sequences FROM %I', r);
END $mig$;

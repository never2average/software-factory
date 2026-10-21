-- Record areas (mold_v0-047; src/record-areas.ts, molds/mold_v0/MOLD.md "Pack and record-area contract"). A pack
-- declares areas (a role: source, check or asset; a scope: platform or workspace; fields); their rows live here, so a
-- pack gets a list page, a detail page and MCP list/get tools without a table or a line of code of its own.

-- Platform-scope areas: shared by every workspace (a source of requirements, a library of checks). The tenant role may
-- read them and nothing else: read-only to customers by the database's own grants (src/rls.ts PLATFORM_READONLY).
CREATE TABLE IF NOT EXISTS platform_records (
  id          BIGSERIAL PRIMARY KEY,
  pack        TEXT NOT NULL,
  area        TEXT NOT NULL,
  key         TEXT NOT NULL,
  title       TEXT,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  version     TEXT,                              -- the source version it was indexed from (a pinned commit, a date)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pack, area, key)
);

-- Workspace-scope areas: one workspace's own rows, under row-level security like every tenant table. An asset area's
-- title and data are sealed with the workspace's data key (src/orgcrypto.ts); `sealed` says which rows are.
CREATE TABLE IF NOT EXISTS workspace_records (
  id          BIGSERIAL PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  pack        TEXT NOT NULL,
  area        TEXT NOT NULL,
  key         TEXT NOT NULL,
  title       TEXT,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  sealed      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, pack, area, key)
);

DO $mig$
DECLARE
  r TEXT := octillion_tenant_role();
BEGIN
  EXECUTE format('REVOKE ALL ON platform_records FROM %I', r);
  EXECUTE format('GRANT SELECT ON platform_records TO %I', r);

  ALTER TABLE workspace_records ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON workspace_records;
  EXECUTE format('CREATE POLICY tenant_isolation ON workspace_records TO %I USING (org_id = octillion_tenant_org()) WITH CHECK (org_id = octillion_tenant_org())', r);
  EXECUTE format('REVOKE ALL ON workspace_records FROM %I', r);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_records TO %I', r);
  EXECUTE format('GRANT USAGE ON SEQUENCE workspace_records_id_seq TO %I', r);
END $mig$;

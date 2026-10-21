-- Row-level security on tenant tables (docs/security.md, src/tenant-scope.ts), as defence in depth behind the org
-- filters every query already has (npm run check:tenant-sql).
--
-- Tenant work (every MCP tool call, every customer-portal request) runs its queries as the tenant role (octillion_tenant_<10 hex of md5(database name)>, one per database, since roles are
-- shared by every database on a server; octillion_tenant_role() names it) with
-- the setting octillion.org_id naming its organization. These policies then let it see and change only that
-- organization's rows, so a query that forgets its org filter reaches nothing of anyone else's. Without the setting
-- the role sees no tenant rows at all (fails closed). The role that owns the tables (the app's own login: the
-- orchestrator worker API, the admin console, background jobs, migrations) is not restricted: those paths are
-- cross-tenant by design. This guards against a forgotten filter, not against SQL injection: injected SQL runs on the
-- app's login and could leave the role.
-- `npm run check:rls` proves all of this against the live database on every deploy (scripts/check-rls.ts).

-- The tenant role's name for this database (roles are server-wide; one per database keeps two databases on one server,
-- or a role another login created, from colliding).
CREATE OR REPLACE FUNCTION octillion_tenant_role() RETURNS TEXT LANGUAGE sql STABLE AS
$$ SELECT 'octillion_tenant_' || substr(md5(current_database()), 1, 10) $$;

-- The organization the current tenant query acts for; NULL (no rows) when unset.
CREATE OR REPLACE FUNCTION octillion_tenant_org() RETURNS INT LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('octillion.org_id', true), '')::INT $$;

DO $mig$
DECLARE
  r TEXT := octillion_tenant_role();
  t TEXT;
  fk RECORD;
  seq RECORD;
  -- Parent-scoped tables: visible when the parent row is the tenant's (the EXISTS runs under the parent's own policy).
  via_product CONSTANT TEXT := 'EXISTS (SELECT 1 FROM products p WHERE p.id = product_id AND p.org_id = octillion_tenant_org())';
  via_session CONSTANT TEXT := 'EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = session_id AND s.org_id = octillion_tenant_org())';
BEGIN
  BEGIN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT', r);
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  -- The app's login switches to it per transaction (SET LOCAL ROLE): it must be a member that may SET it.
  EXECUTE format('GRANT %I TO CURRENT_USER', r);

  -- Least privilege: nothing by default (a new table is unreachable from tenant work until a migration grants it), then
  -- read-only on platform tables tenant code reads, read-write only where a policy limits the rows.
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
  EXECUTE format('GRANT SELECT ON library_tasks, platform_settings, platform_harnesses, model_prices, schema_migrations, journey_seed TO %I', r);

  -- Every table with an org_id column, except the shared libraries below: the tenant reads and writes its own rows only.
  FOR t IN SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables x USING (table_schema, table_name)
            WHERE c.table_schema = 'public' AND c.column_name = 'org_id' AND x.table_type = 'BASE TABLE'
              AND c.table_name NOT IN ('developer_profiles', 'developer_populations', 'journey_templates') LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (org_id = octillion_tenant_org()) WITH CHECK (org_id = octillion_tenant_org())', t, r);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r);
  END LOOP;
  -- Rows tenant work must never write, though they are its own: keys and tokens are issued by the platform; tombstones
  -- and access requests are the platform's records. A data key may be created on first use (src/orgcrypto.ts).
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON api_keys, worker_tokens, org_keys FROM %I', r);
  EXECUTE format('GRANT UPDATE (last_used_at) ON api_keys TO %I', r);
  EXECUTE format('GRANT INSERT ON org_keys TO %I', r);
  EXECUTE format('REVOKE ALL ON access_requests, org_deletions FROM %I', r);

  -- Shared libraries: rows with no organization are Octillion's public ones (readable by every tenant, changed by
  -- none); an organization's own rows are its alone.
  FOREACH t IN ARRAY ARRAY['developer_profiles', 'developer_populations', 'journey_templates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_read ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_write ON %I', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO %I USING (org_id IS NULL OR org_id = octillion_tenant_org())', t, r);
    EXECUTE format('CREATE POLICY tenant_write ON %I TO %I USING (org_id = octillion_tenant_org()) WITH CHECK (org_id = octillion_tenant_org())', t, r);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r);
  END LOOP;

  -- The organization itself: read its own row, nothing else (plans, budgets and links are set by the platform).
  ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON organizations;
  EXECUTE format('CREATE POLICY tenant_isolation ON organizations FOR SELECT TO %I USING (id = octillion_tenant_org())', r);
  EXECUTE format('GRANT SELECT ON organizations TO %I', r);

  FOREACH t IN ARRAY ARRAY['scenarios', 'product_personas'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (%s) WITH CHECK (%s)', t, r, via_product, via_product);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r);
  END LOOP;
  -- Transcripts and gateway usage: read only. Session gateway tokens: a tenant may revoke its own sessions' tokens
  -- (cancelling a run), never issue one.
  FOREACH t IN ARRAY ARRAY['transcript_events', 'gateway_usage', 'gateway_tokens'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO %I USING (%s)', t, r, via_session);
    EXECUTE format('GRANT SELECT ON %I TO %I', t, r);
  END LOOP;
  EXECUTE format('GRANT UPDATE, DELETE ON gateway_tokens TO %I', r);

  -- A population's agents: readable with the population (public ones too), changed only in the tenant's own.
  ALTER TABLE developer_population_agents ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_read ON developer_population_agents;
  DROP POLICY IF EXISTS tenant_write ON developer_population_agents;
  EXECUTE format('CREATE POLICY tenant_read ON developer_population_agents FOR SELECT TO %I USING (EXISTS (SELECT 1 FROM developer_populations p WHERE p.id = population_id))', r);
  EXECUTE format('CREATE POLICY tenant_write ON developer_population_agents TO %I USING (EXISTS (SELECT 1 FROM developer_populations p WHERE p.id = population_id AND p.org_id = octillion_tenant_org())) WITH CHECK (EXISTS (SELECT 1 FROM developer_populations p WHERE p.id = population_id AND p.org_id = octillion_tenant_org()))', r);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON developer_population_agents TO %I', r);

  -- Narrower writes where tenant work changes only some columns, and audit-style tables it only appends to.
  EXECUTE format('REVOKE UPDATE, DELETE ON gateway_tokens FROM %I', r);
  EXECUTE format('GRANT UPDATE (revoked_at) ON gateway_tokens TO %I', r);
  EXECUTE format('REVOKE UPDATE ON library_submissions FROM %I', r);
  EXECUTE format('GRANT UPDATE (status, updated_at) ON library_submissions TO %I', r);
  EXECUTE format('REVOKE UPDATE, DELETE ON mcp_events, usage_rule_changes FROM %I', r);

  -- References: foreign-key checks bypass row-level security, so a tenant row could otherwise point at another
  -- organization's product, scenario, persona or run. Every single-column reference from a table the tenant writes to a
  -- table under a tenant policy must name a row the tenant can see (its own, or a shared one).
  FOR fk IN
    SELECT c.conrelid::regclass::text AS child, a.attname AS col, c.confrelid::regclass::text AS parent, pa.attname AS pcol, c.conname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
      JOIN pg_class pc ON pc.oid = c.confrelid
     WHERE c.contype = 'f' AND cardinality(c.conkey) = 1 AND c.connamespace = 'public'::regnamespace
       AND pc.relrowsecurity AND c.confrelid NOT IN ('organizations'::regclass, 'access_requests'::regclass)
  LOOP
    CONTINUE WHEN NOT (has_table_privilege(r, fk.child, 'INSERT') OR has_table_privilege(r, fk.child, 'UPDATE'));
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', 'ref_' || fk.col, fk.child);
    EXECUTE format('CREATE POLICY %I ON %s AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (%I IS NULL OR EXISTS (SELECT 1 FROM %s p WHERE p.%I = %I))',
                   'ref_' || fk.col, fk.child, r, fk.col, fk.parent, fk.pcol, fk.col);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', 'ref_upd_' || fk.col, fk.child);
    EXECUTE format('CREATE POLICY %I ON %s AS RESTRICTIVE FOR UPDATE TO %I USING (true) WITH CHECK (%I IS NULL OR EXISTS (SELECT 1 FROM %s p WHERE p.%I = %I))',
                   'ref_upd_' || fk.col, fk.child, r, fk.col, fk.parent, fk.pcol, fk.col);
  END LOOP;

  -- nextval only for the sequences of tables it inserts into; never setval (UPDATE on a sequence). A later migration
  -- that grants INSERT on a new table grants its sequence too.
  FOR seq IN
    SELECT s.oid::regclass::text AS seq, d.refobjid::regclass::text AS tbl
      FROM pg_class s JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
     WHERE s.relkind = 'S' AND s.relnamespace = 'public'::regnamespace
  LOOP
    IF has_table_privilege(r, seq.tbl, 'INSERT') THEN EXECUTE format('GRANT USAGE ON SEQUENCE %s TO %I', seq.seq, r); END IF;
  END LOOP;
END $mig$;

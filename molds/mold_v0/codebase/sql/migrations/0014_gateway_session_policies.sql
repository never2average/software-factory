-- The gateway's session rule without naming the sessions table (mold_v0-049). The session engine's sessions
-- (agent_sessions) are a host pack's table now, absent from a build without one, so 0003 and 0009 look a session's
-- organization up through octillion_session_org(). A database that ran those two migrations before mold_v0-049 has
-- policies that name agent_sessions directly: they are replaced by the same rule through the function, so every
-- database ends with the same policies whichever version of them it ran. Same rows visible as before: the lookup runs
-- as the caller, under the sessions table's own policy.
CREATE OR REPLACE FUNCTION octillion_session_org(sid TEXT) RETURNS INT LANGUAGE plpgsql STABLE AS $$
DECLARE o INT;
BEGIN
  IF sid IS NULL OR to_regclass('public.agent_sessions') IS NULL THEN RETURN NULL; END IF;
  -- Static SQL, planned on first use (never while the table is missing) and cached: as cheap as the EXISTS it replaces.
  SELECT s.org_id INTO o FROM public.agent_sessions s WHERE s.id = sid;
  RETURN o;
END $$;

DO $mig$
DECLARE
  r TEXT := octillion_tenant_role();
BEGIN
  DROP POLICY IF EXISTS tenant_isolation ON gateway_tokens;
  EXECUTE format('CREATE POLICY tenant_isolation ON gateway_tokens TO %I USING (octillion_session_org(session_id) = octillion_tenant_org())', r);
  DROP POLICY IF EXISTS tenant_isolation ON gateway_usage;
  EXECUTE format('CREATE POLICY tenant_isolation ON gateway_usage TO %I USING ('
    || 'octillion_session_org(session_id) = octillion_tenant_org()'
    || ' OR (run_id IS NOT NULL AND EXISTS (SELECT 1 FROM runs x WHERE x.id = run_id AND x.org_id = octillion_tenant_org())))', r);
END $mig$;

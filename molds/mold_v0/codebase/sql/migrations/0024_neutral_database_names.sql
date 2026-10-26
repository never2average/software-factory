-- Neutral names for the shell's database functions, tenant role and tenant setting (mold_v0-097). Until now they carried
-- the first product's name: octillion_tenant_role(), octillion_tenant_org(), octillion_session_org(), the run charge
-- functions, the role octillion_tenant_<hash> and the setting octillion.org_id. From here they are app_tenant_role(),
-- app_tenant_org(), app_session_org(), app_run_charge*(), app_tenant_<hash> and app.org_id.
--
-- Renamed in place, never recreated: a policy, a trigger and a grant hold a function or a role by its object id, not by
-- its name, so every row-level security policy of this database (the shell's and every pack's) names the new function
-- the moment this commits, with no policy dropped or rewritten, no table touched and no row rewritten. Nothing here takes
-- a lock on a table: renaming a function or a role changes one catalog row each.
--
-- What keeps a release from before this one working (the replica still serving during a rolling deploy, a pack migration
-- written before it), until a later cleanup drops it:
--   * the old function names, each a one-line alias of the new one (the run charge functions closed to tenant work as
--     the new ones are). octillion_tenant_role() returns the new role's name: a pack migration that grants to it grants
--     to the role tenant work runs as. A policy a pack migration writes through an alias is re-pointed at the function
--     itself by the runner, in the same transaction (src/migrate.ts), so every policy names app_tenant_org().
--   * the old role name, as a role of its own with no privilege and no policy of its own: a member of the new role,
--     inheriting it, that the app's login may SET. A release from before switches to it per transaction as it always
--     did and sees what the new role sees: its own workspace's rows, nothing with no workspace set.
--   * the old setting: app_tenant_org() reads app.org_id, and octillion.org_id when that is unset (a release from before
--     sets only the old one; this one sets only the new one).
-- A rollback to a release before this one: sql/rollback/0024_neutral_database_names.sql puts the old names back
-- (docs/migrations.md "Rolling back").

-- The functions, renamed (same object: every policy, trigger and grant follows), then given bodies that use the new names.
ALTER FUNCTION octillion_tenant_role() RENAME TO app_tenant_role;
ALTER FUNCTION octillion_tenant_org() RENAME TO app_tenant_org;
ALTER FUNCTION octillion_session_org(TEXT) RENAME TO app_session_org;
ALTER FUNCTION octillion_run_charge_figures(TEXT) RENAME TO app_run_charge_figures;
ALTER FUNCTION octillion_run_charge(TEXT) RENAME TO app_run_charge;
ALTER FUNCTION octillion_run_charge_refresh(TEXT) RENAME TO app_run_charge_refresh;
ALTER FUNCTION octillion_run_charge_on_end() RENAME TO app_run_charge_on_end;

-- The tenant role's name for this database (roles are server-wide; one per database).
CREATE OR REPLACE FUNCTION app_tenant_role() RETURNS TEXT LANGUAGE sql STABLE AS
$$ SELECT 'app_tenant_' || substr(md5(current_database()), 1, 10) $$;

-- The organization the current tenant query acts for; NULL (no rows) when unset. The old setting is read only when the
-- new one is unset (a release from before this one sets the old one only).
CREATE OR REPLACE FUNCTION app_tenant_org() RETURNS INT LANGUAGE sql STABLE AS
$$ SELECT COALESCE(NULLIF(current_setting('app.org_id', true), ''), NULLIF(current_setting('octillion.org_id', true), ''))::INT $$;

-- Unchanged (0017): the organization of the session a gateway row names.
CREATE OR REPLACE FUNCTION app_session_org(sid TEXT) RETURNS INT LANGUAGE plpgsql STABLE AS $$
DECLARE o INT;
BEGIN
  IF sid IS NULL OR to_regclass('public.agent_sessions') IS NULL THEN RETURN NULL; END IF;
  -- Static SQL, planned on first use (never while the table is missing) and cached: as cheap as the EXISTS it replaces.
  SELECT s.org_id INTO o FROM public.agent_sessions s WHERE s.id = sid;
  RETURN o;
END $$;

-- Unchanged (0014): what an ended, priced run owes.
CREATE OR REPLACE FUNCTION app_run_charge_figures(p_run TEXT)
RETURNS TABLE (org_id INT, attempt INT, run_status TEXT, currency TEXT, amount BIGINT, fixed_part BIGINT, cost_part BIGINT, usd NUMERIC, why TEXT)
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  r runs%ROWTYPE;
  p JSONB;
  scale NUMERIC;
  fixed BIGINT;
  plus BIGINT := 0;
BEGIN
  SELECT * INTO r FROM runs WHERE runs.id = p_run;
  IF NOT FOUND OR r.price IS NULL OR r.status NOT IN ('succeeded', 'failed', 'cancelled') THEN RETURN; END IF;
  p := r.price;
  usd := coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.run_id = r.id AND g.token_hash IN (
           SELECT t.token_hash FROM gateway_tokens t WHERE t.run_id = r.id
              AND t.created_at >= (SELECT max(t2.created_at) FROM gateway_tokens t2 WHERE t2.run_id = r.id))), 0);
  scale := power(10::numeric, coalesce((p->>'exponent')::int, 2));
  fixed := GREATEST(coalesce((p->>'fixed_minor')::bigint, 0), 0);
  IF p->>'markup_percent' IS NOT NULL THEN
    plus := GREATEST(round(usd * scale * (1 + (p->>'markup_percent')::numeric / 100)), 0)::bigint;
  END IF;
  org_id := r.org_id; attempt := r.attempt; run_status := r.status; currency := p->>'currency'; why := NULL;
  IF r.status = 'succeeded' THEN
    fixed_part := fixed; cost_part := plus;
  ELSIF r.status = 'failed' AND r.error_kind = 'infrastructure' THEN
    fixed_part := 0; cost_part := 0; why := 'failed: the platform could not run it (never charged)';
  ELSIF r.status = 'failed' THEN
    fixed_part := CASE WHEN p->>'on_failure' = 'full' THEN fixed ELSE 0 END;
    cost_part := CASE WHEN p->>'on_failure' IN ('full', 'cost') THEN plus ELSE 0 END;
    why := CASE p->>'on_failure' WHEN 'full' THEN 'failed: charged in full (the app''s policy)' WHEN 'cost' THEN 'failed: model cost only (the app''s policy)'
                ELSE 'failed: not charged (the app''s policy)' END;
  ELSE
    fixed_part := 0;
    cost_part := CASE WHEN p->>'on_cancel' = 'cost' THEN plus ELSE 0 END;
    why := CASE p->>'on_cancel' WHEN 'cost' THEN 'cancelled: model cost only (the app''s policy)' ELSE 'cancelled: not charged (the app''s policy)' END;
  END IF;
  amount := fixed_part + cost_part;
  RETURN NEXT;
END $fn$;

-- As 0014, through the renamed figures function.
CREATE OR REPLACE FUNCTION app_run_charge(p_run TEXT) RETURNS BIGINT LANGUAGE plpgsql AS $fn$
DECLARE
  f RECORD;
  r runs%ROWTYPE;
  out_id BIGINT;
BEGIN
  SELECT * INTO f FROM app_run_charge_figures(p_run);
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO r FROM runs WHERE runs.id = p_run;
  INSERT INTO run_charges (run_id, org_id, kind, pack, job_kind, attempt, run_status, requested_by, currency, amount_minor, fixed_minor, cost_minor,
                           model_cost_usd, reason, delivery, delivered_at)
  VALUES (p_run, f.org_id, 'charge', r.pack, r.kind, f.attempt, f.run_status, r.requested_by, f.currency, f.amount, f.fixed_part, f.cost_part, f.usd, f.why,
          CASE WHEN f.amount = 0 THEN 'none' ELSE 'pending' END, CASE WHEN f.amount = 0 THEN now() END)
  ON CONFLICT (run_id, kind) DO NOTHING
  RETURNING id INTO out_id;
  RETURN out_id;
END $fn$;

CREATE OR REPLACE FUNCTION app_run_charge_refresh(p_run TEXT) RETURNS VOID LANGUAGE plpgsql AS $fn$
DECLARE
  f RECORD;
BEGIN
  SELECT * INTO f FROM app_run_charge_figures(p_run);
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE run_charges c SET amount_minor = f.amount, fixed_minor = f.fixed_part, cost_minor = f.cost_part, model_cost_usd = f.usd
   WHERE c.run_id = p_run AND c.kind = 'charge' AND c.delivery = 'pending' AND f.amount > 0
     AND (c.claimed_until IS NULL OR c.claimed_until < now()) AND c.amount_minor IS DISTINCT FROM f.amount;
END $fn$;

-- The trigger (runs_charge_on_end) holds this function by its id: renamed above, it fires this body.
CREATE OR REPLACE FUNCTION app_run_charge_on_end() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  BEGIN
    PERFORM app_run_charge(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'run charge for % not written (reconciled later): %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END $fn$;

-- The old names, each a one-line alias of the new function (until a later cleanup).
CREATE FUNCTION octillion_tenant_role() RETURNS TEXT LANGUAGE sql STABLE AS $$ SELECT app_tenant_role() $$;
CREATE FUNCTION octillion_tenant_org() RETURNS INT LANGUAGE sql STABLE AS $$ SELECT app_tenant_org() $$;
CREATE FUNCTION octillion_session_org(sid TEXT) RETURNS INT LANGUAGE sql STABLE AS $$ SELECT app_session_org(sid) $$;
CREATE FUNCTION octillion_run_charge(p_run TEXT) RETURNS BIGINT LANGUAGE sql AS $$ SELECT app_run_charge(p_run) $$;
CREATE FUNCTION octillion_run_charge_refresh(p_run TEXT) RETURNS VOID LANGUAGE sql AS $$ SELECT app_run_charge_refresh(p_run) $$;

DO $mig$
DECLARE
  h CONSTANT TEXT := substr(md5(current_database()), 1, 10);
  old_role CONSTANT TEXT := 'octillion_tenant_' || h;
  r CONSTANT TEXT := app_tenant_role();
  fn TEXT;
BEGIN
  -- Roles outlive databases: a role under the new name can only be left from an earlier database of this name (dropped
  -- since; its grants went with it). DROP ROLE refuses if anything anywhere still depends on it.
  IF to_regrole(r) IS NOT NULL THEN
    EXECUTE format('DROP ROLE %I', r);
  END IF;
  -- The tenant role, renamed: every policy and grant holds it by its id, and so does the app's membership (SET ROLE).
  EXECUTE format('ALTER ROLE %I RENAME TO %I', old_role, r);
  EXECUTE format('ALTER ROLE %I NOLOGIN NOINHERIT', r);

  -- The old name: no privilege and no policy of its own, a member of the tenant role inheriting what it may do, that the
  -- app's login may SET (a release from before this one switches to it per transaction).
  EXECUTE format('CREATE ROLE %I NOLOGIN INHERIT', old_role);
  EXECUTE format('GRANT %I TO %I', r, old_role);
  EXECUTE format('GRANT %I TO CURRENT_USER', old_role);

  -- The run charge aliases are closed to tenant work, as the functions they call are (0014).
  FOREACH fn IN ARRAY ARRAY['octillion_run_charge(TEXT)', 'octillion_run_charge_refresh(TEXT)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
  END LOOP;
END $mig$;

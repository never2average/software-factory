-- Rolling back past 0024_neutral_database_names (mold_v0-097): the old names back, for a release from before it.
-- Not a migration (never run by src/migrate.ts). Run it once, on the app's own login, before starting the older release:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f sql/rollback/0024_neutral_database_names.sql
-- A release from before 0024 reads the tenant role's name from octillion_tenant_role() and checks that every policy names
-- octillion_tenant_org(): until this has run it refuses tenant queries (platform work carries on), it never opens rows.
-- The reverse of 0024, renames only: no table locked, no row rewritten. Refused when a later migration is applied.
DO $rb$
DECLARE
  h CONSTANT TEXT := substr(md5(current_database()), 1, 10);
  old_role CONSTANT TEXT := 'octillion_tenant_' || h;
  r CONSTANT TEXT := 'app_tenant_' || h;
BEGIN
  IF (SELECT max(version) FROM schema_migrations) <> 24 THEN
    RAISE EXCEPTION 'this database is at migration %, not 0024: roll back the later migrations first', (SELECT max(version) FROM schema_migrations);
  END IF;
  -- The aliases go first, then the functions take their names back.
  DROP FUNCTION octillion_tenant_role();
  DROP FUNCTION octillion_tenant_org();
  DROP FUNCTION octillion_session_org(TEXT);
  DROP FUNCTION octillion_run_charge(TEXT);
  DROP FUNCTION octillion_run_charge_refresh(TEXT);
  ALTER FUNCTION app_tenant_role() RENAME TO octillion_tenant_role;
  ALTER FUNCTION app_tenant_org() RENAME TO octillion_tenant_org;
  ALTER FUNCTION app_session_org(TEXT) RENAME TO octillion_session_org;
  ALTER FUNCTION app_run_charge_figures(TEXT) RENAME TO octillion_run_charge_figures;
  ALTER FUNCTION app_run_charge(TEXT) RENAME TO octillion_run_charge;
  ALTER FUNCTION app_run_charge_refresh(TEXT) RENAME TO octillion_run_charge_refresh;
  ALTER FUNCTION app_run_charge_on_end() RENAME TO octillion_run_charge_on_end;
  -- The alias role (no privilege, no policy of its own) goes; the tenant role takes its name back.
  EXECUTE format('DROP ROLE %I', old_role);
  EXECUTE format('ALTER ROLE %I RENAME TO %I', r, old_role);
  DELETE FROM schema_migrations WHERE version = 24;
END $rb$;
-- The bodies as 0003 and 0014 left them (they name each other).
CREATE OR REPLACE FUNCTION octillion_tenant_role() RETURNS TEXT LANGUAGE sql STABLE AS
$$ SELECT 'octillion_tenant_' || substr(md5(current_database()), 1, 10) $$;
CREATE OR REPLACE FUNCTION octillion_tenant_org() RETURNS INT LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('octillion.org_id', true), '')::INT $$;
CREATE OR REPLACE FUNCTION octillion_run_charge(p_run TEXT) RETURNS BIGINT LANGUAGE plpgsql AS $fn$
DECLARE
  f RECORD;
  r runs%ROWTYPE;
  out_id BIGINT;
BEGIN
  SELECT * INTO f FROM octillion_run_charge_figures(p_run);
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

CREATE OR REPLACE FUNCTION octillion_run_charge_refresh(p_run TEXT) RETURNS VOID LANGUAGE plpgsql AS $fn$
DECLARE
  f RECORD;
BEGIN
  SELECT * INTO f FROM octillion_run_charge_figures(p_run);
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE run_charges c SET amount_minor = f.amount, fixed_minor = f.fixed_part, cost_minor = f.cost_part, model_cost_usd = f.usd
   WHERE c.run_id = p_run AND c.kind = 'charge' AND c.delivery = 'pending' AND f.amount > 0
     AND (c.claimed_until IS NULL OR c.claimed_until < now()) AND c.amount_minor IS DISTINCT FROM f.amount;
END $fn$;

CREATE OR REPLACE FUNCTION octillion_run_charge_on_end() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  BEGIN
    PERFORM octillion_run_charge(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'run charge for % not written (reconciled later): %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END $fn$;

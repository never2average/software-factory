-- Price per run (mold_v0-019; src/run-charges.ts, molds/mold_v0/MOLD.md "Price per run"): a billing usage event per
-- finished run, off by default.
--
-- runs.price is the run's price as the platform allowed it when the run was queued (src/run-charges.ts priceForStart:
-- the kind's declared price, checked and clamped against the app's billing rules in profile.json). NULL, as on every
-- run when billing is off, means the run is never charged and nothing below ever fires for it.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS price JSONB;

-- One row per run and kind: 'charge' when the run ended (exactly one, whatever path ended it: completion, the lease
-- sweep, a cancel, a launch that never happened), 'credit' when staff gave a charge back (at most one). Amounts are in
-- the currency's minor unit; a charge is >= 0, a credit <= 0. The row is the internal ledger and the outbox to Stripe:
--   delivery  pending  not handed on yet (src/run-charges.ts deliverCharges sends it)
--             stripe   a meter event (charge) or a customer balance credit (credit) Stripe accepted; delivery_ref says which
--             ledger   this table is the record (Stripe is off, or the workspace has no Stripe customer)
--             none     nothing to bill (a charge of 0: a failed or cancelled run the app's policy does not charge)
-- run_id is no foreign key: a run's row may be pruned, its charge stays. A workspace's deletion removes its ledger.
CREATE TABLE IF NOT EXISTS run_charges (
  id                 BIGSERIAL PRIMARY KEY,
  run_id             TEXT NOT NULL,
  org_id             INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('charge', 'credit')),
  pack               TEXT NOT NULL,
  job_kind           TEXT NOT NULL,
  attempt            INT NOT NULL,
  run_status         TEXT NOT NULL,
  requested_by       TEXT,
  currency           TEXT NOT NULL,
  amount_minor       BIGINT NOT NULL,
  fixed_minor        BIGINT NOT NULL DEFAULT 0,
  cost_minor         BIGINT NOT NULL DEFAULT 0,
  model_cost_usd     NUMERIC NOT NULL DEFAULT 0,
  reason             TEXT,
  credited_by        TEXT,
  delivery           TEXT NOT NULL DEFAULT 'pending' CHECK (delivery IN ('pending', 'stripe', 'ledger', 'none')),
  delivery_ref       TEXT,
  delivery_error     TEXT,
  delivery_attempts  INT NOT NULL DEFAULT 0,
  claimed_until      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at       TIMESTAMPTZ,
  UNIQUE (run_id, kind),
  CHECK ((kind = 'charge' AND amount_minor >= 0) OR (kind = 'credit' AND amount_minor <= 0))
);
CREATE INDEX IF NOT EXISTS run_charges_org_idx ON run_charges (org_id, created_at);
CREATE INDEX IF NOT EXISTS run_charges_pending_idx ON run_charges (created_at) WHERE delivery = 'pending';

-- The charge of a run that has ended, written once: from the frozen price, the run's metered model cost (GREATEST of
-- its recorded cost and its gateway total, as src/run-spend.ts counts it; never a figure the runner reports) and how it
-- ended. A succeeded run pays the fixed amount plus the cost-plus part. A failed one: never when the platform failed it
-- (error_kind 'infrastructure'); else as price.on_failure says ('free' 0, 'cost' the cost-plus part, 'full' both),
-- which src/run-charges.ts sets to 'free' unless the app's profile lets failed runs be charged. A cancelled one: as
-- price.on_cancel ('free' or 'cost'), likewise. Returns the new row's id, or NULL (not priced, not ended, or already
-- charged: the unique (run_id, kind) makes a second call a no-op).
CREATE OR REPLACE FUNCTION octillion_run_charge(p_run TEXT) RETURNS BIGINT LANGUAGE plpgsql AS $fn$
DECLARE
  r runs%ROWTYPE;
  p JSONB;
  usd NUMERIC;
  scale NUMERIC;
  fixed BIGINT;
  plus BIGINT := 0;
  amount BIGINT;
  why TEXT := NULL;
  out_id BIGINT;
BEGIN
  SELECT * INTO r FROM runs WHERE runs.id = p_run;
  IF NOT FOUND OR r.price IS NULL OR r.status NOT IN ('succeeded', 'failed', 'cancelled') THEN RETURN NULL; END IF;
  p := r.price;
  usd := GREATEST(coalesce(r.cost_usd, 0), coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.run_id = r.id), 0));
  scale := power(10::numeric, coalesce((p->>'exponent')::int, 2));
  fixed := GREATEST(coalesce((p->>'fixed_minor')::bigint, 0), 0);
  IF p->>'markup_percent' IS NOT NULL THEN
    plus := GREATEST(round(usd * scale * (1 + (p->>'markup_percent')::numeric / 100)), 0)::bigint;
  END IF;
  IF r.status = 'succeeded' THEN
    amount := fixed + plus;
  ELSIF r.status = 'failed' AND r.error_kind = 'infrastructure' THEN
    amount := 0; why := 'failed: the platform could not run it (never charged)';
  ELSIF r.status = 'failed' THEN
    amount := CASE p->>'on_failure' WHEN 'full' THEN fixed + plus WHEN 'cost' THEN plus ELSE 0 END;
    why := CASE p->>'on_failure' WHEN 'full' THEN 'failed: charged in full (the app''s policy)' WHEN 'cost' THEN 'failed: model cost only (the app''s policy)'
                ELSE 'failed: not charged (the app''s policy)' END;
  ELSE
    amount := CASE p->>'on_cancel' WHEN 'cost' THEN plus ELSE 0 END;
    why := CASE p->>'on_cancel' WHEN 'cost' THEN 'cancelled: model cost only (the app''s policy)' ELSE 'cancelled: not charged (the app''s policy)' END;
  END IF;
  INSERT INTO run_charges (run_id, org_id, kind, pack, job_kind, attempt, run_status, requested_by, currency, amount_minor, fixed_minor, cost_minor,
                           model_cost_usd, reason, delivery, delivered_at)
  VALUES (r.id, r.org_id, 'charge', r.pack, r.kind, r.attempt, r.status, r.requested_by, p->>'currency', amount,
          CASE WHEN amount = 0 THEN 0 WHEN r.status = 'succeeded' OR (r.status = 'failed' AND p->>'on_failure' = 'full') THEN fixed ELSE 0 END,
          CASE WHEN amount = 0 THEN 0 ELSE plus END, usd, why,
          CASE WHEN amount = 0 THEN 'none' ELSE 'pending' END, CASE WHEN amount = 0 THEN now() END)
  ON CONFLICT (run_id, kind) DO NOTHING
  RETURNING id INTO out_id;
  RETURN out_id;
END $fn$;

-- Every move of a priced run into an ended state writes its charge in the same transaction, whichever code moved it.
-- A failure to write it never fails the run's own change: it is logged, and src/run-charges.ts reconcileCharges writes
-- it later (it charges every ended, priced run with no charge row).
CREATE OR REPLACE FUNCTION octillion_run_charge_on_end() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  BEGIN
    PERFORM octillion_run_charge(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'run charge for % not written (reconciled later): %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS runs_charge_on_end ON runs;
CREATE TRIGGER runs_charge_on_end AFTER UPDATE OF status ON runs FOR EACH ROW
  WHEN (NEW.price IS NOT NULL AND NEW.status IN ('succeeded', 'failed', 'cancelled') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION octillion_run_charge_on_end();

-- Read only for tenant work: its own workspace's charges and credits. Only the shell's code writes them.
DO $mig$
DECLARE
  r TEXT := octillion_tenant_role();
BEGIN
  ALTER TABLE run_charges ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON run_charges;
  EXECUTE format('CREATE POLICY tenant_isolation ON run_charges TO %I USING (org_id = octillion_tenant_org()) WITH CHECK (org_id = octillion_tenant_org())', r);
  EXECUTE format('REVOKE ALL ON run_charges FROM %I', r);
  EXECUTE format('GRANT SELECT ON run_charges TO %I', r);
  EXECUTE format('REVOKE ALL ON SEQUENCE run_charges_id_seq FROM %I', r);
  -- Only the platform writes a charge: tenant work may not call the function that writes one.
  REVOKE ALL ON FUNCTION octillion_run_charge(TEXT) FROM PUBLIC;
  EXECUTE format('REVOKE ALL ON FUNCTION octillion_run_charge(TEXT) FROM %I', r);
END $mig$;

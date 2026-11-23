-- Upgrade plan for this month (mold_v0-342, flag plan_upgrade; src/month-upgrade.ts, its only reader and writer;
-- molds/mold_v0/MOLD.md "Upgrade plan for this month").
--
-- A workspace's owners and billing managers set, for the current month only, a seat count (how many people and pending
-- invitations it may have) and a spending limit (the month's allowance). One row per workspace per month (UTC): it applies
-- while period_start <= now() < period_end and ends by itself when the month does (nothing deletes it; the plan's own
-- seats and allowance apply again from the next month). It is never a plan edit: src/billing.ts orgBudget puts it before
-- the admin-set allowance, the plan's and the default, for its month only. Each change is also a line in Budget rules'
-- history (usage_rule_changes) and the staff log.
--
--   seats      NULL: no seat count this month (the plan's, else none)
--   limit_usd  NULL: no limit of its own this month (the allowance as before)
--
-- Tenant table under row-level security, closed to tenant work entirely (src/rls.ts NO_ACCESS): only the shell's own
-- billing code reads and writes it (as the platform). Rollback: sql/rollback/0077_billing_month_changes.sql.
CREATE TABLE IF NOT EXISTS billing_month_changes (
  org_id        INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  period_start  TIMESTAMPTZ NOT NULL,
  period_end    TIMESTAMPTZ NOT NULL CHECK (period_end > period_start),
  seats         INT CHECK (seats IS NULL OR seats BETWEEN 1 AND 100000),
  limit_usd     NUMERIC(12, 2) CHECK (limit_usd IS NULL OR limit_usd >= 0),
  set_by        TEXT CHECK (length(set_by) <= 300),
  set_by_user   TEXT CHECK (length(set_by_user) <= 300),
  set_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, period_start)
);

DO $mig$
DECLARE
  r TEXT := app_tenant_role();
BEGIN
  ALTER TABLE billing_month_changes ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON billing_month_changes;
  EXECUTE format('CREATE POLICY tenant_isolation ON billing_month_changes TO %I USING (org_id = app_tenant_org()) WITH CHECK (org_id = app_tenant_org())', r);
  -- Not even a workspace's own work reads them (src/rls.ts NO_ACCESS): only the shell's billing code.
  EXECUTE format('REVOKE ALL ON billing_month_changes FROM %I', r);
END $mig$;

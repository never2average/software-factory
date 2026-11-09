-- A session's budget may be lowered as well as raised (mold_v0-287; src/harness-sessions.ts raiseBudget): each change is
-- one row of harness_budget_grants, from and to, why and who, exactly as a raise is. A lowering has to_usd below
-- from_usd, so the check that a change raises it becomes the check that it changes it. Nothing else moves.
ALTER TABLE harness_budget_grants DROP CONSTRAINT IF EXISTS harness_budget_grants_check;
ALTER TABLE harness_budget_grants DROP CONSTRAINT IF EXISTS harness_budget_grants_to_usd_check;
ALTER TABLE harness_budget_grants ADD CONSTRAINT harness_budget_grants_changes CHECK (to_usd <> from_usd);

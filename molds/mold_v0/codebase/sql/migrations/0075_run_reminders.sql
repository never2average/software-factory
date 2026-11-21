-- Reminders about agent runs (mold_v0-334; src/run-reminders.ts, its only writer of them): workspace_notices gains kind
-- 'run', an in-app notice to a workspace about one of its runs whose result waits: on a staff review for 3 days, or
-- accepted and not applied for 7 days. Its area names which (run_review, run_apply), its record_key the run (the root
-- session), its due_on the day it became due; one a run and day. Existing notices keep their kinds. Rollback:
-- sql/rollback/0075_run_reminders.sql.
ALTER TABLE workspace_notices DROP CONSTRAINT IF EXISTS workspace_notices_kind_check;
ALTER TABLE workspace_notices ADD CONSTRAINT workspace_notices_kind_check CHECK (kind IN ('due', 'clock', 'run'));

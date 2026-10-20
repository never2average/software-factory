-- A RECORD WORKFLOW'S AGENT ACTION, ONCE (lib/record-workflow-actions.ts): an agent action of a record's workflow becomes
-- a task for the assistant, carrying the action's delivery id as custom.workflow_action. The deliverer looks for that
-- task before it writes one, but two deliveries of the same action (one whose claim was taken over as stale while it was
-- still running) can both look before either writes. This makes the database the judge, as drizzle/0042 does for a
-- recurring task's next occurrence: in a workspace, one task per workflow_action. The second write fails with a unique
-- violation, which the task-workflow service answers as a 409 and the deliverer takes as "found".
--
-- workflow_action is a GENERATED column (custom ->> 'workflow_action'), never written, so schema.ts states it and its
-- index as drizzle-kit compares them. Adding a stored generated column rewrites todos once, under a short exclusive
-- lock; no value is changed and no policy touched (org_isolation on todos is row-level). The partial unique index covers
-- only rows that carry the key and is led by org_id, so it is used under row-level security. IF NOT EXISTS, safe to
-- apply twice. Before applying: two rows of one workspace with the same workflow_action would refuse the index. This
-- lists them:
--   SELECT org_id, custom ->> 'workflow_action', count(*) FROM todos WHERE custom ? 'workflow_action' GROUP BY 1, 2 HAVING count(*) > 1;
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
ALTER TABLE "todos" ADD COLUMN IF NOT EXISTS "workflow_action" text GENERATED ALWAYS AS ((custom ->> 'workflow_action'::text)) STORED;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "todos_workflow_action_uidx" ON "todos" USING btree ("org_id","workflow_action") WHERE workflow_action IS NOT NULL;

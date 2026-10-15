-- RECURRENCE, ONCE (agent/lib/task-recurrence.ts): completing a recurring task creates its next occurrence, linked back
-- by custom.recurs_from = the completed task's id. The write path looks for one before creating it, but two completions
-- at the same moment both look before either creates. This makes the database the judge: in a workspace, one task per
-- recurs_from. The second write fails with a unique violation, which the task-workflow service answers as a 409
-- ("already has its next occurrence") and the write path takes as done.
--
-- recurs_from is a GENERATED column (custom ->> 'recurs_from'), never written, so schema.ts states it and its index as
-- drizzle-kit compares them (an index over the expression itself would be planned again on every drift run). Adding a
-- stored generated column rewrites todos once, under a short exclusive lock; no value is changed and no policy touched
-- (org_isolation on todos is row-level). The partial unique index covers only rows that carry the key (next
-- occurrences) and is led by org_id, so it is used under row-level security. IF NOT EXISTS, safe to apply twice.
-- Before applying: two rows of one workspace with the same recurs_from would refuse the index (none can exist unless two
-- completions raced before this). This lists them:
--   SELECT org_id, custom ->> 'recurs_from', count(*) FROM todos WHERE custom ? 'recurs_from' GROUP BY 1, 2 HAVING count(*) > 1;
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
ALTER TABLE "todos" ADD COLUMN IF NOT EXISTS "recurs_from" text GENERATED ALWAYS AS ((custom ->> 'recurs_from'::text)) STORED;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "todos_recurs_from_uidx" ON "todos" USING btree ("org_id","recurs_from") WHERE recurs_from IS NOT NULL;

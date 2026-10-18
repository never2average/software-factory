-- A RECORD'S WORKFLOW, STORED (phase 3 of the workflow engine, docs/WORKFLOW_ENGINE.md; mold_v1-278). Two tables:
-- `record_workflow_instances`, one row per workflow running on one record (the engine's materialized instance, with a
-- pinned copy of the workflow document it was made from and a revision for compare-and-swap writes), and
-- `record_workflow_events`, its append-only history (app_rw may SELECT and INSERT only; its foreign key RESTRICTS, so
-- an instance with a history is never deleted, and an instance outlives its record). See `recordWorkflowInstances` and `recordWorkflowEvents` in
-- agent/lib/db/schema.ts; read and written only by lib/record-workflow-store.ts, inside the caller's workspace scope.
-- Nothing at runtime reads or writes them yet (phase 5 does). Additive: two new tables and nothing else; no existing
-- table is altered.
--
-- Row-level security as every per-workspace table: ENABLED and FORCED, with the `org_isolation` policy on
-- `app.org_id`. The policy is the production form from the start (no workspace named, no rows): nothing reads these
-- tables outside a workspace's scope, so there is no unscoped path for the permissive form to keep working.
--
-- Numbered 0047, after 0046 (the people directory). Its journal entry carries a later `when` than 0046's: the
-- production migrator applies only entries later than the last applied one, so 0046 must land first, as it did.
--
-- DEPLOY ORDER: any time before the web app or agent that uses them (phase 5). Idempotent (IF NOT EXISTS, the policy
-- dropped and made again). Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
CREATE TABLE IF NOT EXISTS "record_workflow_instances" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"definition_hash" text NOT NULL,
	"definition" jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"terminal" boolean,
	"fired_once" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"engine_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "record_workflow_instances_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "record_workflow_instances_entity_uidx" ON "record_workflow_instances" USING btree ("org_id","entity_type","entity_id","workflow_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "record_workflow_instances_workflow_idx" ON "record_workflow_instances" USING btree ("org_id","workflow_id","terminal");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "record_workflow_events" (
	"org_id" text NOT NULL,
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "record_workflow_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"instance_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"step_id" text,
	"actor" text,
	"source" text,
	"detail" text,
	"origin_instance_id" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'record_workflow_events_instance_fk') THEN
    ALTER TABLE "record_workflow_events" ADD CONSTRAINT "record_workflow_events_instance_fk" FOREIGN KEY ("org_id","instance_id") REFERENCES "public"."record_workflow_instances"("org_id","id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "record_workflow_events_instance_at_idx" ON "record_workflow_events" USING btree ("org_id","instance_id","at");--> statement-breakpoint

ALTER TABLE "record_workflow_instances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "record_workflow_instances" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "record_workflow_instances";--> statement-breakpoint
CREATE POLICY "org_isolation" ON "record_workflow_instances"
  USING ("org_id" = current_setting('app.org_id', true))
  WITH CHECK ("org_id" = current_setting('app.org_id', true));--> statement-breakpoint
ALTER TABLE "record_workflow_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "record_workflow_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "record_workflow_events";--> statement-breakpoint
CREATE POLICY "org_isolation" ON "record_workflow_events"
  USING ("org_id" = current_setting('app.org_id', true))
  WITH CHECK ("org_id" = current_setting('app.org_id', true));--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "record_workflow_instances" TO app_rw;
    -- Append-only: the history is an audit trail. A deployment's default privileges gave app_rw everything on the new
    -- table; take back what changes or removes a row (scripts/lib/append-only-tables.mjs re-applies this on every
    -- bootstrap, whose grant on ALL TABLES would otherwise give it back).
    GRANT SELECT, INSERT ON "record_workflow_events" TO app_rw;
    REVOKE UPDATE, DELETE, TRUNCATE ON "record_workflow_events" FROM app_rw;
  END IF;
END $$;

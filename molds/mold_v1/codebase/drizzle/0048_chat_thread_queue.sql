-- A shared chat's queue (mold_v1-290): every message the owner or a participant sends into a shared chat waits here
-- and runs in order, one turn at a time (lib/thread-queue-server.ts). See `chatThreadQueue` in
-- agent/lib/db/schema.ts. Additive: a new table and nothing else. Numbered 0048, after 0047 (record workflows): its
-- journal entry's `when` is later than 0047's, as the high-watermark production migrator needs.
--
-- An item's id is unique within its workspace (the key is org_id, id), so an id says nothing about another workspace.
-- Each message is sent AS ITS AUTHOR with a single-use token bound to its claim (`claim_id`, `token_seq`; the agent's
-- door agent/lib/queue-delivery-auth.ts spends it), and `tried_claims` remembers claims whose send may have landed,
-- so a resend is never made before the session's history has been checked.
--
-- DEPLOY ORDER: the factory's deploy applies the journal before it deploys code. Code that reaches a database without
-- this table still works: a shared chat's message is sent the way it was before the queue existed (straight into the
-- turn when the thread is free, "a turn is in progress" when it is not), and no queue is shown.
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs). IF NOT EXISTS / DROP POLICY IF EXISTS:
-- applying this twice is harmless.
CREATE TABLE IF NOT EXISTS "chat_thread_queue" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"author_email" text NOT NULL,
	"text" text NOT NULL,
	"seq" bigserial NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"claim_id" text,
	"claimed_at" timestamp with time zone,
	"token_seq" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"first_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"tried_claims" text[],
	"author_wait_since" timestamp with time zone,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_thread_queue_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_thread_queue_thread_idx" ON "chat_thread_queue" USING btree ("org_id","thread_id","state","seq");--> statement-breakpoint
-- One item on its way per thread: two pumps can never send two at once.
CREATE UNIQUE INDEX IF NOT EXISTS "chat_thread_queue_one_sending_uidx" ON "chat_thread_queue" USING btree ("thread_id") WHERE state = 'sending';--> statement-breakpoint

-- The same tenant boundary as every other workspace table, in its fail-closed form: no workspace set, no rows.
ALTER TABLE "chat_thread_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_thread_queue" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "chat_thread_queue";--> statement-breakpoint
CREATE POLICY "org_isolation" ON "chat_thread_queue"
  USING (NULLIF(current_setting('app.org_id', true), '') IS NOT NULL AND "org_id" = current_setting('app.org_id', true))
  WITH CHECK (NULLIF(current_setting('app.org_id', true), '') IS NOT NULL AND "org_id" = current_setting('app.org_id', true));--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "chat_thread_queue" TO app_rw;
    GRANT USAGE, SELECT ON SEQUENCE "chat_thread_queue_seq_seq" TO app_rw;
  END IF;
END $$;

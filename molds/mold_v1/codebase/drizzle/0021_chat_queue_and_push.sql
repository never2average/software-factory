-- Messages typed while a turn runs are held on the SERVER, so closing the tab no longer loses them, and the devices a
-- person asked to be notified on. Both org-scoped (org_isolation, the fail-open form every table ships with, which
-- .migrate-rls-fail-closed.mjs rewrites in its sweep) AND owner-only: a RESTRICTIVE policy ANDed with org_isolation
-- keeps a colleague in the same workspace out of another person's rows whenever the request names its person
-- (`app.principal_email`, set by withOrgRls({ orgId, principal })). A caller that names no person (the delivery
-- sweep, the notification hook) is scoped by workspace alone, like every other server path.
-- IF NOT EXISTS / DROP POLICY IF EXISTS: applying this twice is harmless.
-- Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs).
CREATE TABLE IF NOT EXISTS "chat_queue_items" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_email" text NOT NULL,
	"eve_session_id" text NOT NULL,
	"chat_id" text,
	"text" text NOT NULL,
	"message" text NOT NULL,
	"settings" jsonb NOT NULL,
	"goal" boolean DEFAULT false NOT NULL,
	"attachments" jsonb,
	"files_pending" integer DEFAULT 0 NOT NULL,
	"file_names" jsonb,
	"position" bigint NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"claim_id" text,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"sent_by" text,
	"rest_mark" text,
	"token_seq" integer DEFAULT 0 NOT NULL,
	"sent_message" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- For a database that ran an earlier draft of this file.
ALTER TABLE "chat_queue_items" ADD COLUMN IF NOT EXISTS "token_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_queue_items" ADD COLUMN IF NOT EXISTS "sent_message" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_queue_items_session_idx" ON "chat_queue_items" USING btree ("org_id","eve_session_id","state","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_queue_items_state_idx" ON "chat_queue_items" USING btree ("state","created_at");--> statement-breakpoint
-- EXACTLY ONCE: one item per (workspace, eve session) may be on its way at a time — per workspace, so another
-- workspace's row can never hold this one's queue. Two claimers racing for the same session (two
-- tabs, the agent's hook, the cron) cannot both hold one; the loser's UPDATE fails on this index.
-- Dropped first so a database that ran the first draft of this file (keyed on the session alone) gets the right one.
DROP INDEX IF EXISTS "chat_queue_items_one_sending_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "chat_queue_items_one_sending_uidx" ON "chat_queue_items" USING btree ("org_id","eve_session_id") WHERE state = 'sending';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"owner_email" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"preview" boolean DEFAULT true NOT NULL,
	"user_agent" text,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_endpoint_uidx" ON "push_subscriptions" USING btree ("org_id","endpoint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_subscriptions_owner_idx" ON "push_subscriptions" USING btree ("org_id","owner_email");--> statement-breakpoint
ALTER TABLE "chat_queue_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_queue_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "chat_queue_items";--> statement-breakpoint
CREATE POLICY "org_isolation" ON "chat_queue_items"
  USING (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true))
  WITH CHECK (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "chat_queue_owner" ON "chat_queue_items";--> statement-breakpoint
CREATE POLICY "chat_queue_owner" ON "chat_queue_items" AS RESTRICTIVE
  USING (NULLIF(current_setting('app.principal_email', true), '') IS NULL OR "owner_email" = current_setting('app.principal_email', true))
  WITH CHECK (NULLIF(current_setting('app.principal_email', true), '') IS NULL OR "owner_email" = current_setting('app.principal_email', true));--> statement-breakpoint
ALTER TABLE "push_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_subscriptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "push_subscriptions";--> statement-breakpoint
CREATE POLICY "org_isolation" ON "push_subscriptions"
  USING (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true))
  WITH CHECK (NULLIF(current_setting('app.org_id', true), '') IS NULL OR "org_id" = current_setting('app.org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "push_subscriptions_owner" ON "push_subscriptions";--> statement-breakpoint
CREATE POLICY "push_subscriptions_owner" ON "push_subscriptions" AS RESTRICTIVE
  USING (NULLIF(current_setting('app.principal_email', true), '') IS NULL OR "owner_email" = current_setting('app.principal_email', true))
  WITH CHECK (NULLIF(current_setting('app.principal_email', true), '') IS NULL OR "owner_email" = current_setting('app.principal_email', true));--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "chat_queue_items" TO app_rw;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "push_subscriptions" TO app_rw;
  END IF;
END $$;

ALTER TABLE "connectors" ADD COLUMN "notify_emails" jsonb;--> statement-breakpoint
ALTER TABLE "schedule_rules" ADD COLUMN "notify_emails" jsonb;--> statement-breakpoint
ALTER TABLE "system_cron_overrides" ADD COLUMN "notify_emails" jsonb;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "notify_emails" jsonb;--> statement-breakpoint
-- Hand-written backfill: any record already configured with the deprecated
-- single notify_email keeps working — it becomes a one-element notify_emails
-- list. notify_email itself stays in place (deprecated, fallback-only).
UPDATE "connectors" SET "notify_emails" = jsonb_build_array("notify_email") WHERE "notify_email" IS NOT NULL AND "notify_emails" IS NULL;--> statement-breakpoint
UPDATE "schedule_rules" SET "notify_emails" = jsonb_build_array("notify_email") WHERE "notify_email" IS NOT NULL AND "notify_emails" IS NULL;--> statement-breakpoint
UPDATE "system_cron_overrides" SET "notify_emails" = jsonb_build_array("notify_email") WHERE "notify_email" IS NOT NULL AND "notify_emails" IS NULL;--> statement-breakpoint
UPDATE "workflows" SET "notify_emails" = jsonb_build_array("notify_email") WHERE "notify_email" IS NOT NULL AND "notify_emails" IS NULL;
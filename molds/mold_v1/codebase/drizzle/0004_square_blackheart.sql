CREATE TABLE "automation_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_type" text NOT NULL,
	"automation_id" text NOT NULL,
	"actor" text NOT NULL,
	"event" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_type" text NOT NULL,
	"automation_id" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer,
	"summary" text,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "notify_email" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "notify_when" text;--> statement-breakpoint
ALTER TABLE "schedule_rules" ADD COLUMN "notify_email" text;--> statement-breakpoint
ALTER TABLE "schedule_rules" ADD COLUMN "notify_when" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "instructions" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "notify_email" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "notify_when" text;--> statement-breakpoint
CREATE INDEX "automation_audit_lookup_idx" ON "automation_audit" USING btree ("automation_type","automation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "automation_runs_lookup_idx" ON "automation_runs" USING btree ("automation_type","automation_id","started_at" DESC NULLS LAST);
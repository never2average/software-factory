CREATE TABLE "schedule_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" text,
	"name" text NOT NULL,
	"cron" text,
	"every_minutes" integer,
	"kind" text DEFAULT 'prompt' NOT NULL,
	"prompt" text NOT NULL,
	"channel_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"locked_at" timestamp with time zone,
	"lease_token" text,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "schedule_rules_due_idx" ON "schedule_rules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "schedule_rules_customer_id_idx" ON "schedule_rules" USING btree ("customer_id");
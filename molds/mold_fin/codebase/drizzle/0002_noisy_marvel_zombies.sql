CREATE TYPE "public"."connector_access" AS ENUM('read', 'write', 'read_write');--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"access" "connector_access" DEFAULT 'read' NOT NULL,
	"status" text DEFAULT 'setup' NOT NULL,
	"detail" text,
	"lands" text,
	"synced" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"trigger" text DEFAULT 'on delegation' NOT NULL,
	"customer_id" text,
	"steps" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "connectors_access_idx" ON "connectors" USING btree ("access");--> statement-breakpoint
CREATE INDEX "workflows_customer_id_idx" ON "workflows" USING btree ("customer_id");
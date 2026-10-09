CREATE TABLE "workflow_instruction_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"content" text,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "instructions_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "workflow_instr_versions_idx" ON "workflow_instruction_versions" USING btree ("workflow_id","created_at");
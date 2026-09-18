ALTER TABLE "automation_runs" ADD COLUMN "run_key" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "input_tokens" bigint;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "output_tokens" bigint;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "cache_read_tokens" bigint;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "cache_write_tokens" bigint;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "cost_usd" double precision;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_run_key_unique" UNIQUE("run_key");
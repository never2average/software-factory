-- Drop the single-column customer_id indexes on deployments, solutions, tickets and interactions (mold_v1-145).
--
-- Since 0024 each of these tables' primary key is (org_id, customer_id, <its own id>), and every read of a company's
-- rows names the workspace (row-level security adds org_id = <the session's workspace> to every query; the app's
-- own filters name it too), so the key's btree answers "this company's rows" by itself. The old index on
-- customer_id alone is dead weight: written on every insert and update, read by nothing that the key does not serve
-- better. schema.ts no longer declares them.
--
-- THIS MIGRATION DOES THE DROP. The deploy runs the journal first and then only a drift step (a read-only dry run of
-- `drizzle-kit push` against schema.ts) that REFUSES any index drop but one out-of-band index, so without this entry
-- every live database would carry the four indexes and every deploy would stop on them. After it the drift plan is
-- empty, which scripts/test-customer-id-index-migration-db.mjs asserts on a database shaped like production.
--
-- Idempotent (IF EXISTS): a database pushed from schema.ts after this change never had them. Nothing else changes,
-- and no row is touched. Applied by `npm run db:migrate:production` (scripts/migrate-production.mjs), in the same
-- transaction as any other pending entry.
DROP INDEX IF EXISTS "deployments_customer_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "solutions_customer_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "tickets_customer_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "interactions_customer_id_idx";

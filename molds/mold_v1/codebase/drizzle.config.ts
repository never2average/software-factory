import { defineConfig } from "drizzle-kit";

// Offline-first: `npm run db:generate` (drizzle-kit generate) emits SQL
// migrations under ./drizzle without any database. `npm run db:migrate`
// (drizzle-kit migrate) is for later, once a Postgres DATABASE_URL exists —
// never run it in dev/CI where no live DB is available.
export default defineConfig({
  dialect: "postgresql",
  schema: "./agent/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // DATABASE_URL only — no POSTGRES_URL fallback.
    //
    // Managed Postgres integrations inject their own POSTGRES_URL, and a stale
    // one outlives the provider you left. Falling back to it here means a
    // `drizzle-kit push` run without DATABASE_URL quietly executes DDL against
    // whichever database that variable still names. An empty string fails
    // loudly instead, which is the correct outcome.
    url: process.env.DATABASE_URL ?? "",
  },
});

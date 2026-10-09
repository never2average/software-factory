// Migration: TODOs workspace v2 — task status board, sprint lifecycle, the
// activity feed, and comments. Additive + idempotent.
//
// RUN THIS BEFORE deploying the front-end — the ORM selects these columns/tables.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const sql = postgres(env.DATABASE_URL, { ssl: "require" });

// 1. Task board status — backfilled from `done`.
await sql`ALTER TABLE todos ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open'`;
await sql`UPDATE todos SET status = CASE WHEN done THEN 'done' ELSE 'open' END
          WHERE status = 'open'`;
await sql`CREATE INDEX IF NOT EXISTS todos_status_idx ON todos (status)`;

// 2. Sprint lifecycle fields.
await sql`ALTER TABLE cycles ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'planning'`;
await sql`ALTER TABLE cycles ADD COLUMN IF NOT EXISTS goal text`;
await sql`ALTER TABLE cycles ADD COLUMN IF NOT EXISTS capacity integer`;

// 3. Activity feed (append-only, one row per change).
await sql`
  CREATE TABLE IF NOT EXISTS entity_activity (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    actor text NOT NULL,
    event text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
await sql`CREATE INDEX IF NOT EXISTS entity_activity_lookup_idx
          ON entity_activity (entity_type, entity_id, created_at DESC)`;

// 4. Comments (flat thread per entity).
await sql`
  CREATE TABLE IF NOT EXISTS comments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    author text NOT NULL,
    body text NOT NULL,
    mentions jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
await sql`CREATE INDEX IF NOT EXISTS comments_lookup_idx
          ON comments (entity_type, entity_id, created_at)`;

const checks = await sql`
  SELECT
    to_regclass('public.entity_activity') AS activity,
    to_regclass('public.comments') AS comments,
    (SELECT count(*) FROM information_schema.columns
       WHERE table_name='todos' AND column_name='status') AS todo_status,
    (SELECT count(*) FROM information_schema.columns
       WHERE table_name='cycles' AND column_name='state') AS cycle_state`;
const c = checks[0];
console.log("todos.status:", c.todo_status ? "OK" : "MISSING");
console.log("cycles.state/goal/capacity:", c.cycle_state ? "OK" : "MISSING");
console.log("entity_activity:", c.activity ? "OK" : "MISSING");
console.log("comments:", c.comments ? "OK" : "MISSING");

await sql.end();

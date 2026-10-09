// Migration: subtasks + editable ref titles. Adds three nullable columns:
//   - todos.parent_id            (uuid) — a subtask points at its parent todo
//   - deployments.display_name   (text) — optional human title
//   - implementation.display_name (text) — optional human title
// Additive + idempotent.
//
// RUN THIS BEFORE deploying the front-end — the ORM selects these columns.
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

await sql`ALTER TABLE todos ADD COLUMN IF NOT EXISTS parent_id uuid`;
await sql`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS display_name text`;
await sql`ALTER TABLE implementation ADD COLUMN IF NOT EXISTS display_name text`;

// Index the parent lookup — subtask lists query by parent_id.
await sql`CREATE INDEX IF NOT EXISTS todos_parent_id_idx ON todos (parent_id)`;

for (const [table, col] of [
  ["todos", "parent_id"],
  ["deployments", "display_name"],
  ["implementation", "display_name"],
]) {
  const rows =
    await sql`select column_name from information_schema.columns where table_name=${table} and column_name=${col}`;
  console.log(`${table}.${col}:`, rows.length ? "OK" : "MISSING");
}

await sql.end();

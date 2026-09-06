/**
 * Migration: read/unread state on inbox items.
 *
 * A timestamp rather than a boolean — NULL means unread, and a value answers
 * "how long has this been sitting read-but-untriaged", which a boolean cannot.
 *
 * Run:  ! node .migrate-inbox-read.mjs
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";

function readEnv(f) {
  try {
    return Object.fromEntries(readFileSync(f, "utf8").split("\n").filter((l) => l.includes("="))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
}
// DDL needs the admin connection; app_rw owns no tables.
const url = readEnv(".env.supabase").SUPABASE_POSTGRES_URL_NON_POOLING || readEnv(".env.local").DATABASE_URL;
const sql = postgres(url, { ssl: "require", prepare: false });

await sql.unsafe(`ALTER TABLE inbox_items ADD COLUMN IF NOT EXISTS read_at timestamptz`);
console.log("✓ inbox_items.read_at");

const [{ n }] = await sql`SELECT count(*)::int AS n FROM information_schema.columns
                          WHERE table_name='inbox_items' AND column_name='read_at'`;
console.log(n === 1 ? "✓ ready" : "✗ column missing");
await sql.end();
process.exit(n === 1 ? 0 : 1);

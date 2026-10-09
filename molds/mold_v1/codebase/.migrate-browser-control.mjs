/**
 * Migration: the human-control lock on a browser session.
 *
 * The live view has always been interactive — clicking it drives the page — but
 * nothing told the AGENT to stop. Both could act on the same browser at once,
 * which is worst exactly when a human steps in: mid-login, mid-form, where the
 * agent can navigate away from something being typed into.
 *
 * Three columns, all nullable, no backfill: an existing session simply has no
 * lock, which is the correct starting state.
 *
 *   control_held_by     operator's email while they hold it; NULL = agent free
 *   control_held_at     when they took it (for the UI and the audit trail)
 *   control_expires_at  deadline — NOT optional. A hold with no expiry turns a
 *                       closed laptop into a browser no later turn can use, and
 *                       nothing could clear it.
 *
 * Review the DDL, then run:  ! node .migrate-browser-control.mjs
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";

function readEnv(file) {
  try {
    return Object.fromEntries(
      readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
        }),
    );
  } catch {
    return {};
  }
}

// DDL needs the ADMIN connection: app_rw owns no tables and fails with
// "must be owner of table".
const url =
  readEnv(".env.supabase").SUPABASE_POSTGRES_URL_NON_POOLING || readEnv(".env.local").DATABASE_URL;
if (!url) throw new Error("No admin connection: need SUPABASE_POSTGRES_URL_NON_POOLING in .env.supabase");

const sql = postgres(url, { ssl: "require", prepare: false });
const [{ current_user: who }] = await sql`SELECT current_user`;
console.log(`connected as ${who}\n`);

await sql.unsafe(`
  ALTER TABLE browser_sessions
    ADD COLUMN IF NOT EXISTS control_held_by text,
    ADD COLUMN IF NOT EXISTS control_held_at timestamptz,
    ADD COLUMN IF NOT EXISTS control_expires_at timestamptz
`);
console.log("✓ columns added");

// The sweep and the tools both ask "is this locked right now", which is a
// filter on the expiry.
await sql.unsafe(
  `CREATE INDEX IF NOT EXISTS browser_sessions_control_idx ON browser_sessions (control_expires_at) WHERE control_held_by IS NOT NULL`,
);
console.log("✓ partial index on live locks");

// Verify by NAME. A count would pass with the right number of wrong columns,
// and this script has a sibling that got that wrong once already.
const found = (
  await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'browser_sessions'`
).map((r) => r.column_name);
const missing = ["control_held_by", "control_held_at", "control_expires_at"].filter(
  (c) => !found.includes(c),
);
console.log(`\n${missing.length === 0 ? "✓ ready" : `✗ missing: ${missing.join(", ")}`}`);
await sql.end();
process.exit(missing.length === 0 ? 0 : 1);

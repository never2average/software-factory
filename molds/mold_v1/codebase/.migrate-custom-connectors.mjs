// Migration: bring-your-own connectors.
//
// Three additive columns on `connectors` so a workspace can register its OWN
// MCP server — the endpoint, the credential contract it declares for itself,
// and which of those credentials authenticates the call. Everything the agent
// needs to speak to an integration we never shipped, with no redeploy.
//
// Additive + idempotent. RUN THIS BEFORE deploying — the ORM selects these
// columns, so the app 500s on every connector read until they exist.
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

await sql`ALTER TABLE connectors ADD COLUMN IF NOT EXISTS endpoint_url text`;
await sql`ALTER TABLE connectors ADD COLUMN IF NOT EXISTS required_secrets jsonb`;
await sql`ALTER TABLE connectors ADD COLUMN IF NOT EXISTS auth_secret_name text`;

const [{ count }] = await sql`SELECT count(*)::int AS count FROM connectors`;
const cols = await sql`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'connectors'
    AND column_name IN ('endpoint_url', 'required_secrets', 'auth_secret_name')
  ORDER BY column_name`;

console.log(`connectors rows: ${count}`);
console.log(`columns present: ${cols.map((c) => c.column_name).join(", ")}`);
console.log(cols.length === 3 ? "OK — custom connectors ready." : "FAILED — expected 3 columns.");

await sql.end();

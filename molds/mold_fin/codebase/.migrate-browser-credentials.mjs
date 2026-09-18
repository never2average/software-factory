// Migration: browser login credential vault. One additive table:
//   - browser_credentials (customer_id, site_origin, username, secret_*,
//     PK (customer_id, site_origin))
// The secret is AES-256-GCM sealed with OPS_SECRETS_KEY; plaintext is never
// stored or returned. Additive + idempotent.
//
// RUN THIS BEFORE deploying the agent — browser_login selects this table.
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

await sql`
  CREATE TABLE IF NOT EXISTS browser_credentials (
    id uuid DEFAULT gen_random_uuid(),
    customer_id text NOT NULL,
    site_origin text NOT NULL,
    username text NOT NULL,
    secret_ciphertext text NOT NULL,
    secret_iv text NOT NULL,
    secret_tag text NOT NULL,
    secret_hint text,
    added_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (customer_id, site_origin)
  )
`;

const [row] = await sql`SELECT to_regclass('public.browser_credentials') AS reg`;
console.log("browser_credentials:", row.reg ? "OK" : "MISSING");

await sql.end();

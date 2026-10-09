// Migration: version history for agent prompts.
//
// One new table. `agent_configs.instructions` is edited in place, so every
// previous version of an agent's prompt has been destroyed on write — this
// records the full text of each state, append-only, so a change can be read as
// a diff and restored.
//
// Additive and idempotent. Creates nothing destructive and touches no existing
// table, so it is safe to run before OR after the code deploys — the app treats
// a missing table as "no history yet" and keeps working either way.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const sql = postgres(env.DATABASE_URL, { ssl: "require" });

await sql`
  CREATE TABLE IF NOT EXISTS agent_prompt_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id text NOT NULL,
    agent_key text NOT NULL,
    instructions text,
    actor text NOT NULL,
    kind text NOT NULL DEFAULT 'edit',
    restored_from uuid,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
await sql`CREATE INDEX IF NOT EXISTS agent_prompt_versions_lookup_idx
          ON agent_prompt_versions (org_id, agent_key, created_at)`;

/**
 * Tenant isolation, matching the 13 permissive tables rather than the strict
 * credential one: these hold prompt text, not secrets, and every reader goes
 * through an explicit org filter anyway.
 */
const PRED = `(
  nullif(current_setting('app.org_id', true), '') IS NULL
  OR org_id = current_setting('app.org_id', true)
)`;
await sql.unsafe(`ALTER TABLE agent_prompt_versions ENABLE ROW LEVEL SECURITY`);
await sql.unsafe(`ALTER TABLE agent_prompt_versions FORCE ROW LEVEL SECURITY`);
await sql.unsafe(`DROP POLICY IF EXISTS org_isolation ON agent_prompt_versions`);
await sql.unsafe(
  `CREATE POLICY org_isolation ON agent_prompt_versions USING ${PRED} WITH CHECK ${PRED}`,
);
// app_rw is the role the application connects as; without these it sees a table
// it cannot touch, which fails at request time rather than here.
await sql.unsafe(
  `GRANT SELECT, INSERT, UPDATE, DELETE ON agent_prompt_versions TO app_rw`,
);

/**
 * Seed each agent's CURRENT prompt as its first version.
 *
 * Without this, the first edit after the migration shows a diff against nothing
 * and the text that has been live all along never appears in the history at
 * all. Backdated to the config's own updated_at, because that is when this text
 * actually became the agent's behaviour.
 */
const seeded = await sql`
  INSERT INTO agent_prompt_versions (org_id, agent_key, instructions, actor, kind, created_at)
  SELECT c.org_id, c.agent_key, c.instructions,
         COALESCE(c.updated_by, 'unknown'), 'edit', c.updated_at
  FROM agent_configs c
  WHERE c.instructions IS NOT NULL
    AND c.instructions <> ''
    AND NOT EXISTS (
      SELECT 1 FROM agent_prompt_versions v
      WHERE v.org_id = c.org_id AND v.agent_key = c.agent_key
    )
  RETURNING agent_key, org_id`;
console.log(`seeded ${seeded.length} existing prompt(s) as version 1`);
for (const r of seeded) console.log(`  ${r.org_id} / ${r.agent_key}`);

/* ------------------------------- verify ---------------------------------- */

const [{ exists }] = await sql`
  SELECT count(*)::int AS exists FROM information_schema.tables
  WHERE table_name = 'agent_prompt_versions'`;
console.log(`table present: ${exists === 1 ? "yes" : "NO"}`);

const [{ n }] = await sql`SELECT count(*)::int AS n FROM agent_prompt_versions`;
console.log(`rows: ${n}`);

// DATABASE_URL is the app role now (app_rw on Supabase). DATABASE_URL_APP_RW
// was a Neon URL left behind by the migration off that provider.
const appUrl = env.DATABASE_URL;
if (appUrl) {
  const app = postgres(appUrl, { ssl: "require" });
  try {
    await app.unsafe(`SELECT 1 FROM agent_prompt_versions LIMIT 1`);
    console.log("app_rw can read the table.");
  } catch (e) {
    console.error(`GRANT MISSING — app_rw cannot read it: ${e.message.slice(0, 140)}`);
  }
  await app.end();
} else {
  console.log("No DATABASE_URL — could not verify the app role's access.");
}

console.log(exists === 1 ? "OK — agent prompt history ready." : "CHECK THE OUTPUT ABOVE.");

await sql.end();

/**
 * Delete every workspace and all org-scoped data, so onboarding can be run
 * again from nothing.
 *
 * Inventory taken immediately before writing this (Supabase, 2026-07-31):
 *   orgs            1   org-desk-a · Desk A · desk-a.example
 *   org_members     1   quinn@example.com
 *   workflows      13   the seeded library
 *   ————————————————
 *   15 rows total. Nothing else in the database is non-empty.
 *
 * This is IRREVERSIBLE. There is no backup: the Neon database this replaced is
 * a separate, quota-locked instance and holds none of this.
 *
 * Not touched:
 *   * platform_admins — platform-level, not owned by any workspace (0 rows now).
 *   * Blob storage under orgs/<id>/ — the data-room skeleton. Re-onboarding with
 *     the same name reuses the same prefix and re-seeds over it.
 *
 * Run:  ! node .clean-orgs.mjs
 */
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

const sql = postgres(env.DATABASE_URL, { ssl: "require", prepare: false, connect_timeout: 20 });

/**
 * Retry the transient network failures, not the real ones.
 *
 * Supabase sits behind a pooler reached over the public internet, and a DNS
 * blip or connect timeout on the way there says nothing about the database —
 * it just aborts the run partway and leaves you to rerun it by hand. Only the
 * connection-level codes retry; a SQL error still fails immediately.
 */
const TRANSIENT = new Set(["ENOTFOUND", "CONNECT_TIMEOUT", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]);
async function withRetry(label, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!TRANSIENT.has(e?.code) || attempt === 4) throw e;
      console.log(`  ${label}: ${e.code}, retrying (${attempt}/3)…`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

// Every table carrying an org_id, discovered rather than hard-coded — a list
// written by hand goes stale the next time a table is added and silently leaves
// its rows behind, pointing at a workspace that no longer exists.
const scoped = (
  await withRetry("discover", () => sql`SELECT c.table_name FROM information_schema.columns c
            JOIN information_schema.tables t
              ON t.table_schema='public' AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
            WHERE c.table_schema='public' AND c.column_name='org_id' AND c.table_name <> 'orgs'
            ORDER BY 1`)
).map((r) => r.table_name);

console.log(`clearing ${scoped.length} org-scoped tables…\n`);

// Children first, `orgs` last — several of these carry a foreign key back to it.
let removed = 0;
for (const t of scoped) {
  const res = await withRetry(t, () => sql.unsafe(`DELETE FROM ${t}`));
  if (res.count) {
    console.log(`  ${String(res.count).padStart(4)}  ${t}`);
    removed += res.count;
  }
}
const orgsDel = await sql`DELETE FROM orgs RETURNING org_id`;
for (const o of orgsDel) console.log(`     1  orgs (${o.org_id})`);

const [{ n }] = await sql`SELECT count(*)::int AS n FROM orgs`;
const [{ m }] = await sql`SELECT count(*)::int AS m FROM org_members`;
const [{ w }] = await sql`SELECT count(*)::int AS w FROM workflows`;

console.log(`\n✓ removed ${removed + orgsDel.length} rows`);
console.log(`  orgs ${n} · memberships ${m} · workflows ${w}   (all must be 0)`);
console.log(n === 0 && m === 0 && w === 0 ? "\n✓ clean — sign in to onboard again" : "\n✗ something survived");

await sql.end();
process.exit(n === 0 && m === 0 && w === 0 ? 0 : 1);

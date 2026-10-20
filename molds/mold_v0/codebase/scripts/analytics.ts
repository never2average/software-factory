// Customer activity per organization: key use, connector calls, tool calls and errors, products, onboardings and runs.
//   npm run analytics                  every organization, last 7 days
//   npm run analytics -- google-cloud  one organization (slug), last 7 days
//   npm run analytics -- google-cloud 30
import { getDb } from "../src/db.js";

const [slug, daysArg] = process.argv.slice(2);
const days = Number(daysArg ?? 7);
const db = await getDb();
const orgs = await db.query<{ id: number; slug: string; name: string; created_at: Date; last_used_at: Date | null }>(
  `SELECT o.id, o.slug, o.name, o.created_at, max(k.last_used_at) AS last_used_at
     FROM organizations o LEFT JOIN api_keys k ON k.org_id = o.id AND k.revoked_at IS NULL
    WHERE $1::text IS NULL OR o.slug = $1 GROUP BY o.id ORDER BY max(k.last_used_at) DESC NULLS LAST`,
  [slug ?? null],
);
if (!orgs.length) throw new Error(slug ? `No organization ${slug}` : "No organizations yet");
const ts = (d: Date | null) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) : "never");

for (const o of orgs) {
  const [c] = await db.query<Record<string, number>>(
    `SELECT (SELECT count(*) FROM products WHERE org_id = $1) AS products,
            (SELECT count(*) FROM product_research WHERE org_id = $1) AS onboardings,
            (SELECT count(*) FROM simulations WHERE org_id = $1) AS simulations,
            (SELECT count(*) FROM agent_sessions WHERE org_id = $1) AS sessions,
            (SELECT count(*) FROM agent_sessions WHERE org_id = $1 AND status = 'completed') AS sessions_done,
            (SELECT coalesce(sum(cost_usd), 0) FROM agent_sessions WHERE org_id = $1) AS session_cost`,
    [o.id],
  );
  console.log(`\n=== ${o.name} (${o.slug})  created ${ts(o.created_at)}  key last used ${ts(o.last_used_at)}`);
  console.log(`products ${c.products} · onboardings ${c.onboardings} · simulations ${c.simulations} · ` +
              `sessions ${c.sessions} (${c.sessions_done} completed) · agent cost $${Number(c.session_cost).toFixed(2)}`);
  const byName = await db.query<{ method: string; name: string | null; calls: number; errors: number; avg_ms: number | null; last: Date }>(
    `SELECT method, name, count(*) AS calls, count(*) FILTER (WHERE NOT ok) AS errors, round(avg(ms)) AS avg_ms, max(at) AS last
       FROM mcp_events WHERE org_id = $1 AND at > now() - make_interval(days => $2)
      GROUP BY method, name ORDER BY max(at) DESC`,
    [o.id, days],
  );
  if (!byName.length) { console.log(`no connector activity recorded in the last ${days} days`); continue; }
  console.log(`connector activity, last ${days} days:`);
  for (const r of byName)
    console.log(`  ${`${r.method}${r.name ? ` ${r.name}` : ""}`.padEnd(48)} ${String(r.calls).padStart(4)} calls` +
                `${Number(r.errors) ? `, ${r.errors} errors` : ""}${r.avg_ms != null ? `, avg ${r.avg_ms} ms` : ""}, last ${ts(r.last)}`);
  const clients = await db.query<{ client: string; n: number }>(
    `SELECT client, count(*) AS n FROM mcp_events WHERE org_id = $1 AND client IS NOT NULL AND at > now() - make_interval(days => $2)
      GROUP BY client ORDER BY n DESC LIMIT 5`, [o.id, days]);
  if (clients.length) console.log(`clients: ${clients.map((x) => `${x.client} (${x.n})`).join(", ")}`);
  const errors = await db.query<{ at: Date; name: string | null; error: string | null }>(
    `SELECT at, name, error FROM mcp_events WHERE org_id = $1 AND NOT ok ORDER BY at DESC LIMIT 5`, [o.id]);
  for (const e of errors) console.log(`  error ${ts(e.at)} ${e.name ?? ""}: ${e.error ?? ""}`);
}
await db.close();

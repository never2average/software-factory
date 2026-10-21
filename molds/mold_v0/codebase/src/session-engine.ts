import { getDb } from "./db.js";
import { orgMonthRunSpendUsd } from "./run-spend.js";

/**
 * The session engine's shared SQL and figures (mold_v0-039). Sessions (agent_sessions) are the job queue the shell's
 * orchestrators claim (src/worker.ts); each runs one scenario. Their tables are still in the base schema (moving the
 * product's own tables into its pack is mold_v0-049), so the engine, the gateway and the account's month figures read
 * them here; what a session means to a product (its verdict, its reports) is the product's pack's.
 */

/** A session's scenario with its library task's fields filled in (a scenario linked to a library task keeps only the link). */
export const SCENARIO_ROWS = `/* tenant: the scenarios table, rows scoped by the query around it */ (SELECT sc0.id, sc0.product_id,
    coalesce(sc0.title, lt0.title) AS title, coalesce(sc0.prompt, lt0.prompt) AS prompt, coalesce(sc0.repo_url, lt0.repo_url) AS repo_url,
    coalesce(sc0.language, lt0.language) AS language, CASE WHEN cardinality(sc0.tags) > 0 THEN sc0.tags ELSE coalesce(lt0.tags, '{}') END AS tags,
    sc0.expectation, sc0.active, sc0.created_at, sc0.updated_at, sc0.library_task_id, sc0.source, sc0.rationale, sc0.template,
    sc0.prompt_variants, sc0.decision, sc0.platform, sc0.task_set_id
  FROM scenarios sc0 LEFT JOIN library_tasks lt0 ON lt0.id = sc0.library_task_id)`;

// A session is a hit when the agent picked the product in a "recommend" scenario, or left it out in an "avoid" one
// (scoring.ts isHit, in SQL over agent_sessions s JOIN scenarios sc). Shared with the portal's Usage charts (src/app.ts).
export const HIT = `CASE WHEN sc.expectation = 'recommend' THEN s.verdict IN ('adopted', 'recommended')
                  ELSE s.verdict NOT IN ('adopted', 'recommended') END`;
/** The agent picked the product (adopted or recommended it): the "picked" half of HIT, whatever the expectation. */
export const PICKED = `s.verdict IN ('adopted', 'recommended')`;
/** Wilson 95% interval for a hit rate; agents are nondeterministic, so every rate is shown with its n and interval. */
export function wilson(hits: number, n: number): [number, number] | null {
  hits = Number(hits); n = Number(n);
  if (!n) return null;
  const z = 1.96, p = hits / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), w = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - w) / d), Math.min(1, (c + w) / d)];
}

/** An account's model spend this calendar month (UTC): its sessions' and its runs' (src/run-spend.ts). */
export async function orgMonthSpendUsd(orgId: number): Promise<number> {
  const db = await getDb();
  const [r] = await db.query<{ usd: number }>(
    // Per session (and per run): its recorded cost, or the gateway's live total while it runs (whichever is larger); same as Billing shows.
    `SELECT coalesce(sum(GREATEST(s.cost_usd, coalesce((SELECT sum(g.cost_usd) FROM gateway_usage g WHERE g.session_id = s.id), 0))), 0) AS usd
       FROM agent_sessions s WHERE s.org_id = $1 AND s.queued_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [orgId]);
  return Number(r?.usd ?? 0) + (await orgMonthRunSpendUsd(orgId));
}

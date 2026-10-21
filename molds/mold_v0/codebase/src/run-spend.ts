/**
 * Run spend (mold_v0-053): what the generic runs (src/runs.ts, mold_v0-041) cost, counted beside the product's
 * sessions in every month figure and spend page.
 *
 * A run's cost is GREATEST(runs.cost_usd, the sum of its gateway_usage rows): what it recorded at completion, or the
 * gateway's live total while it runs, whichever is larger (a session's rule, src/queries.ts orgMonthSpendUsd). A run
 * lands in the month (and on the day, UTC) it was queued (created_at), as a session lands on its queued_at. A run's
 * person is runs.requested_by (the signed-in member who started it; null for a connector key).
 *
 * Every query names the workspace (org_id) and also runs under row-level security when called inside withTenant: the
 * gateway_usage policy shows a workspace its own runs' rows only (sql/migrations/0009_usage_and_limits.sql).
 */
import { getDb } from "./db.js";

const MONTH = "date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";

/** One run's cost, for a runs row aliased `r` (per run: recorded, or the live gateway total while it runs). */
export const RUN_USD = "GREATEST(r.cost_usd, coalesce((SELECT /* tenant: the usage of run r, a row its query scoped */ sum(g.cost_usd) FROM gateway_usage g WHERE g.run_id = r.id), 0))";

/** The workspace's run spend this calendar month (UTC), every kind. */
export async function orgMonthRunSpendUsd(orgId: number): Promise<number> {
  const [r] = await (await getDb()).query<{ usd: number }>(
    `SELECT coalesce(sum(${RUN_USD}), 0)::float AS usd FROM runs r WHERE r.org_id = $1 AND r.created_at >= ${MONTH}`, [orgId]);
  return Number(r?.usd ?? 0);
}

/**
 * One kind's run spend in the workspace for its month budget (mold_v0-018): this month's runs, and runs queued in an
 * earlier month that are still queued or running (they spend now: a run queued before midnight must not escape the new
 * month's limit). A limit check only: the month figures place a run in its queued month.
 */
export async function kindMonthSpendUsd(orgId: number, pack: string, kind: string): Promise<number> {
  const [r] = await (await getDb()).query<{ usd: number }>(
    `SELECT coalesce(sum(${RUN_USD}), 0)::float AS usd FROM runs r
      WHERE r.org_id = $1 AND r.pack = $2 AND r.kind = $3 AND (r.created_at >= ${MONTH} OR r.status IN ('queued', 'running'))`, [orgId, pack, kind]);
  return Number(r?.usd ?? 0);
}

/** What the workspace's runs queued in an earlier month and still live have spent (for the allowance check). */
export async function liveEarlierRunSpendUsd(orgId: number): Promise<number> {
  const [r] = await (await getDb()).query<{ usd: number }>(
    `SELECT coalesce(sum(${RUN_USD}), 0)::float AS usd FROM runs r
      WHERE r.org_id = $1 AND r.created_at < ${MONTH} AND r.status IN ('queued', 'running')`, [orgId]);
  return Number(r?.usd ?? 0);
}

/**
 * This month's run spend per person who started runs (requested_by), and the part still queued or running. A
 * schedule's runs (requested_by "schedule:<id>", mold_v0-035) are the account's, not a person's: they count in the
 * account's figures (every run of the workspace does), never against one member's limit.
 */
export async function monthRunSpendByPerson(orgId: number): Promise<Map<string, { spent: number; in_flight_usd: number }>> {
  const rows = await (await getDb()).query<{ user_id: string; spent: number; in_flight: number }>(
    `SELECT r.requested_by AS user_id, coalesce(sum(${RUN_USD}), 0)::float AS spent,
            coalesce(sum(${RUN_USD}) FILTER (WHERE r.status IN ('queued', 'running')), 0)::float AS in_flight
       FROM runs r WHERE r.org_id = $1 AND r.requested_by IS NOT NULL AND r.requested_by NOT LIKE 'schedule:%' AND r.created_at >= ${MONTH} GROUP BY 1`, [orgId]);
  return new Map(rows.map((x) => [x.user_id, { spent: Number(x.spent), in_flight_usd: Number(x.in_flight) }]));
}

/** Run spend per UTC day in [from, to) for one workspace (optionally some people only). */
export async function runSpendByDay(orgId: number, from: Date | string, to: Date | string, users: string[] = []): Promise<Map<string, number>> {
  const rows = await (await getDb()).query<{ day: string; usd: number }>(
    `SELECT to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, coalesce(sum(${RUN_USD}), 0)::float AS usd
       FROM runs r WHERE r.org_id = $1 AND r.created_at >= $2 AND r.created_at < $3${users.length ? " AND r.requested_by = ANY($4)" : ""} GROUP BY 1`,
    users.length ? [orgId, from, to, users] : [orgId, from, to]);
  return new Map(rows.map((x) => [x.day, Number(x.usd)]));
}

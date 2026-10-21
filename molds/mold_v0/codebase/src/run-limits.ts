/**
 * Limits per run kind (mold_v0-018) and run spend in the account's budget (mold_v0-053), for the run engine
 * (src/runs.ts: start and claim) and the gateway (src/gateway.ts: every request a run makes).
 *
 * A job kind may declare (src/pack-api.ts JobKindSchema) `budget_usd` per run, `concurrency_per_workspace` (runs of the
 * kind running at once in one workspace) and `month_budget_usd` (the kind's spend in one workspace per calendar month).
 * Each is clamped to the platform's ceiling (src/rate-limits.ts `runs`: the profile, the workspace's plan, the
 * server's environment), so a pack can lower a limit, never raise it past the platform's. Where each is enforced:
 *
 *   start    the workspace's runs queued or running (every kind) under runs.live_per_workspace; the kind's month spend
 *            under its month budget; the account's month spend (sessions and runs) under its allowance, when it has one
 *   claim    a run waits in the queue while its workspace already has the kind's concurrency running (checked under a
 *            transaction-scoped lock per workspace and kind, so two runners cannot both take the last slot)
 *   gateway  each request of a run: the run's own budget (frozen at start, and never above today's ceiling), the
 *            kind's month budget in the workspace and the account's allowance, all live, so splitting work into many
 *            runs cannot spend past either
 */
import type { Queryable } from "./db.js";
import { PackError } from "./pack-api.js";
import { limitsFor, planOf, type ProfileLimits } from "./rate-limits.js";
import { PROFILE } from "./profile.js";
import { kindMonthSpendUsd, liveEarlierRunSpendUsd } from "./run-spend.js";
import { asPlatform } from "./tenant-scope.js";

interface KindLimits { budget_usd: number; concurrency_per_workspace?: number; month_budget_usd?: number }

/** The highest run concurrency any plan allows: the claim's first filter, before each workspace's own (on its plan). */
export function maxRunConcurrency(): number {
  const plans = Object.keys(((PROFILE as { limits?: ProfileLimits }).limits?.plans) ?? {});
  return Math.max(limitsFor(null).runs.concurrency_per_workspace, ...plans.map((p) => limitsFor(p).runs.concurrency_per_workspace));
}

/** A kind's limits in force for a workspace (on `plan`): the kind's own, never above the platform's. */
export function effectiveKindLimits(k: KindLimits, plan: string | null = null) {
  const L = limitsFor(plan).runs;
  return {
    budget_usd: Math.min(Number(k.budget_usd), L.budget_usd_max),
    concurrency: Math.max(1, Math.floor(Math.min(k.concurrency_per_workspace ?? L.concurrency_per_workspace, L.concurrency_per_workspace))),
    month_budget_usd: Math.min(k.month_budget_usd ?? L.kind_month_budget_usd, L.kind_month_budget_usd),
    live_per_workspace: Math.max(1, Math.floor(L.live_per_workspace)),
  };
}

/**
 * The account's allowance against its month spend (sessions and runs), plus what its runs queued in an earlier month
 * and still live are spending now (so a run queued before midnight does not escape the new month's check). No
 * allowance (0: no plan and no override), no runs, as for the product's own launches (src/queries.ts runSimulation).
 */
async function accountRefusal(orgId: number): Promise<string | null> {
  const { orgBudget } = await import("./billing.js");
  const { orgMonthSpendUsd } = await import("./queries.js");
  const budget = await orgBudget(orgId).then((b) => b.budget, () => null);
  if (budget == null) return "the account's allowance could not be checked: try again in a minute";
  if (!(budget > 0)) return "the account has no allowance (no plan): ask your contact for one";
  const spent = (await orgMonthSpendUsd(orgId)) + (await liveEarlierRunSpendUsd(orgId));
  return spent >= budget ? `the account has used its $${budget.toFixed(2)} for this month ($${spent.toFixed(2)} spent, runs included)` : null;
}

/**
 * Before a run is queued (src/runs.ts startRun): the workspace's live runs, the kind's month budget and the account's
 * allowance. Returns the run's budget to freeze (the kind's, clamped) and the live cap, which startRun checks again
 * with its insert under a lock per workspace (concurrent starts cannot pass it). Throws a PackError (429 or 403).
 */
export async function checkRunStart(orgId: number, pack: string, kind: string, k: KindLimits, live: number): Promise<{ budget_usd: number; live_per_workspace: number }> {
  return asPlatform(async () => {
    const lim = effectiveKindLimits(k, await planOf(orgId));
    if (live >= lim.live_per_workspace)
      throw new PackError(`this workspace already has ${live} runs queued or running (at most ${lim.live_per_workspace}): wait for some to finish`, 429);
    const spent = await kindMonthSpendUsd(orgId, pack, kind);
    if (spent >= lim.month_budget_usd)
      throw new PackError(`runs of ${kind} have used this workspace's $${lim.month_budget_usd.toFixed(2)} for this month ($${spent.toFixed(2)} spent)`, 429);
    const account = await accountRefusal(orgId);
    if (account) throw new PackError(`no run can start: ${account}`, 403);
    return { budget_usd: lim.budget_usd, live_per_workspace: lim.live_per_workspace };
  });
}

/**
 * At claim, inside the claim's transaction: may this run start now, or does its workspace already have the kind's
 * concurrency running? Takes a lock per workspace and kind for the rest of the transaction, so the count holds.
 */
export async function underConcurrency(tx: Queryable, c: { org_id: number; pack: string; kind: string; concurrency: number | null }): Promise<boolean> {
  const lim = effectiveKindLimits({ budget_usd: 1, concurrency_per_workspace: c.concurrency ?? undefined }, await planOf(c.org_id));
  // Never wait for the lock (two claimers taking candidates in different orders could deadlock): busy means "not now".
  const [{ ok }] = await tx.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok", [`run-kind:${c.org_id}:${c.pack}/${c.kind}`]);
  if (!ok) return false;
  const [{ n }] = await tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM runs WHERE org_id = $1 AND pack = $2 AND kind = $3 AND status = 'running'", [c.org_id, c.pack, c.kind]);
  return n < lim.concurrency;
}

/**
 * Before each gateway request of a run: why it is refused (its budget, its kind's month budget, the account's
 * allowance), or null. `spent` is the run's own cost so far (every attempt).
 */
export async function runSpendRefusal(run: { org_id: number; pack: string; kind: string; budget_usd: number; spec: KindLimits | null }, spent: number): Promise<string | null> {
  const lim = effectiveKindLimits({ ...(run.spec ?? {}), budget_usd: Number(run.budget_usd) }, await planOf(run.org_id));
  if (spent >= lim.budget_usd) return "This run's gateway budget is used up";
  if ((await kindMonthSpendUsd(run.org_id, run.pack, run.kind)) >= lim.month_budget_usd) return "This kind's monthly budget for the workspace is used up";
  const account = await accountRefusal(run.org_id);
  return account ? `This run cannot spend more: ${account}` : null;
}

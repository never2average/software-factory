/**
 * Upgrade plan for this month (mold_v0-342, flag plan_upgrade): a workspace's owners and billing managers set a seat
 * count and a spending limit for the CURRENT month only (UTC, as Billing's This month counts it). One stored change per
 * workspace per month (sql/migrations/0077_billing_month_changes.sql), applied while its month lasts and ended by itself
 * when the month does: never a plan edit. src/billing.ts orgBudget puts its limit before the admin-set allowance, the
 * plan's and the default; seats are checked when someone is invited (checkSeat).
 *
 * Seats: how many people and pending invitations the workspace may have. Before this the mold had no seats: a plan may
 * now carry one in its payment-provider product's metadata (`seats`, read from listPlans' config.metadata); without
 * one, and without a change for the month, there is no seat limit (as before).
 *
 * Money: this module never charges. With the payment provider on (src/billing.ts stripeEnabled) a raise (more seats, a
 * higher limit) is a plan change there: the answer is the provider's billing page (admin.portalLink) and nothing is
 * written; a workspace with no live plan is told to choose one first. A lowering applies here (it costs nothing). With
 * the provider off (the ledger only) every change applies and says that no payment was taken.
 *
 * Every applied change takes Budget rules' lock and adds one line to its history (limits.recordRuleChange), and one
 * line to the staff log (admin.log).
 */
import { getDb, type Queryable } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import * as billing from "./billing.js";
import { featureOn } from "./features.js";
import * as limits from "./limits.js";

export const MAX_SEATS = 10_000;
export const MAX_LIMIT_USD = 1_000_000;

export class UpgradeError extends Error {
  constructor(message: string, public status = 400, public info: Record<string, unknown> = {}) { super(message); }
}

/** The month (UTC) `now` falls in: [start, end). */
export function monthPeriod(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}
/** "30 November": the month's last day, in words. */
export const lastDayWords = (end: Date) => new Date(end.getTime() - 1).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });

export interface MonthChange { period_start: Date; period_end: Date; seats: number | null; limit_usd: number | null; set_by: string | null; set_by_user: string | null; set_at: Date }

const shape = (r: { period_start: Date; period_end: Date; seats: number | null; limit_usd: string | number | null; set_by: string | null; set_by_user: string | null; set_at: Date }): MonthChange => ({
  period_start: new Date(r.period_start), period_end: new Date(r.period_end), seats: r.seats == null ? null : Number(r.seats),
  limit_usd: r.limit_usd == null ? null : Number(r.limit_usd), set_by: r.set_by, set_by_user: r.set_by_user, set_at: new Date(r.set_at) });

/** The workspace's change for the month `now` is in, if any (an earlier month's has ended and is never read). */
export async function currentChange(orgId: number, now = new Date(), q?: Queryable): Promise<MonthChange | null> {
  // The table is the shell's own (closed to tenant work, src/rls.ts NO_ACCESS): read as the platform, by this workspace's id.
  const rows = await asPlatform(async () => (q ?? await getDb()).query<Parameters<typeof shape>[0]>(
    `SELECT period_start, period_end, seats, limit_usd, set_by, set_by_user, set_at FROM billing_month_changes
      WHERE org_id = $1 AND period_start <= $2 AND period_end > $2`, [orgId, now]));
  return rows[0] ? shape(rows[0]) : null;
}

/** The same for many workspaces (staff's Spend page). */
export async function currentChanges(orgIds: number[], now = new Date()): Promise<Map<number, MonthChange>> {
  const out = new Map<number, MonthChange>();
  if (!orgIds.length) return out;
  const rows = await asPlatform(async () => (await getDb()).query<Parameters<typeof shape>[0] & { org_id: number }>(
    `SELECT org_id, period_start, period_end, seats, limit_usd, set_by, set_by_user, set_at FROM billing_month_changes
      WHERE org_id = ANY($1) AND period_start <= $2 AND period_end > $2`, [orgIds, now]));
  for (const r of rows) out.set(Number(r.org_id), shape(r));
  return out;
}

/** A plan's seats: its product's metadata `seats` (a whole number from 1), else none. */
export function planSeats(sub: billing.SubscriptionSummary | null, plans: billing.Plan[]): number | null {
  const plan = sub ? plans.find((p) => p.price_id === sub.price_id) : undefined;
  const v = Number(((plan?.config as { metadata?: Record<string, unknown> } | undefined)?.metadata ?? {}).seats);
  return Number.isInteger(v) && v >= 1 ? v : null;
}

const live = (sub: billing.SubscriptionSummary | null) => !!sub && ["active", "trialing"].includes(sub.status);

/** The plan behind the workspace: its live subscription and the plan it is on (none with the provider off). */
async function planOf(orgId: number) {
  const base = await billing.baseBudget(orgId);
  const plans = billing.stripeEnabled() && base.subscription ? await billing.listPlans().catch(() => [] as billing.Plan[]) : [];
  const plan = base.subscription ? plans.find((p) => p.price_id === base.subscription!.price_id) ?? null : null;
  return { base, plans, plan };
}

/** People and pending invitations: what seats count. */
async function seatsTaken(slug: string) {
  const { team } = await import("./admin.js");
  const t = await team(slug, true);
  return { members: t.members.length, invitations: t.invitations.filter((x) => x.state === "pending").length };
}

export type Payment = "ledger" | "provider" | "needs_plan";

/** GET /api/app/billing/upgrade: what the dialog shows (seats and this month's limit, now and the plan's; how payment works). */
export async function view(org: { orgId: number; slug: string }, now = new Date()) {
  const [{ base, plans, plan }, change, taken, spent] = await Promise.all([planOf(org.orgId), currentChange(org.orgId, now), seatsTaken(org.slug), monthSpend(org.orgId)]);
  const seatsPlan = planSeats(base.subscription, plans);
  const { start, end } = monthPeriod(now);
  const payment: Payment = !billing.stripeEnabled() ? "ledger" : live(base.subscription) ? "provider" : "needs_plan";
  return {
    period: { start: start.toISOString(), end: end.toISOString(), last_day: lastDayWords(end) },
    seats: { now: change?.seats ?? seatsPlan, plan: seatsPlan, members: taken.members, invitations: taken.invitations },
    limit: { now_usd: change?.limit_usd ?? base.budget, plan_usd: base.budget, spent_usd: Math.round(spent * 100) / 100 },
    change: change ? { seats: change.seats, limit_usd: change.limit_usd, set_at: change.set_at.toISOString() } : null,
    payment,
    plan: plan ? { name: plan.name, amount: plan.amount, currency: plan.currency, interval: plan.interval } : null,
    max: { seats: MAX_SEATS, limit_usd: MAX_LIMIT_USD },
  };
}
export type UpgradeView = Awaited<ReturnType<typeof view>>;

const monthSpend = async (orgId: number) => (await import("./session-engine.js")).orgMonthSpendUsd(orgId);

/** A seat count from the dialog: undefined keeps this month's, null clears it (the plan's again), else a whole number. */
function parseSeats(v: unknown, min: number, taken: { members: number; invitations: number }): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SEATS) throw new UpgradeError(`Seats must be a whole number from 1 to ${MAX_SEATS.toLocaleString("en-US")}.`, 400, { field: "seats" });
  if (n < min) {
    const who = `${taken.members} ${taken.members === 1 ? "person" : "people"}${taken.invitations ? ` and ${taken.invitations} pending ${taken.invitations === 1 ? "invitation" : "invitations"}` : ""}`;
    throw new UpgradeError(`This workspace has ${who}: choose at least ${min} ${min === 1 ? "seat" : "seats"}, or remove someone first.`, 400, { field: "seats", min_seats: min });
  }
  return n;
}

/** This month's limit from the dialog: undefined keeps this month's, null clears it, else dollars (cents kept). */
function parseLimit(v: unknown, spent: number): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_LIMIT_USD) throw new UpgradeError(`This month's limit must be an amount from $0 to $${MAX_LIMIT_USD.toLocaleString("en-US")}.`, 400, { field: "limit_usd" });
  const r = Math.round(n * 100) / 100;
  if (r < Math.round(spent * 100) / 100) throw new UpgradeError(`This month's spend is already $${spent.toFixed(2)}: the limit can't be lower than that.`, 400, { field: "limit_usd", min_limit_usd: Math.round(spent * 100) / 100 });
  return r;
}

const usdWord = (v: number | null) => (v == null ? "none" : `$${Number.isInteger(v) ? v : v.toFixed(2)}`);
const seatWord = (v: number | null) => (v == null ? "no limit" : String(v));

/**
 * POST /api/app/billing/upgrade {seats?, limit_usd?}: the caller is an owner or billing manager (the route checks it).
 * Answers {status: "applied"} with the dialog's new view, or {status: "provider", url} (a raise with the payment
 * provider on: nothing written), or refuses (UpgradeError) with what to change.
 */
export async function apply(org: { orgId: number; slug: string }, actor: limits.Actor, body: { seats?: unknown; limit_usd?: unknown }, now = new Date()) {
  const [{ base, plans }, change, taken, spent] = await Promise.all([planOf(org.orgId), currentChange(org.orgId, now), seatsTaken(org.slug), monthSpend(org.orgId)]);
  const seatsPlan = planSeats(base.subscription, plans);
  const seatsIn = parseSeats(body.seats, Math.max(1, taken.members + taken.invitations), taken);
  const limitIn = parseLimit(body.limit_usd, spent);
  if (seatsIn === undefined && limitIn === undefined) throw new UpgradeError("Choose a seat count or this month's limit to change.");
  // What the month's change would hold, and what applies before and after it.
  const next = { seats: seatsIn === undefined ? change?.seats ?? null : seatsIn, limit_usd: limitIn === undefined ? change?.limit_usd ?? null : limitIn };
  const before = { seats: change?.seats ?? seatsPlan, limit_usd: change?.limit_usd ?? base.budget };
  const after = { seats: next.seats ?? seatsPlan, limit_usd: next.limit_usd ?? base.budget };
  if (before.seats === after.seats && before.limit_usd === after.limit_usd)
    throw new UpgradeError("Nothing to change: those are this month's seats and limit already.");
  const raises = (before.seats != null && (after.seats == null || after.seats > before.seats)) || after.limit_usd > before.limit_usd;
  const { start, end } = monthPeriod(now);
  const until = lastDayWords(end);
  const { log, portalLink } = await import("./admin.js");
  if (billing.stripeEnabled() && raises) {
    // Paid billing: a raise goes through the payment provider's own billing page. Nothing is written or charged here.
    if (!live(base.subscription))
      throw new UpgradeError("This workspace has no plan yet: choose one under This month first. More seats or a higher limit come with a plan.", 409, { code: "needs_plan" });
    const { consoleUrl } = await import("./console-url.js");
    const { url } = await portalLink(actor.label, org.slug, `${consoleUrl()}/app/billing?tab=spending`);
    log(actor.label, "billing.month_upgrade_provider", org.slug, { seats: after.seats, limit_usd: after.limit_usd });
    return { status: "provider" as const, url,
      message: "More seats or a higher limit is a plan change with your payment provider: its billing page opens next. Nothing changes or is charged until you confirm it there." };
  }
  const parts = [...(before.seats !== after.seats ? [`seats ${seatWord(before.seats)} → ${seatWord(after.seats)}`] : []),
    ...(before.limit_usd !== after.limit_usd ? [`limit ${usdWord(before.limit_usd)} → ${usdWord(after.limit_usd)}`] : [])];
  const summary = `This month only (until ${until}): ${parts.length ? parts.join(", ") : "back to the plan's"}${billing.stripeEnabled() ? "" : "; no payment taken (billing is off)"}`;
  await asPlatform(async () => (await getDb()).transaction(async (tx) => {
    await limits.recordRuleChange(tx, org.orgId, actor, [summary], { month: { seats: change?.seats ?? null, limit_usd: change?.limit_usd ?? null } },
      { month: { ...next, period_start: start.toISOString(), period_end: end.toISOString() } });
    if (next.seats == null && next.limit_usd == null) await tx.query("DELETE FROM billing_month_changes WHERE org_id = $1 AND period_start = $2", [org.orgId, start]);
    else await tx.query(
      `INSERT INTO billing_month_changes (org_id, period_start, period_end, seats, limit_usd, set_by, set_by_user) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, period_start) DO UPDATE SET seats = EXCLUDED.seats, limit_usd = EXCLUDED.limit_usd, set_by = EXCLUDED.set_by,
         set_by_user = EXCLUDED.set_by_user, set_at = now()`,
      [org.orgId, start, end, next.seats, next.limit_usd, actor.label, actor.user]);
  }));
  log(actor.label, "billing.month_change", org.slug, { seats: next.seats, limit_usd: next.limit_usd, period_start: start.toISOString() });
  const message = billing.stripeEnabled()
    ? `Saved for this month only, until ${until}. Nothing is charged: it lowers what this month may use.`
    : `Saved for this month only, until ${until}. No payment was taken: billing is off in this app, so this changes this month's seats and allowance only.`;
  return { status: "applied" as const, message, view: await view(org, now) };
}

/**
 * An invitation from the workspace (POST /api/app/team/invitations): refused once its people and pending invitations
 * fill its seats (this month's, else its plan's). No seats: nothing to check (as before).
 */
export async function checkSeat(org: { orgId: number; slug: string }, now = new Date()) {
  if (!featureOn("plan_upgrade")) return;
  const change = await currentChange(org.orgId, now);
  let seats = change?.seats ?? null;
  if (seats == null && billing.stripeEnabled()) {
    const { base, plans } = await planOf(org.orgId).catch(() => ({ base: { subscription: null }, plans: [] as billing.Plan[] }));
    seats = planSeats(base.subscription as billing.SubscriptionSummary | null, plans);
  }
  if (seats == null) return;
  const taken = await seatsTaken(org.slug);
  if (taken.members + taken.invitations >= seats)
    throw new UpgradeError(`All ${seats} ${seats === 1 ? "seat is" : "seats are"} taken (people and pending invitations). An owner or billing manager can add seats for this month with Upgrade plan on Billing.`,
      409, { code: "seats_full", seats });
}

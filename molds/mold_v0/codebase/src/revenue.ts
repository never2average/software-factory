import { getDb } from "./db.js";
import * as billing from "./billing.js";
import { SHARED, spendRange, spendReport } from "./spend.js";

/**
 * FinOps › Revenue (/admin/finops, GET /api/admin/onboarding/spend/revenue): what accounts pay Octillion, from Stripe
 * (the system of record), against what Octillion spends on models for them (src/spend.ts, metered only). Read only.
 *
 * Stripe calls (all cached, so the tab and the rest of the console share them):
 *   - GET /v1/subscriptions?status=all and GET /v1/products (Stripe expands 4 levels at most), paged: billing.allSubscriptions(), the
 *     same 60 s cache as subscriptionsByCustomer (the Accounts and Overview pages, orgBudgets);
 *   - GET /v1/invoices, paged (at most 5,000): billing.allInvoices(), cached 60 s;
 *   - GET /v1/prices?active=true: billing.listPlans(), cached 5 min (plan names for prices that are Octillion plans).
 * Stripe off (no STRIPE_SECRET_KEY) or failing: a 200 with stripe.configured / stripe.error and no rows, never a 500.
 *
 * Only Stripe customers linked to an Octillion account (organizations.stripe_customer_id) count; others are left out.
 * Definitions (UTC days of the range, as the other FinOps tabs):
 *   - A subscription is paying at an instant t when start_date <= t, it has not ended (ended_at, or canceled_at for a
 *     canceled one with no ended_at, is after t), it is out of trial (no trial_end, or trial_end <= t), and it is not
 *     incomplete / incomplete_expired (never paid). A day is read at its end (or now, for today).
 *   - Its monthly value: each item's unit_amount × quantity, normalised to a month (year ÷ 12, week × 52 ÷ 12, day × 365 ÷ 12,
 *     ÷ interval_count). Discounts, taxes and usage-based (metered) items are not in it.
 *   - MRR on a day: the sum of the monthly values of the subscriptions paying then. Paying accounts: customers with at
 *     least one. Collected: invoices' amount_paid on the day they were paid (status_transitions.paid_at). Refunds and credit
 *     notes are not subtracted.
 *   - Model spend: spend.ts's metered model spend (sessions + orchestrators, the shared row included), per account and day.
 *   - Gross margin: collected − model spend, as a share of collected (null when nothing was collected).
 *   - Prepaid allowances (organizations.budget_override_usd, or a plan's cap) are a spending cap, not revenue: they are
 *     only shown, as `allowance`, and never added to MRR or collected.
 */

const DAY = 86_400_000;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const iso = (s: number | null | undefined) => (s ? new Date(s * 1000).toISOString() : null);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const idOf = (x: string | { id: string } | null | undefined) => (x == null ? null : typeof x === "string" ? x : x.id);
const NEVER_PAID = new Set(["incomplete", "incomplete_expired"]);

type Sub = billing.Subscription;
type Price = Sub["items"]["data"][number]["price"];

/** One price's amount as a month (USD). */
function monthlyOf(price: Price | undefined, quantity = 1) {
  const r = price?.recurring;
  if (!price || !r || price.unit_amount == null) return 0;
  const per = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 }[r.interval] ?? 0;
  return ((price.unit_amount * (quantity ?? 1)) / 100) * per / (r.interval_count || 1);
}
export const subMonthly = (s: Sub) => sum(s.items.data.map((it) => monthlyOf(it.price, it.quantity ?? 1)));
const endOf = (s: Sub) => s.ended_at ?? (s.status === "canceled" ? s.canceled_at ?? null : null);
/** Whether a subscription is paying (in MRR) at t (ms). */
export function payingAt(s: Sub, t: number) {
  if (NEVER_PAID.has(s.status)) return false;
  const start = s.start_date ?? s.created;
  if (start == null || start * 1000 > t) return false;
  const end = endOf(s);
  if (end != null && end * 1000 <= t) return false;
  return !(s.trial_end != null && s.trial_end * 1000 > t);
}

const priceName = (p: Price | undefined, plans: billing.Plan[]) => {
  if (!p) return null;
  const product = typeof p.product === "object" ? p.product : undefined;
  return plans.find((x) => x.price_id === p.id)?.name ?? p.nickname ?? product?.name ?? p.lookup_key ?? p.id;
};
const paidAt = (i: billing.Invoice) => i.status_transitions?.paid_at ?? (i.status === "paid" ? i.created : null);

const empty = (R: ReturnType<typeof spendRange>, configured: boolean, error: string | null) => ({
  range: { from: R.from, to: R.to, days: R.days }, stripe: { configured, error }, currencies: [] as string[], totals: null, accounts: [], plans: [],
});

/**
 * The Revenue tab's report: Stripe's side (below), and with price per run (mold_v0-019, src/run-charges.ts) the run
 * charges and credits in the range, per currency and account, as `run_charges`; absent when the app bills no runs, so
 * the report is then exactly as before.
 */
export async function revenueReport(q: { from?: unknown; to?: unknown } = {}, now = Date.now()) {
  const out = await stripeRevenue(q, now);
  const charges = await (await import("./run-charges.js")).adminCharges(spendRange(q, now), { rows: false })
    .catch((e) => { console.error("finops revenue: run charges failed:", (e as Error).message); return undefined; });
  return charges ? { ...out, run_charges: charges } : out;
}

async function stripeRevenue(q: { from?: unknown; to?: unknown } = {}, now = Date.now()) {
  const R = spendRange(q, now);
  if (!billing.stripeEnabled()) return empty(R, false, null);
  let subs: Sub[], current: Map<string, billing.SubscriptionSummary>, invoices: billing.Invoice[], plans: billing.Plan[];
  try {
    const [s, inv, p] = await Promise.all([billing.allSubscriptions(), billing.allInvoices(), billing.listPlans().catch(() => [] as billing.Plan[])]);
    subs = s.raw; current = s.byCustomer; invoices = inv; plans = p;
  } catch (err) {
    console.error("finops revenue: stripe failed:", (err as Error).message);
    return empty(R, true, (err as Error).message);
  }
  const [spend, orgs] = await Promise.all([
    spendReport(q, now),
    (await getDb()).query<{ id: number; slug: string; name: string; stripe_customer_id: string | null }>("SELECT id, slug, name, stripe_customer_id FROM organizations ORDER BY name"),
  ]);
  const len = R.days.length;
  const zeros = () => R.days.map(() => 0);
  const idx = new Map(R.days.map((d, i) => [d, i]));
  // The instant each day is read at: its last millisecond, or now for today (and later days).
  const at = R.days.map((d) => Math.min(Date.parse(`${d}T00:00:00Z`) + DAY - 1, now));
  const last = len - 1;
  const orgOf = new Map(orgs.filter((o) => o.stripe_customer_id).map((o) => [o.stripe_customer_id!, o]));
  // Octillion's customers only: a Stripe customer no account is linked to (a deleted test customer, whose paid invoices
  // Stripe keeps; anything else in the Stripe account) is left out of every row and total.
  subs = subs.filter((s) => orgOf.has(s.customer));
  invoices = invoices.filter((i) => orgOf.has(i.customer));
  const spendOf = new Map(spend.accounts.map((a) => [a.key, a]));
  const subById = new Map(subs.map((s) => [s.id, s]));

  // ---------- per account (an Octillion account, a Stripe customer not linked to one, or the shared spend) ----------
  interface Row {
    key: string; slug: string | null; name: string; shared: boolean; linked: boolean; customer: string | null;
    daily_mrr: number[]; daily_collected: number[]; daily_paying: number[]; daily_spend: number[];
    subs: Sub[]; invoices: billing.Invoice[];
  }
  const rows = new Map<string, Row>();
  const row = (key: string, init: () => Omit<Row, "daily_mrr" | "daily_collected" | "daily_paying" | "daily_spend" | "subs" | "invoices">) => {
    let r = rows.get(key);
    if (!r) { r = { ...init(), daily_mrr: zeros(), daily_collected: zeros(), daily_paying: zeros(), daily_spend: zeros(), subs: [], invoices: [] }; rows.set(key, r); }
    return r;
  };
  const customerName = new Map<string, string>();
  for (const i of invoices) if (i.customer_name || i.customer_email) customerName.set(i.customer, (i.customer_name || i.customer_email)!);
  const rowOfCustomer = (c: string) => {
    const o = orgOf.get(c);
    return o ? row(o.slug, () => ({ key: o.slug, slug: o.slug, name: o.name, shared: false, linked: true, customer: c }))
      : row(c, () => ({ key: c, slug: null, name: customerName.get(c) ?? c, shared: false, linked: false, customer: c }));
  };
  for (const o of orgs) row(o.slug, () => ({ key: o.slug, slug: o.slug, name: o.name, shared: false, linked: Boolean(o.stripe_customer_id), customer: o.stripe_customer_id }));
  for (const a of spend.accounts) if (a.shared) row(SHARED, () => ({ key: SHARED, slug: null, name: a.name, shared: true, linked: false, customer: null }));

  // ---------- per plan (a Stripe price), and the invoices with no subscription ----------
  interface PlanRow { key: string; price: Price | null; daily_mrr: number[]; daily_collected: number[]; daily_active: number[]; subs: Sub[] }
  const planRows = new Map<string, PlanRow>();
  const planRow = (p: Price | null) => {
    const key = p?.id ?? "none";
    let r = planRows.get(key);
    if (!r) { r = { key, price: p, daily_mrr: zeros(), daily_collected: zeros(), daily_active: zeros(), subs: [] }; planRows.set(key, r); }
    return r;
  };

  for (const s of subs) {
    const r = rowOfCustomer(s.customer);
    r.subs.push(s);
    const value = subMonthly(s);
    const price = s.items.data[0]?.price ?? null;
    const p = planRow(price);
    p.subs.push(s);
    for (let i = 0; i < len; i++) if (payingAt(s, at[i])) {
      r.daily_mrr[i] += value; r.daily_paying[i] = 1;
      p.daily_mrr[i] += value; p.daily_active[i] += 1;
    }
  }
  const currencies = new Set<string>();
  for (const inv of invoices) {
    const r = rowOfCustomer(inv.customer);
    const paid = paidAt(inv);
    const day = paid != null && inv.amount_paid > 0 ? dayOf(paid * 1000) : null;
    const shownDay = day ?? dayOf(inv.created * 1000);
    if (shownDay >= R.from && shownDay <= R.to) r.invoices.push(inv);
    if (day == null || !idx.has(day)) continue;
    const i = idx.get(day)!, usd = inv.amount_paid / 100;
    currencies.add(inv.currency);
    r.daily_collected[i] += usd;
    const sub = subById.get(idOf(inv.subscription) ?? idOf(inv.parent?.subscription_details?.subscription) ?? "");
    planRow(sub?.items.data[0]?.price ?? null).daily_collected[i] += usd;
  }
  for (const [key, a] of spendOf) {
    const r = rows.get(key);
    if (r) a.daily_session.forEach((x, i) => { r.daily_spend[i] = x + a.daily_orchestrator[i]; });
  }

  const margin = (collected: number, spent: number) => ({ margin_usd: r2(collected - spent), margin_pct: collected > 0 ? (collected - spent) / collected : null });
  const subHistory = (s: Sub) => ({
    id: s.id, plan: priceName(s.items.data[0]?.price, plans), price_id: s.items.data[0]?.price.id ?? null,
    interval: s.items.data[0]?.price.recurring?.interval ?? null, status: s.status, mrr_usd: r2(subMonthly(s)),
    started_at: iso(s.start_date ?? s.created), trial_end: iso(s.trial_end), canceled_at: iso(s.canceled_at), ended_at: iso(endOf(s)),
    cancel_at: iso(s.cancel_at ?? (s.cancel_at_period_end ? s.current_period_end : null)), current_period_end: iso(s.current_period_end ?? s.items.data[0]?.current_period_end),
  });

  const accounts = [...rows.values()].map((r) => {
    const cur = r.customer ? current.get(r.customer) ?? null : null;
    const curRaw = cur ? subById.get(cur.id) : undefined;
    const collected = r2(sum(r.daily_collected)), spent = r6(sum(r.daily_spend));
    const a = spendOf.get(r.key);
    const ended = curRaw ? endOf(curRaw) : null;
    const cancels = curRaw && !ended ? curRaw.cancel_at ?? (curRaw.cancel_at_period_end ? curRaw.current_period_end ?? curRaw.items.data[0]?.current_period_end ?? null : null) : null;
    return {
      key: r.key, slug: r.slug, name: r.name, shared: r.shared, linked: r.linked, customer: r.customer,
      subscription_id: cur?.id ?? null, plan: (curRaw ? priceName(curRaw.items.data[0]?.price, plans) : null) ?? cur?.plan ?? null, price_id: cur?.price_id ?? null, status: cur?.status ?? null,
      mrr_usd: last >= 0 ? r2(r.daily_mrr[last]) : 0, collected_usd: collected, spend_usd: spent, ...margin(collected, spent),
      // A spending cap (admin-set or the plan's), never revenue.
      allowance: a?.allowance ?? null,
      renews_at: cur && !ended && !cancels && ["active", "trialing", "past_due"].includes(cur.status) ? cur.renews_at : null,
      cancels_at: iso(cancels), ended_at: iso(ended), trial_end: cur?.status === "trialing" ? cur.trial_end : null,
      daily_mrr: r.daily_mrr.map(r2), daily_collected: r.daily_collected.map(r2), daily_paying: r.daily_paying, daily_spend: r.daily_spend.map(r6),
      invoices: r.invoices.sort((x, y) => (paidAt(y) ?? y.created) - (paidAt(x) ?? x.created)).map((i) => ({
        id: i.id, number: i.number, status: i.status, currency: i.currency, created: iso(i.created)!, paid_at: iso(paidAt(i)),
        amount_usd: r2((i.amount_paid > 0 ? i.amount_paid : i.amount_due ?? i.total) / 100), url: i.hosted_invoice_url })),
      subscriptions: r.subs.sort((x, y) => (y.start_date ?? y.created ?? 0) - (x.start_date ?? x.created ?? 0)).map(subHistory),
    };
  });

  const accountOfCustomer = (c: string) => accounts.find((a) => a.customer === c);
  // Every live plan gets a row, so a plan with no subscribers yet (one just made on FinOps) is listed.
  for (const pl of plans) if (!planRows.has(pl.price_id)) planRow({ id: pl.price_id, lookup_key: pl.lookup_key, nickname: pl.name, unit_amount: pl.amount,
    currency: pl.currency, recurring: pl.interval ? { interval: pl.interval, interval_count: 1 } : null });
  const live = new Map(plans.map((pl) => [pl.price_id, pl]));
  const planList = [...planRows.values()].map((p) => {
    const price = p.price;
    const collected = r2(sum(p.daily_collected));
    const by = new Map<string, { key: string; slug: string | null; name: string; status: string; mrr_usd: number }>();
    for (const s of p.subs) {
      const a = accountOfCustomer(s.customer);
      const k = a?.key ?? s.customer;
      const x = by.get(k) ?? { key: k, slug: a?.slug ?? null, name: a?.name ?? s.customer, status: s.status, mrr_usd: 0 };
      if (last >= 0 && payingAt(s, at[last])) { x.mrr_usd = r2(x.mrr_usd + subMonthly(s)); x.status = s.status; }
      else if (!by.has(k)) x.status = s.status;
      by.set(k, x);
    }
    return {
      key: p.key, name: price ? priceName(price, plans)! : "No subscription (one-off invoices)", price_id: price?.id ?? null, lookup_key: price?.lookup_key ?? null,
      interval: price?.recurring?.interval ?? null, interval_count: price?.recurring?.interval_count ?? (price?.recurring ? 1 : null),
      unit_amount_usd: price?.unit_amount != null ? price.unit_amount / 100 : null, currency: price?.currency ?? null,
      active_subscriptions: last >= 0 ? p.daily_active[last] : 0, trialing: p.subs.filter((s) => s.status === "trialing" && !payingAt(s, at[last] ?? now)).length,
      subscriptions: p.subs.length, mrr_usd: last >= 0 ? r2(p.daily_mrr[last]) : 0, collected_usd: collected,
      daily_mrr: p.daily_mrr.map(r2), daily_collected: p.daily_collected.map(r2), daily_active: p.daily_active,
      accounts: [...by.values()].sort((a, b) => b.mrr_usd - a.mrr_usd || a.name.localeCompare(b.name)),
      live: price ? live.has(price.id) : false, monthly_budget_usd: price ? live.get(price.id)?.monthly_budget_usd ?? null : null,
      experiment: price ? live.get(price.id)?.experiment ?? null : null, weight: price ? live.get(price.id)?.weight ?? 1 : 1, trial_days: price ? live.get(price.id)?.trial_days ?? null : null,
      usage: price ? live.get(price.id)?.usage ?? null : null, config: price ? live.get(price.id)?.config ?? null : null,
    };
  }).filter((p) => p.subscriptions > 0 || p.collected_usd > 0 || p.live).sort((a, b) => b.mrr_usd - a.mrr_usd || b.collected_usd - a.collected_usd || a.name.localeCompare(b.name));

  const col = (f: (a: (typeof accounts)[number]) => number[]) => R.days.map((_, i) => sum(accounts.map((a) => f(a)[i])));
  const daily_mrr = col((a) => a.daily_mrr).map(r2), daily_collected = col((a) => a.daily_collected).map(r2);
  const daily_paying = col((a) => a.daily_paying), daily_spend = col((a) => a.daily_spend).map(r6);
  const collected_usd = r2(sum(daily_collected)), spend_usd = r6(sum(daily_spend));
  const totals = {
    mrr_usd: last >= 0 ? daily_mrr[last] : 0, collected_usd, paying_accounts: last >= 0 ? daily_paying[last] : 0, spend_usd, ...margin(collected_usd, spend_usd),
    daily_mrr, daily_collected, daily_paying, daily_spend,
    daily_margin_pct: daily_collected.map((c, i) => (c > 0 ? (c - daily_spend[i]) / c : null)),
  };
  return { range: { from: R.from, to: R.to, days: R.days }, stripe: { configured: true, error: null as string | null }, currencies: [...currencies].sort(), totals, accounts, plans: planList };
}

export type RevenueReport = Awaited<ReturnType<typeof revenueReport>>;

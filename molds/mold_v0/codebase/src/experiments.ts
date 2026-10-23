import { createHash } from "node:crypto";
import { getDb } from "./db.js";
import * as billing from "./billing.js";
import { wilson } from "./session-engine.js";
import { payingAt, subMonthly } from "./revenue.js";
import { spendRange, spendReport } from "./spend.js";
import { NS_KEYS, nsGet } from "./namespace.js";

/**
 * Pricing experiments (FinOps › Experiments, GET /api/admin/onboarding/spend/experiments): A/B tests between plans.
 * Stripe is the system of record for everything but who was shown what:
 *   - an experiment is a key on Stripe price metadata (NS_KEYS.experiment, src/namespace.ts); the live plans sharing it are its
 *     variants, each with a traffic weight (NS_KEYS.weight, default 1). Set on New plan or a plan's ⋯ › Experiment.
 *   - assignment: an account allowed plans sees every plan in no experiment, and one variant per experiment: the one it
 *     was first shown (sticky, while that plan is live), else a weighted pick from sha256(experiment:account id).
 *   - exposure: the first time an account's Billing page shows it a variant (plan_exposures, one row per account and
 *     experiment). The only thing kept here: Stripe has no record of a page view.
 *   - attribution: checkout puts NS_KEYS {slug, experiment, variant} on the session and the
 *     subscription (billing.checkoutUrl), so started checkouts and conversions are read back from Stripe.
 *
 * Per variant (UTC days of the range, as the other FinOps tabs; counts up to the range's end):
 *   exposed       accounts first shown it by the end of the range (new_in_range: first shown within it)
 *   checkouts     checkout sessions tagged with it created in the range (completed: of those, status complete)
 *   converted     accounts with a subscription tagged with it that ever paid or trialed (not incomplete) by the end
 *   conversion    converted / exposed, Wilson 95% interval; vs control (the variant created first) the difference in
 *                 points with a 95% normal interval, significant when it excludes 0
 *   paying, mrr   tagged subscriptions paying at the end of the range (out of trial), their monthly value
 *   trialing, churned   tagged subscriptions in trial at the end; ended by the end
 *   collected     paid invoices of tagged subscriptions in the range; per exposed account (the A/B revenue metric)
 *   model_spend   metered model spend (src/spend.ts) of the converted accounts in the range; margin = collected - spend
 */

const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const idOf = (x: string | { id: string } | null | undefined) => (x == null ? null : typeof x === "string" ? x : x.id);
const NEVER_PAID = new Set(["incomplete", "incomplete_expired"]);

/** The variant of `experiment` for an account: weighted by the plans' weights, stable for the account. */
export function pickVariant(orgId: number, experiment: string, variants: billing.Plan[]): billing.Plan | null {
  const vs = [...variants].sort((a, b) => a.price_id.localeCompare(b.price_id));
  if (!vs.length) return null;
  const total = sum(vs.map((v) => v.weight));
  const u = (parseInt(createHash("sha256").update(`${experiment}:${orgId}`).digest("hex").slice(0, 8), 16) / 0x1_0000_0000) * total;
  let acc = 0;
  for (const v of vs) { acc += v.weight; if (u < acc) return v; }
  return vs[vs.length - 1];
}

/**
 * The plans an account is offered: every plan in no experiment, plus its variant of each experiment (the one it was
 * shown first while that is still live). Records a first exposure for each experiment shown. Never throws on the log.
 */
export async function offeredPlans(orgId: number, plans: billing.Plan[]): Promise<billing.Plan[]> {
  const db = await getDb();
  const groups = new Map<string, billing.Plan[]>();
  for (const p of plans) if (p.experiment) groups.set(p.experiment, [...(groups.get(p.experiment) ?? []), p]);
  if (!groups.size) return plans;
  const seen = new Map((await db.query<{ experiment: string; price_id: string }>(
    "SELECT experiment, price_id FROM plan_exposures WHERE org_id = $1", [orgId])).map((r) => [r.experiment, r.price_id]));
  const chosen = new Map<string, billing.Plan>();
  for (const [exp, vs] of groups) {
    const v = vs.find((x) => x.price_id === seen.get(exp)) ?? pickVariant(orgId, exp, vs);
    if (v) chosen.set(exp, v);
  }
  const fresh = [...chosen].filter(([exp]) => !seen.has(exp));
  if (fresh.length) await db.query(
    `INSERT INTO plan_exposures (org_id, experiment, price_id, plan_name)
     SELECT $1, x.e, x.p, x.n FROM unnest($2::text[], $3::text[], $4::text[]) AS x(e, p, n) ON CONFLICT (org_id, experiment) DO NOTHING`,
    [orgId, fresh.map(([e]) => e), fresh.map(([, v]) => v.price_id), fresh.map(([, v]) => v.name)]).catch((e) => console.error("plan exposure:", (e as Error).message));
  return plans.filter((p) => !p.experiment || chosen.get(p.experiment)?.price_id === p.price_id);
}

/** What checkout tags a plan's session and subscription with (Stripe metadata). */
export const checkoutMeta = (slug: string, plan: billing.Plan): Record<string, string> =>
  ({ [NS_KEYS.slug]: slug, ...(plan.experiment ? { [NS_KEYS.experiment]: plan.experiment, [NS_KEYS.variant]: plan.price_id } : {}) });

const empty = (R: ReturnType<typeof spendRange>, configured: boolean, error: string | null) =>
  ({ range: { from: R.from, to: R.to, days: R.days }, stripe: { configured, error }, totals: null, experiments: [] as string[], variants: [] });

export async function experimentsReport(q: { from?: unknown; to?: unknown } = {}, now = Date.now()) {
  const R = spendRange(q, now);
  if (!billing.stripeEnabled()) return empty(R, false, null);
  let plans: billing.Plan[], subs: billing.Subscription[], sessions: billing.CheckoutSession[], invoices: billing.Invoice[];
  try {
    [plans, { raw: subs }, sessions, invoices] = await Promise.all([billing.listPlans(), billing.allSubscriptions(), billing.allCheckoutSessions(), billing.allInvoices()]);
  } catch (err) {
    console.error("finops experiments: stripe failed:", (err as Error).message);
    return empty(R, true, (err as Error).message);
  }
  const db = await getDb();
  const [exposures, orgs, spend] = await Promise.all([
    db.query<{ org_id: number; experiment: string; price_id: string; plan_name: string | null; first_seen_at: Date }>(
      "/* tenant: internal: admin FinOps, every account's plan exposures */ SELECT org_id, experiment, price_id, plan_name, first_seen_at FROM plan_exposures"),
    db.query<{ id: number; slug: string; stripe_customer_id: string | null }>("SELECT id, slug, stripe_customer_id FROM organizations"),
    spendReport(q, now),
  ]);
  const idx = new Map(R.days.map((d, i) => [d, i]));
  const endAt = Math.min(Date.parse(`${R.to}T00:00:00Z`) + DAY - 1, now);
  const inRange = (ms: number) => { const d = dayOf(ms); return d >= R.from && d <= R.to; };
  const slugOfCustomer = new Map(orgs.filter((o) => o.stripe_customer_id).map((o) => [o.stripe_customer_id!, o.slug]));
  // The app's own customers only (as FinOps Revenue): checkouts and subscriptions of a Stripe customer no account is
  // linked to (a deleted test customer) are left out.
  sessions = sessions.filter((x) => x.customer != null && slugOfCustomer.has(x.customer));
  subs = subs.filter((x) => slugOfCustomer.has(x.customer));
  invoices = invoices.filter((x) => slugOfCustomer.has(x.customer));
  const spendOf = new Map(spend.accounts.map((a) => [a.key, sum(a.daily_session) + sum(a.daily_orchestrator)]));

  interface V { experiment: string; price_id: string; name: string; amount: number | null; interval: string | null; weight: number; live: boolean; created: number | null;
    exposed: Set<number>; new_in_range: number; checkouts: number; completed: number; converted: Set<string>; subs: billing.Subscription[];
    daily_exposed: number[]; daily_converted: number[]; daily_collected: number[] }
  const vs = new Map<string, V>();
  const v = (experiment: string, price_id: string, name?: string | null) => {
    const k = `${experiment}\u0000${price_id}`;
    let x = vs.get(k);
    if (!x) {
      const p = plans.find((y) => y.price_id === price_id);
      x = { experiment, price_id, name: p?.name ?? name ?? price_id, amount: p?.amount ?? null, interval: p?.interval ?? null, weight: p?.experiment === experiment ? p.weight : 0,
            live: p?.experiment === experiment, created: p?.created ?? null, exposed: new Set(), new_in_range: 0, checkouts: 0, completed: 0, converted: new Set(), subs: [],
            daily_exposed: R.days.map(() => 0), daily_converted: R.days.map(() => 0), daily_collected: R.days.map(() => 0) };
      vs.set(k, x);
    }
    if (name && x.name === price_id) x.name = name;
    return x;
  };
  for (const p of plans) if (p.experiment) v(p.experiment, p.price_id);
  for (const e of exposures) {
    const t = new Date(e.first_seen_at).getTime();
    if (t > endAt) continue;
    const x = v(e.experiment, e.price_id, e.plan_name);
    x.exposed.add(Number(e.org_id));
    if (inRange(t)) { x.new_in_range++; x.daily_exposed[idx.get(dayOf(t))!]++; }
  }
  for (const s of sessions) {
    const m = s.metadata ?? {};
    if (!nsGet(m, "experiment") || !nsGet(m, "variant") || !inRange(s.created * 1000)) continue;
    const x = v(nsGet(m, "experiment"), nsGet(m, "variant"));
    x.checkouts++; if (s.status === "complete") x.completed++;
  }
  const subVariant = new Map<string, V>();
  for (const s of subs) {
    const m = s.metadata ?? {};
    if (!nsGet(m, "experiment") || !nsGet(m, "variant") || NEVER_PAID.has(s.status)) continue;
    const start = (s.start_date ?? s.created ?? 0) * 1000;
    if (start > endAt) continue;
    const price = s.items.data[0]?.price;
    const x = v(nsGet(m, "experiment"), nsGet(m, "variant"), price?.nickname ?? null);
    x.subs.push(s); subVariant.set(s.id, x);
    if (!x.converted.has(s.customer)) { x.converted.add(s.customer); if (inRange(start)) x.daily_converted[idx.get(dayOf(start))!]++; }
  }
  for (const inv of invoices) {
    const x = subVariant.get(idOf(inv.subscription) ?? idOf(inv.parent?.subscription_details?.subscription) ?? "");
    const paid = inv.status_transitions?.paid_at ?? (inv.status === "paid" ? inv.created : null);
    if (!x || paid == null || inv.amount_paid <= 0 || !inRange(paid * 1000)) continue;
    x.daily_collected[idx.get(dayOf(paid * 1000))!] += inv.amount_paid / 100;
  }

  const rate = (k: number, n: number) => (n ? k / n : null);
  const variants = [...vs.values()].map((x) => {
    const exposed = x.exposed.size, converted = x.converted.size;
    const paying = x.subs.filter((s) => payingAt(s, endAt));
    const trialing = x.subs.filter((s) => s.trial_end != null && s.trial_end * 1000 > endAt && !(s.ended_at && s.ended_at * 1000 <= endAt)).length;
    const churned = x.subs.filter((s) => (s.ended_at ?? (s.status === "canceled" ? s.canceled_at : null) ?? Infinity) * 1000 <= endAt).length;
    const collected = r2(sum(x.daily_collected));
    const spent = r2(sum([...x.converted].map((c) => spendOf.get(slugOfCustomer.get(c) ?? nsGet(x.subs.find((s) => s.customer === c)?.metadata, "slug") ?? "") ?? 0)));
    const ci = wilson(converted, exposed);
    return { experiment: x.experiment, price_id: x.price_id, name: x.name, amount_usd: x.amount == null ? null : x.amount / 100, interval: x.interval, weight: x.weight, live: x.live,
      created: x.created, exposed, new_in_range: x.new_in_range, checkouts: x.checkouts, completed: x.completed, converted,
      conversion_pct: exposed ? r1((converted / exposed) * 100) : null, ci: ci ? [r1(ci[0] * 100), r1(ci[1] * 100)] as [number, number] : null,
      paying: paying.length, trialing, churned, mrr_usd: r2(sum(paying.map(subMonthly))), collected_usd: collected,
      collected_per_exposed_usd: exposed ? r2(collected / exposed) : null, model_spend_usd: spent, margin_usd: r2(collected - spent),
      daily_exposed: x.daily_exposed, daily_converted: x.daily_converted, daily_collected: x.daily_collected.map(r2),
      control: false, lift_pts: null as number | null, lift_ci: null as [number, number] | null, significant: false };
  });
  // Control: the variant created first (Stripe's created time; then price id). Lift: conversion difference, in points.
  for (const exp of new Set(variants.map((x) => x.experiment))) {
    const group = variants.filter((x) => x.experiment === exp).sort((a, b) => (a.created ?? Infinity) - (b.created ?? Infinity) || a.price_id.localeCompare(b.price_id));
    const c = group[0]; c.control = true;
    const pc = rate(c.converted, c.exposed);
    for (const x of group.slice(1)) {
      const px = rate(x.converted, x.exposed);
      if (pc == null || px == null) continue;
      const se = Math.sqrt((pc * (1 - pc)) / c.exposed + (px * (1 - px)) / x.exposed);
      const d = px - pc;
      x.lift_pts = r1(d * 100);
      x.lift_ci = [r1((d - 1.96 * se) * 100), r1((d + 1.96 * se) * 100)];
      x.significant = se > 0 && (d - 1.96 * se > 0 || d + 1.96 * se < 0);
    }
  }
  variants.sort((a, b) => a.experiment.localeCompare(b.experiment) || Number(b.control) - Number(a.control) || (a.created ?? 0) - (b.created ?? 0));
  const experiments = [...new Set(variants.map((x) => x.experiment))];
  const running = experiments.filter((e) => variants.filter((x) => x.experiment === e && x.live).length >= 2);
  const daily = (k: "daily_exposed" | "daily_converted" | "daily_collected") => R.days.map((_, i) => r2(sum(variants.map((x) => x[k][i]))));
  return {
    range: { from: R.from, to: R.to, days: R.days }, stripe: { configured: true, error: null as string | null },
    totals: { running: running.length, experiments: experiments.length, accounts: new Set(exposures.map((e) => Number(e.org_id))).size,
      checkouts: sum(variants.map((x) => x.checkouts)), converted: sum(variants.map((x) => x.converted)), collected_usd: r2(sum(variants.map((x) => x.collected_usd))),
      daily_exposed: daily("daily_exposed"), daily_converted: daily("daily_converted"), daily_collected: daily("daily_collected") },
    experiments, running, variants,
  };
}
export type ExperimentsReport = Awaited<ReturnType<typeof experimentsReport>>;

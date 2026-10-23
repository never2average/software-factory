/**
 * Stripe is the system of record for money: customers, plans, recurring subscriptions, invoices and card details.
 * The app keeps only organizations.stripe_customer_id (also recorded in the Clerk organization's public_metadata, so
 * Clerk and Stripe can be joined either way). Customers self-serve through Stripe Checkout and the Stripe customer
 * portal; nothing about a plan is stored here.
 * Plain REST over fetch. Unset STRIPE_SECRET_KEY = billing is off.
 *
 * Plans are prepaid and invite-only: inference is expensive, so an account may subscribe only when an admin allows it
 * (organizations.prepaid_allowed), a plan is a fixed monthly price with a hard spend cap (no overage), and an account
 * with neither a live plan nor an admin-set allowance (organizations.budget_override_usd) gets $0: it cannot start runs.
 *
 *   STRIPE_SECRET_KEY            sk_test_... / rk_... (customers, checkout, billing portal, subscriptions, prices, meter events)
 *   Plans                        active Stripe prices whose lookup_key starts with KEY_PREFIX (src/namespace.ts: the build's namespace and _). A price's (or its
 *                                product's) metadata.monthly_budget_usd sets that plan's monthly model-spend cap.
 *   STRIPE_SPEND_METER           optional meter event name: each finished agent session reports its model cost in cents,
 *                                for usage-based prices (deduplicated by session id).
 *   APP_REQUIRE_SUBSCRIPTION=1  refuse new simulations for orgs without an active or trialing subscription.
 */
import { createHash } from "node:crypto";
import { getDb } from "./db.js";
import { sessionEngine } from "./host-tables.js";
import { componentJson, componentSummary, configJson, DEFAULT_TAX_CODE, METRIC_IDS, METRICS, meterFor, stripeTiers, usageFromTiers, usageLookup,
  type Metric, type PlanConfig, type UsageComponent } from "./plan-config.js";
import { ENV } from "./env-names.js";
import { isNsKey, isPlanKey, KEY_PREFIX, NS, NS_KEYS, nsGet } from "./namespace.js";
import { PROFILE } from "./profile.js";

export const stripeEnabled = () => Boolean(process.env.STRIPE_SECRET_KEY);
const apiBase = () => (process.env.STRIPE_API_URL ?? "https://api.stripe.com").replace(/\/$/, "");

export class StripeError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

/** Stripe's form encoding: nested objects and arrays as a[b][0]=c. */
function form(body: Record<string, unknown>, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function call<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  if (!stripeEnabled()) throw new StripeError("Stripe is not configured (STRIPE_SECRET_KEY)", 503);
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
               ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
    body: body ? form(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new StripeError(`Stripe ${method} ${path.split("?")[0]}: ${json.error?.message ?? res.status}`, res.status >= 500 ? 502 : res.status);
  return json as T;
}

async function all<T extends { id: string }>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let after: string | undefined; ;) {
    const page = await call<{ data: T[]; has_more: boolean }>("GET", `${path}${path.includes("?") ? "&" : "?"}limit=100${after ? `&starting_after=${after}` : ""}`);
    out.push(...page.data);
    if (!page.has_more || !page.data.length || out.length >= 5000) return out;
    after = page.data[page.data.length - 1].id;
  }
}

/**
 * A plan: a live Stripe price with a lookup key that starts with KEY_PREFIX. A pricing experiment is Stripe price metadata
 * too: NS_KEYS.experiment (its key; the plans sharing it are its variants) and NS_KEYS.weight (the variant's share of
 * accounts, relative to the others; default 1). NS_KEYS.trial_days gives checkout a free trial.
 */
export interface Plan { price_id: string; lookup_key: string; name: string; amount: number | null; currency: string; interval: string | null; monthly_budget_usd: number | null;
  experiment: string | null; weight: number; trial_days: number | null; description: string | null; created: number | null;
  /** Usage pricing: one metered price per metric (src/plan-config.ts METRICS), each on its billing meter, graduated. */
  usage: PlanUsage[];
  /** The plan as a JSON config (src/plan-config.ts): New plan › JSON takes it back. */
  config: Record<string, unknown> }
export interface Subscription { id: string; customer: string; status: string; metadata?: Record<string, string>; current_period_end: number | null; cancel_at_period_end: boolean; trial_end: number | null;
  start_date?: number | null; created?: number | null; ended_at?: number | null; canceled_at?: number | null; cancel_at?: number | null;
  items: { data: { quantity?: number | null; current_period_end?: number;
    price: { id: string; lookup_key: string | null; nickname?: string | null; unit_amount?: number | null; currency?: string;
             recurring?: { interval: string; interval_count?: number | null } | null; metadata?: Record<string, string>;
             product?: string | { name?: string; metadata?: Record<string, string> } } }[] } }

interface StripePrice { id: string; lookup_key: string | null; unit_amount: number | null; unit_amount_decimal?: string | null; currency: string; created?: number;
  recurring: { interval: string; usage_type?: string; meter?: string | null } | null; tiers?: { up_to: number | null; unit_amount?: number | null; unit_amount_decimal?: string | null }[];
  nickname: string | null; metadata: Record<string, string>; product: { name: string; description?: string | null; tax_code?: string | { id: string } | null; metadata: Record<string, string> } }
/** A plan's usage component: its metered price, metric and meter, in words, and as config JSON. */
export interface PlanUsage { price_id: string; metric: Metric; meter: string; summary: string; config: Record<string, unknown> }
/** Lookup keys of usage prices end in __<suffix> (plan-config.ts usageLookup); a plan's own price never has "__". */
const isUsageLookup = (k: string) => k.includes("__");

export interface Meter { id: string; event_name: string; status?: string }
let metersCache: { at: number; meters: Meter[] } | null = null;
/** The account's billing meters (cached 5 minutes): usage prices name one. */
export async function listMeters(fresh = false): Promise<Meter[]> {
  if (!fresh && metersCache && Date.now() - metersCache.at < 5 * 60_000) return metersCache.meters;
  const meters = await all<Meter>("/v1/billing/meters");
  metersCache = { at: Date.now(), meters };
  return meters;
}

const weightOf = (v: unknown) => (Number(v) > 0 ? Number(v) : 1);
/** An experiment key: lower-case letters, digits, - and _ (it is Stripe metadata and goes in URLs). */
export const experimentKey = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const budgetOf = (meta?: Record<string, string>) => (meta?.monthly_budget_usd != null && meta.monthly_budget_usd !== "" ? Number(meta.monthly_budget_usd) : null);

let plansCache: { at: number; plans: Plan[] } | null = null;
export async function listPlans(): Promise<Plan[]> {
  if (plansCache && Date.now() - plansCache.at < 5 * 60_000) return plansCache.plans;
  const [prices, meters] = await Promise.all([all<StripePrice>("/v1/prices?active=true&expand[]=data.product&expand[]=data.tiers"), listMeters().catch(() => [] as Meter[])]);
  const ours = prices.filter((p) => isPlanKey(p.lookup_key));
  const byLookup = new Map(ours.map((p) => [p.lookup_key!, p]));
  const meterName = (id?: string | null) => meters.find((m) => m.id === id)?.event_name ?? id ?? "";
  const component = (up: StripePrice, metric: Metric): { u: UsageComponent; usage: PlanUsage } => {
    const u = usageFromTiers(metric, meterName(up.recurring?.meter), up.tiers ?? [{ up_to: null, unit_amount_decimal: up.unit_amount_decimal ?? String(up.unit_amount ?? 0) }]);
    return { u, usage: { price_id: up.id, metric, meter: u.meter, summary: componentSummary(u), config: componentJson(u) } };
  };
  const plans = ours.filter((p) => !isUsageLookup(p.lookup_key!)).map((p) => {
    const metered = p.recurring?.usage_type === "metered";
    // A usage-only plan's own price is its first component (NS_KEYS.metric says which); the rest are <plan>__<metric>.
    const own = metered ? [component(p, (nsGet(p.metadata, "metric") as Metric) || "model_spend")] : [];
    const rest = METRIC_IDS.filter((m) => !own.some((x) => x.u.metric === m)).flatMap((m) => { const up = byLookup.get(usageLookup(p.lookup_key!, m)); return up ? [component(up, m)] : []; });
    const comps = [...own, ...rest].sort((a, b) => METRIC_IDS.indexOf(a.u.metric) - METRIC_IDS.indexOf(b.u.metric));
    const extra = Object.fromEntries(Object.entries(p.product?.metadata ?? {}).filter(([k]) => !isNsKey(k) && k !== "monthly_budget_usd"));
    const plan = {
      price_id: p.id, lookup_key: p.lookup_key!, name: p.nickname || p.product?.name || p.lookup_key!, amount: metered ? null : p.unit_amount, currency: p.currency,
      interval: p.recurring?.interval ?? null, monthly_budget_usd: budgetOf(p.metadata) ?? budgetOf(p.product?.metadata),
      experiment: nsGet(p.metadata, "experiment") || null, weight: weightOf(nsGet(p.metadata, "weight")),
      trial_days: Number(nsGet(p.metadata, "trial_days")) > 0 ? Number(nsGet(p.metadata, "trial_days")) : null,
      description: p.product?.description || null, created: p.created ?? null, usage: comps.map((x) => x.usage),
    };
    return { ...plan, config: configJson({ name: plan.name, description: plan.description, interval: (plan.interval === "year" ? "year" : "month"), lookup_key: plan.lookup_key,
      base_fee_usd: metered ? 0 : (p.unit_amount ?? 0) / 100, trial_days: plan.trial_days, monthly_budget_usd: plan.monthly_budget_usd ?? 0,
      usage: comps.map((x) => x.u), experiment: plan.experiment, weight: plan.weight, metadata: extra,
      tax_code: (typeof p.product?.tax_code === "string" ? p.product.tax_code : p.product?.tax_code?.id) ?? DEFAULT_TAX_CODE }) };
  });
  plansCache = { at: Date.now(), plans };
  return plans;
}

export const invalidatePlans = () => { plansCache = null; };

/** A plan's lookup key from its name: KEY_PREFIX plus the name in lower case, words joined by underscores. */
export const planLookupKey = (name: string) =>
  `${KEY_PREFIX}${name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "plan"}`;

/** The meter body for a metric: the sum of `value` per stripe_customer_id, as the report* functions send it. */
const meterBody = (m: Metric, event: string) => ({ display_name: `${PROFILE.name} ${METRICS[m].label.toLowerCase()} (${METRICS[m].unit}s)`, event_name: event,
  default_aggregation: { formula: "sum" }, customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" }, value_settings: { event_payload_key: "value" } });

/** One line per Stripe object a plan config makes: the dry run's preview. */
function describe(o: { create: string; body: Record<string, any> }, c: PlanConfig): string {
  const b = o.body;
  if (o.create === "billing.meter") return `Billing meter "${b.event_name}": the sum of each customer's reported ${METRICS[(Object.keys(METRICS) as Metric[]).find((m) => meterFor(m) === b.event_name) ?? "model_spend"].unit}s`;
  if (o.create === "product") return `Product "${b.name}"${b.description ? `: ${b.description}` : ""} (tax code ${b.tax_code})`;
  if (b.recurring?.usage_type === "metered") {
    const comp = c.usage.find((u) => u.metric === nsGet(b.metadata, "metric"))!;
    return `Usage price ${b.lookup_key}, graduated, billed each ${b.recurring.interval}: ${componentSummary(comp)}`;
  }
  return `Base price ${b.lookup_key}: $${(b.unit_amount / 100).toLocaleString("en-US")} / ${b.recurring?.interval}`;
}

/**
 * A plan from a JSON config (src/plan-config.ts, already checked): a product, a licensed price for the base fee (if
 * any) and one graduated metered price per usage component, each on its metric's billing meter (made when the account
 * has none with that event name). The plan's own price (the base fee, else the first component) carries the lookup
 * key, allowance, experiment and trial; the other components are <lookup_key>__<metric> with NS_KEYS.plan. `dryRun`
 * returns what would be made, a line per object, and sends nothing that writes.
 */
export async function createPlanFromConfig(c: PlanConfig, dryRun = false) {
  const hasBase = c.base_fee_usd > 0;
  const lookupOf = (u: UsageComponent, i: number) => (!hasBase && i === 0 ? c.lookup_key : usageLookup(c.lookup_key, u.metric));
  const lookups = [c.lookup_key, ...c.usage.map(lookupOf).filter((k) => k !== c.lookup_key)];
  const existing = await call<{ data: { id: string; active: boolean; lookup_key: string }[] }>("GET", `/v1/prices?${lookups.map((k) => `lookup_keys[]=${encodeURIComponent(k)}`).join("&")}&limit=10`);
  const taken = existing.data.find((x) => x.active) ?? existing.data[0];
  if (taken) throw new StripeError(taken.active ? `A plan with the lookup key ${taken.lookup_key} already exists. Pick another name or lookup_key.`
    : `An archived plan still holds the lookup key ${taken.lookup_key}. Pick another name or lookup_key.`, 409);
  const meters = c.usage.length ? await listMeters(true) : [];
  const found = new Map(c.usage.map((u) => [u.meter, meters.find((m) => m.event_name === u.meter && m.status !== "inactive") ?? null]));
  const planMeta: Record<string, string> = { monthly_budget_usd: String(c.monthly_budget_usd), ...(c.experiment ? { [NS_KEYS.experiment]: c.experiment, [NS_KEYS.weight]: String(c.weight) } : {}),
    ...(c.trial_days ? { [NS_KEYS.trial_days]: String(c.trial_days) } : {}) };
  const usagePrice = (u: UsageComponent, i: number, meterId: string, product: string) => {
    const primary = !hasBase && i === 0;
    return { product, currency: "usd", nickname: primary ? c.name : `${c.name} · ${METRICS[u.metric].label}`, lookup_key: lookupOf(u, i),
      recurring: { interval: c.interval, usage_type: "metered", meter: meterId }, billing_scheme: "tiered", tiers_mode: "graduated", tiers: stripeTiers(u),
      metadata: primary ? { ...planMeta, [NS_KEYS.role]: "usage", [NS_KEYS.metric]: u.metric } : { [NS_KEYS.role]: "usage", [NS_KEYS.metric]: u.metric, [NS_KEYS.plan]: c.lookup_key } };
  };
  const basePrice = (product: string) => ({ product, currency: "usd", unit_amount: Math.round(c.base_fee_usd * 100), recurring: { interval: c.interval },
    nickname: c.name, lookup_key: c.lookup_key, metadata: planMeta });
  const productBody = { name: c.name, description: c.description ?? undefined, tax_code: c.tax_code, metadata: { ...c.metadata, monthly_budget_usd: String(c.monthly_budget_usd), [NS]: "plan" } };
  const newMeters = c.usage.filter((u, i, all) => !found.get(u.meter) && all.findIndex((x) => x.meter === u.meter) === i);
  const plan = [
    ...newMeters.map((u) => ({ create: "billing.meter", body: meterBody(u.metric, u.meter) })),
    { create: "product", body: productBody as Record<string, any> },
    ...(hasBase ? [{ create: "price", body: basePrice("<product>") as Record<string, any> }] : []),
    ...c.usage.map((u, i) => ({ create: "price", body: usagePrice(u, i, found.get(u.meter)?.id ?? `<meter ${u.meter}>`, "<product>") as Record<string, any> })),
  ];
  if (dryRun) return { dry_run: true as const, config: configJson(c), stripe: plan, lines: plan.map((o) => describe(o, c)),
    meters: c.usage.map((u) => ({ metric: u.metric, event_name: u.meter, exists: Boolean(found.get(u.meter)) })) };
  const idem = `plancfg-${c.lookup_key}-${createHash("sha256").update(JSON.stringify(c)).digest("hex").slice(0, 16)}`;
  const meterIds = new Map([...found].filter(([, m]) => m).map(([k, m]) => [k, m!.id]));
  for (const u of newMeters) meterIds.set(u.meter, (await call<{ id: string }>("POST", "/v1/billing/meters", meterBody(u.metric, u.meter), `${idem}-meter-${u.metric}`)).id);
  if (newMeters.length) metersCache = null;
  const product = await call<{ id: string }>("POST", "/v1/products", productBody, `${idem}-product`);
  const base = hasBase ? await call<{ id: string }>("POST", "/v1/prices", basePrice(product.id), `${idem}-base`) : null;
  const usage: { metric: Metric; price_id: string }[] = [];
  for (const [i, u] of c.usage.entries()) usage.push({ metric: u.metric, price_id: (await call<{ id: string }>("POST", "/v1/prices", usagePrice(u, i, meterIds.get(u.meter)!, product.id), `${idem}-usage-${u.metric}`)).id });
  invalidatePlans();
  return { dry_run: false as const, price_id: base?.id ?? usage[0].price_id, usage_price_ids: usage.map((x) => x.price_id), usage, lookup_key: c.lookup_key,
           name: c.name, experiment: c.experiment, config: configJson(c) };
}

/** Put a plan in a pricing experiment (or take it out: experiment null), with its traffic weight. Stripe price metadata. */
export async function setPlanExperiment(priceId: string, experiment: string | null, weight = 1): Promise<{ price_id: string; experiment: string | null; weight: number }> {
  if (!/^price_[A-Za-z0-9_]+$/.test(priceId)) throw new StripeError("Unknown plan", 404);
  const price = await call<{ id: string; lookup_key: string | null }>("GET", `/v1/prices/${priceId}`);
  if (!isPlanKey(price.lookup_key)) throw new StripeError(`That price is not one of ${PROFILE.name}'s plans`, 400);
  const key = experiment ? experimentKey(experiment) || null : null, w = weight > 0 ? weight : 1;
  await call("POST", `/v1/prices/${priceId}`, { metadata: { [NS_KEYS.experiment]: key ?? "", [NS_KEYS.weight]: key ? String(w) : "" } });
  invalidatePlans();
  return { price_id: priceId, experiment: key, weight: key ? w : 1 };
}

/** Archive a plan (price active=false): it leaves listPlans and checkout; Stripe keeps it and any subscription on it. Never deleted. */
export async function archivePlan(priceId: string): Promise<{ price_id: string; lookup_key: string | null }> {
  if (!/^price_[A-Za-z0-9_]+$/.test(priceId)) throw new StripeError("Unknown plan", 404);
  const price = await call<{ id: string; lookup_key: string | null; active: boolean }>("GET", `/v1/prices/${priceId}`);
  if (!isPlanKey(price.lookup_key)) throw new StripeError(`That price is not one of ${PROFILE.name}'s plans`, 400);
  if (price.active) await call("POST", `/v1/prices/${priceId}`, { active: false }, `plan-archive-${priceId}`);
  // Its usage prices go with it.
  const usage = await call<{ data: { id: string; active: boolean }[] }>("GET", `/v1/prices?${METRIC_IDS.map((m) => `lookup_keys[]=${encodeURIComponent(usageLookup(price.lookup_key!, m))}`).join("&")}&limit=10`);
  for (const u of usage.data) if (u.active) await call("POST", `/v1/prices/${u.id}`, { active: false }, `plan-archive-${u.id}`);
  invalidatePlans();
  return { price_id: price.id, lookup_key: price.lookup_key };
}

export const createCustomer = (o: { name: string; email?: string | null; slug: string; clerkOrgId?: string | null }) =>
  call<{ id: string }>("POST", "/v1/customers", { name: o.name, email: o.email ?? undefined,
    metadata: { [NS_KEYS.slug]: o.slug, clerk_organization_id: o.clerkOrgId ?? undefined } }, `customer-${o.slug}`);

/** The subscription that decides the org's plan: active/trialing/past_due first, then the most recent. */
function current(subs: Subscription[]) {
  const rank = (s: Subscription) => (["active", "trialing"].includes(s.status) ? 0 : s.status === "past_due" ? 1 : 2);
  return [...subs].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}
const shapeSub = (s: Subscription | null, plans: Plan[]) => {
  if (!s) return null;
  const price = s.items.data[0]?.price;
  const plan = plans.find((p) => p.price_id === price?.id);
  const productMeta = typeof price?.product === "object" ? price.product.metadata : undefined;
  const end = s.current_period_end ?? s.items.data[0]?.current_period_end ?? null;
  return { id: s.id, status: s.status, plan: plan?.name ?? price?.lookup_key ?? price?.id ?? null, price_id: price?.id ?? null,
           monthly_budget_usd: plan?.monthly_budget_usd ?? budgetOf(price?.metadata) ?? budgetOf(productMeta),
           renews_at: end ? new Date(end * 1000).toISOString() : null, cancel_at_period_end: s.cancel_at_period_end,
           trial_end: s.trial_end ? new Date(s.trial_end * 1000).toISOString() : null };
};
export type SubscriptionSummary = NonNullable<ReturnType<typeof shapeSub>>;

/** When a subscription was paid for (ms): from its start, or the end of its trial, to when it ended (null: still on). */
export interface PaidSpan { customer: string; from: number; to: number | null }
let subsCache: { at: number; byCustomer: Map<string, SubscriptionSummary>; spans: PaidSpan[]; raw: Subscription[] } | null = null;
/** Every customer's current subscription in one paged list call, cached for a minute. */
export async function subscriptionsByCustomer(fresh = false): Promise<Map<string, SubscriptionSummary>> {
  if (!fresh && subsCache && Date.now() - subsCache.at < 60_000) return subsCache.byCustomer;
  // Stripe expands at most 4 levels (data.items.data.price.product is 5): products come from their own list instead.
  const [subs, plans, products] = await Promise.all([all<Subscription>("/v1/subscriptions?status=all"), listPlans(), all<{ id: string; name?: string; metadata?: Record<string, string> }>("/v1/products")]);
  const productById = new Map(products.map((p) => [p.id, p]));
  for (const s of subs) for (const it of s.items.data) if (typeof it.price.product === "string") it.price.product = productById.get(it.price.product) ?? it.price.product;
  const grouped = new Map<string, Subscription[]>();
  for (const s of subs) grouped.set(s.customer, [...(grouped.get(s.customer) ?? []), s]);
  const byCustomer = new Map([...grouped].map(([c, list]) => [c, shapeSub(current(list), plans)!]));
  const spans = subs.filter((s) => !["incomplete", "incomplete_expired"].includes(s.status) && (s.start_date ?? s.created) != null).map((s) => ({
    customer: s.customer, from: Math.max(s.start_date ?? s.created ?? 0, s.trial_end ?? 0) * 1000, to: s.ended_at ? s.ended_at * 1000 : null }));
  subsCache = { at: Date.now(), byCustomer, spans, raw: subs };
  return byCustomer;
}
/** Every subscription as Stripe lists it (every status), with each customer's current one: the same cached list call (FinOps Revenue). */
export async function allSubscriptions(fresh = false): Promise<{ raw: Subscription[]; byCustomer: Map<string, SubscriptionSummary> }> {
  const byCustomer = await subscriptionsByCustomer(fresh);
  return { raw: subsCache?.raw ?? [], byCustomer };
}
/** Every subscription's paid span, from the same cached list call (the Onboarding page's Paying sparkline). */
export async function paidSpans(): Promise<PaidSpan[]> {
  if (!stripeEnabled()) return [];
  await subscriptionsByCustomer();
  return subsCache?.spans ?? [];
}
export const invalidateSubscriptions = () => { subsCache = null; invoicesCache = null; };

export interface Invoice { id: string; number: string | null; customer: string; customer_name?: string | null; customer_email?: string | null; status: string;
  amount_paid: number; amount_due: number; total: number; currency: string; created: number; hosted_invoice_url: string | null;
  status_transitions?: { paid_at?: number | null } | null; subscription?: string | { id: string } | null;
  parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null }
let invoicesCache: { at: number; invoices: Invoice[] } | null = null;
/** Every invoice on the Stripe account (paged list call, at most 5,000), cached for a minute (FinOps Revenue). */
export async function allInvoices(fresh = false): Promise<Invoice[]> {
  if (!fresh && invoicesCache && Date.now() - invoicesCache.at < 60_000) return invoicesCache.invoices;
  const invoices = await all<Invoice>("/v1/invoices");
  invoicesCache = { at: Date.now(), invoices };
  return invoices;
}

/**
 * A hosted checkout for one plan. `meta` (the account's slug, and the experiment and variant when the plan is in one)
 * goes on the session and on the subscription it makes, so Stripe itself records which variant converted. A plan
 * with NS_KEYS.trial_days starts with that free trial.
 */
export async function checkoutUrl(customer: string, priceId: string, returnUrl: string, meta: Record<string, string> = {}, trialDays?: number | null, usagePriceIds: string[] = []) {
  // A metered price takes no quantity; a usage-only plan's own price is its first usage price.
  const items = [...(usagePriceIds.includes(priceId) ? [] : [{ price: priceId, quantity: 1 }]), ...usagePriceIds.map((price) => ({ price }))];
  const body = { mode: "subscription", customer, line_items: items, success_url: returnUrl, cancel_url: returnUrl, allow_promotion_codes: true, metadata: meta,
    subscription_data: { metadata: meta, ...(trialDays ? { trial_period_days: trialDays } : {}) } };
  let s: { url: string };
  try { s = await call<{ url: string }>("POST", "/v1/checkout/sessions", body); }
  catch (e) {
    // Stripe Tax / Managed Payments refuse a product with no tax code (plans made before plans carried one): set the
    // default on the plan's products once, then try again.
    if (!(e instanceof StripeError) || !/tax code is missing/i.test(e.message)) throw e;
    for (const it of items) {
      const price = await call<{ product: string }>("GET", `/v1/prices/${it.price}`);
      await call("POST", `/v1/products/${price.product}`, { tax_code: DEFAULT_TAX_CODE }, `tax-code-${price.product}`);
    }
    invalidatePlans();
    s = await call<{ url: string }>("POST", "/v1/checkout/sessions", body);
  }
  invalidateCheckouts();
  return s.url;
}

export interface CheckoutSession { id: string; created: number; status: string | null; customer: string | null; subscription?: string | { id: string } | null; metadata?: Record<string, string> }
let checkoutsCache: { at: number; sessions: CheckoutSession[] } | null = null;
/** Every checkout session (paged, at most 5,000), cached a minute: the started side of a pricing experiment. */
export async function allCheckoutSessions(fresh = false): Promise<CheckoutSession[]> {
  if (!fresh && checkoutsCache && Date.now() - checkoutsCache.at < 60_000) return checkoutsCache.sessions;
  const sessions = await all<CheckoutSession>("/v1/checkout/sessions");
  checkoutsCache = { at: Date.now(), sessions };
  return sessions;
}
export const invalidateCheckouts = () => { checkoutsCache = null; };

/** Stripe's hosted portal: change plan, card, billing email; download invoices; cancel. */
export async function portalUrl(customer: string, returnUrl: string) {
  return (await call<{ url: string }>("POST", "/v1/billing_portal/sessions", { customer, return_url: returnUrl })).url;
}

export async function recentInvoices(customer: string) {
  const r = await call<{ data: { id: string; number: string | null; status: string; total: number; currency: string; created: number; hosted_invoice_url: string | null }[] }>(
    "GET", `/v1/invoices?customer=${encodeURIComponent(customer)}&limit=6`);
  return r.data.map((i) => ({ id: i.id, number: i.number, status: i.status, total: i.total, currency: i.currency,
                              created: new Date(i.created * 1000).toISOString(), url: i.hosted_invoice_url }));
}

// ---------- what the org may spend ----------

export type BudgetSource = "override" | "plan" | "default";

/**
 * The org's monthly model-spend allowance (a hard cap): an admin-set allowance first (your own account, trials, comps),
 * else its live Stripe plan's monthly_budget_usd, else APP_ORG_MONTHLY_BUDGET_USD (default 0). 0 = no runs.
 */
export async function orgBudget(orgId: number): Promise<{ budget: number; subscription: SubscriptionSummary | null; source: BudgetSource }> {
  const fallback = Number(ENV.APP_ORG_MONTHLY_BUDGET_USD ?? 0);
  const [o] = await (await getDb()).query<{ stripe_customer_id: string | null; budget_override_usd: string | number | null }>(
    "SELECT stripe_customer_id, budget_override_usd FROM organizations WHERE id = $1", [orgId]);
  if (o?.budget_override_usd != null) return { budget: Number(o.budget_override_usd), subscription: null, source: "override" };
  if (!stripeEnabled()) return { budget: fallback, subscription: null, source: "default" };
  let sub: SubscriptionSummary | null = null;
  if (o?.stripe_customer_id) {
    try { sub = (await subscriptionsByCustomer()).get(o.stripe_customer_id) ?? null; }
    catch (err) { console.error("stripe subscription lookup failed:", (err as Error).message); return { budget: fallback, subscription: null, source: "default" }; }
  }
  const live = sub && ["active", "trialing"].includes(sub.status);
  if (ENV.APP_REQUIRE_SUBSCRIPTION === "1" && !live)
    throw new Error(`This organization has no active ${PROFILE.name} plan. Ask your admin to subscribe, then try again; existing results stay available.`);
  return live && sub!.monthly_budget_usd != null ? { budget: sub!.monthly_budget_usd, subscription: sub, source: "plan" } : { budget: fallback, subscription: sub, source: "default" };
}

/**
 * orgBudget for many orgs at once (the admin Spend page): one query and one subscription listing, the same order of
 * rules. For display only: it never throws (a Stripe outage or APP_REQUIRE_SUBSCRIPTION gives the fallback).
 */
export async function orgBudgets(orgIds: number[]): Promise<Map<number, { budget: number; plan: string | null; source: BudgetSource }>> {
  const fallback = Number(ENV.APP_ORG_MONTHLY_BUDGET_USD ?? 0);
  const out = new Map<number, { budget: number; plan: string | null; source: BudgetSource }>();
  if (!orgIds.length) return out;
  const rows = await (await getDb()).query<{ id: number; stripe_customer_id: string | null; budget_override_usd: string | number | null }>(
    "SELECT id, stripe_customer_id, budget_override_usd FROM organizations WHERE id = ANY($1)", [orgIds]);
  let subs = new Map<string, SubscriptionSummary>();
  if (stripeEnabled() && rows.some((o) => o.budget_override_usd == null && o.stripe_customer_id)) {
    try { subs = await subscriptionsByCustomer(); }
    catch (err) { console.error("stripe subscription lookup failed:", (err as Error).message); }
  }
  for (const o of rows) {
    const sub = o.stripe_customer_id ? subs.get(o.stripe_customer_id) ?? null : null;
    const live = sub && ["active", "trialing"].includes(sub.status);
    out.set(Number(o.id), o.budget_override_usd != null ? { budget: Number(o.budget_override_usd), plan: sub?.plan ?? null, source: "override" }
      : live && sub!.monthly_budget_usd != null ? { budget: sub!.monthly_budget_usd, plan: sub!.plan, source: "plan" }
      : { budget: fallback, plan: sub?.plan ?? null, source: "default" });
  }
  return out;
}

/**
 * Send one usage event to a metric's meter, once it exists in Stripe (a usage plan makes it; for model spend,
 * STRIPE_SPEND_METER also turns it on). `identifier` makes a retry count once (Stripe dedupes by it).
 */
async function reportUsage(metric: Metric, identifier: string, customer: string, value: number) {
  const event = meterFor(metric);
  if (!(metric === "model_spend" && process.env.STRIPE_SPEND_METER) && !(await listMeters()).some((m) => m.event_name === event && m.status !== "inactive")) return;
  await call("POST", "/v1/billing/meter_events", { event_name: event, identifier, payload: { stripe_customer_id: customer, value } });
}

/**
 * A finished session's usage, to the meters usage plans bill on: its model cost in cents (model_spend; identifier the
 * session id, as before), 1 agent session if it completed (agent_sessions), and its sandbox minutes from start to end,
 * rounded up (sandbox_hours). Only for an account with a Stripe customer. Best effort, never throws.
 */
export function reportSessionSpend(sessionId: string): void {
  if (!stripeEnabled() || !sessionEngine()) return;
  void (async () => {
    const [r] = await (await getDb()).query<{ stripe_customer_id: string | null; cost_usd: number | null; status: string; minutes: number | null }>(
      `SELECT o.stripe_customer_id, s.cost_usd, s.status, ceil(extract(epoch FROM (s.ended_at - s.started_at)) / 60)::int AS minutes
         FROM agent_sessions s JOIN organizations o ON o.id = s.org_id WHERE s.id = $1`, [sessionId]);
    if (!r?.stripe_customer_id) return;
    const cents = Math.round(Number(r.cost_usd ?? 0) * 100);
    const jobs: Promise<unknown>[] = [];
    if (cents > 0) jobs.push(reportUsage("model_spend", sessionId, r.stripe_customer_id, cents));
    if (r.status === "completed") jobs.push(reportUsage("agent_sessions", `${sessionId}:session`, r.stripe_customer_id, 1));
    if (Number(r.minutes) > 0) jobs.push(reportUsage("sandbox_hours", `${sessionId}:sandbox`, r.stripe_customer_id, Number(r.minutes)));
    for (const x of await Promise.allSettled(jobs)) if (x.status === "rejected") console.error(`stripe usage for ${sessionId} failed:`, (x.reason as Error).message);
  })().catch((err) => console.error(`stripe usage for ${sessionId} failed:`, (err as Error).message));
}

/** A completed simulation run, to the simulations meter (1 per run; identifier the run id). Best effort, never throws. */
export function reportSimulationUsage(simulationId: string): void {
  if (!stripeEnabled() || !sessionEngine()) return;
  void (async () => {
    const [r] = await (await getDb()).query<{ stripe_customer_id: string | null }>(
      "SELECT o.stripe_customer_id FROM simulations sim JOIN organizations o ON o.id = sim.org_id WHERE sim.id = $1 AND sim.status = 'completed'", [simulationId]);
    if (r?.stripe_customer_id) await reportUsage("simulations", `${simulationId}:run`, r.stripe_customer_id, 1);
  })().catch((err) => console.error(`stripe usage for run ${simulationId} failed:`, (err as Error).message));
}

// ---------- price per run (mold_v0-019; src/run-charges.ts) ----------

/**
 * One run's charge, to a billing meter: `value` in the currency's minor unit for `customer`. `identifier` is the run's
 * own (Stripe counts a meter event with an identifier it has seen once) and is also the request's idempotency key, so
 * a retry after a lost answer, or a second deliverer, never counts it twice. Throws a StripeError when Stripe refuses.
 */
export const sendRunChargeEvent = (o: { meter: string; identifier: string; customer: string; value: number }) =>
  call<{ identifier?: string }>("POST", "/v1/billing/meter_events",
    { event_name: o.meter, identifier: o.identifier, payload: { stripe_customer_id: o.customer, value: String(Math.trunc(o.value)) } }, o.identifier);

/** A credit for a run's charge: a negative customer balance transaction, which Stripe takes off the next invoice. Once per key. */
export const creditRunCharge = (customer: string, o: { minor: number; currency: string; description: string; runId: string; key: string }) =>
  call<BalanceTransaction>("POST", `/v1/customers/${encodeURIComponent(customer)}/balance_transactions`, {
    amount: -Math.abs(Math.trunc(o.minor)), currency: o.currency, description: o.description, metadata: { [NS_KEYS.run_id]: o.runId, [NS_KEYS.kind]: "run_credit" },
  }, o.key);

// ---------- credits for library contributions (src/contributions.ts) ----------

export interface BalanceTransaction { id: string; amount: number; currency: string; created: number; description: string | null; metadata?: Record<string, string> }
/** The metadata key a library-contribution credit carries: the submission (request) id. */
export const CONTRIBUTION_META = "library_submission_id";

/**
 * Credit a customer's Stripe balance (a negative balance transaction), which Stripe applies to their next invoice.
 * The idempotency key is the submission id, so a retry never credits twice.
 */
export const creditCustomerBalance = (customer: string, o: { cents: number; description: string; submissionId: string; kind: string }) =>
  call<BalanceTransaction>("POST", `/v1/customers/${encodeURIComponent(customer)}/balance_transactions`, {
    amount: -Math.abs(Math.round(o.cents)), currency: "usd", description: o.description,
    metadata: { [CONTRIBUTION_META]: o.submissionId, [NS_KEYS.kind]: o.kind },
  }, `library-credit-${o.submissionId}`);

/** A customer's balance transactions that are library-contribution credits (newest first, at most 500). */
export async function contributionCredits(customer: string): Promise<BalanceTransaction[]> {
  const out: BalanceTransaction[] = [];
  for (let after: string | undefined; out.length < 500;) {
    const page = await call<{ data: BalanceTransaction[]; has_more: boolean }>("GET",
      `/v1/customers/${encodeURIComponent(customer)}/balance_transactions?limit=100${after ? `&starting_after=${after}` : ""}`);
    out.push(...page.data);
    if (!page.has_more || !page.data.length) break;
    after = page.data[page.data.length - 1]!.id;
  }
  return out.filter((t) => t.metadata?.[CONTRIBUTION_META]);
}

/**
 * A plan as one JSON document (FinOps › Plans › New plan › JSON; POST /api/admin/onboarding/plans {config}): what a
 * customer pays, written once and turned into Stripe objects by billing.createPlanFromConfig. Checked here, with every
 * problem listed by its path, before anything is sent to Stripe.
 *
 *   {
 *     "name": "Growth",                     required, 2 to 60 characters; checkout shows it
 *     "description": "For teams shipping every week",  optional, shown at checkout
 *     "interval": "month",                  "month" (default) or "year"; the base fee and usage bill on it
 *     "lookup_key": "growth_v2",            optional; default <name> (KEY_PREFIX, src/namespace.ts, is put in front)
 *     "base_fee_usd": 499,                  flat recurring fee (0 or omitted: usage only)
 *     "trial_days": 14,                     optional free trial
 *     "monthly_budget_usd": 3000,           the account's monthly cap on model spend (Budget rules); default the base fee
 *                                           without usage, required with usage
 *     "usage": [                            optional: usage-based pricing, one component per metric (METRICS), each on
 *                                           its own Stripe billing meter (made if missing) and metered price, graduated:
 *       { "metric": "model_spend", "included_usd": 150, "markup": 1.3 },
 *       { "metric": "agent_sessions", "included": 500, "unit_price_usd": 0.08 },
 *       { "metric": "simulations", "included": 20, "tiers": [{ "up_to": 100, "unit_price_usd": 4 }, { "up_to": null, "unit_price_usd": 3 }] },
 *       { "metric": "sandbox_hours", "included_hours": 50, "unit_price_usd": 0.6 }
 *     ],                                    a single object (no metric) is model_spend, as before
 *     "experiment": "growth-price-q4", "weight": 1,   optional A/B test (src/experiments.ts)
 *     "tax_code": "txcd_10103001",          the product's Stripe tax code (default: SaaS, business use); Stripe
 *                                           Tax / Managed Payments refuse checkout for a product without one
 *     "metadata": { "owner": "growth" }     optional extra Stripe metadata (string values; keys starting with the namespace are reserved)
 *   }
 *
 * Each metric's meter counts whole units the server reports as the work finishes (src/billing.ts reportSessionUsage,
 * reportSimulationUsage); a component's price is in cents per unit (unit_amount_decimal), its tier bounds in units:
 *   model_spend     cents of a session's model cost       priced by markup (×cost), bounds in USD of model spend
 *   agent_sessions  1 per completed agent session         priced per session
 *   simulations     1 per completed simulation run        priced per run
 *   sandbox_hours   minutes of a session's sandbox time   priced per hour, bounds in hours
 */
import { experimentKey, planLookupKey } from "./billing.js";
import { KEY_PREFIX, NS } from "./namespace.js";

export const METRICS = {
  model_spend: { event: () => process.env.STRIPE_SPEND_METER || `${KEY_PREFIX}model_spend`, label: "Model spend", unit: "cent of model spend", suffix: "usage" },
  agent_sessions: { event: () => `${KEY_PREFIX}agent_sessions`, label: "Agent sessions", unit: "agent session", suffix: "agent_sessions" },
  simulations: { event: () => `${KEY_PREFIX}simulations`, label: "Simulations", unit: "simulation run", suffix: "simulations" },
  sandbox_hours: { event: () => `${KEY_PREFIX}sandbox_minutes`, label: "Sandbox hours", unit: "sandbox minute", suffix: "sandbox_hours" },
} as const;
export type Metric = keyof typeof METRICS;
export const METRIC_IDS = Object.keys(METRICS) as Metric[];
/** The meter event name for a metric (model_spend: STRIPE_SPEND_METER, else KEY_PREFIX + model_spend). */
export const meterFor = (m: Metric) => METRICS[m].event();
export const defaultMeter = () => meterFor("model_spend");
/** A metric's usage price lookup key, next to the plan's own: <plan>__usage for model spend (as before), else <plan>__<metric>. */
export const usageLookup = (plan: string, m: Metric) => `${plan}__${METRICS[m].suffix}`;

/** One usage component in Stripe's units: tier bounds in units, prices in cents per unit; included units bill at 0. */
export interface UsageComponent { metric: Metric; meter: string; included: number; tiers: { up_to: number | null; cents: number }[] }
export interface PlanConfig {
  name: string; description: string | null; interval: "month" | "year"; lookup_key: string; base_fee_usd: number; trial_days: number | null;
  monthly_budget_usd: number; usage: UsageComponent[];
  experiment: string | null; weight: number; metadata: Record<string, string>; tax_code: string;
}
/** Stripe's tax code for software as a service, business use: what the app sells. */
export const DEFAULT_TAX_CODE = "txcd_10103001";

export class PlanConfigError extends Error {
  status = 400;
  constructor(public problems: string[]) { super(`The plan config has ${problems.length === 1 ? "a problem" : `${problems.length} problems`}: ${problems.join("; ")}`); }
}

const KEYS = new Set(["name", "description", "interval", "lookup_key", "base_fee_usd", "trial_days", "monthly_budget_usd", "usage", "experiment", "weight", "metadata", "tax_code"]);
const cents = (x: number) => Math.abs(x * 100 - Math.round(x * 100)) < 1e-6;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

// How each metric reads and writes its JSON: the included amount, the bound and the price, and their scale to units/cents.
const SHAPE: Record<Metric, { included: string; bound: string; price: string; unitsPer: number; centsPer: number; priceMax: number }> = {
  model_spend: { included: "included_usd", bound: "up_to_usd", price: "markup", unitsPer: 100, centsPer: 1, priceMax: 10 },
  agent_sessions: { included: "included", bound: "up_to", price: "unit_price_usd", unitsPer: 1, centsPer: 100, priceMax: 1000 },
  simulations: { included: "included", bound: "up_to", price: "unit_price_usd", unitsPer: 1, centsPer: 100, priceMax: 10_000 },
  sandbox_hours: { included: "included_hours", bound: "up_to_hours", price: "unit_price_usd", unitsPer: 60, centsPer: 100 / 60, priceMax: 1000 },
};

/** Check and normalise a plan config: every problem at once, by path. */
export function parsePlanConfig(input: unknown): PlanConfig {
  let raw = input;
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch (e) { throw new PlanConfigError([`not valid JSON (${(e as Error).message})`]); } }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PlanConfigError(["the config must be a JSON object"]);
  const c = raw as Record<string, unknown>, bad: string[] = [];
  for (const k of Object.keys(c)) if (!KEYS.has(k)) bad.push(`${k}: unknown field`);
  const num = (path: string, v: unknown, o: { min?: number; max?: number; gt?: number; int?: boolean; money?: boolean } = {}) => {
    const n = Number(v);
    if (typeof v !== "number" || !Number.isFinite(n)) { bad.push(`${path}: must be a number`); return null; }
    if (o.gt != null && !(n > o.gt)) bad.push(`${path}: must be more than ${o.gt}`);
    if (o.min != null && n < o.min) bad.push(`${path}: must be at least ${o.min}`);
    if (o.max != null && n > o.max) bad.push(`${path}: must be at most ${o.max}`);
    if (o.int && !Number.isInteger(n)) bad.push(`${path}: must be a whole number`);
    if (o.money && !cents(n)) bad.push(`${path}: can't have fractions of a cent`);
    return n;
  };

  const name = typeof c.name === "string" ? c.name.trim().replace(/\s+/g, " ") : "";
  if (name.length < 2 || name.length > 60) bad.push("name: 2 to 60 characters");
  const description = c.description == null ? null : typeof c.description === "string" ? c.description.trim().slice(0, 300) || null : (bad.push("description: must be text"), null);
  const interval = c.interval ?? "month";
  if (interval !== "month" && interval !== "year") bad.push(`interval: "month" or "year"`);
  let lookup_key = planLookupKey(name || "plan");
  if (c.lookup_key != null) {
    const lk = String(c.lookup_key).trim();
    lookup_key = lk.startsWith(KEY_PREFIX) ? lk : `${KEY_PREFIX}${lk}`;
    if (!lookup_key.startsWith(KEY_PREFIX) || !/^[a-z0-9_]{1,160}$/.test(lookup_key.slice(KEY_PREFIX.length)) || lookup_key.includes("__")) bad.push("lookup_key: lower-case letters, digits and single underscores");
  }
  const base = c.base_fee_usd == null ? 0 : num("base_fee_usd", c.base_fee_usd, { min: 0, max: 100_000, money: true }) ?? 0;
  const trial = c.trial_days == null ? null : num("trial_days", c.trial_days, { min: 1, max: 730, int: true });

  const usage: UsageComponent[] = [];
  if (c.usage != null) {
    const list = Array.isArray(c.usage) ? c.usage : [c.usage];
    const single = !Array.isArray(c.usage);
    if (!list.length || list.length > METRIC_IDS.length) bad.push(`usage: 1 to ${METRIC_IDS.length} components`);
    list.forEach((item, idx) => {
      const at = single ? "usage" : `usage[${idx}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) return void bad.push(`${at}: must be an object`);
      const u = item as Record<string, unknown>;
      const metric = (u.metric ?? "model_spend") as Metric;
      if (!METRIC_IDS.includes(metric)) return void bad.push(`${at}.metric: one of ${METRIC_IDS.join(", ")}`);
      if (usage.some((x) => x.metric === metric)) return void bad.push(`${at}.metric: ${metric} is listed twice`);
      const sh = SHAPE[metric];
      for (const k of Object.keys(u)) if (![("metric"), "meter", sh.included, sh.price, "tiers"].includes(k)) bad.push(`${at}.${k}: unknown field for ${metric}`);
      const meter = u.meter == null ? meterFor(metric) : String(u.meter).trim();
      if (!/^[a-z0-9_]{3,100}$/.test(meter)) bad.push(`${at}.meter: an event name of lower-case letters, digits and underscores`);
      const incRaw = u[sh.included] == null ? 0 : num(`${at}.${sh.included}`, u[sh.included], { min: 0, max: 1_000_000, ...(metric === "model_spend" ? { money: true } : metric === "sandbox_hours" ? {} : { int: true }) }) ?? 0;
      const included = Math.round(incRaw * sh.unitsPer);
      const tiers: UsageComponent["tiers"] = [];
      if (u.tiers != null && u[sh.price] != null) bad.push(`${at}: give ${sh.price} or tiers, not both`);
      if (u.tiers != null) {
        if (!Array.isArray(u.tiers) || !u.tiers.length || u.tiers.length > 10) bad.push(`${at}.tiers: 1 to 10 tiers`);
        else u.tiers.forEach((t, i) => {
          const p = `${at}.tiers[${i}]`;
          if (!t || typeof t !== "object") return void bad.push(`${p}: must be an object`);
          const x = t as Record<string, unknown>;
          for (const k of Object.keys(x)) if (k !== sh.bound && k !== sh.price) bad.push(`${p}.${k}: unknown field (${sh.bound}, ${sh.price})`);
          const last = i === (u.tiers as unknown[]).length - 1;
          const up = x[sh.bound] == null ? null : num(`${p}.${sh.bound}`, x[sh.bound], { gt: 0, ...(metric === "model_spend" ? { money: true } : metric === "sandbox_hours" ? {} : { int: true }) });
          if (last && up != null) bad.push(`${p}.${sh.bound}: the last tier must be null (no upper bound)`);
          if (!last && up == null) bad.push(`${p}.${sh.bound}: only the last tier may be unbounded`);
          const price = num(`${p}.${sh.price}`, x[sh.price], { min: 0, max: sh.priceMax }) ?? 0;
          tiers.push({ up_to: up == null ? null : Math.round(up * sh.unitsPer), cents: r6(price * sh.centsPer) });
        });
        for (let i = 1; i < tiers.length - 1; i++) if ((tiers[i].up_to ?? 0) <= (tiers[i - 1].up_to ?? 0)) bad.push(`${at}.tiers[${i}].${sh.bound}: must be above the tier before`);
        if (tiers.length > 1 && included > 0 && (tiers[0].up_to ?? Infinity) <= included) bad.push(`${at}.tiers[0].${sh.bound}: must be above ${sh.included}`);
      } else if (u[sh.price] == null) bad.push(`${at}: give ${sh.price} or tiers`);
      else tiers.push({ up_to: null, cents: r6((num(`${at}.${sh.price}`, u[sh.price], { min: 0, max: sh.priceMax }) ?? 0) * sh.centsPer) });
      if (metric === "model_spend" && tiers.some((t) => t.cents <= 0)) bad.push(`${at}: a model-spend markup must be more than 0`);
      usage.push({ metric, meter, included, tiers });
    });
  }
  if (!(base > 0) && !usage.length) bad.push("base_fee_usd or usage: a plan needs a base fee, usage pricing or both");
  let budget = base;
  if (c.monthly_budget_usd != null) budget = num("monthly_budget_usd", c.monthly_budget_usd, { min: 0, max: 1_000_000, money: true }) ?? 0;
  else if (usage.length) bad.push("monthly_budget_usd: required with usage (the account's monthly cap on model spend)");
  const experimentRaw = c.experiment == null ? "" : String(c.experiment).trim();
  const experiment = experimentRaw ? experimentKey(experimentRaw) || null : null;
  if (experimentRaw && !experiment) bad.push("experiment: needs letters or digits");
  const weight = c.weight == null ? 1 : num("weight", c.weight, { gt: 0, max: 100 }) ?? 1;
  if (c.weight != null && !experiment) bad.push("weight: only with an experiment");
  const metadata: Record<string, string> = {};
  if (c.metadata != null) {
    if (typeof c.metadata !== "object" || Array.isArray(c.metadata)) bad.push("metadata: must be an object of strings");
    else for (const [k, v] of Object.entries(c.metadata as Record<string, unknown>)) {
      if (k.startsWith(NS) || k === "monthly_budget_usd") bad.push(`metadata.${k}: reserved`);
      else if (!/^[A-Za-z0-9_.-]{1,40}$/.test(k)) bad.push(`metadata.${k}: keys are letters, digits, _ . - (at most 40)`);
      else if (typeof v !== "string" || v.length > 500) bad.push(`metadata.${k}: a string of at most 500 characters`);
      else metadata[k] = v;
    }
    if (Object.keys(metadata).length > 20) bad.push("metadata: at most 20 keys");
  }
  const tax_code = c.tax_code == null ? DEFAULT_TAX_CODE : String(c.tax_code).trim();
  if (!/^txcd_\d{8}$/.test(tax_code)) bad.push("tax_code: a Stripe tax code, txcd_ and 8 digits");
  if (bad.length) throw new PlanConfigError(bad);
  return { tax_code, name, description, interval: interval as "month" | "year", lookup_key, base_fee_usd: base, trial_days: trial, monthly_budget_usd: budget, usage, experiment, weight, metadata };
}

/** A component's Stripe price tiers: included units at 0 first, then its tiers (bounds in units, cents per unit). */
export function stripeTiers(u: UsageComponent): { up_to: number | "inf"; unit_amount_decimal: string }[] {
  const out: { up_to: number | "inf"; unit_amount_decimal: string }[] = [];
  if (u.included > 0) out.push({ up_to: u.included, unit_amount_decimal: "0" });
  for (const t of u.tiers) out.push({ up_to: t.up_to == null ? "inf" : t.up_to, unit_amount_decimal: String(r6(t.cents)) });
  return out;
}

/** A component back from Stripe's tiers (inverse of stripeTiers). */
export function usageFromTiers(metric: Metric, meter: string, tiers: { up_to: number | null; unit_amount_decimal?: string | null; unit_amount?: number | null }[]): UsageComponent {
  const rate = (t: (typeof tiers)[number]) => Number(t.unit_amount_decimal ?? t.unit_amount ?? 0);
  const ts = [...tiers];
  const included = ts.length > 1 && rate(ts[0]) === 0 && ts[0].up_to != null ? ts.shift()!.up_to! : 0;
  return { metric, meter, included, tiers: ts.map((t) => ({ up_to: t.up_to ?? null, cents: rate(t) })) };
}

const rn = (x: number) => Math.round(x * 1e4) / 1e4;
/** A component as a person writes it (human units; the meter left out when it is the default). */
export function componentJson(u: UsageComponent): Record<string, unknown> {
  const sh = SHAPE[u.metric];
  const price = (cts: number) => rn(cts / sh.centsPer), bound = (n: number | null) => (n == null ? null : rn(n / sh.unitsPer));
  return { metric: u.metric, ...(u.meter !== meterFor(u.metric) ? { meter: u.meter } : {}), [sh.included]: bound(u.included) ?? 0,
    ...(u.tiers.length === 1 && u.tiers[0].up_to == null ? { [sh.price]: price(u.tiers[0].cents) } : { tiers: u.tiers.map((t) => ({ [sh.bound]: bound(t.up_to), [sh.price]: price(t.cents) })) }) };
}

const usd = (x: number) => `$${x.toLocaleString("en-US", { minimumFractionDigits: x % 1 ? 2 : 0, maximumFractionDigits: 4 })}`;
/** A component in words, for the Plans table and the customer's Billing page. */
export function componentSummary(u: UsageComponent): string {
  const j = componentJson(u) as Record<string, any>, sh = SHAPE[u.metric];
  const price = (p: number) => (u.metric === "model_spend" ? `${p}× cost` : `${usd(p)} per ${u.metric === "sandbox_hours" ? "hour" : u.metric === "simulations" ? "run" : "session"}`);
  const bound = (b: number) => (u.metric === "model_spend" ? usd(b) : u.metric === "sandbox_hours" ? `${b} h` : b.toLocaleString("en-US"));
  const inc = j[sh.included] ? `${bound(j[sh.included])} included, then ` : "";
  const rates = j.tiers ? (j.tiers as any[]).map((t) => `${price(t[sh.price])}${t[sh.bound] == null ? "" : ` up to ${bound(t[sh.bound])}`}`).join(", then ") : price(j[sh.price]);
  return `${METRICS[u.metric].label}: ${inc}${rates}`;
}

/** A plan config as a person writes it (defaults left out where they are the default). */
export function configJson(c: PlanConfig): Record<string, unknown> {
  return {
    name: c.name, ...(c.description ? { description: c.description } : {}), interval: c.interval, lookup_key: c.lookup_key, base_fee_usd: c.base_fee_usd,
    ...(c.trial_days ? { trial_days: c.trial_days } : {}), monthly_budget_usd: c.monthly_budget_usd,
    ...(c.usage.length ? { usage: c.usage.map(componentJson) } : {}),
    ...(c.experiment ? { experiment: c.experiment, weight: c.weight } : {}), ...(Object.keys(c.metadata).length ? { metadata: c.metadata } : {}),
    ...(c.tax_code !== DEFAULT_TAX_CODE ? { tax_code: c.tax_code } : {}),
  };
}

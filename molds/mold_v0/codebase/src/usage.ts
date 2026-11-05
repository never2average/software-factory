import { getDb } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import { ENV } from "./env-names.js";
import { PROFILE } from "./profile.js";

/**
 * Per-model inference usage and cost. The gateway calls recordModelUsage() once per request with the model the
 * provider reported and the tokens it metered; we price it from model_prices (long-context tier per request), add it
 * to the day's row for (provider, model, consumer), and fire a once-a-day webhook alert when a model's daily cost
 * crosses its budget (APP_MODEL_DAILY_BUDGETS='{"gpt-6.1-sol": 25}', APP_ALERT_WEBHOOK_URL).
 *
 * The arithmetic is the provider's usage fields' (mold_v0-246): of a request's input, the plain tokens at the input
 * price, the cache reads at the cached price, and the cache writes at their own price (model_prices
 * cache_write_per_mtok, 5-minute writes, and cache_write_1h_per_mtok, 1-hour writes; when a column is empty, the
 * provider's premium on the input price: 1.25x and 2x). Only Anthropic reports cache writes
 * (cache_creation_input_tokens, split by cache_creation.ephemeral_5m/1h_input_tokens); others report none.
 */

export interface Price {
  input_per_mtok: number; cached_input_per_mtok: number; output_per_mtok: number;
  cache_write_per_mtok: number | null; cache_write_1h_per_mtok: number | null;
  long_context_threshold: number | null; long_input_per_mtok: number | null; long_cached_input_per_mtok: number | null; long_output_per_mtok: number | null;
}
let prices: { at: number; byModel: Map<string, Price> } | null = null;

async function priceOf(model: string): Promise<Price | null> {
  if (!prices || Date.now() - prices.at > 60_000) {
    const rows = await (await getDb()).query<Price & { model: string }>("SELECT * FROM model_prices");
    prices = { at: Date.now(), byModel: new Map(rows.map((r) => [r.model, r])) };
  }
  // Exact id first, then a dated or pinned release of a known id (gpt-6.1-sol-2026-09-01, gpt-6-sol-20260901,
  // claude-opus-5-5@20261001, ...-latest). Any other suffix is another model (glm-5.3-flash is not glm-5.3), so it
  // stays unpriced rather than borrowing a bigger model's rate.
  const release = /^(\d{4}-\d{2}-\d{2}|\d{8}|\d{4}|latest|v\d+)$/;
  return prices.byModel.get(model) ?? [...prices.byModel].find(([k]) => model.startsWith(`${k}@`) || (model.startsWith(`${k}-`) && release.test(model.slice(k.length + 1))))?.[1] ?? null;
}

/**
 * One request's (or a day's) metered tokens. `input` is all input, cached included; `cached` the cache reads in it;
 * `cacheWrite` the cache writes in it (`cacheWrite1h` the 1-hour ones among those). The rest of `input` is plain.
 */
export interface Metered { requests: number; errors: number; input: number; cached: number; output: number; cacheWrite?: number; cacheWrite1h?: number }

/** The provider's premium for a cache write over the input price, when model_prices names no price of its own. */
export const CACHE_WRITE_PREMIUM = 1.25, CACHE_WRITE_1H_PREMIUM = 2;

/** The model's price row (an exact id, or a dated release of one), or null when it has none. */
export async function hasPrice(model: string): Promise<boolean> {
  return !!model && (await priceOf(model)) != null;
}

/** What tokens cost at a price row, in dollars (pure: the tests check it against the provider's own figures). */
export function priceTokens(p: Price, m: Pick<Metered, "input" | "cached" | "output" | "cacheWrite" | "cacheWrite1h">): number {
  const long = p.long_context_threshold != null && m.input > p.long_context_threshold;
  const inP = Number(long ? p.long_input_per_mtok ?? p.input_per_mtok : p.input_per_mtok);
  const cachedP = Number(long ? p.long_cached_input_per_mtok ?? p.cached_input_per_mtok : p.cached_input_per_mtok);
  const outP = Number(long ? p.long_output_per_mtok ?? p.output_per_mtok : p.output_per_mtok);
  // A long-context request writes at the premium on its long input price (no table lists a long write price apart).
  const writeP = long || p.cache_write_per_mtok == null ? inP * CACHE_WRITE_PREMIUM : Number(p.cache_write_per_mtok);
  const write1hP = long || p.cache_write_1h_per_mtok == null ? inP * CACHE_WRITE_1H_PREMIUM : Number(p.cache_write_1h_per_mtok);
  const cached = Math.max(0, m.cached), write = Math.max(0, m.cacheWrite ?? 0), write1h = Math.min(write, Math.max(0, m.cacheWrite1h ?? 0));
  const plain = Math.max(0, m.input - cached - write);
  return (plain * inP + cached * cachedP + (write - write1h) * writeP + write1h * write1hP + m.output * outP) / 1e6;
}

export async function costOf(model: string, m: Pick<Metered, "input" | "cached" | "output" | "cacheWrite" | "cacheWrite1h">): Promise<number | null> {
  const p = await priceOf(model);
  return p ? priceTokens(p, m) : null;
}

/**
 * One request into the day's row. `priceAs` prices it when the model the provider named has no row of its own (the
 * model the request asked for, which the gateway checked before routing it); the row keeps the served name.
 */
export async function recordModelUsage(provider: string, model: string, consumer: "session" | "orchestrator", m: Metered, priceAs?: string) {
  // Platform metering (gateway_model_usage), whoever's call it was (src/tenant-scope.ts).
  return asPlatform(async () => {
  const cost = (await costOf(model, m)) ?? (priceAs && priceAs !== model ? await costOf(priceAs, m) : null);
  const db = await getDb();
  await db.query(
    `INSERT INTO gateway_model_usage (day, provider, model, consumer, requests, errors, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, cost_usd, priced)
     VALUES (current_date, $1, $2, $3, $4, $5, $6, $7, $11, $8, $9, $10)
     ON CONFLICT (day, provider, model, consumer) DO UPDATE SET
       requests = gateway_model_usage.requests + excluded.requests, errors = gateway_model_usage.errors + excluded.errors,
       input_tokens = gateway_model_usage.input_tokens + excluded.input_tokens,
       cached_input_tokens = gateway_model_usage.cached_input_tokens + excluded.cached_input_tokens,
       cache_write_tokens = gateway_model_usage.cache_write_tokens + excluded.cache_write_tokens,
       output_tokens = gateway_model_usage.output_tokens + excluded.output_tokens,
       cost_usd = gateway_model_usage.cost_usd + excluded.cost_usd, priced = gateway_model_usage.priced AND excluded.priced`,
    [provider, model || "unknown", consumer, m.requests, m.errors, m.input, m.cached, m.output, cost ?? 0, cost != null, m.cacheWrite ?? 0],
  );
  if (cost) await maybeAlert(model).catch((e) => console.error("usage alert failed:", (e as Error).message));
});
}

async function maybeAlert(model: string) {
  const budgets = JSON.parse(ENV.APP_MODEL_DAILY_BUDGETS ?? "{}") as Record<string, number>;
  const budget = budgets[model];
  const hook = ENV.APP_ALERT_WEBHOOK_URL;
  if (!budget || !hook) return;
  const db = await getDb();
  const [{ cost }] = await db.query<{ cost: number }>("SELECT coalesce(sum(cost_usd), 0) AS cost FROM gateway_model_usage WHERE day = current_date AND model = $1", [model]);
  if (Number(cost) < budget) return;
  const [fresh] = await db.query("INSERT INTO usage_alerts (day, model) VALUES (current_date, $1) ON CONFLICT DO NOTHING RETURNING model", [model]);
  if (!fresh) return; // already alerted today
  await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ text: `${PROFILE.name}: ${model} spend today is $${Number(cost).toFixed(2)} (daily budget $${budget}).` }) });
}

/** Daily rows and totals per model for the last `days` days (optionally one model). */
export async function usageReport(input: { days?: number; model?: string } = {}) {
  const db = await getDb();
  const days = Math.min(Math.max(Math.trunc(input.days ?? 7), 1), 366);
  const params: unknown[] = [days];
  let where = "day > current_date - $1::int";
  if (input.model) params.push(input.model), (where += ` AND model = $${params.length}`);
  const daily = await db.query<any>(
    `SELECT day::text AS day, provider, model, consumer, requests, errors, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens,
            round(cost_usd, 4) AS cost_usd, priced
       FROM gateway_model_usage WHERE ${where} ORDER BY day DESC, cost_usd DESC`, params);
  const totals = await db.query<any>(
    `SELECT model, sum(requests) AS requests, sum(input_tokens) AS input_tokens, sum(cached_input_tokens) AS cached_input_tokens, sum(cache_write_tokens) AS cache_write_tokens,
            sum(output_tokens) AS output_tokens, round(sum(cost_usd), 4) AS cost_usd, bool_and(priced) AS priced
       FROM gateway_model_usage WHERE ${where} GROUP BY model ORDER BY sum(cost_usd) DESC`, params);
  return { days, model: input.model ?? null, totals, daily };
}

export async function setPrice(model: string, p: Partial<Price> & { input_per_mtok: number; cached_input_per_mtok: number; output_per_mtok: number; source?: string }) {
  await (await getDb()).query(
    `INSERT INTO model_prices (model, input_per_mtok, cached_input_per_mtok, output_per_mtok, long_context_threshold,
                               long_input_per_mtok, long_cached_input_per_mtok, long_output_per_mtok, source, cache_write_per_mtok, cache_write_1h_per_mtok, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (model) DO UPDATE SET input_per_mtok = excluded.input_per_mtok, cached_input_per_mtok = excluded.cached_input_per_mtok,
       output_per_mtok = excluded.output_per_mtok, long_context_threshold = excluded.long_context_threshold,
       long_input_per_mtok = excluded.long_input_per_mtok, long_cached_input_per_mtok = excluded.long_cached_input_per_mtok,
       long_output_per_mtok = excluded.long_output_per_mtok, source = excluded.source,
       cache_write_per_mtok = excluded.cache_write_per_mtok, cache_write_1h_per_mtok = excluded.cache_write_1h_per_mtok, updated_at = now()`,
    [model, p.input_per_mtok, p.cached_input_per_mtok, p.output_per_mtok, p.long_context_threshold ?? null,
     p.long_input_per_mtok ?? null, p.long_cached_input_per_mtok ?? null, p.long_output_per_mtok ?? null, p.source ?? "manual",
     p.cache_write_per_mtok ?? null, p.cache_write_1h_per_mtok ?? null]);
  prices = null;
}

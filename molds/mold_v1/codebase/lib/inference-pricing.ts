/**
 * What a model call costs — the ONE place prices live.
 *
 * `chat_turn_usage` and `automation_runs` store tokens, never dollars: a price
 * changes, a token count does not, and a stored cost quietly goes stale the day
 * the provider reprices. The read API (`app/api/ops/usage`) prices rows here at
 * request time instead.
 *
 * Source: https://developers.cloudflare.com/workers-ai/platform/pricing/
 * Read on 2026-09-09. GLM 5.2 on Workers AI:
 *   $1.40 per million input tokens
 *   $0.26 per million cached input tokens
 *   $4.40 per million output tokens
 *
 * A model that is not in the table prices to `null`, never to zero: an
 * unknown model producing a $0.00 line is the kind of number that gets
 * believed. Add the model here when it is adopted, with its source and date.
 *
 * No imports on purpose — this runs under plain `node --experimental-strip-types`
 * in scripts/test-chat-usage.mjs as well as inside Next.
 */

export interface ModelPrice {
  /** USD per million uncached input tokens. */
  readonly inputPerM: number;
  /** USD per million input tokens served from the provider's prompt cache. */
  readonly cachedInputPerM: number;
  /** USD per million output tokens. */
  readonly outputPerM: number;
}

export interface TokenCounts {
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  /** Input tokens the provider reports as cache hits (a SUBSET of inputTokens). */
  readonly cacheReadTokens?: number | null;
  /** Cache-write tokens. Workers AI does not bill these separately; ignored. */
  readonly cacheWriteTokens?: number | null;
}

export const INFERENCE_PRICES: Readonly<Record<string, ModelPrice>> = {
  // Cloudflare Workers AI — https://developers.cloudflare.com/workers-ai/platform/pricing/ (2026-09-09)
  "@cf/zai-org/glm-5.2": { inputPerM: 1.4, cachedInputPerM: 0.26, outputPerM: 4.4 },
  // From the account's Workers AI model catalogue (GET /accounts/<id>/ai/models/search), 2026-09-19.
  "@cf/zai-org/glm-5.3": { inputPerM: 1.4, cachedInputPerM: 0.26, outputPerM: 4.4 },
  "@cf/zai-org/glm-5.3-flash": { inputPerM: 0.15, cachedInputPerM: 0.03, outputPerM: 0.5 },
  "@cf/moonshotai/kimi-k2.6": { inputPerM: 0.95, cachedInputPerM: 0.16, outputPerM: 4 },
};

/** The price row for a model id, or null when the model is not priced here. */
export function priceForModel(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  return INFERENCE_PRICES[model.trim()] ?? null;
}

const nonNegative = (n: number | null | undefined): number =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;

/**
 * Estimated USD for a set of token counts on a model, or null when the model is
 * not priced.
 *
 * Cache reads are treated as a subset of input tokens, the OpenAI-compatible
 * convention Workers AI follows (`prompt_tokens` includes
 * `prompt_tokens_details.cached_tokens`): the cached part is billed at the
 * cached rate and only the remainder at the full input rate. A provider that
 * reports cache reads OUTSIDE its input count would be over-corrected here, so
 * the remainder is floored at zero rather than going negative.
 */
export function estimateCostUsd(model: string | null | undefined, tokens: TokenCounts): number | null {
  const price = priceForModel(model);
  if (!price) return null;
  const input = nonNegative(tokens.inputTokens);
  const output = nonNegative(tokens.outputTokens);
  const cached = Math.min(nonNegative(tokens.cacheReadTokens), input);
  const uncached = input - cached;
  const usd =
    (uncached * price.inputPerM + cached * price.cachedInputPerM + output * price.outputPerM) / 1_000_000;
  // Round to a tenth of a cent: enough for a dashboard, and it keeps floating
  // point noise like 0.04536000000000001 out of the JSON.
  return Math.round(usd * 10_000) / 10_000;
}

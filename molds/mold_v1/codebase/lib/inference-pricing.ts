/**
 * What a model call costs — the ONE place prices live.
 *
 * `chat_turn_usage` stores tokens, never dollars: a price changes, a token count
 * does not, and a stored cost quietly goes stale the day the provider reprices.
 * The read API (`app/api/ops/usage`) prices those rows here at request time.
 *
 * A specialist's run (`automation_runs`, agent/lib/workflow-usage.ts) does store
 * a cost, because that row has always carried the provider's: each step adds the
 * provider's figure when there is one, else the step's tokens priced here at the
 * model that served the step. The tokens are kept per model beside it
 * (`model_usage`), so a run can still be re-priced from them.
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

/* ---- speech to text (dictation) ---------------------------------------------------------------------------------- */

/**
 * What a speech-to-text model costs: USD per minute of audio. Billed on the audio's length, not on tokens, so it is
 * its own table; a dictation's usage row (`chat_turn_usage`, kind "dictation") stores the audio's length in
 * milliseconds and is priced here at request time, exactly as a chat turn's tokens are.
 *
 * Source: https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/ — "Unit Pricing: $0.000513 per
 * audio minute", read on 2026-10-11. The pricing page (https://developers.cloudflare.com/workers-ai/platform/pricing/,
 * same day) rounds it to "$0.0005 per audio minute" and states the unit it is billed in: 46.63 neurons per audio
 * minute at $0.011 per 1,000 neurons = $0.000513. Whisper (the older model) is $0.000453 on its page (41.14 neurons).
 *
 * Unknown model: null, never zero, as for the token table above.
 */
export interface AudioPrice {
  /** USD per minute of audio. */
  readonly perMinute: number;
}

export const AUDIO_PRICES: Readonly<Record<string, AudioPrice>> = {
  // Cloudflare Workers AI — https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/ (2026-10-11)
  "@cf/openai/whisper-large-v3-turbo": { perMinute: 0.000513 },
  // https://developers.cloudflare.com/workers-ai/models/whisper/ (2026-10-11)
  "@cf/openai/whisper": { perMinute: 0.000453 },
};

/** The audio price row for a model id, or null when the model is not priced here. */
export function audioPriceForModel(model: string | null | undefined): AudioPrice | null {
  if (!model) return null;
  return AUDIO_PRICES[model.trim()] ?? null;
}

/**
 * Estimated USD for `audioMs` milliseconds of audio on a speech-to-text model, or null when the model is not priced.
 * Rounded to a millionth of a dollar (six places): a two-minute clip is about a tenth of a cent, and the four places
 * the token figures use would round a single dictation to zero.
 */
export function estimateAudioCostUsd(model: string | null | undefined, audioMs: number | null | undefined): number | null {
  const price = audioPriceForModel(model);
  if (!price) return null;
  const ms = nonNegative(audioMs);
  return Math.round(((ms / 60_000) * price.perMinute) * 1_000_000) / 1_000_000;
}

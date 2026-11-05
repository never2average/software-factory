/**
 * Provider-safe settings for the agent CLIs a run starts (mold_v0-189).
 *
 * A run reaches its model through the gateway (src/gateway.ts): the CLI is given ANTHROPIC_BASE_URL and an ogw_ token,
 * so it believes it talks to Anthropic's own API and sends Anthropic's newest request fields. When the gateway's
 * upstream is Claude on Google Cloud Vertex AI (src/vertex.ts) those fields can be refused: Claude Code up to 2.1.303
 * (measured: 2.1.220, 2.1.295, 2.1.302, 2.1.303) sends `context_management` (its context-editing beta) with every
 * request for current models, and Vertex answers
 * "400 context_management: Extra inputs are not permitted" before a single token is spent (the audit app's hosted run of
 * 2026-11-01 10:06, on a sandbox whose own Claude Code was 2.1.220). Claude Code 2.1.304 and later retry once without
 * the field; older ones end the session.
 *
 * Claude Code's documented settings (code.claude.com/docs/en/settings, "Environment variables"), each checked against
 * the 2.1.220, 2.1.295 and 2.1.316 binaries with a stand-in API that refuses context_management as Vertex does:
 *   CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1  the documented switch for gateways in front of other providers: no beta
 *                                             headers, so no beta request fields (no context_management): the session
 *                                             then succeeds on every one of those versions.
 *   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 no auto-update, telemetry or error reporting. With telemetry off the
 *   DISABLE_TELEMETRY=1, DISABLE_AUTOUPDATER=1 CLI does not fetch its remote feature flags either (the binary's own
 *                                             words: "GrowthBook is off for this session: a third-party provider, or
 *                                             telemetry opted out"), so a flag served remotely cannot change a hosted
 *                                             run's requests between two runs.
 * Auto permission mode keeps working with the betas off (its classifier requests are made as before).
 *
 * These are settings, never secrets. A kind's own declared variables win over them (an agent-workspace kind may set
 * any of them itself).
 */
import type { ProviderRow } from "./keyvault.js";

/** Every run with a Claude provider: no self-update, no telemetry, so no remotely served feature flags either. */
export const CLAUDE_CODE_QUIET_ENV: Readonly<Record<string, string>> = Object.freeze({
  DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1",
});
/** A Claude provider that is not Anthropic's own API (Vertex AI, or another upstream): no beta request fields. */
export const CLAUDE_CODE_THIRD_PARTY_ENV: Readonly<Record<string, string>> = Object.freeze({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" });

/** Anthropic's own API host: the only upstream that accepts every request field Claude Code sends. */
const FIRST_PARTY_HOST = "api.anthropic.com";

/**
 * Whether the gateway serves this Claude provider from Anthropic's own API: a direct upstream at api.anthropic.com with
 * an Anthropic key of its own in the vault (`hasDirectKey`). A Vertex backend, a provider with only a Vertex key (the
 * gateway's fallback to Vertex), or any other upstream (a proxy, another cloud) is not.
 */
export function anthropicFirstParty(p: Pick<ProviderRow, "backend" | "upstream_url">, hasDirectKey: boolean): boolean {
  if (p.backend === "vertex" || !hasDirectKey || !p.upstream_url) return false;
  try { return new URL(p.upstream_url).hostname.toLowerCase() === FIRST_PARTY_HOST; } catch { return false; }
}

/** The settings a run's CLI gets for one gateway provider (only the Claude provider `anthropic` has any). */
export function providerSafeEnv(slug: string, firstParty: boolean): Record<string, string> {
  if (slug !== "anthropic") return {};
  return { ...CLAUDE_CODE_QUIET_ENV, ...(firstParty ? {} : CLAUDE_CODE_THIRD_PARTY_ENV) };
}

/** One attempt's gateway usage: requests forwarded, how many the upstream refused (HTTP 4xx/5xx), tokens and cost. */
export interface AttemptUsage { requests: number; errors: number; tokens: number; cost_usd: number }

/**
 * Whether the model API refused the attempt before it spent anything (mold_v0-189): the upstream refused at least one of
 * its requests, no token was metered and nothing cost anything (a free request answered, count_tokens say, spends
 * nothing either). Such a run never started its work, so running it once more costs nothing and loses nothing.
 */
export function refusedBeforeSpend(u: AttemptUsage): boolean {
  return u.errors > 0 && u.tokens === 0 && u.cost_usd === 0;
}

/** The event a run gets when it is queued again after such a refusal; a run gets it at most once. */
export const REFUSED_RETRY_EVENT = "model_refused_retry";

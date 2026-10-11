/**
 * WHEN A SESSION'S PROMPT IS SUMMARISED — eve's compaction threshold, per role and per specialist (mold_v1-220).
 *
 * Every step of an eve session resends the session's whole history: instructions, tools, every earlier tool call and
 * its result. eve compacts (summarises the older steps and goes on from the summary and the latest ones) only once the
 * prompt passes `threshold = thresholdPercent x context window`, and its default is 90%. On GLM 5.3's 1,310,720-token
 * window that is ~1.18M tokens, which a specialist never reaches: its prompt climbs to a few hundred thousand tokens
 * and every one of its 20-40 steps pays for all of it again. Measured on one workspace (2026-10-09): 3.5M-18M input
 * tokens for one specialist run.
 *
 * So each agent declares a threshold in TOKENS, read from the deployment profile (`agent.compaction`, default 160,000
 * for a specialist, eve's own for the main agent) and turned here into the `compaction.thresholdPercent` eve takes,
 * against the same context window the agent declares. Nothing is stopped and no step is refused: a long run goes on
 * for as many steps as it needs, each one sending at most about the threshold. What compaction keeps is eve's, patched
 * so a specialist's tool results reach the summary (scripts/eve-patch/files/harness/compaction-fidelity.js).
 *
 * Precedence, highest first:
 *   MODEL_COMPACT_AT_TOKENS_<ROLE>                  the environment, for one deployment ("off" = eve's own)
 *   agent.compaction.specialists.<directory name>   one specialist (null = eve's own for it)
 *   agent.compaction.<role>_tokens                  the role (null = eve's own)
 * and the result is held to 90% of the window (eve's own threshold): a smaller window is never asked to hold more.
 *
 * Read when the agent is built: eve compiles `compaction` into its manifest, like the context window beside it.
 * No side effects on import, so a test can import it without a provider (scripts/test-specialist-context.mjs).
 */
import { DEPLOYMENT_PROFILE } from "./deployment-profile.generated.ts";

export type CompactionRole = "orchestrator" | "specialist";

/** eve's own threshold: 90% of the window (eve/dist/src/execution/session.js createCompactionConfig). */
export const EVE_DEFAULT_THRESHOLD_PERCENT = 0.9;
/** The smallest threshold accepted from the environment, as from the profile (scripts/gen-deployment-profile.mjs). */
export const MIN_COMPACT_AT_TOKENS = 32_000;

type Settings = { orchestrator_tokens: number | null; specialist_tokens: number | null; specialists: Record<string, number | null> };

const envVar = (role: CompactionRole) => `MODEL_COMPACT_AT_TOKENS_${role.toUpperCase()}`;

/**
 * The threshold, in tokens, an agent of `role` (the specialist `key`, for a specialist) compacts at, or null for
 * eve's own. Not yet held to the window: see `agentCompaction`.
 */
export function compactAtTokens(
  role: CompactionRole,
  key?: string,
  env: Record<string, string | undefined> = process.env,
  settings: Settings = DEPLOYMENT_PROFILE.agent.compaction,
): number | null {
  const raw = env[envVar(role)]?.trim().toLowerCase();
  if (raw) {
    if (raw === "off" || raw === "none" || raw === "false") return null;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= MIN_COMPACT_AT_TOKENS) return n;
    console.warn(`[compaction] ${envVar(role)}="${raw}" is not "off" or a whole number of tokens from ${MIN_COMPACT_AT_TOKENS} up — using the profile's value`);
  }
  if (role === "specialist" && key !== undefined && Object.hasOwn(settings.specialists, key)) return settings.specialists[key] ?? null;
  return (role === "orchestrator" ? settings.orchestrator_tokens : settings.specialist_tokens) ?? null;
}

/**
 * eve's `compaction` for an agent: `{ thresholdPercent }` so that the threshold is `compactAtTokens` on a window of
 * `windowTokens`, or undefined (eve's own) when there is no value, no known window (gateway mode: eve looks the window
 * up itself, so a fraction of it cannot be computed here), or the value is at or above eve's own 90%.
 */
export function agentCompaction(
  role: CompactionRole,
  key: string | undefined,
  windowTokens: number | undefined,
  env: Record<string, string | undefined> = process.env,
  settings: Settings = DEPLOYMENT_PROFILE.agent.compaction,
): { thresholdPercent: number } | undefined {
  const tokens = compactAtTokens(role, key, env, settings);
  if (tokens === null || windowTokens === undefined || !(windowTokens > 0)) return undefined;
  const percent = tokens / windowTokens;
  if (percent >= EVE_DEFAULT_THRESHOLD_PERCENT) return undefined;
  // eve floors window x percent; round up in the last digits so the floor lands on `tokens`, not one below it.
  return { thresholdPercent: Math.min(EVE_DEFAULT_THRESHOLD_PERCENT, Math.ceil(percent * 1e9) / 1e9) };
}

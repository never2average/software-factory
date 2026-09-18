/**
 * Where the eve agent lives — resolved in ONE place, defensively.
 *
 * The agent runs as a separate Vercel project (`fde-agent-api`). Seven call
 * sites read its address out of the environment, each with its own fallback:
 * some defaulted to the production hostname, some to `""`, and one threw. So
 * the same misconfiguration produced three different symptoms depending on
 * which path you happened to hit.
 *
 * THE `[SENSITIVE]` TRAP
 * ---------------------
 * A Vercel env var marked Sensitive is not readable by the CLI, so `vercel
 * pull` / `vercel build` substitutes the literal string `"[SENSITIVE]"`. That
 * is a perfectly ordinary non-empty string, so `??` and `||` both accept it
 * happily — the value is present, it is just nonsense. It reached
 * `next.config.ts`, which builds a rewrite destination out of it, and the build
 * died with "Invalid rewrites found" naming a route nobody had touched. The
 * cause and the error message had nothing visibly to do with each other.
 *
 * Being a build-time read is what makes this bite: the value is baked into the
 * rewrite at build time, so a var that is merely unreadable LOCALLY breaks a
 * local prebuilt deploy while the identical config builds fine on Vercel.
 *
 * Hence: validate the shape, not merely the presence. A value that cannot be a
 * URL is treated as absent, which is what it actually is.
 *
 * NOTE ON THE NAME. `NEXT_PUBLIC_EVE_API_URL` is read exclusively by SERVER
 * code — API routes, the rewrite, the workflow delegate. Nothing in the client
 * bundle references it (verified: it appears in none of the page's chunks), so
 * despite the prefix it is not shipped to browsers. The prefix is a leftover
 * that misdescribes the variable's scope. `EVE_API_URL` is read first so the
 * name can be corrected without a flag day; until then the old name still
 * works, and neither has to be Sensitive for a build to succeed.
 */

/** The production agent, used when the environment says nothing usable. */
export const DEFAULT_AGENT_URL = "https://fde-agent-api.vercel.app";

/**
 * A value only counts if it could actually be an origin.
 *
 * Rejects the empty string, the `[SENSITIVE]` placeholder, and anything that is
 * not an http(s) URL. Trailing slashes are trimmed so callers can concatenate
 * paths without doubling them.
 */
export function normalizeAgentUrl(raw: string | undefined | null): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  // Vercel's stand-in for a value the CLI may not read. Non-empty, so every
  // `??`/`||` fallback in the codebase accepted it before this existed.
  if (value === "[SENSITIVE]") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return value.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * The agent's base URL, or the production default.
 *
 * Never returns "" — a caller that concatenates onto an empty base builds a
 * request against its own origin and gets a confusing 404 from itself rather
 * than a clear "the agent is not configured".
 */
export function agentBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    normalizeAgentUrl(env.EVE_API_URL) ??
    normalizeAgentUrl(env.NEXT_PUBLIC_EVE_API_URL) ??
    DEFAULT_AGENT_URL
  );
}

/**
 * True when the address came from the environment rather than the fallback —
 * for health checks that want to say "nobody configured this" out loud instead
 * of silently probing the default.
 */
export function agentUrlIsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    normalizeAgentUrl(env.EVE_API_URL) !== null ||
    normalizeAgentUrl(env.NEXT_PUBLIC_EVE_API_URL) !== null
  );
}

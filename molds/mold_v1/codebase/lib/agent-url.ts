/**
 * Where the eve agent lives — resolved in ONE place, defensively.
 *
 * The agent runs as a separate service (on Vercel, its own project). Seven call
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

/**
 * The stand-in for development and test builds only: an agent on this machine (`eve dev`). Never a deployment's
 * address — no deployment's agent is written into base code.
 */
export const DEFAULT_AGENT_URL = "http://127.0.0.1:3001";

/**
 * A DEFAULT DEPLOYMENT ADDRESS IS A TRAP
 * --------------------------------------
 * The fallback used to be one Vercel deployment's own agent. A web app built anywhere else without the agent's
 * address did not fail: it built, started, and proxied every chat to that deployment. Nothing said so. On Vercel it
 * was the same trap for every other project: a web app missing the setting talked to someone else's agent.
 *
 * So a PRODUCTION build or server (`next build`, `next start`), and anything running on Vercel, must be told where its
 * agent is, and refuses to build or start otherwise, with {@link AgentUrlNotConfiguredError}'s message. Two cases keep
 * the local stand-in above:
 *
 *   - development and plain-node tests (`NODE_ENV` is not "production"), off Vercel;
 *   - an automated test build that talks to no agent, off Vercel: `CI` is set (every CI system sets it), or
 *     `EVE_API_URL_OPTIONAL=1` says so for a build made by hand.
 */
const truthy = (value: string | undefined): boolean => {
  const v = (value ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no" && v !== "off";
};

/** Must this process be TOLD its agent's address (no falling back to the Vercel deployment)? */
export function agentUrlRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VERCEL) return true;
  if (env.NODE_ENV !== "production") return false;
  if (truthy(env.CI) || truthy(env.EVE_API_URL_OPTIONAL)) return false;
  return true;
}

export class AgentUrlNotConfiguredError extends Error {
  constructor(detail: string) {
    super(
      `${detail}\n` +
        "  This web app will not fall back to any default agent address: chat would silently go somewhere else.\n" +
        "  Set this to the address of YOUR agent API (for example http://127.0.0.1:18210), in the environment\n" +
        "  of the build AND of the running server:\n" +
        "      NEXT_PUBLIC_EVE_API_URL=<agent address>\n" +
        "  If you also set EVE_API_URL, give it the same address.\n" +
        "  (A test build that talks to no agent can set EVE_API_URL_OPTIONAL=1 instead.)",
    );
    this.name = "AgentUrlNotConfiguredError";
  }
}

/**
 * What stands in for a missing address: the local development agent where that is right, an error where it is not
 * ({@link agentUrlRequired}).
 */
function fallbackAgentUrl(env: NodeJS.ProcessEnv): string {
  if (agentUrlRequired(env)) {
    throw new AgentUrlNotConfiguredError("The agent's address is not configured (NEXT_PUBLIC_EVE_API_URL and EVE_API_URL are unset or unusable).");
  }
  return DEFAULT_AGENT_URL;
}

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
 * The agent's base URL, or the local development stand-in.
 *
 * Never returns "" — a caller that concatenates onto an empty base builds a
 * request against its own origin and gets a confusing 404 from itself rather
 * than a clear "the agent is not configured".
 *
 * On Vercel, and in a production build or server, there is no default: it throws
 * (see {@link agentUrlRequired}). next.config.ts calls this when the build
 * starts and again when the server starts, so that is where it stops.
 *
 * There it also refuses `EVE_API_URL` without a matching
 * `NEXT_PUBLIC_EVE_API_URL`. `EVE_API_URL` is read here, for the rewrite; six
 * server modules read `NEXT_PUBLIC_EVE_API_URL` themselves (the workflow
 * delegate, the thread relay, the queue…) and treat a missing one as "no
 * agent". The first without the second is a deployment where chat is proxied
 * and workflows, cancels and queued messages are not; two different values are
 * two different agents. `NEXT_PUBLIC_EVE_API_URL` alone is complete.
 */
export function agentBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const preferred = normalizeAgentUrl(env.EVE_API_URL);
  const legacy = normalizeAgentUrl(env.NEXT_PUBLIC_EVE_API_URL);
  if (agentUrlRequired(env) && preferred !== null && preferred !== legacy) {
    throw new AgentUrlNotConfiguredError(
      legacy !== null
        ? `EVE_API_URL (${preferred}) and NEXT_PUBLIC_EVE_API_URL (${legacy}) name different agents.`
        : "EVE_API_URL is set but NEXT_PUBLIC_EVE_API_URL is not (or is unusable), and most of the server reads the second.",
    );
  }
  return preferred ?? legacy ?? fallbackAgentUrl(env);
}

/**
 * The fallback for a module that reads `NEXT_PUBLIC_EVE_API_URL` itself and used to write one deployment's address
 * after `??` (the session proxy, app/eve/v1/session/[...segments]/route.ts). It is {@link agentBaseUrl}: the
 * configured agent, the local development stand-in, or the error.
 */
export function agentUrlFallback(env: NodeJS.ProcessEnv = process.env): string {
  return agentBaseUrl(env);
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

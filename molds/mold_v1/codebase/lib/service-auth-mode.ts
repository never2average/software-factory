/**
 * HOW THE WEB APP PROVES IT IS THE WEB APP when it calls the agent as a service (lib/session-token-kinds.ts has the
 * whole story). One setting, read the same way by the web app (which mints) and the agent (which admits):
 *
 *   SERVICE_AUTH unset / empty / "vercel-oidc"   Vercel's own OIDC token and nothing else. Today's behaviour.
 *   SERVICE_AUTH=session-key                     also the short-lived token the web app signs with the session key
 *                                                pair. For a deployment that is not on Vercel.
 *
 * Only that exact value turns it on. Anything unrecognised is the default, said once in the log, so a typo closes
 * the new door rather than opening it. Dependency-free: the agent, the web app and plain-node tests all load it.
 */
import { SERVICE_AUTH_ENV, SERVICE_AUTH_SESSION_KEY } from "./session-token-kinds.ts";

export type ServiceAuthMode = "vercel-oidc" | typeof SERVICE_AUTH_SESSION_KEY;

const warned = new Set<string>();

export function serviceAuthMode(env: Record<string, string | undefined> = process.env): ServiceAuthMode {
  const raw = env[SERVICE_AUTH_ENV]?.trim().toLowerCase() ?? "";
  if (raw === SERVICE_AUTH_SESSION_KEY) return SERVICE_AUTH_SESSION_KEY;
  if (raw && raw !== "vercel-oidc" && !warned.has(raw)) {
    warned.add(raw);
    console.warn(
      `[service-auth] ${SERVICE_AUTH_ENV}=${JSON.stringify(raw)} is not a known value (use "${SERVICE_AUTH_SESSION_KEY}", or leave it unset). Using the default.`,
    );
  }
  return "vercel-oidc";
}

/** Is the session-key service identity on in this process? */
export const sessionKeyServiceAuth = (env: Record<string, string | undefined> = process.env): boolean =>
  serviceAuthMode(env) === SERVICE_AUTH_SESSION_KEY;

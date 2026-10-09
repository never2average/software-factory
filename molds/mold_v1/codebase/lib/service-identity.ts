/**
 * THE WEB APP'S SERVICE IDENTITY — what the crons, the on-demand run trigger and the run-cancel fan-out present to the
 * agent. One place, so the five routes that need it cannot drift apart.
 *
 * DEFAULT (`SERVICE_AUTH` unset — every Vercel deployment today). Exactly what each route did itself before this
 * module existed: the Vercel OIDC token of this invocation (`x-vercel-oidc-token`, which Vercel sets on every
 * function call), else `VERCEL_OIDC_TOKEN` from the environment (local development after `vercel env pull`), else
 * none. Nothing is minted.
 *
 * `SERVICE_AUTH=session-key` (a deployment that is not on Vercel). Vercel's token is still preferred where there is
 * one. Where there is none, the web app signs its own two-minute service token with the session key pair
 * (lib/auth-session.ts `mintWebServiceToken`). Because that token is short-lived and a workflow step can run for
 * minutes, the identity is handed on as a SOURCE — a function that mints a fresh token for each call — never as one
 * token to be reused until it expires.
 *
 * The request header is honoured only ON Vercel in that mode: there Vercel sets it; anywhere else it is a header any
 * client can send, and although the agent would refuse a made-up token, taking it would stop the real identity from
 * being used.
 *
 * None of this reads the caller's own credentials. The routes that use it have already decided the caller may ask
 * (the cron secret, or a signed-in member of the workspace); this only says who the WEB APP is.
 */
import { emailSignInConfigured, mintWebServiceToken } from "./auth-session.ts";
import { sessionKeyServiceAuth } from "./service-auth-mode.ts";

/** A bearer for the agent: one token, or a source that mints a fresh one per call. */
export type ServiceBearer = string | (() => Promise<string>);

/** The token to send on ONE call. A source is asked every time, so a short-lived token is never reused stale. */
export async function bearerToken(bearer: ServiceBearer): Promise<string> {
  return typeof bearer === "string" ? bearer : bearer();
}

/** True for a minted service identity (which names no person), false for a plain token. */
export const isServiceSource = (bearer: ServiceBearer): bearer is () => Promise<string> => typeof bearer === "function";

const mintedSource = async (): Promise<string> => {
  const token = await mintWebServiceToken();
  if (!token) throw new Error("The web app could not sign its service token (AUTH_JWT_PRIVATE_KEY is not configured).");
  return token;
};

/** The web app's service identity for this request, or null when it has none. */
export function serviceBearerFor(
  request: { headers: { get(name: string): string | null } },
  env: Record<string, string | undefined> = process.env,
): ServiceBearer | null {
  if (!sessionKeyServiceAuth(env)) {
    // Today's behaviour, byte for byte.
    return request.headers.get("x-vercel-oidc-token") ?? env.VERCEL_OIDC_TOKEN ?? null;
  }
  const oidc = (env.VERCEL ? request.headers.get("x-vercel-oidc-token") : null) ?? env.VERCEL_OIDC_TOKEN ?? null;
  if (oidc) return oidc;
  return emailSignInConfigured() ? mintedSource : null;
}

/** Why there is no service identity, in words an operator can act on. */
export function noServiceBearerReason(env: Record<string, string | undefined> = process.env): string {
  return sessionKeyServiceAuth(env)
    ? "SERVICE_AUTH=session-key is set but the web app cannot sign its service token (AUTH_JWT_PRIVATE_KEY is not configured)."
    : "VERCEL_OIDC_TOKEN unset";
}

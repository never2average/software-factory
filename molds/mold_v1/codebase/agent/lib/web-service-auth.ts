/**
 * The agent's door for the WEB APP'S OWN SERVICE TOKEN (lib/auth-session.ts `mintWebServiceToken`): what the web app
 * presents as itself where there is no Vercel OIDC token to present — a deployment that is not on Vercel, with
 * `SERVICE_AUTH=session-key` set on both sides (lib/session-token-kinds.ts, lib/service-auth-mode.ts).
 *
 * Admitted only when ALL hold:
 *   - the ES256 signature verifies with AUTH_JWT_PUBLIC_KEY (only the web app holds the private half; this project is
 *     never given it), the issuer is ours, the audience is the service one, the subject is the fixed service subject
 *     and the `kind` says so. A person's sign-in fails three of those, so it is never taken for the service; and this
 *     token fails the sign-in door's audience and kind, so it is never taken for a person;
 *   - it names no person, no session and no workspace (`email`, `sid`, `org` absent): a service token that carried
 *     one would be something else, and is refused rather than interpreted;
 *   - it is as short-lived as the web app makes it: `exp - iat` no longer than the mint's two minutes. A token signed
 *     with the right key but a long life is refused.
 *
 * WHAT IT MAY THEN DO is not decided here. agent/lib/service-scope.ts recognises the principal this door produces as
 * the same service the Vercel OIDC front-end token is, and every rule that applies to that one applies to this one
 * unchanged: it must name the workspace it acts for on every call, it starts workspace-visible steps, and it reaches
 * only sessions the platform itself runs (lib/chat-gate.ts). Nothing wider.
 *
 * The door is in the auth list only when the setting is on (agent/channels/eve.ts), and service-scope.ts checks the
 * setting again. With it unset, which is every Vercel deployment today, this token is refused like any unknown one.
 */
import { jwtEcdsa } from "eve/channels/auth";
import {
  WEB_SERVICE_TOKEN_AUDIENCE,
  WEB_SERVICE_TOKEN_KIND,
  WEB_SERVICE_TOKEN_SUBJECT,
  WEB_SERVICE_TOKEN_TTL_SECONDS,
} from "../../lib/session-token-kinds.ts";
import { claimsOf } from "./queue-delivery-auth.ts";

type AuthResult = Awaited<ReturnType<ReturnType<typeof jwtEcdsa>>>;
type AuthFn = (request: Request) => Promise<AuthResult>;

/** Claims a service token never carries. */
const PERSON_OR_SCOPE_CLAIMS = ["email", "sid", "org", "act"] as const;

export function webServiceAuth(publicKey: string): AuthFn {
  const verify = jwtEcdsa({
    algorithm: "ES256",
    publicKey,
    issuer: "delivered",
    audiences: [WEB_SERVICE_TOKEN_AUDIENCE],
    subjects: [WEB_SERVICE_TOKEN_SUBJECT],
    claims: { kind: [WEB_SERVICE_TOKEN_KIND] },
    clockSkewSeconds: 5,
  });
  return async (request) => {
    const auth = await verify(request);
    if (!auth) return null;
    // Verified above; only now are its claims read, for the checks the verifier has no option for.
    const claims = claimsOf(request);
    if (!claims) return null;
    if (PERSON_OR_SCOPE_CLAIMS.some((name) => claims[name] !== undefined)) return null;
    const { iat, exp } = claims;
    if (typeof iat !== "number" || typeof exp !== "number") return null;
    if (exp - iat > WEB_SERVICE_TOKEN_TTL_SECONDS) return null;
    return auth;
  };
}

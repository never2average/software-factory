/**
 * Our own sign-in tokens, for people Google cannot vouch for.
 *
 * Everything else in this platform authenticates with a Google ID token. That
 * works right up until you need to invite someone whose email is not a Google
 * Workspace account — a gmail.com address, a contractor on a domain with no
 * Workspace, anyone at all. Those invites were being created and emailed and
 * then refused at the door, because a personal account carries no `hd` claim.
 * This is the second door: a code to their inbox, then a token we sign.
 *
 * ES256, NOT HS256, and that is the important decision here. The token has to
 * be verified in three places — the Next proxy (Edge runtime), the ops routes
 * (Node), and the eve agent (a different Vercel project) — and only ONE place
 * mints. With a shared HMAC secret every one of those places would need the
 * key that can forge tokens, including the edge bundle. With ECDSA they need
 * only the PUBLIC key, and the private key stays in the two mint routes.
 *
 * Keys are read as PEM or base64-of-PEM. That is not gold-plating: a PEM is
 * multi-line, this project has already been burned once by an environment
 * variable whose trailing newline silently changed behaviour, and base64 is the
 * form that survives every copy-paste path into a dashboard.
 */
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
// Relative with its extension, like its neighbours that the agent and plain-node tests also load.
import {
  EMAIL_SESSION_KIND,
  WORKSPACE_STEP_GRANT_AUDIENCE,
  WORKSPACE_STEP_GRANT_KIND,
  WORKSPACE_STEP_GRANT_TTL_SECONDS,
} from "./session-token-kinds.ts";
import { QUEUE_DELIVERY_AUDIENCE, QUEUE_DELIVERY_KIND, QUEUE_DELIVERY_TTL_SECONDS, type DeliveryScope } from "./queue-delivery-token.ts";

/** Both sides of every verification must agree on these two strings. */
export const SESSION_ISSUER = "delivered";
export const SESSION_AUDIENCE = "delivered-app";
const ALG = "ES256";

/**
 * Seven days. Long enough that an invited collaborator is not re-authenticating
 * every morning, short enough that a stolen token expires on its own.
 *
 * Note what this token does and does NOT carry: it proves an email address and
 * nothing else. Workspace membership is read from the database on every single
 * request (lib/org-context.ts), so leaving a workspace takes effect immediately
 * even though the token in the browser is still valid — there is no stale
 * grant baked into it.
 */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** A PEM, or base64 of one. Empty/unset returns null so callers can fail soft. */
function readKeyMaterial(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (value.includes("-----BEGIN")) return value.replace(/\\n/g, "\n");
  try {
    // `atob`, not Buffer: this module is imported by proxy.ts, which runs on the
    // Edge runtime. Buffer is a Node built-in and reaching for it here is how a
    // gate starts throwing in production while every local test passes.
    const decoded = atob(value.replace(/\s+/g, ""));
    return decoded.includes("-----BEGIN") ? decoded : null;
  } catch {
    return null;
  }
}

/** True when this deployment can mint email sessions at all. */
export function emailSignInConfigured(): boolean {
  return Boolean(readKeyMaterial(process.env.AUTH_JWT_PRIVATE_KEY));
}

/** True when this deployment can verify them (public key present). */
export function emailSessionVerifiable(): boolean {
  return Boolean(readKeyMaterial(process.env.AUTH_JWT_PUBLIC_KEY));
}

export async function mintSessionToken(
  email: string,
  /**
   * The workspace this token acts for.
   *
   * Used by workflow steps. A step used to forward the operator's own bearer,
   * so the agent re-resolved the workspace from their identity — and for anyone
   * in two workspaces that is a coin toss decided by whichever they last
   * clicked. The run knows which workspace it belongs to; putting it in the
   * TOKEN makes it verifiable at the far end instead of a sentence in a prompt
   * the model is asked to forward faithfully.
   *
   * It is a claim, not an authorisation: the agent still checks membership
   * before honouring it (agent/lib/org-context.ts).
   */
  opts?: { org?: string },
): Promise<string> {
  const pem = readKeyMaterial(process.env.AUTH_JWT_PRIVATE_KEY);
  if (!pem) throw new Error("Email sign-in is not configured (AUTH_JWT_PRIVATE_KEY).");
  const key = await importPKCS8(pem, ALG);
  return new SignJWT({
    email: email.toLowerCase(),
    kind: EMAIL_SESSION_KIND,
    ...(opts?.org ? { org: opts.org } : {}),
  })
    .setProtectedHeader({ alg: ALG })
    .setSubject(email.toLowerCase())
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(key);
}

/**
 * A grant letting the session `email` is about to create be WORKSPACE-visible (a workflow/app/cron step — see
 * lib/session-token-kinds.ts). Not a sign-in: its own kind and audience, two minutes, and the agent honours it only
 * alongside a verified token for the same email. Returns null when this deployment cannot sign (no private key); the
 * step is then private to its initiator, which is the safe side.
 */
export async function mintWorkspaceStepGrant(email: string): Promise<string | null> {
  const pem = readKeyMaterial(process.env.AUTH_JWT_PRIVATE_KEY);
  const who = email.trim().toLowerCase();
  if (!pem || !who) return null;
  const key = await importPKCS8(pem, ALG);
  return new SignJWT({ email: who, kind: WORKSPACE_STEP_GRANT_KIND })
    .setProtectedHeader({ alg: ALG })
    .setSubject(who)
    .setIssuer(SESSION_ISSUER)
    .setAudience(WORKSPACE_STEP_GRANT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${WORKSPACE_STEP_GRANT_TTL_SECONDS}s`)
    .sign(key);
}

/**
 * A QUEUE-DELIVERY token — what the server signs to send a queued chat message for someone whose tab is closed
 * (lib/chat-queue-drain.ts). It is NOT a sign-in, and cannot be used as one:
 *
 *   - its own audience (`QUEUE_DELIVERY_AUDIENCE`) and `kind`, so `verifySessionToken` — every web-app route —
 *     refuses it, and only the agent's channel accepts it (agent/lib/queue-delivery-auth.ts);
 *   - bound to ONE eve session (`sid`) and ONE action (`act`): `read` its stream, or `post` the claimed queued item
 *     — once (`seq`, recorded on the claim), with exactly that item's text as the body (see queue-delivery-token.ts);
 *   - two minutes long, with a `jti`.
 *
 * It names the person and the workspace the message was queued in, so the turn runs as them, in it.
 */

export async function mintQueueDeliveryToken(
  email: string,
  input: { org: string; sessionId: string; scope: DeliveryScope },
): Promise<string> {
  const pem = readKeyMaterial(process.env.AUTH_JWT_PRIVATE_KEY);
  if (!pem) throw new Error("Email sign-in is not configured (AUTH_JWT_PRIVATE_KEY).");
  const key = await importPKCS8(pem, ALG);
  const scope = input.scope;
  return new SignJWT({
    email: email.toLowerCase(),
    kind: QUEUE_DELIVERY_KIND,
    org: input.org,
    sid: input.sessionId,
    act: scope.act,
    ...(scope.act === "post" ? { item: scope.item, claim: scope.claim, seq: scope.seq } : {}),
  })
    .setProtectedHeader({ alg: ALG })
    .setSubject(email.toLowerCase())
    .setIssuer(SESSION_ISSUER)
    .setAudience(QUEUE_DELIVERY_AUDIENCE)
    .setJti(scope.act === "post" ? `${scope.claim}:${scope.seq}` : crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${QUEUE_DELIVERY_TTL_SECONDS}s`)
    .sign(key);
}

/**
 * Verify one of our tokens. Returns the email, or null for anything else —
 * including a Google token, which is the common case at every call site that
 * tries both. Never throws: callers use it as one branch of a union.
 */
export async function verifySessionToken(token: string | null | undefined): Promise<string | null> {
  const pem = readKeyMaterial(process.env.AUTH_JWT_PUBLIC_KEY);
  if (!pem || !token) return null;
  try {
    const key = await importSPKI(pem, ALG);
    const { payload } = await jwtVerify(token, key, {
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      algorithms: [ALG],
    });
    if (payload.kind !== EMAIL_SESSION_KIND) return null;
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    return email || null;
  } catch {
    return null;
  }
}

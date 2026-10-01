import { createRemoteJWKSet, jwtVerify } from "jose";
import { verifySessionToken } from "@/lib/auth-session";
import { compatEnv } from "../agent/lib/compat-env";
import { PRODUCT_NAME } from "@/lib/deployment-profile.generated";
import { W } from "@/lib/ui-words";

/**
 * Who is allowed to call the Ops API (`/api/ops/*`).
 *
 * One kind of caller, one way to verify — this is the whole access-control story
 * for connectors, workflows and crons, which used to be an open door:
 *
 *  - a person with an `@onfinance.in` Google identity, presenting a Google ID
 *    token — from the browser (the app already holds `workspace-google-token`) or from
 *    the setup MCP after `workspace-login`. It is verified against Google's JWKS the
 *    same way the agent verifies it (audience = one of our OAuth clients, hosted
 *    domain = onfinance.in), so a forged "hd: onfinance.in" JWT does not pass —
 *    the signature has to be Google's.
 *
 * Anything else is refused. There is deliberately no shared service key: every
 * caller is a real, named human. Runs on the edge (middleware), so it uses jose +
 * Web Crypto, no Node built-ins.
 */
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
/** Google's signing keys. Only a test replaces them ({@link __setGoogleKeysForTest}), with keys it made itself. */
let googleKeys: Parameters<typeof jwtVerify>[1] = GOOGLE_JWKS;

/**
 * The OAuth clients whose ID tokens we accept — a token's `aud` must be one of
 * these. Two, because two front doors mint tokens for the same @onfinance.in
 * people:
 *   - the WEB One Tap client (NEXT_PUBLIC_GOOGLE_CLIENT_ID), used by the browser;
 *   - the CLI/desktop client used by `workspace-login` for the setup MCP.
 * Client IDs are public (the web one already ships in the browser bundle), so
 * listing the CLI one here is not a secret — the client SECRET never appears in
 * this repo.
 */
/** The desktop client `workspace-login`/`workspace-mcp` use (current, External-consent project). */
/**
 * Consumer mail domains. Google does not attach an `hd` claim to these, so the
 * check above already excludes them — this is the second lock, for the case
 * where a token carries an `hd` that happens to name one.
 */
/**
 * Personal-account domains. Sign-in refuses these outright, so anything that
 * mints an invite should refuse them too — otherwise it creates a member row
 * for someone who can never authenticate, and the invite dies silently.
 */
export const CONSUMER_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
]);

const CLI_CLIENT_ID = "865110163807-dsiua8j7v253dqngcccechjbc4a14scp.apps.googleusercontent.com";
/**
 * The PREVIOUS desktop client, from the legacy Internal-consent project. Still
 * admitted so an engineer who hasn't re-run `workspace-login` isn't cut off mid-flight;
 * drop it once everyone has (their stored refresh token pins them to whichever
 * client minted it).
 */
const LEGACY_CLI_CLIENT_ID = "1086316340555-c5igmjvsqbg5oqgmiqn282h5538nsv3t.apps.googleusercontent.com";
/**
 * Optional extra audience, for rotating the CLI client without a code change.
 *
 * Read through compatEnv: this was `FDE_CLI_CLIENT_ID`, and it is the one
 * renamed variable that DEPLOYED code reads. Dropping the old name outright
 * would silently narrow the accepted audiences on any project that still sets
 * it — every CLI-minted token 401s, with nothing on screen saying why, which is
 * the exact outage scripts/check-gates.mjs exists to catch.
 */
const EXTRA_CLI_CLIENT_ID = compatEnv("WORKSPACE_CLI_CLIENT_ID");
const acceptedAudiences = (): string[] =>
  [
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
    CLI_CLIENT_ID,
    LEGACY_CLI_CLIENT_ID,
    EXTRA_CLI_CLIENT_ID,
  ].filter((a): a is string => Boolean(a));

export type OpsIdentity = {
  kind: "user";
  email: string;
  /**
   * The token's Google Workspace `hd` claim (hosted domain), when present.
   * Consumer accounts have none. This is what the Node-side org resolver maps
   * to a workspace — see `lib/org-context.ts`. Populated for backward-compat;
   * the identity gate itself is unchanged.
   */
  hostedDomain?: string;
};

/** Verify an `Authorization: Bearer …` header. Returns the identity, or null. */
/**
 * Why a token was refused.
 *
 * These are facts about the CALLER'S OWN token, so returning them leaks
 * nothing — and without them every rejection is an identical silent 401. A
 * workspace owner spent a morning locked out of an account they had used an
 * hour earlier because the only signal was "Sign in with your @onfinance.in
 * account", which was both wrong for their domain and un-actionable.
 */
export type AuthFailure =
  | "no-token"
  | "no-audience-configured"
  | "email-unverified"
  | "no-email"
  | "not-a-workspace-account"
  | "consumer-domain"
  | "invalid-token";

/**
 * Our own email-session token, as a SECOND way in.
 *
 * A Google ID token proves a Google account. It cannot prove a gmail.com
 * invitee (no `hd` claim) and cannot prove anyone without Google at all, so
 * every invite to such an address was created, emailed, and then refused here.
 * `lib/auth-session.ts` mints an ES256 token after a code goes to their inbox;
 * this admits it.
 *
 * What it does NOT do is grant anything. It establishes an email address, and
 * `hostedDomain` stays undefined, so the identity resolves through exactly the
 * same membership lookup as everyone else (lib/org-context.ts): an address with
 * no membership and no invite lands in an isolated empty workspace, precisely
 * as an unrecognised Workspace account does today. Admission is not access.
 */
async function verifyEmailSession(bearer: string): Promise<OpsIdentity | null> {
  const email = await verifySessionToken(bearer);
  return email ? { kind: "user", email } : null;
}

/** Human-readable, safe to show the person who presented the token. */
export function explainAuthFailure(reason: AuthFailure, email?: string): string {
  switch (reason) {
    case "no-token":
      return "No sign-in token was sent. Sign in again.";
    case "no-audience-configured":
      return `This ${W.install} has no Google client configured, so no sign-in can be accepted.`;
    case "email-unverified":
      return "That Google account's email address is not verified.";
    case "no-email":
      return "That sign-in carried no email address.";
    case "not-a-workspace-account":
      return `${email ?? "That account"} is not a Google Workspace account. ${PRODUCT_NAME} admits work accounts only — a personal Google account on a custom domain carries no workspace claim and cannot sign in.`;
    case "consumer-domain":
      return "Personal Google accounts (gmail.com and similar) are not admitted.";
    case "invalid-token":
      return "That sign-in could not be verified — it may have expired. Sign in again.";
  }
}

/**
 * The same check as {@link verifyOpsAuth}, but says WHY when it refuses.
 */
export async function verifyOpsAuthResult(
  bearer: string | null,
): Promise<{ ok: true; identity: OpsIdentity } | { ok: false; reason: AuthFailure; email?: string }> {
  const detail: { reason: AuthFailure; email?: string } = { reason: "invalid-token" };
  const identity = await verifyOpsAuth(bearer, detail);
  if (identity) return { ok: true, identity };
  return { ok: false, reason: detail.reason, email: detail.email };
}

/** Records why we refused, for the caller that asked. Always returns null so
 *  it can be used directly in a `return` and the control flow stays flat. */
function fail(
  detail: { reason: AuthFailure; email?: string } | undefined,
  reason: AuthFailure,
  email?: string,
): null {
  if (detail) {
    detail.reason = reason;
    if (email) detail.email = email;
  }
  return null;
}

export async function verifyOpsAuth(
  authHeader: string | null,
  /** Optional out-param: set to the reason when this returns null. */
  detail?: { reason: AuthFailure; email?: string },
): Promise<OpsIdentity | null> {
  const bearer = authHeader?.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return fail(detail, "no-token");

  // Our own email-session token first — it is cheap (local public-key verify,
  // no network) and unambiguous, and a token that is one of ours is never also
  // a valid Google one. Anything else falls through to Google below.
  const session = await verifyEmailSession(bearer);
  if (session) return session;

  // A Google ID token, signature-verified against Google — from the browser
  // (web client) or `workspace-login` (CLI client). No other way in.
  const audiences = acceptedAudiences();
  if (audiences.length === 0) return fail(detail, "no-audience-configured");
  try {
    const { payload } = await jwtVerify(bearer, googleKeys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: audiences,
    });
    if (payload.email_verified === false) return fail(detail, "email-unverified");
    const email = typeof payload.email === "string" ? payload.email : "";
    const hostedDomain = typeof payload.hd === "string" ? payload.hd : undefined;

    // Admission gate. WHO can read WHAT is decided downstream by org membership
    // (lib/org-context.ts) — this only decides which validly-signed Google
    // tokens reach the Node layer at all. An unrecognized work email resolves to
    // its OWN empty workspace there, never onfinance's data.
    //
    if (!email) return fail(detail, "no-email");
    // WORK ACCOUNTS ONLY, in every mode.
    //
    // A Google `hd` (hosted-domain) claim marks a managed Workspace account. A
    // personal account has none, so the presence of `hd` is the test — not a
    // list of banned domains, which would be a losing game.
    //
    // This used to be skipped entirely under OPS_MULTI_TENANT=1, on the theory
    // that multi-tenant meant "admit anyone and let org membership decide". It
    // does not: a consumer account admitted here gets an isolated workspace and
    // a foothold on the API, and self-serve onboarding will happily create an
    // org for it. Multi-tenant should widen WHICH work domains are allowed, not
    // stop asking whether it is a work account at all.
    if (!hostedDomain) return fail(detail, "not-a-workspace-account", email);
    // Belt and braces: Google will not issue `hd` for these, but a domain that
    // merely LOOKS managed should not get in on the strength of the claim alone.
    if (CONSUMER_DOMAINS.has(hostedDomain.toLowerCase())) return fail(detail, "consumer-domain", email);
    if (CONSUMER_DOMAINS.has(email.split("@")[1]?.toLowerCase() ?? "")) return fail(detail, "consumer-domain", email);
    return { kind: "user", email, hostedDomain };
  } catch {
    return null;
  }
}

/**
 * A Google ID token's VERIFIED address, whatever kind of Google account it is — for the one door that needs it: a GUEST
 * of one shared chat signing in with Google (app/api/auth/guest/google).
 *
 * The same signature, issuer and audience checks as {@link verifyOpsAuth}. What it does not require is a Workspace
 * (`hd`) account: the guest door accepts a Google sign-in ONLY when this address is the invited one, and then hands
 * back our own email-session token for that address, so no Google token is ever admitted here on its own. Returns
 * null for anything Google did not sign for one of our clients, or whose address Google has not verified.
 */
export async function verifiedGoogleAddress(
  credential: string | null | undefined,
): Promise<{ email: string; hostedDomain?: string } | null> {
  const token = credential?.trim();
  const audiences = acceptedAudiences();
  if (!token || audiences.length === 0) return null;
  try {
    const { payload } = await jwtVerify(token, googleKeys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: audiences,
    });
    // Strictly true: an absent claim is not a verified address.
    if (payload.email_verified !== true && payload.email_verified !== "true") return null;
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!email) return null;
    return { email, ...(typeof payload.hd === "string" ? { hostedDomain: payload.hd } : {}) };
  } catch {
    return null;
  }
}

/** Test seam: verify Google tokens against keys the test made (a JWKS or key function). Null restores Google's. */
export function __setGoogleKeysForTest(keys: Parameters<typeof jwtVerify>[1] | null): void {
  googleKeys = keys ?? GOOGLE_JWKS;
}

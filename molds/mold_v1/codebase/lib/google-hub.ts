/**
 * THE GOOGLE SIGN-IN HUB: ONE ADDRESS GOOGLE ALREADY KNOWS SIGNS PEOPLE IN FOR ADDRESSES IT DOES NOT.
 *
 * Google hands a sign-in only to an address written, by hand, on the OAuth client's page in Google Cloud Console
 * ("Authorised JavaScript origins" for the Google button, "Authorised redirect URIs" for the full-page flow). There
 * is no API for adding one. A deployment that shares its client with others therefore came up with a "Continue with
 * Google" button that could not work until a person edited that page, and nothing said so.
 *
 * With a hub, the address Google knows does the Google part for the others:
 *
 *   1. the app (AUTH_GOOGLE_HUB_ORIGIN names its hub) makes a `state` and a `nonce`, keeps both in an httpOnly cookie
 *      for ten minutes, and sends the browser to `<hub>/auth/google-hub?return=<its own origin>&state=…&nonce=…`
 *      (app/api/auth/google-hub/start);
 *   2. the hub (AUTH_GOOGLE_HUB_ALLOWED_RETURNS lists who may ask) shows who is asking and the Google button, bound
 *      to that nonce (app/auth/google-hub);
 *   3. Google's ID token goes back to the app in the BODY of a form POST to one fixed path, never in an address
 *      (app/api/auth/google-hub/callback);
 *   4. the app verifies the token as it verifies every Google sign-in (signature, audience = its own client, issuer,
 *      expiry), and also that the token's nonce and the posted state are the ones in its cookie. Then the browser
 *      holds the same sign-in it would hold after the direct flow.
 *
 * WHAT HOLDS IT TOGETHER, each asserted by scripts/test-google-hub.mjs:
 *   - the hub answers only an origin on its allow-list: exact origins, https, no wildcard, and the path the token is
 *     posted to is written here, not taken from the request, so the hub is never an open redirect or a token relay;
 *   - the nonce is in the token Google signed, so a token minted for another app, session or flow is refused;
 *   - the state, which only this browser's cookie holds, stops a sign-in started elsewhere being finished here;
 *   - the token is never put in a query string and never logged;
 *   - the hub page cannot be framed, and it names the address the person is signing in to.
 *
 * Every deployment ships both halves. The hub half is OFF unless its allow-list is set; the app half is off unless
 * its hub is set. An app Google knows directly never uses the hub (lib/google-sign-in-mode.ts decides).
 *
 * This file is the rules only: no I/O, no Node built-ins (proxy.ts reads the two paths on the Edge runtime), and
 * loadable by plain-node tests.
 */
type Env = Record<string, string | undefined>;

/** Where the hub shows its page. */
export const HUB_PAGE_PATH = "/auth/google-hub";
/** Where an app starts a sign-in through its hub. */
export const HUB_START_PATH = "/api/auth/google-hub/start";
/** Where the hub posts the token: the app's side, fixed here. A caller never chooses it. */
export const HUB_CALLBACK_PATH = "/api/auth/google-hub/callback";
/** Where a hub says whether it will answer an origin. */
export const HUB_STATUS_PATH = "/api/auth/google-hub/status";

/** How long a started sign-in may take, in seconds. */
export const HUB_FLOW_SECONDS = 600;
/** The OAuth `state` prefix of a full-page Google round trip the hub page started (see {@link encodeHubRoundTrip}). */
export const HUB_ROUND_TRIP_PREFIX = "hub.";
/** The query parameter the app's page reads when a hub sign-in was refused. */
export const HUB_ERROR_PARAM = "sign_in_error";

/** Why a hub sign-in was refused, as the app's page is told. Never anything from the token. */
export type HubRefusal = "expired" | "state" | "origin" | "token" | "nonce" | "off" | "incomplete";

export function explainHubRefusal(code: string | null | undefined): string | null {
  switch (code) {
    case "expired":
      return "That sign-in took too long or was started in another tab. Please try again.";
    case "state":
    case "nonce":
    case "origin":
      return "That sign-in could not be matched to this browser, so it was not accepted. Please try again.";
    case "token":
      return "Google's answer could not be verified. Please try again, or sign in with a code sent to your email.";
    case "off":
    case "incomplete":
      return "Google sign-in is not available here right now. Sign in with a code sent to your email.";
    default:
      return null;
  }
}

const isProduction = (env: Env): boolean => env.NODE_ENV === "production";

/**
 * A setting that is exactly one origin, or null. https only; http is accepted for a loopback address and only outside
 * a production build (local development and the tests). No path, query, fragment, credentials or wildcard, and the
 * text must already be the origin's canonical form (`https://Example.com/` is refused, not tidied): an allow-list
 * that quietly normalises is one whose entries nobody can read with certainty.
 */
export function exactOrigin(text: string | null | undefined, env: Env = process.env): string | null {
  const raw = (text ?? "").trim();
  if (!raw || raw.length > 300 || raw.includes("*")) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.origin !== raw) return null;
  if (url.protocol === "https:") return raw;
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && loopback && !isProduction(env)) return raw;
  return null;
}

export interface AllowedReturn {
  /** The exact origin, as written in the allow-list. */
  origin: string;
  /** Its host, shown to the person on the hub page. */
  host: string;
  /** The name the hub's operator wrote for it (`origin=Name`), or null. Never anything the caller sent. */
  label: string | null;
}

/**
 * The hub's allow-list: AUTH_GOOGLE_HUB_ALLOWED_RETURNS, entries separated by commas or new lines, each an exact
 * origin and optionally `=A name to show` after it. An entry that is not an exact https origin is DROPPED, never
 * repaired, and `invalid` lists what was dropped so a check can say so.
 */
export function allowedReturns(env: Env = process.env): { list: AllowedReturn[]; invalid: string[] } {
  const list: AllowedReturn[] = [];
  const invalid: string[] = [];
  for (const entry of (env.AUTH_GOOGLE_HUB_ALLOWED_RETURNS ?? "").split(/[,\n]+/)) {
    const text = entry.trim();
    if (!text) continue;
    const eq = text.indexOf("=");
    const origin = exactOrigin(eq === -1 ? text : text.slice(0, eq), env);
    if (!origin) {
      invalid.push(text.slice(0, 80));
      continue;
    }
    if (list.some((e) => e.origin === origin)) continue;
    // A name is plain words: letters, digits, spaces and a few marks. Anything else and the entry has no name.
    const name = eq === -1 ? "" : text.slice(eq + 1).trim();
    const label = name && name.length <= 60 && /^[\p{L}\p{N} .&'()+-]+$/u.test(name) ? name : null;
    list.push({ origin, host: new URL(origin).host, label });
  }
  return { list, invalid };
}

/** True when this deployment answers as a hub at all. */
export function hubEnabled(env: Env = process.env): boolean {
  return allowedReturns(env).list.length > 0;
}

/**
 * The allow-list entry for what a caller sent as `return`, or null. The comparison is of the two STRINGS: the caller's
 * text is not parsed, trimmed or normalised first, so nothing that merely resolves to an allowed origin
 * (`https://app.example@evil.example`, a trailing slash, a path, other letter case) passes.
 */
export function allowedReturn(value: string | null | undefined, env: Env = process.env): AllowedReturn | null {
  if (typeof value !== "string" || !value) return null;
  return allowedReturns(env).list.find((e) => e.origin === value) ?? null;
}

/** Where the token is posted for an allowed return. The path is this code's, whatever the caller asked for. */
export function callbackUrlFor(entry: AllowedReturn): string {
  return `${entry.origin}${HUB_CALLBACK_PATH}`;
}

/** The hub this deployment delegates Google sign-in to (AUTH_GOOGLE_HUB_ORIGIN), or null. */
export function hubOriginSetting(env: Env = process.env): string | null {
  return exactOrigin(env.AUTH_GOOGLE_HUB_ORIGIN, env);
}

/** A `state` or `nonce` as this code makes them: 32 random bytes, base64url. Anything else is refused on sight. */
export function validHubValue(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

export function randomHubValue(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64url(text: string): string | null {
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}
const encodeText = (text: string): string => base64url(new TextEncoder().encode(text));

/** Compare two strings without stopping at the first difference. */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Where on THIS site the person goes once signed in: a path that starts with one slash. Anything else (another
 * site, `//host`, a backslash trick, control characters) is the home page.
 */
export function safeBackPath(value: string | null | undefined): string {
  const path = typeof value === "string" ? value : "";
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 2000) return "/";
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return "/";
  return path;
}

/**
 * The cookie that holds a started sign-in. `__Host-` on https: the browser then accepts it only from this exact
 * host, over https, for the whole site, so a sibling subdomain cannot plant one. SameSite=None because the answer
 * arrives as a form POST from another site (the hub), and a Lax or Strict cookie is not sent with one; what protects
 * the POST is that the state inside must match, and only this browser was given it. httpOnly: no script reads it.
 */
export function hubCookieName(secure: boolean): string {
  return secure ? "__Host-google-hub" : "google-hub";
}

export interface HubFlow {
  state: string;
  nonce: string;
  back: string;
}

export function encodeHubFlow(flow: HubFlow): string {
  return `v1.${flow.state}.${flow.nonce}.${encodeText(flow.back)}`;
}

export function decodeHubFlow(value: string | null | undefined): HubFlow | null {
  const parts = (value ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, state, nonce, back] = parts;
  if (!validHubValue(state) || !validHubValue(nonce)) return null;
  const path = fromBase64url(back);
  if (path === null) return null;
  return { state, nonce, back: safeBackPath(path) };
}

export function hubCookie(value: string, secure: boolean, maxAge: number): string {
  // `Secure` always: SameSite=None requires it, and browsers accept a Secure cookie from a loopback http address.
  return `${hubCookieName(secure)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None`;
}

/** The value of one cookie in a Cookie header, or null. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/**
 * The hub page's full-page Google round trip. Google returns to the hub's home address (the one redirect address its
 * console lists) with the token in the fragment and this `state`; the home page reads which hub sign-in it belongs to
 * and goes back to the hub page with the fragment intact (app/_components/auth-gate.tsx). The hub page checks the
 * return against the allow-list again, so a forged state names nothing the list does not.
 */
export function encodeHubRoundTrip(trip: { returnTo: string; state: string; nonce: string }): string {
  return HUB_ROUND_TRIP_PREFIX + encodeText(JSON.stringify({ r: trip.returnTo, s: trip.state, n: trip.nonce }));
}

export function decodeHubRoundTrip(state: string | null | undefined): { returnTo: string; state: string; nonce: string } | null {
  if (typeof state !== "string" || !state.startsWith(HUB_ROUND_TRIP_PREFIX)) return null;
  const json = fromBase64url(state.slice(HUB_ROUND_TRIP_PREFIX.length));
  if (json === null) return null;
  try {
    const v = JSON.parse(json) as { r?: unknown; s?: unknown; n?: unknown };
    if (typeof v.r !== "string" || !validHubValue(v.s as string) || !validHubValue(v.n as string)) return null;
    return { returnTo: v.r, state: v.s as string, nonce: v.n as string };
  } catch {
    return null;
  }
}

/** The hub page's address for one sign-in. */
export function hubPageUrl(hubOrigin: string, trip: { returnTo: string; state: string; nonce: string }): string {
  const q = new URLSearchParams({ return: trip.returnTo, state: trip.state, nonce: trip.nonce });
  return `${hubOrigin}${HUB_PAGE_PATH}?${q}`;
}

/**
 * A short fingerprint of a Google client id, so an app and its hub can tell they use the same client without either
 * printing it. The id is public (it is in every page's JavaScript); this only keeps it out of answers and logs.
 */
export async function clientFingerprint(clientId: string | null | undefined): Promise<string | null> {
  const id = (clientId ?? "").trim();
  if (!id) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)));
  return [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The address the browser used for this request: what `window.location.origin` is on the page, which is what Google
 * and a hub's allow-list are asked about. Behind a reverse proxy the request's own URL can name the server's bind
 * address instead, so the forwarded host and scheme are read first, then the Host header. A caller can only lie
 * about its own request: the answer is checked against a hub's allow-list or against Google, never trusted.
 */
export function requestOrigin(request: { url: string; headers: { get(name: string): string | null } }): string {
  const url = new URL(request.url);
  const first = (name: string): string => (request.headers.get(name) ?? "").split(",")[0].trim();
  const host = first("x-forwarded-host") || first("host") || url.host;
  const proto = (first("x-forwarded-proto") || url.protocol).replace(/:$/, "");
  try {
    const built = new URL(`${proto === "https" ? "https" : "http"}://${host}`);
    return built.origin;
  } catch {
    return url.origin;
  }
}

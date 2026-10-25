/**
 * The built-in MCP authorization server (mold_v0-013): when the server signs people in itself (AUTH_PROVIDER=builtin,
 * src/builtin-auth.ts), it is also the OAuth 2.1 authorization server for /mcp, so connector apps that can only sign
 * in (Claude's and ChatGPT's connectors, VS Code), not send a header key, reach the workspace. With Clerk on nothing
 * here answers: every route passes on (next()), and Clerk's OAuth stays exactly as it was (src/http.ts, src/clerk.ts).
 *
 * The MCP authorization spec, piece by piece:
 *   protected resource metadata (RFC 9728)  /.well-known/oauth-protected-resource/mcp (path-inserted) and the root
 *                                           /.well-known/oauth-protected-resource; a 401 on /mcp names it
 *                                           (WWW-Authenticate resource_metadata=...)
 *   authorization server metadata           RFC 8414 /.well-known/oauth-authorization-server and OIDC discovery
 *                                           /.well-known/openid-configuration, issuer exactly where AI clients
 *                                           connect (APP_MCP_URL, the app's own domain, else PUBLIC_URL; mold_v0-118:
 *                                           the console forwards /.well-known and /oauth to this API, so the whole
 *                                           sign-in is on the one address); the authorization response carries iss
 *                                           (RFC 9207)
 *   clients                                 a client ID metadata document (the client_id is an https URL, fetched with
 *                                           SSRF guards: https only, no IP literals, every resolved address public, no
 *                                           redirects, 5 KB, 5 s) or, as the deprecated fallback, dynamic client
 *                                           registration (RFC 7591: rate-limited per address, ten redirect URIs at
 *                                           most, safe schemes only)
 *   authorization code + PKCE               S256 only (no PKCE, plain, or a missing method is refused); redirect URIs
 *                                           match exactly (loopback http may change port, RFC 8252); codes last two
 *                                           minutes, are used once, and a second use revokes what the first gave. An
 *                                           error before the person answers is a page, never a redirect (no open
 *                                           redirector); private-use schemes are reverse-domain or a known app's
 *   resource indicators (RFC 8707)          the resource parameter is required and must be this server's /mcp
 *                                           (mcpAudiences); the token is bound to it and /mcp checks it on every call
 *   tokens                                  opaque, random, only their sha256 stored: access tokens short-lived
 *                                           (APP_OAUTH_ACCESS_MINUTES, default 30), refresh tokens rotated on
 *                                           every use (a replayed one revokes the grant), revocation (RFC 7009)
 *   consent                                 the console's /auth/consent page, under the built-in session: it names the
 *                                           client (and whether its name is verified), where it sends the person back,
 *                                           and the workspace the token will act in; same-site JSON with the CSRF header
 *   scope                                   "mcp" (the default); a token without it gets 403 insufficient_scope on /mcp.
 *                                           A refresh may narrow it (RFC 6749 6, OAuth 2.1 4.3; mold_v0-087): the new
 *                                           access token carries only the scopes asked for, never one the refresh
 *                                           token lacks; the new refresh token keeps the old one's scope, so a later
 *                                           refresh may ask for the whole grant again, never more
 *   connected apps                          the person's grants (/api/oauth/grants: the client, the workspace, when
 *                                           allowed and last used) and revoking one; the console's Connected apps page
 *
 * A token acts as its person, with their current role, in the one workspace they chose: the membership is read live on
 * every call (src/auth.ts memberRole), so removal, suspension and role changes hold on the next request. No token,
 * code, secret or request id is ever written to a log line.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { builtinAuth } from "./auth-provider.js";
import { memberRole, type Org } from "./auth.js";
import { consoleUrl, memberships, sameSite, sessionFromRequest } from "./builtin-auth.js";
import { canonicalResource, mcpAudience, mcpAudiences } from "./clerk.js";
import { mcpUrlSetting } from "./console-url.js";
import { getDb, type Queryable } from "./db.js";
import { PROFILE } from "./profile.js";
import { hashed, hit } from "./rate-limits.js";
import { asPlatform } from "./tenant-scope.js";
import { ENV } from "./env-names.js";
import { nsGet } from "./namespace.js";

// ---------- settings ----------

export const SCOPE = "mcp";
/** Scopes a request may name: "mcp" is access to /mcp; offline_access is understood (refresh tokens are always issued). */
const KNOWN_SCOPES = new Set([SCOPE, "offline_access"]);
export const CODE_SECONDS = 120;
export const REQUEST_MINUTES = 10;
const between = (v: string | undefined, lo: number, hi: number, dflt: number) => {
  const n = Number(v ?? "");
  return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
};
export const accessMinutes = () => between(ENV.APP_OAUTH_ACCESS_MINUTES, 5, 60, 30);
export const refreshDays = () => between(ENV.APP_OAUTH_REFRESH_DAYS, 1, 90, 30);
/** Registrations from one address an hour, and clients' requests to the token endpoint from one address an hour. */
export const REGISTRATIONS_PER_HOUR_PER_IP = 20;
export const TOKEN_CALLS_PER_HOUR_PER_IP = 600;
export const AUTHORIZE_PER_HOUR_PER_IP = 120;
const MAX_REDIRECT_URIS = 10;
const MAX_URI = 2000;
const CIMD_MAX_BYTES = 5 * 1024;
const CIMD_FRESH_MS = 60 * 60_000;
const CIMD_STALE_MS = 24 * 60 * 60_000;

const ACCESS_PREFIX = "oma_", REFRESH_PREFIX = "omr_", CODE_PREFIX = "omc_";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (bytes: number) => randomBytes(bytes).toString("base64url");
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");
const P = <T>(fn: (db: Queryable & { transaction: <R>(f: (tx: Queryable) => Promise<R>) => Promise<R> }) => Promise<T>): Promise<T> =>
  asPlatform(async () => fn(await getDb()));

/**
 * The issuer: where AI clients connect, exactly (no trailing slash): APP_MCP_URL (the app's own domain) when it is set,
 * else this server's public address. Never taken from the request's Host. A client that signed in through the old
 * address keeps its grant: its refresh token is the server's own and /oauth/token answers on both addresses.
 */
export const issuer = () => mcpUrlSetting() ?? (process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3333}`).replace(/\/+$/, "");
/** Whether this server is its own authorization server for /mcp: built-in sign-in only. */
export const oauthOn = () => builtinAuth();
/** The protected resource metadata's address for /mcp (RFC 9728, path-inserted). */
export const resourceMetadataUrl = () => `${issuer()}/.well-known/oauth-protected-resource${new URL(mcpAudience()).pathname.replace(/\/+$/, "")}`;
export const isOAuthAccessToken = (t: string | null | undefined) => typeof t === "string" && t.startsWith(ACCESS_PREFIX);

// ---------- metadata ----------

export function protectedResourceMetadata() {
  return { resource: mcpAudience(), authorization_servers: [issuer()], bearer_methods_supported: ["header"], scopes_supported: [SCOPE], resource_name: PROFILE.name };
}

export function authorizationServerMetadata() {
  const i = issuer();
  const methods = ["none", "client_secret_post", "client_secret_basic"];
  return {
    issuer: i,
    authorization_endpoint: `${i}/oauth/authorize`,
    token_endpoint: `${i}/oauth/token`,
    registration_endpoint: `${i}/oauth/register`,
    revocation_endpoint: `${i}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: methods,
    revocation_endpoint_auth_methods_supported: methods,
    scopes_supported: [SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${i}/install`,
  };
}

/** The WWW-Authenticate value for a 401 on /mcp (and, with insufficient scope, a 403). */
export function wwwAuthenticate(error?: "invalid_token" | "insufficient_scope") {
  const parts = [`resource_metadata="${resourceMetadataUrl()}"`, `scope="${SCOPE}"`];
  if (error === "invalid_token") parts.unshift(`error="invalid_token", error_description="The access token is invalid, expired, revoked or for another resource"`);
  if (error === "insufficient_scope") parts.unshift(`error="insufficient_scope", error_description="This token does not carry the ${SCOPE} scope"`);
  return `Bearer ${parts.join(", ")}`;
}

// ---------- redirect URIs ----------

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
/** Schemes a redirect URI may never use (a private-use scheme of an app, such as cursor: or vscode:, is fine). */
/** One-word schemes of known MCP clients (editors and desktop apps) a redirect URI may use. */
const CLIENT_APP_SCHEMES = new Set(["cursor", "vscode", "vscode-insiders", "claude", "windsurf", "zed", "kiro", "positron"]);
const BROWSER_SCHEME = /(^|[.-])(safari|chrome|chromium|edge|firefox|opera|brave|intent|search|ms-|https?)([.-]|$)/;
const BAD_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "filesystem:", "ftp:", "ws:", "wss:", "mailto:", "tel:", "chrome:", "view-source:"]);

/** A redirect URI a client may register: https; http on a loopback host only; or an app's private-use scheme. No fragment. */
export function redirectUriOk(v: unknown): v is string {
  if (typeof v !== "string" || !v || v.length > MAX_URI || /[\u0000- \u007f\\]/.test(v)) return false;
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  if (u.hash || v.includes("#") || u.username || u.password) return false;
  if (u.protocol === "https:") return Boolean(u.hostname);
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  if (BAD_SCHEMES.has(u.protocol)) return false;
  // A private-use scheme (RFC 8252 7.1): reverse-domain (com.example.app:), or one of the few editors' and apps' own
  // one-word schemes. Anything else (a browser's or the OS's handler: x-safari-https:, googlechromes:, microsoft-edge:,
  // intent:, search-ms:) could open any web page or program, so it is refused.
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  return CLIENT_APP_SCHEMES.has(scheme) || (/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(scheme) && !BROWSER_SCHEME.test(scheme));
}

/** Exact match, except that a loopback http URI may change its port (RFC 8252 7.3). */
export function redirectMatches(registered: string[], asked: string): boolean {
  if (registered.includes(asked)) return true;
  let a: URL;
  try { a = new URL(asked); } catch { return false; }
  if (a.protocol !== "http:" || !LOOPBACK.has(a.hostname)) return false;
  return registered.some((r) => {
    try {
      const x = new URL(r);
      return x.protocol === "http:" && x.hostname === a.hostname && x.pathname === a.pathname && x.search === a.search;
    } catch { return false; }
  });
}

const cleanName = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "").trim().slice(0, 80) || null : null);

// ---------- clients ----------

type ClientRow = { id: string; kind: "dcr" | "cimd"; name: string | null; redirect_uris: string[] | string; auth_method: "none" | "client_secret_post" | "client_secret_basic";
  secret_hash: string | null; fetched_at: Date | null };
export type Client = { id: string; kind: "dcr" | "cimd"; name: string | null; redirectUris: string[]; authMethod: ClientRow["auth_method"]; secretHash: string | null };
const toClient = (r: ClientRow): Client => ({ id: r.id, kind: r.kind, name: r.name, redirectUris: typeof r.redirect_uris === "string" ? JSON.parse(r.redirect_uris) : r.redirect_uris,
  authMethod: r.auth_method, secretHash: r.secret_hash });

class OAuthError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

/** Register a client (RFC 7591), checked: redirect URIs, grant and response types, the auth method, sizes. */
export async function registerClient(body: Record<string, unknown>, ip: string) {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || !uris.length) throw new OAuthError("invalid_redirect_uri", "redirect_uris is required");
  if (uris.length > MAX_REDIRECT_URIS) throw new OAuthError("invalid_redirect_uri", `At most ${MAX_REDIRECT_URIS} redirect URIs`);
  for (const u of uris) if (!redirectUriOk(u)) throw new OAuthError("invalid_redirect_uri", "Each redirect URI must be https, http on a loopback address, or an app's own scheme, with no fragment");
  const grants = body.grant_types ?? ["authorization_code"];
  if (!Array.isArray(grants) || grants.some((g) => g !== "authorization_code" && g !== "refresh_token") || !grants.includes("authorization_code"))
    throw new OAuthError("invalid_client_metadata", "grant_types may name authorization_code and refresh_token only");
  const responses = body.response_types ?? ["code"];
  if (!Array.isArray(responses) || responses.some((r) => r !== "code")) throw new OAuthError("invalid_client_metadata", "response_types may name code only");
  const method = body.token_endpoint_auth_method ?? "none";
  if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic")
    throw new OAuthError("invalid_client_metadata", "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic");
  if (JSON.stringify(body).length > 8 * 1024) throw new OAuthError("invalid_client_metadata", "The registration is too large");
  const id = `ocl_${token(18)}`, secret = method === "none" ? null : `ocs_${token(32)}`;
  const name = cleanName(body.client_name);
  const kept = Object.fromEntries(["client_uri", "logo_uri", "software_id", "software_version"].flatMap((k) =>
    typeof body[k] === "string" && (body[k] as string).length <= 500 ? [[k, body[k]]] : []));
  await P(async (db) => {
    await db.query(
      "INSERT INTO oauth_clients (id, kind, name, redirect_uris, auth_method, secret_hash, metadata, ip_hash) VALUES ($1, 'dcr', $2, $3::jsonb, $4, $5, $6::jsonb, $7)",
      [id, name, JSON.stringify(uris), method, secret ? sha256(secret) : null, JSON.stringify(kept), hashed(ip)]);
    // Registrations nobody ever used go after a day (a cap on what a flood of them leaves behind).
    if (Math.random() < 0.05) await db.query(
      "/* tenant: platform: unused client registrations, no workspace yet */ DELETE FROM oauth_clients c WHERE c.kind = 'dcr' AND c.created_at < now() - interval '1 day' AND c.last_used_at IS NULL AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)");
    // Cached metadata documents nobody holds a grant for go after a week (they are fetched again when used).
    if (Math.random() < 0.05) await db.query(
      "/* tenant: platform: cached client documents with no grant */ DELETE FROM oauth_clients c WHERE c.kind = 'cimd' AND c.fetched_at < now() - interval '7 days' AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)");
  });
  return {
    client_id: id, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name ?? undefined, redirect_uris: uris, grant_types: grants, response_types: ["code"], token_endpoint_auth_method: method, ...kept,
  };
}

// ---------- client ID metadata documents ----------

/** Addresses a client ID metadata document may never be fetched from (private, loopback, link-local, reserved). */
const blocked = new BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const)
  blocked.addSubnet(a, p, "ipv4");
// IPv4-mapped addresses (::ffff:a.b.c.d, either spelling) are matched against the IPv4 rules by BlockList itself; a
// ::ffff:0:0/96 rule here would also match every plain IPv4 address.
for (const [a, p] of [["::", 96], ["::ffff:0:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const)
  blocked.addSubnet(a, p, "ipv6");

/** Whether an address is a public one (an IPv4-mapped IPv6 address is judged as its IPv4 address). */
export function publicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (!v) return false;
  if (v === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return publicAddress(mapped[1]!);
    return !blocked.check(ip, "ipv6");
  }
  return !blocked.check(ip, "ipv4");
}

/** A client_id that names a metadata document: https, a host name (no IP literal, not localhost), a path, nothing else. */
export function cimdUrlOk(v: string): boolean {
  if (v.length > 512 || /[\u0000- \u007f\\]/.test(v)) return false;
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  // Only a URL already in its normal form (no dot segments, lower-case host, no default port): the document must name it exactly.
  return u.href === v && u.protocol === "https:" && !u.username && !u.password && !u.hash && !v.includes("#") && u.pathname.length > 1 &&
    !isIP(host) && host !== "localhost" && !host.endsWith(".localhost") && host.includes(".") && !u.pathname.split("/").some((s) => s === "." || s === "..");
}

/** The DNS lookup used for a document fetch: every address the name resolves to must be public (DNS rebinding included). */
function guardedLookup(hostname: string, options: { all?: boolean; family?: number } | number, cb: (...a: any[]) => void) {
  const all = typeof options === "object" && Boolean(options.all);
  dnsLookup(hostname, { all: true }, (err, addrs: LookupAddress[]) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => !publicAddress(a.address))) return cb(Object.assign(new Error(`${hostname} resolves to an address that is not public`), { code: "EBLOCKED" }));
    all ? cb(null, addrs) : cb(null, addrs[0]!.address, addrs[0]!.family);
  });
}

/** Fetch a client ID metadata document: https, guarded DNS, no redirects, at most 5 KB, 5 seconds, JSON. */
async function fetchDocument(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { lookup: guardedLookup as any, agent: false, timeout: 5000, headers: { accept: "application/json", "user-agent": `${PROFILE.name} OAuth` } }, (res) => {
      if ((res.statusCode ?? 0) !== 200) { res.resume(); return reject(new Error(`answered ${res.statusCode}`)); }
      if (!/json/i.test(String(res.headers["content-type"] ?? ""))) { res.resume(); return reject(new Error("not JSON")); }
      if (Number(res.headers["content-length"] ?? 0) > CIMD_MAX_BYTES) { req.destroy(); return reject(new Error("larger than 5 KB")); }
      let size = 0; const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => { size += c.length; if (size > CIMD_MAX_BYTES) { req.destroy(new Error("larger than 5 KB")); return; } chunks.push(c); });
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("not JSON")); } });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    // A deadline for the whole fetch, not only between bytes: a server answering one byte at a time is cut off too.
    const deadline = setTimeout(() => req.destroy(new Error("took longer than 5 seconds")), 5000);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
  });
}
let fetcher: (url: string) => Promise<unknown> = fetchDocument;
/** Tests: answer document fetches without the network (the URL checks still apply before it is called). */
export const setDocumentFetcherForTest = (f: ((url: string) => Promise<unknown>) | null) => { fetcher = f ?? fetchDocument; };

/** The client a metadata document describes, fetched (or from the cache, an hour fresh), checked, and cached. */
async function documentClient(url: string): Promise<Client> {
  if (!cimdUrlOk(url)) throw new OAuthError("invalid_client", "The client_id is not a valid client ID metadata document URL");
  const [cached] = await P((db) => db.query<ClientRow>("SELECT id, kind, name, redirect_uris, auth_method, secret_hash, fetched_at FROM oauth_clients WHERE id = $1 AND kind = 'cimd'", [url]));
  if (cached && Date.now() - +new Date(cached.fetched_at ?? 0) < CIMD_FRESH_MS) return toClient(cached);
  let doc: Record<string, unknown>;
  try {
    const d = await fetcher(url);
    if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("not an object");
    doc = d as Record<string, unknown>;
  } catch (e) {
    console.error(`oauth: client metadata document ${JSON.stringify(new URL(url).host)} could not be read (${(e as Error).message})`);
    if (cached && Date.now() - +new Date(cached.fetched_at ?? 0) < CIMD_STALE_MS) return toClient(cached);
    throw new OAuthError("invalid_client", "The client's metadata document could not be fetched");
  }
  if (doc.client_id !== url) throw new OAuthError("invalid_client", "The metadata document's client_id is not its own URL");
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > MAX_REDIRECT_URIS || !uris.every(redirectUriOk))
    throw new OAuthError("invalid_client", "The metadata document's redirect_uris are missing or not allowed");
  const method = doc.token_endpoint_auth_method ?? "none";
  if (method !== "none") throw new OAuthError("invalid_client", "A client ID metadata document client must use token_endpoint_auth_method none");
  const name = cleanName(doc.client_name);
  const [row] = await P((db) => db.query<ClientRow>(
    `INSERT INTO oauth_clients (id, kind, name, redirect_uris, auth_method, fetched_at) VALUES ($1, 'cimd', $2, $3::jsonb, 'none', now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, redirect_uris = EXCLUDED.redirect_uris, fetched_at = now() WHERE oauth_clients.kind = 'cimd'
     RETURNING id, kind, name, redirect_uris, auth_method, secret_hash, fetched_at`, [url, name, JSON.stringify(uris)]));
  if (!row) throw new OAuthError("invalid_client", "Unknown client");
  return toClient(row);
}

/** The client behind a client_id: a metadata document URL, or a registered one. */
export async function clientFor(clientId: unknown): Promise<Client | null> {
  if (typeof clientId !== "string" || !clientId || clientId.length > 512) return null;
  if (clientId.startsWith("https://")) return documentClient(clientId).catch((e) => { if (e instanceof OAuthError) return null; throw e; });
  const [row] = await P((db) => db.query<ClientRow>("SELECT id, kind, name, redirect_uris, auth_method, secret_hash, fetched_at FROM oauth_clients WHERE id = $1 AND kind = 'dcr'", [clientId]));
  return row ? toClient(row) : null;
}

// ---------- authorization requests and consent ----------

const resourceOk = (r: string) => mcpAudiences().some((a) => canonicalResource(a) === canonicalResource(r));
/** The scope to grant: the known scopes asked for; "mcp" when none was asked; null when only unknown ones were. */
function grantScope(asked: unknown): string | null {
  if (asked === undefined || asked === null || asked === "") return SCOPE;
  if (typeof asked !== "string" || asked.length > 500) return null;
  const want = [...new Set(asked.split(/\s+/).filter(Boolean))].filter((s) => KNOWN_SCOPES.has(s));
  return want.length ? want.join(" ") : null;
}
const PKCE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** The authorization response URI: the registered redirect, with the answer added to its own query, and iss (RFC 9207). */
function answerUri(redirectUri: string, params: Record<string, string | null | undefined>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries({ ...params, iss: issuer() })) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** An error the client cannot be told through its redirect URI (the client or the URI itself is wrong): a page, no redirect. */
function errorPage(res: Response, status: number, message: string) {
  res.status(status).type("html").set({ "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" })
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(PROFILE.name)}: sign-in for an app</title>` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#111;background:#fff}</style></head>` +
      `<body><main><h1>This app's sign-in request cannot be used</h1><p>${esc(message)}</p><p>Go back to the app and connect again.</p></main></body></html>`);
}

/** GET /oauth/authorize: check the request, keep it for ten minutes, and send the browser to the consent page. */
async function authorize(req: Request, res: Response) {
  const q = (k: string) => (typeof req.query[k] === "string" ? (req.query[k] as string) : undefined);
  for (const k of ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope", "resource"])
    if (Array.isArray(req.query[k])) return errorPage(res, 400, `The ${k} parameter appears more than once.`);
  if (Array.isArray(req.query.resource)) return errorPage(res, 400, "Only one resource may be named.");
  // The client and the redirect URI first: until both check out, nothing is sent anywhere (open redirect).
  const client = await clientFor(q("client_id"));
  if (!client) return errorPage(res, 400, "The app is not registered here, or its metadata document could not be read.");
  const redirectUri = q("redirect_uri");
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) return errorPage(res, 400, "The app asked to send you to an address it did not register.");
  const state = q("state");
  // Errors before the person has answered are shown here, never sent to the redirect URI: anyone can register a client
  // with any https redirect, so a redirect without a click would make this server an open redirector (RFC 9700 4.11.2).
  const fail = (error: string, description: string) => errorPage(res, 400, `${description} (${error}).`);
  if (state && state.length > 1024) return fail("invalid_request", "state is too long");
  if (q("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
  const challenge = q("code_challenge"), method = q("code_challenge_method");
  if (!challenge) return fail("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256");
  if (method !== "S256") return fail("invalid_request", "Only the S256 code challenge method is supported");
  if (!PKCE.test(challenge)) return fail("invalid_request", "code_challenge must be the base64url SHA-256 of the verifier (43 characters)");
  const resource = q("resource");
  if (!resource) return fail("invalid_target", `The resource parameter is required (RFC 8707): ${mcpAudience()}`);
  if (!resourceOk(resource)) return fail("invalid_target", `This server issues tokens for ${mcpAudience()} only`);
  const scope = grantScope(q("scope"));
  if (!scope) return fail("invalid_scope", `Unknown scope: this server offers ${SCOPE}`);
  const id = token(32);
  await P(async (db) => {
    await db.query(
      "INSERT INTO oauth_requests (id_hash, client_id, redirect_uri, state, code_challenge, scope, resource, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(mins => $8))",
      [sha256(id), client.id, redirectUri, state ?? null, challenge, scope, canonicalResource(resource), REQUEST_MINUTES]);
    if (Math.random() < 0.05) await db.query("DELETE FROM oauth_requests WHERE expires_at < now() - interval '1 hour'");
  });
  res.set("Cache-Control", "no-store").redirect(302, `${consoleUrl()}/auth/consent?request=${encodeURIComponent(id)}`);
}

type RequestRow = { client_id: string; redirect_uri: string; state: string | null; code_challenge: string; scope: string; resource: string; expires_at: Date; used_at: Date | null };
const requestRow = async (id: string) => (/^[A-Za-z0-9_-]{43}$/.test(id) ? (await P((db) => db.query<RequestRow>(
  "SELECT client_id, redirect_uri, state, code_challenge, scope, resource, expires_at, used_at FROM oauth_requests WHERE id_hash = $1", [sha256(id)])))[0] : undefined);
const live = (r: RequestRow | undefined): r is RequestRow => Boolean(r && !r.used_at && +new Date(r.expires_at) > Date.now());

/** The workspaces a person may connect: their memberships that are not suspended. */
async function workspacesOf(userId: string) {
  return (await memberships.forUser(userId)).filter((m) => m.public_metadata?.suspended !== true && m.organization)
    .map((m) => ({ id: m.organization!.id, name: m.organization!.name, role: String(nsGet(m.public_metadata, "role") ?? "member") }));
}

/** What the consent page shows: the client, where it sends the person back, and the workspaces to choose from. */
async function consentView(id: string, userId: string, activeDirId: string | null) {
  const r = await requestRow(id);
  if (!live(r)) return null;
  const client = await clientFor(r.client_id);
  if (!client) return null;
  const ws = await workspacesOf(userId);
  const back = new URL(r.redirect_uri);
  return {
    client: { name: client.name, verified: client.kind === "cimd", id_host: client.kind === "cimd" ? new URL(client.id).host : null },
    redirect: { scheme: back.protocol.replace(/:$/, ""), host: back.host || null },
    scope: r.scope.split(" "), resource: r.resource,
    workspaces: ws, default_workspace: ws.find((w) => w.id === activeDirId)?.id ?? ws[0]?.id ?? null,
    expires_at: new Date(r.expires_at).toISOString(),
  };
}

/** Allow or deny: the request is used once either way; allowing makes the grant and a two-minute code. */
async function decide(id: string, userId: string, allow: boolean, dirId: string): Promise<{ redirect: string } | { status: number; error: string }> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return { status: 404, error: "This sign-in request is unknown or has expired. Go back to the app and connect again." };
  let orgId: number | null = null;
  if (allow) {
    const ws = await workspacesOf(userId);
    if (!ws.some((w) => w.id === dirId)) return { status: 403, error: "You are not an active member of that workspace." };
    const [o] = await P((db) => db.query<{ id: number }>("SELECT id FROM organizations WHERE clerk_org_id = $1", [dirId]));
    if (!o) return { status: 403, error: "You are not an active member of that workspace." };
    orgId = o.id;
  }
  const [r] = await P((db) => db.query<RequestRow>(
    "UPDATE oauth_requests SET used_at = now() WHERE id_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING client_id, redirect_uri, state, code_challenge, scope, resource, expires_at, used_at",
    [sha256(id)]));
  if (!r) return { status: 404, error: "This sign-in request is unknown, was already answered, or has expired. Go back to the app and connect again." };
  if (!allow) return { redirect: answerUri(r.redirect_uri, { error: "access_denied", error_description: "The person declined", state: r.state }) };
  const code = `${CODE_PREFIX}${token(32)}`, grantId = `ogr_${token(15)}`;
  await P((db) => db.transaction(async (tx) => {
    await tx.query("INSERT INTO oauth_grants (id, client_id, user_id, org_id, scope, resource) VALUES ($1, $2, $3, $4, $5, $6)", [grantId, r.client_id, userId, orgId, r.scope, r.resource]);
    await tx.query("INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))",
      [sha256(code), grantId, r.redirect_uri, r.code_challenge, CODE_SECONDS]);
  }));
  console.error(`oauth: grant ${grantId} made for client ${JSON.stringify(r.client_id.slice(0, 120))} in workspace ${orgId}`);
  return { redirect: answerUri(r.redirect_uri, { code, state: r.state }) };
}

// ---------- tokens ----------

/** Revoke a grant and every token it issued. */
async function revokeGrant(db: Queryable, grantId: string, why: string) {
  await db.query("/* tenant: platform: one grant by its id */ UPDATE oauth_grants SET revoked_at = now(), revoked_why = $2 WHERE id = $1 AND revoked_at IS NULL", [grantId, why]);
  await db.query("UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id = $1 AND revoked_at IS NULL", [grantId]);
}

/**
 * A fresh access token and refresh token for a grant: each with its own scope (mold_v0-087), the grant's unless a
 * refresh narrowed the access token's (`scopes.access`) or the refresh token being replaced carried less (`scopes.refresh`).
 */
async function issueTokens(db: Queryable, grant: { id: string; scope: string }, scopes: { access?: string; refresh?: string } = {}) {
  const access = `${ACCESS_PREFIX}${token(32)}`, refresh = `${REFRESH_PREFIX}${token(32)}`, mins = accessMinutes();
  const accessScope = scopes.access ?? grant.scope, refreshScope = scopes.refresh ?? grant.scope;
  await db.query(
    "INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at, scope) VALUES ($1, $3, 'access', now() + make_interval(mins => $4), $6), ($2, $3, 'refresh', now() + make_interval(days => $5), $7)",
    [sha256(access), sha256(refresh), grant.id, mins, refreshDays(), accessScope, refreshScope]);
  await db.query("/* tenant: platform: one grant by its id */ UPDATE oauth_grants SET last_used_at = now() WHERE id = $1", [grant.id]);
  await db.query("/* tenant: platform: the grant's client */ UPDATE oauth_clients SET last_used_at = now() WHERE id = (SELECT client_id FROM oauth_grants WHERE id = $1)", [grant.id]);
  return { access_token: access, token_type: "Bearer", expires_in: mins * 60, refresh_token: refresh, scope: accessScope };
}

/**
 * The scope a refresh asks for, against what its refresh token holds (RFC 6749 6): omitted or blank is all of it; a
 * scope it does not hold is refused (never widened); otherwise the scopes asked for, in the held order, once each.
 */
export function narrowedScope(held: string, asked: unknown): { scope: string } | { error: string } {
  const have = held.split(" ").filter(Boolean);
  if (asked === undefined || asked === null) return { scope: have.join(" ") };
  if (typeof asked !== "string" || asked.length > 500) return { error: "scope must be a space-separated list" };
  const want = new Set(asked.split(/\s+/).filter(Boolean));
  if (!want.size) return { scope: have.join(" ") };
  if ([...want].some((s) => !have.includes(s))) return { error: "A refresh cannot widen the scope" };
  return { scope: have.filter((s) => want.has(s)).join(" ") };
}

/** The client a token request authenticates as: client_secret_basic, client_secret_post, or a public client by id. */
async function tokenClient(req: Request): Promise<Client> {
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.get("authorization") ?? "");
  let id: unknown = req.body?.client_id, secret: unknown = req.body?.client_secret, via: "basic" | "post" | "none" = secret ? "post" : "none";
  if (basic) {
    const [u, ...p] = Buffer.from(basic[1]!, "base64").toString("utf8").split(":");
    try { id = decodeURIComponent(u ?? ""); secret = decodeURIComponent(p.join(":")); } catch { throw new OAuthError("invalid_client", "Malformed client credentials", 401); }
    if (req.body?.client_secret) throw new OAuthError("invalid_request", "Send the client's credentials one way only");
    via = "basic";
  }
  const client = await clientFor(id);
  if (!client) throw new OAuthError("invalid_client", "Unknown client", 401);
  if (client.authMethod === "none") {
    if (via !== "none") throw new OAuthError("invalid_client", "This client was registered without a secret", 401);
  } else {
    const want = client.secretHash ? Buffer.from(client.secretHash, "hex") : null;
    const got = Buffer.from(sha256(typeof secret === "string" ? secret : ""), "hex");
    if (via === "none" || !want || want.length !== got.length || !timingSafeEqual(want, got)) throw new OAuthError("invalid_client", "Client authentication failed", 401);
  }
  return client;
}

type GrantRow = { id: string; client_id: string; user_id: string; org_id: number; scope: string; resource: string; revoked_at: Date | null; dir_id: string | null };
const GRANT_SQL = "SELECT g.id, g.client_id, g.user_id, g.org_id, g.scope, g.resource, g.revoked_at, o.clerk_org_id AS dir_id FROM oauth_grants g JOIN organizations o ON o.id = g.org_id";

/** POST /oauth/token: an authorization code (with its PKCE verifier) or a refresh token, for a new token pair. */
async function tokenEndpoint(req: Request) {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
  for (const k of ["grant_type", "code", "redirect_uri", "code_verifier", "refresh_token", "resource", "client_id", "scope"])
    if (Array.isArray(b[k])) throw new OAuthError("invalid_request", `${k} appears more than once`);
  const grantType = str("grant_type");
  if (grantType !== "authorization_code" && grantType !== "refresh_token") throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  const client = await tokenClient(req);
  const resource = str("resource");
  if (resource !== undefined && !resourceOk(resource)) throw new OAuthError("invalid_target", `This server issues tokens for ${mcpAudience()} only`);

  if (grantType === "authorization_code") {
    const code = str("code") ?? "", verifier = str("code_verifier") ?? "", redirectUri = str("redirect_uri") ?? "";
    if (!code.startsWith(CODE_PREFIX)) throw new OAuthError("invalid_grant", "The code is invalid, expired or already used");
    if (!VERIFIER.test(verifier)) throw new OAuthError("invalid_request", "code_verifier is required (PKCE, 43 to 128 characters)");
    // The transaction returns its refusal rather than throwing it: a revocation it made must commit.
    const out = await P((db) => db.transaction(async (tx): Promise<{ error: OAuthError } | Awaited<ReturnType<typeof issueTokens>>> => {
      const [c] = await tx.query<{ grant_id: string; redirect_uri: string; code_challenge: string; expires_at: Date }>(
        "UPDATE oauth_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL RETURNING grant_id, redirect_uri, code_challenge, expires_at", [sha256(code)]);
      if (!c) {
        // A code used a second time: whatever the first use gave is revoked (RFC 6749 4.1.2, OAuth 2.1 4.1.3).
        const [used] = await tx.query<{ grant_id: string }>(
          "/* tenant: platform: a code's grant by the code's hash */ SELECT c.grant_id FROM oauth_codes c JOIN oauth_grants g ON g.id = c.grant_id WHERE c.code_hash = $1 AND g.client_id = $2",
          [sha256(code), client.id]);
        if (used) { await revokeGrant(tx, used.grant_id, "code_reused"); console.error(`oauth: a code of grant ${used.grant_id} was used twice: grant revoked`); }
        return { error: new OAuthError("invalid_grant", "The code is invalid, expired or already used") };
      }
      const [g] = await tx.query<GrantRow>(`${GRANT_SQL} WHERE g.id = $1`, [c.grant_id]);
      if (!g || g.revoked_at || +new Date(c.expires_at) <= Date.now()) return { error: new OAuthError("invalid_grant", "The code is invalid, expired or already used") };
      if (g.client_id !== client.id) return { error: new OAuthError("invalid_grant", "The code was issued to another client") };
      if (redirectUri !== c.redirect_uri) return { error: new OAuthError("invalid_grant", "redirect_uri does not match the authorization request") };
      const want = Buffer.from(c.code_challenge), got = Buffer.from(s256(verifier));
      if (want.length !== got.length || !timingSafeEqual(want, got)) return { error: new OAuthError("invalid_grant", "The code_verifier does not match the code_challenge") };
      if (resource !== undefined && canonicalResource(resource) !== g.resource) return { error: new OAuthError("invalid_target", "resource does not match the authorization request") };
      return issueTokens(tx, g);
    }));
    if ("error" in out) throw out.error;
    return out;
  }

  const refresh = str("refresh_token") ?? "";
  if (!refresh.startsWith(REFRESH_PREFIX)) throw new OAuthError("invalid_grant", "The refresh token is invalid, expired or revoked");
  const out = await P((db) => db.transaction(async (tx) => {
    const [t] = await tx.query<{ grant_id: string; expires_at: Date; revoked_at: Date | null; scope: string | null }>(
      "UPDATE oauth_tokens SET used_at = now() WHERE token_hash = $1 AND kind = 'refresh' AND used_at IS NULL RETURNING grant_id, expires_at, revoked_at, scope", [sha256(refresh)]);
    if (!t) {
      // A refresh token used twice: someone else holds a copy. The whole grant ends (OAuth 2.1 4.3.1, rotation).
      const [used] = await tx.query<{ grant_id: string; client_id: string }>(
        "/* tenant: platform: a token's grant by the token's hash */ SELECT t.grant_id, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = $1 AND t.kind = 'refresh'", [sha256(refresh)]);
      if (used && used.client_id === client.id) { await revokeGrant(tx, used.grant_id, "refresh_reused"); console.error(`oauth: a refresh token of grant ${used.grant_id} was used twice: grant revoked`); }
      return { error: new OAuthError("invalid_grant", "The refresh token is invalid, expired or revoked") };
    }
    const [g] = await tx.query<GrantRow>(`${GRANT_SQL} WHERE g.id = $1`, [t.grant_id]);
    if (!g || g.revoked_at || t.revoked_at || +new Date(t.expires_at) <= Date.now()) return { error: new OAuthError("invalid_grant", "The refresh token is invalid, expired or revoked") };
    if (g.client_id !== client.id) return { error: new OAuthError("invalid_grant", "The refresh token was issued to another client") };
    if (resource !== undefined && canonicalResource(resource) !== g.resource) return { error: new OAuthError("invalid_target", "resource does not match the grant") };
    // The refresh token's own scope (the grant's for one issued before mold_v0-087); a refresh may narrow it.
    const held = t.scope ?? g.scope;
    const asked = narrowedScope(held, b.scope);
    if ("error" in asked) return { error: new OAuthError("invalid_scope", asked.error) };
    return { grant: g, scopes: { access: asked.scope, refresh: held } };
  }));
  if ("error" in out) throw out.error;
  // The person must still be an active member of the grant's workspace; if not, the grant ends.
  if (!(await memberRole(out.grant.user_id, out.grant.dir_id))) {
    await P((db) => revokeGrant(db, out.grant.id, "membership_ended"));
    throw new OAuthError("invalid_grant", "The person is no longer an active member of the workspace");
  }
  return P((db) => issueTokens(db, out.grant, out.scopes));
}

/** POST /oauth/revoke (RFC 7009): the token's grant ends (an access or a refresh token). 200 whatever the token was. */
async function revokeEndpoint(req: Request) {
  const client = await tokenClient(req);
  const t = typeof req.body?.token === "string" ? req.body.token : "";
  if (!t.startsWith(ACCESS_PREFIX) && !t.startsWith(REFRESH_PREFIX)) return;
  await P(async (db) => {
    const [row] = await db.query<{ grant_id: string; client_id: string }>(
      "/* tenant: platform: a token's grant by the token's hash */ SELECT t.grant_id, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = $1", [sha256(t)]);
    if (row && row.client_id === client.id) await revokeGrant(db, row.grant_id, "revoked_by_client");
  });
}

/**
 * An access token on /mcp: the workspace and person it acts for, with their current role; `scope` when the token lacks
 * the mcp scope (403); null when it is unknown, expired, revoked, for another resource, or the person is no longer an
 * active member of the workspace.
 */
export async function resolveOAuthAccessToken(t: string): Promise<{ org: Org } | { scope: true } | null> {
  if (!oauthOn() || !isOAuthAccessToken(t) || !/^oma_[A-Za-z0-9_-]{43}$/.test(t)) return null;
  const [g] = await P((db) => db.query<GrantRow & { slug: string; name: string; token_scope: string | null }>(
    `/* tenant: platform: an access token's grant by the token's hash, before any workspace is known */
     SELECT g.id, g.client_id, g.user_id, g.org_id, g.scope, g.resource, g.revoked_at, o.clerk_org_id AS dir_id, o.slug, o.name, t.scope AS token_scope
       FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN organizations o ON o.id = g.org_id
      WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now() AND g.revoked_at IS NULL`, [sha256(t)]));
  if (!g) return null;
  // The audience: a token issued for another resource (another address this server no longer answers for) is refused.
  if (!resourceOk(g.resource)) return null;
  // The token's own scope (a refresh may have narrowed it, mold_v0-087), else the grant's.
  if (!(g.token_scope ?? g.scope).split(" ").includes(SCOPE)) return { scope: true };
  const role = await memberRole(g.user_id, g.dir_id);
  if (!role) return null;
  touchGrant(g.id);
  return { org: { orgId: g.org_id, slug: g.slug, name: g.name, userId: g.user_id, role } };
}

/**
 * When a connected app last used its grant (the console's "Last used"): set when tokens are issued and, at most once a
 * minute per grant, when an access token is used on /mcp. Never awaited: a failed write costs the date, not the call.
 */
const touched = new Map<string, number>();
const TOUCH_MS = 60_000;
function touchGrant(grantId: string) {
  const now = Date.now();
  if ((touched.get(grantId) ?? 0) > now - TOUCH_MS) return;
  if (touched.size >= 10_000) touched.clear();
  touched.set(grantId, now);
  void P((db) => db.query("/* tenant: platform: one grant by its id */ UPDATE oauth_grants SET last_used_at = now() WHERE id = $1 AND revoked_at IS NULL", [grantId]))
    .catch((e) => console.error(`oauth: the last use of grant ${grantId} was not recorded (${(e as Error).name})`));
}
/** Tests: forget when grants were last touched, so the next use is recorded at once. */
export const forgetGrantTouchesForTest = () => touched.clear();

/** One connected app, as the console's Connected apps page shows it (GET /api/oauth/grants). */
export interface ConnectedApp {
  id: string;
  /** The client: its name (as it gave it), whether it is verified, and for a verified one the address that identifies it. */
  client: { name: string | null; verified: boolean; id_host: string | null; url: string | null };
  workspace: { id: string; name: string };
  scope: string[];
  created_at: string;
  last_used_at: string | null;
}

// ---------- routes ----------

/** The OAuth endpoints and the consent API. With Clerk on, every route passes on: nothing here answers. */
export function mcpOAuthRouter(): Router {
  const r = express.Router();
  const only = (_req: Request, _res: Response, next: NextFunction) => (oauthOn() ? next() : next("router"));
  const open = (req: Request, res: Response, next: NextFunction) => {
    // Clients call these from anywhere (browser-based MCP clients too); no cookie is read on them.
    res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version", "Cache-Control": "no-store", Pragma: "no-cache" });
    if (req.method === "OPTIONS") return void res.status(204).end();
    next();
  };
  const form = [express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 30 }), express.json({ limit: "8kb" })];
  const ipLimit = (bucket: string, limit: number) => async (req: Request, res: Response, next: NextFunction) => {
    const refused = await hit([{ bucket: `oauth:${bucket}:${hashed(req.ip ?? "?")}`, limit, what: "address" }], 3600);
    if (!refused) return next();
    res.status(429).set("Retry-After", String(refused.retry_after)).json({ error: "slow_down", error_description: `Too many requests from this address. Try again in ${Math.ceil(refused.retry_after / 60)} minutes.` });
  };
  const oauthJson = (fn: (req: Request) => Promise<unknown>, status = 200) => (req: Request, res: Response) => void fn(req).then(
    (out) => void res.status(status).json(out ?? {}),
    (e) => {
      if (!(e instanceof OAuthError)) { console.error(`oauth: ${req.path} failed (${(e as Error).name})`); return void res.status(500).json({ error: "server_error" }); }
      if (e.status === 401 && /^Basic/i.test(req.get("authorization") ?? "")) res.set("WWW-Authenticate", 'Basic realm="oauth"');
      res.status(e.status).json({ error: e.code, error_description: e.message });
    });

  r.use(["/oauth", "/api/oauth"], only);
  r.options(["/oauth/register", "/oauth/token", "/oauth/revoke"], open);
  r.post("/oauth/register", open, ipLimit("register", REGISTRATIONS_PER_HOUR_PER_IP), express.json({ limit: "8kb" }), oauthJson(async (req) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new OAuthError("invalid_client_metadata", "Send the client metadata as a JSON object");
    return registerClient(req.body as Record<string, unknown>, req.ip ?? "?");
  }, 201));
  r.post("/oauth/token", open, ipLimit("token", TOKEN_CALLS_PER_HOUR_PER_IP), ...form, oauthJson(tokenEndpoint));
  r.post("/oauth/revoke", open, ipLimit("token", TOKEN_CALLS_PER_HOUR_PER_IP), ...form, oauthJson(async (req) => { await revokeEndpoint(req); return {}; }));
  r.get("/oauth/authorize", ipLimit("authorize", AUTHORIZE_PER_HOUR_PER_IP), (req, res, next) => void authorize(req, res).catch(next));

  // The consent page's API (/auth/consent in the console): the built-in session; changes are same-site JSON with the
  // console's CSRF header.
  const signedIn = async (req: Request, res: Response) => {
    const s = await sessionFromRequest(req);
    if (!s) res.status(401).json({ error: "Sign in", sign_in_url: "/auth/sign-in" });
    return s;
  };
  const change = (req: Request, res: Response, next: NextFunction) => {
    if (!sameSite(req)) return void res.status(403).json({ error: "This request came from another site" });
    if (!req.is("application/json") || req.get("x-pack-request") !== "1") return void res.status(403).json({ error: "Send JSON with the X-Pack-Request header" });
    express.json({ limit: "2kb" })(req, res, (err?: unknown) => (err ? void res.status(400).json({ error: "The request body must be JSON" }) : next()));
  };
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);
  r.use("/api/oauth", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.get("/api/oauth/requests/:id", wrap(async (req, res) => {
    const s = await signedIn(req, res);
    if (!s) return;
    const view = await consentView(String(req.params.id), s.userId, s.orgId);
    if (!view) return void res.status(404).json({ error: "This sign-in request is unknown, was already answered, or has expired. Go back to the app and connect again." });
    res.json(view);
  }));
  r.post("/api/oauth/requests/:id", change, wrap(async (req, res) => {
    const s = await signedIn(req, res);
    if (!s) return;
    const decision = req.body?.decision;
    if (decision !== "allow" && decision !== "deny") return void res.status(400).json({ error: "decision must be allow or deny" });
    const out = await decide(String(req.params.id), s.userId, decision === "allow", String(req.body?.workspace ?? ""));
    if ("error" in out) return void res.status(out.status).json({ error: out.error });
    res.json(out);
  }));
  // The person's connected apps, and revoking one (every token of it ends on the next request).
  r.get("/api/oauth/grants", wrap(async (req, res) => {
    const s = await signedIn(req, res);
    if (!s) return;
    const rows = await P((db) => db.query<{ id: string; client_id: string; name: string | null; kind: string; org_name: string; dir_id: string; scope: string; created_at: Date; last_used_at: Date | null }>(
      `/* tenant: platform: the signed-in person's own grants, across their workspaces */
       SELECT g.id, g.client_id, c.name, c.kind, o.name AS org_name, o.clerk_org_id AS dir_id, g.scope, g.created_at, g.last_used_at
         FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id JOIN organizations o ON o.id = g.org_id
        WHERE g.user_id = $1 AND g.revoked_at IS NULL ORDER BY g.created_at DESC LIMIT 200`, [s.userId]));
    const grants: ConnectedApp[] = rows.map((g) => {
      const verified = g.kind === "cimd";
      return { id: g.id, client: { name: g.name, verified, id_host: verified ? new URL(g.client_id).host : null, url: verified ? g.client_id : null },
        workspace: { id: g.dir_id, name: g.org_name }, scope: g.scope.split(" "), created_at: new Date(g.created_at).toISOString(),
        last_used_at: g.last_used_at ? new Date(g.last_used_at).toISOString() : null };
    });
    res.json({ grants });
  }));
  r.post("/api/oauth/grants/:id/revoke", change, wrap(async (req, res) => {
    const s = await signedIn(req, res);
    if (!s) return;
    const [g] = await P((db) => db.query<{ id: string }>(
      "/* tenant: platform: one of the signed-in person's own grants */ SELECT id FROM oauth_grants WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [String(req.params.id), s.userId]));
    if (!g) return void res.status(404).json({ error: "No such connected app" });
    await P((db) => revokeGrant(db, g.id, "revoked_by_person"));
    res.json({ ok: true });
  }));
  r.use(["/oauth", "/api/oauth"], (err: Error & { type?: string; status?: number }, req: Request, res: Response, _next: NextFunction) => {
    // A body the parser refused: its message can quote the body (a token, a code), so only its kind is logged.
    if (err.type && err.status && err.status < 500) {
      console.error(`oauth: ${req.path} refused a request body (${err.type})`);
      return void res.status(err.status).json({ error: "invalid_request", error_description: "The request body could not be read" });
    }
    console.error(`oauth: ${req.path} failed (${err.name})`);
    res.status(500).json({ error: "server_error" });
  });
  return r;
}

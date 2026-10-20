/**
 * Clerk is the system of record for people: users, organizations, memberships, roles and invitations (Clerk sends the
 * invite email), sign-in with passwords and social providers (Google, Microsoft, GitHub, set up in the Clerk
 * dashboard), and the OAuth server for /mcp, so Claude and ChatGPT sign people in instead of pasting a secret URL.
 * Octillion keeps only organizations.clerk_org_id to join Clerk organizations to its own product data.
 * Plain REST over fetch, like the other integrations. Unset CLERK_SECRET_KEY = Clerk is off and per-org API keys
 * (src/auth.ts) are the only way in.
 *
 *   CLERK_SECRET_KEY            sk_test_... / sk_live_... (Backend API)
 *   CLERK_PUBLISHABLE_KEY       pk_... (or NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY): names the Frontend API, the OAuth server
 *   CLERK_JWT_KEY               optional PEM public key: verify session tokens without calling Clerk (else JWKS)
 *   CLERK_AUTHORIZED_PARTIES    origins allowed in a session token's azp (default: PUBLIC_URL's origin)
 *   CLERK_API_URL, CLERK_FRONTEND_API_URL  overrides for the smoke test only (it points them at its local mock, scripts/lib/mock-providers.ts)
 *
 * Suspending a person: Clerk memberships have no "deactivated" state, so suspension is the membership's
 * public_metadata.suspended = true, which Octillion enforces on /mcp and /api/app; removing a member deletes the
 * membership in Clerk.
 */
import { createLocalJWKSet, importSPKI, jwtVerify, decodeProtectedHeader, type JWTPayload } from "jose";

export const clerkEnabled = () => Boolean(process.env.CLERK_SECRET_KEY);
const apiBase = () => (process.env.CLERK_API_URL ?? "https://api.clerk.com").replace(/\/$/, "");
const publicUrl = () => (process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3333}`).replace(/\/$/, "");

export class ClerkError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!clerkEnabled()) throw new ClerkError("Clerk is not configured (CLERK_SECRET_KEY)", 503);
  const res = await fetch(`${apiBase()}/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = json.errors?.[0];
    throw new ClerkError(`Clerk ${method} ${path.split("?")[0]}: ${e?.long_message ?? e?.message ?? res.status}`, res.status >= 500 ? 502 : res.status);
  }
  return json as T;
}

/** Every page of a Clerk list endpoint ({data, total_count}, limit/offset). */
async function all<T>(path: string, params: Record<string, string | string[] | undefined> = {}): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; out.length < 5000; offset += 100) {
    const q = new URLSearchParams({ limit: "100", offset: String(offset) });
    for (const [k, v] of Object.entries(params)) for (const x of v === undefined ? [] : Array.isArray(v) ? v : [v]) q.append(k, x);
    const page = await call<{ data: T[]; total_count?: number } | T[]>("GET", `${path}?${q}`);
    const data = Array.isArray(page) ? page : page.data;
    out.push(...data);
    if (data.length < 100) break;
  }
  return out;
}

// ---------- shapes (Backend API JSON, snake_case; timestamps in ms) ----------

export interface ClerkOrg { id: string; name: string; slug: string | null; public_metadata: Record<string, unknown>; created_at: number }
export interface ClerkInvitation { id: string; email_address: string; role: string; status: "pending" | "accepted" | "revoked" | "expired";
  created_at: number; updated_at?: number; expires_at?: number | null; public_metadata?: Record<string, unknown> | null }
export interface ClerkMembership { id: string; role: string; public_metadata: Record<string, unknown> | null; created_at: number;
  public_user_data?: { user_id: string; identifier?: string; first_name?: string | null; last_name?: string | null };
  organization?: ClerkOrg }
export interface ClerkUser { id: string; first_name: string | null; last_name: string | null; primary_email_address_id: string | null;
  email_addresses: { id: string; email_address: string; verification?: { status?: string } | null }[]; public_metadata: Record<string, unknown>;
  last_sign_in_at?: number | null; created_at?: number }

/** "org:admin" -> "admin"; anything that is not admin is a member. */
export const roleOf = (role: string | null | undefined): "admin" | "member" => (String(role ?? "").replace(/^org:/, "") === "admin" ? "admin" : "member");
const roleKey = (role: "admin" | "member") => `org:${role}`;
export const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
export const isSuspended = (m: { public_metadata?: Record<string, unknown> | null }) => m.public_metadata?.suspended === true;

export const organizations = {
  // No slug: accounts are matched by Clerk org id, and the production instance has organization slugs turned off
  // (sending one is refused). Clerk names a slug itself if slugs are ever turned on. `_slug` is kept for callers.
  create: (name: string, _slug: string, publicMetadata: Record<string, unknown> = {}) =>
    call<ClerkOrg>("POST", "/organizations", { name, public_metadata: publicMetadata }),
  get: (id: string) => call<ClerkOrg>("GET", `/organizations/${encodeURIComponent(id)}`),
  rename: (id: string, name: string) => call<ClerkOrg>("PATCH", `/organizations/${encodeURIComponent(id)}`, { name }),
  /** Merges into public_metadata (keys not sent are kept). */
  setMetadata: (id: string, publicMetadata: Record<string, unknown>) =>
    call<ClerkOrg>("PATCH", `/organizations/${encodeURIComponent(id)}/metadata`, { public_metadata: publicMetadata }),
  list: () => all<ClerkOrg>("/organizations"),
};

export const invitations = {
  /** Clerk emails the invitation; accepting it signs the person up (or in) and adds the membership, which gets the
   *  invitation's public_metadata (the account role, src/account-roles.ts). */
  send: (orgId: string, email: string, role: "admin" | "member" = "member", publicMetadata: Record<string, unknown> = {}) =>
    call<ClerkInvitation>("POST", `/organizations/${encodeURIComponent(orgId)}/invitations`, {
      email_address: email, role: roleKey(role), public_metadata: publicMetadata, redirect_url: `${publicUrl()}/app/`,
    }),
  list: (orgId: string) => all<ClerkInvitation>(`/organizations/${encodeURIComponent(orgId)}/invitations`),
  revoke: (orgId: string, invitationId: string) =>
    call<ClerkInvitation>("POST", `/organizations/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}/revoke`, {}),
};

/**
 * A person's memberships are read on every portal request and MCP connection, so they are cached for half a minute.
 * Changes made through this process clear the cache at once (and tell listeners, e.g. the MCP token cache); changes
 * made in the Clerk dashboard or by another replica apply within the cache lifetime.
 */
const userMemberships = new Map<string, { at: number; list: ClerkMembership[] }>();
const changeListeners: ((userId: string) => void)[] = [];
export const onMembershipChange = (fn: (userId: string) => void) => void changeListeners.push(fn);
const changed = <T>(userId: string, r: T) => { userMemberships.delete(userId); for (const fn of changeListeners) fn(userId); return r; };

export const memberships = {
  list: (orgId: string) => all<ClerkMembership>(`/organizations/${encodeURIComponent(orgId)}/memberships`),
  /** A person's memberships across organizations (each with its organization), cached for 30 seconds. */
  forUser: async (userId: string) => {
    const hit = userMemberships.get(userId);
    if (hit && Date.now() - hit.at < 30_000) return hit.list;
    const list = await all<ClerkMembership>(`/users/${encodeURIComponent(userId)}/organization_memberships`);
    userMemberships.set(userId, { at: Date.now(), list });
    return list;
  },
  /** Clerk's role, and with `metadata` the membership's public_metadata too (merged: suspended stays). */
  setRole: async (orgId: string, userId: string, role: "admin" | "member", metadata?: Record<string, unknown>) => {
    const m = await call<ClerkMembership>("PATCH", `/organizations/${encodeURIComponent(orgId)}/memberships/${encodeURIComponent(userId)}`, { role: roleKey(role) });
    return changed(userId, metadata ? await call<ClerkMembership>("PATCH", `/organizations/${encodeURIComponent(orgId)}/memberships/${encodeURIComponent(userId)}/metadata`,
      { public_metadata: metadata }) : m);
  },
  setSuspended: async (orgId: string, userId: string, suspended: boolean) => changed(userId,
    await call<ClerkMembership>("PATCH", `/organizations/${encodeURIComponent(orgId)}/memberships/${encodeURIComponent(userId)}/metadata`,
      { public_metadata: { suspended } })),
  remove: async (orgId: string, userId: string) => changed(userId,
    await call<ClerkMembership>("DELETE", `/organizations/${encodeURIComponent(orgId)}/memberships/${encodeURIComponent(userId)}`)),
};

const userCache = new Map<string, { at: number; user: ClerkUser }>();
export const users = {
  get: async (id: string, fresh = false) => {
    const hit = userCache.get(id);
    if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.user;
    const user = await call<ClerkUser>("GET", `/users/${encodeURIComponent(id)}`);
    userCache.set(id, { at: Date.now(), user });
    return user;
  },
  /** Every user (paged); Clerk has no search on metadata, so callers filter. */
  list: () => all<ClerkUser>("/users", { order_by: "-created_at" }),
  byEmail: async (email: string) => (await call<ClerkUser[]>("GET", `/users?${new URLSearchParams({ email_address: email.toLowerCase() })}`))[0] ?? null,
  /** A user who signs in later with that address (Google, a magic link): no password needed. */
  create: (email: string, publicMetadata: Record<string, unknown>) =>
    call<ClerkUser>("POST", "/users", { email_address: [email], public_metadata: publicMetadata, skip_password_requirement: true }),
  /** Merges into public_metadata (null removes a key). */
  setMetadata: async (id: string, publicMetadata: Record<string, unknown>) => {
    const user = await call<ClerkUser>("PATCH", `/users/${encodeURIComponent(id)}/metadata`, { public_metadata: publicMetadata });
    userCache.set(id, { at: Date.now(), user });
    return user;
  },
};

/** The user's primary email and whether Clerk has verified it. */
export function primaryEmail(u: ClerkUser): { email: string | null; verified: boolean } {
  const e = u.email_addresses.find((x) => x.id === u.primary_email_address_id) ?? u.email_addresses[0];
  return { email: e?.email_address?.toLowerCase() ?? null, verified: e?.verification?.status === "verified" };
}
export const displayName = (u: { first_name?: string | null; last_name?: string | null }) => [u.first_name, u.last_name].filter(Boolean).join(" ") || null;

// ---------- verifying tokens ----------

let jwks: { at: number; set: ReturnType<typeof createLocalJWKSet> } | null = null;
async function keyFor(header: { alg?: string; kid?: string }) {
  if (process.env.CLERK_JWT_KEY) return importSPKI(process.env.CLERK_JWT_KEY.replace(/\\n/g, "\n"), header.alg ?? "RS256");
  if (!jwks || Date.now() - jwks.at > 3_600_000) jwks = { at: Date.now(), set: createLocalJWKSet(await call("GET", "/jwks")) };
  return jwks.set;
}
async function verifyJwt(token: string): Promise<JWTPayload & Record<string, any>> {
  const header = decodeProtectedHeader(token);
  const key = await keyFor(header);
  const { payload } = await jwtVerify(token, key as Parameters<typeof jwtVerify>[1], { clockTolerance: 5 });
  return payload as JWTPayload & Record<string, any>;
}
const OAUTH_JWT_TYPES = ["at+jwt", "application/at+jwt"];

const authorizedParties = () => (process.env.CLERK_AUTHORIZED_PARTIES ?? (process.env.PUBLIC_URL ? new URL(publicUrl()).origin : ""))
  .split(",").map((x) => x.trim()).filter(Boolean);

export interface SessionClaims { userId: string; sessionId: string | null; orgId: string | null; orgRole: "admin" | "member" | null }

/**
 * A Clerk session token (the __session cookie, or the Bearer token from getToken()). Checks the signature, expiry and
 * the authorized party (azp) against CLERK_AUTHORIZED_PARTIES. Reads the active organization from v2 (`o`) or v1
 * (`org_id`, `org_role`) claims. Null when it is not a valid session token.
 */
export async function verifySessionToken(token: string | null | undefined): Promise<SessionClaims | null> {
  if (!token || !clerkEnabled() || token.split(".").length !== 3) return null;
  try {
    if (OAUTH_JWT_TYPES.includes(String(decodeProtectedHeader(token).typ ?? ""))) return null;
    const p = await verifyJwt(token);
    if (!p.sub || !p.sid && !p.sub.startsWith("user_")) return null;
    const parties = authorizedParties();
    if (p.azp && parties.length && !parties.includes(String(p.azp))) return null;
    const orgId = (p.o?.id ?? p.org_id ?? null) as string | null;
    const rawRole = (p.o?.rol ?? p.org_role ?? null) as string | null;
    return { userId: p.sub, sessionId: (p.sid as string) ?? null, orgId, orgRole: orgId ? roleOf(rawRole) : null };
  } catch {
    return null;
  }
}

/**
 * An OAuth access token Clerk issued to an MCP client: opaque (oat_…, checked with the Backend API) or JWT (typ
 * at+jwt, checked against the instance's keys). Returns the user and scopes, or null.
 */
export async function verifyOAuthToken(token: string): Promise<{ userId: string; scopes: string[]; clientId: string | null } | null> {
  if (!clerkEnabled()) return null;
  try {
    if (token.startsWith("oat_")) {
      const r = await call<{ subject?: string; scopes?: string[]; client_id?: string; revoked?: boolean; expired?: boolean }>(
        "POST", "/oauth_applications/access_tokens/verify", { access_token: token });
      if (!r.subject || r.revoked || r.expired) return null;
      return { userId: r.subject, scopes: r.scopes ?? [], clientId: r.client_id ?? null };
    }
    if (token.split(".").length === 3 && OAUTH_JWT_TYPES.includes(String(decodeProtectedHeader(token).typ ?? ""))) {
      const p = await verifyJwt(token);
      if (!p.sub) return null;
      const scopes = typeof p.scp === "string" ? p.scp.split(" ") : Array.isArray(p.scp) ? p.scp : typeof p.scope === "string" ? p.scope.split(" ") : [];
      return { userId: p.sub, scopes, clientId: (p.client_id ?? p.azp ?? null) as string | null };
    }
  } catch {
    return null;
  }
  return null;
}

// ---------- the OAuth server for /mcp ----------

/** Clerk's Frontend API (the OAuth authorization server), from CLERK_FRONTEND_API_URL or the publishable key. */
export function frontendApi(): string | null {
  if (process.env.CLERK_FRONTEND_API_URL) return process.env.CLERK_FRONTEND_API_URL.replace(/\/$/, "");
  const pk = process.env.CLERK_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const enc = pk?.split("_")[2];
  if (!enc) return null;
  try {
    const host = Buffer.from(enc, "base64").toString("utf8").replace(/\$$/, "");
    return host ? `https://${host}` : null;
  } catch {
    return null;
  }
}
export const mcpAudience = () => process.env.CLERK_MCP_AUDIENCE || `${publicUrl()}/mcp`;

// ---------- platform admins ----------

/**
 * OCTILLION_PLATFORM_ADMINS: comma-separated addresses or *@domain entries (anything after a colon is ignored, so old
 * password entries still name their admin). Clerk must have verified the address. Roles: src/admin-roles.ts.
 */
export function isPlatformAdminEmail(email: string | null): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  const entries = platformAdminEntries();
  return entries.includes(e) || entries.includes(`*@${e.split("@")[1]}`);
}
/** An address OCTILLION_PLATFORM_ADMINS names (exact entries only, for listing; domain entries match anyone there). */
export const platformAdminEntries = () => (process.env.OCTILLION_PLATFORM_ADMINS ?? "").split(",").map((x) => x.trim().split(":")[0].toLowerCase()).filter(Boolean);

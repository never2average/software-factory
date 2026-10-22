/**
 * Built-in sign-in (mold_v0-004): the shell's own people directory and sessions, used when AUTH_PROVIDER is builtin
 * (src/auth-provider.ts; the default for every app without a Clerk key). Two ways in, both proving an email address:
 *
 *   an emailed code  eight digits from a CSPRNG, sent through the email module (src/email.ts, Resend), kept as an HMAC
 *                    keyed with a server secret; ten minutes, five tries, used once, and a new code retires the old one
 *   Google           OpenID Connect with PKCE (S256), a state bound to the browser by a cookie, a nonce, and an ID token
 *                    checked against Google's keys (issuer, audience, expiry, nonce, email_verified). Shown only when
 *                    GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set
 *
 * Who may sign in: a person this server already knows (a member, someone staff added as a platform admin, anyone who
 * signed in before), an address with a live invitation, or an address OCTILLION_PLATFORM_ADMINS names. The answer to
 * "send me a code" is the same words, the same status and the same work for every address, so it says nothing about
 * who is known (a code row is written for every request; only a known address is sent one, and only a sent code can
 * be used). Requests are limited per address (codes an hour, failed tries a day) and per IP (src/rate-limits.ts).
 *
 * A session is a random 256-bit value in an httpOnly, SameSite=Lax cookie (`__Host-oct_session`, Secure, on https;
 * `oct_session` on plain http for local work); only its sha256 is stored (auth_sessions). Sessions expire
 * (OCTILLION_SESSION_DAYS, default 14) and are checked against the database on every request, so signing out, signing
 * out everywhere, and an owner removing someone take effect on the next request. Every sign-in mints a new session
 * (the one the browser came with is revoked): no session id is ever taken from the request (fixation).
 *
 * The directory has Clerk's shapes (src/clerk.ts ClerkUser, ClerkMembership, ClerkInvitation, ClerkOrg), so the code
 * that manages teams (src/admin.ts), reads roles (src/account-roles.ts) and checks member keys (src/auth.ts) is the same
 * for both providers (src/people.ts). Invitations are emailed here (Clerk sends its own): accepting one is signing in
 * with the invited address, nothing else, so a forwarded invitation email lets nobody else in.
 *
 * Every query runs as the platform (src/tenant-scope.ts asPlatform): the auth tables are closed to tenant work.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { builtinAuth } from "./auth-provider.js";
import { ClerkError, isPlatformAdminEmail, type ClerkInvitation, type ClerkMembership, type ClerkOrg, type ClerkUser, type SessionClaims } from "./clerk.js";
import { getDb, type Queryable } from "./db.js";
import { ACCOUNT_ROLE_LABELS, isAccountRole, type AccountRole } from "./account-roles.js";
import { PROFILE } from "./profile.js";
import { hashed, hit, limitsFor } from "./rate-limits.js";
import { asPlatform } from "./tenant-scope.js";
import { consoleUrl, publicUrl } from "./console-url.js";

// ---------- settings ----------

export const CODE_TTL_MINUTES = 10;
export const CODE_MAX_ATTEMPTS = 5;
/** Codes for one address from one IP an hour (the per-address total is limits.endpoints.signin_codes_per_hour_per_address). */
export const CODES_PER_ADDRESS_AND_IP = 5;
export const CODE_DIGITS = 8;
export const INVITE_DAYS = 7;
const sessionDays = () => {
  const d = Number(process.env.OCTILLION_SESSION_DAYS ?? "");
  return Number.isInteger(d) && d >= 1 && d <= 90 ? d : 14;
};
/**
 * Where people open the console (src/console-url.ts): OCTILLION_CONSOLE_URL, else PUBLIC_URL. The factory sets it on
 * every target (mold_v0-084): on Vercel, where the console is its own project in front of this API, to the console's
 * address, so invitation and sign-in emails link to the console's sign-in page.
 */
export { consoleUrl };
/** The origin the browser is on: the forwarded host when the console proxies the request (Next.js rewrites), else this host. */
const browserOrigin = (req: Request) => {
  const host = String(req.get("x-forwarded-host") ?? req.get("host") ?? "").split(",")[0]!.trim();
  const proto = String(req.get("x-forwarded-proto") ?? req.protocol).split(",")[0]!.trim();
  return /^[A-Za-z0-9.-]+(:\d+)?$/.test(host) && /^https?$/.test(proto) ? `${proto}://${host}` : consoleUrl();
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (bytes: number) => randomBytes(bytes).toString("base64url");
const newId = (prefix: string) => `${prefix}${token(15)}`;
const ms = (d: Date | string | null | undefined) => (d ? +new Date(d) : null);
const P = <T>(fn: (db: Queryable & { transaction: <R>(f: (tx: Queryable) => Promise<R>) => Promise<R> }) => Promise<T>): Promise<T> =>
  asPlatform(async () => fn(await getDb()));

/**
 * The key codes are kept under: OCTILLION_AUTH_SECRET, else derived from the vault key or the worker token (both are
 * server secrets every deploy has). A database copy alone then cannot be turned back into codes.
 */
let codeKey: Buffer | null = null;
function authKey(): Buffer {
  if (codeKey) return codeKey;
  const base = process.env.OCTILLION_AUTH_SECRET || process.env.OCTILLION_VAULT_KEY || process.env.OCTILLION_WORKER_TOKEN;
  if (!base) console.error("builtin sign-in: no OCTILLION_AUTH_SECRET, OCTILLION_VAULT_KEY or OCTILLION_WORKER_TOKEN: codes are kept under a per-process key (a restart retires codes in flight)");
  codeKey = createHash("sha256").update(`octillion-sign-in-codes:${base || randomBytes(32).toString("hex")}`).digest();
  return codeKey;
}
const codeHash = (email: string, code: string) => createHmac("sha256", authKey()).update(`${email}\n${code}`).digest("hex");

export const normEmail = (v: unknown): string | null => {
  const e = typeof v === "string" ? v.trim().toLowerCase() : "";
  return e.length <= 254 && /^[^\s@<>,;"'()\\]+@[^\s@<>,;"'()\\]+\.[^\s@<>,;"'()\\]+$/.test(e) ? e : null;
};

/**
 * Where to go after signing in: a path on this site only ("/app", "/admin/accounts?x=1"). Anything with a scheme, a
 * host, a protocol-relative start ("//", "/\"), a backslash or a control character is refused for "/app" (open redirect).
 */
export function safeRedirect(v: unknown, fallback = "/app"): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > 512 || !s.startsWith("/") || s.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(s)) return fallback;
  try {
    const u = new URL(s, "http://x.invalid");
    if (u.origin !== "http://x.invalid") return fallback;
    // Dot-segments collapse ("/.//evil.example" is "//evil.example" once normalised): check the result again.
    const out = u.pathname + u.search + u.hash;
    return out.startsWith("/") && !out.startsWith("//") && !/[\\\u0000-\u001f\u007f]/.test(out) ? out : fallback;
  } catch { return fallback; }
}

// ---------- the directory, in Clerk's shapes ----------

type UserRow = { id: string; email: string; email_verified_at: Date | null; first_name: string | null; last_name: string | null; google_sub: string | null;
  public_metadata: Record<string, unknown> | null; created_at: Date; last_sign_in_at: Date | null };
const USER_COLS = "id, email, email_verified_at, first_name, last_name, google_sub, public_metadata, created_at, last_sign_in_at";
const toUser = (u: UserRow): ClerkUser => ({
  id: u.id, first_name: u.first_name, last_name: u.last_name, primary_email_address_id: `idn_${u.id}`,
  email_addresses: [{ id: `idn_${u.id}`, email_address: u.email, verification: { status: u.email_verified_at ? "verified" : "unverified" } }],
  public_metadata: (typeof u.public_metadata === "string" ? JSON.parse(u.public_metadata) : u.public_metadata) ?? {},
  last_sign_in_at: ms(u.last_sign_in_at), created_at: ms(u.created_at) ?? undefined,
});

type MemberRow = { org_id: number; user_id: string; role: AccountRole; suspended: boolean; created_at: Date; dir_id: string; org_name: string; org_slug: string;
  org_created: Date; email: string; first_name: string | null; last_name: string | null };
const MEMBER_SQL = `SELECT m.org_id, m.user_id, m.role, m.suspended, m.created_at, o.clerk_org_id AS dir_id, o.name AS org_name, o.slug AS org_slug,
         o.created_at AS org_created, u.email, u.first_name, u.last_name
    FROM auth_memberships m JOIN organizations o ON o.id = m.org_id JOIN auth_users u ON u.id = m.user_id`;
/** Clerk's organization role for an account role: owner is org:admin, everyone else org:member (src/account-roles.ts). */
const clerkRole = (r: AccountRole) => (r === "owner" ? "org:admin" : "org:member");
const toOrg = (r: { dir_id: string; org_name: string; org_slug: string; org_created: Date }): ClerkOrg =>
  ({ id: r.dir_id, name: r.org_name, slug: r.org_slug, public_metadata: {}, created_at: ms(r.org_created) ?? 0 });
const toMembership = (r: MemberRow): ClerkMembership => ({
  id: `mem_${r.org_id}_${r.user_id}`, role: clerkRole(r.role), public_metadata: { octillion_role: r.role, ...(r.suspended ? { suspended: true } : {}) },
  created_at: ms(r.created_at) ?? 0, public_user_data: { user_id: r.user_id, identifier: r.email, first_name: r.first_name, last_name: r.last_name },
  organization: toOrg(r),
});

type InviteRow = { id: string; org_id: number; email: string; role: AccountRole; status: "pending" | "accepted" | "revoked"; created_at: Date; updated_at: Date; expires_at: Date };
const INVITE_COLS = "id, org_id, email, role, status, created_at, updated_at, expires_at";
const toInvitation = (x: InviteRow): ClerkInvitation => ({
  id: x.id, email_address: x.email, role: clerkRole(x.role),
  status: x.status === "pending" && +new Date(x.expires_at) <= Date.now() ? "expired" : x.status,
  created_at: ms(x.created_at) ?? 0, updated_at: ms(x.updated_at) ?? undefined, expires_at: ms(x.expires_at), public_metadata: { octillion_role: x.role },
});

/** An account role from Clerk's (role, metadata) pair, as src/account-roles.ts clerkRoleFor writes it. */
function roleFrom(role: "admin" | "member", metadata?: Record<string, unknown>): AccountRole {
  if (role === "admin") return "owner";
  const r = metadata?.octillion_role;
  return isAccountRole(r) && r !== "owner" ? r : "member";
}

/** The workspace row behind a directory id (organizations.clerk_org_id), or a 404 in Clerk's words. */
async function orgRow(db: Queryable, dirId: string): Promise<{ id: number; name: string; slug: string; created_at: Date }> {
  const [o] = await db.query<{ id: number; name: string; slug: string; created_at: Date }>(
    "SELECT id, name, slug, created_at FROM organizations WHERE clerk_org_id = $1", [String(dirId)]);
  if (!o) throw new ClerkError("Organization not found", 404);
  return o;
}

const listeners: ((userId: string) => void)[] = [];
export const onMembershipChange = (fn: (userId: string) => void) => void listeners.push(fn);
const changed = <T>(userId: string, r: T) => { for (const fn of listeners) fn(userId); return r; };

export const organizations = {
  /** A new directory id for a workspace: the caller writes it into organizations.clerk_org_id (src/admin.ts). */
  create: async (name: string, _slug: string, publicMetadata: Record<string, unknown> = {}): Promise<ClerkOrg> =>
    ({ id: newId("org_b"), name, slug: null, public_metadata: publicMetadata, created_at: Date.now() }),
  get: (id: string) => P(async (db) => { const o = await orgRow(db, id); return { id, name: o.name, slug: o.slug, public_metadata: {}, created_at: ms(o.created_at) ?? 0 } as ClerkOrg; }),
  /** The workspace's own row is the record: renaming it there is the rename (src/admin.ts renameOrg). */
  rename: (id: string, name: string) => P(async (db) => { const o = await orgRow(db, id); return { id, name, slug: o.slug, public_metadata: {}, created_at: ms(o.created_at) ?? 0 } as ClerkOrg; }),
  /** Metadata Clerk keeps on its organization (the slug, the Stripe customer) is already on the workspace row. */
  setMetadata: (id: string, _md: Record<string, unknown>) => organizations.get(id),
  list: () => P(async (db) => (await db.query<{ dir_id: string; org_name: string; org_slug: string; org_created: Date }>(
    "SELECT clerk_org_id AS dir_id, name AS org_name, slug AS org_slug, created_at AS org_created FROM organizations WHERE clerk_org_id IS NOT NULL ORDER BY id")).map(toOrg)),
};

export const users = {
  get: (id: string, _fresh = false) => P(async (db) => {
    const [u] = await db.query<UserRow>(`SELECT ${USER_COLS} FROM auth_users WHERE id = $1`, [String(id)]);
    if (!u) throw new ClerkError("User not found", 404);
    return toUser(u);
  }),
  list: () => P(async (db) => (await db.query<UserRow>(`SELECT ${USER_COLS} FROM auth_users ORDER BY created_at DESC LIMIT 5000`)).map(toUser)),
  byEmail: (email: string) => P(async (db) => {
    const [u] = await db.query<UserRow>(`SELECT ${USER_COLS} FROM auth_users WHERE email = $1`, [String(email).trim().toLowerCase()]);
    return u ? toUser(u) : null;
  }),
  /** A person who signs in later with that address (src/admin-roles.ts addAdmin): unverified until they do. */
  create: (email: string, publicMetadata: Record<string, unknown>) => P(async (db) => {
    const e = normEmail(email);
    if (!e) throw new ClerkError("Enter a valid email address", 422);
    const [u] = await db.query<UserRow>(`INSERT INTO auth_users (id, email, public_metadata) VALUES ($1, $2, $3::jsonb) ON CONFLICT (email) DO NOTHING RETURNING ${USER_COLS}`,
      [newId("user_b"), e, JSON.stringify(publicMetadata ?? {})]);
    if (!u) throw new ClerkError("That email address is taken. Please try another.", 422);
    return toUser(u);
  }),
  /** Merges into public_metadata; null removes a key (as Clerk's). */
  setMetadata: (id: string, publicMetadata: Record<string, unknown>) => P(async (db) => {
    const [u] = await db.query<UserRow>(`UPDATE auth_users SET public_metadata = jsonb_strip_nulls(public_metadata || $2::jsonb) WHERE id = $1 RETURNING ${USER_COLS}`,
      [String(id), JSON.stringify(publicMetadata ?? {})]);
    if (!u) throw new ClerkError("User not found", 404);
    return toUser(u);
  }),
};

/**
 * Sessions to end when someone leaves a workspace: those working in it, and, when they are left in no workspace at all,
 * every one of theirs (nothing is left for them to open).
 */
async function revokeForRemoval(db: Queryable, orgId: number, userId: string) {
  await db.query(
    `UPDATE auth_sessions SET revoked_at = now(), revoked_why = 'removed'
      WHERE user_id = $1 AND revoked_at IS NULL
        AND (active_org_id = $2 OR NOT EXISTS (SELECT 1 FROM auth_memberships m WHERE m.user_id = $1 AND NOT m.suspended))`, [userId, orgId]);
}

export const memberships = {
  list: (orgDirId: string) => P(async (db) =>
    (await db.query<MemberRow>(`${MEMBER_SQL} WHERE o.clerk_org_id = $1 ORDER BY m.created_at, m.user_id`, [String(orgDirId)])).map(toMembership)),
  /** A person's memberships across workspaces, read live (no cache: a change holds on the next request). */
  forUser: (userId: string) => P(async (db) =>
    (await db.query<MemberRow>(`${MEMBER_SQL} WHERE m.user_id = $1 AND o.clerk_org_id IS NOT NULL ORDER BY m.created_at, m.org_id`, [String(userId)])).map(toMembership)),
  setRole: (orgDirId: string, userId: string, role: "admin" | "member", metadata?: Record<string, unknown>) => P(async (db) => {
    const o = await orgRow(db, orgDirId);
    const r = await db.query("UPDATE auth_memberships SET role = $3, updated_at = now() WHERE org_id = $1 AND user_id = $2 RETURNING user_id", [o.id, String(userId), roleFrom(role, metadata)]);
    if (!r.length) throw new ClerkError("Not a member of this organization", 404);
    const [m] = await db.query<MemberRow>(`${MEMBER_SQL} WHERE m.org_id = $1 AND m.user_id = $2`, [o.id, String(userId)]);
    return changed(String(userId), toMembership(m!));
  }),
  setSuspended: (orgDirId: string, userId: string, suspended: boolean) => P(async (db) => {
    const o = await orgRow(db, orgDirId);
    const r = await db.query("UPDATE auth_memberships SET suspended = $3, updated_at = now() WHERE org_id = $1 AND user_id = $2 RETURNING user_id", [o.id, String(userId), suspended]);
    if (!r.length) throw new ClerkError("Not a member of this organization", 404);
    const [m] = await db.query<MemberRow>(`${MEMBER_SQL} WHERE m.org_id = $1 AND m.user_id = $2`, [o.id, String(userId)]);
    return changed(String(userId), toMembership(m!));
  }),
  /** Removes the person from the workspace and ends their sessions there (src/admin.ts removeMember also revokes their keys). */
  remove: (orgDirId: string, userId: string) => P(async (db) => db.transaction(async (tx) => {
    const o = await orgRow(tx, orgDirId);
    const [m] = await tx.query<MemberRow>(`${MEMBER_SQL} WHERE m.org_id = $1 AND m.user_id = $2`, [o.id, String(userId)]);
    if (!m) throw new ClerkError("Not a member of this organization", 404);
    await tx.query("DELETE FROM auth_memberships WHERE org_id = $1 AND user_id = $2", [o.id, String(userId)]);
    await revokeForRemoval(tx, o.id, String(userId));
    return changed(String(userId), toMembership(m));
  })),
};

export const invitations = {
  /**
   * Invite an address to a workspace with a role, for seven days, and email it (src/email.ts). Someone already in the
   * workspace is refused; an earlier pending invitation for the same address is replaced (revoked).
   */
  send: (orgDirId: string, email: string, role: "admin" | "member" = "member", publicMetadata: Record<string, unknown> = {}) => P(async (db) => {
    const e = normEmail(email);
    if (!e) throw new ClerkError("Enter a valid email address", 422);
    const accountRole = roleFrom(role, publicMetadata);
    const { inv, org } = await db.transaction(async (tx) => {
      const o = await orgRow(tx, orgDirId);
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`invite:${o.id}:${e}`]);
      const [already] = await tx.query("SELECT 1 FROM auth_memberships m JOIN auth_users u ON u.id = m.user_id WHERE m.org_id = $1 AND u.email = $2", [o.id, e]);
      if (already) throw new ClerkError(`${e} is already a member of this organization`, 409);
      await tx.query("UPDATE auth_invitations SET status = 'revoked', updated_at = now() WHERE org_id = $1 AND email = $2 AND status = 'pending'", [o.id, e]);
      const [x] = await tx.query<InviteRow>(
        `INSERT INTO auth_invitations (id, org_id, email, role, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING ${INVITE_COLS}`,
        [newId("inv_b"), o.id, e, accountRole, INVITE_DAYS]);
      return { inv: x!, org: o };
    });
    // The words and the link are the email module's (src/email.ts invitation): the one place that sends.
    const mail = await import("./email.js");
    void mail.invitation({ id: inv.id, to: e, account: org.name, accountSlug: org.slug, role: ACCOUNT_ROLE_LABELS[accountRole], google: googleConfigured(), days: INVITE_DAYS });
    return toInvitation(inv);
  }),
  list: (orgDirId: string) => P(async (db) => {
    const o = await orgRow(db, orgDirId);
    return (await db.query<InviteRow>(`SELECT ${INVITE_COLS} FROM auth_invitations WHERE org_id = $1 ORDER BY created_at DESC LIMIT 500`, [o.id])).map(toInvitation);
  }),
  revoke: (orgDirId: string, invitationId: string) => P(async (db) => {
    const o = await orgRow(db, orgDirId);
    const [x] = await db.query<InviteRow>(
      `UPDATE auth_invitations SET status = 'revoked', updated_at = now() WHERE id = $1 AND org_id = $2 AND status = 'pending' RETURNING ${INVITE_COLS}`, [String(invitationId), o.id]);
    if (!x) throw new ClerkError("Invitation not found or not pending", 404);
    return toInvitation(x);
  }),
};

// ---------- who may sign in ----------

/** A known person, a live invitation, or a platform admin named in the environment. */
export async function maySignIn(email: string): Promise<boolean> {
  // The query runs for every address, an environment admin's too, so the time taken says nothing about who is one.
  const admin = isPlatformAdminEmail(email);
  const known = await P(async (db) => {
    const [r] = await db.query<{ ok: boolean }>(
      `/* tenant: platform: who may sign in, by address, across workspaces */ SELECT EXISTS (SELECT 1 FROM auth_users WHERE email = $1)
           OR EXISTS (SELECT 1 FROM auth_invitations WHERE email = $1 AND status = 'pending' AND expires_at > now()) AS ok`, [email]);
    return Boolean(r?.ok);
  });
  return admin || known;
}

/**
 * The person behind a proven address, made or updated. Their live invitations are accepted here (each becomes a
 * membership with its role) only when they are in no workspace yet: someone who already has one accepts each new
 * invitation themselves (acceptInvitation; the console lists them), so an invitation cannot quietly move them into
 * another workspace, and their session opens the workspace they already had. For Google, the person is found by Google's stable id first, then by address; an address already
 * linked to another Google account is refused. Returns the person and the workspace to open first.
 */
export async function completeSignIn(email: string, how: { method: "email_code" | "google"; googleSub?: string; firstName?: string | null; lastName?: string | null }):
  Promise<{ userId: string; activeOrg: number | null } | { refused: string }> {
  return P((db) => db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`sign-in:${email}`]);
    let [u] = how.googleSub ? await tx.query<UserRow>(`SELECT ${USER_COLS} FROM auth_users WHERE google_sub = $1`, [how.googleSub]) : [];
    if (!u) [u] = await tx.query<UserRow>(`SELECT ${USER_COLS} FROM auth_users WHERE email = $1`, [email]);
    if (u && how.googleSub && u.google_sub && u.google_sub !== how.googleSub)
      return { refused: "This address is linked to another Google account. Sign in with an emailed code instead." };
    if (!u) {
      [u] = await tx.query<UserRow>(`INSERT INTO auth_users (id, email, first_name, last_name) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLS}`,
        [newId("user_b"), email, how.firstName?.slice(0, 100) || null, how.lastName?.slice(0, 100) || null]);
    }
    const userId = u!.id;
    // Only the address just proven is marked verified; a Google id is linked once, to the person with that address.
    await tx.query(
      `UPDATE auth_users SET last_sign_in_at = now(),
              email_verified_at = CASE WHEN email = $2 THEN coalesce(email_verified_at, now()) ELSE email_verified_at END,
              google_sub = coalesce(google_sub, $3),
              first_name = coalesce(first_name, $4), last_name = coalesce(last_name, $5)
        WHERE id = $1`, [userId, email, how.googleSub ?? null, how.firstName?.slice(0, 100) || null, how.lastName?.slice(0, 100) || null]);
    const [had] = await tx.query("SELECT 1 FROM auth_memberships WHERE user_id = $1 LIMIT 1", [userId]);
    // Invitations for the address on file only (a Google account whose address changed accepts nothing for the new one).
    const accepted = had || email !== u!.email ? [] : await tx.query<{ org_id: number; role: AccountRole; id: string }>(
      `UPDATE auth_invitations SET status = 'accepted', accepted_at = now(), accepted_by = $2, updated_at = now()
        WHERE email = $1 AND status = 'pending' AND expires_at > now() RETURNING org_id, role, id`, [email, userId]);
    for (const a of accepted)
      await tx.query("INSERT INTO auth_memberships (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO NOTHING", [a.org_id, userId, a.role]);
    if (accepted.length) changed(userId, null);
    const [first] = await tx.query<{ org_id: number }>(
      "SELECT org_id FROM auth_memberships WHERE user_id = $1 AND NOT suspended ORDER BY created_at, org_id LIMIT 1", [userId]);
    return { userId, activeOrg: first?.org_id ?? null };
  }));
}

/** Live invitations for the person's own (verified) address, for the console to offer. */
export async function pendingInvitations(userId: string) {
  return P(async (db) => (await db.query<{ id: string; role: AccountRole; expires_at: Date; dir_id: string; name: string }>(
    `/* tenant: platform: the signed-in person's own invitations, by their verified address */
     SELECT i.id, i.role, i.expires_at, o.clerk_org_id AS dir_id, o.name FROM auth_invitations i
       JOIN auth_users u ON u.email = i.email AND u.email_verified_at IS NOT NULL JOIN organizations o ON o.id = i.org_id
      WHERE u.id = $1 AND i.status = 'pending' AND i.expires_at > now() AND o.clerk_org_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM auth_memberships m WHERE m.org_id = i.org_id AND m.user_id = u.id)
      ORDER BY i.created_at`, [userId])).map((x) => ({ id: x.id, role: x.role, expires_at: new Date(x.expires_at).toISOString(), organization: { id: x.dir_id, name: x.name } })));
}

/** Accept one invitation to the person's own verified address: the membership, with the invitation's role. */
export async function acceptInvitation(userId: string, invitationId: string): Promise<{ orgId: number; dirId: string } | null> {
  return P((db) => db.transaction(async (tx) => {
    const [x] = await tx.query<{ org_id: number; role: AccountRole }>(
      `/* tenant: platform: an invitation to the signed-in person's own verified address */
       UPDATE auth_invitations i SET status = 'accepted', accepted_at = now(), accepted_by = $2, updated_at = now()
         FROM auth_users u WHERE i.id = $1 AND u.id = $2 AND u.email = i.email AND u.email_verified_at IS NOT NULL
          AND i.status = 'pending' AND i.expires_at > now() RETURNING i.org_id, i.role`, [invitationId, userId]);
    if (!x) return null;
    await tx.query("INSERT INTO auth_memberships (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO NOTHING", [x.org_id, userId, x.role]);
    const [o] = await tx.query<{ clerk_org_id: string }>("SELECT clerk_org_id FROM organizations WHERE id = $1", [x.org_id]);
    changed(userId, null);
    return { orgId: x.org_id, dirId: o!.clerk_org_id };
  }));
}

// ---------- sessions ----------

export const COOKIE_SECURE = "__Host-oct_session";
export const COOKIE_PLAIN = "oct_session";
const OAUTH_COOKIE = "oct_oauth_state";

/** Cookies by name; a value that is not valid percent-encoding is taken as it is (never throws). */
export function readCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.get("cookie") ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k in out) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}
const secureSite = (req: Request) => publicUrl().startsWith("https://") || req.secure;
const cookieLine = (name: string, value: string, maxAge: number, secure: boolean, path = "/") =>
  `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
const clearSessionCookies = (res: Response) =>
  [cookieLine(COOKIE_SECURE, "", 0, true), cookieLine(COOKIE_PLAIN, "", 0, false)];

/** On an https site only the `__Host-` cookie counts (a plain one could be planted by a sibling host or over http). */
const sessionToken = (req: Request) => {
  const jar = readCookies(req);
  const t = secureSite(req) ? jar[COOKIE_SECURE] : jar[COOKIE_SECURE] ?? jar[COOKIE_PLAIN];
  return t && /^[A-Za-z0-9_-]{40,64}$/.test(t) ? t : null;
};

export interface BuiltinSession extends SessionClaims { viaCookie: true; activeOrgId: number | null; method: string }

/** The signed-in person on a request (the session cookie), or null: unknown, expired, revoked. */
export async function sessionFromRequest(req: Request): Promise<BuiltinSession | null> {
  const t = sessionToken(req);
  if (!t) return null;
  return P(async (db) => {
    const [s] = await db.query<{ id: string; user_id: string; active_org_id: number | null; dir_id: string | null; method: string; last_seen_at: Date }>(
      `SELECT s.id, s.user_id, s.active_org_id, o.clerk_org_id AS dir_id, s.method, s.last_seen_at
         FROM auth_sessions s LEFT JOIN organizations o ON o.id = s.active_org_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [sha256(t)]);
    if (!s) return null;
    if (Date.now() - +new Date(s.last_seen_at) > 60_000) db.query("UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1", [s.id]).catch(() => {});
    return { userId: s.user_id, sessionId: s.id, orgId: s.dir_id, orgRole: null, viaCookie: true, activeOrgId: s.active_org_id, method: s.method };
  });
}

/** A new session for `userId`; the one the browser came with (if any) is ended. Sets the cookie. */
async function startSession(req: Request, res: Response, userId: string, method: "email_code" | "google", activeOrg: number | null) {
  const value = token(32), days = sessionDays(), old = sessionToken(req);
  await P(async (db) => {
    if (old) await db.query("UPDATE auth_sessions SET revoked_at = now(), revoked_why = 'replaced' WHERE token_hash = $1 AND revoked_at IS NULL", [sha256(old)]);
    await db.query(
      `INSERT INTO auth_sessions (id, token_hash, user_id, active_org_id, method, expires_at, user_agent) VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7)`,
      [newId("ses_b"), sha256(value), userId, activeOrg, method, days, String(req.get("user-agent") ?? "").slice(0, 200) || null]);
  });
  const secure = secureSite(req);
  res.append("Set-Cookie", [...clearSessionCookies(res).filter((l) => !l.startsWith(`${secure ? COOKIE_SECURE : COOKIE_PLAIN}=`)),
    cookieLine(secure ? COOKIE_SECURE : COOKIE_PLAIN, value, days * 86_400, secure)]);
}

/** End sessions: this one, every one of the person's, or every one but this. Returns how many ended. */
export async function revokeSessions(userId: string, opts: { only?: string; except?: string; why: string }): Promise<number> {
  return P(async (db) => (await db.query(
    `UPDATE auth_sessions SET revoked_at = now(), revoked_why = $2 WHERE user_id = $1 AND revoked_at IS NULL
        ${opts.only ? "AND id = $3" : opts.except ? "AND id <> $3" : ""} RETURNING id`,
    opts.only || opts.except ? [userId, opts.why, opts.only ?? opts.except] : [userId, opts.why])).length);
}

// ---------- the emailed code ----------

/** Whether codes can go out: the email module has a key and emails are on (src/email.ts emailStatus). */
export async function emailCodesReady(): Promise<boolean> {
  try { const { emailStatus } = await import("./email.js"); const s = await emailStatus(); return s.enabled && s.connected; }
  catch { return false; }
}

export type CodeRequest = { ok: true } | { ok: false; status: number; error: string; retry_after?: number };
/**
 * Make a code for `email` and send it when the address may sign in. The same answer, and the same writes, whoever it
 * is for: only the delivery differs (fired after the answer, never awaited).
 */
export async function requestCode(email: string, ip: string): Promise<CodeRequest> {
  const limit = limitsFor(null).endpoints.signin_codes_per_hour_per_address;
  const ipHash = hashed(ip);
  // Codes an hour for the address (a cap on guesses: at most limit x five tries an hour against 10^8 codes), and for the
  // address from one IP. There is no longer lock-out: anyone who knows an address could use it to keep its person out.
  const busy = await P(async (db) => {
    const [r] = await db.query<{ recent: number; mine: number }>(
      `SELECT count(*)::int AS recent, count(*) FILTER (WHERE ip_hash = $2)::int AS mine
         FROM auth_codes WHERE email = $1 AND created_at > now() - interval '1 hour'`, [email, ipHash]);
    return r!;
  });
  if (busy.recent >= limit || busy.mine >= CODES_PER_ADDRESS_AND_IP) return { ok: false, status: 429, error: "Too many codes for this address. Try again in an hour.", retry_after: 3600 };
  const deliverable = await maySignIn(email);
  const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
  const id = await P(async (db) => db.transaction(async (tx) => {
    // A new code retires the older ones: only the newest can be used.
    await tx.query("UPDATE auth_codes SET consumed_at = now() WHERE email = $1 AND consumed_at IS NULL", [email]);
    const [r] = await tx.query<{ id: number }>(
      "INSERT INTO auth_codes (email, code_hash, deliverable, ip_hash, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5)) RETURNING id",
      [email, codeHash(email, code), deliverable, ipHash, CODE_TTL_MINUTES]);
    // Old rows go now and then (a day of them is what the limits read).
    if (Math.random() < 0.02) await tx.query("DELETE FROM auth_codes WHERE created_at < now() - interval '2 days'");
    return Number(r!.id);
  }));
  if (deliverable) {
    const mail = await import("./email.js");
    void mail.signInCode({ id, to: email, code, minutes: CODE_TTL_MINUTES });
  }
  return { ok: true };
}

/** One message for a wrong, expired, used or unknown code: which one it was helps only someone guessing. */
export const CODE_REFUSED = "That code is wrong or has expired. Ask for a new one.";

/** Check a code for `email`: the newest unused one, counted before it is compared, used once. */
export async function checkCode(email: string, code: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!new RegExp(`^\\d{${CODE_DIGITS}}$`).test(code)) return { ok: false, status: 400, error: `The code is ${CODE_DIGITS} digits.` };
  return P(async (db) => {
    const [row] = await db.query<{ id: number; code_hash: string; deliverable: boolean; expires_at: Date; attempts: number }>(
      "SELECT id, code_hash, deliverable, expires_at, attempts FROM auth_codes WHERE email = $1 AND consumed_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1", [email]);
    const want = Buffer.from(codeHash(email, code), "hex");
    if (!row || +new Date(row.expires_at) <= Date.now()) { timingSafeEqual(want, want); return { ok: false, status: 401, error: CODE_REFUSED }; }
    // Count the try before comparing, in one statement, so tries at once cannot pass the limit together.
    const [counted] = await db.query<{ attempts: number }>(
      "UPDATE auth_codes SET attempts = attempts + 1 WHERE id = $1 AND consumed_at IS NULL AND attempts < $2 RETURNING attempts", [row.id, CODE_MAX_ATTEMPTS]);
    if (!counted) return { ok: false, status: 429, error: "Too many wrong tries on this code. Ask for a new one." };
    const match = timingSafeEqual(want, Buffer.from(row.code_hash, "hex")) && row.deliverable;
    if (!match) return { ok: false, status: 401, error: CODE_REFUSED };
    const [used] = await db.query("UPDATE auth_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id", [row.id]);
    if (!used) return { ok: false, status: 401, error: CODE_REFUSED };
    return { ok: true };
  });
}

// ---------- Google ----------

export const googleConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const google = () => ({
  clientId: process.env.GOOGLE_CLIENT_ID!, secret: process.env.GOOGLE_CLIENT_SECRET!,
  authUrl: process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
  jwksUrl: process.env.GOOGLE_JWKS_URL || "https://www.googleapis.com/oauth2/v3/certs",
  issuers: (process.env.GOOGLE_ISSUER || "https://accounts.google.com,accounts.google.com").split(",").map((x) => x.trim()).filter(Boolean),
});
/**
 * Google sends the person back to GOOGLE_REDIRECT_URI, else to /api/auth/google/callback on the origin the browser is on
 * (the console's, through its proxy). Google accepts only the redirect URIs registered for the client, so a forged
 * Host cannot send anyone elsewhere; the same URI is kept with the state for the token exchange.
 */
const redirectUriFor = (req: Request) => process.env.GOOGLE_REDIRECT_URI || `${browserOrigin(req)}/api/auth/google/callback`;
let googleKeys: { url: string; set: ReturnType<typeof createRemoteJWKSet> } | null = null;
const googleJwks = (url: string) => (googleKeys?.url === url ? googleKeys.set : (googleKeys = { url, set: createRemoteJWKSet(new URL(url)) }).set);

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

/** The Google authorization URL for a new sign-in, and the cookie that binds it to this browser. */
async function googleStart(req: Request, res: Response) {
  const g = google();
  const state = token(32), verifier = token(48), nonce = token(24);
  const redirectUri = redirectUriFor(req);
  await P((db) => db.query("INSERT INTO auth_oauth_states (state_hash, verifier, nonce, redirect, redirect_uri, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')",
    [sha256(state), verifier, nonce, safeRedirect(req.query.redirect_url), redirectUri]));
  P((db) => db.query("DELETE FROM auth_oauth_states WHERE expires_at < now() - interval '1 hour'")).catch(() => {});
  const q = new URLSearchParams({ client_id: g.clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile", state, nonce,
    code_challenge: s256(verifier), code_challenge_method: "S256", prompt: "select_account" });
  res.append("Set-Cookie", cookieLine(OAUTH_COOKIE, state, 600, secureSite(req), "/api/auth/google"));
  res.set("Cache-Control", "no-store").redirect(302, `${g.authUrl}?${q}`);
}

const signInPage = (error: string) => `/auth/sign-in?error=${encodeURIComponent(error)}`;

/** Google's answer: the browser's own state, the code exchanged with PKCE, the ID token checked; then the session. */
async function googleCallback(req: Request, res: Response) {
  res.set("Cache-Control", "no-store");
  res.append("Set-Cookie", cookieLine(OAUTH_COOKIE, "", 0, secureSite(req), "/api/auth/google"));
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const cookie = readCookies(req)[OAUTH_COOKIE] ?? "";
  if (!state || !cookie || state.length !== cookie.length || !timingSafeEqual(Buffer.from(state), Buffer.from(cookie)))
    return void res.redirect(302, signInPage("google_state"));
  const [st] = await P((db) => db.query<{ verifier: string; nonce: string; redirect: string; redirect_uri: string }>(
    "DELETE FROM auth_oauth_states WHERE state_hash = $1 AND expires_at > now() RETURNING verifier, nonce, redirect, redirect_uri", [sha256(state)]));
  if (!st) return void res.redirect(302, signInPage("google_state"));
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code || req.query.error) return void res.redirect(302, signInPage("google_cancelled"));
  const g = google();
  let claims: Record<string, unknown>;
  try {
    const r = await fetch(g.tokenUrl, { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: st.redirect_uri, client_id: g.clientId, client_secret: g.secret, code_verifier: st.verifier }) });
    const j = await r.json().catch(() => ({})) as { id_token?: string };
    if (!r.ok || typeof j.id_token !== "string") throw new Error(`token endpoint answered ${r.status}`);
    ({ payload: claims } = await jwtVerify(j.id_token, googleJwks(g.jwksUrl), { issuer: g.issuers, audience: g.clientId, clockTolerance: 5 }));
  } catch (e) {
    console.error(`google sign-in: ${(e as Error).message}`);
    return void res.redirect(302, signInPage("google_failed"));
  }
  const email = normEmail(claims.email);
  if (claims.nonce !== st.nonce || !email || !(claims.email_verified === true || claims.email_verified === "true") || typeof claims.sub !== "string" || !claims.sub)
    return void res.redirect(302, signInPage("google_failed"));
  // Google speaks for an address only when it hosts its mailbox: a Gmail address, or a Google Workspace account of the
  // address's own domain (the hd claim). A consumer Google account made with a work address stays "verified" after its
  // owner leaves that mailbox, so it proves nothing: that person signs in with an emailed code.
  const domain = email.split("@")[1]!;
  if (!(["gmail.com", "googlemail.com"].includes(domain) || (typeof claims.hd === "string" && claims.hd.toLowerCase() === domain)))
    return void res.redirect(302, signInPage("google_not_authoritative"));
  const known = await P(async (db) => (await db.query("SELECT 1 FROM auth_users WHERE google_sub = $1", [claims.sub])).length > 0);
  if (!known && !(await maySignIn(email))) return void res.redirect(302, signInPage("not_invited"));
  const done = await completeSignIn(email, { method: "google", googleSub: claims.sub, firstName: typeof claims.given_name === "string" ? claims.given_name : null,
    lastName: typeof claims.family_name === "string" ? claims.family_name : null });
  if ("refused" in done) return void res.redirect(302, signInPage("google_linked_elsewhere"));
  await startSession(req, res, done.userId, "google", done.activeOrg);
  res.redirect(302, st.redirect);
}

// ---------- routes: /api/auth ----------

/**
 * A browser change must come from this site: an Origin header, when there is one, names this server's public address
 * or the host the request came to (a page on another site gets a 403), and the body is JSON (a cross-site form cannot
 * send that without a preflight this server never answers).
 */
function sameSite(req: Request): boolean {
  const origin = req.get("origin");
  if (!origin) return true;
  const allowed = new Set([new URL(publicUrl()).origin, new URL(consoleUrl()).origin, ...(process.env.OCTILLION_AUTH_ORIGINS ?? "").split(",").map((x) => x.trim().replace(/\/$/, "")).filter(Boolean)]);
  const host = req.get("x-forwarded-host") ?? req.get("host");
  if (host) allowed.add(`${req.protocol}://${host}`);
  return allowed.has(origin.replace(/\/$/, ""));
}

const ipBucket = async (req: Request, res: Response, kind: "signin_per_hour_per_ip" | "signin_checks_per_hour_per_ip") => {
  const limit = limitsFor(null).endpoints[kind];
  const r = await hit([{ bucket: `${kind}:${hashed(req.ip ?? "?")}`, limit, what: "address" }], 3600);
  if (!r) return false;
  res.status(429).set("Retry-After", String(r.retry_after)).json({ error: `Too many sign-in attempts from this network. Try again in ${Math.ceil(r.retry_after / 60)} minutes.`, code: "rate_limited", retry_after: r.retry_after });
  return true;
};

/** The person's view of themselves for the console (src/people.ts sessionView reads the same). */
export async function sessionView(s: BuiltinSession) {
  const [u, ms] = await Promise.all([users.get(s.userId), memberships.forUser(s.userId)]);
  const active = ms.find((m) => m.organization!.id === s.orgId) ?? ms.find((m) => !(m.public_metadata?.suspended === true)) ?? null;
  const google = await P(async (db) => (await db.query<{ g: boolean }>("SELECT google_sub IS NOT NULL AS g FROM auth_users WHERE id = $1", [s.userId]))[0]?.g ?? false);
  return {
    signed_in: true, provider: "builtin" as const, session_id: s.sessionId, method: s.method,
    user: { id: u.id, email: u.email_addresses[0]?.email_address ?? null, first_name: u.first_name, last_name: u.last_name, google },
    active_organization: active ? { id: active.organization!.id, name: active.organization!.name, slug: active.organization!.slug } : null,
    memberships: ms.map((m) => ({ organization: { id: m.organization!.id, name: m.organization!.name, slug: m.organization!.slug },
      role: m.role, account_role: m.public_metadata?.octillion_role ?? null, suspended: m.public_metadata?.suspended === true })),
    invitations: await pendingInvitations(s.userId),
  };
}

export function builtinAuthRouter(): Router {
  const r = express.Router();
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  // What the sign-in page shows: open to anyone, under either provider.
  r.get("/config", async (_req, res) => {
    if (!builtinAuth()) return void res.json({ provider: "clerk" });
    res.json({ provider: "builtin", email_code: await emailCodesReady(), google: googleConfigured() });
  });
  r.use((_req, res, next) => (builtinAuth() ? next() : void res.status(404).json({ error: "This server signs people in with Clerk" })));
  const json = express.json({ limit: "4kb" });
  /** A change: same site, JSON body. */
  const change = (req: Request, res: Response, next: NextFunction) => {
    if (!sameSite(req)) return void res.status(403).json({ error: "This request came from another site" });
    if (!req.is("application/json")) return void res.status(415).json({ error: "Send JSON (Content-Type: application/json)" });
    json(req, res, (err?: unknown) => (err ? void res.status(400).json({ error: "The request body must be JSON" }) : next()));
  };
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => void fn(req, res).catch(next);

  r.post("/email/request", change, wrap(async (req, res) => {
    if (await ipBucket(req, res, "signin_per_hour_per_ip")) return;
    const email = normEmail(req.body?.email);
    if (!email) return void res.status(400).json({ error: "Enter a valid email address." });
    if (!(await emailCodesReady())) return void res.status(503).json({ error: "Email sign-in is not set up on this server yet (no email provider). Ask your administrator.", code: "email_off" });
    const out = await requestCode(email, req.ip ?? "?");
    if (!out.ok) return void res.status(out.status).set(out.retry_after ? { "Retry-After": String(out.retry_after) } : {}).json({ error: out.error, code: "rate_limited" });
    res.json({ ok: true, message: "If that address can sign in here, a code is on its way. It works for 10 minutes." });
  }));

  r.post("/email/verify", change, wrap(async (req, res) => {
    if (await ipBucket(req, res, "signin_checks_per_hour_per_ip")) return;
    const email = normEmail(req.body?.email);
    const code = String(req.body?.code ?? "").replace(/\s+/g, "");
    if (!email) return void res.status(400).json({ error: "Enter a valid email address." });
    const checked = await checkCode(email, code);
    if (!checked.ok) return void res.status(checked.status).json({ error: checked.error });
    // The invitation may have been withdrawn while the code was in the inbox: ask again.
    if (!(await maySignIn(email))) return void res.status(401).json({ error: CODE_REFUSED });
    const done = await completeSignIn(email, { method: "email_code" });
    if ("refused" in done) return void res.status(409).json({ error: done.refused });
    await startSession(req, res, done.userId, "email_code", done.activeOrg);
    res.json({ ok: true, redirect: safeRedirect(req.body?.redirect_url) });
  }));

  r.get("/google/start", wrap(async (req, res) => {
    if (!googleConfigured()) return void res.status(404).json({ error: "Google sign-in is not set up on this server" });
    if (await ipBucket(req, res, "signin_per_hour_per_ip")) return;
    await googleStart(req, res);
  }));
  r.get("/google/callback", wrap(async (req, res) => {
    if (!googleConfigured()) return void res.status(404).json({ error: "Google sign-in is not set up on this server" });
    if (await ipBucket(req, res, "signin_checks_per_hour_per_ip")) return;
    await googleCallback(req, res);
  }));

  r.get("/session", wrap(async (req, res) => {
    const s = await sessionFromRequest(req);
    if (!s) return void res.json({ signed_in: false, provider: "builtin" });
    res.json(await sessionView(s));
  }));

  const signedIn = async (req: Request, res: Response) => {
    const s = await sessionFromRequest(req);
    if (!s) res.status(401).json({ error: "Sign in", sign_in_url: "/auth/sign-in" });
    return s;
  };
  r.post("/sign-out", change, wrap(async (req, res) => {
    const s = await sessionFromRequest(req);
    if (s) await revokeSessions(s.userId, { only: s.sessionId!, why: "signed_out" });
    res.append("Set-Cookie", clearSessionCookies(res)).json({ ok: true });
  }));
  // Every session of this person, this one included (a lost laptop, a shared computer).
  r.post("/sign-out/everywhere", change, wrap(async (req, res) => {
    const s = await signedIn(req, res);
    if (!s) return;
    const n = await revokeSessions(s.userId, { why: "signed_out_everywhere" });
    res.append("Set-Cookie", clearSessionCookies(res)).json({ ok: true, ended: n });
  }));
  r.post("/sign-out/others", change, wrap(async (req, res) => {
    const s = await signedIn(req, res);
    if (!s) return;
    res.json({ ok: true, ended: await revokeSessions(s.userId, { except: s.sessionId!, why: "signed_out_elsewhere" }) });
  }));
  // Switch the workspace this session works in: one the person is an active member of.
  r.post("/active-org", change, wrap(async (req, res) => {
    const s = await signedIn(req, res);
    if (!s) return;
    const want = String(req.body?.organization_id ?? "");
    const m = (await memberships.forUser(s.userId)).find((x) => x.organization!.id === want && x.public_metadata?.suspended !== true);
    if (!m) return void res.status(404).json({ error: "You are not in that workspace" });
    await P((db) => db.query("UPDATE auth_sessions SET active_org_id = (SELECT id FROM organizations WHERE clerk_org_id = $2) WHERE id = $1", [s.sessionId, want]));
    res.json({ ok: true, active_organization: { id: m.organization!.id, name: m.organization!.name } });
  }));
  // Accept an invitation to your own address (someone already in a workspace accepts each new one here).
  r.post("/invitations/:id/accept", change, wrap(async (req, res) => {
    const s = await signedIn(req, res);
    if (!s) return;
    const done = await acceptInvitation(s.userId, String(req.params.id));
    if (!done) return void res.status(404).json({ error: "No such invitation for your address, or it expired" });
    res.json({ ok: true, organization_id: done.dirId });
  }));
  r.post("/profile", change, wrap(async (req, res) => {
    const s = await signedIn(req, res);
    if (!s) return;
    const clean = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100) || null : null);
    await P((db) => db.query("UPDATE auth_users SET first_name = $2, last_name = $3 WHERE id = $1", [s.userId, clean(req.body?.first_name), clean(req.body?.last_name)]));
    res.json({ ok: true });
  }));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  r.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`builtin sign-in: ${err.message}`);
    res.status(err instanceof ClerkError ? err.status : 500).json({ error: err instanceof ClerkError ? err.message : "Sign-in failed on the server. Try again." });
  });
  return r;
}

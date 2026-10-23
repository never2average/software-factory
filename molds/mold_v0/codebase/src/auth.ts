import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "./db.js";
import { clerkEnabled, isSuspended, mcpAudiences, memberships, onMembershipChange, organizations, verifyOAuthToken } from "./clerk.js";
import { people } from "./people.js";
import { accountRoleOf, type AccountRole } from "./account-roles.js";

/** The tenant a request acts for. Every query in queries.ts is scoped by orgId. */
export interface Org {
  orgId: number;
  slug: string;
  name: string;
  /** The Clerk user, when the request came with a Clerk token (absent for legacy API keys). */
  userId?: string;
  /** Their account role (src/account-roles.ts), from the Clerk membership; absent for legacy API keys (no limits). */
  role?: AccountRole;
  /** The API key's row id, when the request came with a key (rate limits and usage per key, mold_v0-018/008); never the key. */
  keyId?: number;
  /** The MCP client, as its User-Agent names it ("name/version"), for usage per client (mold_v0-008). */
  client?: { name: string | null; version: string | null };
  /**
   * Platform staff acting for this workspace through the admin MCP (an admin_only tool, mold_v0-067): their calls are
   * written to the workspace's activity log as "staff:<pseudonym>" (src/analytics.ts staffId) and the runs they start
   * pass the account's own launch rules (src/limits.ts checkAccountRun). Absent for every customer call.
   */
  staff?: string;
}

const KEY_PREFIX = "oct_";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomId = (prefix: string, bytes = 9) => `${prefix}${randomBytes(bytes).toString("base64url")}`;

export const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "org";

/** Create an organization and its first API key. The key is returned once and only its hash is stored. */
export async function createOrg(name: string, slug = slugify(name)) {
  const db = await getDb();
  const [org] = await db.query<{ id: number; slug: string; name: string }>(
    "INSERT INTO organizations (slug, name) VALUES ($1, $2) RETURNING id, slug, name",
    [slug, name],
  );
  const key = await createApiKey(org.id);
  return { org: { orgId: org.id, slug: org.slug, name: org.name } satisfies Org, key };
}

export async function createApiKey(orgId: number, label = "default", userId: string | null = null): Promise<string> {
  const key = randomId(KEY_PREFIX, 24);
  const db = await getDb();
  await db.query("INSERT INTO api_keys (org_id, label, key_prefix, key_hash, user_id) VALUES ($1, $2, $3, $4, $5)", [
    orgId,
    label,
    key.slice(0, KEY_PREFIX.length + 6),
    sha256(key),
    userId,
  ]);
  return key;
}

/**
 * Resolve an API key to its organization, or null if it is unknown, revoked or expired. A member key (mold_v0-007,
 * src/member-keys.ts) acts as its person with their current role in the workspace, read on every call through Clerk's
 * 30-second membership cache (cleared on the instance that changes a membership: a removal, suspension or role change
 * made elsewhere, in Clerk or on another instance, holds within 30 seconds), and is
 * refused when it came in a URL (`inUrl`: the legacy /mcp/<key> path and the preview's ?key=): a member key is
 * header-only. Older keys (the account's own, and those staff issued for a person) resolve exactly as before.
 */
export async function resolveKey(key: string | undefined | null, opts: { inUrl?: boolean } = {}): Promise<Org | null> {
  if (!key || !key.startsWith(KEY_PREFIX)) return null;
  const db = await getDb();
  const [row] = await db.query<{ id: number; org_id: number; slug: string; name: string; user_id: string | null; scoped: boolean; clerk_org_id: string | null }>(
    `SELECT k.id, k.org_id, o.slug, o.name, k.user_id, k.scoped, o.clerk_org_id
       FROM api_keys k JOIN organizations o ON o.id = k.org_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())`,
    [sha256(key)],
  );
  if (!row) return null;
  let role: AccountRole | undefined;
  if (row.scoped) {
    if (opts.inUrl || !row.user_id) return null;
    const r = await memberRole(row.user_id, row.clerk_org_id);
    if (!r) return null;
    role = r;
  }
  // Best effort; never block the request on it.
  db.query("/* tenant: the key row just resolved by its hash */ UPDATE api_keys SET last_used_at = now() WHERE id = $1", [row.id]).catch(() => {});
  // A key issued to a person acts as that person (usage, adoption, limits); an account key has no person. A member key
  // also carries the person's role, so it can do no more than they can.
  return { orgId: row.org_id, slug: row.slug, name: row.name, ...(row.user_id ? { userId: row.user_id } : {}), ...(role ? { role } : {}), keyId: Number(row.id) };
}

/**
 * A person's current role in the workspace whose directory id (organizations.clerk_org_id: a Clerk organization, or the
 * built-in directory's id, src/people.ts) is `clerkOrgId`, or null when they are not in it (left, removed), are
 * suspended, or it cannot be read (sign-in off or failing: a member key fails closed). Built-in memberships are read
 * live; Clerk's through its 30-second cache.
 */
export async function memberRole(userId: string, clerkOrgId: string | null): Promise<AccountRole | null> {
  const dir = people();
  if (!clerkOrgId || !dir.enabled()) return null;
  try {
    const m = (await dir.memberships.forUser(userId)).find((x) => x.organization?.id === clerkOrgId);
    return m && !isSuspended(m) ? accountRoleOf(m) : null;
  } catch (e) {
    console.error(`member key: the membership could not be read (${(e as Error).message}): refused`);
    return null;
  }
}

/** Constant-time check of the orchestrator's shared worker token (OCTILLION_WORKER_TOKEN). */
export function isWorkerToken(token: string | undefined | null): boolean {
  const expected = process.env.OCTILLION_WORKER_TOKEN;
  if (!expected || !token) return false;
  const a = Buffer.from(sha256(token));
  const b = Buffer.from(sha256(expected));
  return timingSafeEqual(a, b);
}

/** The Vercel cron's bearer (CRON_SECRET), in constant time. Nothing else opens /api/cron/*. */
export function cronSecretOk(authorization: string | undefined): boolean {
  const want = process.env.CRON_SECRET, got = bearer(authorization);
  if (!want || !got) return false;
  return timingSafeEqual(Buffer.from(sha256(got)), Buffer.from(sha256(want)));
}

export function bearer(header: string | undefined): string | null {
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/**
 * The credential an MCP request carries in a header: `Authorization: Bearer <oct_ key or OAuth token>`, else
 * `X-API-Key: oct_...` (for clients whose header setting is a plain name/value pair). Never read from the URL: a URL
 * ends up in proxy and access logs, browser history, Referer headers and screenshots.
 */
export function headerCredential(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = bearer(typeof headers.authorization === "string" ? headers.authorization : undefined);
  if (auth) return auth;
  const x = headers["x-api-key"];
  const v = (Array.isArray(x) ? x[0] : x)?.trim();
  return v && /^\S+$/.test(v) ? v : null;
}

/**
 * Legacy connector URLs (/mcp/oct_...) put the key in the URL. OCTILLION_URL_KEYS:
 *   allow (default)  still accepted, deprecated: each response says so (Deprecation header) and the server logs which
 *                    account and key used one, so those people can be moved to a header or to sign-in
 *   off              refused with a 401 that says how to send the key instead
 * New keys are never issued as URLs (src/admin.ts connectInfo).
 */
export const urlKeysAllowed = () => (process.env.OCTILLION_URL_KEYS ?? "allow").trim().toLowerCase() !== "off";

// ---------- Clerk users on /mcp (OAuth) ----------

const tokenOrgs = new Map<string, { org: Org; at: number }>();
onMembershipChange((userId) => tokenOrgs.delete(userId)); // a suspended person is cut off at once, not after the cache

/**
 * Resolve a Clerk OAuth access token issued for /mcp (its audience is checked, src/clerk.ts) to the organization the user acts for: their oldest Clerk membership that is not
 * suspended. A Clerk organization created in the Clerk dashboard gets its Octillion row on first use.
 */
export async function resolveUserToken(token: string): Promise<Org | null> {
  const claims = await verifyOAuthToken(token, mcpAudiences()); // issued for /mcp, not another resource
  if (!claims) return null;
  const hit = tokenOrgs.get(claims.userId);
  if (hit && Date.now() - hit.at < 60_000) return hit.org;
  const ms = (await memberships.forUser(claims.userId)).filter((m) => !isSuspended(m) && m.organization)
    .sort((a, b) => a.created_at - b.created_at);
  if (!ms.length) return null;
  const found = await orgForClerk(ms[0].organization!.id);
  const org = found ? { ...found, userId: claims.userId, role: accountRoleOf(ms[0]) } : null;
  if (org) tokenOrgs.set(claims.userId, { org, at: Date.now() });
  return org;
}

/** The Octillion organization joined to a Clerk organization, created (and linked by slug metadata) on first sight. */
const selfServe = () => (process.env.OCTILLION_SELF_SERVE_ACCOUNTS ?? "off").toLowerCase() === "on";

/** The Octillion account for a Clerk organization: linked by id, or by the octillion_slug Octillion wrote when it
 *  created the organization; a new account only in self-serve mode. */
export async function orgForClerk(clerkOrgId: string): Promise<Org | null> {
  const db = await getDb();
  const find = async () => (await db.query<{ id: number; slug: string; name: string }>(
    "SELECT id, slug, name FROM organizations WHERE clerk_org_id = $1", [clerkOrgId]))[0];
  let row = await find();
  if (!row) {
    if (!clerkEnabled()) return null;
    const c = await organizations.get(clerkOrgId);
    const known = typeof c.public_metadata?.octillion_slug === "string" ? c.public_metadata.octillion_slug : null;
    const bySlug = known
      ? (await db.query<{ id: number }>("SELECT id FROM organizations WHERE slug = $1 AND clerk_org_id IS NULL", [known]))[0]
      : undefined;
    if (bySlug) await db.query("UPDATE organizations SET clerk_org_id = $2 WHERE id = $1", [bySlug.id, clerkOrgId]);
    // Accounts are invite-only: a Clerk organization someone made for themselves is not an Octillion account unless
    // self-serve is switched on (OCTILLION_SELF_SERVE_ACCOUNTS=on).
    else if (!selfServe()) return null;
    else {
      let slug = slugify(c.name);
      if ((await db.query("SELECT 1 FROM organizations WHERE slug = $1", [slug])).length) slug = `${slug.slice(0, 40)}-${randomBytes(3).toString("hex")}`;
      await db.query("INSERT INTO organizations (slug, name, clerk_org_id) VALUES ($1, $2, $3) ON CONFLICT (clerk_org_id) DO NOTHING", [slug, c.name, clerkOrgId]);
      await organizations.setMetadata(clerkOrgId, { octillion_slug: slug }).catch((err) => console.error("clerk metadata:", (err as Error).message));
    }
    row = await find();
  }
  return row ? { orgId: row.id, slug: row.slug, name: row.name } : null;
}

/**
 * Who may open an account here (mold_v0-098; the console's landing and sign-up pages say so): `invite_only`, the
 * platform's staff make every account and a person asks for access (POST /api/access-requests); `self_serve`, a Clerk
 * organization someone makes becomes an account on first sight (orgForClerk). The built-in sign-in is always invite-only.
 */
export const accountsMode = (): "invite_only" | "self_serve" => (clerkEnabled() && selfServe() ? "self_serve" : "invite_only");

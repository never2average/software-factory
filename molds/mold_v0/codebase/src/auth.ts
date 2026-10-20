import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "./db.js";
import { clerkEnabled, isSuspended, memberships, onMembershipChange, organizations, verifyOAuthToken } from "./clerk.js";
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

/** Resolve an API key to its organization, or null if it is unknown or revoked. */
export async function resolveKey(key: string | undefined | null): Promise<Org | null> {
  if (!key || !key.startsWith(KEY_PREFIX)) return null;
  const db = await getDb();
  const [row] = await db.query<{ id: number; org_id: number; slug: string; name: string; user_id: string | null }>(
    `SELECT k.id, k.org_id, o.slug, o.name, k.user_id
       FROM api_keys k JOIN organizations o ON o.id = k.org_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [sha256(key)],
  );
  if (!row) return null;
  // Best effort; never block the request on it.
  db.query("/* tenant: the key row just resolved by its hash */ UPDATE api_keys SET last_used_at = now() WHERE id = $1", [row.id]).catch(() => {});
  // A key issued to a person acts as that person (usage, adoption, limits); an account key has no person.
  return { orgId: row.org_id, slug: row.slug, name: row.name, ...(row.user_id ? { userId: row.user_id } : {}) };
}

/** Constant-time check of the orchestrator's shared worker token (OCTILLION_WORKER_TOKEN). */
export function isWorkerToken(token: string | undefined | null): boolean {
  const expected = process.env.OCTILLION_WORKER_TOKEN;
  if (!expected || !token) return false;
  const a = Buffer.from(sha256(token));
  const b = Buffer.from(sha256(expected));
  return timingSafeEqual(a, b);
}

export function bearer(header: string | undefined): string | null {
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

// ---------- Clerk users on /mcp (OAuth) ----------

const tokenOrgs = new Map<string, { org: Org; at: number }>();
onMembershipChange((userId) => tokenOrgs.delete(userId)); // a suspended person is cut off at once, not after the cache

/**
 * Resolve a Clerk OAuth access token to the organization the user acts for: their oldest Clerk membership that is not
 * suspended. A Clerk organization created in the Clerk dashboard gets its Octillion row on first use.
 */
export async function resolveUserToken(token: string): Promise<Org | null> {
  const claims = await verifyOAuthToken(token);
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

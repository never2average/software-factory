/**
 * The platform account (mold_v0-276): the one account the platform's own staff use the customer portal (/app) in, so a
 * platform admin never meets the page for someone with no account.
 *
 *   One account, shared. Every platform admin is an owner of the same account (other platform roles join it with a
 *   lesser role: viewer as viewer, support and operator as member), rather than one account each: staff see the same
 *   portal, the same records and the same bill; the accounts list, the funnel and Stripe get one row for the platform,
 *   not one per person; and adding or removing an admin is a membership, never an account to make or to clean up.
 *   Named from the build's brand ("<name> (platform)", src/profile.ts) under a stable slug (`platform`, or the first free
 *   one after it), and marked on its row (organizations.platform_account, sql/migrations/0058_platform_account.sql), so a
 *   rename or a customer account that took the slug first never makes a second one.
 *   Made the way staff make an account (src/admin.ts createPlatformAccount: the directory's organization, the app's row,
 *   the Stripe customer as for any account), under either sign-in (Clerk or the built-in one).
 *
 *   When. At sign-in to the portal: a platform admin whose request finds no account open for them (src/app.ts
 *   customerSession) gets the account made if there is none and is added to it, then lands in it as owner; a second
 *   sign-in finds them there and makes nothing. After every deploy, the factory calls POST /api/cron/platform-account
 *   (CRON_SECRET or APP_WORKER_TOKEN, src/http.ts; .claude/scripts/lib/single_service.py), which makes the account and
 *   adds every platform admin who has signed in before, so the portal works for them straight away. An address added to
 *   APP_PLATFORM_ADMINS gets in at its next sign-in; one removed keeps its membership, and the account is never deleted
 *   here (an owner of the account or staff remove the person on its Team page, as anyone's).
 *   A membership staff suspended is left alone: the person then sees the portal's suspended page, never a new account.
 *
 *   Audited. The account made, each member added and each role raised: a staff log line (src/admin.ts log) and, with the
 *   platform trail on, a staff entry in the account's slice of it (src/audit-trail.ts auditPlatformAccount).
 */
import * as admin from "./admin.js";
import { roleOfUser, type PlatformRole } from "./admin-roles.js";
import { accountRoleOf, clerkRoleFor, type AccountRole } from "./account-roles.js";
import { auditPlatformAccount } from "./audit-trail.js";
import { orgForClerk, type Org } from "./auth.js";
import * as clerk from "./clerk.js";
import { getDb } from "./db.js";
import { people } from "./people.js";
import { PROFILE } from "./profile.js";
import { asPlatform } from "./tenant-scope.js";

/** The slug the account is made under, when no account holds it. */
export const PLATFORM_SLUG = "platform";
/** Its name: the build's brand, then "(platform)". */
export const platformAccountName = () => `${PROFILE.name} (platform)`;

/** The account role a platform role gets in the platform account: owners own it; the others work in it. */
export const accountRoleForStaff = (r: PlatformRole): AccountRole => (r === "owner" ? "owner" : r === "viewer" ? "viewer" : "member");

export interface PlatformAccountRow { id: number; slug: string; name: string; clerk_org_id: string | null }

/** The marked account, or null. */
export async function findPlatformAccount(): Promise<PlatformAccountRow | null> {
  return asPlatform(async () => (await (await getDb()).query<PlatformAccountRow>(
    "/* tenant: platform: the platform account, by its mark */ SELECT id, slug, name, clerk_org_id FROM organizations WHERE platform_account ORDER BY id LIMIT 1"))[0] ?? null);
}

/** `platform`, else `platform-account`, else `platform-2`, ...: the first slug no account holds. */
async function freeSlug(): Promise<string> {
  const db = await getDb();
  const taken = new Set((await db.query<{ slug: string }>(
    "/* tenant: platform: which candidate slugs are taken */ SELECT slug FROM organizations WHERE slug = $1 OR slug LIKE $1 || '-%'", [PLATFORM_SLUG])).map((r) => r.slug));
  for (const s of [PLATFORM_SLUG, `${PLATFORM_SLUG}-account`]) if (!taken.has(s)) return s;
  for (let i = 2; ; i++) if (!taken.has(`${PLATFORM_SLUG}-${i}`)) return `${PLATFORM_SLUG}-${i}`;
}

let making: Promise<{ account: PlatformAccountRow; created: boolean }> | null = null;
/**
 * The platform account, made now when there is none. One maker per process at a time; across processes the one-mark
 * index refuses a second row, and the loser reads the winner's.
 */
export async function ensurePlatformAccount(actor: string): Promise<{ account: PlatformAccountRow; created: boolean }> {
  const there = await findPlatformAccount();
  if (there) return { account: there, created: false };
  making ??= (async () => {
    try {
      const again = await findPlatformAccount();
      if (again) return { account: again, created: false };
      const name = platformAccountName();
      try {
        await asPlatform(async () => admin.createPlatformAccount(actor, name, await freeSlug()));
      } catch (err) {
        const won = await findPlatformAccount();   // made by another instance a moment ago
        if (won) return { account: won, created: false };
        throw err;
      }
      const made = await findPlatformAccount();
      if (!made) throw new Error("the platform account was made but is not found by its mark");
      admin.log(actor, "platform_account.create", made.slug, { name: made.name });
      auditPlatformAccount(actor, "create", made.id, made.slug);
      return { account: made, created: true };
    } finally { making = null; }
  })();
  return making;
}

/** The account's directory id, linking one when it has none (an account made while the directory was off). */
async function directoryId(actor: string, a: PlatformAccountRow): Promise<string> {
  if (a.clerk_org_id) return a.clerk_org_id;
  const { clerk_org_id } = await admin.linkClerk(actor, a.slug);
  a.clerk_org_id = clerk_org_id;
  return clerk_org_id;
}

export type JoinResult = "added" | "member" | "promoted" | "suspended";
/**
 * Make sure the person is in the platform account with at least `role`: added when they are not in it; with `promote`,
 * an owner's role raised when it is lower (the factory's sync). A suspended membership is left as it is.
 */
export async function joinPlatformAccount(actor: string, a: PlatformAccountRow, user: { id: string; email: string | null }, role: AccountRole,
  opts: { promote?: boolean } = {}): Promise<JoinResult> {
  const dir = people();
  const orgDir = await directoryId(actor, a);
  const mine = (await dir.memberships.forUser(user.id, true)).find((m) => m.organization?.id === orgDir);
  const c = clerkRoleFor(role);
  if (!mine) {
    try { await dir.memberships.add(orgDir, user.id, c.role, c.metadata); }
    catch (err) {
      // Added meanwhile (another request, another instance): what is there now counts.
      if (!(await dir.memberships.forUser(user.id, true)).some((m) => m.organization?.id === orgDir)) throw err;
      return "member";
    }
    admin.forgetPeople(orgDir);
    admin.log(actor, "platform_account.member_add", a.slug, { user: user.id, email: user.email, role });
    auditPlatformAccount(actor, `member-add/${role}`, a.id, a.slug);
    return "added";
  }
  if (clerk.isSuspended(mine)) return "suspended";
  if (opts.promote && role === "owner" && accountRoleOf(mine) !== "owner") {
    await dir.memberships.setRole(orgDir, user.id, c.role, c.metadata);
    admin.forgetPeople(orgDir);
    admin.log(actor, "platform_account.member_role", a.slug, { user: user.id, email: user.email, role });
    auditPlatformAccount(actor, `member-role/${role}`, a.id, a.slug);
    return "promoted";
  }
  return "member";
}

const inFlight = new Map<string, Promise<{ org: Org; clerkOrgId: string } | null>>();
/**
 * At sign-in (src/app.ts customerSession, for a person with no account open): a platform admin is put in the platform
 * account (made first when there is none) and their membership's account returned; anyone else, null. One run per
 * person at a time. Throws when the account cannot be made or joined (the portal says so, never "no account").
 */
export function platformAccessFor(userId: string): Promise<{ org: Org; clerkOrgId: string } | null> {
  const hit = inFlight.get(userId);
  if (hit) return hit;
  const p = (async () => {
    // The directory's cached copy (Clerk: at most a minute old): this runs on every portal call of someone with no account.
    const u = await people().users.get(userId);
    const { role } = roleOfUser(u);
    if (!role) return null;
    const email = clerk.primaryEmail(u).email;
    const actor = email ?? userId;
    const { account } = await ensurePlatformAccount(actor);
    const got = await joinPlatformAccount(actor, account, { id: userId, email }, accountRoleForStaff(role));
    if (got === "suspended") return null;
    const org = await orgForClerk(account.clerk_org_id!);
    return org ? { org, clerkOrgId: account.clerk_org_id! } : null;
  })().finally(() => inFlight.delete(userId));
  inFlight.set(userId, p);
  return p;
}

export interface SyncResult { account: { slug: string; name: string }; created: boolean; staff: number; added: number; promoted: number; suspended: number; not_signed_in: number }
/**
 * The factory's call after a deploy (POST /api/cron/platform-account): the account made when there is none, and every
 * person with a platform role in it (owners raised to owner). Counts only: no address leaves the server.
 */
export async function syncPlatformAccount(actor = "factory"): Promise<SyncResult> {
  const { account, created } = await ensurePlatformAccount(actor);
  const out: SyncResult = { account: { slug: account.slug, name: account.name }, created, staff: 0, added: 0, promoted: 0, suspended: 0, not_signed_in: 0 };
  const seen = new Set<string>();
  for (const u of await people().users.list()) {
    const { role } = roleOfUser(u);
    const { email } = clerk.primaryEmail(u);
    if (email) seen.add(email);
    if (!role) continue;
    out.staff++;
    const r = await joinPlatformAccount(actor, account, { id: u.id, email }, accountRoleForStaff(role), { promote: true });
    if (r === "added") out.added++; else if (r === "promoted") out.promoted++; else if (r === "suspended") out.suspended++;
  }
  // APP_PLATFORM_ADMINS addresses nobody has signed in with yet: they join at their first sign-in.
  out.not_signed_in = clerk.platformAdminEntries().filter((e) => !e.startsWith("*@") && !seen.has(e)).length;
  return out;
}

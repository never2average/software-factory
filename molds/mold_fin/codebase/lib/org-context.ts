/**
 * Org (workspace) context — the tenant layer above every ops surface.
 *
 * A single request-scoped resolver turns a JWKS-verified identity into
 * `{ orgId, role }`, and `orgDb` wraps a query set so a route can't forget the
 * org filter. Enforcement is STRUCTURAL, not per-route discipline (§3 of the
 * Org Onboarding plan).
 *
 * FAIL-SAFE / BACKWARD-COMPATIBLE: until the tenancy migration runs and a real
 * second org exists, every code path here resolves to the single implicit
 * org #1 (`onfinance`). If the `orgs`/`org_members` tables are absent or empty,
 * or a lookup errors, we fall back to `DEFAULT_ORG` — so prod behaves EXACTLY
 * as today and no one is ever locked out by this layer.
 *
 * `server-only`: this reads the DB and trusts request headers set by the proxy.
 */
import "server-only";

import { and, asc, eq, ne, sql } from "drizzle-orm";
import { getOpsDb, type Db } from "@/lib/ops-db";
import { customers, orgMembers, orgs } from "@/agent/lib/db/schema";
import { verifyOpsAuth } from "@/lib/ops-auth";

/** Org #1. The backfill target; the fail-safe when tenancy isn't live yet. */
export const DEFAULT_ORG = "org-onfinance";
/** Org #1's Google Workspace hosted domain. */
export const DEFAULT_DOMAIN = "onfinance.in";

export type OrgRole = "owner" | "admin" | "engineer" | "member";

export type OrgContext = {
  orgId: string;
  /** The caller's role in this org, or "member" when unknown/fail-safe. */
  role: OrgRole;
  /** True when we fell back to the default org (tenancy not resolvable yet). */
  fallback: boolean;
};

/**
 * May this context act on the workspace `id` named in a route path? True for the
 * caller's own org. The ONLY cross-id allowance is the genuine pre-tenancy /
 * onfinance fail-safe (fallback into org #1) — NEVER an isolated `personal:*`
 * workspace, which must not reach another org's admin surface. Use this instead
 * of the old `ctx.orgId !== id && !ctx.fallback` inline check, which admitted
 * every fallback identity (including isolates) to any org id.
 */
export function canAccessOrg(ctx: OrgContext, id: string): boolean {
  if (ctx.orgId === id) return true;
  return ctx.fallback && ctx.orgId === DEFAULT_ORG;
}

/**
 * The header the proxy stamps once it has resolved the org, so route handlers
 * (Node runtime) don't each re-verify. It is set on the REWRITTEN request and
 * therefore not attacker-controllable from outside (the proxy strips any
 * inbound copy first — see proxy.ts).
 */
export const ORG_HEADER = "x-ops-org";
export const ORG_ROLE_HEADER = "x-ops-org-role";

/**
 * Does the tenancy layer exist yet? Cheap probe of `to_regclass`; cached for the
 * process. Lets every resolver short-circuit to the fail-safe pre-migration
 * without erroring on a missing table.
 */
let tenancyLive: boolean | null = null;
export async function tenancyEnabled(db: Db | null = getOpsDb()): Promise<boolean> {
  if (tenancyLive !== null) return tenancyLive;
  if (!db) return false;
  try {
    const rows = await db.execute<{ reg: string | null }>(
      sql`SELECT to_regclass('public.orgs') AS reg`,
    );
    tenancyLive = Boolean(rows[0]?.reg);
  } catch {
    tenancyLive = false;
  }
  return tenancyLive;
}

/** True for an OnFinance identity (member domain or address). */
function isOnfinanceIdentity(email: string, hostedDomain?: string | null): boolean {
  return hostedDomain === DEFAULT_DOMAIN || email.toLowerCase().endsWith(`@${DEFAULT_DOMAIN}`);
}

/**
 * The isolated, empty workspace an unrecognized WORK email lands in until it's
 * onboarded. Keyed by hosted domain so one company's users share one (empty)
 * workspace. No existing row is stamped with this org, so RLS shows nothing —
 * the whole point: a stranger's Google Workspace account never sees OnFinance
 * data via the fail-safe.
 */
function isolatedOrgFor(email: string, hostedDomain?: string | null): string {
  return `personal:${(hostedDomain || email).toLowerCase()}`;
}

/**
 * Resolve the org for a verified identity. Order:
 *   1. If tenancy isn't live → DEFAULT_ORG (fail-safe; single-org world).
 *   2. Explicit membership row (email → org + role) wins — covers per-email
 *      invitees on any domain, and our own FDEs assisting a tenant.
 *   3. Else the Google hosted-domain (`hd`) → org lookup.
 *   4. Else: OnFinance identities → DEFAULT_ORG; any OTHER work email → its own
 *      isolated empty workspace (never DEFAULT_ORG, so we don't leak OnFinance
 *      data to outside Workspace accounts the auth gate now admits).
 *
 * `hostedDomain` is the token's `hd` claim (may be undefined for consumer
 * accounts); `preferOrg` lets a dual-org user pin a specific workspace.
 */
export async function resolveOrgForIdentity(
  email: string,
  hostedDomain?: string | null,
  preferOrg?: string | null,
): Promise<OrgContext> {
  const db = getOpsDb();
  if (!db || !(await tenancyEnabled(db))) {
    return { orgId: DEFAULT_ORG, role: "member", fallback: true };
  }
  try {
    // 2. Membership — the most specific signal. If the caller asked for a
    //    particular org and is a member, honour it; else first membership.
    const memberships = await db
      .select({ orgId: orgMembers.orgId, role: orgMembers.role })
      .from(orgMembers)
      .where(eq(orgMembers.email, email.toLowerCase()))
      // ORDERED, and it matters. This was an unordered query whose first row
      // became the default workspace, so someone in two workspaces could be
      // put in either one from request to request — the same person seeing a
      // different tenant's console on a refresh. Oldest membership first, tied
      // broken by id, so "my default workspace" is a fact rather than a race.
      .orderBy(
        // Most recently chosen in the switcher first — the same order the agent
        // uses, so the console and the agent never disagree about which
        // workspace you are in.
        sql`${orgMembers.lastSelectedAt} DESC NULLS LAST`,
        asc(orgMembers.createdAt),
        asc(orgMembers.orgId),
      );
    if (memberships.length > 0) {
      // An explicit ?org= / X-Ops-Org pick wins, but ONLY if they are actually
      // a member of it — this is the switcher's mechanism, not a bypass.
      const pick =
        (preferOrg && memberships.find((m) => m.orgId === preferOrg)) || memberships[0];
      return { orgId: pick.orgId, role: normalizeRole(pick.role), fallback: false };
    }
    // 3. Hosted-domain → org.
    if (hostedDomain) {
      const [byDomain] = await db
        .select({ orgId: orgs.orgId })
        .from(orgs)
        // EXCLUDE suspended rather than require "active": an allow-list means
        // any status nobody remembered to handle silently stops resolving a
        // workspace, which is how self-serve orgs became unreachable.
        .where(and(eq(orgs.googleHostedDomain, hostedDomain), ne(orgs.status, "suspended")))
        .limit(1);
      if (byDomain) return { orgId: byDomain.orgId, role: "member", fallback: false };
    }
  } catch {
    // fall through to fail-safe
  }
  // 4. No membership, no domain match. OnFinance identities keep DEFAULT_ORG
  //    (they'd normally resolve above; this is belt-and-suspenders). Every other
  //    admitted work email gets an isolated empty workspace — NOT OnFinance's.
  if (isOnfinanceIdentity(email, hostedDomain)) {
    return { orgId: DEFAULT_ORG, role: "member", fallback: true };
  }
  return { orgId: isolatedOrgFor(email, hostedDomain), role: "member", fallback: true };
}

/**
 * Node-side per-request org context: verify the caller (same JWKS check every
 * ops route runs) and resolve their org. Returns null when the caller has no
 * verified identity. This is the entry point a route handler calls:
 *
 *   const ctx = await orgContextForRequest(request);
 *   if (!ctx) return unauthorized();
 *   const { db, where, stamp } = orgDb(ctx);
 */
export async function orgContextForRequest(request: Request): Promise<OrgContext | null> {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!identity) return null;
  // A caller may pin a workspace with ?org= or an X-Ops-Org request header
  // (dual-org FDEs assisting a tenant); membership is still required.
  const url = safeUrl(request.url);
  const preferOrg =
    url?.searchParams.get("org") || request.headers.get(ORG_HEADER) || null;
  return resolveOrgForIdentity(identity.email, identity.hostedDomain, preferOrg);
}

function safeUrl(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

function normalizeRole(role: string | null | undefined): OrgRole {
  return role === "owner" || role === "admin" || role === "engineer" ? role : "member";
}

/** Is this role allowed to administer the workspace (settings, members)? */
export function isOrgAdmin(role: OrgRole): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Guard for CUSTOMER-scoped routes (deployments/implementations/tickets): does
 * this customer belong to the caller's workspace? Customer-scoped tables have no
 * org_id of their own — they inherit it through `customers.org_id`. Returns true
 * when the customer is in `orgId` (fail-safe: when tenancy isn't live, every
 * customer is in the default org, so a default-org caller always passes).
 */
export async function customerInOrg(orgId: string, customerId: string): Promise<boolean> {
  const db = getOpsDb();
  if (!db || !(await tenancyEnabled(db))) return orgId === DEFAULT_ORG;
  try {
    const [row] = await db
      .select({ orgId: customers.orgId })
      .from(customers)
      .where(eq(customers.customerId, customerId))
      .limit(1);
    // Unknown customer → let the route's own 404 handle it (don't false-deny).
    return row ? (row.orgId ?? DEFAULT_ORG) === orgId : true;
  } catch {
    return true;
  }
}

/**
 * The org that OWNS a customer (front-end twin of the agent's `orgForCustomer`).
 * The RIGHT key-derivation salt for that customer's per-workspace encrypted
 * secrets, so the front-end encrypts and the agent decrypts with the same key.
 * Fail-safe → DEFAULT_ORG.
 */
export async function orgForCustomerId(customerId: string): Promise<string> {
  const db = getOpsDb();
  if (!db || !(await tenancyEnabled(db))) return DEFAULT_ORG;
  try {
    const [row] = await db
      .select({ orgId: customers.orgId })
      .from(customers)
      .where(eq(customers.customerId, customerId))
      .limit(1);
    return row?.orgId ?? DEFAULT_ORG;
  } catch {
    return DEFAULT_ORG;
  }
}

/**
 * Read the org context a route handler was handed by the proxy. Falls back to
 * the default org if the header is missing (e.g. a route hit before the proxy
 * layer is org-aware, or health/self-guarded routes).
 */
export function orgContextFromHeaders(headers: Headers): OrgContext {
  const orgId = headers.get(ORG_HEADER) || DEFAULT_ORG;
  const role = normalizeRole(headers.get(ORG_ROLE_HEADER));
  return { orgId, role, fallback: !headers.get(ORG_HEADER) };
}

/**
 * The org-scoped DB accessor. Returns the raw Drizzle `db` plus a `where`
 * helper that AND-folds the caller's org into any predicate, and a `scope`
 * column for the current org — so a route writes `db.select().from(t)
 * .where(orgWhere(t.orgId, extra))` and physically cannot read another org's
 * rows. Pre-migration (org_id absent) callers simply pass the default org and
 * the predicate still matches the backfilled rows.
 */
export function orgDb(ctx: OrgContext) {
  const db = getOpsDb();
  return {
    db,
    orgId: ctx.orgId,
    role: ctx.role,
    /** `WHERE org_id = <ctx> [AND extra]` — the filter routes must not hand-write. */
    where(orgColumn: Parameters<typeof eq>[0], extra?: Parameters<typeof and>[0]) {
      const scope = eq(orgColumn, ctx.orgId);
      return extra ? and(scope, extra) : scope;
    },
    /** Value to STAMP on inserts so new rows carry the org. */
    stamp() {
      return { orgId: ctx.orgId };
    },
  };
}

/** Test seam: reset the cached tenancy probe (used by the cross-tenant test). */
export function __resetTenancyCache() {
  tenancyLive = null;
}

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
 * org #1 (`DEFAULT_ORG`). If the `orgs`/`org_members` tables are absent or empty,
 * or a lookup errors, we fall back to `DEFAULT_ORG` — so prod behaves EXACTLY
 * as today and no one is ever locked out by this layer.
 *
 * `server-only`: this reads the DB and trusts request headers set by the proxy.
 */
import "server-only";
import { resolvableByDomain } from "@/lib/workspace-rules";
import { WORKSPACE_REFUSED_CODE, WORKSPACE_REFUSED_MESSAGE, WORKSPACE_UNAVAILABLE_CODE } from "@/lib/workspace-refusal";

import { and, asc, eq, ne, sql } from "drizzle-orm";
import { getOpsDb, withOrgRls, type Db } from "@/lib/ops-db";
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
 * org #1 fail-safe (fallback into org #1) — NEVER an isolated `personal:*`
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
  return (await probeTenancy(db)) === true;
}

/**
 * The probe behind {@link tenancyEnabled}: true / false, or null when the database could not answer. A failed probe
 * is NOT cached: it used to be remembered as "no tenancy" for the life of the process, so one refused connection at
 * start-up resolved every later caller to the default workspace.
 */
async function probeTenancy(db: Db | null): Promise<boolean | null> {
  if (tenancyLive !== null) return tenancyLive;
  if (!db) return false;
  try {
    const rows = await db.execute<{ reg: string | null }>(
      sql`SELECT to_regclass('public.orgs') AS reg`,
    );
    tenancyLive = Boolean(rows[0]?.reg);
    return tenancyLive;
  } catch {
    return null;
  }
}

/** True for an org #1 identity (member domain or address). */
function isDefaultOrgIdentity(email: string, hostedDomain?: string | null): boolean {
  return hostedDomain === DEFAULT_DOMAIN || email.toLowerCase().endsWith(`@${DEFAULT_DOMAIN}`);
}

/**
 * The isolated, empty workspace an unrecognized WORK email lands in until it's
 * onboarded. Keyed by hosted domain so one company's users share one (empty)
 * workspace. No existing row is stamped with this org, so RLS shows nothing —
 * the whole point: a stranger's Google Workspace account never sees org #1's
 * data via the fail-safe.
 */
function isolatedOrgFor(email: string, hostedDomain?: string | null): string {
  return `personal:${(hostedDomain || email).toLowerCase()}`;
}

/**
 * A NAMED WORKSPACE IS NEVER SWAPPED FOR ANOTHER.
 *
 * A request may name the workspace it is about (`x-ops-org`, `?org=` — the console sends its tab's workspace on every
 * call). It used to be "a preference, not a grant": a name the caller was not a member of, or that did not exist, was
 * dropped and the request was served from the caller's FIRST membership instead. So a console set to workspace B (a
 * stale choice, a link, a platform admin's list of every workspace) showed workspace A's records, chats and files
 * under B's name, and a write made there landed in A.
 *
 * Now a name that cannot be honoured is REFUSED: {@link resolveOrgForIdentity} answers a {@link WorkspaceRefusal}
 * and {@link orgContextForRequest} hands the route the 403 to return. An unknown id and a workspace the caller is not
 * in read exactly the same (nothing says whether the id exists). With no name, the default-membership resolution
 * below is unchanged.
 */
export { WORKSPACE_REFUSED_CODE, WORKSPACE_REFUSED_MESSAGE, WORKSPACE_UNAVAILABLE_CODE };

export type WorkspaceRefusal = {
  readonly refused: true;
  /**
   * `not-a-member`: the caller is not in the workspace named, or there is no such workspace (never told apart).
   * `unavailable`: the lookup itself failed, so membership could be neither confirmed nor denied.
   */
  readonly reason: "not-a-member" | "unavailable";
};

export function isWorkspaceRefusal(value: unknown): value is WorkspaceRefusal {
  return Boolean(value) && typeof value === "object" && (value as { refused?: unknown }).refused === true;
}

/** The response a route returns for a {@link WorkspaceRefusal}. One body for unknown and not-a-member. */
export function workspaceRefusedResponse(refusal: WorkspaceRefusal): Response {
  if (refusal.reason === "unavailable") {
    return Response.json(
      { error: "Your workspace could not be checked right now. Try again in a moment.", code: WORKSPACE_UNAVAILABLE_CODE },
      { status: 503, headers: { "cache-control": "no-store", "retry-after": "5" } },
    );
  }
  return Response.json(
    { error: WORKSPACE_REFUSED_MESSAGE, code: WORKSPACE_REFUSED_CODE },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Resolve the org for a verified identity. Order:
 *   1. If tenancy isn't live → DEFAULT_ORG (fail-safe; single-org world).
 *   2. Explicit membership row (email → org + role) wins — covers per-email
 *      invitees on any domain, and our own operators assisting a tenant.
 *   3. Else the Google hosted-domain (`hd`) → org lookup.
 *   4. Else: org #1 identities → DEFAULT_ORG; any OTHER work email → its own
 *      isolated empty workspace (never DEFAULT_ORG, so we don't leak org #1's
 *      data to outside Workspace accounts the auth gate now admits).
 *
 * `hostedDomain` is the token's `hd` claim (may be undefined for consumer
 * accounts); `preferOrg` is the workspace the request NAMES. When it names one,
 * the answer is that workspace or a {@link WorkspaceRefusal} — never another.
 */
export async function resolveOrgForIdentity(
  email: string,
  hostedDomain?: string | null,
  preferOrg?: string | null,
): Promise<OrgContext | WorkspaceRefusal> {
  const named = preferOrg?.trim() || null;
  const { ctx, lookupFailed } = await resolveWorkspace(email, hostedDomain, named);
  // The one rule: what the steps above resolved is served only when it IS the workspace named.
  if (named && ctx.orgId !== named) {
    return { refused: true, reason: lookupFailed ? "unavailable" : "not-a-member" };
  }
  return ctx;
}

/** Steps 1-4 above. `named` only chooses AMONG the caller's memberships here; the caller checks the result. */
async function resolveWorkspace(
  email: string,
  hostedDomain: string | null | undefined,
  named: string | null,
): Promise<{ ctx: OrgContext; lookupFailed: boolean }> {
  const db = getOpsDb();
  const live = await probeTenancy(db);
  if (!db || !live) {
    return { ctx: { orgId: DEFAULT_ORG, role: "member", fallback: true }, lookupFailed: live === null };
  }
  let lookupFailed = false;
  try {
    // 2. Membership — the most specific signal. The workspace the request names
    //    when the caller is a member of it; with no name, the first membership.
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
      // A name that is not one of these is NOT answered with memberships[0] any more: the first membership is
      // returned here only so the caller's comparison refuses it (resolveOrgForIdentity).
      const pick = (named && memberships.find((m) => m.orgId === named)) || memberships[0];
      return { ctx: { orgId: pick.orgId, role: normalizeRole(pick.role), fallback: false }, lookupFailed };
    }
    // 3. Hosted-domain → org.
    if (hostedDomain) {
      const [byDomain] = await db
        .select({ orgId: orgs.orgId })
        .from(orgs)
        // EXCLUDE suspended rather than require "active": an allow-list means
        // any status nobody remembered to handle silently stops resolving a
        // workspace, which is how self-serve orgs became unreachable.
        .where(and(eq(orgs.googleHostedDomain, hostedDomain), resolvableByDomain(orgs.status)))
        .limit(1);
      if (byDomain) return { ctx: { orgId: byDomain.orgId, role: "member", fallback: false }, lookupFailed };
    }
  } catch {
    // fall through to fail-safe — and remember that membership was never read, so a NAMED workspace is answered
    // "could not check" (503) rather than "not a member".
    lookupFailed = true;
  }
  // 4. No membership, no domain match. Org #1 identities keep DEFAULT_ORG
  //    (they'd normally resolve above; this is belt-and-suspenders). Every other
  //    admitted work email gets an isolated empty workspace — NOT org #1's.
  if (isDefaultOrgIdentity(email, hostedDomain)) {
    return { ctx: { orgId: DEFAULT_ORG, role: "member", fallback: true }, lookupFailed };
  }
  return { ctx: { orgId: isolatedOrgFor(email, hostedDomain), role: "member", fallback: true }, lookupFailed };
}

/**
 * Node-side per-request org context: verify the caller (same JWKS check every
 * ops route runs) and resolve their org. Returns null when the caller has no
 * verified identity. This is the entry point a route handler calls:
 *
 *   const ctx = await orgContextForRequest(request);
 *   if (!ctx) return unauthorized();
 *   if (ctx instanceof Response) return ctx;
 *   const { db, where, stamp } = orgDb(ctx);
 */
/**
 * Every workspace `email` is a member of (`org_members`, the tenancy control plane — no RLS). Used by the session
 * gate (lib/session-gate.ts) to find a session's owner in one read and to decide a workspace-visible step. Throws on
 * a database error: the gate refuses (503) rather than reading a failure as "no memberships".
 */
export async function workspacesOf(email: string): Promise<string[]> {
  const db = getOpsDb();
  if (!db) throw new Error("Database not configured");
  const rows = await db
    .select({ orgId: orgMembers.orgId })
    .from(orgMembers)
    .where(eq(orgMembers.email, email.trim().toLowerCase()));
  return rows.map((r) => r.orgId);
}

/** The workspace a request names (`?org=` first, then the `x-ops-org` header), or null. */
export function namedWorkspaceOf(request: Request): string | null {
  const url = safeUrl(request.url);
  return (url?.searchParams.get("org") || request.headers.get(ORG_HEADER) || "").trim() || null;
}

/**
 * Three answers, and a route must handle each (the type makes it: a `Response` has no `orgId`):
 *
 *   const ctx = await orgContextForRequest(request);
 *   if (!ctx) return unauthorized();              // no verified identity
 *   if (ctx instanceof Response) return ctx;      // the request named a workspace it cannot be served from
 *
 * The `Response` is the refusal itself (403 `workspace_refused`, or 503 when membership could not be read): the
 * request names a workspace the caller is not a member of, or one that does not exist, and it is NOT served from the
 * caller's default workspace instead.
 */
export async function orgContextForRequest(request: Request): Promise<OrgContext | Response | null> {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!identity) return null;
  // A caller names a workspace with ?org= or an X-Ops-Org request header (the console's tab, a dual-org operator
  // assisting a tenant). Membership is required — and a name without it is refused, not replaced.
  const resolved = await resolveOrgForIdentity(identity.email, identity.hostedDomain, namedWorkspaceOf(request));
  return isWorkspaceRefusal(resolved) ? workspaceRefusedResponse(resolved) : resolved;
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
 * this customer belong to the caller's workspace? Customer-scoped tables inherit
 * their workspace through `customers.org_id`.
 *
 * Asked INSIDE the caller's scope, so row-level security is the answer: visible
 * means yours, invisible means not (unknown and another workspace's read the
 * same, which is the point — absent, not forbidden). It used to read on the bare
 * handle and answer `true` for a row it could not see ("unknown → let the route
 * 404"); under the fail-closed policy that handle sees NO row, so the guard
 * passed every id from every workspace. The routes stayed safe only because
 * their own reads and writes run in the caller's scope too.
 */
export async function customerInOrg(orgId: string, customerId: string): Promise<boolean> {
  const db = getOpsDb();
  if (!db || !(await tenancyEnabled(db))) return orgId === DEFAULT_ORG;
  try {
    const [row] = await withOrgRls(orgId, (tx) =>
      tx
        .select({ orgId: customers.orgId })
        .from(customers)
        .where(and(eq(customers.customerId, customerId), eq(customers.orgId, orgId)))
        .limit(1),
    );
    return Boolean(row);
  } catch {
    // Fail closed: a guard that cannot answer does not admit.
    return false;
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

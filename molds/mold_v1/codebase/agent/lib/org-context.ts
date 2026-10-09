/**
 * Agent-side org (workspace) resolution — the twin of the front-end's
 * `lib/org-context.ts`, using the agent's own `getDb()` (the Next bundler can't
 * import agent `#lib/` modules, and vice-versa, so the logic is duplicated).
 *
 * An agent tool learns WHICH workspace it is acting for from the session's
 * authenticated caller: `ctx.session.auth.current` (or `.initiator`) carries the
 * verified OIDC claims (`attributes.email`, `attributes.hd`). This resolver maps
 * that to an org, exactly as the front end does for HTTP requests.
 *
 * FAIL-SAFE: no DB / no tenancy tables / unresolved caller → org #1
 * (`DEFAULT_ORG`). With the multi-tenant flag off, every caller resolves to
 * `DEFAULT_ORG`, so tools behave exactly as before.
 *
 * tenancy-ok: this RESOLVES the workspace, so it cannot run inside one — that
 * would be circular. It reads only `orgs` and `org_members`, the tenancy
 * control plane, which carry no org_id and no RLS.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { resolvableByDomain } from "../../lib/workspace-rules.ts";
// The same words and code the web answers with.
import { WORKSPACE_REFUSED_CODE, WORKSPACE_REFUSED_MESSAGE } from "../../lib/workspace-refusal.ts";
import { getDb, type Db } from "./db/index.ts";
import { orgMembers, orgs } from "./db/schema.ts";
import { inheritedScope } from "./session-scope.ts";
import { isServicePrincipal, serviceScopeOf, type AuthLike } from "./service-scope.ts";

export const DEFAULT_ORG = "org-onfinance";
export const DEFAULT_DOMAIN = "onfinance.in";

/** True for an org #1 identity (member domain or address). */
function isDefaultOrgIdentity(email?: string, hd?: string): boolean {
  return hd === DEFAULT_DOMAIN || (email ?? "").toLowerCase().endsWith(`@${DEFAULT_DOMAIN}`);
}

/**
 * The isolated, empty workspace an unrecognized WORK email lands in until it's
 * onboarded. Twin of `lib/org-context.ts::isolatedOrgFor` — keeps the web auth
 * gate's newly-admitted outside Workspace accounts from ever touching org #1's
 * data through the agent (RLS shows nothing stamped with this org).
 */
function isolatedOrgFor(email?: string, hd?: string): string {
  return `personal:${(hd || email || "unknown").toLowerCase()}`;
}

/** The minimal shape we read off an eve tool/session context. */
export interface SessionAuthLike extends AuthLike {
  readonly attributes?: Readonly<Record<string, string | readonly string[]>>;
  readonly subject?: string;
  readonly principalId?: string;
}
export interface SessionCtxLike {
  readonly session?: {
    readonly id?: string;
    /** Present on a subagent's child session (eve): the lineage back to the root session. */
    readonly parent?: { readonly rootSessionId?: string; readonly sessionId?: string } | null;
    readonly auth?: {
      readonly current?: SessionAuthLike | null;
      readonly initiator?: SessionAuthLike | null;
    };
  };
}

let tenancyLive: boolean | null = null;
async function tenancyEnabled(db: Db): Promise<boolean> {
  if (tenancyLive !== null) return tenancyLive;
  try {
    const rows = await db.execute<{ reg: string | null }>(
      sql`SELECT to_regclass('public.orgs') AS reg`,
    );
    tenancyLive = Boolean((rows as unknown as { reg: string | null }[])[0]?.reg);
  } catch {
    // Not cached: a probe that FAILED is not "no tenancy". Remembered, one refused connection at start-up resolved
    // every later caller of this process to the default workspace (the web's probe had the same flaw).
    return false;
  }
  return tenancyLive;
}

function attr(a: SessionAuthLike | null | undefined, key: string): string | undefined {
  const v = a?.attributes?.[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

/** Pull the caller's email + hosted-domain (+ any declared workspace) off a session context. */
export function callerFromCtx(ctx: SessionCtxLike | undefined): {
  email?: string;
  hd?: string;
  org?: string;
} {
  const cur = ctx?.session?.auth?.current ?? ctx?.session?.auth?.initiator ?? null;
  const email = attr(cur, "email") ?? (cur?.subject?.includes("@") ? cur.subject : undefined);
  const hd = attr(cur, "hd");
  // A workspace named by the token itself — see mintSessionToken({ org }).
  // Verified against membership before it is honoured; never trusted as-is.
  const org = attr(cur, "org");
  return { email: email?.toLowerCase(), hd, org };
}

/**
 * Resolve the org for an email + hosted domain. Membership wins over the hd→org
 * lookup. An org #1 identity (or no tenancy / an error) fails safe to
 * DEFAULT_ORG; any OTHER work email with no membership and no domain match gets
 * its own isolated empty workspace — never org #1's data (the web auth gate
 * now admits all work emails).
 */
/**
 * Consumer mail domains — kept in lockstep with lib/ops-auth.ts.
 *
 * The eve channel cannot express "the token must carry SOME hosted domain": its
 * `claims` matcher only compares exact values, and listing every customer's
 * work domain there is not a thing anyone can maintain. So the agent enforces
 * the same work-account rule the Ops API does, one layer in — a personal
 * account that reaches the channel resolves to no workspace at all rather than
 * to an isolated one it can start filling.
 */
const CONSUMER_DOMAINS = new Set([
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

/**
 * True for a personal account: a consumer domain, or an email with no Workspace
 * hosted domain beside it.
 *
 * NOT true when there is no identity at all. Crons, workflow resume and every
 * other system-initiated turn run with an app principal and no email — treating
 * those as personal would refuse the platform's own traffic, which is a far
 * worse failure than the one being prevented.
 */
export function isConsumerIdentity(email?: string, hd?: string): boolean {
  if (!email && !hd) return false;
  const domain = (hd ?? email?.split("@")[1] ?? "").toLowerCase();
  if (CONSUMER_DOMAINS.has(domain)) return true;
  // An email with no `hd` beside it: Google did not consider it managed.
  return Boolean(email) && !hd;
}

export async function resolveOrg(email?: string, hd?: string): Promise<string> {
  const db = getDb();
  if (!db || !(await tenancyEnabled(db))) return DEFAULT_ORG;
  try {
    if (email) {
      // ORDERED, and it decides which tenant's data the agent reads. This was
      // an unordered query whose first row won, so a person in two workspaces
      // could have the console showing one and the agent answering from the
      // other — with no way to steer it. The switcher stamps `lastSelectedAt`,
      // so the agent follows the workspace on screen; never-chosen falls back
      // to the oldest membership, tie-broken by id, so it is a fact not a race.
      const memberships = await db
        .select({ orgId: orgMembers.orgId })
        .from(orgMembers)
        .where(eq(orgMembers.email, email.toLowerCase()))
        .orderBy(
          sql`${orgMembers.lastSelectedAt} DESC NULLS LAST`,
          asc(orgMembers.createdAt),
          asc(orgMembers.orgId),
        );
      if (memberships.length > 0) return memberships[0].orgId;
    }
    if (hd) {
      const [row] = await db
        .select({ orgId: orgs.orgId })
        .from(orgs)
        // The web app's rule, from one shared function (lib/workspace-rules.ts): any workspace not suspended.
        .where(and(eq(orgs.googleHostedDomain, hd), resolvableByDomain(orgs.status)))
        .limit(1);
      if (row) return row.orgId;
    }
  } catch {
    /* fall through */
  }
  // A personal account gets no workspace — not even an isolated one. Handing it
  // `personal:gmail.com` gave it somewhere to write, which is the opposite of
  // refusing it.
  if (isConsumerIdentity(email, hd)) {
    throw new Error("This platform admits work Google accounts only — personal accounts are not supported.");
  }
  return isDefaultOrgIdentity(email, hd) ? DEFAULT_ORG : isolatedOrgFor(email, hd);
}

/** The org for the current tool/session context (fail-safe → DEFAULT_ORG). */
/**
 * The workspace's DISPLAY NAME, for the agent to call itself by.
 *
 * Falls back to the id, then to a neutral word — never to a company name. A
 * wrong-but-confident org #1 name in front of another customer is worse than a
 * generic "your workspace".
 */
export async function orgDisplayName(orgId: string): Promise<string> {
  const db = getDb();
  if (!db) return "your workspace";
  try {
    const [row] = await db
      .select({ name: orgs.name })
      .from(orgs)
      .where(eq(orgs.orgId, orgId))
      .limit(1);
    return row?.name?.trim() || orgId || "your workspace";
  } catch {
    return "your workspace";
  }
}

/** Does this workspace exist? `orgs` is the control plane and carries no RLS. Fails closed. */
async function workspaceExists(orgId: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    const [row] = await db.select({ orgId: orgs.orgId }).from(orgs).where(eq(orgs.orgId, orgId)).limit(1);
    return Boolean(row);
  } catch {
    return false;
  }
}

/** The session names a workspace its person is not a member of, or one that does not exist. Never told apart. */
export class WorkspaceRefusedError extends Error {
  readonly code = WORKSPACE_REFUSED_CODE;
  constructor() {
    super(WORKSPACE_REFUSED_MESSAGE);
    this.name = "WorkspaceRefusedError";
  }
}

export async function orgForSession(ctx: SessionCtxLike | undefined): Promise<string> {
  const { email, hd, org } = callerFromCtx(ctx);
  /**
   * A subagent's child session has NO identity (eve runs internal paths with auth null), so everything below
   * would resolve from nothing and land on the default workspace — whose RLS scope then refuses the write for
   * anyone who is not in it. A child inherits the workspace its ROOT session recorded instead. Only when there
   * is no identity at all: a session that has one is never overridden by lineage.
   */
  if (!email && !org && ctx?.session?.parent) {
    const inherited = await inheritedScope(ctx.session.parent);
    if (inherited) return inherited.orgId;
  }
  /**
   * A SERVICE session (a schedule rule, a front-end workflow/app/cron step) has no person to resolve from, so it
   * names the workspace it acts for — see service-scope.ts for who may, and why nobody else can. Honoured only
   * when the workspace exists; anything else falls through to the isolated, empty workspace, as before.
   */
  if (!email) {
    const principal = ctx?.session?.auth?.current ?? ctx?.session?.auth?.initiator ?? null;
    const named = serviceScopeOf(principal);
    if (named && (await workspaceExists(named))) return named;
    /**
     * A CONTINUATION by the same trusted service (an approval answered with only `inputResponses`) does not pass
     * through eve.ts `onMessage`, so it arrives without the attribute. It is still that session: use the workspace
     * the session RECORDED when it started (runtime-context → recordSessionScope). Only for a trusted service
     * principal, and only its own session's row — the id is eve's, never the model's or the request's.
     */
    if (!named && isServicePrincipal(principal) && ctx?.session?.id) {
      const recorded = await inheritedScope({ sessionId: ctx.session.id });
      if (recorded) return recorded.orgId;
    }
  }
  /**
   * A PERSON'S NAMED WORKSPACE IS THAT WORKSPACE, OR A REFUSAL — NEVER ANOTHER.
   *
   * The session's auth names a workspace two ways: the token's own `org` claim (a workflow step's, a queue
   * delivery's — mintSessionToken({ org })) or the console tab's `x-ops-org` (service-scope.ts
   * sessionAuthForRequest). Checking membership is what keeps it a scoping hint rather than an authorisation: a
   * token cannot name a workspace its holder is not in.
   *
   * It used to be "a preference": a name the person was not a member of (or that did not exist) fell through to
   * identity resolution and the session ran in their FIRST membership — a chat started from a console set to
   * workspace B read and wrote workspace A. Now the answer is the workspace named, when membership (or the
   * hosted-domain rule) puts the person in it, and otherwise {@link WorkspaceRefusedError}: unknown and not-a-member
   * read the same, and a lookup that failed is a refusal too (it cannot confirm). The web resolves the same way
   * (lib/org-context.ts resolveOrgForIdentity).
   */
  if (org && email) {
    const db = getDb();
    if (db && (await tenancyEnabled(db))) {
      try {
        const [member] = await db
          .select({ orgId: orgMembers.orgId })
          .from(orgMembers)
          .where(and(eq(orgMembers.email, email.toLowerCase()), eq(orgMembers.orgId, org)))
          .limit(1);
        if (member) return member.orgId;
      } catch {
        /* could not confirm: identity resolution below must land on the same workspace, or it is refused */
      }
    }
    const resolved = await resolveOrg(email, hd);
    if (resolved !== org) throw new WorkspaceRefusedError();
    return resolved;
  }
  return resolveOrg(email, hd);
}

/*
 * orgForCustomer ("the org that OWNS a customer account") is gone: a company is keyed by (org_id, customer_id), and
 * two workspaces may hold the same id (mold_v1-118), so no workspace can be read off an id. Every caller names its
 * own (orgForSession, a sync's orgId, a script's --org). scripts/check-tenancy.mjs still refuses the name.
 */

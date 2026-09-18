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
 * (`onfinance`). With the multi-tenant flag off, every caller resolves to
 * `onfinance`, so tools behave exactly as before.
 *
 * tenancy-ok: this RESOLVES the workspace, so it cannot run inside one — that
 * would be circular. It reads only `orgs` and `org_members`, the tenancy
 * control plane, which carry no org_id and no RLS.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, type Db } from "./db/index.ts";
import { customers, orgMembers, orgs } from "./db/schema.ts";

export const DEFAULT_ORG = "org-onfinance";
export const DEFAULT_DOMAIN = "onfinance.in";

/** True for an OnFinance identity (member domain or address). */
function isOnfinanceIdentity(email?: string, hd?: string): boolean {
  return hd === DEFAULT_DOMAIN || (email ?? "").toLowerCase().endsWith(`@${DEFAULT_DOMAIN}`);
}

/**
 * The isolated, empty workspace an unrecognized WORK email lands in until it's
 * onboarded. Twin of `lib/org-context.ts::isolatedOrgFor` — keeps the web auth
 * gate's newly-admitted outside Workspace accounts from ever touching OnFinance
 * data through the agent (RLS shows nothing stamped with this org).
 */
function isolatedOrgFor(email?: string, hd?: string): string {
  return `personal:${(hd || email || "unknown").toLowerCase()}`;
}

/** The minimal shape we read off an eve tool/session context. */
export interface SessionAuthLike {
  readonly attributes?: Readonly<Record<string, string | readonly string[]>>;
  readonly subject?: string;
  readonly principalId?: string;
}
export interface SessionCtxLike {
  readonly session?: {
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
    tenancyLive = false;
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
 * lookup. An OnFinance identity (or no tenancy / an error) fails safe to
 * DEFAULT_ORG; any OTHER work email with no membership and no domain match gets
 * its own isolated empty workspace — never OnFinance's data (the web auth gate
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
        .where(and(eq(orgs.googleHostedDomain, hd), eq(orgs.status, "active")))
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
  return isOnfinanceIdentity(email, hd) ? DEFAULT_ORG : isolatedOrgFor(email, hd);
}

/** The org for the current tool/session context (fail-safe → DEFAULT_ORG). */
/**
 * The workspace's DISPLAY NAME, for the agent to call itself by.
 *
 * Falls back to the id, then to a neutral word — never to a company name. A
 * wrong-but-confident "OnFinance" in front of another customer is worse than a
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

export async function orgForSession(ctx: SessionCtxLike | undefined): Promise<string> {
  const { email, hd, org } = callerFromCtx(ctx);
  /**
   * A token that NAMES its workspace wins — once membership is confirmed.
   *
   * This is how a workflow step says which workspace it is running for. Without
   * it the step re-resolved from the operator's identity, so a run started in
   * one workspace could read and write another the moment its operator belonged
   * to two. Checking membership is what keeps it a scoping hint rather than an
   * authorisation: a token cannot name a workspace its holder is not in.
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
        /* fall through to identity resolution */
      }
    }
  }
  return resolveOrg(email, hd);
}

/**
 * The org that OWNS a customer account — the right workspace for that customer's
 * data-room artifacts (Customers/{id}/…, Tickets/…). A customer belongs to
 * exactly one org via `customers.org_id`. Fail-safe → DEFAULT_ORG.
 */
export async function orgForCustomer(customerId: string): Promise<string> {
  const db = getDb();
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

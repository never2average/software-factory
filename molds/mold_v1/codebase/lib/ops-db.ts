/**
 * Lazily-initialized postgres.js + Drizzle client for the NEXT runtime.
 *
 * The agent-side client (`agent/lib/db/index.ts`) uses `.ts`-extension
 * imports that the Next bundler cannot resolve, so the ops API routes use
 * this self-contained twin instead. Same contract: `getOpsDb()` returns the
 * Drizzle instance when DATABASE_URL (or POSTGRES_URL) is set, else null.
 * Never throws and never opens a connection at import time — postgres.js
 * defers TCP until the first query.
 */
import "server-only";

import { sql, ne } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/agent/lib/db/schema";
import { installQueryErrorRedaction } from "@/agent/lib/db/query-errors";
import { orgs } from "@/agent/lib/db/schema";

export type Db = PostgresJsDatabase<typeof schema>;

let cached: { url: string; client: postgres.Sql; db: Db } | null = null;

/**
 * Returns the Drizzle instance when a Postgres URL is configured, else null.
 */
export function getOpsDb(): Db | null {
  /**
   * DATABASE_URL is the ONLY source. There is deliberately no POSTGRES_URL
   * fallback: provider integrations inject POSTGRES_URL themselves, so a
   * decommissioned provider's variable lingers and silently becomes the app's
   * database the moment DATABASE_URL is absent — serving stale data, or (as
   * happened with Neon) a database that has stopped answering, while every
   * health check reports a healthy connection to the wrong place.
   */
  const url = process.env.DATABASE_URL || null;
  if (!url) return null;
  if (!cached || cached.url !== url) {
    // `max: 5` keeps the pool small for serverless; `prepare: false` keeps
    // the client compatible with transaction-mode poolers (pgBouncer et al).
    const client = postgres(url, { max: 5, prepare: false });
    // A failed query's error never carries its values (agent/lib/db/query-errors.ts).
    installQueryErrorRedaction();
    cached = { url, client, db: drizzle(client, { schema }) };
  }
  return cached.db;
}

/**
 * Run `fn` inside a transaction with the Postgres GUC `app.org_id` set LOCAL to
 * `orgId`, so ROW-LEVEL SECURITY policies (see `.migrate-org-rls.mjs`) enforce
 * workspace isolation at the DATABASE level — a structural backstop under the
 * application-level `WHERE org_id = …` filters, catching any query that forgets
 * one. `SET LOCAL` is transaction-scoped, so it never leaks onto a pooled
 * connection reused by the next request.
 *
 * The RLS policies are PERMISSIVE when the GUC is unset, so the many non-request
 * DB paths (agent tools, crons, the dispatcher) that don't wrap in `withOrgRls`
 * keep working unchanged; enforcement kicks in precisely for the wrapped
 * (HTTP request) paths where the org is known.
 */
export async function withOrgRls<T>(
  /**
   * The workspace, or `{ orgId, principal }` when the caller is a known person.
   *
   * The principal is what makes ACCOUNT-LEVEL connectors possible: their policy
   * compares owner_email against `app.principal_email`, so a caller who does
   * not set it sees only organization-level rows. That is the safe default and
   * it falls out of the shape — a cron or workflow has no person, and so can
   * never act with someone's personal credentials.
   *
   * Overloaded rather than a second parameter so the 69 existing call sites
   * stay untouched; only the paths that care about ownership pass an object.
   */
  scope: string | { orgId: string; principal?: string | null },
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const orgId = typeof scope === "string" ? scope : scope.orgId;
  const principal = typeof scope === "string" ? null : (scope.principal ?? null);
  const db = getOpsDb();
  if (!db) throw new Error("Database not configured");
  return db.transaction(async (tx) => {
    // set_config(..., true) = LOCAL to this transaction.
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    if (principal) {
      await tx.execute(sql`select set_config('app.principal_email', ${principal.toLowerCase()}, true)`);
    }
    return fn(tx as unknown as Db);
  });
}

/**
 * Every workspace, suspended ones included.
 *
 * `orgs` is the tenancy control plane — no org_id, no policy — and nothing can
 * enumerate it from inside a workspace's scope. The same read {@link
 * acrossOrgsRls} makes, exported so a caller that needs the LIST but not the
 * loop does not have to reach for a bare handle of its own and become the next
 * thing `check:tenancy` has to reason about.
 *
 * The ownership gate in front of eve's session routes is that caller: before it
 * may treat a session as one nobody has ever recorded — which is the branch
 * that lets a brand-new chat work during the debounce window — it has to have
 * looked everywhere, and "everywhere" is a question only this table answers.
 *
 * Suspended workspaces are INCLUDED, unlike the sweep below. A sweep is work to
 * be done and a suspended workspace has none; but a session recorded in one
 * still belongs to somebody, and skipping it would make suspending a workspace
 * a way to make its conversations readable by strangers.
 */
export async function listWorkspaceIds(): Promise<string[]> {
  const db = getOpsDb();
  if (!db) return [];
  const rows = await db.select({ orgId: orgs.orgId }).from(orgs);
  return rows.map((r) => r.orgId);
}

/**
 * Run a query once per workspace, in each workspace's RLS scope, and
 * concatenate.
 *
 * For the recovery sweepers, which are cross-workspace BY DESIGN: "find every
 * stalled run" is not a question any single workspace can answer. Today an
 * unscoped scan works because the policy fails open; the moment it fails
 * closed that same scan returns nothing and the sweeper silently stops
 * recovering runs — the worst kind of failure, because an empty result and
 * "nothing to do" are indistinguishable.
 *
 * The alternative was a BYPASSRLS role for sweeps, which reintroduces exactly
 * the hole this work removed. Looping costs one query per workspace; there are
 * two.
 *
 * `orgs` is the tenancy control plane and carries no RLS, so enumerating it
 * needs no scope of its own.
 */
export async function acrossOrgsRls<T>(fn: (db: Db, orgId: string) => Promise<T[]>): Promise<T[]> {
  const db = getOpsDb();
  if (!db) return [];
  const workspaces = await db
    .select({ orgId: orgs.orgId })
    .from(orgs)
    .where(ne(orgs.status, "suspended"));
  const out: T[] = [];
  for (const w of workspaces) {
    // One workspace failing must not stop the sweep for the rest.
    try {
      out.push(...(await withOrgRls(w.orgId, (tx) => fn(tx, w.orgId))));
    } catch (error) {
      console.error(`[ops-db] sweep failed for ${w.orgId}:`, error);
    }
  }
  return out;
}

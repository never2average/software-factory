/**
 * Lazily-initialized Postgres client + Drizzle instance.
 *
 * The system of record uses Postgres ONLY when DATABASE_URL (or POSTGRES_URL)
 * is set. Without a URL, `getDb()` returns null and callers fall back to the
 * bundled seed JSON (`data/customers.json` / `data/people.json`) — see
 * `agent/lib/system-of-record.ts`. Nothing connects at import time: the
 * postgres.js client is only constructed on the first `getDb()` call that
 * finds a URL, and postgres.js itself defers TCP connections until the first
 * query.
 */
import { sql } from "drizzle-orm";
import { orgs } from "./schema.ts";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export * as dbSchema from "./schema.ts";

export type Db = PostgresJsDatabase<typeof schema>;

let cached: { url: string; client: postgres.Sql; db: Db } | null = null;

/** The connection URL the system of record would use, if any. */
export function getDatabaseUrl(): string | null {
  /**
   * DATABASE_URL is the ONLY source. There is deliberately no POSTGRES_URL
   * fallback: provider integrations inject POSTGRES_URL themselves, so a
   * decommissioned provider's variable lingers and silently becomes the app's
   * database the moment DATABASE_URL is absent — serving stale data, or (as
   * happened with Neon) a database that has stopped answering, while every
   * health check reports a healthy connection to the wrong place.
   */
  return process.env.DATABASE_URL || null;
}

/**
 * Returns the Drizzle instance when a Postgres URL is configured, else null.
 * Never throws and never opens a connection when no URL is set.
 */
export function getDb(): Db | null {
  const url = getDatabaseUrl();
  if (!url) return null;
  if (!cached || cached.url !== url) {
    // `max: 10` keeps the pool small for serverless; `prepare: false` keeps
    // the client compatible with transaction-mode poolers (pgBouncer/Supavisor).
    const client = postgres(url, { max: 10, prepare: false });
    cached = { url, client, db: drizzle(client, { schema }) };
  }
  return cached.db;
}

/**
 * Run `fn` in a transaction with the Postgres GUC `app.org_id` set LOCAL to
 * `orgId` — the agent-side twin of `withOrgRls` in lib/ops-db.ts.
 *
 * Required, not optional, for `connector_secrets`: that table's RLS policy is
 * STRICT (see .migrate-secrets-hardening.mjs), so a query outside this wrapper
 * sees zero rows rather than the wrong ones. That is the intended failure mode
 * — a credential read that forgets its workspace should come back empty, not
 * come back with somebody else's token.
 *
 * `SET LOCAL` is transaction-scoped, so the setting can never leak onto a
 * pooled connection picked up by the next request.
 */
export async function withOrgDb<T>(
  /** The workspace, or `{ orgId, principal }` — see withOrgRls in lib/ops-db.ts. */
  scope: string | { orgId: string; principal?: string | null },
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const orgId = typeof scope === "string" ? scope : scope.orgId;
  const principal = typeof scope === "string" ? null : (scope.principal ?? null);
  const db = getDb();
  if (!db) throw new Error("No database configured.");
  if (!orgId) throw new Error("withOrgDb requires a workspace id.");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    if (principal) {
      await tx.execute(sql`select set_config('app.principal_email', ${principal.toLowerCase()}, true)`);
    }
    return fn(tx as unknown as Db);
  });
}

/**
 * Close the pooled postgres.js client, if one was ever opened. For one-shot
 * scripts (e.g. `scripts/seed-postgres.ts`) that would otherwise hang on the
 * open pool; the long-lived agent runtime never needs to call this.
 */
export async function closeDb(): Promise<void> {
  if (!cached) return;
  const { client } = cached;
  cached = null;
  await client.end({ timeout: 5 });
}

/**
 * Run a query once per workspace, in each workspace's scope, and concatenate.
 *
 * The agent-side twin of `acrossOrgsRls` in lib/ops-db.ts, for the handful of
 * lookups that are cross-workspace by construction — resolving a workflow by
 * NAME, for instance, when the caller has only the name. An unscoped read
 * works today because the policy fails open; once it fails closed it returns
 * nothing, and the lookup silently stops finding anything.
 *
 * `orgs` is the tenancy control plane and carries no RLS, so enumerating it
 * needs no scope of its own.
 */
export async function acrossOrgDbs<T>(fn: (db: Db, orgId: string) => Promise<T[]>): Promise<T[]> {
  const db = getDb();
  if (!db) return [];
  const workspaces = await db.select({ orgId: orgs.orgId }).from(orgs);
  const out: T[] = [];
  for (const w of workspaces) {
    try {
      out.push(...(await withOrgDb(w.orgId, (tx) => fn(tx, w.orgId))));
    } catch (error) {
      console.error(`[agent-db] sweep failed for ${w.orgId}:`, error);
    }
  }
  return out;
}

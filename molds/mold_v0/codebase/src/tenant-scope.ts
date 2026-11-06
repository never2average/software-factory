/**
 * Tenant scope for database row-level security (sql/migrations/0003_row_level_security.sql, docs/security.md).
 *
 * Work done for one organization (every MCP tool call, every customer-portal request) runs inside withTenant(orgId):
 * src/db.ts then runs each of its queries in a short transaction as the tenant role (app_tenant_<hash>, see tenantRole below) with the setting
 * app.org_id, so Postgres itself refuses to show or change another organization's rows, whatever the query's
 * own WHERE clause says. Everything else (the orchestrator worker API, the admin console, background jobs,
 * migrations) runs as the app's own role, which the policies do not restrict: those paths are cross-tenant by design.
 * asPlatform(fn) leaves the scope explicitly, for cross-tenant work a tenant request starts.
 */
import { AsyncLocalStorage } from "node:async_hooks";


const scope = new AsyncLocalStorage<{ orgId: number } | null>();

/**
 * Set at boot from the catalog check (src/rls.ts): while row-level security is not in place, tenant-scoped queries are
 * refused (customers get an error, never another organization's rows); platform work carries on.
 */
let gateProblems: string[] = [];
export const setTenantGate = (problems: string[]) => { gateProblems = problems; };

/** The organization the current work is scoped to, or null (platform work). Throws while the gate is closed. */
export const currentTenant = (): number | null => {
  const t = scope.getStore()?.orgId ?? null;
  if (t !== null && gateProblems.length) throw new Error(`row-level security is not in place, so tenant queries are refused: ${gateProblems[0]}`);
  return t;
};

const checked = (orgId: number) => {
  if (!Number.isSafeInteger(orgId) || orgId <= 0) throw new Error(`tenant scope needs an organization id, got ${String(orgId)}`);
  return orgId;
};

/** Run fn, and everything it starts, with the database limited to one organization's rows. */
export function withTenant<T>(orgId: number, fn: () => T): T {
  return scope.run({ orgId: checked(orgId) }, fn);
}

/** Run fn outside any tenant scope: work that is cross-tenant by design, started from a tenant request. */
export function asPlatform<T>(fn: () => T): T {
  return scope.run(null, fn);
}

/**
 * Who reads (mold_v0-259, the teams flag; sql/migrations/0050_teams_and_visibility.sql): the person whose per-record
 * visibility applies to the workspace's records, or none. Set by the doors (src/visibility.ts withViewerOf) for a person
 * who is not one of the workspace's owners; nothing else sets it. Inside a tenant scope every query's transaction carries
 * it as app.viewer, which the database's record_visibility policy reads: a record private to someone else, or shared with
 * a team the person is not in, is not there for that query (no row to read, count, export, change or delete). "*" (no
 * viewer in scope: the shell's own work, an owner, an account key) sees every record of the workspace, as before.
 */
const viewer = new AsyncLocalStorage<string | null>();
/** A viewer id: a person's sign-in id or a door's own mark (~api); never a quote, a backslash or a space. */
const VIEWER = /^[A-Za-z0-9~][A-Za-z0-9_.:@|~+-]{0,199}$/;
/** The viewer in scope, or null (sees every record). */
export const currentViewer = (): string | null => viewer.getStore() ?? null;
/** Run fn, and everything it starts, reading the workspace's records as `id` (null: every record, e.g. an owner). */
export function withViewer<T>(id: string | null, fn: () => T): T {
  if (id !== null && !VIEWER.test(id)) throw new Error("a viewer is a person's id (letters, digits and . _ : @ | ~ + -)");
  return viewer.run(id, fn);
}

/**
 * The tenant role of this database: app_tenant_<10 hex of md5(database name)> (roles are server-wide, so one per
 * database). Read at boot from app_tenant_role() (sql/migrations/0003_row_level_security.sql, named since
 * 0024_neutral_database_names; src/db.ts).
 */
let role = "";
export const tenantRole = () => role;
export const setTenantRole = (name: string) => {
  if (!/^app_tenant_[0-9a-f]{10}$/.test(name)) throw new Error(`unexpected tenant role name ${JSON.stringify(name)}`);
  role = name;
};

/**
 * The statements that open a tenant transaction: the role, then the organization and the viewer (transaction-local, so a
 * pooled connection never keeps any of them). The id is a checked integer and the role a checked name, never caller text.
 */
export const tenantPrelude = (orgId: number) => {
  if (!role) throw new Error("tenant role unknown: row-level security is not in place (migration 0003_row_level_security)");
  // mold_v0-259: the viewer, "*" when none is in scope (every record). A tenant transaction opened any other way has no
  // app.viewer at all, and the policy then shows it only the records open to the whole workspace.
  const v = viewer.getStore() ?? "*";
  if (v !== "*" && !VIEWER.test(v)) throw new Error("unexpected viewer");
  return `SET LOCAL ROLE ${role}; SELECT set_config('app.org_id', '${checked(orgId)}', true), set_config('app.viewer', '${v}', true)`;
};

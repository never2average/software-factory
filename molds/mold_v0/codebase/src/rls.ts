/**
 * Proof that row-level security (sql/migrations/0003_row_level_security.sql, src/tenant-scope.ts) is in force on a
 * database: `npm run check:rls` on every deploy (deploy/rolling-deploy.sh), the catalog check at every process start,
 * and the live probe from the Vercel cron (src/http.ts), which has no release step to hook.
 *
 *   rlsCatalogProblems  every table with an org_id column, and every table reached through a tenant parent, has RLS
 *                       on and a policy for the tenant role; any other table the role can reach is a known read-only
 *                       platform table; the role exists, cannot bypass RLS, and the app may SET it
 *   rlsProbe            live, inside a transaction that is always rolled back: two organizations with rows; as A the
 *                       tenant role sees none of B's rows in any tenant table (and, for tables reached through a
 *                       parent, exactly the rows whose parent is A's), cannot change or create B's, cannot reach
 *                       platform secrets, and with no organization set sees no tenant rows at all
 *
 * A failing catalog check does not stop the process (the worker API and admin stay up): tenant-scoped queries are
 * refused instead (src/db.ts), so customers get errors, never another organization's rows.
 *
 * The product's tables (products, scenarios, sessions, personas, populations, ...) are its host pack's since mold_v0-049,
 * created by its migrations: each check about one of them runs when the database has it, so a shell with no packs is
 * checked on its own tables, a build with the host pack (or a database built before the move) on those too.
 */
import { randomBytes } from "node:crypto";
import type { Db, Queryable } from "./db.js";
import { setTenantGate, setTenantRole, tenantRole } from "./tenant-scope.js";

/** Read this database's tenant role name (octillion_tenant_role(), migration 0003) into src/tenant-scope.ts. */
export async function loadTenantRole(db: Queryable): Promise<string | null> {
  const [fn] = await db.query<{ ok: boolean }>("SELECT to_regprocedure('octillion_tenant_role()') IS NOT NULL AS ok");
  if (!fn?.ok) return null;
  const [{ r }] = await db.query<{ r: string }>("SELECT octillion_tenant_role() AS r");
  setTenantRole(r);
  return r;
}
/** The tables this database has (the product's are a host pack's: present with it, or left from before mold_v0-049). */
export async function presentTables(db: Queryable): Promise<Set<string>> {
  return new Set((await db.query<{ t: string }>("SELECT relname AS t FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')")).map((r) => r.t));
}
/**
 * Tenant tables without their own org_id: scoped through a parent row, each the SQL that counts the rows whose parent
 * is $1's. The gateway's tables are the shell's; a session's rows count only where the sessions table is.
 */
export function parentScoped(has: Set<string>): Record<string, string> {
  const sessions = has.has("agent_sessions");
  return {
    ...(has.has("scenarios") ? { scenarios: "SELECT count(*)::int AS n FROM scenarios c JOIN products p ON p.id = c.product_id WHERE p.org_id = $1" } : {}),
    ...(has.has("product_personas") ? { product_personas: "SELECT count(*)::int AS n FROM product_personas c JOIN products p ON p.id = c.product_id WHERE p.org_id = $1" } : {}),
    ...(has.has("transcript_events") ? { transcript_events: "SELECT count(*)::int AS n FROM transcript_events c JOIN agent_sessions s ON s.id = c.session_id WHERE s.org_id = $1" } : {}),
    // A session's usage, and since mold_v0-053 a run's (sql/migrations/0009_usage_and_limits.sql): the workspace's own.
    gateway_usage: `SELECT count(*)::int AS n FROM gateway_usage c WHERE ${sessions ? "EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = c.session_id AND s.org_id = $1) OR " : ""}EXISTS (SELECT 1 FROM runs x WHERE x.id = c.run_id AND x.org_id = $1)`,
    gateway_tokens: sessions ? "SELECT count(*)::int AS n FROM gateway_tokens c JOIN agent_sessions s ON s.id = c.session_id WHERE s.org_id = $1" : "SELECT 0 AS n WHERE $1::int IS NOT NULL",
    ...(has.has("developer_population_agents") ? { developer_population_agents: "SELECT count(*)::int AS n FROM developer_population_agents c JOIN developer_populations p ON p.id = c.population_id WHERE p.org_id IS NULL OR p.org_id = $1" } : {}),
  };
}
/** Tables whose rows with no organization are the platform's shared ones, readable by every tenant (the host pack's libraries). */
export const SHARED_TABLES = ["developer_profiles", "developer_populations", "journey_templates"];
/** Platform tables tenant work may read, never write, and that hold nothing of any one organization. */
export const PLATFORM_READONLY = ["library_tasks", "platform_settings", "platform_harnesses", "model_prices", "schema_migrations", "journey_seed",
  // Record areas at platform scope (mold_v0-047, 0004_record_areas): shared by every workspace, read-only to customers.
  "platform_records"];
/** Tables a tenant query must never reach (checked live by the probe). */
export const NO_ACCESS = ["vault_credentials", "vault_providers", "admin_access_log", "admin_tokens", "access_requests", "orchestrators", "email_log",
  // The workspace credential vault (mold_v0-034): not even a workspace's own sealed values reach tenant work.
  "workspace_credentials",
  // Rate-limit counters (mold_v0-018): platform rows.
  "rate_limit_hits",
  // The scheduler's own bookkeeping (mold_v0-035): the day the due-date check last ran.
  "scheduler_marks",
  // The sandboxes launched for runs (mold_v0-055): platform bookkeeping.
  "run_sandboxes",
  // Built-in sign-in (mold_v0-004, 0015_builtin_sign_in): people, sessions, codes and Google sign-ins in flight are the
  // platform's; memberships and invitations carry org_id and are closed to tenant work as well.
  "auth_users", "auth_sessions", "auth_codes", "auth_oauth_states", "auth_memberships", "auth_invitations",
  // The built-in MCP authorization server (mold_v0-013, 0018_mcp_oauth): clients, requests, grants, codes and tokens.
  "oauth_clients", "oauth_requests", "oauth_grants", "oauth_codes", "oauth_tokens",
  // Approvals of previews (mold_v0-079) and a company's egress hosts (mold_v0-075): the shell's code only.
  "run_approvals", "workspace_egress_hosts",
  // A workspace's GitHub App installation, installs in flight and the tokens minted for runs (mold_v0-014).
  "workspace_github_installations", "github_app_states", "run_github_app_tokens"];

export async function tenantTables(db: Queryable): Promise<string[]> {
  const rows = await db.query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = 'public' AND c.column_name = 'org_id' AND t.table_type = 'BASE TABLE' ORDER BY 1`);
  return [...new Set([...rows.map((r) => r.table_name), "organizations", ...Object.keys(parentScoped(await presentTables(db)))])].sort();
}

/** What is missing for RLS to hold; empty when it is in place. */
export async function rlsCatalogProblems(db: Queryable): Promise<string[]> {
  const problems: string[] = [];
  // PG16 split SET from membership: SET ROLE needs the SET option, which pg_has_role names 'SET' from 16 on.
  const [{ v }] = await db.query<{ v: number }>("SELECT current_setting('server_version_num')::int AS v");
  const TENANT_ROLE = (await loadTenantRole(db)) ?? "";
  if (!TENANT_ROLE) return ["octillion_tenant_role() does not exist (migration 0003_row_level_security not applied)"];
  const [role] = await db.query<{ rolsuper: boolean; rolbypassrls: boolean; usable: boolean }>(
    `SELECT rolsuper, rolbypassrls, pg_has_role(current_user, oid, $2) AS usable FROM pg_roles WHERE rolname = $1`, [TENANT_ROLE, v >= 160000 ? "SET" : "MEMBER"]);
  if (!role) return [`role ${TENANT_ROLE} does not exist (migration 0003_row_level_security not applied)`];
  if (role.rolsuper || role.rolbypassrls) problems.push(`role ${TENANT_ROLE} bypasses row-level security (superuser or BYPASSRLS)`);
  if (!role.usable) problems.push(`the app's role (current_user) may not SET ROLE ${TENANT_ROLE}, so tenant queries cannot switch to it`);
  const tenant = new Set(await tenantTables(db));
  const state = await db.query<{ relname: string; on: boolean; policies: number; reach: string[] }>(
    `SELECT c.relname, c.relrowsecurity AS on,
            (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname AND $1 = ANY (p.roles))::int AS policies,
            array_remove(ARRAY[CASE WHEN has_table_privilege($1, c.oid, 'SELECT') THEN 'SELECT' END,
                                CASE WHEN has_table_privilege($1, c.oid, 'INSERT') THEN 'INSERT' END,
                                CASE WHEN has_table_privilege($1, c.oid, 'UPDATE') THEN 'UPDATE' END,
                                CASE WHEN has_table_privilege($1, c.oid, 'DELETE') THEN 'DELETE' END], NULL) AS reach
       FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')`, [TENANT_ROLE]);
  const byName = new Map(state.map((r) => [r.relname, r]));
  for (const t of tenant) {
    const s = byName.get(t);
    if (!s) problems.push(`${t}: table missing`);
    else if (!s.on) problems.push(`${t}: row-level security is off`);
    else if (!s.policies && s.reach.length) problems.push(`${t}: reachable by ${TENANT_ROLE} with no policy`);
  }
  // Every permissive policy for the role limits rows to the workspace it acts for (a pack's table included, mold_v0-038):
  // a policy that does not name octillion_tenant_org() would open rows to every workspace. The one shell exception reads a
  // population's agents through the population's own policy.
  const policies = await db.query<{ tablename: string; policyname: string; qual: string | null; with_check: string | null }>(
    `SELECT tablename, policyname, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND permissive = 'PERMISSIVE' AND ($1 = ANY (roles) OR 'public' = ANY (roles)) ORDER BY 1, 2`, [TENANT_ROLE]);
  const scoped = (x: string | null) => x == null || x.includes("octillion_tenant_org()");
  const PACK_RULE = "(org_id = octillion_tenant_org())";
  for (const p of policies) {
    // Only the shell's own policy names (0003_row_level_security, and the packs' helper in src/migrate.ts): another
    // permissive policy could open rows to a fixed organization while still naming octillion_tenant_org().
    if (!["tenant_isolation", "tenant_read", "tenant_write", "pack_tenant_isolation"].includes(p.policyname))
      problems.push(`${p.tablename}: unexpected policy ${p.policyname} for ${TENANT_ROLE}`);
    if (p.tablename === "developer_population_agents" && p.policyname === "tenant_read") continue;
    if (!scoped(p.qual) || !scoped(p.with_check)) problems.push(`${p.tablename}: policy ${p.policyname} does not limit rows to the tenant's own organization`);
    if (p.policyname === "pack_tenant_isolation" && (p.qual !== PACK_RULE || p.with_check !== PACK_RULE))
      problems.push(`${p.tablename}: pack policy ${p.policyname} is not the workspace rule ${PACK_RULE}`);
  }
  // Anything else the role can reach must be a known read-only platform table: a new table is closed until granted.
  for (const s of state) {
    if (tenant.has(s.relname) || !s.reach.length) continue;
    if (!PLATFORM_READONLY.includes(s.relname)) problems.push(`${s.relname}: ${TENANT_ROLE} can ${s.reach.join("/")} it, but it is neither a tenant table nor a known platform table`);
    else if (s.reach.some((p) => p !== "SELECT")) problems.push(`${s.relname}: ${TENANT_ROLE} can ${s.reach.join("/")} a platform table (read-only expected)`);
  }
  return problems;
}

class Rollback extends Error {}

/** The live proof. Leaves nothing behind: everything happens in one transaction that is rolled back. */
export async function rlsProbe(db: Db): Promise<{ problems: string[]; checked: number }> {
  const TENANT_ROLE = (await loadTenantRole(db)) ?? tenantRole();
  if (!TENANT_ROLE) return { problems: ["octillion_tenant_role() does not exist (migration 0003_row_level_security not applied)"], checked: 0 };
  const problems: string[] = [];
  let checked = 0;
  const tables = await tenantTables(db);
  const has = await presentTables(db), PARENT_SCOPED = parentScoped(has);
  /** Pack workspace tables: the ones the shell's helper secured (src/migrate.ts shell_pack_tenant_table). */
  const packTables = (await db.query<{ t: string }>(
    "SELECT DISTINCT tablename AS t FROM pg_policies WHERE schemaname = 'public' AND policyname = 'pack_tenant_isolation' ORDER BY 1")).map((r) => r.t)
    .filter((t) => /^[a-z_][a-z0-9_]*$/.test(t));
  const tag = `rls-probe-${randomBytes(4).toString("hex")}`;
  await db.transaction(async (tx) => {
    // Bounded: a probe must never hold locks or a pooled connection for long.
    await tx.query("SET LOCAL statement_timeout = '10s'");
    await tx.query("SET LOCAL lock_timeout = '5s'");
    const one = async <T>(sql: string, params?: unknown[]) => (await tx.query<T>(sql, params))[0]!;
    /** A statement that must be refused by RLS or by privileges (SQLSTATE 42501), nothing else. */
    const refused = async (what: string, sql: string, params?: unknown[]) => {
      await tx.query("SAVEPOINT probe");
      try { await tx.query(sql, params); problems.push(`${what}: allowed`); await tx.query("RELEASE SAVEPOINT probe"); }
      catch (e) {
        await tx.query("ROLLBACK TO SAVEPOINT probe");
        const code = (e as { code?: string }).code;
        if (code !== "42501") problems.push(`${what}: failed with ${code ?? "an error"} instead of being refused (42501)`);
      }
      checked++;
    };
    const org = async (k: string) => (await one<{ id: number }>("INSERT INTO organizations (slug, name) VALUES ($1, $1) RETURNING id", [`${tag}-${k}`])).id;
    const a = await org("a"), b = await org("b");
    // The product's tables (a host pack's since mold_v0-049): probed when this database has them.
    const product = has.has("products") && has.has("scenarios");
    const prod = async (o: number, k: string) => (await one<{ id: number }>("INSERT INTO products (org_id, slug, name) VALUES ($1, $2, $2) RETURNING id", [o, `${tag}-${k}`])).id;
    const pa = product ? await prod(a, "pa") : 0, pb = product ? await prod(b, "pb") : 0;
    for (const o of [a, b]) {
      await tx.query("INSERT INTO api_keys (org_id, label, key_prefix, key_hash) VALUES ($1, $2, 'oct_probe', $3)", [o, tag, `${tag}-${o}`]);
      await tx.query("INSERT INTO mcp_events (org_id, method) VALUES ($1, 'rls/probe')", [o]);
      await tx.query("INSERT INTO workspace_records (org_id, pack, area, key) VALUES ($1, 'probe', 'probe', $2)", [o, tag]);
      // Runs (mold_v0-041): a run, an event and a result per organization.
      await tx.query("INSERT INTO runs (id, org_id, pack, kind, spec, max_attempts, token_lifetime_seconds, lease_seconds, budget_usd) VALUES ($1, $2, 'probe', 'probe', '{}', 1, 60, 60, 1)", [`${tag}-run-${o}`, o]);
      await tx.query("INSERT INTO run_events (run_id, org_id, attempt, type) VALUES ($1, $2, 0, 'probe')", [`${tag}-run-${o}`, o]);
      await tx.query("INSERT INTO run_results (run_id, org_id, check_area, check_key, status) VALUES ($1, $2, 'probe', 'probe', 'pass')", [`${tag}-run-${o}`, o]);
      // A run's gateway usage (mold_v0-053): readable by its own workspace only.
      await tx.query("/* tenant: rls probe, the probe org's own run */ INSERT INTO gateway_usage (token_hash, provider, run_id, cost_usd) VALUES ($1, 'probe', $2, 1)", [`${tag}-gw-${o}`, `${tag}-run-${o}`]);
      // The workspace store (mold_v0-033): a snapshot and a lease per organization.
      await tx.query("INSERT INTO workspace_snapshots (org_id, store, version, status, base_version, manifest, manifest_sha256, files, bytes, object_key) VALUES ($1, 'probe', 1, 'committed', 0, '{}', 'x', 0, 0, 'x')", [o]);
      await tx.query("INSERT INTO workspace_leases (org_id, store, run_id, expires_at) VALUES ($1, 'probe', $2, now())", [o, `${tag}-run-${o}`]);
      // The credential vault (mold_v0-034): a sealed value per organization (not readable by tenant work at all).
      await tx.query("INSERT INTO workspace_credentials (org_id, pack, name, bound_to, sealed, last4) VALUES ($1, 'probe', 'probe', 'workspace', 'x', 'xxxx')", [o]);
      // Schedules and notices (mold_v0-035): a schedule and a notice per organization.
      await tx.query("INSERT INTO workspace_schedules (org_id, pack, name, job_kind, cron, next_at) VALUES ($1, 'probe', 'probe', 'probe', '0 * * * *', now())", [o]);
      await tx.query("INSERT INTO workspace_notices (org_id, pack, area, record_key, due_on) VALUES ($1, 'probe', 'probe', $2, current_date)", [o, tag]);
      // Price per run (mold_v0-019): a run's charge per organization.
      await tx.query("INSERT INTO run_charges (run_id, org_id, kind, pack, job_kind, attempt, run_status, currency, amount_minor) VALUES ($1, $2, 'charge', 'probe', 'probe', 1, 'succeeded', 'usd', 100)", [`${tag}-run-${o}`, o]);
    }
    if (product) await tx.query("/* tenant: rls probe, one scenario per probe org */ INSERT INTO scenarios (product_id, title, prompt) VALUES ($1, $2, $2), ($3, $2, $2)", [pa, tag, pb]);
    // What A should see through each parent, counted as the platform before switching.
    const expected: Record<string, number> = {};
    for (const [t, sql] of Object.entries(PARENT_SCOPED)) expected[t] = (await one<{ n: number }>(sql, [a])).n;
    const as = async (orgId: number | null) => {
      await tx.query(`SET LOCAL ROLE ${TENANT_ROLE}`);
      await tx.query("SELECT set_config('octillion.org_id', $1, true)", [orgId === null ? "" : String(orgId)]);
    };

    await as(a);
    for (const t of tables) {
      const parent = PARENT_SCOPED[t];
      const reachable = (await one<{ ok: boolean }>("SELECT has_table_privilege($1, $2, 'SELECT') AS ok", [TENANT_ROLE, `public.${t}`])).ok;
      if (!reachable) continue; // a table tenant work cannot read at all is safe by construction
      if (parent) {
        const { n } = await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
        if (n !== expected[t]) problems.push(`${t}: organization A sees ${n} row(s) through its parent, expected ${expected[t]}`);
      } else {
        const col = t === "organizations" ? "id" : "org_id";
        const foreign = SHARED_TABLES.includes(t) ? `${col} <> $1` : `${col} IS DISTINCT FROM $1`;
        const { n } = await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE ${foreign}`, [a]);
        if (n) problems.push(`${t}: organization A sees ${n} row(s) of other organizations`);
      }
      checked++;
    }
    if (product) {
      if ((await tx.query("/* tenant: rls probe, as tenant A on purpose */ SELECT 1 FROM products WHERE id = $1", [pb])).length) problems.push("products: A reads B's product by id");
      if (!(await tx.query("/* tenant: rls probe, as tenant A on purpose */ SELECT 1 FROM products WHERE id = $1", [pa])).length) problems.push("products: A cannot read its own product");
      if ((await tx.query("/* tenant: rls probe, as tenant A on purpose */ UPDATE products SET name = 'rls probe' WHERE id = $1 RETURNING id", [pb])).length) problems.push("products: A updated B's product");
      if ((await tx.query("/* tenant: rls probe */ DELETE FROM scenarios WHERE product_id = $1 RETURNING id", [pb])).length) problems.push("scenarios: A deleted B's scenario");
      checked += 4;
      await refused("products: A inserts a row for B", "INSERT INTO products (org_id, slug, name) VALUES ($1, $2, $2)", [b, `${tag}-x`]);
      await refused("products: A moves its product to B", "/* tenant: rls probe */ UPDATE products SET org_id = $2 WHERE id = $1", [pa, b]);
      await refused("scenarios: A adds a scenario to B's product", "/* tenant: rls probe, as tenant A on purpose */ INSERT INTO scenarios (product_id, title, prompt) VALUES ($1, 'x', 'x')", [pb]);
      if (has.has("simulations")) await refused("simulations: A points its own run at B's product", "/* tenant: rls probe */ INSERT INTO simulations (org_id, product_id, name, models, harness, repeats) VALUES ($1, $2, 'x', '{x}', 'x', 1)", [a, pb]);
      if (has.has("org_task_sets")) await refused("org_task_sets: A attaches its own task set to B's product", "/* tenant: rls probe */ INSERT INTO org_task_sets (public_id, org_id, product_id, name) VALUES ($1, $2, $3, 'x')", [`${tag}-ts`, a, pb]);
    }
    await refused("api_keys: A issues itself a key", "INSERT INTO api_keys (org_id, label, key_prefix, key_hash) VALUES ($1, 'x', 'oct_x', $2)", [a, `${tag}-own`]);
    // Member keys (mold_v0-007): tenant work cannot bring a revoked or expired key back, nor widen one.
    await refused("api_keys: A un-revokes or extends its own key", "UPDATE api_keys SET revoked_at = NULL, expires_at = NULL, scoped = false WHERE org_id = $1", [a]);
    await refused("organizations: A changes its own account", "/* tenant: rls probe */ UPDATE organizations SET name = 'x' WHERE id = $1", [a]);
    for (const t of NO_ACCESS) await refused(`${t}: readable by a tenant query`, `SELECT 1 FROM ${t} LIMIT 1`);
    // Record areas (mold_v0-047): a platform area is read-only to customers; a workspace area's rows are each workspace's own.
    await refused("platform_records: a tenant adds a shared record", "INSERT INTO platform_records (pack, area, key) VALUES ('probe', 'probe', $1)", [tag]);
    await refused("platform_records: a tenant changes a shared record", "UPDATE platform_records SET title = 'x'");
    await refused("platform_records: a tenant deletes a shared record", "DELETE FROM platform_records");
    await refused("workspace_records: A writes a record for B", "/* tenant: rls probe */ INSERT INTO workspace_records (org_id, pack, area, key) VALUES ($1, 'probe', 'probe', $2)", [b, tag]);
    // Runs (mold_v0-041): tenant work reads its own runs, events and results and writes none (the shell's code does).
    await refused("runs: a tenant queues a run itself", "INSERT INTO runs (id, org_id, pack, kind, spec, max_attempts, token_lifetime_seconds, lease_seconds, budget_usd) VALUES ($1, $2, 'p', 'k', '{}', 1, 60, 60, 1)", [`${tag}-x`, a]);
    await refused("runs: a tenant changes its own run (budget, status)", "/* tenant: rls probe */ UPDATE runs SET budget_usd = 1000 WHERE id = $1", [`${tag}-run-${a}`]);
    await refused("run_results: a tenant writes its own result", "INSERT INTO run_results (run_id, org_id, check_area, check_key, status) VALUES ($1, $2, 'p', 'p', 'pass')", [`${tag}-run-${a}`, a]);
    await refused("run_events: a tenant writes an event", "INSERT INTO run_events (run_id, org_id, attempt, type) VALUES ($1, $2, 0, 'x')", [`${tag}-run-${a}`, a]);
    await refused("workspace_snapshots: a tenant writes a snapshot row", "INSERT INTO workspace_snapshots (org_id, store, version, status, base_version, manifest, manifest_sha256, files, bytes, object_key) VALUES ($1, 'p', 9, 'committed', 0, '{}', 'x', 0, 0, 'x')", [a]);
    await refused("workspace_leases: a tenant takes a store's lease", "/* tenant: rls probe */ UPDATE workspace_leases SET run_id = 'x'");
    // The credential vault (mold_v0-034): tenant work can neither read, write nor replace a sealed value, its own included.
    await refused("workspace_credentials: a tenant writes a value", "INSERT INTO workspace_credentials (org_id, pack, name, bound_to, sealed, last4) VALUES ($1, 'p', 'p', 'workspace', 'x', 'xxxx')", [a]);
    await refused("workspace_credentials: a tenant replaces a value", "/* tenant: rls probe */ UPDATE workspace_credentials SET sealed = 'x'");
    // Run spend (mold_v0-053): a tenant can neither write a run's usage nor raise a counter (mold_v0-018).
    await refused("gateway_usage: a tenant writes its own run's usage", "/* tenant: rls probe, as tenant A on purpose */ INSERT INTO gateway_usage (token_hash, provider, run_id) VALUES ($1, 'p', $2)", [`${tag}-gwx`, `${tag}-run-${a}`]);
    await refused("rate_limit_hits: a tenant resets a counter", "DELETE FROM rate_limit_hits");
    // Schedules and notices (mold_v0-035): tenant work reads its own and writes none (the shell's code does, for the session's workspace).
    await refused("workspace_schedules: a tenant adds a schedule", "INSERT INTO workspace_schedules (org_id, pack, name, job_kind, cron, next_at) VALUES ($1, 'p', 'x', 'k', '0 * * * *', now())", [a]);
    await refused("workspace_schedules: a tenant moves its own schedule on", "/* tenant: rls probe */ UPDATE workspace_schedules SET next_at = now(), seq = seq + 1");
    await refused("workspace_notices: a tenant posts a notice", "INSERT INTO workspace_notices (org_id, pack, area, record_key, due_on) VALUES ($1, 'p', 'p', 'x', current_date)", [a]);
    await refused("workspace_notices: a tenant marks a notice emailed", "/* tenant: rls probe */ UPDATE workspace_notices SET emailed_at = now()");
    // Price per run (mold_v0-019): tenant work reads its own charges and can neither write, lower nor credit one, nor
    // call the function that writes them.
    await refused("run_charges: a tenant writes a charge", "INSERT INTO run_charges (run_id, org_id, kind, pack, job_kind, attempt, run_status, currency, amount_minor) VALUES ($1, $2, 'credit', 'p', 'p', 1, 'succeeded', 'usd', -100)", [`${tag}-run-${a}`, a]);
    await refused("run_charges: a tenant lowers its own charge", "/* tenant: rls probe */ UPDATE run_charges SET amount_minor = 0");
    await refused("run_charges: a tenant deletes its own charge", "/* tenant: rls probe */ DELETE FROM run_charges");
    await refused("run_charges: a tenant writes a charge through the shell's function", "SELECT octillion_run_charge($1)", [`${tag}-run-${a}`]);
    // Packs' workspace tables (mold_v0-038): A cannot write a row for B (refused by the policy before any other check).
    for (const t of packTables) await refused(`${t}: A inserts a row for B`, `/* tenant: rls probe */ INSERT INTO ${t} (org_id) VALUES ($1)`, [b]);

    await as(null);
    for (const t of ["products", "api_keys", "mcp_events", "organizations", "scenarios"].filter((x) => has.has(x))) {
      const { n } = await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
      if (n) problems.push(`${t}: with no organization set the tenant role still sees ${n} row(s)`);
      checked++;
    }
    throw new Rollback();
  }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
  return { problems, checked };
}

/** The live probe's latest result in this process (shown on /healthz); run by the cron at most once an hour. */
let probeState: { status: "ok" | "failed" | "error"; at: number } | null = null;
export const rlsProbeState = () => probeState?.status ?? "not run";
export async function probeFromCron(getDb: () => Promise<Db>): Promise<string> {
  if (probeState && Date.now() - probeState.at < 3_600_000) return probeState.status;
  try {
    const { problems } = await rlsProbe(await getDb());
    probeState = { status: problems.length ? "failed" : "ok", at: Date.now() };
    // A failed probe closes the gate: tenant queries are refused until a probe passes again.
    setTenantGate(problems);
    if (problems.length) console.error(`RLS PROBE FAILED: tenant queries are refused until it passes: ${problems.join("; ")}`);
  } catch (e) {
    probeState = { status: "error", at: Date.now() };
    console.error(`rls probe could not run: ${(e as Error).message}`);
  }
  return probeState.status;
}

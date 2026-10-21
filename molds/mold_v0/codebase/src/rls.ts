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
/** Tenant tables without their own org_id: scoped through a parent row. `own` selects the rows whose parent is $1's. */
export const PARENT_SCOPED: Record<string, string> = {
  scenarios: "SELECT count(*)::int AS n FROM scenarios c JOIN products p ON p.id = c.product_id WHERE p.org_id = $1",
  product_personas: "SELECT count(*)::int AS n FROM product_personas c JOIN products p ON p.id = c.product_id WHERE p.org_id = $1",
  transcript_events: "SELECT count(*)::int AS n FROM transcript_events c JOIN agent_sessions s ON s.id = c.session_id WHERE s.org_id = $1",
  gateway_usage: "SELECT count(*)::int AS n FROM gateway_usage c JOIN agent_sessions s ON s.id = c.session_id WHERE s.org_id = $1",
  gateway_tokens: "SELECT count(*)::int AS n FROM gateway_tokens c JOIN agent_sessions s ON s.id = c.session_id WHERE s.org_id = $1",
  developer_population_agents: "SELECT count(*)::int AS n FROM developer_population_agents c JOIN developer_populations p ON p.id = c.population_id WHERE p.org_id IS NULL OR p.org_id = $1",
};
/** Tables whose rows with no organization are Octillion's shared ones, readable by every tenant. */
export const SHARED_TABLES = ["developer_profiles", "developer_populations", "journey_templates"];
/** Platform tables tenant work may read, never write, and that hold nothing of any one organization. */
export const PLATFORM_READONLY = ["library_tasks", "platform_settings", "platform_harnesses", "model_prices", "schema_migrations", "journey_seed"];
/** Tables a tenant query must never reach (checked live by the probe). */
export const NO_ACCESS = ["vault_credentials", "vault_providers", "admin_access_log", "admin_tokens", "access_requests", "orchestrators", "email_log"];

export async function tenantTables(db: Queryable): Promise<string[]> {
  const rows = await db.query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = 'public' AND c.column_name = 'org_id' AND t.table_type = 'BASE TABLE' ORDER BY 1`);
  return [...new Set([...rows.map((r) => r.table_name), "organizations", ...Object.keys(PARENT_SCOPED)])].sort();
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
    const prod = async (o: number, k: string) => (await one<{ id: number }>("INSERT INTO products (org_id, slug, name) VALUES ($1, $2, $2) RETURNING id", [o, `${tag}-${k}`])).id;
    const pa = await prod(a, "pa"), pb = await prod(b, "pb");
    for (const o of [a, b]) {
      await tx.query("INSERT INTO api_keys (org_id, label, key_prefix, key_hash) VALUES ($1, $2, 'oct_probe', $3)", [o, tag, `${tag}-${o}`]);
      await tx.query("INSERT INTO mcp_events (org_id, method) VALUES ($1, 'rls/probe')", [o]);
    }
    await tx.query("/* tenant: rls probe, one scenario per probe org */ INSERT INTO scenarios (product_id, title, prompt) VALUES ($1, $2, $2), ($3, $2, $2)", [pa, tag, pb]);
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
    if ((await tx.query("/* tenant: rls probe, as tenant A on purpose */ SELECT 1 FROM products WHERE id = $1", [pb])).length) problems.push("products: A reads B's product by id");
    if (!(await tx.query("/* tenant: rls probe, as tenant A on purpose */ SELECT 1 FROM products WHERE id = $1", [pa])).length) problems.push("products: A cannot read its own product");
    if ((await tx.query("/* tenant: rls probe, as tenant A on purpose */ UPDATE products SET name = 'rls probe' WHERE id = $1 RETURNING id", [pb])).length) problems.push("products: A updated B's product");
    if ((await tx.query("/* tenant: rls probe */ DELETE FROM scenarios WHERE product_id = $1 RETURNING id", [pb])).length) problems.push("scenarios: A deleted B's scenario");
    checked += 4;
    await refused("products: A inserts a row for B", "INSERT INTO products (org_id, slug, name) VALUES ($1, $2, $2)", [b, `${tag}-x`]);
    await refused("products: A moves its product to B", "/* tenant: rls probe */ UPDATE products SET org_id = $2 WHERE id = $1", [pa, b]);
    await refused("scenarios: A adds a scenario to B's product", "/* tenant: rls probe, as tenant A on purpose */ INSERT INTO scenarios (product_id, title, prompt) VALUES ($1, 'x', 'x')", [pb]);
    await refused("simulations: A points its own run at B's product", "/* tenant: rls probe */ INSERT INTO simulations (org_id, product_id, name, models, harness, repeats) VALUES ($1, $2, 'x', '{x}', 'x', 1)", [a, pb]);
    await refused("org_task_sets: A attaches its own task set to B's product", "/* tenant: rls probe */ INSERT INTO org_task_sets (public_id, org_id, product_id, name) VALUES ($1, $2, $3, 'x')", [`${tag}-ts`, a, pb]);
    await refused("api_keys: A issues itself a key", "INSERT INTO api_keys (org_id, label, key_prefix, key_hash) VALUES ($1, 'x', 'oct_x', $2)", [a, `${tag}-own`]);
    await refused("organizations: A changes its own account", "/* tenant: rls probe */ UPDATE organizations SET name = 'x' WHERE id = $1", [a]);
    for (const t of NO_ACCESS) await refused(`${t}: readable by a tenant query`, `SELECT 1 FROM ${t} LIMIT 1`);
    // Packs' workspace tables (mold_v0-038): A cannot write a row for B (refused by the policy before any other check).
    for (const t of packTables) await refused(`${t}: A inserts a row for B`, `/* tenant: rls probe */ INSERT INTO ${t} (org_id) VALUES ($1)`, [b]);

    await as(null);
    for (const t of ["products", "api_keys", "mcp_events", "organizations", "scenarios"]) {
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

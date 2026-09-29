/**
 * Keep every org-scoped table closed to the app role for the WHOLE of a schema bring-up (mold_v1-143).
 *
 * The chain provision.py runs on every deploy (schema, journal, the mold's bootstrap, the task-workflow
 * migration, rls-cover.mjs) is not one transaction, and the live app keeps serving as app_rw while it
 * runs. Measured on a postgres:16 set up like the isolation lane, with the chain as it stood:
 *
 *   `drizzle-kit push --force`  schema.ts models no policy, so on a live database push emits
 *                               `DISABLE ROW LEVEL SECURITY` on all 58 org-scoped tables and
 *                               `DROP POLICY` on all 60 policies; app_rw scoped to workspace A read
 *                               workspace B's rows from 58/58 tables until rls-cover ran (3.2 s here,
 *                               longer over a network).
 *   `.bootstrap-supabase.mjs`   rewrites org_isolation on its 13 tables, and the task-workflow
 *                               migration on its 3, to the "permissive when app.org_id is unset" form,
 *                               so between them and rls-cover an app_rw query that never set
 *                               app.org_id read EVERY workspace's rows from 16 tables (1.6 s), even
 *                               with push out of the picture.
 *
 * Neither script is ours to change (HARD RULE 1), so the factory closes the window around them:
 *
 *   probe    how much is there: public base tables, org-scoped tables, whether the app role exists.
 *            provision.py only lets `drizzle-kit push --force` near a database with NO public table;
 *            a live one gets the journal first, then `apply` for whatever drift is left.
 *   hold     one transaction: every org-scoped table ENABLEd and FORCEd, plus a RESTRICTIVE policy
 *            `factory_deploy_guard` TO the app role with the mode's own predicate. Restrictive
 *            policies AND with the permissive ones, and neither the bootstrap nor the task-workflow
 *            migration touches a policy of that name, so their temporary permissive rewrite cannot
 *            widen what app_rw sees. It changes nothing a finished deploy allows: it is the predicate
 *            rls-cover itself converges every table to (the control plane keeps its open-when-unset
 *            shape, exactly as there).
 *   apply    the statements a `drizzle-kit push --strict --verbose` DRY RUN printed, minus the ones
 *            provision.py filtered out (anything that drops a policy or disables RLS, and drops of
 *            indexes the mold creates outside schema.ts), in ONE transaction that also ENABLEs and
 *            FORCEs RLS on any org-scoped table it created (not in `off` mode). `ALTER TYPE ... ADD VALUE` runs first on
 *            its own, because a value added inside a transaction cannot be used until it commits.
 *            It also withholds the app role's DEFAULT privileges on new tables, so a table created
 *            mid-chain is unreadable until the next hold (provision.py re-runs hold after the journal,
 *            the drift apply and the task-workflow migration; it is idempotent).
 *   release  drop `factory_deploy_guard` everywhere and restore the default grant, in one transaction. Run only after rls-cover
 *            exited 0, so the permissive policies are strict again before the guard goes. A chain
 *            that dies before this leaves the guard in place: stricter, never wider.
 *
 * ADMIN_URL and SCHEMA_SQL travel in the environment, never in argv. Prints one JSON line; no secret in it.
 *   exit 0  done    exit 1  it ran and failed    exit 2  misuse    exit 3  could not run at all
 */
import postgres from "postgres";
import { q, why, orgPredicate } from "./rls-policy.mjs";

const url = process.env.ADMIN_URL;
const action = process.env.ACTION || "";
const mode = process.env.RLS_MODE || "fail_closed";
const APP_ROLE = process.env.APP_ROLE || "app_rw";
const GUARD = "factory_deploy_guard";
if (!url) { console.error("ADMIN_URL is not set"); process.exit(2); }
if (!["probe", "hold", "release", "apply"].includes(action)) { console.error(`ACTION=${action} is not probe, hold, release or apply`); process.exit(2); }
if (!["fail_closed", "on", "off"].includes(mode)) { console.error(`RLS_MODE=${mode} is not fail_closed, on or off`); process.exit(2); }
// `off` is an application that asked for no isolation: nothing to hold, and apply must not ENABLE RLS
// on a table rls-cover will never give a policy (that would lock the app out of it for good).
if (mode === "off" && ["hold", "release"].includes(action)) { console.error(`ACTION=${action} with RLS_MODE=off`); process.exit(2); }

// The predicate rls-cover.mjs converges each table to, imported from the module both use: the guard must
// never be stricter (an outage) nor looser (the window it exists to close). --self-test checks the import.
const pred = (t) => orgPredicate(mode, t);
// The DML the bootstrap grants app_rw on every future table (ALTER DEFAULT PRIVILEGES). Withheld while
// held, so a table the journal or a drift apply CREATES mid-chain (possibly backfilled from rows that
// exist) is not readable by the serving app before the next hold guards it; the bootstrap and release
// both grant it back.
const DEFAULT_DML = "SELECT, INSERT, UPDATE, DELETE";

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 20, onnotice: () => {} });
const TABLES = (s) => s`
  SELECT c.relname AS t, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped)
  ORDER BY c.relname`;
const roleExists = async (s) => (await s`SELECT 1 AS x FROM pg_roles WHERE rolname = ${APP_ROLE}`).length > 0;

// ENABLE + FORCE, and (when the app role exists) the guard: the one body hold and apply share.
async function close(tx, withGuard) {
  const tables = await TABLES(tx), did = [];
  for (const { t, enabled, forced } of tables) {
    if (!enabled) { await tx.unsafe(`ALTER TABLE ${q(t)} ENABLE ROW LEVEL SECURITY`); did.push(`${t}(enable)`); }
    if (!forced) await tx.unsafe(`ALTER TABLE ${q(t)} FORCE ROW LEVEL SECURITY`);
    if (withGuard) {
      await tx.unsafe(`DROP POLICY IF EXISTS ${GUARD} ON ${q(t)}`);
      await tx.unsafe(`CREATE POLICY ${GUARD} ON ${q(t)} AS RESTRICTIVE FOR ALL TO ${q(APP_ROLE)} ` +
                      `USING ${pred(t)} WITH CHECK ${pred(t)}`);
    }
  }
  return { tables: tables.length, enabled: did };
}

// Every statement below takes ACCESS EXCLUSIVE on a table the live app is using, and a waiting
// ACCESS EXCLUSIVE queues every later reader behind it. Bound the wait and retry, rather than stall
// the app behind a long transaction of its own.
async function inTx(fn) {
  for (let i = 1; ; i++) {
    try { return await sql.begin(async (tx) => { await tx`SET LOCAL lock_timeout = '10s'`; return fn(tx); }); }
    catch (e) { if (e.code !== "55P03" && e.code !== "40P01" || i === 4) throw e; }
  }
}

const committedOutside = [];   // `ALTER TYPE ... ADD VALUE` cannot share the transaction, so it commits first
try {
  let out;
  if (action === "probe") {
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
                               WHERE ns.nspname = 'public' AND c.relkind = 'r'`;
    // read_only: provision.py probes through the dry run's own URL first, and refuses to plan through a
    // connection that is not actually read-only (a pooler can drop startup options silently).
    const [{ ro }] = await sql`SELECT current_setting('transaction_read_only') AS ro`;
    // Every primary key as it stands: drizzle-kit's push re-emits DROP/ADD for composite keys it already
    // has (same name, same columns). provision.py sets those pairs aside only when this confirms they match.
    const pkRows = await sql`SELECT con.conname AS name, cl.relname AS t,
        array_agg(a.attname ORDER BY k.ord) AS cols
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      WHERE con.contype = 'p' AND ns.nspname = 'public'
      GROUP BY con.conname, cl.relname`;
    const pks = Object.fromEntries(pkRows.map((r) => [r.name, { table: r.t, cols: r.cols }]));
    out = { public_tables: n, org_scoped: (await TABLES(sql)).length, app_role: await roleExists(sql), read_only: ro === "on", pks };
  } else if (action === "hold") {
    // No app role yet means no app has ever connected: there is nobody to hold the window against.
    if (!(await roleExists(sql))) out = { held: false, reason: `no ${APP_ROLE} role yet` };
    else out = { held: true, mode, ...(await inTx(async (tx) => {
      await tx.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ${DEFAULT_DML} ON TABLES FROM ${q(APP_ROLE)}`);
      return close(tx, true);
    })) };
  } else if (action === "release") {
    out = await inTx(async (tx) => {
      const rows = await tx`SELECT tablename AS t FROM pg_policies WHERE schemaname = 'public' AND policyname = ${GUARD}`;
      for (const { t } of rows) await tx.unsafe(`DROP POLICY ${GUARD} ON ${q(t)}`);
      if (await roleExists(tx)) await tx.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${DEFAULT_DML} ON TABLES TO ${q(APP_ROLE)}`);
      return { released: rows.length };
    });
  } else {
    const stmts = JSON.parse(Buffer.from(process.env.SCHEMA_SQL || "", "base64").toString("utf8") || "[]");
    const addValue = stmts.filter((s) => /^\s*ALTER\s+TYPE\s[\s\S]*\sADD\s+VALUE\b/i.test(s));
    const rest = stmts.filter((s) => !addValue.includes(s));
    for (const s of addValue) { await sql.unsafe(s); committedOutside.push(s); }
    // No guard here: hold already put one on every table that existed, and a table this creates is
    // empty and, with RLS on and no permissive policy yet, closed to the app role until rls-cover.
    out = { applied: stmts.length, ...(await inTx(async (tx) => {
      for (const s of rest) await tx.unsafe(s);
      return mode === "off" ? {} : close(tx, false);
    })) };
  }
  console.log(JSON.stringify({ action, ...out }));
} catch (e) {
  // A SQLSTATE outside the connection/auth classes means the database answered and refused a statement.
  const ran = e && /^[0-9A-Z]{5}$/.test(String(e.code)) && e.code !== "EPIPE" && !/^(08|28|3D|57P0[1-3])/.test(e.code);
  // Every transaction here rolled back whole. The one thing that can have committed is an enum value
  // `apply` added first, outside it — say so, and name it, rather than claim nothing changed.
  const kept = committedOutside.length
    ? `; the transaction rolled back, but ${committedOutside.length} enum value addition(s) had already committed on their own: ` +
      committedOutside.map((x) => x.replace(/\s+/g, " ").slice(0, 120)).join(" | ")
    : "; the transaction rolled back, nothing was changed";
  console.error(`deploy window ${action} ${ran ? "failed" : "could not be measured"} — ` + why(e) + (ran || committedOutside.length ? kept : ""));
  process.exit(ran ? 1 : 3);
} finally { await sql.end({ timeout: 5 }).catch(() => {}); }

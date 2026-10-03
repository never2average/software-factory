#!/usr/bin/env node
/**
 * A NEW DATABASE ON A PLAIN POSTGRES WITHOUT TLS — the path docs/self-hosting/DATABASE_AND_AGENT_URL.md gives, run as written.
 *
 * Two facts make that page necessary, and both are held elsewhere: the migration journal alone does not build the
 * schema the app reads (scripts/test-migrations-db.mjs lists what it lacks), and nothing in it creates the app's
 * role or its row-level security (scripts/bootstrap-test-db.mjs does, for CI). So a new database is built from
 * schema.ts, then the journal is recorded on top, then the role and the policies:
 *
 *   1. drizzle-kit push --force                           (an EMPTY database only)
 *   2. DATABASE_SSL=disable npm run db:migrate:production
 *   3. APP_RW_PASSWORD=… npm run db:bootstrap             (creates app_rw, which step 4 grants to)
 *   4. DATABASE_SSL=disable npm run db:migrate:task-workflows
 *   5. APP_RW_PASSWORD=… npm run db:bootstrap             (again: step 4's tables get the same policies)
 *
 * This runs exactly those five against a scratch database on the Postgres CI already has (which has no TLS, like a
 * Postgres on the app's own machine), and checks what a deployment needs to be true afterwards. It also holds the
 * TLS setting's default: without DATABASE_SSL both migration scripts still refuse to connect without TLS.
 *
 * Each migration script is run from a scratch directory that holds only what it reads from the working directory
 * (drizzle/, for the journal). Both scripts read `.env.local` and `.env.supabase` from where they are run BEFORE the
 * environment, and on a developer's machine those files name a real database.
 *
 * Needs ADMIN_URL (a role that may CREATE DATABASE). The scratch database carries this process's pid and is dropped
 * in a finally block. `app_rw` is a role of the whole server and the other isolation tests log in as it, so the
 * bootstrap is given the password they use: it is the one thing here that outlives the scratch database.
 *
 *   ADMIN_URL=postgres://postgres:…@127.0.0.1:5432/workspace_test npm run test:new-database-db
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const adminUrl = process.env.ADMIN_URL;
if (!adminUrl) {
  console.log("test-new-database-db: SKIPPED — needs ADMIN_URL (a role that may create a database).");
  process.exit(0);
}
const ROOT = fileURLToPath(new URL("..", import.meta.url));
if (!/localhost|127\.0\.0\.1/.test(adminUrl)) {
  console.log("test-new-database-db: SKIPPED — ADMIN_URL is not a Postgres on this machine, and this test is about one without TLS.");
  process.exit(0);
}

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail.slice(-700) : JSON.stringify(detail).slice(0, 700)}`}`); }
};

const SCRATCH = `newdb_${process.pid}`;
const scratchUrl = (() => { const u = new URL(adminUrl); u.pathname = `/${SCRATCH}`; return u.toString(); })();
const APP_PASSWORD = "app_rw_test_password"; // see the header: the role is shared with the other isolation tests
const appUrl = (() => { const u = new URL(scratchUrl); u.username = "app_rw"; u.password = APP_PASSWORD; return u.toString(); })();
const admin = postgres(adminUrl, { ssl: false, prepare: false, max: 1, onnotice: () => {} });

/** The environment a command gets: nothing of this process's database settings unless the test passes it. */
const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DATABASE_URL|DATABASE_URL_UNPOOLED|DATABASE_SSL|ADMIN_URL|APP_RW_PASSWORD)$/.test(k)));
const run = (cmd, args, env, cwd = ROOT) => {
  const r = spawnSync(cmd, args, { cwd, env: { ...baseEnv(), ...env }, encoding: "utf8", timeout: 300_000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
// Where the two migration scripts are run from: no .env.local, no .env.supabase, only the journal.
const cwd = mkdtempSync(join(tmpdir(), "new-database-"));
cpSync(join(ROOT, "drizzle"), join(cwd, "drizzle"), { recursive: true });
const MIGRATE = join(ROOT, "scripts/migrate-production.mjs");
const TASKS = join(ROOT, ".migrate-task-workflow-service.mjs");
const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
const COLUMNS = `select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable as c
                 from information_schema.columns where table_schema = 'public' order by 1`;

let db = null;
let app = null;
try {
  await admin.unsafe(`create database "${SCRATCH}"`);
  db = postgres(scratchUrl, { ssl: false, prepare: false, max: 1, onnotice: () => {} });

  console.log("\n1. The schema, from schema.ts, onto the empty database");
  const push = run("npx", ["drizzle-kit", "push", "--force"], { DATABASE_URL: scratchUrl });
  const expected = [...readFileSync(join(ROOT, "agent/lib/db/schema.ts"), "utf8").matchAll(/pgTable\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
  const tables = new Set((await db`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`).map((r) => r.table_name));
  check(`drizzle-kit push builds every table schema.ts declares (${expected.length})`, push.status === 0 && expected.every((t) => tables.has(t)), push.status === 0 ? expected.filter((t) => !tables.has(t)) : push.out);

  console.log("\n2. The migration journal, recorded on top (scripts/migrate-production.mjs)");
  const noSetting = run("node", [MIGRATE], { DATABASE_URL: scratchUrl }, cwd);
  check("WITHOUT DATABASE_SSL it still requires TLS and refuses this server (the default is unchanged)", noSetting.status !== 0 && !/applied |baselined|schema is current/.test(noSetting.out), noSetting.out);
  const [untouched] = await db`select to_regclass('drizzle.__drizzle_migrations') as reg`;
  check("…and it wrote nothing", untouched.reg === null, untouched);
  const explicit = run("node", [MIGRATE], { DATABASE_URL: scratchUrl, DATABASE_SSL: "require" }, cwd);
  check("DATABASE_SSL=require is the same refusal", explicit.status !== 0 && !/applied |baselined/.test(explicit.out), explicit.out);
  const remote = run("node", [MIGRATE], { DATABASE_URL: "postgres://postgres:not-a-real-password@db.example.invalid:5432/postgres", DATABASE_SSL: "disable" }, cwd);
  check("DATABASE_SSL=disable for a database that is NOT on this machine is refused before connecting, without the password in the message", remote.status !== 0 && /only for a Postgres on this machine/.test(remote.out) && /db\.example\.invalid/.test(remote.out) && !/not-a-real-password/.test(remote.out), remote.out);
  const typo = run("node", [MIGRATE], { DATABASE_URL: scratchUrl, DATABASE_SSL: "off" }, cwd);
  check("an unknown DATABASE_SSL value is an error naming the setting", typo.status !== 0 && /DATABASE_SSL="off" is not supported/.test(typo.out), typo.out);
  const migrate = run("node", [MIGRATE], { DATABASE_URL_UNPOOLED: scratchUrl, DATABASE_SSL: "disable" }, cwd);
  check("DATABASE_SSL=disable: it connects without TLS and records the journal (exit 0)", migrate.status === 0, migrate.out);
  const last = journal.entries[journal.entries.length - 1];
  const [recorded] = await db`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`;
  check(`…up to the journal's last entry (${last.tag})`, Number(recorded?.created_at) === Number(last.when), { recorded, last: last.when });
  const again = run("node", [MIGRATE], { DATABASE_URL_UNPOOLED: scratchUrl, DATABASE_SSL: "disable" }, cwd);
  check("run again: nothing to do", again.status === 0 && /database schema is current/.test(again.out), again.out);

  console.log("\n3. The app's role and row-level security (npm run db:bootstrap)");
  const bare = run("node", ["scripts/bootstrap-test-db.mjs", "--production"], { DATABASE_URL: scratchUrl });
  check("--production with no APP_RW_PASSWORD is refused (there is no default password)", bare.status !== 0 && /needs APP_RW_PASSWORD/.test(bare.out), bare.out);
  const boot = run("node", ["scripts/bootstrap-test-db.mjs", "--production"], { DATABASE_URL: scratchUrl, APP_RW_PASSWORD: APP_PASSWORD });
  check("with one, it builds the role and the policies (exit 0)", boot.status === 0 && /✓ ready/.test(boot.out), boot.out);
  check("…and prints the app's url WITHOUT the password", !boot.out.includes(APP_PASSWORD) && /postgres:\/\/app_rw@/.test(boot.out.trim().split("\n").pop()), boot.out.trim().split("\n").pop());

  console.log("\n4. The task-workflow tables (.migrate-task-workflow-service.mjs)");
  const tasksNoSetting = run("node", [TASKS], { DATABASE_URL_UNPOOLED: scratchUrl }, cwd);
  check("WITHOUT DATABASE_SSL it still requires TLS and refuses this server", tasksNoSetting.status !== 0 && !/task-workflow schema is ready/.test(tasksNoSetting.out), tasksNoSetting.out);
  const noUrl = run("node", [TASKS], { DATABASE_SSL: "disable" }, cwd);
  check("with no admin url anywhere it says so (DATABASE_URL, the app's role, is not used for it)", noUrl.status !== 0 && /An admin database URL is required/.test(noUrl.out), noUrl.out);
  const tasks = run("node", [TASKS], { DATABASE_URL_UNPOOLED: scratchUrl, DATABASE_SSL: "disable" }, cwd);
  check("DATABASE_SSL=disable with the admin url in DATABASE_URL_UNPOOLED: it runs (exit 0)", tasks.status === 0 && /task-workflow schema is ready/.test(tasks.out), tasks.out);
  const taskTables = (await db`select table_name from information_schema.tables where table_schema = 'public' and table_name in ('project_workflow_versions', 'task_workflow_instances', 'task_workflow_transition_events')`).length;
  check("…and its three tables exist", taskTables === 3, taskTables);

  const open3 = (await db`select tablename, qual from pg_policies where schemaname = 'public' and policyname = 'org_isolation' and tablename in ('project_workflow_versions', 'task_workflow_instances', 'task_workflow_transition_events')`).filter((p) => /IS NULL/i.test(p.qual));
  check("its own policies on them still allow a read that names no workspace — which is why the bootstrap runs again", open3.length === 3, open3.map((p) => p.tablename));

  console.log("\n5. The bootstrap again, over the tables step 4 added");
  const boot2 = run("node", ["scripts/bootstrap-test-db.mjs", "--production"], { DATABASE_URL: scratchUrl, APP_RW_PASSWORD: APP_PASSWORD });
  check("it runs a second time without complaint (exit 0)", boot2.status === 0 && /✓ ready/.test(boot2.out), boot2.out);

  console.log("\n6. What a deployment needs to be true afterwards");
  const pushed = new Set((await admin.unsafe(COLUMNS)).map((r) => r.c));
  const built = (await db.unsafe(COLUMNS)).map((r) => r.c);
  const taskCols = (c) => /^(project_workflow_versions|task_workflow_instances|task_workflow_transition_events)\./.test(c);
  const extra = built.filter((c) => !pushed.has(c) && !taskCols(c));
  const missing = [...pushed].filter((c) => !built.includes(c) && !taskCols(c));
  check("every column is the one schema.ts gives (as CI's own pushed database has it): nothing missing, nothing extra", extra.length === 0 && missing.length === 0, { extra: extra.slice(0, 8), missing: missing.slice(0, 8) });
  const [role] = await db`select rolbypassrls, rolsuper from pg_roles where rolname = 'app_rw'`;
  check("app_rw cannot bypass row-level security and is not a superuser", role?.rolbypassrls === false && role.rolsuper === false, role);
  const closed = await db`select tablename, qual from pg_policies where schemaname = 'public' and policyname = 'org_isolation'`;
  const open = closed.filter((p) => /IS NULL|= ''/i.test(p.qual));
  check(`org_isolation FAILS CLOSED on every scoped table (${closed.length}): no "unset means everything" clause`, closed.length > 40 && open.length === 0, open.map((p) => p.tablename));
  const [strict] = await db`select qual from pg_policies where schemaname = 'public' and tablename = 'connector_secrets'`;
  check("connector_secrets keeps its strict policy", /IS NOT NULL/i.test(strict?.qual ?? ""), strict);
  const ownerPolicies = (await db`select policyname from pg_policies where schemaname = 'public' and policyname in ('chat_queue_owner', 'push_subscriptions_owner')`).length;
  check("the owner-only policies are in place", ownerPolicies === 2, ownerPolicies);

  // As the app connects.
  await db`insert into orgs (org_id, name, status) values ('nd-a', 'A', 'active'), ('nd-b', 'B', 'active')`;
  await db`insert into customers (customer_id, org_id, customer_name) values ('acme', 'nd-a', 'Acme A'), ('acme', 'nd-b', 'Acme B'), ('only-b', 'nd-b', 'Only B')`;
  app = postgres(appUrl, { ssl: false, prepare: false, max: 1, onnotice: () => {} });
  const [me] = await app`select current_user as u`;
  check("the app's url connects, as app_rw", me.u === "app_rw", me);
  check("a read that names no workspace sees NO rows", (await app`select customer_id from customers`).length === 0);
  const inA = await app.begin(async (tx) => {
    await tx`select set_config('app.org_id', 'nd-a', true)`;
    return tx`select org_id, customer_name from customers order by 1, 2`;
  });
  check("inside workspace A's scope it sees A's rows and only A's", inA.length === 1 && inA[0].org_id === "nd-a" && inA[0].customer_name === "Acme A", inA);
  let planted = null;
  try {
    await app.begin(async (tx) => {
      await tx`select set_config('app.org_id', 'nd-a', true)`;
      await tx`insert into customers (customer_id, org_id, customer_name) values ('planted', 'nd-b', 'Planted')`;
    });
  } catch (error) {
    planted = error;
  }
  check("…and cannot write a row into workspace B from there", /row-level security/i.test(String(planted?.message)), String(planted?.message));
  let ddl = null;
  try {
    await app`create table app_rw_must_not_create (id int)`;
  } catch (error) {
    ddl = error;
  }
  check("app_rw cannot change the schema", ddl !== null, "create table succeeded");
  const tasksAsApp = await app.begin(async (tx) => {
    await tx`select set_config('app.org_id', 'nd-a', true)`;
    return tx`select count(*)::int as n from task_workflow_instances`;
  });
  check("the task-workflow tables are readable by the app inside a workspace", tasksAsApp[0].n === 0, tasksAsApp);
  const lateTable = `late_${process.pid}`;
  await db.unsafe(`create table ${lateTable} (id int)`);
  check("a table created later is granted to the app too (default privileges)", (await app.unsafe(`select count(*)::int as n from ${lateTable}`))[0].n === 0);
} finally {
  if (app) await app.end({ timeout: 5 }).catch(() => {});
  if (db) await db.end({ timeout: 5 }).catch(() => {});
  // Default privileges granted to app_rw in the scratch database go with it; the role itself stays (it is shared).
  await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`).catch(() => {});
  await admin.end({ timeout: 5 }).catch(() => {});
  rmSync(cwd, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\ntest-new-database-db: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\ntest-new-database-db: all ${passed} checks passed`);

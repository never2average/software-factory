#!/usr/bin/env node
/**
 * drizzle/0028_neutral_owner_columns.sql ON A DATABASE SHAPED LIKE PRODUCTION, WITH DATA (mold_v1-103, PR 4).
 *
 * customers.account_owner is added beside customers.fde_owner, and solutions.solution_owner beside
 * solutions.solution_fde_owner; the values are copied and a trigger keeps each pair equal whichever side is written,
 * because writers outside this repository (the software factory's workspace seeding) name the original columns in raw
 * SQL. Proven here:
 *
 *   A. THE LIVE SHAPE: pushed from the schema before #84 (scripts/fixtures/schema-419b38d.ts), bootstrapped (app_rw,
 *      row-level security), seeded like production (two workspaces, 60 companies, an owner on most, none on some,
 *      a solution each), then the journal up to 0027 as every live database took it. Before 0028 the drift plan
 *      against schema.ts names the new columns (so an empty plan after it means something). Then 0028, in one
 *      transaction as migrate-production.mjs runs it:
 *        - every account_owner equals its fde_owner, every solution_owner its solution_fde_owner, and no row or value
 *          that was there changed; the neutral column's index is there and the original one still is;
 *        - the drift dry run (`drizzle-kit push --strict --verbose`, split as provision.py splits it) plans NOTHING:
 *          no DROP COLUMN, no DROP INDEX, no truncate, nothing to apply;
 *        - 0028 again changes nothing; the journal entries after it (0029) are then applied, as on every live
 *          database, before the app's own paths run (the app reads every column schema.ts declares);
 *        - a write under either name is read under the other: raw SQL INSERT and UPDATE of fde_owner (as the
 *          factory writes it), of account_owner, of both solution columns, a NULL clearing both, and the app's own
 *          write paths (upsert_customer, reassign owner) as app_rw, read back through the app's reader;
 *        - row-level security is still FAIL-CLOSED on both tables (the policies flipped to the production shape):
 *          no workspace sees nothing, a workspace sees only its own rows, a write into another workspace is refused,
 *          an update aimed at another workspace's row touches nothing, and 0028 changed no policy or RLS flag.
 *   B. AN EMPTY DATABASE (the only place the chain runs `drizzle-kit push --force`): push from the new schema.ts, the
 *      journal after the 0013 baseline (0028 among it), the bootstrap: the trigger is there, a write under either name
 *      is read under the other, and the plan holds nothing on the two tables.
 *
 * Needs ADMIN_URL (a role that may CREATE DATABASE). Scratch databases carry this process's pid and are dropped in a
 * finally block.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test npm run test:owner-columns-migration-db
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { ROOT, driftPlan, kit } from "./lib/drift-plan.mjs";

// eve's `.js` -> `.ts` specifiers, so the app's own write path can be imported as the agent imports it.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(s, c, n) {
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          throw e;
        }
      }`),
  pathToFileURL(ROOT + "/").href,
);

const adminUrl = process.env.ADMIN_URL;
if (!adminUrl) {
  console.log("test-owner-columns-migration-db: SKIPPED — needs ADMIN_URL (a role that may create a database).");
  process.exit(0);
}
const LIVE_SCHEMA = "scripts/fixtures/schema-419b38d.ts";
const TAG = "0028_neutral_owner_columns";
const TABLES = ["customers", "solutions"];
const NEW_COLUMNS = ["account_owner", "solution_owner"];
const W1 = "org-own-one";
const W2 = "org-own-two";
const APP_PASSWORD = process.env.APP_RW_PASSWORD || "app_rw_test_password";

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 900)}`}`); }
};

const local = /localhost|127\.0\.0\.1/.test(adminUrl);
const ssl = local ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
const urlOf = (name, user) => {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  if (user) { u.username = user; u.password = APP_PASSWORD; }
  return u.toString();
};
const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
const entry = (tag) => journal.entries.find((e) => e.tag === tag);
const statementsOf = (tag) => readFileSync(join(ROOT, `drizzle/${tag}.sql`), "utf8").split("--> statement-breakpoint").map((v) => v.trim()).filter(Boolean);
/** Journal entries in (from, to], each in one transaction as migrate-production.mjs applies them. */
const applyRange = async (db, fromIdx, toIdx) => {
  for (const e of journal.entries.filter((x) => x.idx > fromIdx && x.idx <= toIdx)) await db.begin(async (tx) => { for (const s of statementsOf(e.tag)) await tx.unsafe(s); });
};

const scratch = [];
async function freshDb(label) {
  const name = `ownmig_${label}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.unsafe(`create database "${name}"`);
  scratch.push(name);
  return { name, url: urlOf(name), db: postgres(urlOf(name), { ssl, prepare: false, max: 1, onnotice: () => {} }) };
}
const bootstrap = (url) => spawnSync(process.execPath, [join(ROOT, "scripts/bootstrap-test-db.mjs")], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });

/** Two workspaces, 60 companies: an owner on 50, none on 10 (an unassigned account); one solution each. */
async function seed(db) {
  await db`insert into orgs (org_id, name, status, created_at) values (${W1}, 'One', 'active', now() - interval '1 year'), (${W2}, 'Two', 'active', now())`;
  for (let i = 0; i < 60; i++) {
    const org = i < 30 ? W1 : W2;
    const id = `co-${String(i + 1).padStart(3, "0")}`;
    const owner = i % 6 === 5 ? null : `owner-${i % 4}@own.test`;
    await db`insert into customers (org_id, customer_id, customer_name, tier, fde_owner, ae_owner, custom) values (${org}, ${id}, ${`Company ${id}`}, 'Growth', ${owner}, 'ae@own.test', ${db.json({ note: `n-${id}` })})`;
    await db`insert into solutions (org_id, customer_id, solution_id, use_case, modules_enabled, solution_status, solution_fde_owner) values (${org}, ${id}, 'SOL-1', 'Research Copilot', '[]', 'Live', ${owner ?? "fallback@own.test"})`;
    await db`insert into deployments (org_id, customer_id, deployment_id, environment, region, deployed_version, release_status, health_status) values (${org}, ${id}, 'DEP-prod', 'prod', 'ap-south-1', ${`v-${id}`}, 'deployed', 'healthy')`;
  }
}

/** Every row of the two tables (and deployments), hashed by its values without the new columns. */
const fingerprint = async (db, { withNew = false } = {}) => {
  const out = {};
  for (const t of [...TABLES, "deployments"]) {
    const row = withNew ? "to_jsonb(x)" : `(to_jsonb(x) - ${NEW_COLUMNS.map((c) => `'${c}'`).join(" - ")})`;
    out[t] = (await db.unsafe(`select count(*)::int as n, md5(coalesce(string_agg(${row}::text, '|' order by ${row}::text), '')) as h from ${t} x`))[0];
  }
  return JSON.stringify(out);
};
const columns = async (db) => (await db`select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = any(${TABLES}) order by 1, 2`).map((r) => `${r.table_name}.${r.column_name} ${r.data_type} ${r.is_nullable}`);
const indexes = async (db) => (await db`select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = any(${TABLES}) order by indexname`).map((r) => `${r.indexname}: ${r.indexdef}`);
/** Every RLS flag and policy on the two tables, as the database has them. */
const security = async (db) => JSON.stringify({
  flags: await db`select relname, relrowsecurity, relforcerowsecurity from pg_class where relname = any(${TABLES}) and relkind = 'r' order by relname`,
  policies: await db`select tablename, policyname, permissive, roles::text, cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = any(${TABLES}) order by 1, 2`,
});
const mismatched = async (db) => ({
  customers: (await db`select org_id, customer_id, fde_owner, account_owner from customers where account_owner is distinct from fde_owner`),
  solutions: (await db`select org_id, customer_id, solution_id, solution_fde_owner, solution_owner from solutions where solution_owner is distinct from solution_fde_owner`),
});
const pair = async (db, org, id) => (await db`select fde_owner, account_owner from customers where org_id = ${org} and customer_id = ${id}`)[0];
const solPair = async (db, org, id, sid = "SOL-1") => (await db`select solution_fde_owner, solution_owner from solutions where org_id = ${org} and customer_id = ${id} and solution_id = ${sid}`)[0];
const both = (row, v) => row?.fde_owner === v && row?.account_owner === v;
const solBoth = (row, v) => row?.solution_fde_owner === v && row?.solution_owner === v;
/**
 * What a LATER journal entry adds: not this migration's to do. 0029's customers.secondary_owner
 * (scripts/test-secondary-owner-migration-db.mjs proves it), 0030's cycle_member_goals table with its index
 * (scripts/test-work-periods-db.mjs proves that one) and 0032's apps.starter_key with its index
 * (scripts/test-starter-apps-db.mjs runs on it; scripts/test-migrations-db.mjs builds it from the journal).
 */
const laterEntry = (x) => /ADD COLUMN "secondary_owner"/.test(x) || /"cycle_member_goals(_member_uidx)?"/.test(x) || /"specialist_handbacks(_org_idx)?"/.test(x) || /"apps" ADD COLUMN "starter_key"|"apps_org_starter_key_uq"/.test(x) || /ADD COLUMN "period_length_days"/.test(x); // …and 0031's table (scripts/test-specialist-handback-db.mjs), 0032's column, 0033's column (scripts/test-work-periods-db.mjs)
const touchesOurs = (x) => TABLES.some((t) => x.includes(`"${t}"`)) || NEW_COLUMNS.some((c) => x.includes(c)) || /owner_idx/.test(x);

/** The deploy's drift step after the journal: nothing to apply, nothing refused, and no DROP COLUMN / DROP INDEX at all. */
function checkPlan(url, label, { oursOnly = false } = {}) {
  const plan = driftPlan(url);
  if (plan.error) { check(`${label}: the drift dry run produced a plan`, false, plan); return; }
  const all = [...plan.apply, ...plan.aside, ...plan.refused];
  if (oursOnly) {
    const other = plan.apply.filter((x) => !touchesOurs(x));
    check(`${label}: the drift dry run plans nothing on customers / solutions (${other.length} older unrelated statement(s): ${other.map((x) => x.split("\n")[0].slice(0, 70)).join(" / ") || "none"})`, plan.apply.filter(touchesOurs).length === 0, plan.apply.filter(touchesOurs));
  } else {
    const ours = plan.apply.filter((x) => !laterEntry(x));
    check(`${label}: the drift dry run plans NOTHING to apply (0028 did the whole change; what later entries add is theirs)`, ours.length === 0, ours);
  }
  check(`${label}: …and nothing the deploy would refuse (no data loss, no index drop)`, plan.refused.length === 0, plan.refused);
  check(`${label}: …and no DROP COLUMN, no truncate, and no DROP INDEX but the one out-of-band index anywhere in the plan`, all.every((x) => !/DROP\s+COLUMN|^\s*truncate/i.test(x)) && all.filter((x) => /DROP\s+INDEX/i.test(x)).every((x) => /workflow_definitions_one_default_idx/.test(x)), all.filter((x) => /DROP|truncate/i.test(x) && !/POLICY/i.test(x)));
  check(`${label}: …and what it sets aside (${plan.aside.length} statements) is only policy / row-level-security noise`, plan.aside.every((x) => !/COLUMN|INDEX|CONSTRAINT|TRIGGER/i.test(x)), plan.aside.filter((x) => /COLUMN|INDEX|CONSTRAINT|TRIGGER/i.test(x)));
}

/** A write under either name is read under the other, in raw SQL (the factory writes fde_owner this way). */
async function checkPairs(db, label) {
  const org = W1;
  // customers, INSERT naming only the original column (the factory's surface apply / workspace seeding).
  await db`insert into customers (org_id, customer_id, customer_name, fde_owner) values (${org}, 'raw-old', 'Raw old', 'raw-old@own.test')`;
  check(`${label}: INSERT naming only fde_owner -> account_owner carries it`, both(await pair(db, org, "raw-old"), "raw-old@own.test"), await pair(db, org, "raw-old"));
  // customers, INSERT naming only the neutral column.
  await db`insert into customers (org_id, customer_id, customer_name, account_owner) values (${org}, 'raw-new', 'Raw new', 'raw-new@own.test')`;
  check(`${label}: INSERT naming only account_owner -> fde_owner carries it`, both(await pair(db, org, "raw-new"), "raw-new@own.test"), await pair(db, org, "raw-new"));
  // customers, INSERT … ON CONFLICT DO UPDATE of fde_owner (the factory's upsert shape).
  await db`insert into customers (org_id, customer_id, customer_name, fde_owner) values (${org}, 'raw-new', 'Raw new', 'upsert@own.test') on conflict (org_id, customer_id) do update set fde_owner = excluded.fde_owner`;
  check(`${label}: an upsert of fde_owner onto an existing row -> account_owner follows`, both(await pair(db, org, "raw-new"), "upsert@own.test"), await pair(db, org, "raw-new"));
  // customers, UPDATE of each side.
  await db`update customers set fde_owner = 'moved-old@own.test' where org_id = ${org} and customer_id = 'co-001'`;
  check(`${label}: UPDATE of fde_owner -> account_owner follows`, both(await pair(db, org, "co-001"), "moved-old@own.test"), await pair(db, org, "co-001"));
  await db`update customers set account_owner = 'moved-new@own.test' where org_id = ${org} and customer_id = 'co-001'`;
  check(`${label}: UPDATE of account_owner -> fde_owner follows`, both(await pair(db, org, "co-001"), "moved-new@own.test"), await pair(db, org, "co-001"));
  await db`update customers set fde_owner = null where org_id = ${org} and customer_id = 'co-001'`;
  check(`${label}: UPDATE of fde_owner to NULL clears both (an unassigned account)`, both(await pair(db, org, "co-001"), null), await pair(db, org, "co-001"));
  await db`update customers set account_owner = 'back@own.test', fde_owner = 'back@own.test' where org_id = ${org} and customer_id = 'co-001'`;
  check(`${label}: UPDATE of both to one value keeps both`, both(await pair(db, org, "co-001"), "back@own.test"), await pair(db, org, "co-001"));
  await db`update customers set status = 'At Risk' where org_id = ${org} and customer_id = 'co-001'`;
  check(`${label}: UPDATE of another column leaves both alone`, both(await pair(db, org, "co-001"), "back@own.test"), await pair(db, org, "co-001"));
  // solutions.
  await db`insert into solutions (org_id, customer_id, solution_id, use_case, modules_enabled, solution_status, solution_fde_owner) values (${org}, 'raw-old', 'SOL-1', 'Other', '[]', 'Live', 'sol-old@own.test')`;
  check(`${label}: solutions INSERT naming only solution_fde_owner -> solution_owner carries it`, solBoth(await solPair(db, org, "raw-old"), "sol-old@own.test"), await solPair(db, org, "raw-old"));
  await db`insert into solutions (org_id, customer_id, solution_id, use_case, modules_enabled, solution_status, solution_owner) values (${org}, 'raw-new', 'SOL-1', 'Other', '[]', 'Live', 'sol-new@own.test')`;
  check(`${label}: solutions INSERT naming only solution_owner -> solution_fde_owner (NOT NULL) carries it`, solBoth(await solPair(db, org, "raw-new"), "sol-new@own.test"), await solPair(db, org, "raw-new"));
  await db`update solutions set solution_fde_owner = 'sol-moved@own.test' where org_id = ${org} and customer_id = 'co-002'`;
  check(`${label}: solutions UPDATE of solution_fde_owner -> solution_owner follows`, solBoth(await solPair(db, org, "co-002"), "sol-moved@own.test"), await solPair(db, org, "co-002"));
  await db`update solutions set solution_owner = 'sol-moved2@own.test' where org_id = ${org} and customer_id = 'co-002'`;
  check(`${label}: solutions UPDATE of solution_owner -> solution_fde_owner follows`, solBoth(await solPair(db, org, "co-002"), "sol-moved2@own.test"), await solPair(db, org, "co-002"));
  const refused = await db`insert into solutions (org_id, customer_id, solution_id, use_case, modules_enabled, solution_status) values (${org}, 'raw-new', 'SOL-none', 'Other', '[]', 'Live')`.then(() => "inserted", (e) => e.code);
  check(`${label}: a solution with no owner under either name is still refused (NOT NULL)`, refused === "23502", refused);
  const m = await mismatched(db);
  check(`${label}: afterwards no row anywhere holds two different owners`, m.customers.length === 0 && m.solutions.length === 0, m);
}

/** Flip org_isolation on the two tables to the production FAIL-CLOSED shape (as .migrate-rls-fail-closed.mjs). */
async function failClosed(db) {
  const closed = `(org_id = current_setting('app.org_id', true))`;
  for (const t of TABLES) await db.unsafe(`ALTER POLICY org_isolation ON "${t}" USING ${closed} WITH CHECK ${closed}`);
}

/** As app_rw under the fail-closed policies: nothing without a workspace, only your own with one, no write across. */
async function checkRls(appUrl, label) {
  const app = postgres(appUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
  try {
    const [who] = await app`select current_user as u, (select rolbypassrls from pg_roles where rolname = current_user) as bypass`;
    check(`${label}: connected as app_rw, which cannot bypass row-level security`, who.u === "app_rw" && who.bypass === false, who);
    const unscoped = await app.begin(async (tx) => ({
      customers: (await tx`select count(*)::int as n from customers`)[0].n,
      solutions: (await tx`select count(*)::int as n from solutions`)[0].n,
      owners: (await tx`select count(*)::int as n from customers where account_owner is not null or fde_owner is not null`)[0].n,
    }));
    check(`${label}: with no workspace set, customers and solutions read NOTHING (fail-closed), under either owner name`, unscoped.customers === 0 && unscoped.solutions === 0 && unscoped.owners === 0, unscoped);
    const scoped = await app.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${W1}, true)`;
      return {
        customers: await tx`select distinct org_id from customers`,
        solutions: await tx`select distinct org_id from solutions`,
      };
    });
    check(`${label}: with W1 set, both tables return only W1's rows`, scoped.customers.length === 1 && scoped.customers[0].org_id === W1 && scoped.solutions.length === 1 && scoped.solutions[0].org_id === W1, scoped);
    const crossInsert = await app.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${W1}, true)`;
      return tx`insert into customers (org_id, customer_id, customer_name, account_owner) values (${W2}, 'planted', 'Planted', 'x@own.test')`;
    }).then(() => "inserted", (e) => e.code);
    check(`${label}: W1 inserting a customer stamped W2 is refused by the policy`, crossInsert === "42501", crossInsert);
    const crossSol = await app.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${W1}, true)`;
      return tx`insert into solutions (org_id, customer_id, solution_id, use_case, modules_enabled, solution_status, solution_owner) values (${W2}, 'co-040', 'SOL-x', 'Other', '[]', 'Live', 'x@own.test')`;
    }).then(() => "inserted", (e) => e.code);
    check(`${label}: W1 inserting a solution stamped W2 is refused by the policy`, crossSol === "42501", crossSol);
    const w2Before = (await adminDb`select fde_owner, account_owner from customers where org_id = ${W2} and customer_id = 'co-040'`)[0];
    const hit = await app.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${W1}, true)`;
      const a = await tx`update customers set fde_owner = 'stolen@own.test' where org_id = ${W2} and customer_id = 'co-040' returning 1`;
      const b = await tx`update customers set account_owner = 'stolen@own.test' where customer_id = 'co-040' returning 1`;
      const c = await tx`update solutions set solution_fde_owner = 'stolen@own.test' where customer_id = 'co-040' returning 1`;
      return a.length + b.length + c.length;
    });
    const w2After = (await adminDb`select fde_owner, account_owner from customers where org_id = ${W2} and customer_id = 'co-040'`)[0];
    const w2Sol = (await adminDb`select solution_fde_owner, solution_owner from solutions where org_id = ${W2} and customer_id = 'co-040'`)[0];
    check(`${label}: W1 updating W2's owner under either name touches no row, and W2's owners are unchanged`, hit === 0 && JSON.stringify(w2Before) === JSON.stringify(w2After) && w2Sol.solution_owner !== "stolen@own.test", { hit, w2Before, w2After, w2Sol });
    // The trigger runs as the writer (no SECURITY DEFINER), inside its policy: W1's own row, under RLS, still pairs.
    await app.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${W1}, true)`;
      await tx`update customers set fde_owner = 'rls-write@own.test' where org_id = ${W1} and customer_id = 'co-003'`;
    });
    check(`${label}: app_rw in W1 writing fde_owner on its own row -> account_owner follows under RLS`, both(await pair(adminDb, W1, "co-003"), "rls-write@own.test"), await pair(adminDb, W1, "co-003"));
    const definer = await adminDb`select proname, prosecdef from pg_proc where proname in ('customers_owner_pair', 'solutions_owner_pair') order by 1`;
    check(`${label}: neither trigger function is SECURITY DEFINER (it cannot widen what the writer may touch)`, definer.length === 2 && definer.every((r) => r.prosecdef === false), definer);
  } finally {
    await app.end();
  }
}
let adminDb; // the scratch database the RLS check compares against, as an admin

/** The app's own write and read paths (agent/lib/system-of-record.ts), as app_rw under the fail-closed policies. */
async function checkAppPaths(appUrl, label) {
  process.env.DATABASE_URL = appUrl;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const dir = mkdtempSync(join(tmpdir(), "owner-cols-"));
  process.env.DATAROOM_DIR = join(dir, "dataroom");
  try {
    const sor = await import(pathToFileURL(join(ROOT, "agent/lib/system-of-record.ts")).href);
    const { closeDb } = await import(pathToFileURL(join(ROOT, "agent/lib/db/index.ts")).href);
    try {
      await sor.upsertCustomer({ id: "co-004", fdeOwner: "agent-write@own.test" }, W1);
      check(`${label}: upsert_customer's write of the owner lands in both columns`, both(await pair(adminDb, W1, "co-004"), "agent-write@own.test"), await pair(adminDb, W1, "co-004"));
      await adminDb`update customers set fde_owner = 'factory@own.test' where org_id = ${W1} and customer_id = 'co-004'`;
      const read = await sor.getCustomer("co-004", W1);
      check(`${label}: a raw write of fde_owner is what get_customer reads`, read?.fdeOwner === "factory@own.test", read?.fdeOwner);
      const listed = (await sor.listCustomers(W1)).find((c) => c.id === "co-004");
      check(`${label}: …and what list_customers reads`, listed?.fdeOwner === "factory@own.test", listed);
      await sor.upsertCustomer({ id: "co-004", solutions: [{ solutionId: "SOL-2", useCase: "Other", modulesEnabled: [], solutionStatus: "Live", solutionFdeOwner: "sol-agent@own.test" }] }, W1);
      check(`${label}: a new solution through upsert_customer carries its owner in both columns`, solBoth(await solPair(adminDb, W1, "co-004", "SOL-2"), "sol-agent@own.test"), await solPair(adminDb, W1, "co-004", "SOL-2"));
      await sor.upsertCustomer({ id: "co-004", solutions: [{ solutionId: "SOL-2", solutionFdeOwner: "sol-agent2@own.test" }] }, W1);
      check(`${label}: …and a patch of it moves both`, solBoth(await solPair(adminDb, W1, "co-004", "SOL-2"), "sol-agent2@own.test"), await solPair(adminDb, W1, "co-004", "SOL-2"));
      await adminDb`update solutions set solution_owner = 'sol-neutral@own.test' where org_id = ${W1} and customer_id = 'co-004' and solution_id = 'SOL-2'`;
      const sols = (await sor.getCustomer("co-004", W1))?.solutions ?? [];
      check(`${label}: a raw write of solution_owner is what get_customer reads for the solution`, sols.find((s) => s.solutionId === "SOL-2")?.solutionFdeOwner === "sol-neutral@own.test", sols);
      const moved = await sor.reassignOwner("co-004", "reassigned@own.test", "Re Assigned", W1);
      check(`${label}: reassigning the owner reads the previous one and writes both columns`, moved.previousOwner === "factory@own.test" && both(await pair(adminDb, W1, "co-004"), "reassigned@own.test"), { moved, now: await pair(adminDb, W1, "co-004") });
      const other = await sor.getCustomer("co-040", W1);
      check(`${label}: W1's reader never returns W2's company`, other === null, other);
    } finally {
      await closeDb?.();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  check(`the journal carries ${TAG}`, !!entry(TAG) && existsSync(join(ROOT, `drizzle/${TAG}.sql`)), journal.entries.at(-1)?.tag);
  if (!entry(TAG)) throw new Error(`${TAG} is not in drizzle/meta/_journal.json`);
  const IDX = entry(TAG).idx;

  console.log(`\nA. The live shape (pushed from ${LIVE_SCHEMA}, bootstrapped, seeded, then the journal to 0027) -> 0028 -> the drift dry run`);
  {
    const { db, url, name } = await freshDb("a");
    adminDb = db;
    const p = kit(["push", "--force", "--dialect=postgresql", `--schema=${LIVE_SCHEMA}`, `--url=${url}`], url);
    if (p.status !== 0 || !/Changes applied/.test(p.out)) throw new Error(`push of ${LIVE_SCHEMA} failed:\n${p.out.slice(-800)}`);
    const b = bootstrap(url);
    if (b.status !== 0) throw new Error(`bootstrap failed:\n${(b.stdout + b.stderr).slice(-800)}`);
    await seed(db);
    await applyRange(db, entry("0024_company_key_per_workspace").idx - 1, IDX - 1); // 0024 to 0027, as the live databases took them
    const cols0 = await columns(db);
    check("before 0028 neither neutral column exists", NEW_COLUMNS.every((c) => !cols0.some((x) => x.includes(`.${c} `))), cols0);
    const planBefore = driftPlan(url);
    const named = (planBefore.apply ?? []).join("\n");
    check(
      "…and the drift plan against schema.ts names them and the new index (so an empty plan after 0028 means something)",
      !planBefore.error && /"account_owner"/.test(named) && /"solution_owner"/.test(named) && /customers_account_owner_idx/.test(named),
      planBefore.error ? planBefore : planBefore.apply,
    );
    const f0 = await fingerprint(db);
    const sec0 = await security(db);
    const idx0 = await indexes(db);
    const ownersBefore = await db`select org_id, customer_id, fde_owner from customers order by 1, 2`;
    await applyRange(db, IDX - 1, IDX);
    const cols1 = await columns(db);
    check("0028 adds customers.account_owner and solutions.solution_owner (text, nullable) and no other column", JSON.stringify(cols1.filter((x) => !cols0.includes(x))) === JSON.stringify(["customers.account_owner text YES", "solutions.solution_owner text YES"]) && cols0.every((x) => cols1.includes(x)), { added: cols1.filter((x) => !cols0.includes(x)), lost: cols0.filter((x) => !cols1.includes(x)) });
    const m = await mismatched(db);
    check("every account_owner equals its fde_owner (NULL where there is none) and every solution_owner its solution_fde_owner", m.customers.length === 0 && m.solutions.length === 0, m);
    const unassigned = (await db`select count(*)::int as n from customers where fde_owner is null and account_owner is null`)[0].n;
    check("…the 10 unassigned accounts stay unassigned under both names", unassigned === 10, unassigned);
    check("…and no row or value that was there changed (60 companies, 60 solutions, 60 deployments)", (await fingerprint(db)) === f0, { before: f0, after: await fingerprint(db) });
    const ownersAfter = await db`select org_id, customer_id, fde_owner from customers order by 1, 2`;
    check("…fde_owner itself is exactly as it was on every row", JSON.stringify(ownersBefore) === JSON.stringify(ownersAfter));
    const idx1 = await indexes(db);
    check("customers_account_owner_idx is added, customers_fde_owner_idx is kept, and no other index changed", idx1.some((x) => x.startsWith("customers_account_owner_idx:") && /\(account_owner\)/.test(x)) && idx0.every((x) => idx1.includes(x)) && idx1.length === idx0.length + 1, { idx0, idx1 });
    check("row-level security on customers and solutions is exactly as before 0028 (flags and every policy)", (await security(db)) === sec0, { before: sec0, after: await security(db) });
    checkPlan(url, "after 0028");
    const f1 = await fingerprint(db, { withNew: true });
    await applyRange(db, IDX - 1, IDX);
    check("0028 again: nothing changes", (await fingerprint(db, { withNew: true })) === f1 && JSON.stringify(await indexes(db)) === JSON.stringify(idx1));
    await checkPairs(db, "A");
    // The app only ever runs against the WHOLE journal: its reads name every column schema.ts declares, the ones a
    // later entry adds included (0029's customers.secondary_owner). So the rest of the journal goes on before the
    // app's own paths run, and the pairs 0028 made must hold through it.
    await applyRange(db, IDX, Number.MAX_SAFE_INTEGER);
    const afterLater = await mismatched(db);
    check("the journal entries after 0028 leave every owner pair equal", afterLater.customers.length === 0 && afterLater.solutions.length === 0, afterLater);
    await failClosed(db);
    await checkRls(urlOf(name, "app_rw"), "A (fail-closed)");
    await checkAppPaths(urlOf(name, "app_rw"), "A (app paths, fail-closed)");
    checkPlan(url, "after the writes");
    await db.end();
  }

  console.log("\nB. An empty database: push --force from the new schema.ts, the journal after the 0013 baseline, the bootstrap");
  {
    const { db, url } = await freshDb("b");
    const p = kit(["push", "--force", "--verbose"], url);
    check("push --force from the new schema.ts builds an empty database with both owner columns", p.status === 0 && /Changes applied/.test(p.out) && (await columns(db)).some((x) => x.startsWith("customers.account_owner ")), p.out.slice(-600));
    await applyRange(db, 13, Number.MAX_SAFE_INTEGER);
    const b = bootstrap(url);
    check("…the journal after it (0014 to 0028) and the bootstrap apply", b.status === 0, (b.stdout + b.stderr).slice(-400));
    const triggers = await db`select tgname from pg_trigger where not tgisinternal and tgrelid in ('public.customers'::regclass, 'public.solutions'::regclass) order by 1`;
    check("…and the two owner triggers are there (beside the one 0029 adds for the second owner)", JSON.stringify(triggers.map((r) => r.tgname)) === JSON.stringify(["customers_owner_pair", "customers_secondary_owner_pair", "solutions_owner_pair"]), triggers);
    await seed(db);
    await checkPairs(db, "B");
    checkPlan(url, "empty database, pushed", { oursOnly: true });
    await db.end();
  }
} catch (error) {
  failures.push("the test itself");
  console.error(`\n✗ the test itself failed: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  for (const name of scratch) await admin.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {});
  await admin.end();
}

if (failures.length) {
  console.error(`\ntest-owner-columns-migration-db: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\ntest-owner-columns-migration-db: all ${passed} checks passed`);

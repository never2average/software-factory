#!/usr/bin/env node
/**
 * drizzle/0029_neutral_secondary_owner.sql ON A DATABASE SHAPED LIKE PRODUCTION, WITH DATA (mold_v1-103, PR 7c).
 *
 * customers.secondary_owner is added beside customers.ae_owner (a column named for one line of work's role); the
 * values are copied and a trigger keeps the pair equal whichever side is written, exactly as 0028 did for the owner
 * (scripts/test-owner-columns-migration-db.mjs). Proven here:
 *
 *   A. THE LIVE SHAPE: pushed from the schema before #84 (scripts/fixtures/schema-419b38d.ts), bootstrapped (app_rw,
 *      row-level security), seeded like production (two workspaces, 60 companies, a second owner on 40, none on 20,
 *      an owner on 50), then the journal up to 0028 as every live database took it. Before 0029 the drift plan
 *      against schema.ts names the new column (so an empty plan after it means something). Then 0029, in one
 *      transaction as migrate-production.mjs runs it:
 *        - every secondary_owner equals its ae_owner (NULL where there is none), no row or value that was there
 *          changed, no index was added or lost, and 0028's owner pair and its trigger are exactly as they were;
 *        - the drift dry run (`drizzle-kit push --strict --verbose`, split as provision.py splits it) plans NOTHING:
 *          no DROP COLUMN, no DROP INDEX, no truncate, nothing to apply;
 *        - 0029 again changes nothing;
 *        - a write under either name is read under the other, for BOTH pairs: raw SQL INSERT, upsert and UPDATE of
 *          ae_owner, of secondary_owner, a NULL clearing both, one statement writing both pairs at once, and the
 *          app's own write and read paths (upsert_customer, get_customer) as app_rw;
 *        - with the trigger switched off (a database built by `drizzle-kit push` alone has none) the app still
 *          writes both columns and reads the neutral one first, the original as the fallback;
 *        - row-level security is still FAIL-CLOSED on customers (the policy flipped to the production shape): no
 *          workspace sees nothing, a workspace sees only its own rows, a write into another workspace is refused, an
 *          update aimed at another workspace's row touches nothing, and 0029 changed no policy or RLS flag.
 *   B. AN EMPTY DATABASE (the only place the chain runs `drizzle-kit push --force`): push from the new schema.ts, the
 *      journal after the 0013 baseline (0028 and 0029 among it), the bootstrap: both triggers are there, a write
 *      under either name is read under the other, and the plan holds nothing on customers.
 *
 * Needs ADMIN_URL (a role that may CREATE DATABASE). Scratch databases carry this process's pid and are dropped in a
 * finally block.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test npm run test:secondary-owner-migration-db
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
  console.log("test-secondary-owner-migration-db: SKIPPED — needs ADMIN_URL (a role that may create a database).");
  process.exit(0);
}
const LIVE_SCHEMA = "scripts/fixtures/schema-419b38d.ts";
const TAG = "0029_neutral_secondary_owner";
const PREVIOUS = "0028_neutral_owner_columns";
const NEW_COLUMN = "secondary_owner";
const TRIGGER = "customers_secondary_owner_pair";
const W1 = "org-sec-one";
const W2 = "org-sec-two";
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
  const name = `secmig_${label}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.unsafe(`create database "${name}"`);
  scratch.push(name);
  return { name, url: urlOf(name), db: postgres(urlOf(name), { ssl, prepare: false, max: 1, onnotice: () => {} }) };
}
const bootstrap = (url) => spawnSync(process.execPath, [join(ROOT, "scripts/bootstrap-test-db.mjs")], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });

/** Two workspaces, 60 companies: a second owner on 40, none on 20; an owner on 50, none on 10. */
async function seed(db) {
  await db`insert into orgs (org_id, name, status, created_at) values (${W1}, 'One', 'active', now() - interval '1 year'), (${W2}, 'Two', 'active', now())`;
  for (let i = 0; i < 60; i++) {
    const org = i < 30 ? W1 : W2;
    const id = `co-${String(i + 1).padStart(3, "0")}`;
    const owner = i % 6 === 5 ? null : `owner-${i % 4}@sec.test`;
    const second = i % 3 === 2 ? null : `second-${i % 5}@sec.test`;
    await db`insert into customers (org_id, customer_id, customer_name, tier, fde_owner, ae_owner, arr, custom) values (${org}, ${id}, ${`Company ${id}`}, 'Growth', ${owner}, ${second}, ${1000 + i}, ${db.json({ note: `n-${id}` })})`;
    await db`insert into deployments (org_id, customer_id, deployment_id, environment, region, deployed_version, release_status, health_status) values (${org}, ${id}, 'DEP-prod', 'prod', 'ap-south-1', ${`v-${id}`}, 'deployed', 'healthy')`;
  }
}

/** Every row of customers (and deployments), hashed by its values without the new column. */
const fingerprint = async (db, { withNew = false } = {}) => {
  const out = {};
  for (const t of ["customers", "deployments"]) {
    const row = withNew ? "to_jsonb(x)" : `(to_jsonb(x) - '${NEW_COLUMN}')`;
    out[t] = (await db.unsafe(`select count(*)::int as n, md5(coalesce(string_agg(${row}::text, '|' order by ${row}::text), '')) as h from ${t} x`))[0];
  }
  return JSON.stringify(out);
};
const columns = async (db) => (await db`select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'customers' order by 1, 2`).map((r) => `${r.table_name}.${r.column_name} ${r.data_type} ${r.is_nullable}`);
const indexes = async (db) => (await db`select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'customers' order by indexname`).map((r) => `${r.indexname}: ${r.indexdef}`);
/** Every RLS flag and policy on customers, as the database has them. */
const security = async (db) => JSON.stringify({
  flags: await db`select relname, relrowsecurity, relforcerowsecurity from pg_class where relname = 'customers' and relkind = 'r'`,
  policies: await db`select tablename, policyname, permissive, roles::text, cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'customers' order by 1, 2`,
});
/** The triggers on customers and the source of the functions they run: 0028's must not move. */
const triggers = async (db) => db`
  select t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) as def, md5(p.prosrc) as body, p.prosecdef
  from pg_trigger t join pg_proc p on p.oid = t.tgfoid
  where not t.tgisinternal and t.tgrelid = 'public.customers'::regclass order by 1`;
const mismatched = async (db) => db`
  select org_id, customer_id, fde_owner, account_owner, ae_owner, secondary_owner from customers
  where secondary_owner is distinct from ae_owner or account_owner is distinct from fde_owner`;
const pair = async (db, org, id) => (await db`select ae_owner, secondary_owner from customers where org_id = ${org} and customer_id = ${id}`)[0];
const ownerPair = async (db, org, id) => (await db`select fde_owner, account_owner from customers where org_id = ${org} and customer_id = ${id}`)[0];
const both = (row, v) => row?.ae_owner === v && row?.secondary_owner === v;
const ownerBoth = (row, v) => row?.fde_owner === v && row?.account_owner === v;
const touchesOurs = (x) => x.includes('"customers"') || x.includes(NEW_COLUMN);
/** What a LATER journal entry adds (0030's cycle_member_goals table and its index; scripts/test-work-periods-db.mjs proves it): not this migration's to do. */
const laterEntry = (x) => /"cycle_member_goals(_member_uidx)?"/.test(x) || /"specialist_handbacks(_org_idx)?"/.test(x); // …and 0031's table (scripts/test-specialist-handback-db.mjs)

/** The deploy's drift step after the journal: nothing to apply, nothing refused, and no DROP COLUMN / DROP INDEX at all. */
function checkPlan(url, label, { oursOnly = false } = {}) {
  const plan = driftPlan(url);
  if (plan.error) { check(`${label}: the drift dry run produced a plan`, false, plan); return; }
  const all = [...plan.apply, ...plan.aside, ...plan.refused];
  if (oursOnly) {
    const other = plan.apply.filter((x) => !touchesOurs(x));
    check(`${label}: the drift dry run plans nothing on customers (${other.length} older unrelated statement(s): ${other.map((x) => x.split("\n")[0].slice(0, 70)).join(" / ") || "none"})`, plan.apply.filter(touchesOurs).length === 0, plan.apply.filter(touchesOurs));
  } else {
    const ours = plan.apply.filter((x) => !laterEntry(x));
    check(`${label}: the drift dry run plans NOTHING to apply (0029 did the whole change; what 0030 adds is 0030's)`, ours.length === 0, ours);
  }
  check(`${label}: …and nothing the deploy would refuse (no data loss, no index drop)`, plan.refused.length === 0, plan.refused);
  check(`${label}: …and no DROP COLUMN, no truncate, and no DROP INDEX but the one out-of-band index anywhere in the plan`, all.every((x) => !/DROP\s+COLUMN|^\s*truncate/i.test(x)) && all.filter((x) => /DROP\s+INDEX/i.test(x)).every((x) => /workflow_definitions_one_default_idx/.test(x)), all.filter((x) => /DROP|truncate/i.test(x) && !/POLICY/i.test(x)));
  check(`${label}: …and what it sets aside (${plan.aside.length} statements) is only policy / row-level-security noise`, plan.aside.every((x) => !/COLUMN|INDEX|CONSTRAINT|TRIGGER/i.test(x)), plan.aside.filter((x) => /COLUMN|INDEX|CONSTRAINT|TRIGGER/i.test(x)));
}

/** A write under either name is read under the other, in raw SQL, for the second owner AND still for the owner. */
async function checkPairs(db, label) {
  const org = W1;
  // INSERT naming only the original column (what any writer outside this repository knows).
  await db`insert into customers (org_id, customer_id, customer_name, ae_owner) values (${org}, 'raw-old', 'Raw old', 'raw-old@sec.test')`;
  check(`${label}: INSERT naming only ae_owner -> secondary_owner carries it`, both(await pair(db, org, "raw-old"), "raw-old@sec.test"), await pair(db, org, "raw-old"));
  // INSERT naming only the neutral column.
  await db`insert into customers (org_id, customer_id, customer_name, secondary_owner) values (${org}, 'raw-new', 'Raw new', 'raw-new@sec.test')`;
  check(`${label}: INSERT naming only secondary_owner -> ae_owner carries it`, both(await pair(db, org, "raw-new"), "raw-new@sec.test"), await pair(db, org, "raw-new"));
  await db`insert into customers (org_id, customer_id, customer_name) values (${org}, 'raw-none', 'Raw none')`;
  check(`${label}: INSERT naming neither leaves both NULL`, both(await pair(db, org, "raw-none"), null), await pair(db, org, "raw-none"));
  await db`insert into customers (org_id, customer_id, customer_name, ae_owner, secondary_owner) values (${org}, 'raw-two', 'Raw two', 'old-side@sec.test', 'new-side@sec.test')`;
  check(`${label}: INSERT naming two different values -> the neutral side wins on both`, both(await pair(db, org, "raw-two"), "new-side@sec.test"), await pair(db, org, "raw-two"));
  // INSERT … ON CONFLICT DO UPDATE of the original column (an upsert written against the old name).
  await db`insert into customers (org_id, customer_id, customer_name, ae_owner) values (${org}, 'raw-new', 'Raw new', 'upsert@sec.test') on conflict (org_id, customer_id) do update set ae_owner = excluded.ae_owner`;
  check(`${label}: an upsert of ae_owner onto an existing row -> secondary_owner follows`, both(await pair(db, org, "raw-new"), "upsert@sec.test"), await pair(db, org, "raw-new"));
  // UPDATE of each side.
  await db`update customers set ae_owner = 'moved-old@sec.test' where org_id = ${org} and customer_id = 'co-001'`;
  check(`${label}: UPDATE of ae_owner -> secondary_owner follows`, both(await pair(db, org, "co-001"), "moved-old@sec.test"), await pair(db, org, "co-001"));
  await db`update customers set secondary_owner = 'moved-new@sec.test' where org_id = ${org} and customer_id = 'co-001'`;
  check(`${label}: UPDATE of secondary_owner -> ae_owner follows`, both(await pair(db, org, "co-001"), "moved-new@sec.test"), await pair(db, org, "co-001"));
  await db`update customers set ae_owner = null where org_id = ${org} and customer_id = 'co-001'`;
  check(`${label}: UPDATE of ae_owner to NULL clears both (no second owner)`, both(await pair(db, org, "co-001"), null), await pair(db, org, "co-001"));
  await db`update customers set secondary_owner = 'back@sec.test', ae_owner = 'back@sec.test' where org_id = ${org} and customer_id = 'co-001'`;
  check(`${label}: UPDATE of both to one value keeps both`, both(await pair(db, org, "co-001"), "back@sec.test"), await pair(db, org, "co-001"));
  await db`update customers set secondary_owner = null where org_id = ${org} and customer_id = 'co-001'`;
  check(`${label}: UPDATE of secondary_owner to NULL clears both`, both(await pair(db, org, "co-001"), null), await pair(db, org, "co-001"));
  await db`update customers set ae_owner = 'again@sec.test' where org_id = ${org} and customer_id = 'co-001'`;
  await db`update customers set status = 'At Risk' where org_id = ${org} and customer_id = 'co-001'`;
  check(`${label}: UPDATE of another column leaves both alone`, both(await pair(db, org, "co-001"), "again@sec.test"), await pair(db, org, "co-001"));
  // The two pairs are independent: 0028's owner pair still pairs, and a write of one never moves the other.
  const ownerBefore = await ownerPair(db, org, "co-002");
  await db`update customers set ae_owner = 'only-second@sec.test' where org_id = ${org} and customer_id = 'co-002'`;
  check(`${label}: a write of ae_owner leaves the owner pair (fde_owner / account_owner) as it was`, JSON.stringify(await ownerPair(db, org, "co-002")) === JSON.stringify(ownerBefore) && both(await pair(db, org, "co-002"), "only-second@sec.test"), { before: ownerBefore, after: await ownerPair(db, org, "co-002") });
  await db`update customers set fde_owner = 'only-owner@sec.test' where org_id = ${org} and customer_id = 'co-002'`;
  check(`${label}: a write of fde_owner still reaches account_owner (0028), and leaves the second owner as it was`, ownerBoth(await ownerPair(db, org, "co-002"), "only-owner@sec.test") && both(await pair(db, org, "co-002"), "only-second@sec.test"), { owner: await ownerPair(db, org, "co-002"), second: await pair(db, org, "co-002") });
  await db`update customers set fde_owner = 'both-o@sec.test', ae_owner = 'both-s@sec.test' where org_id = ${org} and customer_id = 'co-002'`;
  check(`${label}: ONE statement writing both original columns -> each neutral column follows its own`, ownerBoth(await ownerPair(db, org, "co-002"), "both-o@sec.test") && both(await pair(db, org, "co-002"), "both-s@sec.test"), { owner: await ownerPair(db, org, "co-002"), second: await pair(db, org, "co-002") });
  await db`insert into customers (org_id, customer_id, customer_name, fde_owner, ae_owner) values (${org}, 'raw-both', 'Raw both', 'ins-o@sec.test', 'ins-s@sec.test')`;
  check(`${label}: ONE insert naming both original columns -> both neutral columns carry their own`, ownerBoth(await ownerPair(db, org, "raw-both"), "ins-o@sec.test") && both(await pair(db, org, "raw-both"), "ins-s@sec.test"), { owner: await ownerPair(db, org, "raw-both"), second: await pair(db, org, "raw-both") });
  const m = await mismatched(db);
  check(`${label}: afterwards no row anywhere holds two different values in either pair`, m.length === 0, m);
}

/** Flip org_isolation on customers to the production FAIL-CLOSED shape (as .migrate-rls-fail-closed.mjs). */
async function failClosed(db) {
  const closed = `(org_id = current_setting('app.org_id', true))`;
  await db.unsafe(`ALTER POLICY org_isolation ON "customers" USING ${closed} WITH CHECK ${closed}`);
}

let adminDb; // the scratch database the RLS and app checks compare against, as an admin

/** As app_rw under the fail-closed policy: nothing without a workspace, only your own with one, no write across. */
async function checkRls(appUrl, label) {
  const app = postgres(appUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
  try {
    const [who] = await app`select current_user as u, (select rolbypassrls from pg_roles where rolname = current_user) as bypass`;
    check(`${label}: connected as app_rw, which cannot bypass row-level security`, who.u === "app_rw" && who.bypass === false, who);
    const unscoped = await app.begin(async (tx) => ({
      customers: (await tx`select count(*)::int as n from customers`)[0].n,
      seconds: (await tx`select count(*)::int as n from customers where secondary_owner is not null or ae_owner is not null`)[0].n,
    }));
    check(`${label}: with no workspace set, customers reads NOTHING (fail-closed), under either second-owner name`, unscoped.customers === 0 && unscoped.seconds === 0, unscoped);
    const scoped = await app.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${W1}, true)`;
      return {
        orgs: await tx`select distinct org_id from customers`,
        bySecond: await tx`select distinct org_id from customers where secondary_owner like '%@sec.test' or ae_owner like '%@sec.test'`,
      };
    });
    check(`${label}: with W1 set, customers returns only W1's rows, also when filtered by either second-owner column`, scoped.orgs.length === 1 && scoped.orgs[0].org_id === W1 && scoped.bySecond.length === 1 && scoped.bySecond[0].org_id === W1, scoped);
    for (const col of ["secondary_owner", "ae_owner"]) {
      const crossInsert = await app.begin(async (tx) => {
        await tx`select set_config('app.org_id', ${W1}, true)`;
        return tx.unsafe(`insert into customers (org_id, customer_id, customer_name, ${col}) values ($1, $2, 'Planted', 'x@sec.test')`, [W2, `planted-${col}`]);
      }).then(() => "inserted", (e) => e.code);
      check(`${label}: W1 inserting a customer stamped W2 naming ${col} is refused by the policy`, crossInsert === "42501", crossInsert);
    }
    const noScopeInsert = await app`insert into customers (org_id, customer_id, customer_name, secondary_owner) values (${W1}, 'planted-unscoped', 'Planted', 'x@sec.test')`.then(() => "inserted", (e) => e.code);
    check(`${label}: with no workspace set, an insert is refused`, noScopeInsert === "42501", noScopeInsert);
    const w2Before = await pair(adminDb, W2, "co-040");
    const hit = await app.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${W1}, true)`;
      const a = await tx`update customers set ae_owner = 'stolen@sec.test' where org_id = ${W2} and customer_id = 'co-040' returning 1`;
      const b = await tx`update customers set secondary_owner = 'stolen@sec.test' where customer_id = 'co-040' returning 1`;
      return a.length + b.length;
    });
    const w2After = await pair(adminDb, W2, "co-040");
    check(`${label}: W1 updating W2's second owner under either name touches no row, and W2's values are unchanged`, hit === 0 && JSON.stringify(w2Before) === JSON.stringify(w2After), { hit, w2Before, w2After });
    const planted = (await adminDb`select count(*)::int as n from customers where customer_id like 'planted-%'`)[0].n;
    check(`${label}: …and nothing was planted in any workspace`, planted === 0, planted);
    // The trigger runs as the writer (no SECURITY DEFINER), inside its policy: W1's own row, under RLS, still pairs.
    await app.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${W1}, true)`;
      await tx`update customers set ae_owner = 'rls-write@sec.test' where org_id = ${W1} and customer_id = 'co-003'`;
    });
    check(`${label}: app_rw in W1 writing ae_owner on its own row -> secondary_owner follows under RLS`, both(await pair(adminDb, W1, "co-003"), "rls-write@sec.test"), await pair(adminDb, W1, "co-003"));
    const definer = await adminDb`select proname, prosecdef from pg_proc where proname = ${TRIGGER}`;
    check(`${label}: the trigger function is not SECURITY DEFINER (it cannot widen what the writer may touch)`, definer.length === 1 && definer[0].prosecdef === false, definer);
  } finally {
    await app.end();
  }
}

/** The app's own write and read paths (agent/lib/system-of-record.ts), as app_rw under the fail-closed policy. */
async function checkAppPaths(appUrl, label) {
  process.env.DATABASE_URL = appUrl;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const dir = mkdtempSync(join(tmpdir(), "secondary-owner-"));
  process.env.DATAROOM_DIR = join(dir, "dataroom");
  try {
    const sor = await import(pathToFileURL(join(ROOT, "agent/lib/system-of-record.ts")).href);
    const cols = await import(pathToFileURL(join(ROOT, "agent/lib/db/owner-columns.ts")).href);
    const { closeDb } = await import(pathToFileURL(join(ROOT, "agent/lib/db/index.ts")).href);
    try {
      // The record contract names the second owner by its original key; the write lands in both columns.
      await sor.upsertCustomer({ id: "co-004", aeOwner: "agent-write@sec.test" }, W1);
      check(`${label}: upsert_customer's write of the second owner lands in both columns`, both(await pair(adminDb, W1, "co-004"), "agent-write@sec.test"), await pair(adminDb, W1, "co-004"));
      await adminDb`update customers set ae_owner = 'outside@sec.test' where org_id = ${W1} and customer_id = 'co-004'`;
      check(`${label}: a raw write of ae_owner is what get_customer reads`, (await sor.getCustomer("co-004", W1))?.aeOwner === "outside@sec.test", (await sor.getCustomer("co-004", W1))?.aeOwner);
      await adminDb`update customers set secondary_owner = 'neutral@sec.test' where org_id = ${W1} and customer_id = 'co-004'`;
      const read = await sor.getCustomer("co-004", W1);
      check(`${label}: a raw write of secondary_owner is what get_customer reads, under the record's one key`, read?.aeOwner === "neutral@sec.test" && !("secondaryOwner" in (read ?? {})), read && { aeOwner: read.aeOwner, secondaryOwner: read.secondaryOwner });
      await sor.upsertCustomer({ id: "co-004", status: "At Risk" }, W1);
      check(`${label}: a patch that names neither leaves both as they were`, both(await pair(adminDb, W1, "co-004"), "neutral@sec.test"), await pair(adminDb, W1, "co-004"));
      await sor.upsertCustomer({ id: "new-by-agent", name: "New by agent", aeOwner: "created@sec.test", fdeOwner: "created-owner@sec.test" }, W1);
      check(`${label}: a NEW account through upsert_customer carries both owners in both columns of each pair`, both(await pair(adminDb, W1, "new-by-agent"), "created@sec.test") && ownerBoth(await ownerPair(adminDb, W1, "new-by-agent"), "created-owner@sec.test"), { second: await pair(adminDb, W1, "new-by-agent"), owner: await ownerPair(adminDb, W1, "new-by-agent") });
      const other = await sor.getCustomer("co-040", W1);
      check(`${label}: W1's reader never returns W2's company`, other === null, other);

      // A database built by `drizzle-kit push` alone (CI's, a developer's) has the columns and NO trigger. Switched
      // off here, the app must do the pairing itself: write both, read the neutral column, fall back to the original.
      await adminDb.unsafe(`ALTER TABLE customers DISABLE TRIGGER ${TRIGGER}`);
      try {
        await sor.upsertCustomer({ id: "co-005", aeOwner: "no-trigger@sec.test" }, W1);
        check(`${label}: with no trigger, upsert_customer still writes BOTH columns`, both(await pair(adminDb, W1, "co-005"), "no-trigger@sec.test"), await pair(adminDb, W1, "co-005"));
        await adminDb`update customers set secondary_owner = null, ae_owner = 'fallback@sec.test' where org_id = ${W1} and customer_id = 'co-005'`;
        check(`${label}: with no trigger, a row holding only ae_owner is read through the fallback`, (await sor.getCustomer("co-005", W1))?.aeOwner === "fallback@sec.test", await pair(adminDb, W1, "co-005"));
        await adminDb`update customers set secondary_owner = 'neutral-first@sec.test', ae_owner = 'stale@sec.test' where org_id = ${W1} and customer_id = 'co-005'`;
        check(`${label}: with no trigger, when the two differ the NEUTRAL column is the one read`, (await sor.getCustomer("co-005", W1))?.aeOwner === "neutral-first@sec.test", (await sor.getCustomer("co-005", W1))?.aeOwner);
        await sor.upsertCustomer({ id: "co-005", aeOwner: "healed@sec.test" }, W1);
        check(`${label}: …and the app's next write makes them equal again`, both(await pair(adminDb, W1, "co-005"), "healed@sec.test"), await pair(adminDb, W1, "co-005"));
      } finally {
        await adminDb.unsafe(`ALTER TABLE customers ENABLE TRIGGER ${TRIGGER}`);
      }

      // The helpers every write and every `select()` reader goes through (the Ops API and the workbook route).
      const paired = cols.pairOwners({ customerId: "x", secondaryOwner: "n@sec.test" });
      const pairedOld = cols.pairOwners({ customerId: "x", aeOwner: "o@sec.test" });
      const pairedNone = cols.pairOwners({ customerId: "x", tier: "Growth" });
      const cleared = cols.pairOwners({ aeOwner: null });
      check(`${label}: pairOwners names both keys from either one, clears both on null, and adds none when a row names neither`,
        paired.aeOwner === "n@sec.test" && paired.secondaryOwner === "n@sec.test" && pairedOld.aeOwner === "o@sec.test" && pairedOld.secondaryOwner === "o@sec.test"
          && !("aeOwner" in pairedNone) && !("secondaryOwner" in pairedNone) && !("fdeOwner" in paired) && cleared.aeOwner === null && cleared.secondaryOwner === null,
        { paired, pairedOld, pairedNone, cleared });
      const returned = cols.withOwnerKeys({ customerId: "x", fdeOwner: "f@sec.test", accountOwner: null, aeOwner: "o@sec.test", secondaryOwner: null });
      check(`${label}: withOwnerKeys returns both pairs under both names, read with the fallback`, returned.aeOwner === "o@sec.test" && returned.secondaryOwner === "o@sec.test" && returned.fdeOwner === "f@sec.test" && returned.accountOwner === "f@sec.test", returned);
    } finally {
      await closeDb?.();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  check(`the journal carries ${TAG}, right after ${PREVIOUS}`, !!entry(TAG) && existsSync(join(ROOT, `drizzle/${TAG}.sql`)) && entry(TAG)?.idx === entry(PREVIOUS)?.idx + 1, journal.entries.at(-1)?.tag);
  if (!entry(TAG)) throw new Error(`${TAG} is not in drizzle/meta/_journal.json`);
  const IDX = entry(TAG).idx;

  console.log(`\nA. The live shape (pushed from ${LIVE_SCHEMA}, bootstrapped, seeded, then the journal to 0028) -> 0029 -> the drift dry run`);
  {
    const { db, url, name } = await freshDb("a");
    adminDb = db;
    const p = kit(["push", "--force", "--dialect=postgresql", `--schema=${LIVE_SCHEMA}`, `--url=${url}`], url);
    if (p.status !== 0 || !/Changes applied/.test(p.out)) throw new Error(`push of ${LIVE_SCHEMA} failed:\n${p.out.slice(-800)}`);
    const b = bootstrap(url);
    if (b.status !== 0) throw new Error(`bootstrap failed:\n${(b.stdout + b.stderr).slice(-800)}`);
    await seed(db);
    await applyRange(db, entry("0024_company_key_per_workspace").idx - 1, IDX - 1); // 0024 to 0028, as the live databases took them
    const cols0 = await columns(db);
    check("before 0029 the neutral column does not exist, and 0028's does", !cols0.some((x) => x.includes(`.${NEW_COLUMN} `)) && cols0.some((x) => x.startsWith("customers.account_owner ")), cols0);
    const planBefore = driftPlan(url);
    const oursBefore = (planBefore.apply ?? []).filter((x) => !laterEntry(x));
    const named = oursBefore.join("\n");
    check(
      "…and the drift plan against schema.ts names it, and only it (so an empty plan after 0029 means something)",
      !planBefore.error && oursBefore.length === 1 && /ADD COLUMN "secondary_owner" text/.test(named) && planBefore.refused.length === 0,
      planBefore.error ? planBefore : { apply: planBefore.apply, refused: planBefore.refused },
    );
    const f0 = await fingerprint(db);
    const sec0 = await security(db);
    const idx0 = await indexes(db);
    const trg0 = await triggers(db);
    const before = await db`select org_id, customer_id, ae_owner, fde_owner, account_owner from customers order by 1, 2`;
    await applyRange(db, IDX - 1, IDX);
    const cols1 = await columns(db);
    check("0029 adds customers.secondary_owner (text, nullable) and no other column", JSON.stringify(cols1.filter((x) => !cols0.includes(x))) === JSON.stringify(["customers.secondary_owner text YES"]) && cols0.every((x) => cols1.includes(x)), { added: cols1.filter((x) => !cols0.includes(x)), lost: cols0.filter((x) => !cols1.includes(x)) });
    const m = await mismatched(db);
    check("every secondary_owner equals its ae_owner (NULL where there is none), and the owner pair is still equal", m.length === 0, m);
    const counted = (await db`select count(*) filter (where ae_owner is null and secondary_owner is null)::int as none, count(*) filter (where secondary_owner is not null)::int as some from customers`)[0];
    check("…the 20 accounts with no second owner have none under both names, and the 40 with one carry it", counted.none === 20 && counted.some === 40, counted);
    check("…and no row or value that was there changed (60 companies, 60 deployments)", (await fingerprint(db)) === f0, { before: f0, after: await fingerprint(db) });
    const after = await db`select org_id, customer_id, ae_owner, fde_owner, account_owner from customers order by 1, 2`;
    check("…ae_owner, fde_owner and account_owner are exactly as they were on every row", JSON.stringify(before) === JSON.stringify(after));
    check("no index on customers was added or lost (ae_owner never had one)", JSON.stringify(await indexes(db)) === JSON.stringify(idx0), { idx0, idx1: await indexes(db) });
    const trg1 = await triggers(db);
    check(
      `the trigger ${TRIGGER} is added, enabled, for INSERT and for UPDATE OF its two columns only; 0028's customers_owner_pair is untouched`,
      trg1.length === trg0.length + 1 && trg0.every((t) => trg1.some((x) => JSON.stringify(x) === JSON.stringify(t)))
        && trg1.some((t) => t.tgname === TRIGGER && t.tgenabled === "O" && /BEFORE INSERT OR UPDATE OF secondary_owner, ae_owner ON/.test(t.def) && /FOR EACH ROW/.test(t.def)),
      { trg0, trg1 },
    );
    check("row-level security on customers is exactly as before 0029 (flags and every policy)", (await security(db)) === sec0, { before: sec0, after: await security(db) });
    checkPlan(url, "after 0029");
    const f1 = await fingerprint(db, { withNew: true });
    await applyRange(db, IDX - 1, IDX);
    check("0029 again: nothing changes (rows, indexes, triggers)", (await fingerprint(db, { withNew: true })) === f1 && JSON.stringify(await indexes(db)) === JSON.stringify(idx0) && JSON.stringify(await triggers(db)) === JSON.stringify(trg1));
    await checkPairs(db, "A");
    await failClosed(db);
    await checkRls(urlOf(name, "app_rw"), "A (fail-closed)");
    await checkAppPaths(urlOf(name, "app_rw"), "A (app paths, fail-closed)");
    check("after the writes no row holds two different values in either pair", (await mismatched(db)).length === 0, await mismatched(db));
    checkPlan(url, "after the writes");
    await db.end();
  }

  console.log("\nB. An empty database: push --force from the new schema.ts, the journal after the 0013 baseline, the bootstrap");
  {
    const { db, url } = await freshDb("b");
    const p = kit(["push", "--force", "--verbose"], url);
    check("push --force from the new schema.ts builds an empty database with the neutral second-owner column", p.status === 0 && /Changes applied/.test(p.out) && (await columns(db)).some((x) => x.startsWith(`customers.${NEW_COLUMN} `)), p.out.slice(-600));
    await applyRange(db, 13, Number.MAX_SAFE_INTEGER);
    const b = bootstrap(url);
    check("…the journal after it (0014 to 0029) and the bootstrap apply", b.status === 0, (b.stdout + b.stderr).slice(-400));
    const names = (await triggers(db)).map((r) => r.tgname);
    check("…and both pairing triggers are on customers", JSON.stringify(names) === JSON.stringify(["customers_owner_pair", TRIGGER]), names);
    await seed(db);
    check("…rows seeded by the original names carry both names", (await mismatched(db)).length === 0 && (await db`select count(*)::int as n from customers where secondary_owner is not null`)[0].n === 40, await mismatched(db));
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
  console.error(`\ntest-secondary-owner-migration-db: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\ntest-secondary-owner-migration-db: all ${passed} checks passed`);

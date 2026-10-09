#!/usr/bin/env node
/**
 * drizzle/0037_owner_columns_switch.sql ON A DATABASE SHAPED LIKE PRODUCTION, WITH DATA IN THE OLD COLUMNS.
 *
 * 0028 added customers.account_owner and solutions.solution_owner beside the original owner columns (named with the
 * base product's old role word, built here from agent/lib/legacy-member.ts: O and SO) and keeps each pair equal by a
 * trigger. From 0037 on the app names only the neutral columns. 0037 is the database half of that switch, and it runs
 * in the journal BEFORE the new build serves, so the previous release keeps serving against it for the deploy window.
 * Proven here:
 *
 *   A. THE LIVE SHAPE, as the live databases are today: pushed from the schema before #84
 *      (scripts/fixtures/schema-419b38d.ts), bootstrapped (app_rw, row-level security), the journal 0024 to 0036 as
 *      they took it, then seeded the way the previous release and the factory wrote it: two workspaces, 60 companies
 *      with the owner in the original column (the trigger copies it), 10 with none; one solution each; and the cases a
 *      trigger cannot be trusted to have prevented, planted with it switched off: an owner only in the original
 *      column, a solution owner only in the original column, an owner differing between the two. Plus the stored
 *      values that carried the word: tickets.owner_team, customers.value_evidence_status, and operator profile
 *      memories (one with a neutral twin, one without). Then 0037, in one transaction as migrate-production.mjs runs it:
 *        - every original owner value is in its neutral column (filled where the neutral one was NULL; where the two
 *          differed the neutral value, the one the app has read since 0028, is kept);
 *        - NOTHING IS LOST: every row of every touched table is there, and apart from the neutral columns filled and
 *          the three stored values rewritten, every value in it is exactly as it was, the original columns included;
 *        - solutions' original column is nullable, customers' original index is gone, the neutral index is there, and
 *          no other column or index changed;
 *        - the stored values are the neutral ones ("Member", "Member Verified", `member-profile:`), a memory with a
 *          neutral twin in its workspace and scope is left as it was;
 *        - row-level security, every policy and every grant on every table are exactly as before, and as app_rw under
 *          the production FAIL-CLOSED policies: no workspace reads nothing, a workspace reads only its own owners,
 *          memories and tickets, and a write aimed at another workspace is refused or touches nothing;
 *        - THE DEPLOY WINDOW: the previous release's writes (both columns named, raw SQL of the original, a solution
 *          naming both) still succeed after 0037, and its reader (coalesce(neutral, original)) reads the same owner
 *          the new release reads; the new release's writes (neutral only, through the app's own paths, as app_rw)
 *          reach the original column through the trigger, so the previous release reads them too;
 *        - 0037 again changes nothing; the deploy's drift dry run after the journal plans nothing on these tables
 *          and nothing it would refuse.
 *   B. AN EMPTY DATABASE: push --force from the schema drizzle-kit reads, the journal after the 0013 baseline, the
 *      bootstrap: 0037 applies, and the plan is empty.
 *   C. A DATABASE WITH NO ORIGINAL COLUMNS (pushed from agent/lib/db/schema.ts alone, as after 0038): 0028 and 0037
 *      apply without error and change nothing.
 *
 * Needs ADMIN_URL (a role that may CREATE DATABASE). Scratch databases carry this process's pid and are dropped in a
 * finally block.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test npm run test:owner-columns-switch-db
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { ROOT, driftPlan, kit } from "./lib/drift-plan.mjs";
import { LEGACY_MEMBER, LEGACY_OWNER_KEYS } from "../agent/lib/legacy-member.ts";

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
  console.log("test-owner-columns-switch-db: SKIPPED — needs ADMIN_URL (a role that may create a database).");
  process.exit(0);
}
const LIVE_SCHEMA = "scripts/fixtures/schema-419b38d.ts";
const TAG = "0037_owner_columns_switch";
const W1 = "org-switch-one";
const W2 = "org-switch-two";
const APP_PASSWORD = process.env.APP_RW_PASSWORD || "app_rw_test_password";
/** The original columns, the original index, the stored values and the memory prefix, by the names they had. */
const O = LEGACY_OWNER_KEYS.account_owner;
const SO = LEGACY_OWNER_KEYS.solution_owner;
const OLD_INDEX = `customers_${O}_idx`;
const OLD_TEAM = LEGACY_MEMBER.singular;
const OLD_VERIFIED = `${LEGACY_MEMBER.singular} Verified`;
const OLD_PROFILE = `${LEGACY_MEMBER.singular.toLowerCase()}-profile:`;
const TOUCHED = ["customers", "solutions", "tickets", "memories"];

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 900)}`}`); }
};

const local = /localhost|127\.0\.0\.1/.test(adminUrl);
const ssl = local ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
const OWN = admin(O);
const SOL = admin(SO);
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
  const name = `ownswitch_${label}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.unsafe(`create database "${name}"`);
  scratch.push(name);
  return { name, url: urlOf(name), db: postgres(urlOf(name), { ssl, prepare: false, max: 1, onnotice: () => {} }) };
}
const bootstrap = (url) => spawnSync(process.execPath, [join(ROOT, "scripts/bootstrap-test-db.mjs")], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });

/**
 * As the previous release and the factory wrote it, with the trigger on: 60 companies, the owner in the original
 * column on 50; a solution and a ticket each; and the stored values that carried the word.
 */
async function seed(db) {
  await db`insert into orgs (org_id, name, status, created_at) values (${W1}, 'One', 'active', now() - interval '1 year'), (${W2}, 'Two', 'active', now())`;
  for (let i = 0; i < 60; i++) {
    const org = i < 30 ? W1 : W2;
    const id = `co-${String(i + 1).padStart(3, "0")}`;
    const owner = i % 6 === 5 ? null : `owner-${i % 4}@switch.test`;
    const evidence = i % 3 === 0 ? OLD_VERIFIED : i % 3 === 1 ? "Customer Verified" : null;
    await db`insert into customers (org_id, customer_id, customer_name, tier, ${OWN}, ae_owner, value_evidence_status, custom) values (${org}, ${id}, ${`Company ${id}`}, 'Growth', ${owner}, 'ae@switch.test', ${evidence}, ${db.json({ note: `n-${id}` })})`;
    await db`insert into solutions (org_id, customer_id, solution_id, use_case, modules_enabled, solution_status, ${SOL}) values (${org}, ${id}, 'SOL-1', 'Research Copilot', '[]', 'Live', ${owner ?? "fallback@switch.test"})`;
    await db`insert into tickets (org_id, customer_id, ticket_id, summary, ticket_type, ticket_category, ticket_status, ticket_priority, ticket_opened_date, ticket_owner_email, source_channel, last_activity_date, ticket_next_step, owner_team) values (${org}, ${id}, ${`T-${id}`}, 'A ticket', 'Bug', 'Bug Report', 'Open', 'P2-Medium', '2026-07-01', 'tickets@switch.test', 'email', '2026-07-02', 'Triage', ${i % 2 === 0 ? OLD_TEAM : "Support"})`;
  }
  // Profiles: one under the old key only (moves), one under both keys in W1's team scope (the old one stays), one under
  // the old key in W2 whose neutral twin is in W1 only (it moves: a twin counts only in its own workspace and scope).
  const mem = (org, key, value) => db`insert into memories (org_id, scope, key, value, author_email) values (${org}, 'team', ${key}, ${value}, 'op@switch.test')`;
  await mem(W1, `${OLD_PROFILE}solo@switch.test`, "solo-old");
  await mem(W1, `${OLD_PROFILE}twin@switch.test`, "twin-old");
  await mem(W1, "member-profile:twin@switch.test", "twin-new");
  await mem(W2, `${OLD_PROFILE}twin@switch.test`, "w2-old");
  await mem(W1, "other-key", "untouched");
}

/** What the trigger cannot be trusted to have prevented: planted with it off, as a writer that bypassed it would. */
async function plantDrift(db) {
  await db.unsafe(`ALTER TABLE customers DISABLE TRIGGER customers_owner_pair`);
  await db.unsafe(`ALTER TABLE solutions DISABLE TRIGGER solutions_owner_pair`);
  try {
    await db`update customers set account_owner = null, ${OWN} = 'only-old@switch.test' where org_id = ${W1} and customer_id = 'co-001'`;
    await db`update customers set account_owner = 'neutral-wins@switch.test', ${OWN} = 'stale@switch.test' where org_id = ${W1} and customer_id = 'co-002'`;
    await db`update solutions set solution_owner = null, ${SOL} = 'sol-only-old@switch.test' where org_id = ${W2} and customer_id = 'co-040'`;
  } finally {
    await db.unsafe(`ALTER TABLE customers ENABLE TRIGGER customers_owner_pair`);
    await db.unsafe(`ALTER TABLE solutions ENABLE TRIGGER solutions_owner_pair`);
  }
}

/** Every row of a table as JSON, minus the given columns, in a stable order: what "nothing else changed" compares. */
const rowsOf = async (db, table, minus = []) =>
  (await db.unsafe(`select ${minus.length ? `to_jsonb(x) - ${minus.map((c) => `'${c}'`).join(" - ")}` : "to_jsonb(x)"} as r from ${table} x order by 1::text`)).map((r) => JSON.stringify(r.r)).sort();
const columns = async (db) => (await db`select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = any(${TOUCHED}) order by 1, 2`).map((r) => `${r.table_name}.${r.column_name} ${r.data_type} ${r.is_nullable}`);
const indexes = async (db) => (await db`select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = any(${TOUCHED}) order by indexname`).map((r) => `${r.indexname}: ${r.indexdef}`);
/** Every RLS flag, policy and grant in the schema: the tenancy model, all of it. */
const security = async (db) => JSON.stringify({
  flags: await db`select relname, relrowsecurity, relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relkind = 'r' order by relname`,
  policies: await db`select tablename, policyname, permissive, roles::text, cmd, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2`,
  grants: await db`select grantee, table_name, privilege_type from information_schema.role_table_grants where table_schema = 'public' order by 1, 2, 3`,
  columnGrants: await db`select grantee, table_name, column_name, privilege_type from information_schema.column_privileges where table_schema = 'public' and grantee = 'app_rw' order by 1, 2, 3, 4`,
});
const owner = async (db, org, id) => (await db`select ${OWN} as old, account_owner as neutral from customers where org_id = ${org} and customer_id = ${id}`)[0];
const solOwner = async (db, org, id, sid = "SOL-1") => (await db`select ${SOL} as old, solution_owner as neutral from solutions where org_id = ${org} and customer_id = ${id} and solution_id = ${sid}`)[0];
/** What the PREVIOUS release reads for an account's owner (its accountOwnerSql). */
const previousReader = async (db, org, id) => (await db`select coalesce(account_owner, ${OWN}) as owner from customers where org_id = ${org} and customer_id = ${id}`)[0]?.owner;

/** The deploy's drift step after the journal: nothing on the touched tables, nothing refused, no DROP COLUMN. */
function checkPlan(url, label) {
  const plan = driftPlan(url);
  if (plan.error) { check(`${label}: the drift dry run produced a plan`, false, plan); return; }
  const all = [...plan.apply, ...plan.aside, ...plan.refused];
  const ours = plan.apply.filter((x) => TOUCHED.some((t) => x.includes(`"${t}"`)) || x.includes(O) || x.includes(SO));
  check(`${label}: the drift dry run plans nothing on customers, solutions, tickets or memories`, ours.length === 0, ours);
  check(`${label}: …and nothing the deploy would refuse (no data loss, no index drop)`, plan.refused.length === 0, plan.refused);
  check(`${label}: …and no DROP COLUMN or truncate anywhere in the plan`, all.every((x) => !/DROP\s+COLUMN|^\s*truncate/i.test(x)), all.filter((x) => /DROP|truncate/i.test(x) && !/POLICY/i.test(x)));
}

/** Flip org_isolation on every touched table to the production FAIL-CLOSED shape (as .migrate-rls-fail-closed.mjs). */
async function failClosed(db) {
  const closed = `(org_id = current_setting('app.org_id', true))`;
  for (const t of TOUCHED) await db.unsafe(`ALTER POLICY org_isolation ON "${t}" USING ${closed} WITH CHECK ${closed}`);
}

/** As app_rw under the fail-closed policies: isolation of the owners, the tickets and the memories 0037 touched. */
async function checkRls(adminDb, appUrl, label) {
  const app = postgres(appUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
  try {
    const [who] = await app`select current_user as u, (select rolbypassrls from pg_roles where rolname = current_user) as bypass`;
    check(`${label}: connected as app_rw, which cannot bypass row-level security`, who.u === "app_rw" && who.bypass === false, who);
    const unscoped = await app.begin(async (tx) => {
      const out = {};
      for (const t of TOUCHED) out[t] = (await tx.unsafe(`select count(*)::int as n from ${t}`))[0].n;
      return out;
    });
    check(`${label}: with no workspace set, every touched table reads NOTHING (fail-closed)`, Object.values(unscoped).every((n) => n === 0), unscoped);
    const scoped = await app.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${W1}, true)`;
      const out = {};
      for (const t of TOUCHED) out[t] = (await tx.unsafe(`select distinct org_id from ${t}`)).map((r) => r.org_id);
      out.owners = (await tx`select count(*)::int as n from customers where account_owner is not null`)[0].n;
      out.profiles = (await tx`select key from memories where key like 'member-profile:%' order by key`).map((r) => r.key);
      return out;
    });
    check(`${label}: with W1 set, every touched table returns only W1's rows`, TOUCHED.every((t) => JSON.stringify(scoped[t]) === JSON.stringify([W1])), scoped);
    const w1Owners = (await adminDb`select count(*)::int as n from customers where org_id = ${W1} and account_owner is not null`)[0].n;
    check(`${label}: …all of W1's owners, and W1's profiles only (W2's moved one is not among them)`, scoped.owners === w1Owners && JSON.stringify(scoped.profiles) === JSON.stringify(["member-profile:solo@switch.test", "member-profile:twin@switch.test"]), scoped);
    const cross = await app.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${W1}, true)`;
      return tx`insert into customers (org_id, customer_id, customer_name, account_owner) values (${W2}, 'planted', 'Planted', 'x@switch.test')`;
    }).then(() => "inserted", (e) => e.code);
    check(`${label}: W1 inserting a customer stamped W2 is refused by the policy`, cross === "42501", cross);
    const before = await owner(adminDb, W2, "co-040");
    const hit = await app.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${W1}, true)`;
      const a = await tx`update customers set account_owner = 'stolen@switch.test' where customer_id = 'co-040' returning 1`;
      const b = await tx`update customers set ${OWN} = 'stolen@switch.test' where customer_id = 'co-040' returning 1`;
      const c = await tx`update memories set key = 'stolen' where org_id = ${W2} returning 1`;
      return a.length + b.length + c.length;
    });
    check(`${label}: W1 updating W2's owner (either name) or memories touches no row`, hit === 0 && JSON.stringify(await owner(adminDb, W2, "co-040")) === JSON.stringify(before), { hit, before, after: await owner(adminDb, W2, "co-040") });
  } finally {
    await app.end();
  }
}

/** The new release's own write and read paths (agent/lib/system-of-record.ts), as app_rw under fail-closed policies. */
async function checkNewRelease(adminDb, appUrl, label) {
  process.env.DATABASE_URL = appUrl;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const dir = mkdtempSync(join(tmpdir(), "owner-switch-"));
  process.env.DATAROOM_DIR = join(dir, "dataroom");
  try {
    const sor = await import(pathToFileURL(join(ROOT, "agent/lib/system-of-record.ts")).href);
    const { closeDb } = await import(pathToFileURL(join(ROOT, "agent/lib/db/index.ts")).href);
    try {
      const read = await sor.getCustomer("co-001", W1);
      check(`${label}: get_customer reads the owner 0037 filled in from the original column`, read?.accountOwner === "only-old@switch.test", read?.accountOwner);
      await sor.upsertCustomer({ id: "co-004", accountOwner: "new-release@switch.test" }, W1);
      const o = await owner(adminDb, W1, "co-004");
      check(`${label}: upsert_customer writes account_owner only, and the trigger carries it to the original column`, o.neutral === "new-release@switch.test" && o.old === "new-release@switch.test", o);
      check(`${label}: …so the previous release, still serving in the deploy window, reads the same owner`, (await previousReader(adminDb, W1, "co-004")) === "new-release@switch.test");
      await sor.upsertCustomer({ id: "co-004", solutions: [{ solutionId: "SOL-2", useCase: "Other", modulesEnabled: [], solutionStatus: "Live", solutionOwner: "sol-new@switch.test" }] }, W1);
      const so = await solOwner(adminDb, W1, "co-004", "SOL-2");
      check(`${label}: a new solution through upsert_customer (solution_owner only) is accepted, and the trigger fills the original`, so.neutral === "sol-new@switch.test" && so.old === "sol-new@switch.test", so);
      const moved = await sor.reassignOwner("co-004", "reassigned@switch.test", "Re Assigned", W1);
      check(`${label}: reassigning reads the previous owner and writes the new one`, moved.previousOwner === "new-release@switch.test" && (await owner(adminDb, W1, "co-004")).neutral === "reassigned@switch.test", moved);
      const listed = (await sor.listCustomers(W1)).find((c) => c.id === "co-002");
      check(`${label}: list_customers reads the neutral value where the two had differed`, listed?.accountOwner === "neutral-wins@switch.test", listed);
      const w2 = await sor.getCustomer("co-040", W1);
      check(`${label}: W1's reader never returns W2's company`, w2 === null, w2);
    } finally {
      await closeDb?.();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  check(`the journal carries ${TAG}, after every entry before it`, !!entry(TAG) && existsSync(join(ROOT, `drizzle/${TAG}.sql`)) && journal.entries.filter((e) => e.idx < entry(TAG).idx).every((e) => e.when < entry(TAG).when), journal.entries.at(-1)?.tag);
  if (!entry(TAG)) throw new Error(`${TAG} is not in drizzle/meta/_journal.json`);
  const IDX = entry(TAG).idx;
  check("the source of 0037 does not spell the retired word (it builds every name from its letters)", !readFileSync(join(ROOT, `drizzle/${TAG}.sql`), "utf8").toLowerCase().includes(LEGACY_MEMBER.singular.toLowerCase()));

  console.log(`\nA. The live shape (pushed from ${LIVE_SCHEMA}, bootstrapped, the journal 0024 to 0036, seeded with the old columns) -> 0037`);
  {
    const { db, url, name } = await freshDb("a");
    const p = kit(["push", "--force", "--dialect=postgresql", `--schema=${LIVE_SCHEMA}`, `--url=${url}`], url);
    if (p.status !== 0 || !/Changes applied/.test(p.out)) throw new Error(`push of ${LIVE_SCHEMA} failed:\n${p.out.slice(-800)}`);
    const b = bootstrap(url);
    if (b.status !== 0) throw new Error(`bootstrap failed:\n${(b.stdout + b.stderr).slice(-800)}`);
    await applyRange(db, entry("0024_company_key_per_workspace").idx - 1, IDX - 1);
    await seed(db);
    await plantDrift(db);

    const cols0 = await columns(db);
    const idx0 = await indexes(db);
    const sec0 = await security(db);
    const oldValues = (await db`select org_id, customer_id, ${OWN} as v from customers where ${OWN} is not null order by 1, 2`);
    const oldSolValues = (await db`select org_id, customer_id, solution_id, ${SOL} as v from solutions order by 1, 2, 3`);
    const neutralBefore = await db`select org_id, customer_id, account_owner from customers where account_owner is not null order by 1, 2`;
    const counts0 = Object.fromEntries(await Promise.all(TOUCHED.map(async (t) => [t, (await db.unsafe(`select count(*)::int as n from ${t}`))[0].n])));
    const keep = {
      customers: await rowsOf(db, "customers", ["account_owner", "value_evidence_status"]),
      solutions: await rowsOf(db, "solutions", ["solution_owner"]),
      tickets: await rowsOf(db, "tickets", ["owner_team"]),
      memories: await rowsOf(db, "memories", ["key"]),
    };
    check("before 0037 there is drift to fix: an owner only in the original column, and a solution owner likewise", (await owner(db, W1, "co-001")).neutral === null && (await solOwner(db, W2, "co-040")).neutral === null);
    check("…and solutions' original column is NOT NULL, customers' original index is there", cols0.includes(`solutions.${SO} text NO`) && idx0.some((x) => x.startsWith(`${OLD_INDEX}:`)), { cols0, idx0 });

    await applyRange(db, IDX - 1, IDX);

    const lost = [];
    for (const r of oldValues) {
      const now = await owner(db, r.org_id, r.customer_id);
      if (!now?.neutral) lost.push({ ...r, now });
    }
    check(`every original owner value (${oldValues.length}) has a neutral value beside it: none is left only in the old column`, lost.length === 0, lost);
    const o1 = await owner(db, W1, "co-001");
    check("an owner only in the original column is copied into account_owner", o1.neutral === "only-old@switch.test" && o1.old === "only-old@switch.test", o1);
    const o2 = await owner(db, W1, "co-002");
    check("where the two differed, the neutral value (the one the app has read since 0028) is kept, and the original is untouched", o2.neutral === "neutral-wins@switch.test" && o2.old === "stale@switch.test", o2);
    const s40 = await solOwner(db, W2, "co-040");
    check("a solution owner only in the original column is copied into solution_owner", s40.neutral === "sol-only-old@switch.test", s40);
    const solLost = [];
    for (const r of oldSolValues) {
      const now = await solOwner(db, r.org_id, r.customer_id, r.solution_id);
      if (now?.neutral == null || now.old !== r.v) solLost.push({ ...r, now });
    }
    check(`every solution (${oldSolValues.length}) has its owner in solution_owner, and its original value unchanged`, solLost.length === 0, solLost);
    const neutralAfter = await db`select org_id, customer_id, account_owner from customers where account_owner is not null order by 1, 2`;
    check("no neutral owner that was there changed", neutralBefore.every((r) => neutralAfter.some((x) => x.org_id === r.org_id && x.customer_id === r.customer_id && x.account_owner === r.account_owner)), { neutralBefore: neutralBefore.length, neutralAfter: neutralAfter.length });
    const unassigned = (await db`select count(*)::int as n from customers where account_owner is null and ${OWN} is null`)[0].n;
    check("…and the 10 unassigned accounts stay unassigned", unassigned === 10, unassigned);

    const counts1 = Object.fromEntries(await Promise.all(TOUCHED.map(async (t) => [t, (await db.unsafe(`select count(*)::int as n from ${t}`))[0].n])));
    check("NOTHING IS LOST: every row of customers, solutions, tickets and memories is still there", JSON.stringify(counts0) === JSON.stringify(counts1), { counts0, counts1 });
    const kept = {
      customers: await rowsOf(db, "customers", ["account_owner", "value_evidence_status"]),
      solutions: await rowsOf(db, "solutions", ["solution_owner"]),
      tickets: await rowsOf(db, "tickets", ["owner_team"]),
      memories: await rowsOf(db, "memories", ["key"]),
    };
    for (const t of TOUCHED) check(`…and every other value in ${t}, the original owner columns included, is exactly as it was`, JSON.stringify(kept[t]) === JSON.stringify(keep[t]));

    const cols1 = await columns(db);
    check("solutions' original column is nullable now, and no other column changed", JSON.stringify(cols1) === JSON.stringify(cols0.map((x) => (x === `solutions.${SO} text NO` ? `solutions.${SO} text YES` : x))), { added: cols1.filter((x) => !cols0.includes(x)), lost: cols0.filter((x) => !cols1.includes(x)) });
    const idx1 = await indexes(db);
    check("customers' original index is dropped, customers_account_owner_idx stays, and no other index changed", JSON.stringify(idx1) === JSON.stringify(idx0.filter((x) => !x.startsWith(`${OLD_INDEX}:`))) && idx1.some((x) => x.startsWith("customers_account_owner_idx:")), { idx0, idx1 });

    const teams = await db`select owner_team, count(*)::int as n from tickets group by 1 order by 1`;
    check(`tickets.owner_team: every stored "${OLD_TEAM}" is "Member" (30), the others untouched`, JSON.stringify(teams) === JSON.stringify([{ owner_team: "Member", n: 30 }, { owner_team: "Support", n: 30 }]), teams);
    const evidence = await db`select value_evidence_status as v, count(*)::int as n from customers where value_evidence_status is not null group by 1 order by 1`;
    check(`customers.value_evidence_status: every stored "${OLD_VERIFIED}" is "Member Verified" (20), the others untouched`, JSON.stringify(evidence) === JSON.stringify([{ v: "Customer Verified", n: 20 }, { v: "Member Verified", n: 20 }]), evidence);
    const keys = (await db`select org_id, key, value from memories order by org_id, key`).map((r) => `${r.org_id} ${r.key}=${r.value}`);
    check(
      "memories: an old-key profile moves to member-profile:, one whose workspace and scope already has the neutral key is left as it was, other keys are untouched",
      JSON.stringify(keys) === JSON.stringify([
        `${W1} ${OLD_PROFILE}twin@switch.test=twin-old`,
        `${W1} member-profile:solo@switch.test=solo-old`,
        `${W1} member-profile:twin@switch.test=twin-new`,
        `${W1} other-key=untouched`,
        `${W2} member-profile:twin@switch.test=w2-old`,
      ]),
      keys,
    );
    check("row-level security, every policy and every grant on every table are exactly as before 0037", (await security(db)) === sec0, { before: sec0.length, after: (await security(db)).length });

    // THE DEPLOY WINDOW: the previous release keeps serving against this database until the new build is promoted.
    await db`insert into customers (org_id, customer_id, customer_name, account_owner, ${OWN}) values (${W1}, 'prev-both', 'Previous release', 'prev@switch.test', 'prev@switch.test')`;
    await db`update customers set account_owner = 'prev2@switch.test', ${OWN} = 'prev2@switch.test' where org_id = ${W1} and customer_id = 'co-005'`;
    await db`insert into solutions (org_id, customer_id, solution_id, use_case, modules_enabled, solution_status, solution_owner, ${SOL}) values (${W1}, 'prev-both', 'SOL-1', 'Other', '[]', 'Live', 'prev@switch.test', 'prev@switch.test')`;
    await db`update customers set ${OWN} = 'factory@switch.test' where org_id = ${W1} and customer_id = 'co-006'`;
    check("the previous release's writes (both columns named, a solution naming both) still succeed after 0037", (await owner(db, W1, "prev-both")).neutral === "prev@switch.test" && (await owner(db, W1, "co-005")).neutral === "prev2@switch.test" && (await solOwner(db, W1, "prev-both")).neutral === "prev@switch.test");
    check("…a raw write of the original column alone still reaches account_owner (0028's trigger is still there)", (await owner(db, W1, "co-006")).neutral === "factory@switch.test");
    check("…and its reader reads what the new release reads, on every row", (await db`select count(*)::int as n from customers where coalesce(account_owner, ${OWN}) is distinct from account_owner`)[0].n === 0);

    const snapshot = JSON.stringify({ c: await rowsOf(db, "customers"), s: await rowsOf(db, "solutions"), t: await rowsOf(db, "tickets"), m: await rowsOf(db, "memories"), cols: await columns(db), idx: await indexes(db) });
    await applyRange(db, IDX - 1, IDX);
    check("0037 again: nothing changes (rows, columns, indexes)", JSON.stringify({ c: await rowsOf(db, "customers"), s: await rowsOf(db, "solutions"), t: await rowsOf(db, "tickets"), m: await rowsOf(db, "memories"), cols: await columns(db), idx: await indexes(db) }) === snapshot);
    await applyRange(db, IDX, Number.MAX_SAFE_INTEGER);
    checkPlan(url, "after the journal");

    await failClosed(db);
    await checkRls(db, urlOf(name, "app_rw"), "A (fail-closed)");
    await checkNewRelease(db, urlOf(name, "app_rw"), "A (the new release, fail-closed)");
    checkPlan(url, "after the writes");
    await db.end();
  }

  console.log("\nB. An empty database: push --force from the schema drizzle-kit reads, the journal after the 0013 baseline, the bootstrap");
  {
    const { db, url } = await freshDb("b");
    const p = kit(["push", "--force", "--verbose"], url);
    check("push --force builds an empty database with the neutral columns and the original ones (until 0038)", p.status === 0 && (await columns(db)).some((x) => x.startsWith("customers.account_owner ")) && (await columns(db)).includes(`solutions.${SO} text YES`), p.out.slice(-600));
    await applyRange(db, 13, Number.MAX_SAFE_INTEGER);
    const b = bootstrap(url);
    check("…the journal after it (0037 among it) and the bootstrap apply", b.status === 0, (b.stdout + b.stderr).slice(-400));
    checkPlan(url, "empty database, pushed");
    await db.end();
  }

  console.log("\nC. A database with no original columns (pushed from agent/lib/db/schema.ts alone, as after 0038)");
  {
    const { db, url } = await freshDb("c");
    const p = kit(["push", "--force", "--dialect=postgresql", "--schema=agent/lib/db/schema.ts", `--url=${url}`], url);
    check("push --force from schema.ts builds a database without the original columns", p.status === 0 && !(await columns(db)).some((x) => x.includes(`.${O} `) || x.includes(`.${SO} `)), p.out.slice(-600));
    await db`insert into orgs (org_id, name, status, created_at) values (${W1}, 'One', 'active', now())`;
    await db`insert into customers (org_id, customer_id, customer_name, account_owner) values (${W1}, 'c-1', 'C', 'c@switch.test')`;
    const before = await rowsOf(db, "customers");
    let error = null;
    try {
      await applyRange(db, entry("0028_neutral_owner_columns").idx - 1, entry("0028_neutral_owner_columns").idx);
      await applyRange(db, IDX - 1, IDX);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    check("0028 and 0037 apply without error on it, and change nothing", error === null && JSON.stringify(await rowsOf(db, "customers")) === JSON.stringify(before), error);
    const triggers = await db`select tgname from pg_trigger where not tgisinternal and tgrelid in ('public.customers'::regclass, 'public.solutions'::regclass)`;
    check("…and no owner trigger is created where there is no original column to keep equal", !triggers.some((r) => /owner_pair$/.test(r.tgname) && r.tgname !== "customers_secondary_owner_pair"), triggers);
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
  console.error(`\ntest-owner-columns-switch-db: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\ntest-owner-columns-switch-db: all ${passed} checks passed`);

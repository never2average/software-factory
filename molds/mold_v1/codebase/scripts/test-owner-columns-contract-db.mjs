#!/usr/bin/env node
/**
 * drizzle/0038_owner_columns_contract.sql ON A DATABASE SHAPED LIKE PRODUCTION, AFTER 0037 WAS DEPLOYED.
 *
 * 0028 added customers.account_owner and solutions.solution_owner beside the original owner columns (named with the
 * base product's old role word, built here from agent/lib/legacy-member.ts: O and SO) and kept each pair equal by a
 * trigger; 0037 switched the app to the neutral columns. 0038 drops the originals, the triggers, their functions and
 * the last index on them, one release after 0037. Proven here:
 *
 *   A. THE LIVE SHAPE after 0037's deploy: pushed from the schema before #84 (scripts/fixtures/schema-419b38d.ts),
 *      bootstrapped, the journal 0024 to 0036, seeded the way the release before 0037 and the factory wrote it, then
 *      0037. Then what that deploy and the release after it may have left: rows the release before 0037 wrote during
 *      0037's deploy window (the old stored values, an old profile memory key, both owner columns), rows the 0037
 *      release wrote (the neutral columns only, the trigger copying), and an owner only in the original column (a
 *      writer that bypassed the trigger). Then 0038, in one transaction as migrate-production.mjs runs it:
 *        - every owner is in its neutral column: a neutral value that was set is kept, one still NULL took the
 *          original's; NOTHING IS LOST: every row of customers, solutions, tickets and memories is there and every
 *          other value in it is exactly as it was;
 *        - the stored values are the neutral ones again ("Member", "Member Verified", `member-profile:`);
 *        - the two original columns, their index, both triggers and both functions are gone; the neutral index and
 *          0029's second-owner trigger are there; no other column or index changed;
 *        - row-level security, every policy and every table grant are exactly as before;
 *        - THE DEPLOY WINDOW: the release serving while 0038 deploys (the 0037 release, this code) works against it:
 *          its own paths as app_rw under the FAIL-CLOSED policies write and read the owners, a workspace reads only
 *          its own rows and cannot write another's; the factory's workspace seeding (it writes account_owner) works;
 *        - 0038 again changes nothing; the deploy's drift dry run plans nothing on these tables and nothing it would
 *          refuse (a DROP COLUMN left to it would have been refused and stopped the deploy).
 *   B. AN EMPTY DATABASE: push --force from schema.ts, the journal after the 0013 baseline, the bootstrap: 0038 has
 *      nothing to drop, applies, and the plan is empty.
 *   C. A DATABASE BUILT FROM THE JOURNAL ALONE (0000 created the originals): after the whole journal customers and
 *      solutions have exactly the columns a push from schema.ts gives them.
 *
 * Needs ADMIN_URL (a role that may CREATE DATABASE). Scratch databases carry this process's pid and are dropped in a
 * finally block.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test npm run test:owner-columns-contract-db
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
  console.log("test-owner-columns-contract-db: SKIPPED — needs ADMIN_URL (a role that may create a database).");
  process.exit(0);
}
const LIVE_SCHEMA = "scripts/fixtures/schema-419b38d.ts";
const TAG = "0038_owner_columns_contract";
const SWITCH_TAG = "0037_owner_columns_switch";
const W1 = "org-contract-one";
const W2 = "org-contract-two";
const APP_PASSWORD = process.env.APP_RW_PASSWORD || "app_rw_test_password";
const O = LEGACY_OWNER_KEYS.account_owner;
const SO = LEGACY_OWNER_KEYS.solution_owner;
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
const applyRange = async (db, fromIdx, toIdx) => {
  for (const e of journal.entries.filter((x) => x.idx > fromIdx && x.idx <= toIdx)) await db.begin(async (tx) => { for (const s of statementsOf(e.tag)) await tx.unsafe(s); });
};

const scratch = [];
async function freshDb(label) {
  const name = `owncontract_${label}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.unsafe(`create database "${name}"`);
  scratch.push(name);
  return { name, url: urlOf(name), db: postgres(urlOf(name), { ssl, prepare: false, max: 1, onnotice: () => {} }) };
}
const bootstrap = (url) => spawnSync(process.execPath, [join(ROOT, "scripts/bootstrap-test-db.mjs")], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });

/** As the release before 0037 and the factory wrote it: 60 companies (10 unassigned), a solution and a ticket each. */
async function seed(db) {
  await db`insert into orgs (org_id, name, status, created_at) values (${W1}, 'One', 'active', now() - interval '1 year'), (${W2}, 'Two', 'active', now())`;
  for (let i = 0; i < 60; i++) {
    const org = i < 30 ? W1 : W2;
    const id = `co-${String(i + 1).padStart(3, "0")}`;
    const owner = i % 6 === 5 ? null : `owner-${i % 4}@contract.test`;
    await db`insert into customers (org_id, customer_id, customer_name, tier, ${OWN}, ae_owner, value_evidence_status, custom) values (${org}, ${id}, ${`Company ${id}`}, 'Growth', ${owner}, 'ae@contract.test', ${i % 3 === 0 ? OLD_VERIFIED : null}, ${db.json({ note: `n-${id}` })})`;
    await db`insert into solutions (org_id, customer_id, solution_id, use_case, modules_enabled, solution_status, ${SOL}) values (${org}, ${id}, 'SOL-1', 'Research Copilot', '[]', 'Live', ${owner ?? "fallback@contract.test"})`;
    await db`insert into tickets (org_id, customer_id, ticket_id, summary, ticket_type, ticket_category, ticket_status, ticket_priority, ticket_opened_date, ticket_owner_email, source_channel, last_activity_date, ticket_next_step, owner_team) values (${org}, ${id}, ${`T-${id}`}, 'A ticket', 'Bug', 'Bug Report', 'Open', 'P2-Medium', '2026-07-01', 'tickets@contract.test', 'email', '2026-07-02', 'Triage', ${i % 2 === 0 ? OLD_TEAM : "Support"})`;
  }
  await db`insert into memories (org_id, scope, key, value, author_email) values (${W1}, 'team', ${`${OLD_PROFILE}early@contract.test`}, 'early', 'op@contract.test')`;
}

/** What 0037's deploy window and the 0037 release may have left behind. */
async function afterTheSwitch(db) {
  // The release before 0037, still serving during 0037's deploy window: both owner columns, its old enum values, the
  // old memory key.
  await db`insert into customers (org_id, customer_id, customer_name, account_owner, ${OWN}, value_evidence_status) values (${W1}, 'window-co', 'Window', 'window@contract.test', 'window@contract.test', ${OLD_VERIFIED})`;
  await db`insert into solutions (org_id, customer_id, solution_id, use_case, modules_enabled, solution_status, solution_owner, ${SOL}) values (${W1}, 'window-co', 'SOL-1', 'Other', '[]', 'Live', 'window@contract.test', 'window@contract.test')`;
  await db`insert into tickets (org_id, customer_id, ticket_id, summary, ticket_type, ticket_category, ticket_status, ticket_priority, ticket_opened_date, ticket_owner_email, source_channel, last_activity_date, ticket_next_step, owner_team) values (${W1}, 'window-co', 'T-window', 'Window ticket', 'Bug', 'Bug Report', 'Open', 'P2-Medium', '2026-07-03', 'tickets@contract.test', 'email', '2026-07-03', 'Triage', ${OLD_TEAM})`;
  await db`insert into memories (org_id, scope, key, value, author_email) values (${W2}, 'team', ${`${OLD_PROFILE}late@contract.test`}, 'late', 'op@contract.test')`;
  // The 0037 release: the neutral columns only; the trigger copies onto the original.
  await db`update customers set account_owner = 'switched@contract.test' where org_id = ${W1} and customer_id = 'co-003'`;
  await db`insert into solutions (org_id, customer_id, solution_id, use_case, modules_enabled, solution_status, solution_owner) values (${W1}, 'co-003', 'SOL-2', 'Other', '[]', 'Live', 'sol-switched@contract.test')`;
  // A writer that bypassed the trigger: an owner only in the original column, and a solution owner likewise.
  await db.unsafe(`ALTER TABLE customers DISABLE TRIGGER customers_owner_pair`);
  await db.unsafe(`ALTER TABLE solutions DISABLE TRIGGER solutions_owner_pair`);
  try {
    await db`update customers set account_owner = null, ${OWN} = 'bypass@contract.test' where org_id = ${W2} and customer_id = 'co-031'`;
    await db`update solutions set solution_owner = null, ${SOL} = 'sol-bypass@contract.test' where org_id = ${W2} and customer_id = 'co-032'`;
  } finally {
    await db.unsafe(`ALTER TABLE customers ENABLE TRIGGER customers_owner_pair`);
    await db.unsafe(`ALTER TABLE solutions ENABLE TRIGGER solutions_owner_pair`);
  }
}

const rowsOf = async (db, table, minus = []) =>
  (await db.unsafe(`select ${minus.length ? `to_jsonb(x) - ${minus.map((c) => `'${c}'`).join(" - ")}` : "to_jsonb(x)"} as r from ${table} x`)).map((r) => JSON.stringify(r.r)).sort();
const columns = async (db, tables = TOUCHED) => (await db`select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = any(${tables}) order by 1, 2`).map((r) => `${r.table_name}.${r.column_name} ${r.data_type} ${r.is_nullable}`);
const indexes = async (db) => (await db`select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = any(${TOUCHED}) order by indexname`).map((r) => `${r.indexname}: ${r.indexdef}`);
const triggers = async (db) => (await db`select tgname from pg_trigger where not tgisinternal and tgrelid in ('public.customers'::regclass, 'public.solutions'::regclass) order by 1`).map((r) => r.tgname);
const functions = async (db) => (await db`select proname from pg_proc where proname in ('customers_owner_pair', 'solutions_owner_pair') order by 1`).map((r) => r.proname);
/** RLS flags, every policy, and every TABLE grant in the schema (a dropped column takes its column grants with it). */
const security = async (db) => JSON.stringify({
  flags: await db`select relname, relrowsecurity, relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relkind = 'r' order by relname`,
  policies: await db`select tablename, policyname, permissive, roles::text, cmd, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2`,
  grants: await db`select grantee, table_name, privilege_type from information_schema.role_table_grants where table_schema = 'public' order by 1, 2, 3`,
});

function checkPlan(url, label) {
  const plan = driftPlan(url);
  if (plan.error) { check(`${label}: the drift dry run produced a plan`, false, plan); return; }
  const all = [...plan.apply, ...plan.aside, ...plan.refused];
  const ours = plan.apply.filter((x) => TOUCHED.some((t) => x.includes(`"${t}"`)));
  check(`${label}: the drift dry run plans nothing on customers, solutions, tickets or memories`, ours.length === 0, ours);
  check(`${label}: …and nothing the deploy would refuse (no data loss, no index drop)`, plan.refused.length === 0, plan.refused);
  check(`${label}: …and no DROP COLUMN or truncate anywhere in the plan`, all.every((x) => !/DROP\s+COLUMN|^\s*truncate/i.test(x)), all.filter((x) => /DROP|truncate/i.test(x) && !/POLICY/i.test(x)));
}

async function failClosed(db) {
  const closed = `(org_id = current_setting('app.org_id', true))`;
  for (const t of TOUCHED) await db.unsafe(`ALTER POLICY org_isolation ON "${t}" USING ${closed} WITH CHECK ${closed}`);
}

/** The release serving while 0038 deploys (this code), as app_rw under the fail-closed policies. */
async function checkServingRelease(adminDb, appUrl, label) {
  const app = postgres(appUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
  try {
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
      return out;
    });
    check(`${label}: with W1 set, every touched table returns only W1's rows`, TOUCHED.every((t) => JSON.stringify(scoped[t]) === JSON.stringify([W1])), scoped);
    const cross = await app.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${W1}, true)`;
      return tx`insert into customers (org_id, customer_id, customer_name, account_owner) values (${W2}, 'planted', 'Planted', 'x@contract.test')`;
    }).then(() => "inserted", (e) => e.code);
    check(`${label}: W1 inserting a customer stamped W2 is refused by the policy`, cross === "42501", cross);
    const before = (await adminDb`select account_owner from customers where org_id = ${W2} and customer_id = 'co-040'`)[0];
    const hit = await app.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${W1}, true)`;
      return (await tx`update customers set account_owner = 'stolen@contract.test' where customer_id = 'co-040' returning 1`).length;
    });
    check(`${label}: W1 updating W2's owner touches no row`, hit === 0 && JSON.stringify((await adminDb`select account_owner from customers where org_id = ${W2} and customer_id = 'co-040'`)[0]) === JSON.stringify(before), hit);
  } finally {
    await app.end();
  }
  process.env.DATABASE_URL = appUrl;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const dir = mkdtempSync(join(tmpdir(), "owner-contract-"));
  process.env.DATAROOM_DIR = join(dir, "dataroom");
  try {
    const sor = await import(pathToFileURL(join(ROOT, "agent/lib/system-of-record.ts")).href);
    const { closeDb } = await import(pathToFileURL(join(ROOT, "agent/lib/db/index.ts")).href);
    try {
      check(`${label}: get_customer reads an owner that was only in the original column`, (await sor.getCustomer("co-031", W2))?.accountOwner === "bypass@contract.test");
      await sor.upsertCustomer({ id: "co-004", accountOwner: "serving@contract.test", solutions: [{ solutionId: "SOL-9", useCase: "Other", modulesEnabled: [], solutionStatus: "Live", solutionOwner: "sol-serving@contract.test" }] }, W1);
      const read = await sor.getCustomer("co-004", W1);
      check(`${label}: upsert_customer writes the owner and a new solution's owner, and get_customer reads them`, read?.accountOwner === "serving@contract.test" && read?.solutions?.find((s) => s.solutionId === "SOL-9")?.solutionOwner === "sol-serving@contract.test", read && { accountOwner: read.accountOwner });
      const moved = await sor.reassignOwner("co-004", "reassigned@contract.test", "Re Assigned", W1);
      check(`${label}: reassigning reads the previous owner and writes the new one`, moved.previousOwner === "serving@contract.test" && (await sor.getCustomer("co-004", W1))?.accountOwner === "reassigned@contract.test", moved);
      check(`${label}: W1's reader never returns W2's company`, (await sor.getCustomer("co-040", W1)) === null);
    } finally {
      await closeDb?.();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  check(`the journal carries ${TAG}, after ${SWITCH_TAG}`, !!entry(TAG) && existsSync(join(ROOT, `drizzle/${TAG}.sql`)) && entry(TAG).idx === entry(SWITCH_TAG).idx + 1 && entry(TAG).when > entry(SWITCH_TAG).when, journal.entries.at(-1)?.tag);
  if (!entry(TAG)) throw new Error(`${TAG} is not in drizzle/meta/_journal.json`);
  const IDX = entry(TAG).idx;
  check("the source of 0038 does not spell the retired word (it builds every name from its letters)", !readFileSync(join(ROOT, `drizzle/${TAG}.sql`), "utf8").toLowerCase().includes(LEGACY_MEMBER.singular.toLowerCase()));

  console.log(`\nA. The live shape after 0037's deploy (pushed from ${LIVE_SCHEMA}, bootstrapped, the journal to 0036, seeded, 0037, its deploy window and its release) -> 0038`);
  {
    const { db, url, name } = await freshDb("a");
    const p = kit(["push", "--force", "--dialect=postgresql", `--schema=${LIVE_SCHEMA}`, `--url=${url}`], url);
    if (p.status !== 0 || !/Changes applied/.test(p.out)) throw new Error(`push of ${LIVE_SCHEMA} failed:\n${p.out.slice(-800)}`);
    const b = bootstrap(url);
    if (b.status !== 0) throw new Error(`bootstrap failed:\n${(b.stdout + b.stderr).slice(-800)}`);
    await applyRange(db, entry("0024_company_key_per_workspace").idx - 1, IDX - 2);
    await seed(db);
    await applyRange(db, IDX - 2, IDX - 1); // 0037, the previous deploy
    await afterTheSwitch(db);

    const cols0 = await columns(db);
    const idx0 = await indexes(db);
    const sec0 = await security(db);
    check("before 0038 the originals and the two triggers are there (the original's index went with 0037)", cols0.includes(`customers.${O} text YES`) && cols0.includes(`solutions.${SO} text YES`) && idx0.some((x) => x.startsWith(`customers_${O}_idx`)) === false && JSON.stringify(await triggers(db)) === JSON.stringify(["customers_owner_pair", "customers_secondary_owner_pair", "solutions_owner_pair"]), { cols0, trg: await triggers(db) });
    // What every owner must be after 0038: the neutral value where one is set, else the original's.
    const want = await db`select org_id, customer_id, coalesce(account_owner, ${OWN}) as v from customers order by 1, 2`;
    const wantSol = await db`select org_id, customer_id, solution_id, coalesce(solution_owner, ${SOL}) as v from solutions order by 1, 2, 3`;
    check("…and there is something for 0038 to carry: an owner and a solution owner only in the original column", want.some((r) => r.v === "bypass@contract.test") && wantSol.some((r) => r.v === "sol-bypass@contract.test"));
    const counts0 = Object.fromEntries(await Promise.all(TOUCHED.map(async (t) => [t, (await db.unsafe(`select count(*)::int as n from ${t}`))[0].n])));
    const keep = {
      customers: await rowsOf(db, "customers", ["account_owner", O, "value_evidence_status"]),
      solutions: await rowsOf(db, "solutions", ["solution_owner", SO]),
      tickets: await rowsOf(db, "tickets", ["owner_team"]),
      memories: await rowsOf(db, "memories", ["key"]),
    };

    await applyRange(db, IDX - 1, IDX);

    const got = await db`select org_id, customer_id, account_owner as v from customers order by 1, 2`;
    const gotSol = await db`select org_id, customer_id, solution_id, solution_owner as v from solutions order by 1, 2, 3`;
    check(`every account's owner (${want.length}) is in account_owner: the neutral value where it was set, else the original's`, JSON.stringify(got) === JSON.stringify(want), got.filter((r, i) => r.v !== want[i]?.v));
    check(`every solution's owner (${wantSol.length}) is in solution_owner, the same way`, JSON.stringify(gotSol) === JSON.stringify(wantSol), gotSol.filter((r, i) => r.v !== wantSol[i]?.v));
    const counts1 = Object.fromEntries(await Promise.all(TOUCHED.map(async (t) => [t, (await db.unsafe(`select count(*)::int as n from ${t}`))[0].n])));
    check("NOTHING IS LOST: every row of customers, solutions, tickets and memories is still there", JSON.stringify(counts0) === JSON.stringify(counts1), { counts0, counts1 });
    const kept = {
      customers: await rowsOf(db, "customers", ["account_owner", "value_evidence_status"]),
      solutions: await rowsOf(db, "solutions", ["solution_owner"]),
      tickets: await rowsOf(db, "tickets", ["owner_team"]),
      memories: await rowsOf(db, "memories", ["key"]),
    };
    for (const t of TOUCHED) check(`…and every other value in ${t} is exactly as it was`, JSON.stringify(kept[t]) === JSON.stringify(keep[t]));

    const stored = {
      oldTeam: (await db`select count(*)::int as n from tickets where owner_team = ${OLD_TEAM}`)[0].n,
      member: (await db`select count(*)::int as n from tickets where owner_team = 'Member'`)[0].n,
      oldVerified: (await db`select count(*)::int as n from customers where value_evidence_status = ${OLD_VERIFIED}`)[0].n,
      verified: (await db`select count(*)::int as n from customers where value_evidence_status = 'Member Verified'`)[0].n,
      oldKeys: (await db`select count(*)::int as n from memories where key like ${`${OLD_PROFILE}%`}`)[0].n,
      keys: (await db`select key from memories order by key`).map((r) => r.key),
    };
    check("the stored values the release before 0037 wrote in its window are the neutral ones (31 tickets, 21 accounts, both profile memories)", stored.oldTeam === 0 && stored.member === 31 && stored.oldVerified === 0 && stored.verified === 21 && stored.oldKeys === 0 && JSON.stringify(stored.keys) === JSON.stringify(["member-profile:early@contract.test", "member-profile:late@contract.test"]), stored);

    const cols1 = await columns(db);
    check("the two original columns are gone, and no other column changed", JSON.stringify(cols1) === JSON.stringify(cols0.filter((x) => x !== `customers.${O} text YES` && x !== `solutions.${SO} text YES`)), { lost: cols0.filter((x) => !cols1.includes(x)), added: cols1.filter((x) => !cols0.includes(x)) });
    const idx1 = await indexes(db);
    check("no index changed (the original's went with 0037), and customers_account_owner_idx is there", JSON.stringify(idx1) === JSON.stringify(idx0) && idx1.some((x) => x.startsWith("customers_account_owner_idx:")), { idx0, idx1 });
    check("both owner triggers and their functions are gone; 0029's second-owner trigger stays", JSON.stringify(await triggers(db)) === JSON.stringify(["customers_secondary_owner_pair"]) && (await functions(db)).length === 0, { triggers: await triggers(db), functions: await functions(db) });
    check("row-level security, every policy and every table grant are exactly as before 0038", (await security(db)) === sec0);

    // The factory's workspace seeding writes customers.account_owner (and nothing of the originals).
    await db`insert into customers (org_id, customer_id, customer_name, account_owner) values (${W2}, 'factory-seed', 'Seeded', 'seed@contract.test') on conflict (org_id, customer_id) do update set account_owner = excluded.account_owner`;
    check("the factory's workspace seeding (account_owner, upserted) still writes", (await db`select account_owner from customers where org_id = ${W2} and customer_id = 'factory-seed'`)[0]?.account_owner === "seed@contract.test");

    const snapshot = JSON.stringify({ c: await rowsOf(db, "customers"), s: await rowsOf(db, "solutions"), t: await rowsOf(db, "tickets"), m: await rowsOf(db, "memories"), cols: await columns(db), idx: await indexes(db) });
    await applyRange(db, IDX - 1, IDX);
    check("0038 again: nothing changes (rows, columns, indexes)", JSON.stringify({ c: await rowsOf(db, "customers"), s: await rowsOf(db, "solutions"), t: await rowsOf(db, "tickets"), m: await rowsOf(db, "memories"), cols: await columns(db), idx: await indexes(db) }) === snapshot);
    await applyRange(db, IDX, Number.MAX_SAFE_INTEGER);
    checkPlan(url, "after the journal");

    await failClosed(db);
    await checkServingRelease(db, urlOf(name, "app_rw"), "A (the serving release, fail-closed)");
    checkPlan(url, "after the writes");
    await db.end();
  }

  console.log("\nB. An empty database: push --force from schema.ts, the journal after the 0013 baseline, the bootstrap");
  {
    const { db, url } = await freshDb("b");
    const p = kit(["push", "--force", "--verbose"], url);
    check("push --force from schema.ts builds an empty database without the original columns", p.status === 0 && !(await columns(db)).some((x) => x.includes(`.${O} `) || x.includes(`.${SO} `)), p.out.slice(-600));
    await applyRange(db, 13, Number.MAX_SAFE_INTEGER);
    const b = bootstrap(url);
    check("…the journal after it (0038 among it, with nothing to drop) and the bootstrap apply", b.status === 0, (b.stdout + b.stderr).slice(-400));
    checkPlan(url, "empty database, pushed");
    await db.end();
  }

  console.log("\nC. A database built from the journal alone (0000 created the originals) against one pushed from schema.ts");
  {
    const built = await freshDb("c_journal");
    await applyRange(built.db, -1, Number.MAX_SAFE_INTEGER);
    const pushed = await freshDb("c_pushed");
    const p = kit(["push", "--force", "--verbose"], pushed.url);
    check("both build", p.status === 0, p.out.slice(-400));
    const a = await columns(built.db, ["customers", "solutions"]);
    const c = await columns(pushed.db, ["customers", "solutions"]);
    check("after the whole journal customers and solutions have exactly the columns a push from schema.ts gives them", JSON.stringify(a) === JSON.stringify(c), { onlyJournal: a.filter((x) => !c.includes(x)), onlyPush: c.filter((x) => !a.includes(x)) });
    await built.db.end();
    await pushed.db.end();
  }
} catch (error) {
  failures.push("the test itself");
  console.error(`\n✗ the test itself failed: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  for (const name of scratch) await admin.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {});
  await admin.end();
}

if (failures.length) {
  console.error(`\ntest-owner-columns-contract-db: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\ntest-owner-columns-contract-db: all ${passed} checks passed`);

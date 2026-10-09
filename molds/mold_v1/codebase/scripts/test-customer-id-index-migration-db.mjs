#!/usr/bin/env node
/**
 * drizzle/0025_drop_redundant_customer_id_indexes.sql ON A DATABASE SHAPED LIKE PRODUCTION, WITH DATA (mold_v1-145).
 *
 * Since 0024 the keys of deployments, solutions, tickets and interactions lead with (org_id, customer_id), so their
 * single-column customer_id indexes are redundant and schema.ts no longer declares them. The factory's deploy runs the
 * journal and then a drift dry run that REFUSES any index drop but one out-of-band index (scripts/lib/drift-plan.mjs,
 * as provision.py splits it). So the journal must do the drop, and the plan after it must be empty. Proven here:
 *
 *   A. THE LIVE SHAPE: pushed from the schema before #84 (scripts/fixtures/schema-419b38d.ts), bootstrapped (app_rw,
 *      row-level security), seeded, then 0024 — which is how every live database reached #84. The four indexes are
 *      there, and the drift plan against the new schema.ts REFUSES their drop (so without 0025 the deploy stops).
 *      Then 0025: the four are gone, nothing else changed (every other index, every row), the drift plan holds
 *      NOTHING to apply and nothing refused, 0025 is harmless run again, and a company's rows in one workspace are
 *      still found through the primary key.
 *   B. AN EMPTY DATABASE (the only place the chain runs `drizzle-kit push --force`): push from the new schema.ts, the
 *      journal after the 0013 baseline (0025 among it, a no-op there), the bootstrap: no customer_id index, and the
 *      plan holds nothing on the four tables.
 *
 * Needs ADMIN_URL (a role that may CREATE DATABASE). Scratch databases carry this process's pid and are dropped in a
 * finally block.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test npm run test:customer-id-index-migration-db
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
// The owner columns of the live shape (the fixture schema), by the names they had: built from the legacy word.
import { LEGACY_OWNER_KEYS as LK } from "../agent/lib/legacy-member.ts";
import { ROOT, driftPlan, kit } from "./lib/drift-plan.mjs";

const adminUrl = process.env.ADMIN_URL;
if (!adminUrl) {
  console.log("test-customer-id-index-migration-db: SKIPPED — needs ADMIN_URL (a role that may create a database).");
  process.exit(0);
}
const LIVE_SCHEMA = "scripts/fixtures/schema-419b38d.ts";
const TAG = "0025_drop_redundant_customer_id_indexes";
const TABLES = ["deployments", "solutions", "tickets", "interactions"];
const DROPPED = TABLES.map((t) => `${t}_customer_id_idx`);
const W1 = "org-idx-one";
const W2 = "org-idx-two";

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 900)}`}`); }
};

const local = /localhost|127\.0\.0\.1/.test(adminUrl);
const ssl = local ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
const urlOf = (name) => { const u = new URL(adminUrl); u.pathname = `/${name}`; return u.toString(); };
const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
const statementsOf = (tag) => readFileSync(join(ROOT, `drizzle/${tag}.sql`), "utf8").split("--> statement-breakpoint").map((v) => v.trim()).filter(Boolean);
const entry = (tag) => journal.entries.find((e) => e.tag === tag);
/** Journal entries in (from, to], each in one transaction as migrate-production.mjs applies them. */
const applyRange = async (db, fromIdx, toIdx) => {
  for (const e of journal.entries.filter((x) => x.idx > fromIdx && x.idx <= toIdx)) await db.begin(async (tx) => { for (const s of statementsOf(e.tag)) await tx.unsafe(s); });
};

const scratch = [];
async function freshDb(label) {
  const name = `cidx_${label}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.unsafe(`create database "${name}"`);
  scratch.push(name);
  return { name, url: urlOf(name), db: postgres(urlOf(name), { ssl, prepare: false, max: 1, onnotice: () => {} }) };
}
const bootstrap = (url) => spawnSync(process.execPath, [join(ROOT, "scripts/bootstrap-test-db.mjs")], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });

/** Two workspaces, 40 companies, rows in the four tables. */
async function seed(db) {
  await db`insert into orgs (org_id, name, status, created_at) values (${W1}, 'One', 'active', now() - interval '1 year'), (${W2}, 'Two', 'active', now())`;
  for (let i = 0; i < 40; i++) {
    const org = i < 20 ? W1 : W2;
    const id = `co-${String(i + 1).padStart(3, "0")}`;
    await db`insert into customers (org_id, customer_id, customer_name, tier, ${db(LK.account_owner)}) values (${org}, ${id}, ${`Company ${id}`}, 'Growth', 'owner@idx.test')`;
    for (const d of ["prod", "uat"]) await db`insert into deployments (org_id, customer_id, deployment_id, environment, region, deployed_version, release_status, health_status) values (${org}, ${id}, ${`DEP-${d}`}, ${d}, 'ap-south-1', ${`v-${id}`}, 'deployed', 'healthy')`;
    await db`insert into solutions (org_id, customer_id, solution_id, use_case, modules_enabled, solution_status, ${db(LK.solution_owner)}) values (${org}, ${id}, 'SOL-1', 'Research', '[]', 'live', 'owner@idx.test')`;
    for (const n of [1, 2]) {
      await db`insert into tickets (org_id, customer_id, ticket_id, summary, ticket_type, ticket_category, ticket_status, ticket_priority, ticket_opened_date, ticket_owner_email, source_channel, last_activity_date, ticket_next_step) values (${org}, ${id}, ${`TCK-${n}`}, ${`t${n}`}, 'Question', 'Feature Request', 'Open', 'P2-Medium', '2026-09-01', 'owner@idx.test', 'Email', '2026-09-01', 'look')`;
      await db`insert into interactions (org_id, customer_id, interaction_id, interaction_at, interaction_type, source_system, note) values (${org}, ${id}, ${`INT-${n}`}, '2026-09-01', 'note', 'manual', ${`i${n}`})`;
    }
  }
}
/** Rows hashed by value, without the columns a later journal entry adds (0028's and 0029's neutral owner columns: new, not changed). */
const LATER_COLUMNS = "- 'account_owner' - 'solution_owner' - 'secondary_owner'";
const fingerprint = async (db) => {
  const out = {};
  for (const t of ["customers", ...TABLES]) out[t] = (await db.unsafe(`select count(*)::int as n, md5(coalesce(string_agg((to_jsonb(x) ${LATER_COLUMNS})::text, '|' order by (to_jsonb(x) ${LATER_COLUMNS})::text), '')) as h from ${t} x`))[0];
  return JSON.stringify(out);
};
const indexes = async (db) => (await db`select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = any(${TABLES}) order by indexname`).map((r) => `${r.indexname}: ${r.indexdef}`);
const present = (list) => DROPPED.filter((n) => list.some((x) => x.startsWith(`${n}:`)));
const touchesOurs = (x) => TABLES.some((t) => x.includes(`"${t}"`)) || DROPPED.some((n) => x.includes(n));

/** A company's rows in one workspace, with sequential scans off: served by an index, and it is the primary key. */
async function checkKeyServes(db, label) {
  const bad = [];
  await db.begin(async (tx) => {
    await tx.unsafe("set local enable_seqscan = off");
    for (const t of TABLES) {
      const plan = (await tx.unsafe(`explain select * from ${t} where org_id = '${W1}' and customer_id = 'co-001'`)).map((r) => r["QUERY PLAN"]).join("\n");
      if (!plan.includes(`${t}_org_id_customer_id_`) || !/_pk\b/.test(plan)) bad.push({ t, plan });
    }
  });
  check(`${label}: a company's rows in one workspace are found through each table's (org_id, customer_id, …) primary key`, bad.length === 0, bad);
}

try {
  console.log(`\nA. The live shape (pushed from ${LIVE_SCHEMA}, bootstrapped, seeded, then 0024) -> 0025 -> the drift dry run`);
  {
    const { db, url } = await freshDb("a");
    const p = kit(["push", "--force", "--dialect=postgresql", `--schema=${LIVE_SCHEMA}`, `--url=${url}`], url);
    if (p.status !== 0 || !/Changes applied/.test(p.out)) throw new Error(`push of ${LIVE_SCHEMA} failed:\n${p.out.slice(-800)}`);
    const b = bootstrap(url);
    if (b.status !== 0) throw new Error(`bootstrap failed:\n${(b.stdout + b.stderr).slice(-800)}`);
    await seed(db);
    await applyRange(db, entry(TAG).idx - 2, entry(TAG).idx - 1); // 0024, as the live databases took it
    const before = await indexes(db);
    check("after 0024 the live shape still carries the four customer_id indexes", present(before).length === 4, before);
    const planBefore = driftPlan(url);
    const refusedBefore = planBefore.refused ?? [];
    check(
      "…and the drift plan against schema.ts REFUSES their drop (without 0025 the deploy stops here)",
      !planBefore.error && DROPPED.every((n) => refusedBefore.some((x) => x.includes(`"${n}"`))),
      planBefore.error ? planBefore : refusedBefore,
    );
    const f0 = await fingerprint(db);
    await applyRange(db, entry(TAG).idx - 1, entry(TAG).idx);
    const after = await indexes(db);
    check("0025 drops the four customer_id indexes", present(after).length === 0, after);
    check("…and no other index on the four tables", JSON.stringify(after) === JSON.stringify(before.filter((x) => !DROPPED.some((n) => x.startsWith(`${n}:`)))), { before, after });
    check("…and no row is lost or changed", (await fingerprint(db)) === f0);
    // The deploy runs the WHOLE journal before its drift step: any entry after 0025 (0026 adds org_invites.origin)
    // is applied too, so the plan below compares the database the deploy would really leave behind.
    await applyRange(db, entry(TAG).idx, Math.max(...journal.entries.map((e) => e.idx)));
    const plan = driftPlan(url);
    check("after 0025 the drift dry run plans NOTHING to apply", !plan.error && plan.apply.length === 0, plan.error ? plan : plan.apply);
    check("…and nothing the deploy would refuse (no data loss, no index drop)", !plan.error && plan.refused.length === 0, plan.refused);
    check(`…and what it sets aside (${plan.aside?.length ?? "?"} statements) is only policy / row-level-security noise`, !plan.error && plan.aside.every((x) => !/INDEX|CONSTRAINT/i.test(x)), plan.aside);
    await applyRange(db, entry(TAG).idx - 1, entry(TAG).idx);
    check("0025 again: nothing changes", JSON.stringify(await indexes(db)) === JSON.stringify(after) && (await fingerprint(db)) === f0);
    await checkKeyServes(db, "A");
    await db.end();
  }

  console.log("\nB. An empty database: push --force from the new schema.ts, the journal after the 0013 baseline, the bootstrap");
  {
    const { db, url } = await freshDb("b");
    const p = kit(["push", "--force", "--verbose"], url);
    check("push --force from the new schema.ts builds an empty database", p.status === 0 && /Changes applied/.test(p.out), p.out.slice(-600));
    check("…without the four customer_id indexes", present(await indexes(db)).length === 0);
    await applyRange(db, 13, Number.MAX_SAFE_INTEGER);
    const b = bootstrap(url);
    check("…the journal after it (0014 to 0025; 0025 a no-op) and the bootstrap apply", b.status === 0, (b.stdout + b.stderr).slice(-400));
    await seed(db);
    const plan = driftPlan(url);
    const ours = plan.apply?.filter(touchesOurs) ?? [];
    check("the drift dry run plans nothing on the four tables", !plan.error && ours.length === 0, plan.error ? plan : ours);
    check("…and nothing the deploy would refuse", !plan.error && plan.refused.length === 0, plan.refused);
    await checkKeyServes(db, "B");
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
  console.error(`\ntest-customer-id-index-migration-db: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\ntest-customer-id-index-migration-db: all ${passed} checks passed`);

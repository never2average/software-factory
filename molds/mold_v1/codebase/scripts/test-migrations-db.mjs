#!/usr/bin/env node
/**
 * THE MIGRATION JOURNAL BUILDS THE SCHEMA THE APP READS (mold_v1-089).
 *
 * A new deployment's database is built by `npm run db:migrate:production`, which applies drizzle/meta/_journal.json
 * in order. CI builds its database with `drizzle-kit push` from agent/lib/db/schema.ts instead, so nothing noticed
 * when the two disagreed: `implementation.onfinance_launch_approver_email` was renamed to
 * `provider_launch_approver_email` in schema.ts and on the live database by a one-off script, never in the journal,
 * and on a journal-built database every read of the implementation table failed ("column … does not exist").
 *
 * This builds a scratch database from the journal exactly as scripts/migrate-production.mjs does (each file split on
 * `--> statement-breakpoint`, each migration in one transaction) and checks:
 *
 *   1. the implementation table has provider_launch_approver_email and not the vendor-named column, and the app's
 *      own read of it (drizzle `select *` from schema.ts) works;
 *   2. 0023 is harmless run again, and on a database that has BOTH columns it copies the old values into empty new
 *      cells without dropping anything;
 *   3. a ratchet: every column the pushed schema has, the journal-built one has too, except the drift listed below
 *      with the script that applies it outside the journal. A new difference fails here, so the next rename cannot
 *      skip the journal silently.
 *
 * Needs ADMIN_URL (a role that may CREATE DATABASE) pointing at a database drizzle-kit push has built (CI's
 * `isolation` job). The scratch database carries this process's pid and is dropped in a finally block.
 *
 *   ADMIN_URL=postgres://postgres:…@127.0.0.1:5432/fde_test npm run test:migrations-db
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

const adminUrl = process.env.ADMIN_URL;
if (!adminUrl) {
  console.log("test-migrations-db: SKIPPED — needs ADMIN_URL (a role that may create a database).");
  process.exit(0);
}

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}`}`); }
};

/**
 * Known differences between the journal and schema.ts, each applied to the live database by a script outside the
 * journal. Listed so that a NEW difference fails; each is a candidate for its own journal migration.
 */
const KNOWN_DRIFT = [
  { re: /^[a-z_]+\.org_id text (NO|YES)$/, why: "org_id NOT NULL: .migrate-org-not-null.mjs / .migrate-org-tenancy-tighten.mjs" },
  { re: /^inbox_items\./, why: "the inbox table: .migrate-inbox.mjs, .migrate-inbox-read.mjs" },
  { re: /^login_codes\./, why: "email sign-in codes: .migrate-login-codes.mjs" },
  { re: /^browser_sessions\.control_(held_at|held_by|expires_at) /, why: "browser control lease: .migrate-browser-control.mjs" },
  { re: /^connectors\.owner_email /, why: "per-person connectors: .migrate-connector-scope.mjs" },
  { re: /^org_members\.last_selected_at /, why: "the active workspace: .migrate-active-workspace.mjs" },
];

const local = /localhost|127\.0\.0\.1/.test(adminUrl);
const ssl = local ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
const SCRATCH = `migtest_${process.pid}`;
const scratchUrl = (() => { const u = new URL(adminUrl); u.pathname = `/${SCRATCH}`; return u.toString(); })();
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
const statementsOf = (tag) => readFileSync(`drizzle/${tag}.sql`, "utf8").split("--> statement-breakpoint").map((v) => v.trim()).filter(Boolean);
const COLUMNS = `select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable as c
                 from information_schema.columns where table_schema = 'public' order by 1`;

let db = null;
try {
  await admin.unsafe(`create database "${SCRATCH}"`);
  db = postgres(scratchUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });

  console.log("\n1. A database built from the journal has the column schema.ts names");
  const failed = [];
  for (const entry of journal.entries) {
    try {
      await db.begin(async (tx) => { for (const s of statementsOf(entry.tag)) await tx.unsafe(s); });
    } catch (e) {
      failed.push(`${entry.tag}: ${e.message}`);
    }
  }
  check(`every journal migration applies to an empty database (${journal.entries.length})`, failed.length === 0, failed);
  const implCols = (await db`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'implementation'`).map((r) => r.column_name);
  check("implementation has provider_launch_approver_email", implCols.includes("provider_launch_approver_email"), implCols);
  check("…and not the vendor-named onfinance_launch_approver_email", !implCols.includes("onfinance_launch_approver_email"));
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("../agent/lib/db/schema.ts");
  let readError = null;
  try {
    await drizzle(db, { schema }).select().from(schema.implementation).limit(1);
  } catch (e) {
    readError = e.cause?.message ?? e.message;
  }
  check("the app's own read of the implementation table works on it", readError === null, readError);

  console.log("\n2. 0023 again, and on a database with both columns");
  const tag = journal.entries.find((e) => e.tag.includes("provider_launch_approver"))?.tag;
  check("0023 is in the journal", Boolean(tag));
  const run = async () => db.begin(async (tx) => { for (const s of statementsOf(tag)) await tx.unsafe(s); });
  await run();
  await run();
  check("run twice more: harmless", (await db`select count(*)::int as n from information_schema.columns where table_name = 'implementation' and column_name = 'provider_launch_approver_email'`)[0].n === 1);
  await db.unsafe(`alter table implementation add column onfinance_launch_approver_email text`);
  await db.unsafe(`insert into customers (customer_id, org_id, customer_name) values ('c1', 'o1', 'C1'), ('c2', 'o1', 'C2')`);
  await db.unsafe(`insert into implementation (customer_id, org_id, implementation_stage, implementation_progress_pct, implementation_risk_level, blocker_owner, onfinance_launch_approver_email, provider_launch_approver_email)
                   values ('c1', 'o1', 'UAT', 1, 'Green', 'None', 'old@example.com', null), ('c2', 'o1', 'UAT', 1, 'Green', 'None', 'old2@example.com', 'kept@example.com')`);
  await run();
  const rows = await db`select customer_id, provider_launch_approver_email as p, onfinance_launch_approver_email as o from implementation order by 1`;
  check("both columns: an empty new cell takes the old value, a filled one is kept, nothing is dropped",
    rows[0].p === "old@example.com" && rows[1].p === "kept@example.com" && rows[0].o === "old@example.com", rows);
  await db.unsafe(`alter table implementation drop column onfinance_launch_approver_email`);

  console.log("\n3. The journal and schema.ts agree, apart from the drift listed with its script");
  const pushed = new Set((await admin.unsafe(COLUMNS)).map((r) => r.c));
  const built = new Set((await db.unsafe(COLUMNS)).map((r) => r.c));
  const differ = [...[...pushed].filter((c) => !built.has(c)).map((c) => `only in schema.ts: ${c}`), ...[...built].filter((c) => !pushed.has(c)).map((c) => `only in the journal: ${c}`)];
  const unexplained = differ.filter((d) => !KNOWN_DRIFT.some((k) => k.re.test(d.replace(/^only in [^:]+: /, ""))));
  check(`every difference is a known one (${differ.length} known, ${unexplained.length} new)`, unexplained.length === 0, unexplained);
  const stale = KNOWN_DRIFT.filter((k) => !differ.some((d) => k.re.test(d.replace(/^only in [^:]+: /, ""))));
  check("…and every known one still differs (a fixed one comes off the list)", stale.length === 0, stale.map((k) => k.why));
} finally {
  if (db) await db.end();
  await admin.unsafe(`drop database if exists "${SCRATCH}"`).catch(() => {});
  await admin.end();
}

if (failures.length) {
  console.error(`\ntest-migrations-db: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\ntest-migrations-db: all ${passed} checks passed`);

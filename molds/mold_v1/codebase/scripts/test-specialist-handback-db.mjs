#!/usr/bin/env node
/**
 * ONE HAND-BACK PER STOPPED SPECIALIST, ACROSS PROCESSES — the durable claim, against a real Postgres.
 *
 * The agent runs as many serverless instances. Two Stops on the same specialist can land on two of them, and a
 * memory of "already doing this" (the first version's in-process set) holds in one. The claim is a row in
 * `specialist_handbacks` (agent/lib/handback-ledger.ts): this test starts TWO SEPARATE node processes per round,
 * each with its own connection as app_rw (no BYPASSRLS), releases them at the same instant, and requires exactly one
 * to win — then the same for taking over an undelivered hand-back. It also checks the row is the workspace's: written
 * and read inside that workspace's row-level scope, invisible from another's.
 *
 * Needs ADMIN_URL (seeding, catalog reads) and DATABASE_URL (app_rw), a database built by `drizzle-kit push` +
 * scripts/bootstrap-test-db.mjs (CI's isolation job).
 *
 *   ADMIN_URL=… DATABASE_URL=postgres://app_rw:…  npm run test:specialist-handback-db
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { ROOT, driftPlan, kit } from "./lib/drift-plan.mjs";

const SELF = fileURLToPath(import.meta.url);

/* ---- worker: one "instance" ------------------------------------------------------------------------------------ */
if (process.argv[2] === "--worker") {
  const [, , , op, org, parent, child, turn, startAt] = process.argv;
  const { agentGateDb } = await import("../agent/lib/session-owners.ts");
  const { handbackLedger } = await import("../agent/lib/handback-ledger.ts");
  const db = agentGateDb();
  const ledger = handbackLedger(db, org);
  await db.ping(); // connected before the gun
  await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
  const out = op === "claim" ? await ledger.claim({ parentSessionId: parent, childSessionId: child, turnId: turn }) : (await ledger.retry(parent, child)) ? "took" : "none";
  process.stdout.write(out);
  process.exit(0);
}

const adminUrl = process.env.ADMIN_URL;
if (!adminUrl || !process.env.DATABASE_URL) {
  console.log("test-specialist-handback-db: SKIPPED — needs ADMIN_URL (seeding) and DATABASE_URL (app_rw).");
  process.exit(0);
}
let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
};
const admin = postgres(adminUrl, { ssl: /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require", prepare: false, max: 1, onnotice: () => {} });
const ORG_A = `org_hb_a_${process.pid}`;
const ORG_B = `org_hb_b_${process.pid}`;
const worker = (op, org, parent, child, turn, startAt) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server", SELF, "--worker", op, org, parent, child, turn, String(startAt)], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("exit", (code) => resolve(code === 0 ? out : `error: ${err.slice(-300)}`));
  });

try {
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${ORG_A}, 'Handback A', 'active'), (${ORG_B}, 'Handback B', 'active')`;

  console.log("the table is a tenant table like its neighbours:");
  const [rls] = await admin`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'specialist_handbacks'`;
  check("row-level security is enabled and FORCED on specialist_handbacks", rls?.relrowsecurity === true && rls?.relforcerowsecurity === true, rls);
  const policies = await admin`select policyname from pg_policies where tablename = 'specialist_handbacks'`;
  check("…with the workspace policy", policies.some((p) => p.policyname === "org_isolation"), policies);
  const [role] = await admin`select rolbypassrls from pg_roles where rolname = 'app_rw'`;
  check("…and the app's role cannot bypass it (or every check below would be vacuous)", role?.rolbypassrls === false, role);
  const pk = await admin`select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = 'specialist_handbacks'::regclass and i.indisprimary`;
  check("…keyed by (parent session, stopped child, turn)", pk.map((r) => r.attname).sort().join() === "child_session_id,parent_session_id,turn_id", pk);

  console.log("\ntwo processes, one database, the same instant:");
  const ROUNDS = 12;
  const tally = [];
  for (let i = 0; i < ROUNDS; i++) {
    const parent = `wrun_hb_parent_${process.pid}_${i}`;
    const child = `wrun_hb_child_${process.pid}_${i}`;
    const startAt = Date.now() + 1_500;
    tally.push((await Promise.all([worker("claim", ORG_A, parent, child, "turn_0", startAt), worker("claim", ORG_A, parent, child, "turn_0", startAt)])).sort().join("+"));
  }
  check(`${ROUNDS} rounds of two simultaneous claims: exactly one wins every time`, tally.every((t) => t === "held+won"), tally);
  const rows = await admin`select count(*)::int as n from specialist_handbacks where org_id = ${ORG_A}`;
  check("…and there is one row per stopped specialist, not two", rows[0].n === ROUNDS, rows);

  console.log("\ntaking over an undelivered hand-back, two processes:");
  const P = `wrun_hb_parent_${process.pid}_0`;
  const C = `wrun_hb_child_${process.pid}_0`;
  check("a claimed hand-back is not up for retry", (await worker("retry", ORG_A, P, C, "-", Date.now())) === "none");
  const takeovers = [];
  for (let i = 0; i < 6; i++) {
    await admin`update specialist_handbacks set status = 'undelivered', message = 'the saved text' where parent_session_id = ${P} and child_session_id = ${C}`;
    const startAt = Date.now() + 1_500;
    takeovers.push((await Promise.all([worker("retry", ORG_A, P, C, "-", startAt), worker("retry", ORG_A, P, C, "-", startAt)])).sort().join("+"));
  }
  check("6 rounds of two simultaneous retries of one undelivered hand-back: exactly one takes it", takeovers.every((t) => t === "none+took"), takeovers);
  await admin`update specialist_handbacks set status = 'claimed', updated_at = now() - interval '10 minutes' where parent_session_id = ${P} and child_session_id = ${C}`;
  check("a claim whose holder went quiet for minutes can be taken over", (await worker("retry", ORG_A, P, C, "-", Date.now())) === "took");
  await admin`update specialist_handbacks set status = 'delivered' where parent_session_id = ${P} and child_session_id = ${C}`;
  check("a DELIVERED hand-back is never taken again", (await worker("retry", ORG_A, P, C, "-", Date.now())) === "none");
  check("…nor claimed again", (await worker("claim", ORG_A, P, C, "turn_0", Date.now())) === "held");

  console.log("\nthe ledger itself, in this process, as app_rw inside a workspace's scope:");
  const { agentGateDb } = await import("../agent/lib/session-owners.ts");
  const { handbackLedger } = await import("../agent/lib/handback-ledger.ts");
  const db = agentGateDb();
  const a = handbackLedger(db, ORG_A);
  const b = handbackLedger(db, ORG_B);
  const key = { parentSessionId: `wrun_hb_p_${process.pid}`, childSessionId: `wrun_hb_c_${process.pid}`, turnId: "turn_3" };
  check("claim → write → settle keeps the text", (await a.claim(key)) === "won");
  await a.write(key, "HELD RESULT TEXT");
  await a.settle(key, "undelivered");
  const [row] = await admin`select org_id, status, message from specialist_handbacks where parent_session_id = ${key.parentSessionId}`;
  check("…in the caller's workspace, undelivered, with the held text on record", row?.org_id === ORG_A && row?.status === "undelivered" && row?.message === "HELD RESULT TEXT", row);
  const seenFromB = await db.inOrg(ORG_B, (tx) => tx.execute(`select count(*)::int as n from specialist_handbacks where parent_session_id = '${key.parentSessionId}'`));
  check("another workspace cannot see the row", Number((Array.isArray(seenFromB) ? seenFromB : seenFromB.rows)[0].n) === 0, seenFromB);
  check("…cannot take its text", (await b.retry(key.parentSessionId, key.childSessionId)) === null);
  await b.settle(key, "delivered");
  await b.release(key);
  const [still] = await admin`select status, message from specialist_handbacks where parent_session_id = ${key.parentSessionId}`;
  check("…and cannot settle or release it", still?.status === "undelivered" && still?.message === "HELD RESULT TEXT", still);
  const taken = await a.retry(key.parentSessionId, key.childSessionId);
  check("its own workspace takes it over, with the turn it belongs to and the text", taken?.key.turnId === "turn_3" && taken?.message === "HELD RESULT TEXT", taken);
  const other = { ...key, turnId: "turn_4" };
  check("the same specialist session under another turn is another hand-back", (await a.claim(other)) === "won");
  await a.release(other);
  check("a released claim leaves nothing", (await admin`select 1 from specialist_handbacks where parent_session_id = ${key.parentSessionId} and turn_id = 'turn_4'`).length === 0);
  await a.settle(key, "delivered");
  await a.release(key);
  check("release never removes a delivered hand-back (it is the record that it was sent)", (await admin`select 1 from specialist_handbacks where parent_session_id = ${key.parentSessionId} and turn_id = 'turn_3'`).length === 1);

  /* ---- the migration: additive, in step with schema.ts, the drift plan empty after it ---------------------------- */
  console.log("\ndrizzle/0031_specialist_handbacks.sql on a database as the live ones are before it:");
  const TAG = "0031_specialist_handbacks";
  const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
  const at = journal.entries.findIndex((e) => e.tag === TAG);
  // Not necessarily the newest: a later entry (0032's apps.starter_key) comes after it. Every entry is numbered by its place.
  check(`the journal carries ${TAG}, numbered after the one before`, at > 0 && journal.entries[at].idx === journal.entries[at - 1].idx + 1 && journal.entries.every((e, i) => e.idx === i), journal.entries.slice(at - 1, at + 2));
  const statements = readFileSync(join(ROOT, `drizzle/${TAG}.sql`), "utf8").split("--> statement-breakpoint").map((v) => v.trim()).filter(Boolean);
  check("it is additive: it creates one table and its index, and alters or drops nothing else", statements.every((x) => !/\bDROP\s+(TABLE|COLUMN|INDEX)\b|\bALTER\s+TABLE\s+"(?!specialist_handbacks")/i.test(x.replace(/^--.*$/gm, ""))), statements.map((x) => x.split("\n").pop().slice(0, 60)));
  const SCRATCH = `hbmig_${process.pid}`;
  const scratchUrl = (() => { const u = new URL(adminUrl); u.pathname = `/${SCRATCH}`; return u.toString(); })();
  await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`);
  await admin.unsafe(`create database "${SCRATCH}"`);
  const sdb = postgres(scratchUrl, { ssl: false, prepare: false, max: 1, onnotice: () => {} });
  try {
    const pushed = kit(["push", "--force", "--verbose"], scratchUrl);
    check("a database built from schema.ts has the table", pushed.status === 0 && (await sdb`select 1 from information_schema.tables where table_name = 'specialist_handbacks'`).length === 1, pushed.out.slice(-300));
    // …made into the shape every live database has today: everything but this table.
    await sdb.unsafe('drop table "specialist_handbacks"');
    const before = driftPlan(scratchUrl);
    check("before 0031 the drift plan against schema.ts names the table, and only it (so an empty plan after means something)", !before.error && before.apply.length >= 1 && before.apply.every((x) => /specialist_handbacks/.test(x)) && before.refused.length === 0, before.error ? before : { apply: before.apply.map((x) => x.slice(0, 80)), refused: before.refused });
    await sdb.begin(async (tx) => { for (const x of statements) await tx.unsafe(x); });
    const after = driftPlan(scratchUrl);
    check("after 0031 the drift dry run plans NOTHING to apply, and refuses nothing", !after.error && after.apply.length === 0 && after.refused.length === 0, after.error ? after : { apply: after.apply, refused: after.refused });
    check("…what it sets aside is only policy / row-level-security noise", !after.error && after.aside.every((x) => !/COLUMN|INDEX|CONSTRAINT|TRIGGER/i.test(x)), after.aside);
    const [flags] = await sdb`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'specialist_handbacks'`;
    const pol = await sdb`select policyname, qual, with_check from pg_policies where tablename = 'specialist_handbacks'`;
    check("the migration itself enables and forces row-level security and creates the workspace policy", flags?.relrowsecurity && flags?.relforcerowsecurity && pol.length === 1 && pol[0].policyname === "org_isolation" && /app\.org_id/.test(pol[0].qual) && /app\.org_id/.test(pol[0].with_check), { flags, pol });
    await sdb.begin(async (tx) => { for (const x of statements) await tx.unsafe(x); });
    check("run again it changes nothing", (await sdb`select policyname from pg_policies where tablename = 'specialist_handbacks'`).length === 1 && driftPlan(scratchUrl).apply?.length === 0);
  } finally {
    await sdb.end({ timeout: 2 });
    await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`).catch(() => {});
  }
} finally {
  await admin`delete from specialist_handbacks where org_id in (${ORG_A}, ${ORG_B})`.catch(() => {});
  await admin`delete from orgs where org_id in (${ORG_A}, ${ORG_B})`.catch(() => {});
  await admin.end({ timeout: 2 });
}
if (failures.length) {
  console.error(`\ntest-specialist-handback-db: ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`\ntest-specialist-handback-db: ${passed} checks passed`);
process.exit(0);

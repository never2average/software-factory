#!/usr/bin/env node
/**
 * THE TWO ACCOUNT RECORD AREAS, DRAWN FROM THEIR DEFINITION OR NOT, AGAINST A REAL POSTGRES, as the restricted app_rw role
 * under the production FAIL-CLOSED policies (scripts/lib/record-area-db-probe.mjs, run twice):
 *
 *   1. the default definitions (this checkout): today's routes and writes as before; a list query filtered, sorted
 *      and paged in the database; a key outside the definition refused;
 *   2. declared ones (a copy under scripts/fixtures/record-areas/examples/research.json, a "Coverage report" for
 *      deployments, and programme.json, a "Compliance programme" for implementations): every write through the one
 *      validator (the ops routes, upsert_customer's nested rows, the per-area tools), own fields merged per key, the
 *      list filtered and sorted on columns and own fields, paged by a cursor;
 *   both: workspace B, holding an account with the same id, reaches none of A's records.
 *
 *   0. the migration (drizzle/0043_record_areas_custom_gin.sql): a GIN index on each area's `custom`, additive, safe twice,
 *      and the deploy's drift plan names exactly those two before it and nothing after;
 *   3. a strict lifecycle (research-strict.json on top): the agent's write paths (upsert_customer's nested rows, the
 *      per-area tool) read the writer's workspace role and who entered a state, and note every move.
 *
 * Needs ADMIN_URL (policy DDL, seeding) and DATABASE_URL (app_rw); without them it skips. Every policy is restored.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test \
 *   DATABASE_URL=postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test \
 *   npm run test:record-area-db
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { copyWithProfiles } from "./lib/profile-copy.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-record-area-db: SKIPPED — needs ADMIN_URL (policy DDL) and DATABASE_URL (app_rw).");
  process.exit(0);
}
const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
let failures = 0;
let passed = 0;
const saved = new Map();
const check = (what, ok, detail) => {
  if (ok) { passed++; console.log(`  ok   ${what}`); }
  else { failures++; console.log(`  FAIL ${what}${detail === undefined ? "" : ` — ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 600)}`}`); }
};
try {
  console.log("0. The migration (drizzle/0043_record_areas_custom_gin.sql)");
  {
    const TAG = "0043_record_areas_custom_gin";
    const IDX = { deployments: "deployments_custom_idx", implementation: "implementation_custom_idx" };
    for (const [table, name] of Object.entries(IDX)) {
      const [idx] = await admin`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${table} AND indexname = ${name}`;
      check(`${table}.custom has a GIN jsonb_path_ops index`, idx?.indexdef === `CREATE INDEX ${name} ON public.${table} USING gin (custom jsonb_path_ops)`, idx);
    }
    const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    check(`the journal carries ${TAG}, numbered after the one before`, at > 0 && journal.entries[at].idx === journal.entries[at - 1].idx + 1 && journal.entries[at].idx === 43, journal.entries[at]);
    const statements = readFileSync(join(ROOT, `drizzle/${TAG}.sql`), "utf8").split("--> statement-breakpoint").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
    check("it is additive: the two indexes, IF NOT EXISTS, nothing altered, dropped, written or secured", statements.length === 2 && statements.every((x, i) => x === `CREATE INDEX IF NOT EXISTS "${Object.values(IDX)[i]}" ON "${Object.keys(IDX)[i]}" USING gin ("custom" jsonb_path_ops);`), statements);
    let again = "ok";
    try { for (let i = 0; i < 2; i++) for (const x of statements) await admin.unsafe(x); } catch (e) { again = String(e?.message ?? e); }
    check("applying it twice more is harmless", again === "ok", again);
    const { driftPlan, kit } = await import("./lib/drift-plan.mjs");
    const SCRATCH = `areas_gin_${process.pid}`;
    const scratchUrl = (() => { const u = new URL(adminUrl); u.pathname = `/${SCRATCH}`; return u.toString(); })();
    await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`);
    await admin.unsafe(`create database "${SCRATCH}"`);
    const sdb = postgres(scratchUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
    try {
      const pushed = kit(["push", "--force", "--verbose"], scratchUrl);
      const plan = driftPlan(scratchUrl);
      check("a database built from schema.ts has both indexes, and its drift plan is empty", pushed.status === 0 && !plan.error && plan.apply.length === 0 && plan.refused.length === 0 && (await sdb`select 1 from pg_indexes where indexname in ('deployments_custom_idx', 'implementation_custom_idx')`).length === 2, plan.error ? plan : { apply: plan.apply, refused: plan.refused });
      await sdb.unsafe('drop index "deployments_custom_idx"; drop index "implementation_custom_idx"');
      const before = driftPlan(scratchUrl);
      check("before 0043 the drift plan names the two indexes, and only them", !before.error && before.apply.length === 2 && before.apply.some((x) => /deployments_custom_idx/.test(x)) && before.apply.some((x) => /implementation_custom_idx/.test(x)) && before.refused.length === 0, before.error ? before : { apply: before.apply, refused: before.refused });
      await sdb.begin(async (tx) => { for (const x of statements) await tx.unsafe(x); });
      const after = driftPlan(scratchUrl);
      check("after 0043 the drift dry run plans NOTHING, and refuses nothing", !after.error && after.apply.length === 0 && after.refused.length === 0, after.error ? after : { apply: after.apply, refused: after.refused });
    } finally {
      await sdb.end({ timeout: 2 });
      await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`).catch(() => {});
    }
  }

  const policies = await admin`SELECT tablename, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND policyname = 'org_isolation'`;
  if (!policies.length) throw new Error("no org_isolation policies — run scripts/bootstrap-test-db.mjs first");
  const closed = `(org_id = current_setting('app.org_id', true))`;
  for (const p of policies) {
    saved.set(p.tablename, p);
    await admin.unsafe(`ALTER POLICY org_isolation ON "${p.tablename}" USING ${closed} WITH CHECK ${closed}`);
  }
  console.log(`org_isolation on ${policies.length} tables set to the production FAIL-CLOSED shape`);
  const PROBE = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server", "scripts/lib/record-area-db-probe.mjs"];
  const run = (label, cwd) => {
    const r = spawnSync(process.execPath, PROBE, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    const out = `${r.stdout}${r.stderr}`;
    const lines = out.split("\n").filter((l) => /^\s+(ok|FAIL) /.test(l));
    for (const l of lines) console.log(l);
    const oks = lines.filter((l) => /^\s+ok /.test(l)).length;
    const bad = lines.filter((l) => /^\s+FAIL /.test(l)).length;
    passed += oks;
    failures += bad;
    const finished = new RegExp(`record-area-db-probe \\[${label}\\]: \\d+ passed`).test(out) && oks > 5 && (r.status === 0) === (bad === 0);
    if (finished) passed += 1;
    else {
      failures += 1;
      console.log(`  FAIL ${label}: the probe did not finish under that definition — ${out.slice(-1500)}`);
    }
  };
  console.log("\n1. The default definitions (this checkout)");
  run("default", ROOT);
  console.log("\n2. Declared areas: a coverage report (deployments) and a compliance programme (implementations), in a copy");
  const EX = join(ROOT, "scripts/fixtures/record-areas/examples");
  const copy = copyWithProfiles(ROOT, [["50-research.json", join(EX, "research.json")], ["51-programme.json", join(EX, "programme.json")]]);
  try {
    run("declared", copy.dir);
  } finally {
    copy.remove();
  }
  console.log("\n3. A strict lifecycle on the coverage report (research-strict.json on top), through the agent's write paths");
  const strict = copyWithProfiles(ROOT, [["50-research.json", join(EX, "research.json")], ["51-programme.json", join(EX, "programme.json")], ["52-strict.json", join(EX, "research-strict.json")]]);
  try {
    run("strict", strict.dir);
  } finally {
    strict.remove();
  }
} catch (e) {
  failures++;
  console.log(`  FAIL the test threw — ${e?.stack ?? e}`);
} finally {
  for (const [table, p] of saved) await admin.unsafe(`ALTER POLICY org_isolation ON "${table}" USING (${p.qual}) WITH CHECK (${p.with_check ?? p.qual})`).catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`\ntest-record-area-db: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

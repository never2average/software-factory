#!/usr/bin/env node
/**
 * THE PERIODS AS A RECORD AREA, AGAINST A REAL POSTGRES, as the restricted app_rw role under the production FAIL-CLOSED
 * policies (scripts/lib/period-area-db-probe.mjs, run in three definitions):
 *
 *   0. the migration (drizzle/0045_cycles_custom.sql): `cycles.custom` jsonb NOT NULL DEFAULT '{}' and a GIN index over
 *      the column (no expression index), additive, harmless applied twice over rows it keeps byte for byte, and the
 *      deploy's drift plan names exactly the two before it and nothing after;
 *   1. the default definitions (this checkout): the cycles routes and the period tools answer what they always did (no
 *      `custom` on the wire, today's three states, the route's own refusal of a field it does not take);
 *   2. a declared period (scripts/fixtures/record-areas/examples/filing-period.json, a "Regulatory filing"): own fields
 *      written and merged per key at write time, declared states and moves (warn), every refusal in a sentence that
 *      stores nothing, the tools taking and returning the same;
 *   3. the same with auto rollover (a length, rollover on): the system closes an ended period in a done state by the
 *      declared transition, opens and starts the next by category, and writes its moves to the feed;
 *   every run: workspace B reaches none of A's periods through the routes, the tools or the rows under RLS.
 *
 * Needs ADMIN_URL (policy DDL, seeding) and DATABASE_URL (app_rw); without them it skips. Every policy is restored.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test \
 *   DATABASE_URL=postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test \
 *   npm run test:period-area-db
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
  console.log("test-period-area-db: SKIPPED — needs ADMIN_URL (policy DDL) and DATABASE_URL (app_rw).");
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
  console.log("0. The migration (drizzle/0045_cycles_custom.sql)");
  {
    const TAG = "0045_cycles_custom";
    const [col] = await admin`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cycles' AND column_name = 'custom'`;
    check("cycles.custom is jsonb, NOT NULL, default '{}'", col?.data_type === "jsonb" && col.is_nullable === "NO" && col.column_default === "'{}'::jsonb", col);
    const [idx] = await admin`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'cycles' AND indexname = 'cycles_custom_idx'`;
    check("cycles.custom has a GIN jsonb_path_ops index over the column (no expression)", idx?.indexdef === "CREATE INDEX cycles_custom_idx ON public.cycles USING gin (custom jsonb_path_ops)", idx);
    const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    check(`the journal carries ${TAG}, numbered after the one before`, at > 0 && journal.entries[at].idx === journal.entries[at - 1].idx + 1 && journal.entries[at].idx === 45, journal.entries[at]);
    const statements = readFileSync(join(ROOT, `drizzle/${TAG}.sql`), "utf8").split("--> statement-breakpoint").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
    check("it is additive: one column with a default and one index, IF NOT EXISTS; nothing altered, dropped, written or secured", statements.length === 2 && statements[0] === `ALTER TABLE "cycles" ADD COLUMN IF NOT EXISTS "custom" jsonb DEFAULT '{}'::jsonb NOT NULL;` && statements[1] === `CREATE INDEX IF NOT EXISTS "cycles_custom_idx" ON "cycles" USING gin ("custom" jsonb_path_ops);`, statements);
    const ORG = `org-cycles-custom-mig-${process.pid}`;
    await admin`INSERT INTO orgs (org_id, name, status) VALUES (${ORG}, 'Cycles custom migration', 'active') ON CONFLICT DO NOTHING`;
    await admin`INSERT INTO cycles (org_id, name, state, created_by) VALUES (${ORG}, 'kept', 'active', 'x'), (${ORG}, 'kept too', 'closed', 'y')`;
    await admin`UPDATE cycles SET custom = '{"kept": 1}'::jsonb WHERE org_id = ${ORG} AND name = 'kept'`;
    const rows = async () => JSON.stringify(await admin`SELECT to_jsonb(x) AS r FROM cycles x WHERE org_id = ${ORG} ORDER BY name`);
    const kept = await rows();
    let again = "ok";
    try { for (let i = 0; i < 2; i++) for (const x of statements) await admin.unsafe(x); } catch (e) { again = String(e?.message ?? e); }
    check("applying it twice more, over periods that hold values, is harmless and changes no row", again === "ok" && (await rows()) === kept, again);
    await admin`DELETE FROM cycles WHERE org_id = ${ORG}`;
    await admin`DELETE FROM orgs WHERE org_id = ${ORG}`;
    const { driftPlan, kit } = await import("./lib/drift-plan.mjs");
    const SCRATCH = `cycles_custom_${process.pid}`;
    const scratchUrl = (() => { const u = new URL(adminUrl); u.pathname = `/${SCRATCH}`; return u.toString(); })();
    await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`);
    await admin.unsafe(`create database "${SCRATCH}"`);
    const sdb = postgres(scratchUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
    try {
      const pushed = kit(["push", "--force", "--verbose"], scratchUrl);
      const plan = driftPlan(scratchUrl);
      check("a database built from schema.ts has the column and its index, and its drift plan is empty", pushed.status === 0 && !plan.error && plan.apply.length === 0 && plan.refused.length === 0 && (await sdb`select 1 from pg_indexes where indexname = 'cycles_custom_idx'`).length === 1, plan.error ? plan : { apply: plan.apply, refused: plan.refused });
      // As the live databases are before 0045: no column, no index, a period stored.
      await sdb.unsafe(`drop index "cycles_custom_idx"; alter table "cycles" drop column "custom"`);
      await sdb.unsafe(`insert into cycles (org_id, name, state, created_by) values ('org-x', 'Stored before', 'active', 'x')`);
      const before = driftPlan(scratchUrl);
      check("before 0045 the drift plan names the column and the index, and only them", !before.error && before.apply.length === 2 && before.apply.some((x) => /ADD COLUMN "custom"/.test(x)) && before.apply.some((x) => /cycles_custom_idx/.test(x)) && before.refused.length === 0, before.error ? before : { apply: before.apply, refused: before.refused });
      await sdb.begin(async (tx) => { for (const x of statements) await tx.unsafe(x); });
      const after = driftPlan(scratchUrl);
      check("after 0045 the drift dry run plans NOTHING, and refuses nothing", !after.error && after.apply.length === 0 && after.refused.length === 0, after.error ? after : { apply: after.apply, refused: after.refused });
      const [stored] = await sdb`select state, custom from cycles where name = 'Stored before'`;
      check("…and the period stored before it reads {} for its own fields, its state untouched", stored?.state === "active" && JSON.stringify(stored.custom) === "{}", stored);
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
  const PROBE = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server", "scripts/lib/period-area-db-probe.mjs"];
  const run = (label, cwd, min) => {
    const r = spawnSync(process.execPath, PROBE, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    const out = `${r.stdout}${r.stderr}`;
    const lines = out.split("\n").filter((l) => /^\s+(ok|FAIL) /.test(l));
    for (const l of lines) console.log(l);
    const oks = lines.filter((l) => /^\s+ok /.test(l)).length;
    const bad = lines.filter((l) => /^\s+FAIL /.test(l)).length;
    passed += oks;
    failures += bad;
    const finished = new RegExp(`period-area-db-probe \\[${label}\\]: \\d+ passed`).test(out) && oks >= min && (r.status === 0) === (bad === 0);
    if (finished) passed += 1;
    else {
      failures += 1;
      console.log(`  FAIL ${label}: the probe did not finish under that definition — ${out.slice(-1500)}`);
    }
  };
  console.log("\n1. The default definitions (this checkout)");
  run("default", ROOT, 8);
  const EX = join(ROOT, "scripts/fixtures/record-areas/examples/filing-period.json");
  console.log("\n2. A declared period: a regulatory filing (examples/filing-period.json), in a copy");
  const declared = copyWithProfiles(ROOT, [["50-filing.json", EX]]);
  try {
    run("declared", declared.dir, 20);
  } finally {
    declared.remove();
  }
  console.log("\n3. The same, with a length and auto rollover: the system's moves by category");
  const rolling = copyWithProfiles(ROOT, [["50-filing.json", EX], ["51-rollover.json", { records: { areas: { periods: { period: { length_days: 7, auto_rollover: true, length_days_range: [7, 7] } } } } }]]);
  try {
    run("rollover", rolling.dir, 6);
  } finally {
    rolling.remove();
  }
} catch (e) {
  failures++;
  console.log(`  FAIL the test threw — ${e?.stack ?? e}`);
} finally {
  for (const [table, p] of saved) await admin.unsafe(`ALTER POLICY org_isolation ON "${table}" USING (${p.qual}) WITH CHECK (${p.with_check ?? p.qual})`).catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`\ntest-period-area-db: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

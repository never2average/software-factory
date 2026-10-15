#!/usr/bin/env node
/**
 * LIFECYCLES ENFORCED, AGAINST A REAL POSTGRES (agent/lib/record-lifecycle.ts), as the restricted app_rw role under the
 * production FAIL-CLOSED policies: scripts/lib/record-lifecycle-db-probe.mjs, the real ops routes, the agent's real
 * upsert_todo, MCP's task_update through the routes and the real task-workflow engine, two workspaces, run
 *
 *   1. in a copy under the pipeline fixture (scripts/fixtures/record-lifecycle/pipeline.json) with enforce "strict":
 *      every rule is a 409 with the allowed moves, four eyes reads who entered the state, a stage move is checked;
 *   2. the same with enforce "warn": the moves go through and the activity feed names the broken rule;
 *   3. the same with enforce "off": the moves go through as they always did, and nothing is noted;
 *   4. in a copy under the obligation example: completing a recurring task creates its next occurrence, once;
 *   5. in copies under the periods fixture (strict, warn, off): the cycles routes keep the same rules;
 *   6. in this checkout (the default profile): nothing is noted either.
 *
 * First, the migration that makes recurrence once at the database (drizzle/0042_todos_recurs_from_unique.sql).
 *
 * Every run also proves workspace B moves none of A's tasks and reads none of A's lines. Needs ADMIN_URL and
 * DATABASE_URL (app_rw); without them it skips. Every policy is restored.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test \
 *   DATABASE_URL=postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test \
 *   npm run test:record-lifecycle-db
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
  console.log("test-record-lifecycle-db: SKIPPED — needs ADMIN_URL (policy DDL) and DATABASE_URL (app_rw).");
  process.exit(0);
}
const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });

let failures = 0;
let passed = 0;
const check = (what, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${what}`);
  } else {
    failures++;
    console.log(`  FAIL ${what}${detail === undefined ? "" : ` — ${String(detail).slice(0, 1500)}`}`);
  }
};

const saved = new Map();
try {
  /* ---------------------------------------------------------- the migration (drizzle/0042_todos_recurs_from_unique.sql) */
  console.log("The migration: one next occurrence per task (drizzle/0042_todos_recurs_from_unique.sql)");
  const TAG = "0042_todos_recurs_from_unique";
  // The test database is built from schema.ts (drizzle-kit push), which states the column and the index; the journal
  // entry over it is harmless (IF NOT EXISTS), as the deploy's migrate step runs it.
  const statements = readFileSync(join(ROOT, `drizzle/${TAG}.sql`), "utf8").split("--> statement-breakpoint").map((v) => v.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  for (const x of statements) await admin.unsafe(x);
  const [col] = await admin`SELECT data_type, is_generated, generation_expression FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'todos' AND column_name = 'recurs_from'`;
  check("todos.recurs_from is text, GENERATED from custom ->> 'recurs_from' (never written)", col?.data_type === "text" && col.is_generated === "ALWAYS" && /custom ->> 'recurs_from'/.test(col.generation_expression ?? ""), col);
  const [idx] = await admin`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'todos' AND indexname = 'todos_recurs_from_uidx'`;
  check("todos has a UNIQUE index on (org_id, recurs_from) WHERE recurs_from IS NOT NULL", idx?.indexdef === "CREATE UNIQUE INDEX todos_recurs_from_uidx ON public.todos USING btree (org_id, recurs_from) WHERE (recurs_from IS NOT NULL)", idx?.indexdef);
  const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
  const at = journal.entries.findIndex((e) => e.tag === TAG);
  check(`the journal carries ${TAG}, numbered after the one before`, at > 0 && journal.entries[at].idx === journal.entries[at - 1].idx + 1, journal.entries[at]);
  check("it is additive: the generated column and its index, IF NOT EXISTS, nothing altered, dropped or written", statements.length === 2 && /^ALTER TABLE "todos" ADD COLUMN IF NOT EXISTS "recurs_from" text GENERATED ALWAYS AS \(\(custom ->> 'recurs_from'::text\)\) STORED;$/.test(statements[0]) && /^CREATE UNIQUE INDEX IF NOT EXISTS "todos_recurs_from_uidx" ON "todos" USING btree \("org_id","recurs_from"\) WHERE recurs_from IS NOT NULL;$/.test(statements[1]), statements);
  {
    const ORG = `org-recurs-mig-${process.pid}`;
    await admin`INSERT INTO orgs (org_id, name, status) VALUES (${ORG}, 'Recurs migration', 'active') ON CONFLICT DO NOTHING`;
    await admin`INSERT INTO todos (org_id, title, created_by, custom) VALUES (${ORG}, 'plain', 'probe', DEFAULT), (${ORG}, 'next', 'probe', '{"recurs_from": "t1"}'::jsonb), (${ORG}, 'other next', 'probe', '{"recurs_from": "t2"}'::jsonb)`;
    check("the column follows custom: a row's recurs_from is its custom key, else null", JSON.stringify((await admin`SELECT title, recurs_from FROM todos WHERE org_id = ${ORG} ORDER BY title`).map((r) => [r.title, r.recurs_from])) === '[["next","t1"],["other next","t2"],["plain",null]]');
    const before = JSON.stringify(await admin`SELECT to_jsonb(x) AS r FROM todos x WHERE org_id = ${ORG} ORDER BY title`);
    let again = "ok";
    try { for (let i = 0; i < 2; i++) for (const x of statements) await admin.unsafe(x); } catch (e) { again = String(e?.message ?? e); }
    check("applying it twice more is harmless and changes no row", again === "ok" && JSON.stringify(await admin`SELECT to_jsonb(x) AS r FROM todos x WHERE org_id = ${ORG} ORDER BY title`) === before, again);
    let many = "ok";
    try { await admin`INSERT INTO todos (org_id, title, created_by) VALUES (${ORG}, 'a', 'probe'), (${ORG}, 'b', 'probe')`; } catch (e) { many = String(e?.message ?? e); }
    check("rows without the key are not constrained", many === "ok", many);
    await admin`DELETE FROM todos WHERE org_id = ${ORG}`;
    await admin`DELETE FROM orgs WHERE org_id = ${ORG}`;
    const { driftPlan, kit } = await import("./lib/drift-plan.mjs");
    const SCRATCH = `recurs_${process.pid}`;
    const scratchUrl = (() => { const u = new URL(adminUrl); u.pathname = `/${SCRATCH}`; return u.toString(); })();
    await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`);
    await admin.unsafe(`create database "${SCRATCH}"`);
    const sdb = postgres(scratchUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
    try {
      const pushed = kit(["push", "--force", "--verbose"], scratchUrl);
      const plan = driftPlan(scratchUrl);
      check("a database built from schema.ts has the column and the index, and its drift plan is empty", pushed.status === 0 && !plan.error && plan.apply.length === 0 && plan.refused.length === 0 && (await sdb`select 1 from pg_indexes where indexname = 'todos_recurs_from_uidx'`).length === 1, plan.error ? JSON.stringify(plan) : JSON.stringify({ apply: plan.apply, refused: plan.refused }));
      await sdb.unsafe('drop index "todos_recurs_from_uidx"; alter table "todos" drop column "recurs_from"');
      const before = driftPlan(scratchUrl);
      check("before 0042 the drift plan names the column and the index, and only them", !before.error && before.apply.length === 2 && before.apply.some((x) => /ADD COLUMN "recurs_from" text GENERATED ALWAYS AS/.test(x)) && before.apply.some((x) => /todos_recurs_from_uidx/.test(x)) && before.refused.length === 0, before.error ? JSON.stringify(before) : JSON.stringify({ apply: before.apply, refused: before.refused }));
      await sdb.begin(async (tx) => { for (const x of statements) await tx.unsafe(x); });
      const after = driftPlan(scratchUrl);
      check("after 0042 the drift dry run plans NOTHING, and refuses nothing", !after.error && after.apply.length === 0 && after.refused.length === 0, after.error ? JSON.stringify(after) : JSON.stringify({ apply: after.apply, refused: after.refused }));
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
  const PROBE = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server", "scripts/lib/record-lifecycle-db-probe.mjs"];
  const runProbe = (cwd) => spawnSync(process.execPath, PROBE, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1", TASK_AREA_SERVICE_ROOT: join(ROOT, "services/task-workflow") } });
  const report = (label, r, least) => {
    const out = `${r.stdout}${r.stderr}`;
    const lines = out.split("\n").filter((l) => /^\s+(ok|FAIL) /.test(l));
    for (const l of lines) console.log(l);
    const oks = lines.filter((l) => /^\s+ok /.test(l)).length;
    const bad = lines.filter((l) => /^\s+FAIL /.test(l)).length;
    passed += oks;
    failures += bad;
    check(`${label}: the probe ran under that definition and finished (${oks} passed, ${bad} failed)`, new RegExp(`record-lifecycle-db-probe \\[${label}\\]: \\d+ passed`).test(out) && oks >= least && (r.status === 0) === (bad === 0), out.slice(-2000));
  };
  const enforce = (mode) => ["51-enforce.json", { records: { areas: { tasks: { lifecycle: { enforce: mode } } } } }];
  for (const [mode, least] of [["strict", 30], ["warn", 12], ["off", 12]]) {
    console.log(`\nThe pipeline fixture, enforce "${mode}"`);
    const copy = copyWithProfiles(ROOT, [["50-pipeline.json", join(ROOT, "scripts/fixtures/record-lifecycle/pipeline.json")], enforce(mode)]);
    try {
      report(mode, runProbe(copy.dir), least);
    } finally {
      copy.remove();
    }
  }
  console.log("\nRecurrence: the obligation example (records.areas.tasks.recurrence)");
  {
    const copy = copyWithProfiles(ROOT, [["50-obligation.json", join(ROOT, "scripts/fixtures/record-areas/examples/obligation.json")]]);
    try {
      const r = spawnSync(process.execPath, PROBE, { cwd: copy.dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1", LIFECYCLE_PROBE_SET: "recurrence", TASK_AREA_SERVICE_ROOT: join(ROOT, "services/task-workflow") } });
      report("recurrence", r, 10);
    } finally {
      copy.remove();
    }
  }
  for (const mode of ["strict", "warn", "off"]) {
    console.log(`\nPeriods (records.areas.periods, app/api/ops/cycles), enforce "${mode}"`);
    const copy = copyWithProfiles(ROOT, [["50-periods.json", join(ROOT, "scripts/fixtures/record-lifecycle/periods.json")], ["51-enforce.json", { records: { areas: { periods: { lifecycle: { enforce: mode } } } } }]]);
    try {
      const r = spawnSync(process.execPath, PROBE, { cwd: copy.dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1", LIFECYCLE_PROBE_SET: "periods", TASK_AREA_SERVICE_ROOT: join(ROOT, "services/task-workflow") } });
      report(`periods-${mode}`, r, mode === "strict" ? 10 : 4);
    } finally {
      copy.remove();
    }
  }
  console.log("\nThe default profile (this checkout)");
  report("default", runProbe(ROOT), 12);
} catch (e) {
  failures++;
  console.log(`  FAIL the test threw — ${e?.stack ?? e}`);
} finally {
  for (const [table, p] of saved) await admin.unsafe(`ALTER POLICY org_isolation ON "${table}" USING (${p.qual}) WITH CHECK (${p.with_check ?? p.qual})`).catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`\ntest-record-lifecycle-db: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

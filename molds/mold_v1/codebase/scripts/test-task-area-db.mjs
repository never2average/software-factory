#!/usr/bin/env node
/**
 * TASKS AS THE DEPLOYMENT DEFINES THEM (profiles records.areas.tasks), AGAINST A REAL POSTGRES, as the restricted
 * app_rw role under the production FAIL-CLOSED policies.
 *
 *   0. THE MIGRATION (drizzle/0041_todos_custom.sql): todos.custom is jsonb, NOT NULL, '{}' by default, with a GIN
 *      jsonb_path_ops index; applying it twice more is harmless and changes no row; todos keeps its org_isolation
 *      policy, forced; and the deploy's drift step plans exactly the column and the index before it and nothing after.
 *   1. The default definition (this checkout) and 2. a redefined one (a copy under the record-areas design's
 *      obligation example): scripts/lib/task-area-db-probe.mjs, the real routes and the agent's real tools in front of
 *      the real task-workflow engine, two workspaces.
 *
 * Needs ADMIN_URL (policy DDL, seeding) and DATABASE_URL (app_rw); without them it skips. Every policy is restored.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test \
 *   DATABASE_URL=postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test \
 *   npm run test:task-area-db
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
  console.log("test-task-area-db: SKIPPED — needs ADMIN_URL (policy DDL) and DATABASE_URL (app_rw).");
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
    console.log(`  FAIL ${what}${detail === undefined ? "" : ` — ${(typeof detail === "string" ? detail : JSON.stringify(detail))?.slice(0, 600)}`}`);
  }
};

const saved = new Map();
try {
  /* -------------------------------------------------------------------------------- 0. the migration */
  console.log("0. The migration (drizzle/0041_todos_custom.sql)");
  const TAG = "0041_todos_custom";
  const [col] = await admin`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'todos' AND column_name = 'custom'`;
  check("todos.custom is jsonb, NOT NULL, '{}' by default", col?.data_type === "jsonb" && col.is_nullable === "NO" && /^'\{\}'::jsonb$/.test(col.column_default ?? ""), col);
  const [idx] = await admin`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'todos' AND indexname = 'todos_custom_idx'`;
  check("it has a GIN jsonb_path_ops index", /USING gin \(custom jsonb_path_ops\)/.test(idx?.indexdef ?? ""), idx);
  const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
  const at = journal.entries.findIndex((e) => e.tag === TAG);
  check(`the journal carries ${TAG}, numbered after the one before`, at > 0 && journal.entries[at].idx === journal.entries[at - 1].idx + 1, journal.entries[at]);
  const statements = readFileSync(join(ROOT, `drizzle/${TAG}.sql`), "utf8").split("--> statement-breakpoint").map((v) => v.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  check("it is additive: the column and its index, nothing altered, dropped, written or secured", statements.length === 2 && /^ALTER TABLE "todos" ADD COLUMN IF NOT EXISTS "custom" jsonb DEFAULT '\{\}'::jsonb NOT NULL;$/.test(statements[0]) && /^CREATE INDEX IF NOT EXISTS "todos_custom_idx" ON "todos" USING gin \("custom" jsonb_path_ops\);$/.test(statements[1]), statements);
  const ORG = `org-tcustom-mig-${process.pid}`;
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${ORG}, 'Task custom migration', 'active') ON CONFLICT DO NOTHING`;
  await admin`INSERT INTO todos (org_id, title, created_by, custom) VALUES (${ORG}, 'kept', 'probe', '{"k": "v"}'::jsonb), (${ORG}, 'plain', 'probe', DEFAULT)`;
  const todosBefore = JSON.stringify(await admin`SELECT to_jsonb(x) AS r FROM todos x WHERE org_id = ${ORG} ORDER BY title`);
  let again = "ok";
  try { for (let i = 0; i < 2; i++) for (const x of statements) await admin.unsafe(x); } catch (e) { again = String(e?.message ?? e); }
  check("applying it twice more, over rows that hold own fields, is harmless and changes no row", again === "ok" && JSON.stringify(await admin`SELECT to_jsonb(x) AS r FROM todos x WHERE org_id = ${ORG} ORDER BY title`) === todosBefore, again);
  await admin`DELETE FROM todos WHERE org_id = ${ORG}`;
  await admin`DELETE FROM orgs WHERE org_id = ${ORG}`;
  const [rls] = await admin`SELECT c.relrowsecurity AS on, c.relforcerowsecurity AS forced, (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = 'todos' AND p.policyname = 'org_isolation') AS policy FROM pg_class c WHERE c.relname = 'todos' AND c.relnamespace = 'public'::regnamespace`;
  check("todos keeps row-level security, forced, under its org_isolation policy", rls?.on === true && rls.forced === true && rls.policy === 1, rls);
  {
    // The deploy's drift step against a database as the live ones are before 0041: the plan names the column and its
    // index, and only them; after the file, it plans nothing.
    const { driftPlan, kit } = await import("./lib/drift-plan.mjs");
    const SCRATCH = `tcustom_${process.pid}`;
    const scratchUrl = (() => { const u = new URL(adminUrl); u.pathname = `/${SCRATCH}`; return u.toString(); })();
    await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`);
    await admin.unsafe(`create database "${SCRATCH}"`);
    const sdb = postgres(scratchUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
    try {
      const pushed = kit(["push", "--force", "--verbose"], scratchUrl);
      check("a database built from schema.ts has the column and the index", pushed.status === 0 && (await sdb`select 1 from pg_indexes where tablename = 'todos' and indexname = 'todos_custom_idx'`).length === 1, pushed.out?.slice(-300));
      // 0042's generated column reads custom: as the live databases are before 0041, neither exists.
      await sdb.unsafe('drop index "todos_recurs_from_uidx"; alter table "todos" drop column "recurs_from"; drop index "todos_custom_idx"; alter table "todos" drop column "custom"');
      const before = driftPlan(scratchUrl);
      check("before 0041 the drift plan against schema.ts names the column and the index (and 0042's over it), and only them", !before.error && before.apply.length === 4 && before.apply.some((s) => /ADD COLUMN "custom" jsonb DEFAULT '\{\}'::jsonb NOT NULL/.test(s)) && before.apply.some((s) => /todos_custom_idx/.test(s)) && before.apply.filter((s) => /recurs_from/.test(s)).length === 2 && before.refused.length === 0, before.error ? before : { apply: before.apply, refused: before.refused });
      const next = readFileSync(join(ROOT, "drizzle/0042_todos_recurs_from_unique.sql"), "utf8").split("--> statement-breakpoint").map((v) => v.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
      await sdb.begin(async (tx) => { for (const x of [...statements, ...next]) await tx.unsafe(x); });
      const after = driftPlan(scratchUrl);
      check("after 0041 (and 0042) the drift dry run plans NOTHING to apply, and refuses nothing", !after.error && after.apply.length === 0 && after.refused.length === 0, after.error ? after : { apply: after.apply, refused: after.refused });
    } finally {
      await sdb.end({ timeout: 2 });
      await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`).catch(() => {});
    }
  }

  /* ------------------------------------------------------------------------- 1-2. each definition */
  const policies = await admin`SELECT tablename, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND policyname = 'org_isolation'`;
  if (!policies.length) throw new Error("no org_isolation policies — run scripts/bootstrap-test-db.mjs first");
  const closed = `(org_id = current_setting('app.org_id', true))`;
  for (const p of policies) {
    saved.set(p.tablename, p);
    await admin.unsafe(`ALTER POLICY org_isolation ON "${p.tablename}" USING ${closed} WITH CHECK ${closed}`);
  }
  console.log(`\norg_isolation on ${policies.length} tables set to the production FAIL-CLOSED shape`);
  const PROBE = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server", "scripts/lib/task-area-db-probe.mjs"];
  const runProbe = (cwd) => spawnSync(process.execPath, PROBE, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1", TASK_AREA_SERVICE_ROOT: join(ROOT, "services/task-workflow") } });
  const report = (label, r) => {
    const out = `${r.stdout}${r.stderr}`;
    const lines = out.split("\n").filter((l) => /^\s+(ok|FAIL) /.test(l));
    for (const l of lines) console.log(l);
    const oks = lines.filter((l) => /^\s+ok /.test(l)).length;
    const bad = lines.filter((l) => /^\s+FAIL /.test(l)).length;
    passed += oks;
    failures += bad;
    check(`${label}: the probe ran under that definition and finished (${oks} passed, ${bad} failed)`, new RegExp(`task-area-db-probe \\[${label}\\]: \\d+ passed`).test(out) && oks > 5 && (r.status === 0) === (bad === 0), out.slice(-1500));
  };
  console.log("\n1. The default definition (this checkout)");
  report("default", runProbe(ROOT));
  console.log("\n2. A redefined task: the obligation example (a copy under scripts/fixtures/record-areas/examples/obligation.json)");
  const copy = copyWithProfiles(ROOT, [["50-obligation.json", join(ROOT, "scripts/fixtures/record-areas/examples/obligation.json")]]);
  try {
    report("redefined", runProbe(copy.dir));
  } finally {
    copy.remove();
  }
} catch (e) {
  failures++;
  console.log(`  FAIL the test threw — ${e?.stack ?? e}`);
} finally {
  for (const [table, p] of saved) await admin.unsafe(`ALTER POLICY org_isolation ON "${table}" USING (${p.qual}) WITH CHECK (${p.with_check ?? p.qual})`).catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`\ntest-task-area-db: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

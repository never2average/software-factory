#!/usr/bin/env node
/**
 * A RECORD'S WORKFLOW STEP ACTIONS, AGAINST A REAL POSTGRES (lib/record-workflow-actions.ts; docs/WORKFLOW_ENGINE.md
 * phase 6 "Step actions"), as the restricted app_rw role under the production FAIL-CLOSED policies
 * (scripts/lib/record-workflow-actions-db-probe.mjs, run in a copy of this checkout under the neutral maker-checker
 * fixture, scripts/fixtures/record-workflows/review.json, with the step actions of
 * scripts/fixtures/record-workflows/actions.json added and the deployments enforced "strict"): fired with the step
 * change, delivered once after it (a notification, a task for the assistant; never an email), exactly once under
 * retries, rollbacks, re-entries and concurrent or dying deliveries, and workspace B's never reaching A's.
 *
 * Needs ADMIN_URL (policy DDL, seeding) and DATABASE_URL (app_rw); without them it skips. Every policy is restored.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test \
 *   DATABASE_URL=postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test \
 *   npm run test:record-workflow-actions-db
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
  console.log("test-record-workflow-actions-db: SKIPPED — needs ADMIN_URL (policy DDL) and DATABASE_URL (app_rw).");
  process.exit(0);
}
const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
let failures = 0;
let passed = 0;
const saved = new Map();
const check = (what, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${what}`);
  } else {
    failures++;
    console.log(`  FAIL ${what}${detail === undefined ? "" : ` — ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 2500)}`}`);
  }
};
const REVIEW = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/record-workflows/review.json"), "utf8"));
const ACTIONS = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/record-workflows/actions.json"), "utf8"));
const WITH_ACTIONS = structuredClone(REVIEW);
WITH_ACTIONS.records.workflows["maker-checker"].diff.push(...ACTIONS.rules);
try {
  // drizzle/0050: one task per workflow action, in a workspace, at the database.
  const TAG = "0050_todos_workflow_action_unique";
  const statements = readFileSync(join(ROOT, `drizzle/${TAG}.sql`), "utf8").split("--> statement-breakpoint").map((v) => v.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  check("0050 is additive: a generated column and its partial unique index, IF NOT EXISTS, nothing altered, dropped or written", statements.length === 2 && /^ALTER TABLE "todos" ADD COLUMN IF NOT EXISTS "workflow_action" text GENERATED ALWAYS AS \(\(custom ->> 'workflow_action'::text\)\) STORED;$/.test(statements[0]) && /^CREATE UNIQUE INDEX IF NOT EXISTS "todos_workflow_action_uidx" ON "todos" USING btree \("org_id","workflow_action"\) WHERE workflow_action IS NOT NULL;$/.test(statements[1]), statements);
  const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
  const at = journal.entries.findIndex((e) => e.tag === TAG);
  check(`the journal carries ${TAG}, numbered after the one before`, at > 0 && journal.entries[at].idx === journal.entries[at - 1].idx + 1, journal.entries[at]);
  {
    const ORG = `org-wfa-mig-${process.pid}`;
    const OTHER = `org-wfa-mig2-${process.pid}`;
    let again = "ok";
    try { for (let i = 0; i < 2; i++) for (const x of statements) await admin.unsafe(x); } catch (e) { again = String(e?.message ?? e); }
    check("applying it again over a database built from schema.ts is harmless", again === "ok", again);
    const [idx] = await admin`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'todos' AND indexname = 'todos_workflow_action_uidx'`;
    check("todos has a UNIQUE index on (org_id, workflow_action) WHERE workflow_action IS NOT NULL", idx?.indexdef === "CREATE UNIQUE INDEX todos_workflow_action_uidx ON public.todos USING btree (org_id, workflow_action) WHERE (workflow_action IS NOT NULL)", idx?.indexdef);
    await admin`INSERT INTO orgs (org_id, name, status) VALUES (${ORG}, 'Action migration', 'active'), (${OTHER}, 'Action migration 2', 'active') ON CONFLICT DO NOTHING`;
    try {
      await admin`INSERT INTO todos (org_id, title, created_by, custom) VALUES (${ORG}, 'one', 'probe', '{"workflow_action": "d1"}'::jsonb), (${OTHER}, 'same id elsewhere', 'probe', '{"workflow_action": "d1"}'::jsonb), (${ORG}, 'plain', 'probe', DEFAULT), (${ORG}, 'plain too', 'probe', DEFAULT)`;
      let dup = "none";
      try { await admin`INSERT INTO todos (org_id, title, created_by, custom) VALUES (${ORG}, 'twin', 'probe', '{"workflow_action": "d1"}'::jsonb)`; } catch (e) { dup = `${e.code} ${e.constraint_name}`; }
      check("a second task for one workflow action in a workspace is refused (23505); another workspace's, and tasks without the key, are not", dup === "23505 todos_workflow_action_uidx", dup);
    } finally {
      await admin`DELETE FROM todos WHERE org_id IN (${ORG}, ${OTHER})`;
      await admin`DELETE FROM orgs WHERE org_id IN (${ORG}, ${OTHER})`;
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
  const copy = copyWithProfiles(ROOT, [["50-review.json", WITH_ACTIONS], ["51-enforce.json", { records: { areas: { deployments: { lifecycle: { enforce: "strict" } } } } }]]);
  try {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server", "scripts/lib/record-workflow-actions-db-probe.mjs"], { cwd: copy.dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1", TASK_AREA_SERVICE_ROOT: join(ROOT, "services/task-workflow") } });
    const out = `${r.stdout}${r.stderr}`;
    const lines = out.split("\n").filter((l) => /^\s+(ok|FAIL|note) /.test(l));
    for (const l of lines) console.log(l);
    const oks = lines.filter((l) => /^\s+ok /.test(l)).length;
    const bad = lines.filter((l) => /^\s+FAIL /.test(l)).length;
    passed += oks;
    failures += bad;
    check(`the probe ran under the fixture with step actions and finished (${oks} passed, ${bad} failed)`, /record-workflow-actions-db-probe: \d+ passed/.test(out) && oks >= 36 && (r.status === 0) === (bad === 0), out.slice(-2500));
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
console.log(`\ntest-record-workflow-actions-db: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

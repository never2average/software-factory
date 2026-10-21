#!/usr/bin/env node
/**
 * A RECORD'S WORKFLOW ON ITS MOVES, AGAINST A REAL POSTGRES (lib/record-workflow-moves.ts, lib/record-workflow-runtime.ts;
 * docs/WORKFLOW_ENGINE.md phase 5 "Runtime"), as the restricted app_rw role under the production FAIL-CLOSED policies
 * (scripts/lib/record-workflow-runtime-db-probe.mjs, run in copies of this checkout under the neutral fixture
 * scripts/fixtures/record-workflows/review.json):
 *
 *   strict  the step rules refuse with their sentences and write nothing; the holder's move changes the step in the
 *           record's own transaction; four eyes by {entered_by} and as the step holder; a supervisor acts for a
 *           reportee; attached mid-lifecycle from a legacy spelling under an earlier key, dated from the feed, nothing
 *           rewritten; a stale revision a 409 that keeps nothing; the agent's doors;
 *   warn    the move goes through, the broken step rule a warning, a feed line and an administrative step change;
 *   off     the engine never runs: no instance, `evidence` no field, today's moves;
 *   every   another workspace sees nothing of A's and attaches its own;
 *   and the tasks (through the task-workflow service, a stand-in running its own engine) and the periods doors, strict;
 *   people  (scripts/fixtures/record-workflows/people.json laid over it) holders read from the record's own person
 *           fields whatever case they are spelled in, a step's due date anchored to the record's date and following
 *           an edit of it, through the deployments and the tasks doors.
 *
 * Needs ADMIN_URL (policy DDL, seeding) and DATABASE_URL (app_rw); without them it skips. Every policy is restored.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test \
 *   DATABASE_URL=postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test \
 *   npm run test:record-workflow-runtime-db
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import postgres from "postgres";
import { copyWithProfiles } from "./lib/profile-copy.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-record-workflow-runtime-db: SKIPPED — needs ADMIN_URL (policy DDL) and DATABASE_URL (app_rw).");
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
    console.log(`  FAIL ${what}${detail === undefined ? "" : ` — ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 2000)}`}`);
  }
};
try {
  const policies = await admin`SELECT tablename, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND policyname = 'org_isolation'`;
  if (!policies.length) throw new Error("no org_isolation policies — run scripts/bootstrap-test-db.mjs first");
  const closed = `(org_id = current_setting('app.org_id', true))`;
  for (const p of policies) {
    saved.set(p.tablename, p);
    await admin.unsafe(`ALTER POLICY org_isolation ON "${p.tablename}" USING ${closed} WITH CHECK ${closed}`);
  }
  console.log(`org_isolation on ${policies.length} tables set to the production FAIL-CLOSED shape`);
  const PROBE = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server", "scripts/lib/record-workflow-runtime-db-probe.mjs"];
  const FIXTURE = join(ROOT, "scripts/fixtures/record-workflows/review.json");
  const PEOPLE = join(ROOT, "scripts/fixtures/record-workflows/people.json");
  // The fourth run, "people": the review held by the record's own person fields and due by its dates
  // (scripts/fixtures/record-workflows/people.json laid over the fixture, the deployments under "warn").
  for (const [mode, least, enforce, extra] of [["strict", 50, "strict", []], ["warn", 7, "warn", []], ["off", 3, "off", []], ["people", 4, "warn", [["52-people.json", PEOPLE]]]]) {
    console.log(`\nThe maker-checker fixture, ${mode === "people" ? "its holders and due dates from the record (people.json), enforce \"warn\"" : `enforce "${mode}"`}`);
    const copy = copyWithProfiles(ROOT, [["50-review.json", FIXTURE], ["51-enforce.json", { records: { areas: { deployments: { lifecycle: { enforce } } } } }], ...extra]);
    try {
      const r = spawnSync(process.execPath, PROBE, { cwd: copy.dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1", TASK_AREA_SERVICE_ROOT: join(ROOT, "services/task-workflow"), ...(mode === "people" ? { WORKFLOW_PROBE_SET: "people" } : {}) } });
      const out = `${r.stdout}${r.stderr}`;
      const lines = out.split("\n").filter((l) => /^\s+(ok|FAIL) /.test(l));
      for (const l of lines) console.log(l);
      const oks = lines.filter((l) => /^\s+ok /.test(l)).length;
      const bad = lines.filter((l) => /^\s+FAIL /.test(l)).length;
      passed += oks;
      failures += bad;
      check(`${mode}: the probe ran under that definition and finished (${oks} passed, ${bad} failed)`, new RegExp(`record-workflow-runtime-db-probe \\[${mode}\\]: \\d+ passed`).test(out) && oks >= least && (r.status === 0) === (bad === 0), out.slice(-2500));
    } finally {
      copy.remove();
    }
  }
} catch (e) {
  failures++;
  console.log(`  FAIL the test threw — ${e?.stack ?? e}`);
} finally {
  for (const [table, p] of saved) await admin.unsafe(`ALTER POLICY org_isolation ON "${table}" USING (${p.qual}) WITH CHECK (${p.with_check ?? p.qual})`).catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`\ntest-record-workflow-runtime-db: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

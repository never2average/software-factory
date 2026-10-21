#!/usr/bin/env node
/**
 * A RECORD'S WORKFLOW ON ITS SURFACES, AGAINST A REAL POSTGRES (lib/record-workflow-doors.ts, lib/record-workflow-routes.ts,
 * agent/lib/record-workflow-tools.ts; docs/WORKFLOW_ENGINE.md phase 7 "Surfaces"), as the restricted app_rw role under
 * the production FAIL-CLOSED policies (scripts/lib/record-workflow-surfaces-db-probe.mjs, run in a copy of this
 * checkout under the neutral maker-checker fixture, scripts/fixtures/record-workflows/review.json, with the step actions
 * of actions.json and the due dates of surfaces.json added, the deployments enforced "strict"): who holds the next step
 * (names, emails only for an admin), its due date and the timeline; a holder change by supervisors only; the one-time
 * due-date extension; system moves kept in step (a rollover, a record moved outside the doors); the agent's tools
 * taking `evidence` (upsert_cycle again in a second copy whose periods are each person's own, work_periods mode
 * "individual"); workspace B reaching none of A's.
 *
 * Needs ADMIN_URL (policy DDL, seeding) and DATABASE_URL (app_rw); without them it skips. Every policy is restored.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test \
 *   DATABASE_URL=postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test \
 *   npm run test:record-workflow-surfaces-db
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
  console.log("test-record-workflow-surfaces-db: SKIPPED — needs ADMIN_URL (policy DDL) and DATABASE_URL (app_rw).");
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
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/record-workflows", name), "utf8"));
const PROFILE = fixture("review.json");
const DSL = PROFILE.records.workflows["maker-checker"];
DSL.diff.push(...fixture("actions.json").rules);
for (const [id, extra] of Object.entries(fixture("surfaces.json").steps)) Object.assign(DSL.init.steps.find((s) => s.id === id), extra);
/** Run the probe in a copy of this checkout under `layers` (profile files), its "ok"/"FAIL" lines counted here. */
function runProbe(what, layers, env, minOks) {
  const copy = copyWithProfiles(ROOT, layers);
  try {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server", "scripts/lib/record-workflow-surfaces-db-probe.mjs"], { cwd: copy.dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env, NODE_NO_WARNINGS: "1", TASK_AREA_SERVICE_ROOT: join(ROOT, "services/task-workflow") } });
    const out = `${r.stdout}${r.stderr}`;
    const lines = out.split("\n").filter((l) => /^\s+(ok|FAIL) /.test(l));
    for (const l of lines) console.log(l);
    const oks = lines.filter((l) => /^\s+ok /.test(l)).length;
    const bad = lines.filter((l) => /^\s+FAIL /.test(l)).length;
    passed += oks;
    failures += bad;
    check(`${what} (${oks} passed, ${bad} failed)`, /record-workflow-surfaces-db-probe: \d+ passed/.test(out) && oks >= minOks && (r.status === 0) === (bad === 0), out.slice(-2500));
  } finally {
    copy.remove();
  }
}

try {
  const policies = await admin`SELECT tablename, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND policyname = 'org_isolation'`;
  if (!policies.length) throw new Error("no org_isolation policies — run scripts/bootstrap-test-db.mjs first");
  const closed = `(org_id = current_setting('app.org_id', true))`;
  for (const p of policies) {
    saved.set(p.tablename, p);
    await admin.unsafe(`ALTER POLICY org_isolation ON "${p.tablename}" USING ${closed} WITH CHECK ${closed}`);
  }
  console.log(`org_isolation on ${policies.length} tables set to the production FAIL-CLOSED shape`);
  const layers = [["50-review.json", PROFILE], ["51-enforce.json", { records: { areas: { deployments: { lifecycle: { enforce: "strict" } } } } }]];
  // The whole probe under team periods (this checkout's mode); then only upsert_cycle again where each person's periods
  // are their own (work_periods mode "individual"), whose tool writes the declared period beside a person's goal.
  runProbe("the probe ran under the fixture and finished", layers, {}, 30);
  runProbe("the probe's individual-mode part ran and finished", [...layers, ["52-individual.json", { records: { areas: { periods: { period: { mode: "individual", length_days: 7 } } } } }]], { SURFACES_PROBE_PART: "individual-cycle" }, 2);
} catch (e) {
  failures++;
  console.log(`  FAIL the test threw — ${e?.stack ?? e}`);
} finally {
  for (const [table, p] of saved) await admin.unsafe(`ALTER POLICY org_isolation ON "${table}" USING (${p.qual}) WITH CHECK (${p.with_check ?? p.qual})`).catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`\ntest-record-workflow-surfaces-db: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

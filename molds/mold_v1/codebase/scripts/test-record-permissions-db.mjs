#!/usr/bin/env node
/**
 * WHO MAY WRITE A RECORD, AND THE DECLARED METRICS, AGAINST A REAL POSTGRES, as the restricted app_rw role under the
 * production FAIL-CLOSED policies (scripts/lib/record-permissions-db-probe.mjs, run twice):
 *
 *   1. the default definitions (this checkout): nothing declared, a member does everything on every path as before,
 *      and no metric is counted;
 *   2. declared ones (a copy under scripts/fixtures/record-areas/examples/{compliance,obligation,programme,
 *      permissions}.json): every role rule on every write and delete path (the ops routes, upsert_customer's nested
 *      rows, the agent's tools; MCP goes through the routes), "own row", a field only some roles may set, a 403 with
 *      the sentence that changes nothing; the metrics equal the list query's counts;
 *   both: workspace B reaches none of A's records and counts none of them.
 *
 * Needs ADMIN_URL (policy DDL, seeding) and DATABASE_URL (app_rw); without them it skips. Every policy is restored.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test \
 *   DATABASE_URL=postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test \
 *   npm run test:record-permissions-db
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import postgres from "postgres";
import { copyWithProfiles } from "./lib/profile-copy.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-record-permissions-db: SKIPPED — needs ADMIN_URL (policy DDL) and DATABASE_URL (app_rw).");
  process.exit(0);
}
const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
let failures = 0;
let passed = 0;
const saved = new Map();
try {
  const policies = await admin`SELECT tablename, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND policyname = 'org_isolation'`;
  if (!policies.length) throw new Error("no org_isolation policies — run scripts/bootstrap-test-db.mjs first");
  const closed = `(org_id = current_setting('app.org_id', true))`;
  for (const p of policies) {
    saved.set(p.tablename, p);
    await admin.unsafe(`ALTER POLICY org_isolation ON "${p.tablename}" USING ${closed} WITH CHECK ${closed}`);
  }
  console.log(`org_isolation on ${policies.length} tables set to the production FAIL-CLOSED shape`);
  const PROBE = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--conditions=react-server", "scripts/lib/record-permissions-db-probe.mjs"];
  const run = (label, cwd) => {
    const r = spawnSync(process.execPath, PROBE, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1", TASK_AREA_SERVICE_ROOT: join(ROOT, "services/task-workflow") } });
    const out = `${r.stdout}${r.stderr}`;
    const lines = out.split("\n").filter((l) => /^\s+(ok|FAIL) /.test(l));
    for (const l of lines) console.log(l);
    const oks = lines.filter((l) => /^\s+ok /.test(l)).length;
    const bad = lines.filter((l) => /^\s+FAIL /.test(l)).length;
    passed += oks;
    failures += bad;
    const finished = new RegExp(`record-permissions-db-probe \\[${label}\\]: \\d+ passed`).test(out) && oks > 5 && (r.status === 0) === (bad === 0);
    if (finished) passed += 1;
    else {
      failures += 1;
      console.log(`  FAIL ${label}: the probe did not finish under that definition — ${out.slice(-1500)}`);
    }
  };
  console.log("\n1. The default definitions (this checkout)");
  run("default", ROOT);
  console.log("\n2. Declared: filings, tasks, programmes and periods with who may write them, in a copy");
  const EX = join(ROOT, "scripts/fixtures/record-areas/examples");
  const copy = copyWithProfiles(ROOT, [["50-compliance.json", join(EX, "compliance.json")], ["51-obligation.json", join(EX, "obligation.json")], ["52-programme.json", join(EX, "programme.json")], ["60-permissions.json", join(EX, "permissions.json")]]);
  try {
    run("declared", copy.dir);
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
console.log(`\ntest-record-permissions-db: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

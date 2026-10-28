/**
 * THE LIFECYCLE WARNINGS REPORT, AGAINST A REAL POSTGRES as the restricted app_rw role (agent/lib/lifecycle-warnings.ts,
 * scripts/operator/lifecycle-warnings.mjs; the offline twin is scripts/test-lifecycle-warnings.mjs).
 *
 *   1. The operator script itself, as app_rw: a warned move seeded with writeOutcome's own lines (the pipeline fixture
 *      under "warn", checked by the real validator) is listed with its rule, states, actor and comment, the moves of the
 *      window are counted by the Postgres pattern, a line before --since and another workspace's lines stay out, and
 *      the text and --json agree.
 *   2. Read-only: the report's own transaction refuses a write after it ran (SQLSTATE 25006, read_only_sql_transaction),
 *      and entity_activity is the same, row for row, after every run.
 *   3. As a role that bypasses row-level security (the admin URL) the script refuses to run, and reads nothing.
 *
 * Needs ADMIN_URL (to seed and clean up) and DATABASE_URL (app_rw); without them it skips.
 *
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/workspace_test \
 *   DATABASE_URL=postgres://app_rw:app_rw_test_password@127.0.0.1:5432/workspace_test \
 *   npm run test:lifecycle-warnings-db
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-lifecycle-warnings-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (app_rw).");
  process.exit(0);
}
const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
let passed = 0;
let failures = 0;
const check = (what, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${what}`);
  } else {
    failures++;
    console.log(`  FAIL ${what}${detail === undefined ? "" : ` — ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 1500)}`}`);
  }
};

function compile(extra) {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-warnings-db-"));
  try {
    cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
    for (const [name, src] of extra) typeof src === "string" ? cpSync(src, join(dir, name)) : writeFileSync(join(dir, name), JSON.stringify(src));
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(ROOT, "scripts/gen-deployment-profile.mjs"), "--print-areas"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, PROFILES_DIR: dir, NODE_NO_WARNINGS: "1" }, maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const areas = compile([
  ["50-pipeline.json", join(ROOT, "scripts/fixtures/record-lifecycle/pipeline.json")],
  ["52-enforce.json", { records: { areas: { tasks: { lifecycle: { enforce: "warn" } } } } }],
]);
const { prepareTaskWrite } = await import("../agent/lib/task-area.ts");
const { areaView } = await import("../agent/lib/record-areas.ts");
const { outcomeEvents } = await import("../agent/lib/record-lifecycle-store.ts");
const tasks = areaView("tasks", areas);
const task = (status) => ({ title: "Chase the invoice", status, done: status === "done", assignee: "ana@probe.example", createdBy: "ana@probe.example", custom: {} });
const lines = (body, who, comment = null) => outcomeEvents(tasks, prepareTaskWrite("update", body, { now: new Date(), ...who }, areas).lifecycle, comment);

const STAMP = Date.now();
const ORG = `lw-probe-${STAMP}`;
const OTHER = `lw-other-${STAMP}`;
const BO = "bo@probe.example";
const ANA = "ana@probe.example";
const ID = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(STAMP).slice(-12).padStart(12, "0")}`;
const SINCE = "2026-10-21T00:00:00Z";
const seed = async (org, id, actor, at, events) => {
  for (const [i, event] of events.entries())
    await admin`insert into entity_activity (org_id, entity_type, entity_id, actor, event, created_at) values (${org}, 'task', ${id}, ${actor}, ${event}, ${new Date(new Date(at).getTime() + i)})`;
};
const snapshot = async () =>
  (await admin`select count(*)::int as n, coalesce(md5(string_agg(id::text || event || created_at::text, ',' order by id)), '') as h from entity_activity where org_id in (${ORG}, ${OTHER})`)[0];
const run = (url, args) =>
  spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/operator/lifecycle-warnings.mjs", ...args], {
    cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: url, NODE_NO_WARNINGS: "1" },
  });

try {
  await admin`insert into orgs (org_id, name, status) values (${ORG}, 'Lifecycle warnings probe', 'active'), (${OTHER}, 'Other probe', 'active')`;
  const cancel = lines({ status: "cancelled", reason: "filed twice" }, { actor: BO, role: "member", before: task("open") }, "filed twice");
  await seed(ORG, ID(1), BO, "2026-10-22T10:00:00Z", cancel);
  await seed(ORG, ID(2), ANA, "2026-10-23T09:00:00Z", lines({ status: "in_progress" }, { actor: ANA, role: "owner", before: task("open") }));
  await seed(ORG, ID(2), ANA, "2026-10-23T09:00:01Z", ["Status changed open → in_progress"]);
  await seed(ORG, ID(3), BO, "2026-10-20T23:00:00Z", cancel);
  await seed(OTHER, ID(1), ANA, "2026-10-25T12:00:00Z", lines({ status: "backlog" }, { actor: ANA, role: "member", before: task("in_progress") }));
  const before = await snapshot();

  console.log("1. The operator script, as app_rw");
  const j = run(appUrl, ["--since", SINCE, "--org", ORG, "--org", OTHER, "--json"]);
  let report = null;
  try {
    report = JSON.parse(j.stdout);
  } catch {
    /* reported below */
  }
  check("--json: exit 0, one JSON object", j.status === 0 && report, j.stderr || j.stdout);
  const a = report?.orgs?.find((o) => o.orgId === ORG);
  const b = report?.orgs?.find((o) => o.orgId === OTHER);
  const w = a?.list?.[0];
  check(
    "the seeded warned move is listed: its rule, from → to, actor and comment, at writeOutcome's time",
    a?.warnings === 1 && w.entityId === ID(1) && w.actor === BO && w.from === "open" && w.to === "cancelled" && w.comment === "filed twice" &&
      JSON.stringify(w.rules) === '["roles"]' && w.at === "2026-10-22T10:00:00.001Z" && w.area === "tasks",
    a,
  );
  check("the moves of the window counted by the Postgres pattern (not the plain feed line, not the line before --since)", a?.moves === 2 && a?.share === 0.5, a);
  check("the other workspace's warned move in its own report only", b?.warnings === 1 && b.list[0].actor === ANA && b.list[0].to === "backlog" && b.moves === 1, b);
  check("totals over both", report?.totals?.warnings === 2 && report?.totals?.moves === 3 && report?.totals?.byRule?.roles === 1 && report?.totals?.byRule?.transition === 1, report?.totals);
  const t = run(appUrl, ["--since", SINCE, "--org", ORG]);
  check("the text says the same", t.status === 0 && /1 warned move\(s\) of 2 lifecycle move\(s\) \(50\.0%\)/.test(t.stdout) && t.stdout.includes(`status: open → cancelled  [roles]  by ${BO}`) && /comment: filed twice/.test(t.stdout), t.stdout + t.stderr);
  console.log(t.stdout.replace(/^/gm, "       | "));
  const late = run(appUrl, ["--since", "2026-10-24", "--org", ORG]);
  check("a later --since leaves the move out", late.status === 0 && /0 warned move\(s\) of 0 lifecycle move\(s\)/.test(late.stdout), late.stdout + late.stderr);
  const none = run(appUrl, ["--since", SINCE, "--org", `nobody-${STAMP}`]);
  check("a workspace that is not there: exit 2, said", none.status === 2 && /no workspace nobody-/.test(none.stderr), none.stderr);

  console.log("2. Read-only");
  process.env.DATABASE_URL = appUrl;
  const { withOrgDb, closeDb } = await import("../agent/lib/db/index.ts");
  const { lifecycleWarningsIn } = await import("../agent/lib/lifecycle-warnings.ts");
  const { sql } = await import("drizzle-orm");
  let refused = null;
  const gate = {
    inOrg: (orgId, fn) =>
      withOrgDb(orgId, async (tx) => {
        const out = await fn(tx);
        // The report's own transaction, after it ran: a write must fail.
        await tx.execute(sql`insert into entity_activity (org_id, entity_type, entity_id, actor, event) values (${orgId}, 'task', 'x', 'probe', 'probe')`).catch((e) => {
          refused = e?.cause?.code ?? e?.code ?? String(e?.message ?? e);
          throw e;
        });
        return out;
      }),
  };
  const r = await lifecycleWarningsIn(gate, ORG, new Date(SINCE)).catch(() => null);
  check("the report's transaction refuses a write (SQLSTATE 25006, read_only_sql_transaction)", refused === "25006" && r === null, refused);
  await closeDb();
  const after = await snapshot();
  check("entity_activity is the same, row for row, after every run", before.n === after.n && before.h === after.h, { before, after });

  console.log("3. A role that bypasses row-level security");
  const su = run(adminUrl, ["--since", SINCE, "--org", ORG]);
  check("refused: exit 2, says why, prints no report", su.status === 2 && /refusing to run as .*(superuser|bypasses row-level security)/.test(su.stderr) && !su.stdout.includes("warned"), su.stderr + su.stdout);
} finally {
  await admin`delete from entity_activity where org_id in (${ORG}, ${OTHER})`.catch(() => {});
  await admin`delete from orgs where org_id in (${ORG}, ${OTHER})`.catch(() => {});
  await admin.end({ timeout: 5 });
}
console.log(failures ? `test-lifecycle-warnings-db: ${failures} FAILED, ${passed} passed` : `test-lifecycle-warnings-db: ${passed} passed`);
process.exit(failures ? 1 : 0);

// Metrics and charts (mold_v0-063; src/metrics.ts, src/metric-spec.ts, molds/mold_v0/MOLD.md "Pack and record-area contract").
//   npm run test:metrics     offline: an embedded database in a temporary directory
//
// Two fixture packs, each a pack.json alone, show that one shell computes two products' own numbers:
//   scripts/fixtures/packs/fixture_vulns     vulnerabilities: open by severity, found vs fixed per week, by application,
//                                            by control, by regulator, against the fix-by date, time to fix, fix rate
//   scripts/fixtures/packs/fixture_adoption  adoption: pick rate (overall, per week, per task, per agent) over run results,
//                                            runs per week, spend and run time over runs
// 1. gen-packs builds both and refuses malformed metrics, charts and tabs, each with its pack and reason (a field the area
//    lacks, an operator a field cannot take, a donut, two y-axes, an ordinal palette on a non-enum, a field name that is
//    not a plain word, a series over many groups, a state time on an area with no lifecycle, ...).
// 2. In the database, two workspaces with known rows and a fixed clock: every metric equals the number worked out by hand
//    from the fixture rows; the same metric evaluated in code (the sealed-row path) gives the same answer; each
//    workspace's metrics count its own rows only (the other's rows, with the same keys, change nothing); a sealed (asset)
//    area's metric opens its rows; a role that may not read an area may not read its metric, and sees a referenced
//    record's key, not its title; a hostile condition value is data; 20,000 rows in a third workspace stay bounded.
// 3. Moves stamp when a record entered each state ($state_at, never shown as a field nor writable).
// 4. HTTP: /api/metrics per workspace and role, /api/runs and /api/runs/:id per workspace; nothing mounted with no packs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIX = (id: string) => path.join(ROOT, "scripts", "fixtures", "packs", id);
const fixtureJson = (id: string) => JSON.parse(readFileSync(path.join(FIX(id), "pack.json"), "utf8"));
const gen = (packsDir: string) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "gen-packs.mjs"), "--packs", packsDir, "--out", path.join(packsDir, "..", "out"), "--profile", path.join(TMP, "none.json")], { cwd: ROOT, encoding: "utf8" });
let n = 0;
const tryPacks = (jsons: unknown[]) => {
  const dir = path.join(TMP, `try-${++n}`, "packs");
  for (const j of jsons) { const d = path.join(dir, (j as { id: string }).id); mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, "pack.json"), JSON.stringify(j, null, 2)); }
  return gen(dir);
};
const refused = (what: string, r: ReturnType<typeof gen>, re: RegExp) => {
  assert.equal(r.status, 1, `${what}: refused (got ${r.status}: ${r.stdout}${r.stderr})`);
  assert.match(r.stderr, re, `${what}: says where and why (${r.stderr.slice(0, 400)})`);
};
const vulns = (edit: (j: any) => void) => { const j = fixtureJson("fixture_vulns"); edit(j); return j; };
const metricOf = (j: any, name: string) => j.metrics.find((m: any) => m.name === name);

try {
  // ---------- 1. the build ----------
  {
    const dir = path.join(TMP, "both", "packs");
    for (const id of ["fixture_vulns", "fixture_adoption"]) cpSync(FIX(id), path.join(dir, id), { recursive: true });
    const r = gen(dir);
    assert.equal(r.status, 0, `gen-packs builds both fixtures: ${r.stderr}`);
    assert.match(r.stdout, /2 pack\(s\) \(fixture_adoption, fixture_vulns\), 0 page\(s\), 5 record area\(s\).*23 metric\(s\), 16 chart\(s\), 16 tab\(s\)/);
    const nav = readFileSync(path.join(dir, "..", "out", "web", "src", "config", "pack-nav.generated.ts"), "utf8");
    const metrics = JSON.parse(/export const packMetrics[^=]*= ([\s\S]*?);\n/.exec(nav)![1]!);
    assert.deepEqual(metrics.find((m: any) => m.name === "apps_by_environment").roles, ["member", "billing", "owner"], "a metric over an area a viewer may not read is not a viewer's");
    assert.deepEqual(Object.fromEntries(metrics.map((m: any) => [m.name, m.unit])).time_to_fix, "days");
    assert.equal(Object.fromEntries(metrics.map((m: any) => [m.name, m.unit])).pick_rate, "percent");
    assert.equal(Object.fromEntries(metrics.map((m: any) => [m.name, m.unit])).run_spend, "usd", "the sum of a run's cost is money");

    const both = (j: any) => tryPacks([j, fixtureJson("fixture_adoption")]);
    const cases: [string, any, RegExp][] = [
      ["a field the area lacks", vulns((j) => { metricOf(j, "open_by_severity").group_by = "priority"; }), /metric open_by_severity: group_by: area audit_findings has no field priority/],
      ["a field name that is not a plain word", vulns((j) => { metricOf(j, "open_by_severity").group_by = "severity'); DROP TABLE runs; --"; }), /metrics\[2\]\.group_by/],
      ["a condition on a number with in", vulns((j) => { metricOf(j, "open_findings").where.push({ field: "cvss", op: "in", value: ["9"] }); }), /cvss is a number: use lt, lte, gt or gte/],
      ["an enum value that is no option", vulns((j) => { metricOf(j, "open_findings").where[0].value = ["open", "closed"]; }), /closed is not one of state's options/],
      ["a date compared with words", vulns((j) => { metricOf(j, "overdue_findings").where[1].value = "yesterday"; }), /lt compares with a number, a date \(YYYY-MM-DD\), today or now/],
      ["a sum of a word field", vulns((j) => { metricOf(j, "mean_cvss_open").field = "severity"; }), /a average reads a number field; severity is enum/],
      ["a state time where there is no lifecycle", vulns((j) => { metricOf(j, "apps_by_environment").by_time = { at: "state:open", every: "week" }; }), /area audit_apps has no lifecycle/],
      ["a state that is not one", vulns((j) => { metricOf(j, "fixed_per_week").by_time.at = "state:done"; }), /state:done: done is not a state of area audit_findings/],
      ["a series over many groups", vulns((j) => { metricOf(j, "found_weekly_by_severity").group_by = "app"; }), /a series grouped by app could have many groups/],
      ["a group by a list field", vulns((j) => { j.record_areas[2].fields.push({ name: "tags", label: "Tags", type: "enum", multiple: true, options: ["a", "b"] }); metricOf(j, "open_by_severity").group_by = "tags"; }), /group_by: tags holds a list/],
      ["a metric over nothing", vulns((j) => { metricOf(j, "open_findings").over = "nowhere"; }), /metric open_findings is over nowhere, which is neither a record area of this build nor run_results or runs/],
      ["a metric name two packs use", vulns((j) => { metricOf(j, "open_findings").name = "pick_rate"; for (const c of j.charts) c.metrics = c.metrics.map((x: string) => (x === "open_findings" ? "pick_rate" : x)); }), /metric pick_rate is already pack fixture_(vulns|adoption)'s/],
      ["a donut", vulns((j) => { j.charts[1].type = "donut"; }), /donut charts are not offered: show part-to-whole as a stacked_bar/],
      ["two y-axes", vulns((j) => { j.charts[2].metrics = ["opened_per_week", "fixed_per_week"]; metricOf(j, "fixed_per_week").measure = "rate"; metricOf(j, "fixed_per_week").rate = { where: [{ field: "state", op: "eq", value: "fixed" }] }; }), /chart open_vs_fixed \(line\) would need two y-axes \(count and percent\)/],
      ["a bar of a single value", vulns((j) => { j.charts[1].metrics = ["open_findings"]; j.charts[1].palette = "categorical"; }), /a bar chart shows a metric by group or by time/],
      ["a stacked bar of rates", vulns((j) => { j.charts[8].metrics = ["median_fix_by_severity", "open_by_severity"]; j.charts[8].palette = "categorical"; }), /stacked_bar.*(counts or sums only|same group_by)/],
      ["lines over different buckets", vulns((j) => { metricOf(j, "fixed_per_week").by_time.last = 12; }), /a line chart shows 1 to 4 metrics over the same time buckets/],
      ["an ordinal palette on a reference", vulns((j) => { j.charts[4].palette = "ordinal"; }), /an ordinal palette colours the ordered options of one metric's enum group_by/],
      ["a chart of an undeclared metric", vulns((j) => { j.charts[0].metrics.push("nope"); }), /chart headline shows metric nope, which this pack does not declare/],
      ["a tab of an undeclared chart", vulns((j) => { j.tabs[0].charts.push("nope"); }), /tab overview shows chart nope, which this pack does not declare/],
      ["a tab of an area no pack declares", vulns((j) => { j.tabs[1].area = "nowhere"; }), /tab vulnerabilities shows area nowhere, which no pack declares/],
      ["a board by a text field", vulns((j) => { j.tabs[1].board_by = "app"; }), /board_by app must name a single-choice enum field/],
      ["a timeline by a state", vulns((j) => { j.tabs[1].timeline_by = "state:open"; }), /timeline_by: a timeline orders records by one of their date fields or by updated/],
      ["a tab no role may read", vulns((j) => { j.tabs[2].roles = ["viewer"]; }), /tab applications: no role may read what it shows/],
      ["a Schedules tab with nothing scheduled", vulns((j) => { j.tabs.push({ id: "sched", kind: "schedules", group: "Workspace" }); }), /tab sched: the build schedules no job kind/],
      ["an icon outside the set", vulns((j) => { j.tabs[0].icon = "skull"; }), /tabs\[0\]\.icon/],
      ["the same label twice in a group", vulns((j) => { j.tabs[4].label = "Overview"; }), /the sidebar already has "Overview" in Audit/],
      ["a tab id that is a page id", vulns((j) => { j.pages = [{ id: "overview", area: "app", title: "O", data: "/o" }]; j.entry = undefined; }), /tab overview: its id is also a page of the pack/],
    ];
    for (const [what, j, re] of cases) refused(what, both(j), re);
    console.log(`✓ gen-packs builds both fixtures (23 metrics, 16 charts, 16 tabs) and refuses ${cases.length} malformed metrics, charts and tabs, each with its pack and reason`);
  }

  // ---------- 2. in the database ----------
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const rec = await import("../src/record-areas.js");
  const met = await import("../src/metrics.js");
  const { createOrg } = await import("../src/auth.js");
  const manifest = (id: string) => ({ id, name: id, version: "1", entry: null, migrations: null, words: {}, dir: FIX(id) });
  const install = (vj = fixtureJson("fixture_vulns"), aj = fixtureJson("fixture_adoption")) =>
    setPacksForTest([{ manifest: manifest("fixture_adoption"), declared: compileDeclarations(aj), definition: null }, { manifest: manifest("fixture_vulns"), declared: compileDeclarations(vj), definition: null }]);
  install();
  const A = (await createOrg(`Metrics A ${STAMP}`)).org, B = (await createOrg(`Metrics B ${STAMP}`)).org, C = (await createOrg(`Metrics C ${STAMP}`)).org;
  const NOW = new Date("2026-10-21T12:00:00Z"); // a Wednesday: this week started Monday 2026-10-19
  const owner = (org: typeof A) => rec.workspaceRecords("fixture_vulns", org.orgId, { role: "owner", userId: "user_owner" });
  const API = { role: null, userId: null } as const, MEMBER = { role: "member", userId: "u_m" } as const, VIEWER = { role: "viewer", userId: "u_v" } as const;
  const day = (d: string) => `${d}T00:00:00.000Z`;

  // Shared controls, each workspace's applications (sealed) and vulnerabilities.
  for (const [k, reg, t] of [["c1", "central_bank", "Access reviews"], ["c2", "privacy", "Data retention"], ["c3", "securities", "Change control"]] as const)
    await rec.putPlatform(null, "audit_controls", k, { title: t, data: { regulator: reg, summary: t } });
  for (const [k, env, t] of [["web", "prod", "Web app"], ["api", "prod", "API"], ["batch", "staging", "Batch jobs"]] as const)
    await owner(A).put("audit_apps", k, { title: t, data: { url: `https://${k}.a.example`, environment: env } });
  await owner(B).put("audit_apps", "web", { title: "B's web", data: { url: "https://web.b.example", environment: "staging" } });
  type F = { key: string; sev: string; final: string; app: string; control?: string; reg?: string; due?: string; cvss?: number; created: string; times: Record<string, string> };
  const A_ROWS: F[] = [
    { key: "f1", sev: "critical", final: "open", app: "web", control: "c1", reg: "central_bank", due: "2026-10-10", cvss: 9.8, created: "2026-10-01", times: {} },
    { key: "f2", sev: "high", final: "triaged", app: "web", control: "c1", reg: "central_bank", due: "2026-10-25", cvss: 7.5, created: "2026-10-14", times: { triaged: "2026-10-15" } },
    { key: "f3", sev: "high", final: "fixed", app: "api", control: "c2", reg: "privacy", due: "2026-10-05", cvss: 8.0, created: "2026-09-22", times: { fixed: "2026-10-02" } },
    { key: "f4", sev: "medium", final: "open", app: "api", control: "c2", reg: "privacy", due: "2026-12-01", cvss: 5.0, created: "2026-10-20", times: {} },
    { key: "f5", sev: "low", final: "fixed", app: "batch", control: "c3", reg: "securities", cvss: 2.0, created: "2026-09-29", times: { fixed: "2026-10-03" } },
    { key: "f6", sev: "medium", final: "accepted", app: "batch", due: "2026-10-01", created: "2026-10-06", times: { accepted: "2026-10-07" } },
    { key: "f7", sev: "critical", final: "reopened", app: "web", control: "c3", reg: "securities", due: "2026-10-20", cvss: 9.1, created: "2026-09-15", times: { fixed: "2026-09-20", reopened: "2026-10-08" } },
    { key: "f8", sev: "low", final: "fixed", app: "web", control: "c1", reg: "central_bank", cvss: 3.1, created: "2026-10-13", times: { fixed: "2026-10-15" } },
  ];
  const B_ROWS: F[] = ["b1", "f1", "f2"].map((key) => ({ key, sev: "critical", final: "open", app: "web", due: "2026-10-01", cvss: 1, created: "2026-10-19", times: {} }));
  const PATH: Record<string, string[]> = { open: [], triaged: ["triaged"], fixed: ["fixed"], accepted: ["accepted"], reopened: ["fixed", "reopened"] };
  for (const [org, rows] of [[A, A_ROWS], [B, B_ROWS]] as const) for (const f of rows) {
    const data: Record<string, unknown> = { severity: f.sev, app: f.app, ...(f.control ? { control: f.control } : {}), ...(f.reg ? { regulator: f.reg } : {}), ...(f.due ? { due: f.due } : {}), ...(f.cvss !== undefined ? { cvss: f.cvss } : {}) };
    await owner(org).put("audit_findings", f.key, { title: `Finding ${f.key}`, data });
    for (const s of PATH[f.final]!) await owner(org).move("audit_findings", f.key, s);
    // The clock is the test's: when each was found and when it entered each state (the store stamped "now" on each move).
    const times = { open: day(f.created), ...Object.fromEntries(Object.entries(f.times).map(([s, d]) => [s, day(d)])) };
    await db.query("UPDATE workspace_records SET created_at = $1, data = jsonb_set(data, '{$state_at}', $2::jsonb) WHERE org_id = $3 AND area = 'audit_findings' AND key = $4",
      [day(f.created), JSON.stringify(times), org.orgId, f.key]);
  }

  const get = (org: typeof A, name: string, actor: { role: any; userId: any } = API, opts?: { forceCode?: boolean }) => met.computeMetric(org.orgId, name, actor, NOW, opts);
  const groups = (a: Awaited<ReturnType<typeof get>>) => a.groups!.map((g) => [g.key, g.label, g.value]);
  const WEEKS = ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"];
  {
    // Every number below is worked out by hand from A_ROWS (open = open, triaged or reopened; today = 2026-10-21).
    assert.equal((await get(A, "open_findings")).value, 4, "open: f1 f2 f4 f7");
    assert.equal((await get(A, "overdue_findings")).value, 2, "open and due before today: f1 (10-10), f7 (10-20)");
    assert.deepEqual(groups(await get(A, "open_by_severity")), [["low", "Low", 0], ["medium", "Medium", 1], ["high", "High", 1], ["critical", "Critical", 2]], "by severity, every option in order");
    const found = await get(A, "opened_per_week");
    assert.deepEqual([found.kind, found.buckets, found.series!.map((s) => s.values)], ["series", WEEKS, [[0, 0, 1, 1, 2, 1, 2, 1]]], "found per week, from Monday");
    assert.deepEqual((await get(A, "fixed_per_week")).series![0]!.values, [0, 0, 1, 0, 2, 0, 1, 0], "fixed per week by when each entered fixed (f7 09-20, f3 and f5 that week of 09-28, f8 10-15)");
    assert.deepEqual(groups(await get(A, "open_by_app")), [["web", "Web app", 3], ["api", "API", 1]], "by application, largest first, named by the (sealed) application's title");
    assert.deepEqual(groups(await get(A, "open_by_control")), [["c1", "Access reviews", 2], ["c2", "Data retention", 1], ["c3", "Change control", 1]], "by control (a shared record's title)");
    assert.deepEqual(groups(await get(A, "open_by_regulator")), [["central_bank", "Central bank", 2], ["securities", "Securities regulator", 1], ["privacy", "Data protection", 1]]);
    assert.deepEqual(groups(await get(A, "open_due_status")), [["overdue", "Overdue", 2], ["due_soon", "Due within 7 days", 1], ["later", "Later", 1]], "against the fix-by date (no undated open one: no 'No date' group)");
    const ttf = await get(A, "time_to_fix");
    assert.deepEqual([ttf.value, ttf.unit, ttf.rows], [Math.round((16 / 3) * 1e6) / 1e6, "days", 3], "average time to fix: (10 + 4 + 2) / 3 days over f3 f5 f8");
    assert.deepEqual(groups(await get(A, "median_fix_by_severity")), [["low", "Low", 3], ["medium", "Medium", null], ["high", "High", 10], ["critical", "Critical", null]], "median days to fix by severity (low: 4 and 2)");
    assert.equal((await get(A, "fix_rate")).value, 0.375, "3 of 8 fixed");
    assert.deepEqual((await get(A, "found_weekly_by_severity")).series!.map((s) => [s.key, s.values]), [
      ["low", [0, 0, 0, 0, 1, 0, 1, 0]], ["medium", [0, 0, 0, 0, 0, 1, 0, 1]], ["high", [0, 0, 0, 1, 0, 0, 1, 0]], ["critical", [0, 0, 1, 0, 1, 0, 0, 0]]], "found per week by severity");
    assert.equal((await get(A, "mean_cvss_open")).value, 7.85, "(9.8 + 7.5 + 5.0 + 9.1) / 4");
    const env = await get(A, "apps_by_environment");
    assert.deepEqual([groups(env), env.partial ?? false], [[["prod", "Production", 2], ["staging", "Staging", 1]], false], "a sealed area's metric opens its rows");
    console.log("✓ the vulnerability set: open 4, overdue 2, by severity, found vs fixed per week, by application, control and regulator, against the fix-by date, time to fix 5.33 days (median by severity), fix rate 37.5%, average CVSS 7.85 — each as worked out by hand");

    // The same metrics evaluated in code (the sealed-row path) give the same answers as SQL.
    const names = ["open_findings", "overdue_findings", "open_by_severity", "opened_per_week", "fixed_per_week", "open_by_app", "open_by_control", "open_by_regulator",
      "open_due_status", "time_to_fix", "median_fix_by_severity", "fix_rate", "found_weekly_by_severity", "mean_cvss_open"];
    for (const name of names) assert.deepEqual(await get(A, name, API, { forceCode: true }), await get(A, name), `${name}: code and SQL agree`);
    console.log(`✓ the code path (for sealed rows) and the SQL path give the same ${names.length} answers`);

    // B: its own three rows (two with A's keys) and nothing of A's; A's numbers above did not count B's.
    assert.equal((await get(B, "open_findings")).value, 3);
    assert.deepEqual(groups(await get(B, "open_by_app")), [["web", "B's web", 3]], "B's own application, by B's title for the same key");
    assert.deepEqual(groups(await get(B, "apps_by_environment")), [["prod", "Production", 0], ["staging", "Staging", 1]]);
    assert.equal((await get(B, "time_to_fix")).value, null, "nothing fixed in B");
    console.log("✓ two workspaces: each one's metrics count its own rows only (B's rows with A's keys change nothing for A)");

    // Who may read: a viewer may not read applications, so not their metric, and sees keys where titles would be.
    await assert.rejects(get(A, "apps_by_environment", VIEWER), (e: { status?: number }) => e.status === 403, "a viewer may not read a metric of an area they may not read");
    assert.deepEqual(groups(await get(A, "open_by_app", VIEWER)), [["web", "web", 3], ["api", "api", 1]], "and sees an application's key, not its title");
    assert.deepEqual(groups(await get(A, "open_by_app", MEMBER)), [["web", "Web app", 3], ["api", "API", 1]]);
    // A metric's own roles narrow further (checked on the server, whatever the console shows).
    install(vulns((j) => { metricOf(j, "fix_rate").roles = ["owner"]; }));
    await assert.rejects(get(A, "fix_rate", MEMBER), (e: { status?: number }) => e.status === 403);
    assert.equal((await get(A, "fix_rate", { role: "owner", userId: "o" })).value, 0.375);
    install();
    console.log("✓ roles: an area's read permission and a metric's roles hold on the server; a referenced record's title only for those who may read it");

    // A hostile value is data: it reaches the query as a bound parameter (field names never do: they are plain words).
    install(fixtureJson("fixture_vulns"), (() => { const j = fixtureJson("fixture_adoption"); j.metrics.push({ name: "probe", label: "Probe", over: "run_results", where: [{ field: "detail.harness", op: "eq", value: "x) OR (TRUE" }] }); return j; })());
    assert.equal((await get(A, "probe")).value, 0, "a condition value with SQL in it matches nothing");
    install();
    // Many groups: the largest shown, and the answer says there are more.
    install(vulns((j) => { metricOf(j, "open_by_app").limit = 1; }));
    const top = await get(A, "open_by_app");
    assert.deepEqual([groups(top), top.more], [[["web", "Web app", 3]], true]);
    install();
    console.log("✓ a condition value carrying SQL is data (0 rows); groups beyond the limit are cut and flagged");
  }

  // Adoption: run results and runs (inserted as the run engine stores them; the engine is not this test's).
  {
    for (const [k, t, cat] of [["t1", "Install the SDK", "setup"], ["t2", "Call the API", "api"], ["t3", "Fix a failing call", "debugging"]] as const)
      await rec.putPlatform(null, "adopt_tasks", k, { title: t, data: { category: cat, difficulty: "easy" } });
    const run = async (org: typeof A, id: string, status: string, cost: number, created: string, started: string | null, ended: string | null) => db.query(
      `INSERT INTO runs (id, org_id, pack, kind, status, spec, max_attempts, token_lifetime_seconds, lease_seconds, budget_usd, cost_usd, created_at, started_at, ended_at)
       VALUES ($1, $2, 'fixture_adoption', 'adopt_simulate', $3, '{}'::jsonb, 1, 3600, 120, 5, $4, $5, $6, $7)`, [id, org.orgId, status, cost, created, started, ended]);
    const result = async (org: typeof A, runId: string, task: string, status: string, harness: string, at: string) => db.query(
      "INSERT INTO run_results (run_id, org_id, check_area, check_key, status, detail, created_at) VALUES ($1, $2, 'adopt_tasks', $3, $4, $5, $6)",
      [runId, org.orgId, task, status, JSON.stringify({ harness }), at]);
    await run(A, `run_a1_${STAMP}`, "succeeded", 1.5, "2026-10-14T10:00:00Z", "2026-10-14T10:00:00Z", "2026-10-14T12:00:00Z");
    await run(A, `run_a2_${STAMP}`, "succeeded", 0.5, "2026-10-20T09:00:00Z", "2026-10-20T09:00:00Z", "2026-10-20T10:00:00Z");
    await run(A, `run_a3_${STAMP}`, "failed", 0.25, "2026-10-20T11:00:00Z", "2026-10-20T11:00:00Z", "2026-10-20T11:05:00Z");
    await run(B, `run_b1_${STAMP}`, "succeeded", 9, "2026-10-20T09:00:00Z", "2026-10-20T09:00:00Z", "2026-10-20T19:00:00Z");
    for (const [t, s, h] of [["t1", "pass", "claude"], ["t2", "fail", "codex"], ["t3", "pass", "claude"]]) await result(A, `run_a1_${STAMP}`, t!, s!, h!, "2026-10-14T12:00:00Z");
    for (const [t, s, h] of [["t1", "pass", "codex"], ["t2", "not_applicable", "codex"], ["t3", "fail", "claude"]]) await result(A, `run_a2_${STAMP}`, t!, s!, h!, "2026-10-20T10:00:00Z");
    for (const t of ["t1", "t2"]) await result(B, `run_b1_${STAMP}`, t, "pass", "claude", "2026-10-20T19:00:00Z");
    assert.equal((await get(A, "pick_rate")).value, 0.6, "3 picks of 5 pass/fail results (not applicable left out)");
    assert.deepEqual((await get(A, "pick_rate_weekly")).series![0]!.values, [null, null, null, null, 0.666667, 0.5], "per week: no results is no rate, not 0");
    assert.deepEqual(groups(await get(A, "pick_rate_by_task")), [["adopt_tasks/t1", "Install the SDK", 1], ["adopt_tasks/t3", "Fix a failing call", 0.5], ["adopt_tasks/t2", "Call the API", 0]], "by task, named by the task's title");
    assert.deepEqual(groups(await get(A, "pick_rate_by_harness")), [["claude", "claude", 0.666667], ["codex", "codex", 0.5]], "by agent (a result's detail)");
    assert.deepEqual(groups(await get(A, "results_by_status")), [["pass", "Pass", 3], ["fail", "Fail", 2], ["error", "Error", 0], ["not_applicable", "Not applicable", 1], ["unknown", "Unknown", 0]]);
    assert.deepEqual((await get(A, "runs_weekly")).series![0]!.values, [0, 0, 0, 0, 1, 2]);
    assert.deepEqual([(await get(A, "run_spend")).value, (await get(A, "run_spend")).unit], [2.25, "usd"]);
    assert.equal((await get(A, "run_hours")).value, 1.5, "(2 h + 1 h) / 2 succeeded runs");
    assert.deepEqual([(await get(B, "pick_rate")).value, (await get(B, "run_spend")).value, (await get(B, "run_hours")).value], [1, 9, 10], "B's own runs only");
    console.log("✓ the adoption set from the same code: pick rate 60% (per week, per task, per agent), results by status, runs per week, spend $2.25, 1.5 h per run; B's apart");
  }

  // 20,000 rows: bounded queries (one aggregate each, a group limit, a window, a statement timeout).
  {
    await db.query(`INSERT INTO workspace_records (org_id, pack, area, key, title, data, created_at)
      SELECT $1, 'fixture_vulns', 'audit_findings', 'n' || i, NULL,
        jsonb_build_object('severity', (ARRAY['low','medium','high','critical'])[1 + i % 4], 'state', (ARRAY['open','triaged','fixed','accepted','reopened'])[1 + i % 5],
          'app', 'app' || (i % 300), 'due', to_char(date '2026-09-01' + (i % 120), 'YYYY-MM-DD'), 'cvss', (i % 100) / 10.0,
          '$state_at', jsonb_build_object('fixed', to_char(timestamp '2026-09-01' + (i % 50) * interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))),
        timestamp '2026-08-01' + (i % 80) * interval '1 day'
      FROM generate_series(1, 20000) AS i`, [C.orgId]);
    const names = (met.buildViews().metrics.filter((m) => m.over === "audit_findings").map((m) => m.name));
    let slowest = 0;
    for (const name of names) {
      const t0 = performance.now();
      const a = await get(C, name);
      slowest = Math.max(slowest, performance.now() - t0);
      if (a.groups) assert.ok(a.groups.length <= 50, `${name}: at most 50 groups`);
    }
    assert.equal((await get(C, "open_findings")).value, 12000, "3 of every 5 open");
    const apps = await get(C, "open_by_app");
    assert.deepEqual([apps.groups!.length, apps.more], [10, true], "300 applications: the 10 largest, flagged");
    assert.ok(slowest < met.METRIC_TIMEOUT_MS, `slowest metric ${Math.round(slowest)} ms`);
    assert.deepEqual([(await get(A, "open_findings")).value, (await get(B, "open_findings")).value], [4, 3], "C's rows count for C only");
    console.log(`✓ 20,000 rows in a third workspace: ${names.length} metrics, slowest ${Math.round(slowest)} ms (statement timeout ${met.METRIC_TIMEOUT_MS} ms), 10 of 300 groups shown; A and B unchanged`);
  }

  // ---------- 3. state times ----------
  {
    const t0 = Date.now();
    await owner(A).put("audit_findings", "s1", { data: { severity: "low", app: "web" } });
    await owner(A).move("audit_findings", "s1", "fixed");
    const raw = (await db.query<{ data: any }>("SELECT data FROM workspace_records WHERE org_id = $1 AND area = 'audit_findings' AND key = 's1'", [A.orgId]))[0]!.data;
    for (const s of ["open", "fixed"]) assert.ok(Date.parse(raw.$state_at[s]) >= t0 - 1000 && Date.parse(raw.$state_at[s]) <= Date.now() + 1000, `entering ${s} is stamped`);
    const read = await rec.getFor(A.orgId, "audit_findings", "s1");
    assert.ok(!("$state_at" in read!.data) && !read!.drift, "never shown as a field, never drift");
    await owner(A).put("audit_findings", "s1", { data: { severity: "medium", app: "web" } });
    const after = (await db.query<{ data: any }>("SELECT data FROM workspace_records WHERE org_id = $1 AND area = 'audit_findings' AND key = 's1'", [A.orgId]))[0]!.data;
    assert.deepEqual(after.$state_at, raw.$state_at, "a write keeps the stamps");
    await assert.rejects(owner(A).put("audit_findings", "s2", { data: { severity: "low", app: "web", $state_at: { fixed: "2020-01-01T00:00:00Z" } } as any }), /has no field "\$state_at"/, "nobody writes them");
    console.log("✓ moves stamp when a record entered each state; a write keeps them; nobody can write them; never shown as a field");
  }

  // ---------- 4. HTTP ----------
  const http = await startHttp();
  try {
    const ma = await http.signIn(A, "member"), va = await http.signIn(A, "viewer"), mb = await http.signIn(B, "member");
    const getJ = async (p: string, tok?: string) => { const r = await http.req("GET", p, tok ? { authorization: `Bearer ${tok}` } : {}); return { status: r.status, body: await r.json().catch(() => null) as any }; };
    assert.equal((await getJ("/api/metrics?names=open_findings")).status, 401, "signed out: 401");
    const a = await getJ("/api/metrics?names=open_findings,apps_by_environment,pick_rate,no_such", ma);
    assert.equal(a.status, 200);
    const by = (b: any) => Object.fromEntries(b.metrics.map((m: any) => [m.name, m.error ? m.status : m.value ?? m.groups?.length]));
    assert.deepEqual(by(a.body), { open_findings: 4, apps_by_environment: 2, pick_rate: 0.6, no_such: 404 }, "A's member: A's numbers, an unknown metric refused alone");
    assert.equal(by((await getJ("/api/metrics?names=open_findings,apps_by_environment", va)).body).apps_by_environment, 403, "a viewer: refused for that metric alone");
    assert.equal(by((await getJ("/api/metrics?names=open_findings", mb)).body).open_findings, 3, "B's member: B's numbers");
    assert.equal((await getJ("/api/metrics", ma)).status, 400, "names are required");
    assert.equal((await getJ(`/api/metrics?names=${"m,".repeat(40)}x`, ma)).status, 400, "at most 30 at once");
    assert.equal((await getJ("/api/metrics?names=open_findings'%3B--", ma)).status, 400, "names are plain words");
    const runsA = await getJ("/api/runs", ma);
    assert.deepEqual(runsA.body.runs.map((r: any) => r.id).sort(), [`run_a1_${STAMP}`, `run_a2_${STAMP}`, `run_a3_${STAMP}`].sort(), "A's runs only");
    assert.deepEqual(runsA.body.runs.find((r: any) => r.id === `run_a2_${STAMP}`).results, { pass: 1, fail: 1, not_applicable: 1 }, "each run's results by status");
    assert.equal((await getJ(`/api/runs/run_b1_${STAMP}`, ma)).status, 404, "B's run from A: not found");
    const one = await getJ(`/api/runs/run_a1_${STAMP}`, va);
    assert.deepEqual([one.status, one.body.results.length], [200, 3], "a viewer reads a run's results");
    console.log("✓ HTTP: /api/metrics per workspace and role (401 signed out, one metric refused alone, names checked); /api/runs and /api/runs/:id per workspace");
  } finally {
    await http.close();
  }
  {
    // No packs: the routers mount nothing.
    setPacksForTest([]);
    const { metricAppRouter, runAppRouter } = await import("../src/view-routes.js");
    const express = (await import("express")).default;
    const app = express();
    app.use("/api/metrics", metricAppRouter());
    app.use("/api/runs", runAppRouter());
    app.use((_req, res) => void res.status(418).end());
    const srv = app.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const port = (srv.address() as import("node:net").AddressInfo).port;
    for (const p of ["/api/metrics?names=open_findings", "/api/runs"]) assert.equal((await fetch(`http://127.0.0.1:${port}${p}`)).status, 418, `${p}: nothing answers with no packs`);
    srv.close();
    console.log("✓ with no packs, /api/metrics and /api/runs are not mounted");
  }
} finally {
  cleanup();
}
process.exit(0);

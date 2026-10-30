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
// 5. A list tab's four cards (mold_v0-181, src/sparklines.ts): a tab's declared metrics and the shell's defaults (an area
//    tab's, a runs tab's), each value and its 12 weeks worked out by hand; per workspace and role, on /api/sparklines too.
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
    // mold_v0-079: a value already 0 to 100 (an average of percentages a run measured) is "percent_100", shown as it is
    // ("percent" is a share from 0 to 1, a rate, shown times 100).
    {
      const r100 = tryPacks([vulns((j) => { metricOf(j, "mean_cvss_open").unit = "percent_100"; })]);
      assert.equal(r100.status, 0, `a percent_100 unit builds: ${r100.stderr}`);
      const nav100 = readFileSync(path.join(TMP, `try-${n}`, "out", "web", "src", "config", "pack-nav.generated.ts"), "utf8");
      const m100 = JSON.parse(/export const packMetrics[^=]*= ([\s\S]*?);\n/.exec(nav100)![1]!);
      assert.equal(m100.find((m: any) => m.name === "mean_cvss_open").unit, "percent_100");
      assert.match(nav100, /unit: 'count' \| 'number' \| 'usd' \| 'percent' \| 'percent_100' \| 'days' \| 'hours';/, "the console's type knows it");
      refused("a unit that is none", tryPacks([vulns((j) => { metricOf(j, "mean_cvss_open").unit = "percent_points"; })]), /mean_cvss_open|metrics\[\d+\]\.unit/);
    }

    const both = (j: any) => tryPacks(j.job_kinds ? [j, fixtureJson("fixture_adoption")] : [j]);
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
      ["a Schedules tab with nothing to schedule", vulns((j) => { delete j.job_kinds; j.tabs.push({ id: "sched", kind: "schedules", group: "Workspace" }); }), /tab sched: the build has no job kind to schedule/],
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
    assert.deepEqual(groups(await get(A, "open_by_app", VIEWER)), [["restricted-0", "Restricted", 3], ["restricted-1", "Restricted", 1]], "and sees neither an application's title nor its key");
    assert.deepEqual(groups(await get(A, "open_by_app", MEMBER)), [["web", "Web app", 3], ["api", "API", 1]]);
    // A metric's own roles narrow further (checked on the server, whatever the console shows).
    install(vulns((j) => { metricOf(j, "fix_rate").roles = ["owner"]; }));
    await assert.rejects(get(A, "fix_rate", MEMBER), (e: { status?: number }) => e.status === 403);
    assert.equal((await get(A, "fix_rate", { role: "owner", userId: "o" })).value, 0.375);
    install();
    console.log("✓ roles: an area's read permission and a metric's roles hold on the server; a referenced record is named (title or key) only for those who may read it");

    // Durations: a span that ends before it starts (a state entered again since) is left out.
    install(vulns((j) => {
      j.metrics.push({ name: "found_to_fixed_all", label: "Found to fixed", over: "audit_findings", measure: "duration", duration: { from: "created", to: "state:fixed" } });
      j.metrics.push({ name: "reopened_to_fixed", label: "Reopened to fixed", over: "audit_findings", measure: "duration", duration: { from: "state:reopened", to: "state:fixed" } });
    }));
    const all = await get(A, "found_to_fixed_all");
    assert.deepEqual([all.value, all.rows], [5.25, 4], "found to (last) fixed over f3 f5 f7 f8: (10 + 4 + 5 + 2) / 4, whatever their state now");
    const back = await get(A, "reopened_to_fixed");
    assert.deepEqual([back.value, back.rows], [null, 0], "f7 was fixed before it was reopened: no negative duration");
    assert.deepEqual(await get(A, "reopened_to_fixed", API, { forceCode: true }), back, "the code path agrees");
    install();
    console.log("✓ durations leave out spans that end before they start (fixed, then reopened)");

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

  // A list tab's four cards (mold_v0-181; section 5 below, and the runs tab's with the adoption set).
  const spark = await import("../src/sparklines.js");
  const withCards = () => vulns((j) => {
    j.metrics.push({ name: "apps_total", label: "Applications", over: "audit_apps" });
    j.tabs.find((t: any) => t.id === "reports").sparklines = ["open_findings", "opened_per_week", "time_to_fix", "fix_rate"];
    j.tabs.find((t: any) => t.id === "applications").sparklines = ["apps_total", "open_findings", "fix_rate", "opened_per_week"];
    j.tabs.find((t: any) => t.id === "audits").label = "Audits";
  });
  const cardsOf = async (org: typeof A, id: string, actor: { role: any; userId: any } = API) => {
    const t = met.buildViews().tabs.find((x) => x.pack === "fixture_vulns" && x.id === id)!;
    return spark.computeSparklines(org.orgId, t, actor, NOW);
  };
  const said = (c: { id: string; label: string; value: number | null; series: (number | null)[]; mode: string; status?: number }) => [c.id, c.label, c.mode, c.status ?? c.value, c.series];
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
    // Two findings on one check (mold_v0-065: a fingerprint is part of a result's identity) are two rows: each counts.
    for (const fp of ["fp-1", "fp-2"]) await db.query("INSERT INTO run_results (run_id, org_id, check_area, check_key, status, finding_fingerprint, created_at) VALUES ($1, $2, 'adopt_tasks', 't3', 'fail', $3, '2026-10-20T19:00:00Z')", [`run_b1_${STAMP}`, B.orgId, fp]);
    assert.equal((await get(A, "pick_rate")).value, 0.6, "3 picks of 5 pass/fail results (not applicable left out)");
    assert.deepEqual((await get(A, "pick_rate_weekly")).series![0]!.values, [null, null, null, null, 0.666667, 0.5], "per week: no results is no rate, not 0");
    assert.deepEqual(groups(await get(A, "pick_rate_by_task")), [["adopt_tasks/t1", "Install the SDK", 1], ["adopt_tasks/t3", "Fix a failing call", 0.5], ["adopt_tasks/t2", "Call the API", 0]], "by task, named by the task's title");
    assert.deepEqual(groups(await get(A, "pick_rate_by_harness")), [["claude", "claude", 0.666667], ["codex", "codex", 0.5]], "by agent (a result's detail)");
    assert.deepEqual(groups(await get(A, "results_by_status")), [["pass", "Pass", 3], ["fail", "Fail", 2], ["error", "Error", 0], ["not_applicable", "Not applicable", 1], ["unknown", "Unknown", 0]]);
    assert.deepEqual((await get(A, "runs_weekly")).series![0]!.values, [0, 0, 0, 0, 1, 2]);
    assert.deepEqual([(await get(A, "run_spend")).value, (await get(A, "run_spend")).unit], [2.25, "usd"]);
    assert.equal((await get(A, "run_hours")).value, 1.5, "(2 h + 1 h) / 2 succeeded runs");
    await assert.rejects(get(A, "pick_rate", VIEWER), (e: { status?: number }) => e.status === 403, "run results name applications, which a viewer may not read here");
    assert.equal((await get(A, "pick_rate", MEMBER)).value, 0.6);
    assert.deepEqual([(await get(B, "pick_rate")).value, (await get(B, "run_spend")).value, (await get(B, "run_hours")).value], [0.5, 9, 10], "B's own runs only (2 picks of 4: two findings on one check count twice)");
    assert.deepEqual(groups(await get(B, "results_by_status")).slice(0, 2), [["pass", "Pass", 2], ["fail", "Fail", 2]], "findings, not check x asset pairs");
    console.log("✓ the adoption set from the same code: pick rate 60% (per week, per task, per agent), results by status, runs per week, spend $2.25, 1.5 h per run; B's apart");
    // The shell's cards for a runs tab (mold_v0-181): this week's runs, the share that succeeded, the average duration, the spend.
    install(withCards());
    const runs = await cardsOf(A, "audits");
    const n = null;
    assert.deepEqual(runs.cards.map(said), [
      ["_runs_week", "Audits this week", "latest", 2, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]],
      ["_succeeded", "Succeeded", "weekly", 0.666667, [n, n, n, n, n, n, n, n, n, n, 1, 0.5]],
      ["_duration", "Average duration", "weekly", 1.027778, [n, n, n, n, n, n, n, n, n, n, 2, 0.541667]],
      ["_spend", "Spend", "total", 2.25, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1.5, 2.25]],
    ], "2 this week (a2 a3); 2 of 3 succeeded; (2 h + 1 h + 5 min) / 3; $2.25 in all, $1.50 by the week of 10-12");
    assert.deepEqual(runs.cards.map((c) => c.unit), ["count", "percent", "hours", "usd"]);
    assert.deepEqual((await cardsOf(B, "audits")).cards.map((c) => c.value), [1, 1, 10, 9], "B's own run only");
    install();
    console.log("✓ a runs tab's cards from the shell: audits this week 2, succeeded 66.7%, 1.03 h on average, spend $2.25 (a running total); B's apart");
  }

  // ---------- 5. a list tab's four cards (mold_v0-181) ----------
  {
    install(withCards());
    // The 12 weeks up to NOW's (Monday 2026-10-19), oldest first.
    const W12 = ["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24", ...WEEKS];
    const n = null;
    const declared = await cardsOf(A, "reports");
    assert.deepEqual([declared.weeks, declared.buckets], [12, W12], "12 weeks, from Monday");
    assert.deepEqual(declared.cards.map(said), [
      // Open now, f1 f2 f4 f7; a running total of those by the week each was added (f7 09-15, f1 10-01, f2 10-14, f4 10-20).
      ["open_findings", "Open vulnerabilities", "total", 4, [0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 4]],
      // A series metric: this week's bucket, and its weeks (8 declared, 12 drawn).
      ["opened_per_week", "Found this week", "latest", 1, [0, 0, 0, 0, 0, 0, 1, 1, 2, 1, 2, 1]],
      // Average days to fix (10 + 4 + 2) / 3, and week by week by when each was fixed: f3 and f5 (10 and 4) that of 09-28, f8 (2) that of 10-12.
      ["time_to_fix", "Average time to fix", "weekly", Math.round((16 / 3) * 1e6) / 1e6, [n, n, n, n, n, n, n, n, 7, n, 2, n]],
      // 3 of 8 fixed; week by week by when each was added: f7 0, f3 1, f1 f5 1/2, f6 0, f2 f8 1/2, f4 0.
      ["fix_rate", "Fixed", "weekly", 0.375, [n, n, n, n, n, n, 0, 1, 0.5, 0, 0.5, 0]],
    ], "a tab's declared cards, each as worked out by hand");
    assert.deepEqual(declared.cards.map((c) => c.unit), ["count", "count", "days", "percent"]);
    // The shell's cards for an area tab: the rows, new in 7 days, then the pack's first two metrics over the area.
    const area = await cardsOf(A, "vulnerabilities");
    assert.deepEqual(area.cards.map((c) => [c.id, c.mode, c.value]), [["_records", "total", 8], ["_new_7d", "weekly", 1], ["open_findings", "total", 4], ["overdue_findings", "total", 2]],
      "8 vulnerabilities, 1 added since 10-14 noon (f4), open 4, overdue 2");
    assert.deepEqual(area.cards.slice(0, 2).map((c) => c.series), [[0, 0, 0, 0, 0, 0, 1, 2, 4, 5, 7, 8], [0, 0, 0, 0, 0, 0, 1, 1, 2, 1, 2, 1]], "all rows as a running total; new ones per week");
    // Without pack metrics over the area: changed in 7 days and the main enum's most common value (the lifecycle's).
    install(vulns((j) => { j.metrics = j.metrics.filter((m: any) => m.over !== "audit_findings"); j.charts = []; for (const t of j.tabs) t.charts = []; j.tabs = j.tabs.filter((t: any) => t.kind !== "overview"); }));
    const bare = await cardsOf(A, "vulnerabilities");
    assert.deepEqual(bare.cards.map((c) => [c.id, c.value]), [["_records", 8], ["_new_7d", 1], ["_changed_7d", 8], ["_top", 3]], "no own metrics: every row was written this week (the test wrote them), and the commonest state");
    assert.match(bare.cards[3]!.label, /^State: (Fixed|fixed)$/, "named by the field and its value (3 fixed: f3 f5 f8)");
    assert.deepEqual(bare.cards[3]!.series, [0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 3, 3], "the fixed ones by the week each was added (f3 09-22, f5 09-29, f8 10-13)");
    install(withCards());
    // Two workspaces: B's own rows only.
    assert.deepEqual((await cardsOf(B, "reports")).cards.map((c) => c.value), [3, 3, null, 0], "B: 3 open, 3 found this week, nothing fixed");
    // Roles: a card the person may not read says so alone; the rest are theirs.
    const v = await cardsOf(A, "applications", VIEWER);
    assert.deepEqual(v.cards.map((c) => c.status ?? "ok"), [403, "ok", "ok", "ok"], "a viewer may not read applications: that card alone is refused");
    assert.equal((await cardsOf(A, "applications", MEMBER)).cards[0]!.value, 3, "a member reads it (a sealed area, opened)");
    console.log("✓ a list tab's cards: declared (a running total, a series' current week, a duration and a rate week by week) and the shell's for an area (rows, new in 7 days, the pack's metrics; else changed and the commonest value), each worked out by hand; B's apart; a card a role may not read refused alone");
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
    // A board's move goes through the generic data API (mold_v0-059), which stamps the state's time like any move.
    const mv = await http.req("POST", "/api/data/audit_findings/f4/move", { authorization: `Bearer ${ma}`, "X-Pack-Request": "1" }, { to: "triaged" });
    assert.equal(mv.status, 200, `a member moves a record from the board: ${await mv.clone().text()}`);
    const f4 = (await db.query<{ data: any }>("SELECT data FROM workspace_records WHERE org_id = $1 AND area = 'audit_findings' AND key = 'f4'", [A.orgId]))[0]!.data;
    assert.ok(f4.state === "triaged" && f4.$state_at.triaged && f4.$state_at.open, "moved through the data API, its state time stamped, the earlier ones kept");
    assert.equal((await http.req("POST", "/api/data/audit_findings/f4/move", { authorization: `Bearer ${va}`, "X-Pack-Request": "1" }, { to: "fixed" })).status, 403, "a viewer may not move");
    const runsA = await getJ("/api/runs", ma);
    assert.deepEqual(runsA.body.runs.map((r: any) => r.id).sort(), [`run_a1_${STAMP}`, `run_a2_${STAMP}`, `run_a3_${STAMP}`].sort(), "A's runs only");
    assert.deepEqual(runsA.body.runs.find((r: any) => r.id === `run_a2_${STAMP}`).results, { pass: 1, fail: 1, not_applicable: 1 }, "each run's results by status");
    assert.equal((await getJ(`/api/runs/run_b1_${STAMP}`, ma)).status, 404, "B's run from A: not found");
    const one = await getJ(`/api/runs/run_a1_${STAMP}`, va);
    assert.deepEqual([one.status, one.body.results.length], [200, 3], "a viewer reads a run's results");
    console.log("✓ HTTP: /api/metrics per workspace and role (401 signed out, one metric refused alone, names checked); /api/runs and /api/runs/:id per workspace");
    // A list tab's cards (mold_v0-181): per workspace and role, the tab's own rules, nothing but a list tab.
    install(withCards());
    assert.equal((await getJ("/api/sparklines/fixture_vulns/reports")).status, 401, "signed out: 401");
    const ca = await getJ("/api/sparklines/fixture_vulns/reports", ma);
    assert.deepEqual([ca.status, ca.body.cards.length, ca.body.cards[0].id, ca.body.cards[0].value, ca.body.buckets.length], [200, 4, "open_findings", 4, 12], "A's member: A's four cards");
    assert.equal((await getJ("/api/sparklines/fixture_vulns/reports", mb)).body.cards[0].value, 3, "B's member: B's");
    assert.deepEqual((await getJ("/api/sparklines/fixture_vulns/applications", va)).status, 403, "a tab the role may not see: 403");
    assert.equal((await getJ("/api/sparklines/fixture_vulns/overview", ma)).status, 404, "not a list tab: 404");
    assert.equal((await getJ("/api/sparklines/fixture_vulns/nope", ma)).status, 404, "no such tab: 404");
    assert.equal((await getJ("/api/sparklines/fixture_adoption/reports", ma)).status, 404, "another pack's tab id: 404");
    install();
    console.log("✓ HTTP: /api/sparklines/<pack>/<tab> per workspace and role (401 signed out, 403 for a tab the role does not see, 404 for anything but a list tab)");
  } finally {
    await http.close();
  }
  {
    // No packs: the routers mount nothing.
    setPacksForTest([]);
    const { metricAppRouter, runAppRouter, sparklineAppRouter } = await import("../src/view-routes.js");
    const express = (await import("express")).default;
    const app = express();
    app.use("/api/metrics", metricAppRouter());
    app.use("/api/runs", runAppRouter());
    app.use("/api/sparklines", sparklineAppRouter());
    app.use((_req, res) => void res.status(418).end());
    const srv = app.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const port = (srv.address() as import("node:net").AddressInfo).port;
    for (const p of ["/api/metrics?names=open_findings", "/api/runs", "/api/sparklines/fixture_vulns/reports"]) assert.equal((await fetch(`http://127.0.0.1:${port}${p}`)).status, 418, `${p}: nothing answers with no packs`);
    srv.close();
    console.log("✓ with no packs, /api/metrics, /api/runs and /api/sparklines are not mounted");
  }
} finally {
  cleanup();
}
process.exit(0);

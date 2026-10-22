// Record areas' gaps found by the second app (mold_v0-076; src/data-repositories.ts valueAt, src/metrics.ts,
// src/schedules.ts dueCheck, molds/mold_v0/MOLD.md "Pack and record-area contract"). Offline: an embedded database, a fake
// Clerk and a fake Resend, a declarative pack with no code, two workspaces and a fixed clock.
//   npm run test:record-gaps
//
// 1. Value paths take a list's items: controls[0], refs[0].id, $.a[2].b, in a declared map's fields, keys, titles and
//    where. The grammar refuses everything else (negative, computed, padded or huge indexes, __proto__ and friends, an
//    index on a placeholder); a step that does not fit (an index past the end, a list where a property is named) is no value.
// 2. Metrics group by a field that holds a list (a link, an enum with multiple) when they declare group_by_list: first
//    (the list's first item; a link holding one key is that key) or each (a row in the group of every distinct item it
//    lists; `rows` counts each row once). Numbers by hand; SQL and the code path (sealed rows) agree; the same metrics
//    over a sealed area open its rows; each workspace counts its own. The build still refuses a list without
//    group_by_list, group_by_list on a single value, and group_by_list without a field.
// 3. Due dates on a sealed area: the daily check opens each workspace's sealed rows with its own key and posts a notice
//    for each record due within the window; the notice's title is sealed at rest (nothing of it in the clear), opened only
//    for its workspace; the email names the record by key, never its title; with the key vault locked nothing is opened
//    (the workspaces are counted as skipped); a metric over the sealed area's due dates computes in code.
import assert from "node:assert/strict";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";

const NOW = new Date("2026-10-21T12:00:00Z");
const finding = (o: Record<string, unknown>) => JSON.stringify({ kind: "finding", ...o });
const LEDGER_A = [
  finding({ id: "g1", title: "Finding g1", severity: "high", controlIds: ["c1", "c2"], refs: [{ regulator: "rbi", instrument: "rbi-1" }], slaDueAt: "2026-10-10", tags: ["x", "y"], cvss: 8 }),
  finding({ id: "g2", title: "Finding g2", severity: "low", controlIds: ["c2"], refs: [{ regulator: "sebi", instrument: "sebi-2" }, { regulator: "rbi", instrument: "rbi-1" }], slaDueAt: "2026-10-25", tags: ["y"], cvss: 4 }),
  finding({ id: "g3", title: "Finding g3", severity: "high", controlIds: ["c3", "c1", "c1"], refs: [], slaDueAt: "2026-12-01", tags: [], cvss: 6 }),
  finding({ id: "g4", title: "Finding g4", severity: "low", controlIds: [], tags: ["z"] }),
  finding({ id: "g5", title: "Finding g5", severity: "high", refs: "not a list", slaDueAt: "2026-10-22" }),
  JSON.stringify({ kind: "control", id: "c1", title: "a control line, not a finding" }),
  // Append-only: g1's later line wins (critical now).
  finding({ id: "g1", title: "Finding g1", severity: "critical", controlIds: ["c1", "c2"], refs: [{ regulator: "rbi", instrument: "rbi-1" }], slaDueAt: "2026-10-10", tags: ["x", "y"], cvss: 8 }),
].join("\n");
// B: its own rows, one with A's key g2 (due outside the window) and one due within it.
const LEDGER_B = [
  finding({ id: "g2", title: "B's g2", severity: "low", controlIds: ["c3"], slaDueAt: "2026-11-30" }),
  finding({ id: "b1", title: "B's b1", severity: "high", controlIds: ["c1"], slaDueAt: "2026-10-23", tags: ["x"] }),
].join("\n");
const REFS = JSON.stringify({ items: [{ id: "r1", refs: [{ regulator: "rbi", instrument: "rbi-1" }] }, { id: "r2", refs: [{ regulator: "sebi", instrument: "sebi-2" }] }] });

const fields = [
  { name: "severity", label: "Severity", type: "enum", options: ["low", "high", "critical"] },
  { name: "control", label: "Primary control", type: "link" },
  { name: "controls", label: "Controls", type: "link" },
  { name: "regulator", label: "Regulator", type: "text" },
  { name: "instrument", label: "Instrument", type: "text" },
  { name: "due", label: "Fix by", type: "date" },
  { name: "tags", label: "Tags", type: "enum", multiple: true, options: ["x", "y", "z"] },
  { name: "cvss", label: "CVSS", type: "number" },
];
const links = [{ field: "control", area: "gp_controls" }, { field: "controls", area: "gp_controls" }];
const map = { key: "{id}", title: "{title}", where: { kind: "finding" },
  fields: { control: "controlIds[0]", controls: "controlIds", regulator: "refs[0].regulator", instrument: "refs[0].instrument", due: "slaDueAt" } };
const metric = (name: string, over: string, extra: Record<string, unknown>) => ({ name, label: name, over, ...extra });
const PACK = (edit: (j: any) => void = () => {}) => {
  const j: any = JSON.parse(JSON.stringify({
    id: "fixture_gaps", name: "Fixture gaps", version: "0.1.0",
    record_areas: [
      { name: "gp_controls", label: "Controls", role: "source", scope: "platform", fields: [{ name: "summary", label: "Summary", type: "text" }] },
      { name: "gp_findings", label: "Findings", role: "check", scope: "workspace", repository: "ledger", fields, links },
      { name: "gp_sealed", label: "Sealed findings", role: "check", scope: "workspace", repository: "ledger", sealed: true, fields, links,
        permissions: { read: ["member", "billing", "owner"] },
        due: { field: "due", within_days: 7, notify: ["owner"] } },
      { name: "gp_refs", label: "Refs", role: "check", scope: "workspace", repository: "refs", fields: [{ name: "regulator", label: "Regulator", type: "text" }] },
    ],
    repositories: {
      ledger: { kind: "workspace_files", store: "fixture_gaps", path: "ledger.jsonl", format: "jsonl", identity: "id", append_only: true, map: { gp_findings: map, gp_sealed: map } },
      refs: { kind: "workspace_files", store: "fixture_gaps", path: "refs.json", format: "json",
        map: { gp_refs: { each: "items", key: "{refs[0].instrument}:{id}", title: "{refs[0].regulator} {id}", where: { "refs[0].regulator": "rbi" }, fields: { regulator: "refs[0].regulator" } } } },
    },
    metrics: [
      metric("by_control_first", "gp_findings", { group_by: "control", group_by_list: "first" }),
      metric("by_control_each", "gp_findings", { group_by: "controls", group_by_list: "each" }),
      metric("cvss_by_control_each", "gp_findings", { measure: "average", field: "cvss", group_by: "controls", group_by_list: "each" }),
      metric("by_tag_each", "gp_findings", { group_by: "tags", group_by_list: "each" }),
      metric("high_by_control_first", "gp_findings", { where: [{ field: "severity", op: "in", value: ["high", "critical"] }], group_by: "controls", group_by_list: "first" }),
      metric("due_weekly_by_tag", "gp_findings", { group_by: "tags", group_by_list: "each", by_time: { at: "due", every: "week", last: 12 } }),
      metric("sealed_by_control_first", "gp_sealed", { group_by: "control", group_by_list: "first" }),
      metric("sealed_by_control_each", "gp_sealed", { group_by: "controls", group_by_list: "each" }),
      metric("sealed_due_status", "gp_sealed", { group_by: { due: "due", soon_days: 7 } }),
      metric("sealed_overdue", "gp_sealed", { where: [{ field: "due", op: "lt", value: "today" }] }),
    ],
  }));
  edit(j);
  return j;
};

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { VALUE_PATH } = await import("../src/pack-api.js");
  const repos = await import("../src/data-repositories.js");
  const rec = await import("../src/record-areas.js");
  const met = await import("../src/metrics.js");
  const sch = await import("../src/schedules.js");
  const { isSealed, open } = await import("../src/orgcrypto.js");
  const { createOrg } = await import("../src/auth.js");
  const { withTenant } = await import("../src/tenant-scope.js");
  const manifest = { id: "fixture_gaps", name: "Fixture gaps", version: "1", entry: null, migrations: null, words: {}, dir: TMP };
  const install = (j = PACK()) => setPacksForTest([{ manifest, declared: compileDeclarations(j), definition: null }]);

  // ---------- 1. value paths ----------
  {
    for (const ok of ["controls[0]", "refs[0].id", "$.a[2].b", "a[0][1]", "a[999]", "a.b[10].c", "@file", "$.instrumentId", "groups.controls"])
      assert.ok(VALUE_PATH.test(ok), `${ok} is a value path`);
    for (const bad of ["a[-1]", "a[1000]", "a[01]", "a[x]", "a[0", "a]", "[0]", "a.[0]", "a[0].__proto__", "__proto__[0]", "constructor[0]", "a[0].prototype.b",
      "a[ 0]", "@file[0]", "a[0]b", "$[0]", "a[0]]", "a[0.5]", "a[1e2]", "a['b']", "a[\"b\"]", "a[0].", ".a[0]", "a..b", "a[0]\n"])
      assert.ok(!VALUE_PATH.test(bad), `${JSON.stringify(bad)} is refused`);
    assert.throws(() => compileDeclarations(PACK((j) => { j.repositories.ledger.map.gp_findings.fields.control = "controlIds[0].constructor"; })), /value path/);
    assert.throws(() => compileDeclarations(PACK((j) => { j.repositories.ledger.map.gp_findings.key = "{controlIds[-1]}"; })), /template/);
    assert.throws(() => compileDeclarations(PACK((j) => { j.repositories.ledger.map.gp_findings.where = { "controlIds[x]": "c1" }; })), /where\.controlIds\[x\]/);

    install();
    const src = repos.filesSource([{ path: "ledger.jsonl", body: LEDGER_A }, { path: "refs.json", body: REFS }]);
    const ledger = await repos.repositoryRows("fixture_gaps", "ledger", src);
    const rows = ledger.get("gp_findings")!.map((r) => [r.key, r.data.severity, r.data.control, r.data.controls, r.data.regulator, r.data.instrument, r.data.due]);
    assert.deepEqual(rows, [
      ["g1", "critical", "c1", ["c1", "c2"], "rbi", "rbi-1", "2026-10-10"],
      ["g2", "low", "c2", ["c2"], "sebi", "sebi-2", "2026-10-25"],
      ["g3", "high", "c3", ["c3", "c1", "c1"], undefined, undefined, "2026-12-01"],
      ["g4", "low", undefined, [], undefined, undefined, undefined],
      ["g5", "high", undefined, undefined, undefined, undefined, "2026-10-22"],
    ], "controlIds[0] and refs[0].x: the first item, nothing past the end, nothing on a value that is not a list; the latest line of g1");
    assert.deepEqual(ledger.get("gp_sealed")!.map((r) => r.data), ledger.get("gp_findings")!.map((r) => r.data), "the same map feeds the sealed area");
    const refs = (await repos.repositoryRows("fixture_gaps", "refs", src)).get("gp_refs")!;
    assert.deepEqual(refs.map((r) => [r.key, r.title, r.data.regulator]), [["rbi-1:r1", "rbi r1", "rbi"]], "a list's item in a key and a title template, and in where");
    console.log("✓ value paths: controls[0], refs[0].id, $.a[2].b in fields, keys, titles and where; refused: negative, computed, padded or huge indexes, __proto__ and friends, an index on a placeholder");
  }

  // ---------- 2. metrics grouped by a list ----------
  const A = (await createOrg(`Gaps A ${STAMP}`)).org, B = (await createOrg(`Gaps B ${STAMP}`)).org;
  for (const [k, t] of [["c1", "Access reviews"], ["c2", "Data retention"], ["c3", "Change control"]] as const)
    await rec.putPlatform(null, "gp_controls", k, { title: t, data: { summary: t } });
  await repos.indexWorkspaceFiles(A.orgId, "fixture_gaps", [{ path: "ledger.jsonl", body: LEDGER_A }, { path: "refs.json", body: REFS }]);
  await repos.indexWorkspaceFiles(B.orgId, "fixture_gaps", [{ path: "ledger.jsonl", body: LEDGER_B }]);
  const API = { role: null, userId: null } as const, VIEWER = { role: "viewer", userId: "u_v" } as const;
  const get = (org: typeof A, name: string, opts?: { forceCode?: boolean }) => met.computeMetric(org.orgId, name, API, NOW, opts);
  const groups = (a: Awaited<ReturnType<typeof get>>) => a.groups!.map((g) => [g.key, g.label, g.value]);
  {
    const sealedRaw = await db.query<{ data: any; title: string; sealed: boolean }>("SELECT data, title, sealed FROM workspace_records WHERE area = 'gp_sealed'");
    assert.ok(sealedRaw.length === 7 && sealedRaw.every((r) => r.sealed && isSealed(r.title) && !JSON.stringify(r).includes("Finding") && !JSON.stringify(r).includes("2026-10")), "the sealed area's rows are ciphertext at rest");

    const first = await get(A, "by_control_first");
    assert.deepEqual(groups(first), [[null, "No value", 2], ["c1", "Access reviews", 1], ["c2", "Data retention", 1], ["c3", "Change control", 1]], "by the first control (g4 lists none, g5 has no list)");
    assert.equal(first.rows, 5);
    const each = await get(A, "by_control_each");
    assert.deepEqual(groups(each), [["c1", "Access reviews", 2], ["c2", "Data retention", 2], [null, "No value", 2], ["c3", "Change control", 1]], "by each control: g1 in c1 and c2, g3 in c3 and c1 (its second c1 once)");
    assert.equal(each.rows, 5, "five rows read, though the groups add up to seven");
    const avg = await get(A, "cvss_by_control_each");
    assert.deepEqual(groups(avg), [["c1", "Access reviews", 7], ["c2", "Data retention", 6], ["c3", "Change control", 6], [null, "No value", null]], "average CVSS per control: c1 (8+6)/2, c2 (8+4)/2, c3 6");
    assert.equal(avg.rows, 3, "the rows with a CVSS");
    assert.deepEqual(groups(await get(A, "by_tag_each")), [["x", "x", 1], ["y", "y", 2], ["z", "z", 1], [null, "No value", 2]], "an enum with multiple, each option in order");
    assert.deepEqual(groups(await get(A, "high_by_control_first")), [["c1", "Access reviews", 1], ["c3", "Change control", 1], [null, "No value", 1]], "where, then the first item of a list field: g1 (c1), g3 (c3), g5 (none)");
    const names = ["by_control_first", "by_control_each", "cvss_by_control_each", "by_tag_each", "high_by_control_first", "due_weekly_by_tag"];
    for (const n of names) assert.deepEqual(await get(A, n, { forceCode: true }), await get(A, n), `${n}: the code path and SQL agree`);
    const weekly = await get(A, "due_weekly_by_tag");
    assert.deepEqual(weekly.series!.map((s) => [s.key, s.values.reduce((a: number, b) => a + (b ?? 0), 0)]), [["x", 1], ["y", 2], ["z", 0], [null, 1]],
      "a series by each tag over the fix-by week (g4 has no date; g3's is past the window)");
    // The sealed area: the same answers, opened in code.
    assert.deepEqual(groups(await get(A, "sealed_by_control_first")), groups(first));
    assert.deepEqual(groups(await get(A, "sealed_by_control_each")), groups(each));
    assert.equal((await get(A, "sealed_by_control_each")).rows, 5);
    assert.deepEqual(groups(await get(A, "sealed_due_status")), [["overdue", "Overdue", 1], ["due_soon", "Due within 7 days", 2], ["later", "Later", 1], ["none", "No date", 1]],
      "a sealed area's due dates: g1 overdue (10-10), g5 (10-22) and g2 (10-25) due soon, g3 later, g4 none");
    assert.equal((await get(A, "sealed_overdue")).value, 1);
    // B counts its own rows (one with A's key g2) and nothing of A's.
    assert.deepEqual(groups(await get(B, "by_control_each")), [["c1", "Access reviews", 1], ["c3", "Change control", 1]]);
    assert.deepEqual(groups(await get(B, "sealed_due_status")), [["overdue", "Overdue", 0], ["due_soon", "Due within 7 days", 1], ["later", "Later", 1]]);
    // A viewer may read findings here, and controls: the titles; the groups are the same.
    assert.deepEqual(groups(await met.computeMetric(A.orgId, "by_control_each", VIEWER, NOW)), groups(each));
    console.log("✓ metrics by a list: first item (5 rows: c1 1, c2 1, c3 1, none 2) and each item (c1 2, c2 2, c3 1, none 2; rows 5), average per control, an enum with multiple, a series; SQL = code; the sealed area agrees; B counts its own");

    // The build: a list without group_by_list, group_by_list on one value or with no field, are refused.
    const refused = (what: string, edit: (j: any) => void, re: RegExp) => assert.throws(() => install(PACK(edit)), re, what);
    refused("a list without group_by_list", (j) => { delete j.metrics[1].group_by_list; }, /group_by: controls holds a list: group by a single-valued field, or declare group_by_list/);
    refused("group_by_list on one value", (j) => { j.metrics[1].group_by = "severity"; }, /group_by_list: severity holds one value, not a list/);
    refused("group_by_list without group_by", (j) => { delete j.metrics[1].group_by; }, /group_by_list says how to group by a field that holds a list/);
    refused("group_by_list with due buckets", (j) => { j.metrics[1].group_by = { due: "due" }; }, /group_by_list says how/);
    refused("a bad word", (j) => { j.metrics[1].group_by_list = "all"; }, /group_by_list/);
    install();
    console.log("✓ the build refuses a list without group_by_list, group_by_list on a single value, without a field, or a word that is not first or each");
  }

  // ---------- 3. due dates on a sealed area ----------
  const http = await startHttp();
  try {
    process.env.RESEND_API_URL = http.mock.url;
    await (await import("../src/keyvault.js")).setCredential("resend", `re_test_${STAMP}_secret`);
    await http.signIn(A, "owner");
    await http.signIn(B, "owner");
    const emails = () => (http.mock.state.emails as any[]).filter((e) => e.tags?.some((t: any) => t.value === "due_soon"));

    // The key vault locked: nothing sealed is opened, the workspaces are counted, nothing is posted.
    const key = process.env.OCTILLION_VAULT_KEY;
    delete process.env.OCTILLION_VAULT_KEY;
    const locked = await sch.dueCheck(new Date("2026-10-21T06:00:00Z"));
    process.env.OCTILLION_VAULT_KEY = key;
    assert.deepEqual([locked.ran, locked.found, locked.posted, locked.sealed_skipped], [true, 0, 0, 2], "locked: A and B skipped, nothing posted");
    assert.equal((await db.query("SELECT 1 FROM scheduler_marks WHERE name = 'due_check'")).length, 0, "the day is not marked done: the next tick checks again");
    // A damaged sealed row of A (its ciphertext does not open) is left out alone; A's other rows are still checked.
    await db.query(`INSERT INTO workspace_records (org_id, pack, area, key, title, data, sealed) VALUES ($1, 'fixture_gaps', 'gp_sealed', 'g9', 'enc:v1:AAAA:BBBB:CCCC', '{"_sealed": "enc:v1:AAAA:BBBB:CCCC"}', true)`, [A.orgId]);

    const d = await sch.dueCheck(new Date("2026-10-21T06:00:00Z"));
    assert.equal(d.ran, true);
    assert.deepEqual([d.found, d.posted, d.sealed_skipped, d.sealed_unreadable], [3, 3, 0, 1], "A's g5 (10-22) and g2 (10-25), B's b1 (10-23); B's g2 (11-30) and A's g1 (past), g3 (later) are not");
    const raw = await db.query<{ org_id: number; record_key: string; title: string; due_on: unknown }>("SELECT org_id, record_key, title, due_on FROM workspace_notices WHERE area = 'gp_sealed' ORDER BY org_id, record_key");
    assert.equal(raw.length, 3);
    assert.ok(raw.every((r) => isSealed(r.title)), "each notice's title is sealed at rest");
    assert.ok(!JSON.stringify(raw).includes("Finding") && !JSON.stringify(raw).includes("B's"), "no title in the clear in the notices table");
    const list = async (org: typeof A) => (await sch.listNotices(org.orgId)).map((n) => [n.key, n.title, n.due_on]);
    assert.deepEqual(await list(A), [["g5", "Finding g5", "2026-10-22"], ["g2", "Finding g2", "2026-10-25"]], "A's notices, titles opened for A");
    assert.deepEqual(await list(B), [["b1", "B's b1", "2026-10-23"]], "B's own only");
    const aTitle = raw.find((r) => r.org_id === A.orgId)!.title;
    await assert.rejects(withTenant(B.orgId, () => open(B.orgId, aTitle)), "A's sealed notice title does not open with B's key");
    const sent = emails();
    assert.ok(sent.length >= 2, "both workspaces' owners are emailed");
    for (const e of sent) {
      assert.doesNotMatch(e.text + e.subject, /Finding g|B's b1|B's g2/, "a sealed title never goes in an email");
      const inA = new RegExp(`^owner\\+${A.orgId}-`).test(e.to[0]);
      if (inA) { assert.match(e.text, /\(g5\): due 2026-10-22/); assert.match(e.text, /\(g2\): due 2026-10-25/); assert.doesNotMatch(e.text, /b1/); }
      else { assert.match(e.text, /\(b1\): due 2026-10-23/); assert.doesNotMatch(e.text, /g5|g2/); }
    }
    // Over HTTP, A's owner sees A's notices with their titles; B's owner B's.
    const tok = await http.signIn(A, "owner");
    const listed = await (await http.req("GET", "/api/notices", { authorization: `Bearer ${tok}` })).json();
    assert.deepEqual(listed.notices.map((n: any) => [n.key, n.title]), [["g5", "Finding g5"], ["g2", "Finding g2"]]);
    // A viewer may not read the sealed area: none of its notices (no key, no day, no title), at the door or in the store.
    const vtok = await http.signIn(A, "viewer");
    assert.deepEqual((await (await http.req("GET", "/api/notices", { authorization: `Bearer ${vtok}` })).json()).notices, [], "a viewer sees no notice of an area they may not read");
    assert.deepEqual(await sch.listNotices(A.orgId, { actor: { role: "viewer", userId: "v" } }), []);
    assert.equal((await sch.listNotices(A.orgId, { actor: { role: "member", userId: "m" } })).length, 2);
    const logs = await db.query<{ meta: any; subject: string }>("SELECT meta, subject FROM email_log WHERE kind = 'due_soon'");
    assert.ok(!JSON.stringify(logs).includes("Finding"), "nothing of a title in the email log");
    console.log("✓ due dates on a sealed area: opened per workspace with its own key; 3 notices, titles sealed at rest and opened only for their workspace; emails name keys, never titles; vault locked: nothing opened, 2 workspaces skipped, the day left unmarked; a damaged row left out alone; a viewer who may not read the area sees none of its notices");
  } finally {
    await http.close();
  }
  await db.close();
  console.log("RECORD GAPS TEST PASS");
} finally {
  cleanup();
}
process.exit(0);

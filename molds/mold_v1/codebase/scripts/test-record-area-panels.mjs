/**
 * THE TWO ACCOUNT RECORD AREAS DRAWN FROM THEIR DEFINITION (deployments, implementations stated in the record-area form,
 * `records.areas.<area>`, compiled with `declared: true`), OFFLINE.
 *
 *   1. AN OLD PROFILE IS UNCHANGED. The default profile, the record sections of both live packs' profiles (fixtures) and
 *      the relabelling fixture declare no area, so their screens, routes and tools take today's code; the model reads
 *      byte for byte what it read before: the whole default surface is the recorded one, and under each live pack's
 *      fixture every section of the surface hashes as it did at upstream main fc2ea3e
 *      (fixtures/record-areas/legacy-surface-hashes.json). With LIVE_PACK_PROFILES=<dir>[:<dir>] the same holds for
 *      those profile directories (no area declared).
 *   2. THE WORKED EXAMPLES COMPILE as the preview page reads them (golden/{filing,coverage,programme,own-state}.areas.json).
 *   3. THE SCREEN FROM THE DEFINITION (lib/record-area-ui.ts): words, table columns, board columns and tones, card,
 *      sorts, filters and presets, groups, detail sections, create fields (own fields of every type included).
 *   4. A RECORD READ (agent/lib/record-area-records.ts): the title template, a computed field, the values by key.
 *   5. EVERY WRITE THROUGH THE ONE VALIDATOR (agent/lib/record-area-write.ts): a declared area's create filled and
 *      normalised (fixed values, the initial state, {me}, aliases, lists), refusals in sentences; a legacy write checked
 *      and passed through untouched.
 *   6. THE SERVER QUERY (agent/lib/record-query.ts): whitelisted keys only (an injected key is refused), values coerced
 *      and bound, categories, sorts, pages; the SQL carries no caller text.
 *   7. THE PER-AREA TOOLS, named and described from the definition: absent under the default; under the coverage
 *      example `list_coverage_reports` / `upsert_coverage_report`, their words the definition's.
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-record-area-panels.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyWithProfiles, surfaceSections } from "./lib/profile-copy.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FIX = join(ROOT, "scripts/fixtures/record-areas");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
let passed = 0;
let failed = 0;
const check = async (what, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${what}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${what}\n${e.message}`);
  }
};
const NODE = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
/** The generator over the default profile plus `extra` ([name, path]); never writes files. */
function gen(extra, flag) {
  const dir = mkdtempSync(join(tmpdir(), "record-area-panels-"));
  try {
    cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
    for (const [name, src] of extra) cpSync(src, join(dir, name));
    const r = spawnSync(process.execPath, [...NODE, join(ROOT, "scripts/gen-deployment-profile.mjs"), flag], { cwd: ROOT, encoding: "utf8", env: { ...process.env, PROFILES_DIR: dir, NODE_NO_WARNINGS: "1" }, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const areasOf = (extra) => JSON.parse(gen(extra, "--print-areas"));
const EX = join(FIX, "examples");
const EXAMPLES = {
  filing: [["50-a.json", join(EX, "compliance.json")], ["51-b.json", join(EX, "obligation.json")]],
  coverage: [["50-a.json", join(EX, "research.json")]],
  programme: [["50-a.json", join(EX, "programme.json")]],
  // The lifecycle on an OWN field (under `custom`), read by the board, a group, a filter, a sort and a metric.
  "own-state": [["50-a.json", join(EX, "own-state.json")]],
};
const LEGACY = {
  default: [],
  "research-pack": [["50-x.json", join(FIX, "legacy/research-pack.json")]],
  "compliance-pack": [["50-x.json", join(FIX, "legacy/compliance-pack.json")]],
  relabelled: [["50-x.json", join(ROOT, "scripts/fixtures/agent-vocabulary/50-relabelled.json")]],
  everything: [["50-x.json", join(FIX, "legacy/everything.json")]],
};

const { isDeclared, recordTitle, computedValue, recordValues, valueOf } = await import("../agent/lib/record-area-records.ts");
const { areaView } = await import("../agent/lib/record-areas.ts");

// --- 1. an old profile is unchanged ----------------------------------------------------------------------------------
console.log("1. An old profile: nothing declared, the model's surface byte for byte what it was");
for (const [set, extra] of Object.entries(LEGACY)) {
  await check(`${set}: no area is declared, so the screens, routes and tools take today's code`, () => {
    const a = areasOf(extra);
    for (const id of ["deployments", "implementations"]) {
      assert.equal("declared" in a[id], false, `${id} carries "declared"`);
      assert.equal(isDeclared(id, a), false, id);
    }
  });
}
for (const dir of (process.env.LIVE_PACK_PROFILES ?? "").split(":").filter(Boolean)) {
  await check(`live profiles ${dir}: no area is declared`, () => {
    const a = areasOf(readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => [f, join(dir, f)]));
    for (const id of ["deployments", "implementations"]) assert.equal(isDeclared(id, a), false, id);
  });
}
const SURFACE = ["scripts/lib/model-surface.mjs", "--snapshot", "--no-results"];
await check("the default model surface is the recorded one, byte for byte (no per-area tool, no other change)", () => {
  const r = spawnSync(process.execPath, [...NODE, ...SURFACE], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  assert.ok(r.stdout === readFileSync(join(ROOT, "scripts/fixtures/agent-vocabulary/default-surface.txt"), "utf8"), "the default surface moved");
});
const hashes = read(join(FIX, "legacy-surface-hashes.json"));
for (const set of ["research-pack", "compliance-pack"]) {
  await check(`${set} (legacy form): every section of the model's surface is the one upstream main rendered`, () => {
    const copy = copyWithProfiles(ROOT, LEGACY[set]);
    try {
      const secs = surfaceSections(copy.run(SURFACE).stdout);
      const now = Object.fromEntries([...secs].map(([k, v]) => [k, createHash("sha256").update(v).digest("hex").slice(0, 16)]));
      if (process.env.UPDATE_SURFACE_HASHES === "1") {
        hashes[set] = now;
        writeFileSync(join(FIX, "legacy-surface-hashes.json"), JSON.stringify(hashes));
      }
      const moved = [...new Set([...Object.keys(now), ...Object.keys(hashes[set])])].filter((k) => now[k] !== hashes[set][k]);
      assert.deepEqual(moved, [], `sections that moved: ${moved.join(", ")}`);
    } finally {
      copy.remove();
    }
  });
}

// --- 2. the worked examples ------------------------------------------------------------------------------------------
console.log("2. The worked examples compile as the preview reads them");
const A = {};
for (const [name, extra] of Object.entries(EXAMPLES)) {
  await check(`${name}: the compiled areas are golden/${name}.areas.json`, () => {
    A[name] = areasOf(extra);
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(join(FIX, `golden/${name}.areas.json`), `${JSON.stringify(A[name], null, 1)}\n`);
    assert.deepEqual(A[name], read(join(FIX, `golden/${name}.areas.json`)));
  });
}
await check("declared exactly where a profile file states the area in the record-area form", () => {
  assert.deepEqual([isDeclared("deployments", A.filing), isDeclared("implementations", A.filing)], [true, false]);
  assert.deepEqual([isDeclared("deployments", A.coverage), isDeclared("implementations", A.coverage)], [true, false]);
  assert.deepEqual([isDeclared("deployments", A.programme), isDeclared("implementations", A.programme)], [false, true]);
});

// --- 3. the screen from the definition -------------------------------------------------------------------------------
console.log("3. The screen, from the definition");
const { recordAreaUi, whereOf, listQuery, listRowOf, listValue, listChoice } = await import("../lib/record-area-ui.ts");
await check("Regulatory filing: words, the table's columns, the board (states in order, tones), card, views", () => {
  const ui = recordAreaUi("deployments", A.filing, "Company");
  assert.equal(ui.navLabel, "Regulatory filings");
  assert.equal(ui.createLabel, "Add filing");
  assert.equal(ui.idLabel, "Filing id");
  assert.deepEqual(ui.columns.map((c) => c.label), ["Company", "Type", "Period", "Due date", "Status", "Timeliness", "Penalty exposure", "Preparer"]);
  assert.deepEqual(ui.board.columns.map((c) => [c.key, c.label, c.tone]), [
    ["in-progress", "In preparation", "bg-amber-500"], ["pending-approval", "Awaiting sign-off", "bg-sky-500"], ["deployed", "Filed", "bg-emerald-500"], ["rolled-back", "Revised / refiled", "bg-slate-400"], ["failed", "Missed", "bg-red-500"],
  ]);
  assert.deepEqual(ui.board.card, { title: "title", meta: ["due_date", "deployOwnerEmail"], badge: "timeliness" });
  assert.deepEqual(ui.modes, ["table", "kanban", "timeline"], "calendar is drawn as the timeline");
  assert.deepEqual(ui.timeline, { start: "due_date", end: "due_date" });
  assert.equal(ui.defaultMode, "table");
});
await check("Regulatory filing: sorts, filters (choices of each, date presets, people), groups", () => {
  const ui = recordAreaUi("deployments", A.filing, "Company");
  assert.deepEqual(ui.sorts.map((s) => s.value), ["due_date:asc", "account:asc", "releaseStatus:asc"]);
  assert.equal(ui.defaultSort, "due_date:asc");
  assert.deepEqual(ui.facets.map((f) => [f.key, f.options.length]), [["releaseStatus", 5], ["runtime", 5], ["penalty_exposure", 4]]);
  assert.deepEqual(ui.facets[0].options[2], { value: "deployed", label: "Filed" });
  assert.deepEqual(ui.presets.map((p) => [p.key, p.presets.map((x) => x.value)]), [["due_date", ["overdue", "due_7d", "due_30d"]], ["deployOwnerEmail", ["mine", "unassigned"]]]);
  assert.deepEqual(ui.groupBy, ["account", "runtime"]);
});
await check("Regulatory filing: the detail's sections, and the create form (an own date field among them)", () => {
  const ui = recordAreaUi("deployments", A.filing, "Company");
  assert.deepEqual(ui.sections.map((s) => [s.label, s.fields.map((f) => f.key), s.related]), [
    ["Filing", ["runtime", "deployedVersion", "due_date", "releaseStatus", "timeliness"], null],
    ["Sign-off", ["deployOwnerEmail", "approvedByEmail", "lastDeployAt", "liveUrl"], null],
    ["Basis", ["source_requirement", "penalty_exposure", "notes"], null],
    [null, [], "files"], [null, [], "tasks"], [null, [], "activity"], [null, [], "comments"],
  ]);
  assert.deepEqual(ui.createFields.map((f) => [f.key, f.type, f.column]), [["runtime", "pick_list", true], ["deployedVersion", "text", true], ["due_date", "date", false], ["deployOwnerEmail", "person", true], ["source_requirement", "link", false]]);
});
await check("Coverage report: no create list, so the form asks for every field a new report must carry (on_create too)", () => {
  const ui = recordAreaUi("deployments", A.coverage, "Company");
  assert.equal(ui.createLabel, "New coverage report");
  assert.deepEqual(ui.createFields.map((f) => f.key), ["runtime", "deployedVersion", "healthStatus", "rating"]);
  assert.deepEqual(ui.columns.map((c) => c.key), ["account", "runtime", "deployedVersion", "rating", "target_price", "kpi_completeness", "releaseStatus", "deployOwnerEmail"]);
  assert.deepEqual(ui.modes, ["table", "kanban", "timeline"]);
  assert.equal(ui.defaultSort, "lastDeployAt:desc");
});
await check("Compliance programme (implementations): own fields of every type on the form and the detail; groups; board", () => {
  const ui = recordAreaUi("implementations", A.programme, "Company");
  assert.equal(ui.idField, null, "one per account: no id field");
  assert.deepEqual(ui.createFields.map((f) => [f.key, f.type]), [["implementationStage", "pick_list"], ["regulators", "multi_pick"], ["targetGoLiveDate", "date"], ["budget", "money"]]);
  assert.deepEqual(ui.sections[1].fields.map((f) => [f.key, f.type, Boolean(f.many)]), [["regulators", "multi_pick", false], ["evidence", "file", true], ["budget", "money", false], ["board_approved", "boolean", false]]);
  assert.deepEqual(ui.board.columns.map((c) => c.label), ["Scoping", "Gap assessment", "Remediation", "Operating", "Paused"]);
  assert.deepEqual(ui.modes, ["table", "kanban"]);
  assert.deepEqual(ui.groupBy, ["implementationRiskLevel", "account"]);
  assert.deepEqual(ui.facets.find((f) => f.key === "regulators").options.map((o) => o.value), ["RBI", "SEBI", "NHB", "MCA"]);
});
await check("the toolbar's picks become the list route's query: facets `in`, a preset a range (overdue: still to do), mine", () => {
  const now = new Date("2026-10-14T07:00:00Z");
  const w = whereOf({ facets: { runtime: ["Periodic return"] }, presets: { due_date: ["overdue"], deployOwnerEmail: ["mine"] } }, "Ana@Desk.test", now, "releaseStatus");
  assert.deepEqual(w, { runtime: { in: ["Periodic return"] }, due_date: { lt: "2026-10-14" }, releaseStatus: { category: ["backlog", "open", "active", "blocked"] }, deployOwnerEmail: "ana@desk.test" });
  assert.equal(new URLSearchParams(listQuery(w, "due_date:desc", " rbi ")).get("sort"), "-due_date");
});

// --- 4. reading a record ---------------------------------------------------------------------------------------------
console.log("4. A record as the definition reads it");
await check("the title template, the parts that are empty dropped; a computed field evaluated, never stored", () => {
  const v = areaView("deployments", A.filing);
  const row = { customerId: "acme", deploymentId: "Q2", runtime: "Periodic return", deployedVersion: "Q2 FY27", releaseStatus: "in-progress", lastDeployAt: null, custom: { due_date: "2026-10-01" } };
  assert.equal(recordTitle(v, row, "legacy"), "Periodic return · Q2 FY27");
  assert.equal(recordTitle(v, { ...row, deployedVersion: "" }, "legacy"), "Periodic return");
  const t = v.field("timeliness");
  const now = new Date("2026-10-14T00:00:00Z");
  assert.equal(computedValue(v, t, row, now), "Overdue");
  assert.equal(computedValue(v, t, { ...row, lastDeployAt: "2026-09-30" }, now), "On time");
  assert.equal(computedValue(v, t, { ...row, lastDeployAt: "2026-10-03" }, now), "Filed late");
  assert.equal(computedValue(v, t, { ...row, custom: { due_date: "2026-11-30" } }, now), "Not yet due");
  const values = recordValues(v, row, now);
  assert.equal(values.timeliness, "Overdue");
  assert.equal(values.due_date, "2026-10-01");
  assert.equal("environment" in values, false, "a hidden field is not shown");
  assert.equal(valueOf(v, row, "account"), "acme");
});

await check("a row with no own values (custom absent, null or not an object; a list row with no values) reads empty and never throws", () => {
  const v = areaView("deployments", A["own-state"]);
  assert.equal(v.lifecycle?.field, "stage");
  assert.equal(v.lifecycle?.own, true, "the lifecycle is on an own field");
  for (const custom of [undefined, null, "stage", ["stage"], 7, {}]) {
    const row = { customerId: "acme", deploymentId: "item-1", deployedVersion: "First", ...(custom === undefined ? {} : { custom }) };
    const what = JSON.stringify(custom ?? "absent");
    assert.equal(v.get(row, "stage"), undefined, what);
    assert.equal(v.categoryOfRow(row), null, what);
    assert.equal(v.closed(row), false, what);
    const values = recordValues(v, row);
    assert.equal("stage" in values, false, `${what}: a field the row does not hold is not in its values`);
    assert.equal(values.deployedVersion, "First", what);
    assert.equal(recordTitle(v, row, "legacy"), "First", what);
  }
  // The screen: whatever the answer carried, `values` and `custom` are objects and an unheld field is empty.
  for (const raw of [{ id: "a" }, { id: "a", values: null, custom: null }, { id: "a", values: "x", custom: [] }, { id: "a", values: {}, custom: {} }]) {
    const r = listRowOf(v, raw);
    assert.deepEqual([r.values, r.custom], [{}, {}], JSON.stringify(raw));
    assert.equal(listValue(r, "stage"), undefined);
    assert.equal(listChoice(v, r, "stage"), "", "in no board column");
    assert.equal(v.display("stage", listValue(r, "stage")), "", "grouped under the empty bucket");
  }
  assert.equal(listValue({}, "stage"), undefined, "a row never read through listRowOf does not throw either");
  assert.equal(listChoice(v, { values: undefined }, "stage"), "");
  // A row in another shape that carries its own values under `custom` (the old key, a legacy spelling) still reads them.
  const old = listRowOf(v, { id: "b", custom: { old_stage: "todo", size: 3 } });
  assert.deepEqual(old.values, { stage: "todo", size: 3 });
  assert.equal(listChoice(v, old, "stage"), "queued", "a legacy spelling sits in its option's column");
  // A row the API sent with its values is read as sent.
  assert.deepEqual(listRowOf(v, { id: "c", values: { stage: "working" }, custom: { stage: "working" } }).values, { stage: "working" });
});

// --- 5. every write through the one validator ------------------------------------------------------------------------
console.log("5. Every write through the one validator");
const { prepareRecordWrite, checkOnly } = await import("../agent/lib/record-area-write.ts");
await check("a filing's create: fixed values, the initial state and {me} filled; an alias and a label taken; own values canonical", () => {
  const r = prepareRecordWrite("deployments", "create", { deploymentId: "Q2-ALM", filing_type: "periodic return", period: "Q2 FY27", custom: { due_date: "2026-10-31", evidence: "Filings/q2.pdf, Filings/q2-workings.xlsx" }, actor: "x", customerId: "acme" }, { actor: "Ana@Desk.test" }, A.filing);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.columns, { deploymentId: "Q2-ALM", runtime: "Periodic return", deployedVersion: "Q2 FY27", environment: "prod", region: "ap-south-1", releaseStatus: "in-progress", healthStatus: "unknown", deployOwnerEmail: "Ana@Desk.test" });
  assert.deepEqual(r.custom, { due_date: "2026-10-31", evidence: ["Filings/q2.pdf", "Filings/q2-workings.xlsx"] });
});
await check("a filing's refusals, in sentences: a choice not offered, a computed field, a fixed one, a missing required one", () => {
  const r = prepareRecordWrite("deployments", "create", { deploymentId: "bad id!", runtime: "Tax return", deployedVersion: "Q2", custom: { timeliness: "On time" }, environment: "dev" }, { actor: "a@b.co" }, A.filing);
  assert.equal(r.ok, false);
  const text = r.errors.join(" ");
  assert.match(text, /"Filing type" \(runtime\) must be one of: "Periodic return"/);
  assert.match(text, /"Timeliness" \(timeliness\) is computed from the record's other fields; it is never set\./);
  assert.match(text, /\(environment\) is not used here; it always holds "prod"\./);
  assert.match(text, /"Due date" \(due_date\) is required\./);
  assert.match(text, /"Filing id" \(deploymentId\) is not in the expected form \(\^\[A-Za-z0-9\]/, "the id's pattern, on create");
  const later = prepareRecordWrite("deployments", "update", { deploymentId: "legacy id", deployedVersion: "Q3" }, { actor: "a@b.co", before: { deploymentId: "legacy id", custom: {} } }, A.filing);
  assert.ok(later.ok, "a row stored before the pattern is still changed by its id");
});
await check("a programme's create: route defaults the definition does not override (blockerOwner fixed, risk default), lists and money", () => {
  const r = prepareRecordWrite("implementations", "create", { regulators: ["rbi", "SEBI"], custom: { budget: "1,25,000" } }, { actor: "lead@desk.test" }, A.programme);
  assert.equal(r.ok, false, "1,25,000 is not a number as written");
  const ok = prepareRecordWrite("implementations", "create", { regulators: ["rbi", "SEBI"], custom: { budget: "125000", board_approved: "yes" } }, { actor: "lead@desk.test" }, A.programme);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(ok.columns, { implementationStage: "Kickoff", implementationRiskLevel: "Green", implementationOwnerEmail: "lead@desk.test", implementationProgressPct: 0, blockerOwner: "None" });
  assert.deepEqual(ok.custom, { regulators: ["RBI", "SEBI"], budget: 125000, board_approved: true });
});
await check("an update names only what changes; null clears an own field (a per-key delta), a stored key not declared is kept", () => {
  const before = { customerId: "acme", implementationStage: "Kickoff", custom: { regulators: ["RBI"], retired: "kept" } };
  const r = prepareRecordWrite("implementations", "update", { implementationStage: "Discovery", custom: { regulators: null, budget: 5 } }, { actor: "a@b.co", before }, A.programme);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.columns, { implementationStage: "Discovery" });
  assert.deepEqual(r.customDelta, { set: { budget: 5 }, clear: ["regulators"], append: {} });
  assert.deepEqual(r.customAfter, { retired: "kept", budget: 5 });
});
await check("the lifecycle is the validator's: under \"warn\" a move outside the rules goes through with its warning; under \"strict\" it is a conflict", () => {
  const before = { customerId: "acme", deploymentId: "Q2", releaseStatus: "in-progress", deployOwnerEmail: "ana@desk.test", custom: { rating: "Buy" } };
  const warn = prepareRecordWrite("deployments", "update", { releaseStatus: "deployed" }, { actor: "ben@desk.test", before }, A.coverage);
  assert.ok(warn.ok, JSON.stringify(warn));
  assert.equal(warn.warnings[0]?.code, "lifecycle_rule_broken");
  assert.equal(warn.lifecycle?.to, "deployed");
  const strict = structuredClone(A.coverage);
  strict.deployments.lifecycle.enforce = "strict";
  const refused = prepareRecordWrite("deployments", "update", { releaseStatus: "deployed" }, { actor: "ben@desk.test", before }, strict);
  assert.equal(refused.ok, false);
  assert.equal(refused.conflict?.code, "lifecycle_refused");
  assert.equal(refused.conflict?.to, "deployed");
  const allowed = prepareRecordWrite("deployments", "update", { releaseStatus: "pending-approval", custom: { kpi_completeness: 90 } }, { actor: "ana@desk.test", before }, strict);
  assert.ok(allowed.ok && allowed.warnings.length === 0 && allowed.lifecycle?.allowed === true, JSON.stringify(allowed));
});
await check("a legacy (default) write: a valid one passes untouched; the validator refuses what the definition refuses", () => {
  const D = areasOf([]);
  assert.deepEqual(checkOnly("deployments", "create", { customerId: "acme", deploymentId: "D1", environment: "prod", region: "eu-west-1", deployedVersion: "1.0", releaseStatus: "deployed", healthStatus: "healthy", displayName: "x" }, { actor: "web" }, D), []);
  assert.deepEqual(checkOnly("deployments", "update", { releaseStatus: "in-progress" }, { actor: "web" }, D), []);
  assert.match(checkOnly("deployments", "update", { releaseStatus: "waiting" }, { actor: "web" }, D).join(" "), /\(releaseStatus\) must be one of: "Deployed" \("deployed"\)|\(releaseStatus\) must be one of/);
  assert.deepEqual(checkOnly("deployments", "update", { custom: { colour: "red" } }, { actor: "web" }, D), [], "own values stay custom-fields.ts's on the legacy routes, with its sentences");
  // A legacy kind field (free text with a list of kinds) stays free text on the legacy routes, as it always was.
  const R = areasOf(LEGACY["research-pack"]);
  assert.equal(R.deployments.fields.runtime.type, "pick_list");
  assert.deepEqual(checkOnly("deployments", "update", { runtime: "Something the list does not have" }, { actor: "web" }, R), []);
});

// --- 6. the server query ---------------------------------------------------------------------------------------------
console.log("6. The server query");
const { parseRecordQuery, compileRecordQuery, encodeCursor } = await import("../agent/lib/record-query.ts");
const { deployments, implementation } = await import("../agent/lib/db/schema.ts");
const { PgDialect } = await import("drizzle-orm/pg-core");
const dialect = new PgDialect();
const render = (id, input, areas, table) => {
  const p = parseRecordQuery(id, input, areas);
  assert.ok(p.ok, JSON.stringify(p));
  const q = compileRecordQuery(id, p.query, table, "org-a", areas);
  return { where: dialect.sqlToQuery(q.where), order: q.orderBy.map((o) => dialect.sqlToQuery(o).sql), q };
};
await check("filters on columns and own fields: labels become stored values, own equality is jsonb containment, values bound", () => {
  const { where } = render("deployments", { where: { runtime: "periodic return", penalty_exposure: { in: ["Late fee", "Penalty"] }, due_date: { lt: "2026-11-01" }, account: "acme" } }, A.filing, deployments);
  assert.deepEqual(where.params, ["org-a", "Periodic return", JSON.stringify({ penalty_exposure: "Late fee" }), JSON.stringify({ penalty_exposure: "Penalty" }), "due_date", "2026-11-01", "acme"]);
  assert.match(where.sql, /"deployments"\."runtime" = \$2/);
  assert.match(where.sql, /"deployments"\."custom" @> \$3::jsonb or "deployments"\."custom" @> \$4::jsonb/);
  assert.match(where.sql, /\("deployments"\."custom" ->> \$5::text\) < \$6/);
});
await check("a lifecycle category is its states; a number own field compares as a number; a list field by containment", () => {
  const r = render("implementations", { where: { implementationStage: { category: ["open", "active"] }, budget: { gte: 1000 }, regulators: { contains: "rbi" } } }, A.programme, implementation);
  assert.deepEqual(r.where.params, ["org-a", "Kickoff", "Discovery", "Configuration", "budget", "budget", 1000, JSON.stringify({ regulators: ["RBI"] })]);
  assert.match(r.where.sql, /jsonb_typeof\("implementation"\."custom" -> \$5::text\) = 'number'/);
});
await check("sorting: the definition's keys, nulls last, then the row's key (a total order); pages by an opaque cursor", () => {
  const r = render("deployments", { sort: "-due_date,account", limit: 10, cursor: encodeCursor(20) }, A.filing, deployments);
  assert.equal(r.order.length, 4);
  assert.match(r.order[0], /\("deployments"\."custom" ->> \$1::text\) desc nulls last/);
  assert.deepEqual([r.q.limit, r.q.offset], [10, 20]);
});
await check("only the definition's keys reach SQL: an unknown, hidden or injected key, a bad op, a bad cursor are refused in sentences", () => {
  const bad = (input) => {
    const p = parseRecordQuery("deployments", input, A.filing);
    assert.equal(p.ok, false, JSON.stringify(input));
    return p.errors.join(" ");
  };
  assert.match(bad({ where: { "custom->>'x') or 1=1; drop table deployments; --": "x" } }), /There is no field "custom->>'x'\) or 1=1; drop table deployments; --" to filter on here\. The fields are: `account`/);
  assert.match(bad({ where: { environment: "prod" } }), /There is no field "environment" to filter on here/, "hidden");
  assert.match(bad({ where: { runtime: { like: "%" } } }), /"like" is not a comparison/);
  assert.match(bad({ where: { runtime: "Tax return" } }), /must be one of/);
  assert.match(bad({ sort: "evidence" }), /\(evidence\) cannot be sorted/);
  assert.match(bad({ cursor: "not-ours" }), /That cursor is not one this list gave out/);
  assert.match(bad({ limit: 5000 }), /`limit` is a whole number from 1 to 300/);
});
await check("a computed field is filtered and sorted in the database: its definition compiled to one CASE, {today} the day the query runs", () => {
  const now = new Date("2026-10-14T07:00:00Z");
  const p = parseRecordQuery("deployments", { where: { timeliness: "overdue" }, sort: "-timeliness" }, A.filing);
  assert.ok(p.ok, JSON.stringify(p));
  const q = compileRecordQuery("deployments", p.query, deployments, "org-a", A.filing, now);
  const w = dialect.sqlToQuery(q.where);
  assert.match(w.sql, /\(case when .* then \$\d+::text when .* then \$\d+::text when .* then \$\d+::text else \$\d+::text end\) = \$\d+::text/);
  for (const x of ["Overdue", "On time", "Filed late", "Not yet due", "2026-10-14"]) assert.ok(w.params.includes(x), `${x} bound: ${JSON.stringify(w.params)}`);
  assert.match(dialect.sqlToQuery(q.orderBy[0]).sql, /^\(case when .* end\) desc nulls last$/);
  const n = parseRecordQuery("implementations", { where: { size: "Large", schedule: { in: ["Late", "Scheduled"] } }, sort: "schedule" }, A.programme);
  assert.ok(n.ok, JSON.stringify(n));
});
await check("a computed field the server cannot compile (it reads a list field) is refused, naming why", () => {
  const areas = structuredClone(A.filing);
  areas.deployments.fields.timeliness.computed.when[0].if = { evidence: { set: true } };
  const p = parseRecordQuery("deployments", { where: { timeliness: "Overdue" } }, areas);
  assert.equal(p.ok, false);
  assert.match(p.errors.join(" "), /"Timeliness" \(timeliness\) is computed from the record's other fields in a way the server cannot filter on \("evidence" holds a list\)/);
});
await check("the search: every word over the searchable fields, the caller's text only as a bound pattern", () => {
  const r = render("deployments", { q: "q2 50%_off" }, A.filing, deployments);
  assert.ok(r.where.params.includes("%q2%") && r.where.params.includes("%50\\%\\_off%"), JSON.stringify(r.where.params));
  assert.ok(!r.where.sql.includes("q2") && !r.where.sql.includes("off"), r.where.sql);
});

// --- 7. the per-area tools -------------------------------------------------------------------------------------------
console.log("7. The per-area tools, named and described from the definition");
await check("under the coverage example: list_coverage_reports and upsert_coverage_report, in the definition's words; nothing else moved", () => {
  const copy = copyWithProfiles(ROOT, EXAMPLES.coverage);
  try {
    const secs = surfaceSections(copy.run(SURFACE).stdout);
    const list = secs.get("root :: tool :: list_coverage_reports") ?? "";
    const upsert = secs.get("root :: tool :: upsert_coverage_report") ?? "";
    assert.ok(list && upsert, `tools: ${[...secs.keys()].filter((k) => k.startsWith("root :: tool")).join(", ")}`);
    assert.match(list, /^List coverage reports \(One row per company per report: what was published, for which period, and how complete its data is\), filtered, sorted and paged in the database\./m);
    assert.match(list, /`rating` \("Rating"\)/);
    assert.match(list, /Its `releaseStatus` moves through: "In progress" → "Awaiting review" → "Published" → "Restated" → "Failed"\./);
    assert.match(upsert, /Create OR update one coverage report/);
    assert.match(upsert, /"Rating", one of "Buy" \| "Add" \| "Hold" \| "Reduce" \| "Sell" \| "Not rated"/);
    assert.match(upsert, /"Target price", amount in INR/);
    for (const k of secs.keys()) if (/implementation/.test(k) && /:: tool :: (list|upsert)_/.test(k)) assert.fail(`an implementations tool appeared: ${k}`);
  } finally {
    copy.remove();
  }
});

console.log(`\ntest-record-area-panels: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

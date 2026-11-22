// mold_v0-339: a record's main action that fits it, a repeat that moves the record it repeats, a shared area's lifecycle
// moved by staff ("Deprecated since 3 Oct"), steps a record never passed, percent fields in forms. Offline: an embedded
// database, a fake sign-in, a pack of its own. `npm run test:records-339`.
//   1. The keys: an action's `show_when` (several primaries, each shown on its own records), a header fact's
//      `state_since`, a program record's `on_repeat`, a lifecycle on a shared (platform) area (no roles, no supersedes,
//      its contract's move is staff's). Each parses; each wrong use is refused with its path or in words.
//   2. The console's pure parts: steps a record never entered read Skipped (not Done), a record from before the state
//      times keeps Done; "<state> since" and its day; a share shown and typed as a percent (0.8 <-> 80).
//   3. show_when through the API: offered only while it holds (the first holding primary is the primary, the others in
//      the menu), refused (409) on a record it does not hold on.
//   4. on_repeat: a repeat moves the stored record it repeats (solved -> regressed), as the run's starter, once; never
//      when a person moved it after the run started; never for a starter whose role may not move it, one who left, or a
//      run nobody started; the batch's own repeats never move anything; said on the result.
//   5. A shared area's lifecycle: a hand write keeps the state (one naming another is refused, 409), a new row starts in
//      the state it names or the initial one, a repository's write carries its state; staff move it (POST
//      /api/admin/records/<area>/<key>/move, "library"): along a transition only, never a repository's row, a staff
//      viewer and a workspace refused, the access log names the move; its state times reach both pages' state_at.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ok = (m: string) => console.log(`✓ ${m}`);
const ALL = ["owner", "member", "viewer", "billing"];
const opts = (...v: string[]) => v.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1).replace(/_/g, " ") }));
const tr = (from: string[], to: string, roles?: string[]) => ({ from, to, ...(roles ? { roles } : {}) });

const ITEMS = { name: "items", label: "Items", role: "source", scope: "workspace", list_columns: ["status"],
  fields: [
    { name: "status", label: "Status", type: "enum", required: true, options: opts("open", "formalized", "improving", "solved", "regressed") },
    { name: "statement", label: "Statement", type: "text" }, { name: "target", label: "Target", type: "text" },
    { name: "kind", label: "Kind", type: "enum", options: opts("recipe", "policy") },
    { name: "confidence", label: "Confidence", type: "number", unit: "percent", min: 0, max: 1 },
  ],
  permissions: { read: ALL, create: ["owner", "member"], update: ["owner", "member"], move: ["owner", "member"], delete: ["owner"] },
  lifecycle: { field: "status", initial: "open", transitions: [
    tr(["open"], "formalized"), tr(["open", "formalized"], "improving"), tr(["improving"], "solved"), tr(["solved"], "regressed", ["owner", "member"]), tr(["regressed"], "improving")] },
  detail: { style: "rail", header: { status: "status", facts: [{ field: "confidence", unit: "percent" }, { state_since: true }] },
    tabs: [{ label: "Overview", sections: [{ title: "About", fields: ["statement", "target", "kind", "confidence"] }, { title: "Progress", steps: { field: "status", states: ["open", "formalized", "improving", "solved"] } }] }],
    actions: [
      { kind: "edit", place: "primary", label: "Edit the recipe item", show_when: { field: "kind", equals: "recipe" } },
      { kind: "copy_link", place: "primary", label: "Copy its link", show_when: { field: "kind", in: ["recipe", "policy"] } },
    ] } };
const CATALOG = { name: "catalog", label: "Catalog", role: "source", scope: "platform",
  fields: [{ name: "summary", label: "Summary", type: "text" }, { name: "maturity", label: "Maturity", type: "enum", options: opts("preview", "ga", "deprecated", "retired") }],
  permissions: { read: ALL },
  lifecycle: { field: "maturity", initial: "preview", transitions: [tr(["preview"], "ga"), tr(["ga"], "deprecated"), tr(["deprecated"], "ga"), tr(["deprecated"], "retired")] },
  detail: { style: "rail", header: { status: "maturity", facts: [{ state_since: true }] }, tabs: [{ label: "Overview", sections: [{ title: "About", fields: ["summary"] }] }] } };
const PACK = { id: "fixture_records_339", name: "Fixture records 339", version: "0.1.0", record_areas: [ITEMS, CATALOG] };

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
let code = 0;
try {
  const F = await import("../src/features.js");
  F.setFeaturesForTest({ record_pages: true, record_rules: true, agent_harness: true, nested_runs: true });
  const PA = await import("../src/pack-api.js");
  const PS = await import("../src/program-spec.js");
  // The console's pure modules, loaded as the other record-page tests load them (the root typecheck stays the server's).
  const web = (rel: string) => import(pathToFileURL(path.join(ROOT, "web", "src", rel)).href);
  const DL = await web("features/records/detail-layout.ts");
  const FP = await web("features/tabs/form-prefill.ts");

  // ---------- 1. the keys ----------
  {
    const issues = (x: unknown) => { const r = PA.RecordAreaSchema.safeParse(x); return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`); };
    const refusedAt = (got: string[], at: string, re: RegExp) => assert.ok(got.some((m) => m.startsWith(`${at}:`) && re.test(m)), `refused at ${at} (${re}): ${JSON.stringify(got)}`);
    assert.deepEqual(issues(ITEMS), [], "two primaries each with show_when, a state_since fact");
    assert.deepEqual(issues(CATALOG), [], "a shared area's lifecycle");
    const withActions = (actions: unknown[]) => { const a = clone(ITEMS); a.detail.actions = actions as never; return a; };
    refusedAt(issues(withActions([{ kind: "edit", place: "primary" }, { kind: "copy_link", place: "primary", show_when: { field: "kind", equals: "policy" } }])), "detail.actions.1.place", /or several each shown only while its condition holds \(show_when on every one\)/);
    refusedAt(issues(withActions([{ kind: "edit", place: "primary", show_when: { field: "nope", equals: "x" } }])), "detail.actions.0.show_when.field", /nope is not one of the area's fields/);
    refusedAt(issues(withActions([{ kind: "edit", show_when: { field: "kind", equals: "other" } }])), "detail.actions.0.show_when", /other/);
    const facts = (f: unknown[], lc = true) => { const a = clone(ITEMS) as Record<string, any>; a.detail.header.facts = f; if (!lc) { delete a.lifecycle; delete a.permissions.move; } return a; };
    refusedAt(issues(facts([{ state_since: true }], false)), "detail.header.facts.0.state_since", /this area has no lifecycle/);
    refusedAt(issues(facts([{ state_since: true, field: "status" }])), "detail.header.facts.0.field", /takes no field/);
    refusedAt(issues(facts([{ state_since: true, unit: "%" }])), "detail.header.facts.0.unit", /takes no unit/);
    refusedAt(issues(facts([{ state_since: true }, { state_since: true }])), "detail.header.facts.1.state_since", /a fact twice/);
    // A rail layout lists up to 12 facts as rows (the cards' header still 10, in rows of four).
    const many = (n: number, style?: string) => { const a = facts(Array.from({ length: n }, (_, i) => (i === 0 ? { state_since: true } : { field: "statement", label: `Fact ${i}` })).map((f, i) => (i > 1 ? { label: `F${i}`, computed: { area: "items", op: "count" } } : f))) as Record<string, any>; if (style) a.detail.style = style; else delete a.detail.style; return a; };
    assert.ok(!issues(many(11, "rail")).some((m) => /at most/.test(m)), JSON.stringify(issues(many(11, "rail"))));
    refusedAt(issues(many(11)), "detail.header.facts", /at most 10 facts: the header shows them in rows of four/);
    refusedAt(issues(many(13, "rail")), "detail.header.facts", /at most 12 facts/);
    const shared = (lc: unknown, contract?: unknown) => ({ ...clone(CATALOG), lifecycle: lc, ...(contract ? { contract } : {}) });
    refusedAt(issues(shared({ ...CATALOG.lifecycle, transitions: [tr(["preview"], "ga", ["owner"])] })), "lifecycle.transitions.0.roles", /moved by platform staff only: a transition names no roles/);
    refusedAt(issues(shared({ ...CATALOG.lifecycle, supersedes: { scope_fields: ["summary"], when_enters: "ga", previous_to: "deprecated" } })), "lifecycle.supersedes", /a shared area's records move only when staff move them/);
    const grants = (move: unknown) => ({ provenance: ["staff"], actions: { read: ALL, create: { staff: "library" }, update: { staff: "library" }, move, delete: { staff: "library" }, reveal: { none: "-" }, export: ["owner"], import: { staff: "library" } }, primary_action: { none: "Staff add entries." } });
    assert.deepEqual(issues(shared(CATALOG.lifecycle, grants({ staff: "library" }))), [], "a shared area's contract: move is staff's");
    refusedAt(issues(shared(CATALOG.lifecycle, grants({ none: "Nobody." }))), "contract.actions.move", /moved by platform staff: move is \{staff/);
    const wsContract = { ...clone(ITEMS), contract: { provenance: ["people"], actions: { read: ALL, create: ["owner"], update: ["owner"], move: { staff: "library" }, delete: ["owner"], reveal: { none: "-" }, export: ["owner"], import: { none: "-" } }, primary_action: "create_record" } };
    assert.ok(issues(wsContract).some((m) => /contract\.actions\.move: \{staff\} is for a shared area's/.test(m)), "a workspace area's move is never staff's");
    // on_repeat, as a program's record is checked when it is saved.
    const shapes = [{ name: "items", scope: "workspace", fields: ITEMS.fields.map((f) => f.name), states: [...new Set(ITEMS.lifecycle.transitions.map((t) => t.to))], encrypted: [],
      transitions: ITEMS.lifecycle.transitions.map((t) => ({ from: t.from, to: t.to })) }];
    const problems = (r: unknown) => PS.recordProblems(r, shapes);
    const base = { area: "items", items: "found", dedupe_on: ["statement"], fields: { statement: "statement" } };
    assert.deepEqual(problems({ ...base, on_repeat: { from: ["solved"], move_to: "regressed" } }), []);
    assert.match(problems({ area: "items", items: "found", fields: { statement: "statement" }, on_repeat: { from: ["solved"], move_to: "regressed" } }).join(), /give dedupe_on too/);
    assert.match(problems({ ...base, on_repeat: { from: ["open"], move_to: "regressed" } }).join(), /no transition of items's lifecycle moves open to regressed/);
    assert.match(problems({ ...base, on_repeat: { from: ["solved"], move_to: "solved" } }).join(), /move_to solved is one of from/);
    assert.match(problems({ ...base, on_repeat: { from: [], move_to: "regressed" } }).join(), /1 to 12 states/);
    assert.match(problems({ ...base, on_repeat: { from: ["solved"], move_to: "regressed", also: 1 } }).join(), /record\.on_repeat/);
    ok("keys: show_when (several primaries each on its own records), state_since, a shared area's lifecycle (no roles, no supersedes, move staff's in its contract), on_repeat; each wrong use refused with its path");
  }

  // ---------- 2. the console's pure parts ----------
  {
    const S = ["open", "formalized", "improving", "solved"];
    const t = (s: string[]) => Object.fromEntries(s.map((x, i) => [x, `2026-11-0${i + 1}T10:00:00.000Z`]));
    const words = (r: { steps: { value: string; state: string }[] }) => r.steps.map((x) => `${x.value}:${x.state}`).join(" ");
    assert.equal(words(DL.stepRows(S, "solved", { stateAt: t(["open", "improving", "solved"]) })), "open:done formalized:skipped improving:done solved:now", "a state it never entered is skipped");
    assert.equal(words(DL.stepRows(S, "solved", { stateAt: t(["open", "formalized", "improving", "solved"]) })), "open:done formalized:done improving:done solved:now");
    assert.equal(words(DL.stepRows(S, "solved", { stateAt: {} })), "open:done formalized:done improving:done solved:now", "no state times (a record from before): done, as before");
    assert.equal(words(DL.stepRows(S, "solved", { stateAt: t(["improving", "solved"]) })), "open:done formalized:done improving:done solved:now", "steps before the first one timed: done (from before the times were kept)");
    assert.equal(words(DL.stepRows(S, "solved")), "open:done formalized:done improving:done solved:now");
    // Off the path (regressed): the step it stopped at, a skipped one before it said so.
    assert.equal(words(DL.stepRows(S, "regressed", { stateAt: { ...t(["open", "improving", "solved"]), regressed: "2026-11-09T10:00:00.000Z" } })), "open:done formalized:skipped improving:done solved:failed");
    assert.equal(DL.STEP_WORD.skipped, "Skipped");
    assert.equal(DL.stepMark("skipped", 1), "–");
    const area = { name: "catalog", label: "Catalog", fields: CATALOG.fields, lifecycle: CATALOG.lifecycle } as never;
    assert.deepEqual(DL.stateSince(area, { state_since: true }, { maturity: "deprecated" }, { deprecated: "2026-10-03T09:00:00.000Z" }), { label: "Deprecated since", at: "2026-10-03T09:00:00.000Z" });
    assert.deepEqual(DL.stateSince(area, { state_since: true, label: "Since" }, {}, { preview: "2026-10-01T09:00:00.000Z" }), { label: "Since", at: "2026-10-01T09:00:00.000Z" }, "no state: the initial one");
    assert.equal(DL.stateSince(area, { state_since: true }, { maturity: "ga" }, { deprecated: "2026-10-03T09:00:00.000Z" }), null, "no time for the state it is in: left out");
    assert.equal(DL.sinceWords("2026-10-03T09:00:00.000Z", Date.parse("2026-11-22T00:00:00Z")), "3 Oct");
    assert.equal(DL.sinceWords("2025-10-03T09:00:00.000Z", Date.parse("2026-11-22T00:00:00Z")), "3 Oct 2025");
    const pct = { type: "number", unit: "percent" }, p100 = { type: "number", unit: "percent_100" }, plain = { type: "number" };
    assert.deepEqual([FP.percentInput(pct, 0.8), FP.percentInput(pct, 0.125), FP.percentInput(pct, 0.07), FP.percentInput(pct, ""), FP.percentInput(p100, 80), FP.percentInput(plain, 0.8)], ["80", "12.5", "7", "", 80, 0.8]);
    assert.deepEqual([FP.percentStored(pct, 80), FP.percentStored(pct, 7), FP.percentStored(p100, 80), FP.percentStored(plain, 80)], [0.8, 0.07, 80, 80]);
    assert.deepEqual([FP.percentBound(pct, 1), FP.percentBound(pct, 0), FP.percentBound(pct, null), FP.percentBound(plain, 1)], [100, 0, undefined, 1]);
    assert.deepEqual([FP.showsPercentSign(pct), FP.showsPercentSign(p100), FP.showsPercentSign({ type: "number", unit: "%" }), FP.showsPercentSign(plain), FP.showsPercentSign({ type: "text", unit: "percent" })], [true, true, true, false, false]);
    // The wiring: the steps draw a skipped circle, the facts a state_since row, forms the percent input, staff a Move.
    const { readFileSync } = await import("node:fs");
    const web = (rel: string) => readFileSync(path.join(ROOT, "web", "src", rel), "utf8");
    assert.match(web("features/records/record-kit.tsx"), /skipped: 'border-dashed/);
    assert.match(web("features/records/detail-page.tsx"), /x\.state_since[\s\S]*data-state-since/);
    assert.match(web("features/tabs/tab-action.tsx"), /showsPercentSign\(f\) \?[\s\S]*data-percent-input/);
    assert.match(web("features/tabs/tab-action.tsx"), /values\[f\.name\] = percentStored\(f, n\)/);
    assert.match(web("features/records/staff-records.tsx"), /return String\(percentInput\(f, v\)\)/);
    assert.match(web("features/records/staff-records.tsx"), /adminRecordsApi\('POST', `\/\$\{encodeURIComponent\(area\.name\)\}\/\$\{encodeURIComponent\(row\.key\)\}\/move`/);
    ok("console: a step never entered reads Skipped (a record from before the times, Done); \"Deprecated since 3 Oct\"; a share shown and typed as a percent (0.8 <-> 80), its bounds too");
  }

  // ---------- the world ----------
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  const RA = await import("../src/record-areas.js");
  const PR = await import("../src/program-records.js");
  const { getDb } = await import("../src/db.js");
  const { asPlatform } = await import("../src/tenant-scope.js");
  const db = await getDb();
  setPacksForTest([{ manifest: { id: PACK.id, name: PACK.name, version: PACK.version, entry: null, migrations: null, words: {}, dir: TMP }, declared: compileDeclarations(PACK as never) } as never]);
  const A = (await createOrg(`Records 339 ${STAMP}`)).org;
  const http = await startHttp();
  const owner = await http.signInAs(A, "owner"), member = await http.signInAs(A, "member"), viewer = await http.signInAs(A, "viewer");
  const h = (tok: string) => ({ authorization: `Bearer ${tok}`, "x-pack-request": "1" });
  const req = async (tok: string, method: string, p: string, body?: unknown) => { const r = await http.req(method, p, h(tok), body); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const rec = RA.workspaceRecords(PACK.id, A.orgId);
  const stateOf = async (key: string) => String((await RA.getFor(A.orgId, "items", key))?.data.status);
  const seed = (key: string, data: Record<string, unknown>) => RA.asWriter({ by: "people", id: "seed" }, () => rec.put("items", key, { title: key, data }));

  // ---------- 3. show_when through the API ----------
  {
    await seed("rc-1", { statement: "A recipe item", kind: "recipe" });
    await seed("po-1", { statement: "A policy item", kind: "policy" });
    await seed("no-1", { statement: "Neither" });
    const page = async (key: string) => (await req(owner.token, "GET", `/api/records/_page/items/${key}`)).body as { actions: { id: string; place: string }[]; state_at?: Record<string, string> };
    assert.deepEqual((await page("rc-1")).actions.map((a) => `${a.id}:${a.place}`), ["edit:primary", "copy_link:more"], "both hold: the first is the primary, the other in the menu");
    assert.deepEqual((await page("po-1")).actions.map((a) => `${a.id}:${a.place}`), ["copy_link:primary"], "only the one that fits, as the primary");
    assert.deepEqual((await page("no-1")).actions, [], "neither fits: none");
    const refused = await req(owner.token, "POST", "/api/records/_page/items/po-1/actions/edit", { data: { statement: "x" } });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error, /Edit the recipe item is not offered on this record now/);
    assert.equal((await RA.getFor(A.orgId, "items", "po-1"))?.data.statement, "A policy item", "nothing written");
    assert.ok((await page("rc-1")).state_at?.open, "a page with a steps section or a state_since fact reads the state times");
    ok("show_when: offered only while it holds (the first holding primary is the primary, the rest in the menu), none where none fits; refused (409) on a record it does not hold on");
  }

  // ---------- 4. on_repeat ----------
  {
    const tag = STAMP.replace(/[^A-Za-z0-9]/g, "").slice(-10).padStart(10, "0");
    let n = 0;
    const id = (p: string) => `${p}_${tag}${String(++n).padStart(3, "0")}`;
    const session = async (startedBy: string | null) => {
      const s = id("hss");
      await asPlatform(() => db.query(`INSERT INTO harness_sessions (id, org_id, title, flavour, model, provider, budget_usd, state, root_id, depth, started_by, created_at)
        VALUES ($1, $2, 'Find items', 'claude_code', 'model-large', 'anthropic', 2, 'parked', $1, 0, $3, clock_timestamp())`, [s, A.orgId, startedBy]));
      return s;
    };
    const solve = async (key: string, statement: string) => { await seed(key, { statement, target: "pages" }); for (const to of ["improving", "solved"]) await rec.move("items", key, to); };
    await solve("sv-1", "Pages are slow");
    await solve("sv-2", "Search is down");
    await solve("sv-3", "Logins fail");
    await seed("op-1", { statement: "Still open", target: "pages" });
    const find = { area: "items", items: "found", dedupe_on: ["statement"], on_repeat: { from: ["solved"], move_to: "regressed" }, fields: { statement: "statement", target: "target" } };
    const out = (found: { statement: string }[]) => ({ found: found.map((f) => ({ target: "pages", ...f })) });
    // A member's run finds a solved one again (other case and spaces), an open one again, a new one and its own repeat.
    const m1 = await session(member.userId);
    const w = await PR.writeProgramResult(A.orgId, { id: id("hch"), program_id: "find", root_id: m1, outputs: out([{ statement: "  PAGES are slow " }, { statement: "Still open" }, { statement: "Brand new" }, { statement: "brand NEW" }]) }, find);
    assert.equal(w.keys.length, 1, `only the new one is written: ${JSON.stringify(w)}`);
    assert.deepEqual(w.repeated, [{ key: "sv-1", from: "solved", moved: true }], "the solved one it repeats is moved, the open one is not in from, the batch's own repeat moves nothing");
    assert.deepEqual([await stateOf("sv-1"), await stateOf("op-1")], ["regressed", "open"]);
    const hist = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM workspace_records WHERE org_id = $1 AND area = 'items' AND key = 'sv-1' AND updated_by LIKE 'run:%'", [A.orgId]);
    assert.notEqual(hist[0]?.n, "0", "the run is the move's writer");
    // Seen again: once (it is no longer solved).
    const again = await PR.writeProgramResult(A.orgId, { id: id("hch"), program_id: "find", root_id: m1, outputs: out([{ statement: "Pages are slow" }]) }, find);
    assert.deepEqual([again.repeated, await stateOf("sv-1")], [[], "regressed"], "applied once");
    // A person moved it after the run started: that move stands.
    const m2 = await session(member.userId);
    await new Promise((r) => setTimeout(r, 15));
    await rec.move("items", "sv-1", "improving"); await rec.move("items", "sv-1", "solved");
    const late = await PR.writeProgramResult(A.orgId, { id: id("hch"), program_id: "find", root_id: m2, outputs: out([{ statement: "Pages are slow" }]) }, find);
    assert.deepEqual([late.repeated, await stateOf("sv-1")], [[{ key: "sv-1", from: "solved", moved: false, why: "a person moved it after the run started" }], "solved"]);
    // A starter whose role may not move it (a viewer), one who left the workspace, a run nobody started: nothing moves.
    const v = await session(viewer.userId);
    const byViewer = await PR.writeProgramResult(A.orgId, { id: id("hch"), program_id: "find", root_id: v, outputs: out([{ statement: "Search is down" }]) }, find);
    assert.deepEqual([byViewer.repeated?.[0]?.moved, byViewer.repeated?.[0]?.why, await stateOf("sv-2")], [false, "the person who started the run may not make this move", "solved"]);
    const gone = await session("u-not-a-member");
    const byGone = await PR.writeProgramResult(A.orgId, { id: id("hch"), program_id: "find", root_id: gone, outputs: out([{ statement: "Search is down" }]) }, find);
    assert.match(byGone.repeated?.[0]?.why ?? "", /no longer a member/);
    const none = await PR.writeProgramResult(A.orgId, { id: id("hch"), program_id: "find", outputs: out([{ statement: "Logins fail" }]) }, find);
    assert.deepEqual([none.repeated?.[0]?.why, await stateOf("sv-3")], ["no person or account started this run", "solved"]);
    // An owner's run (or the account's, which acts as an owner) moves it.
    const o = await session(owner.userId);
    const byOwner = await PR.writeProgramResult(A.orgId, { id: id("hch"), program_id: "find", root_id: o, outputs: out([{ statement: "Search is down" }]) }, find);
    assert.deepEqual([byOwner.repeated, await stateOf("sv-2")], [[{ key: "sv-2", from: "solved", moved: true }], "regressed"]);
    // Without on_repeat, as before: the repeat is left out, nothing moves.
    const plain = await PR.writeProgramResult(A.orgId, { id: id("hch"), program_id: "find", root_id: o, outputs: out([{ statement: "Logins fail" }]) }, { ...find, on_repeat: undefined });
    assert.deepEqual([plain.repeated, plain.deduped.length, await stateOf("sv-3")], [undefined, 1, "solved"]);
    ok("on_repeat: a repeat moves the solved record it repeats to regressed as the run's starter, once; a person's later move stands; a viewer's, a departed member's and a nobody's run move nothing (said why); the batch's own repeats and records not in from stay; without it, as before");
  }

  // ---------- 5. a shared area's lifecycle ----------
  {
    const at = async (key: string) => (await asPlatform(() => db.query<{ data: Record<string, any>; source: string | null }>("SELECT data, source FROM platform_records WHERE area = 'catalog' AND key = $1", [key])))[0];
    const put = (key: string, data: Record<string, unknown>, mode: "put" | "create" | "update" = "put", meta: { source: string; fingerprint: string } | null = null) => RA.putPlatform(null, "catalog", key, { title: key, data }, mode, meta);
    await put("cat-a", { summary: "A" });
    assert.equal((await at("cat-a"))!.data.maturity, "preview", "a new row starts in the initial state");
    assert.ok((await at("cat-a"))!.data.$state_at?.preview, "with when it entered it");
    await put("cat-b", { summary: "B", maturity: "deprecated" });
    assert.equal((await at("cat-b"))!.data.maturity, "deprecated", "a new row staff add (or import) as it stands starts in the state it names");
    await put("cat-a", { summary: "A, edited" }, "update");
    assert.equal((await at("cat-a"))!.data.maturity, "preview", "an edit that leaves the state out keeps it");
    await put("cat-a", { summary: "A, again", maturity: "preview" }, "update");
    await assert.rejects(put("cat-a", { summary: "A", maturity: "ga" }, "update"), (e: Error & { status?: number }) => /changes only by a move/.test(e.message) && e.status === 409);
    await assert.rejects(put("cat-a", { summary: "A", $state_at: { ga: "2020-01-01T00:00:00Z" } } as never, "update"), "the state times are never written by hand");
    // A repository's write carries the state its source gives.
    await put("cat-r", { summary: "From the repository", maturity: "ga" }, "put", { source: "catalog-repo", fingerprint: "f1" });
    await put("cat-r", { summary: "From the repository", maturity: "deprecated" }, "put", { source: "catalog-repo", fingerprint: "f2" });
    assert.deepEqual([(await at("cat-r"))!.data.maturity, !!(await at("cat-r"))!.data.$state_at?.deprecated], ["deprecated", true]);

    const staff = await http.adminToken("operator"), staffViewer = await http.adminToken("viewer");
    const call = async (tok: string, method: string, p: string, body?: unknown) => { const r = await http.req(method, p, { authorization: `Bearer ${tok}` }, body); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
    const move = (tok: string, key: string, to: unknown) => call(tok, "POST", `/api/admin/records/catalog/${key}/move`, { to });
    const before = (await at("cat-a"))!.data.$state_at.preview;
    const m = await move(staff, "cat-a", "ga");
    assert.equal(m.status, 200, JSON.stringify(m.body));
    assert.equal(m.body.record.data.maturity, "ga");
    assert.equal(m.body.record.data.$state_at, undefined, "the state times are never in an answer");
    const a1 = (await at("cat-a"))!.data;
    assert.deepEqual([a1.maturity, a1.summary, a1.$state_at.preview, !!a1.$state_at.ga], ["ga", "A, again", before, true], "moved, its fields kept, when it entered ga kept");
    const off = await move(staff, "cat-a", "retired");
    assert.equal(off.status, 409);
    assert.match(off.body.error, /cannot move from "ga" to "retired"\. From "ga" it can move to: "deprecated"/);
    assert.equal((await move(staff, "cat-a", "ga")).status, 409, "to where it is already");
    assert.equal((await move(staff, "cat-r", "ga")).status, 409, "a repository's row is read only");
    assert.equal((await move(staffViewer, "cat-a", "deprecated")).status, 403, "a staff viewer may not");
    assert.equal((await move(staff, "nope", "ga")).status, 404);
    assert.equal((await move(staff, "cat-a", 3)).status, 400);
    const ws = await req(owner.token, "POST", "/api/admin/records/catalog/cat-a/move", { to: "deprecated" });
    assert.ok([401, 403].includes(ws.status), `a workspace's owner may not: ${ws.status}`);
    const wsData = await req(owner.token, "POST", "/api/data/catalog/cat-a/move", { to: "deprecated" });
    assert.ok(wsData.status >= 400, "nor through the workspace's data API");
    assert.equal((await at("cat-a"))!.data.maturity, "ga");
    const logged = await asPlatform(() => db.query<{ path: string }>("SELECT path FROM admin_access_log WHERE method = 'MOVE' AND path LIKE '%/catalog/cat-a %'"));
    assert.deepEqual(logged.map((l) => l.path), ["/api/admin/records/catalog/cat-a preview -> ga"], "the access log names the move");
    // The staff form leaves the state out (a new row starts in the initial one; staff move it) and says the area moves.
    const form = await call(staff, "GET", "/api/admin/records/_console/catalog/form");
    assert.deepEqual([form.body.fields.map((f: { name: string }) => f.name), form.body.moves], [["summary"], true]);
    // Both pages read when it entered its state (the fact "Generally available since …").
    const sp = await call(staff, "GET", "/api/admin/records/_page/catalog/cat-a");
    assert.equal(sp.body.state_at?.ga, a1.$state_at.ga, JSON.stringify(sp.body));
    const wp = await req(member.token, "GET", "/api/records/_page/catalog/cat-a");
    assert.equal(wp.status, 200, JSON.stringify(wp.body));
    assert.equal(wp.body.state_at?.ga, a1.$state_at.ga);
    assert.deepEqual(wp.body.actions, [], "a workspace's page offers no move of a shared record");
    ok("a shared area's lifecycle: a hand write keeps the state (another refused, 409; times never by hand), a new row starts where it says or initial, a repository carries its own; staff move it along a transition only (never a repository's row, a staff viewer, a workspace), the access log names it; both pages read its state times");
  }
  await http.close();
  console.log("records 339: ok");
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  cleanup();
}
process.exit(code);

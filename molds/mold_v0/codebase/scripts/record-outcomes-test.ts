// Truthful improvement, catalog, run and access state (mold_v0-334), offline: an embedded database, an inline fixture pack
// (items with a lifecycle, notes about them, a catalog the items name), sessions, evaluations and versions written as the
// nested runs write them.
//   tsx scripts/record-outcomes-test.ts          (ONLY=<words> runs the items whose name has them)
//   1. program records: update_by "key" updates the record a program was started for ($inputs.<key>), its fields written
//      over the stored ones, moved along the lifecycle (move_to); a key with no record refuses; a move no transition allows
//      is left out and said; dedupe_on leaves out a repeat of a kept record (and a batch's own); the checks when saved
//   2. a start_program action's moves: the pack's checks; on start (move_to); on the evaluation's outcome (accepted,
//      needs_review then a staff review, refused with its reason in the reason field), on a version applied, on a run that
//      ended with no decision (the sweep); a person's own move afterwards stands; an outcome seen twice changes nothing
//   3. a reference whose where holds for new picks only (filter_new_only): a record keeps a value retired since; a new
//      pick of it is refused; without the flag, refused as before
//   4. one run vocabulary: the server's and the console's words are the same; Active runs' status, whose decision, outcome
//      and attention; the Finished view keeps a failed and a refused run
//   5. access: a workspace key with an expiry (refused after it), the unused flag, invitations cancelled, neutral badges
//   6. reminders: a result waiting on a staff review 3 days and a version accepted and not applied 7 days are notices
//      (Open run), once a day
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, STAMP, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const ok = (m: string) => console.log(`✓ ${m}`);
const ONLY = (process.env.ONLY ?? "").toLowerCase();
const want = (name: string) => !ONLY || name.toLowerCase().includes(ONLY);

const opts = (...v: string[]) => v.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1).replace(/_/g, " ") }));
const ITEM_STATES = ["open", "formalized", "improving", "in_review", "solved", "rejected"];
const tr = (from: string[], to: string) => ({ from, to });
const PACK = {
  id: "fixture_outcomes", name: "Fixture outcomes", version: "0.1.0",
  record_areas: [
    { name: "items", label: "Items", role: "source", scope: "workspace", list_columns: ["status"],
      fields: [
        { name: "status", label: "Status", type: "enum", required: true, options: opts(...ITEM_STATES) },
        { name: "statement", label: "Statement", type: "text" },
        { name: "claim", label: "Claim", type: "text" },
        { name: "metric", label: "Metric", type: "text" },
        { name: "target", label: "Target", type: "text" },
        { name: "why", label: "Why", type: "text" },
      ],
      lifecycle: { field: "status", initial: "open", transitions: [
        tr(["open"], "formalized"), tr(["open", "formalized"], "improving"), tr(["improving"], "in_review"), tr(["improving", "in_review"], "solved"),
        tr(["improving", "in_review"], "open"), tr(["open", "formalized"], "rejected"), tr(["solved", "rejected"], "open")] },
      detail: { tabs: [{ label: "Overview", sections: [{ title: "About", fields: ["statement", "claim", "metric", "why"] }] }, { label: "Changes", sections: [{ title: "Changes", history: {} }] }],
        actions: [{ kind: "start_program", place: "primary", label: "Improve it", program: "improve-it", input: { item_key: "$key" },
          move_to: "improving", on_outcome: { accepted: "solved", needs_review: "in_review", refused: "open", failed: "open", applied: "solved" }, reason_field: "why" }] } },
    { name: "notes", label: "Notes", role: "source", scope: "workspace", list_columns: ["status"],
      fields: [{ name: "status", label: "Status", type: "enum", required: true, options: opts("new", "applied", "dismissed") }, { name: "body", label: "Body", type: "text" }],
      lifecycle: { field: "status", initial: "new", transitions: [tr(["new"], "applied"), tr(["new"], "dismissed"), tr(["applied", "dismissed"], "new")] },
      detail: { tabs: [{ label: "Overview", sections: [{ title: "About", fields: ["body"] }] }],
        actions: [{ kind: "start_program", label: "Change the rule", program: "change-rule", on_outcome: { accepted: "applied" } }] } },
    { name: "catalog", label: "Catalog", role: "source", scope: "workspace", list_columns: ["maturity"],
      fields: [{ name: "maturity", label: "Maturity", type: "enum", options: opts("ga", "deprecated", "retired") }] },
    { name: "apps", label: "Apps", role: "source", scope: "workspace", list_columns: ["base"],
      fields: [
        { name: "base", label: "Base", type: "reference", to: "catalog", where: { field: "maturity", in: ["ga", "deprecated"] }, filter_new_only: true },
        { name: "strict_base", label: "Strict base", type: "reference", to: "catalog", where: { field: "maturity", in: ["ga", "deprecated"] } },
      ] },
  ],
};

let code = 0;
try {
  const F = await import("../src/features.js");
  F.setFeaturesForTest({ record_pages: true, record_rules: true, agent_harness: true, nested_runs: true });
  const { setPacksForTest } = await import("../src/packs.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg, createApiKey, resolveKey } = await import("../src/auth.js");
  const RA = await import("../src/record-areas.js");
  const PR = await import("../src/program-records.js");
  const PS = await import("../src/program-spec.js");
  const PA = await import("../src/pack-api.js");
  const RO = await import("../src/record-outcomes.js");
  const W = await import("../src/run-words.js");
  const { getDb } = await import("../src/db.js");
  const { asPlatform } = await import("../src/tenant-scope.js");
  const db = await getDb();
  setPacksForTest([{ manifest: { id: PACK.id, name: PACK.name, version: PACK.version, entry: null, migrations: null, words: {}, dir: TMP }, declared: compileDeclarations(PACK) } as never]);
  const A = (await createOrg(`Outcomes A ${STAMP}`)).org;
  const rec = RA.workspaceRecords(PACK.id, A.orgId);
  const stateOf = async (area: string, key: string) => String((await RA.getFor(A.orgId, area, key))?.data.status);
  const tag = STAMP.replace(/[^A-Za-z0-9]/g, "").slice(-10).padStart(10, "0");
  let n = 0;
  const id = (p: string) => `${p}_${tag}${String(++n).padStart(3, "0")}`;

  // ---------- 1. program records ----------
  if (want("program records")) {
    const shapes = await PR.recordAreaShapes();
    const problems = (r: unknown) => PS.recordProblems(r, shapes);
    assert.deepEqual(problems({ area: "items", key: "$inputs.item_key", update_by: "key", move_to: "formalized", fields: { claim: "claim", metric: "metric" } }), []);
    assert.match(problems({ area: "items", key: "$inputs.item_key", fields: { claim: "claim" } })[0]!, /record\.key/, "$inputs is an update's key only");
    assert.match(problems({ area: "items", update_by: "key", fields: { claim: "claim" } })[0]!, /give record\.key/);
    assert.match(problems({ area: "items", key: "k", move_to: "nowhere", fields: { claim: "claim" } })[0]!, /no transition of items's lifecycle reaches nowhere/);
    assert.match(problems({ area: "catalog", key: "k", move_to: "ga", fields: { maturity: "m" } })[0]!, /catalog has no lifecycle/);
    assert.match(problems({ area: "items", key: "k", dedupe_on: ["nope"], fields: { claim: "claim" } })[0]!, /items has no field nope/);
    assert.match(problems({ area: "items", key: "$inputs.k", update_by: "key", dedupe_on: ["claim"], fields: { claim: "claim" } }).join(), /nothing to dedupe/);

    await RA.asWriter({ by: "people", id: "seed" }, () => rec.put("items", "it-1", { title: "Slow pages", data: { statement: "Pages are slow", target: "pages" } }));
    const upd = { area: "items", key: "$inputs.item_key", update_by: "key" as const, move_to: "formalized", fields: { claim: "claim", metric: "metric" } };
    const w = await PR.writeProgramResult(A.orgId, { id: "hch_formal0001", program_id: "formalize", inputs: { item_key: "it-1" }, outputs: { claim: "Caching halves the load time", metric: "p95_ms" } }, upd);
    assert.deepEqual(w.keys, ["it-1"]);
    const r1 = await RA.getFor(A.orgId, "items", "it-1");
    assert.deepEqual([r1?.data.status, r1?.data.claim, r1?.data.metric, r1?.data.statement, r1?.title], ["formalized", "Caching halves the load time", "p95_ms", "Pages are slow", "Slow pages"], "updated over the stored fields, moved to formalized, title kept");
    // Seen twice: the same fields, and no move (it is there already).
    const again = await PR.writeProgramResult(A.orgId, { id: "hch_formal0001", program_id: "formalize", inputs: { item_key: "it-1" }, outputs: { claim: "Caching halves the load time", metric: "p95_ms" } }, upd);
    assert.deepEqual([again.keys, again.unmoved, await stateOf("items", "it-1")], [["it-1"], [], "formalized"]);
    await assert.rejects(PR.writeProgramResult(A.orgId, { id: "hch_formal0002", program_id: "formalize", inputs: { item_key: "it-none" }, outputs: { claim: "x" } }, upd), /no items record it-none to update/);
    // A person moved it on since: the result's fields are written, its move is not made, and it says so.
    await rec.move("items", "it-1", "rejected");
    const late = await PR.writeProgramResult(A.orgId, { id: "hch_formal0003", program_id: "formalize", inputs: { item_key: "it-1" }, outputs: { claim: "Later claim", metric: "p95_ms" } }, upd);
    assert.deepEqual([late.unmoved, await stateOf("items", "it-1"), (await RA.getFor(A.orgId, "items", "it-1"))?.data.claim], [[{ key: "it-1", from: "rejected" }], "rejected", "Later claim"]);
    await rec.move("items", "it-1", "open");

    // dedupe_on: a repeat of a kept record (another key, other case and spaces) is left out, and a batch's own repeat once.
    const find = { area: "items", items: "found", dedupe_on: ["statement", "target"], fields: { statement: "statement", target: "target" } };
    const d = await PR.writeProgramResult(A.orgId, { id: "hch_find000001", program_id: "find", outputs: { found: [
      { statement: "  pages are   SLOW ", target: "Pages" }, { statement: "Search is down", target: "search" }, { statement: "search is down", target: "SEARCH" }] } }, find);
    assert.deepEqual(d.keys, ["hch_find000001-2"], "only the new one is written");
    assert.deepEqual(d.deduped, [{ key: "hch_find000001-1", kept: "it-1" }, { key: "hch_find000001-3", kept: "hch_find000001-2" }]);
    const d2 = await PR.writeProgramResult(A.orgId, { id: "hch_find000002", program_id: "find", outputs: { found: [{ statement: "Search is down", target: "search" }] } }, find);
    assert.deepEqual([d2.keys, d2.deduped], [[], [{ key: "hch_find000002-1", kept: "hch_find000001-2" }]], "a second run files nothing new");
    // The same key again replaces its own record (a settle seen twice), never counted as a repeat.
    const d3 = await PR.writeProgramResult(A.orgId, { id: "hch_find000001", program_id: "find", outputs: { found: [{ statement: "Pages are slow", target: "pages" }, { statement: "Search is down", target: "search" }] } }, find);
    assert.deepEqual(d3.keys, ["hch_find000001-2"]);
    ok("program records: update_by key ($inputs) writes over the stored fields and moves along the lifecycle; a missing key refuses; a move a person made since stands, said; dedupe_on leaves out repeats; the checks when saved");
  }

  // ---------- 2. a start_program action's moves ----------
  if (want("start_program")) {
    // The pack's checks.
    const area = (actions: unknown[], over: Record<string, unknown> = {}) => ({ ...PACK.record_areas[0], ...over, detail: { ...PACK.record_areas[0]!.detail, actions } });
    const issues = (a: unknown) => PA.detailProblems(a as never).map((x) => x.message).join(" | ");
    assert.equal(issues(area(PACK.record_areas[0]!.detail!.actions)), "", "the fixture's action is right");
    assert.match(issues(area([{ kind: "start_program", program: "improve-it", move_to: "nowhere" }])), /no transition of the lifecycle goes to nowhere/);
    assert.match(issues(area([{ kind: "start_program", program: "improve-it", on_outcome: { accepted: "gone" } }])), /goes to gone/);
    assert.match(issues(area([{ kind: "start_program", program: "improve-it", on_outcome: { accepted: "solved" }, reason_field: "status" }])), /plain, optional text field/);
    assert.match(issues(area([{ kind: "start_program", program: "improve-it", reason_field: "why" }])), /give on_outcome too/);
    assert.match(issues(area([{ kind: "edit", move_to: "solved" }])), /move_to is for a start_program action/);
    assert.match(issues(area([{ kind: "start_program", program: "improve-it", move_to: "improving" }], { lifecycle: undefined })), /this area has none/);
    assert.ok(PA.DetailActionSchema.safeParse({ kind: "start_program", program: "x", on_outcome: { sometime: "solved" } }).success === false, "an outcome is one of RUN_OUTCOMES");

    const itemsArea = RA.findArea("items")!, notesArea = RA.findArea("notes")!;
    const action = RO.actionFor(itemsArea, ["improve-it"])!;
    assert.equal(action.program, "improve-it");
    // Pure: only from where the action put it, along a transition.
    assert.equal(RO.mayMove(itemsArea, action, "improving", "solved"), true);
    assert.equal(RO.mayMove(itemsArea, action, "rejected", "open"), false, "a person's own end state stands");
    assert.equal(RO.mayMove(itemsArea, action, "solved", "solved"), false);

    const session = async (record: { area: string; key: string } | null, state = "parked", reason: string | null = null) => {
      const s = id("hss"), wake = id("run");
      await asPlatform(async () => {
        await db.query(`INSERT INTO harness_sessions (id, org_id, title, flavour, model, provider, budget_usd, state, state_reason, root_id, depth, record_area, record_key, ended_at)
          VALUES ($1, $2, 'Improve it: Slow pages', 'claude_code', 'model-large', 'anthropic', 2, $3, $4, $1, 0, $5, $6, CASE WHEN $3 IN ('stopped', 'failed') THEN now() END)`, [s, A.orgId, state, reason, record?.area ?? null, record?.key ?? null]);
        await db.query(`INSERT INTO runs (id, org_id, pack, kind, status, spec, max_attempts, token_lifetime_seconds, lease_seconds, budget_usd, harness_session_id)
          VALUES ($1, $2, '_agent', 'wake', 'succeeded', '{}', 1, 600, 60, 1, $3)`, [wake, A.orgId, s]);
      });
      return { s, wake };
    };
    const evaluation = async (root: string, program: string, outcome: "accepted" | "refused" | "needs_review", reasons: string[] = ["measured"], decidedDaysAgo = 0) => {
      const e = id("hev");
      await asPlatform(() => db.query(`INSERT INTO harness_evaluations (id, org_id, program_id, program_version, root_id, target_kind, target_id, candidate, acceptance, status, outcome, reasons, decided_at)
        VALUES ($1, $2, $3, 1, $4, 'mold_ref', 'example-mold', '{}', '{}', 'decided', $5, $6, now() - make_interval(days => $7))`, [e, A.orgId, program, root, outcome, JSON.stringify(reasons), decidedDaysAgo]));
      return e;
    };
    const champion = async (evaluationId: string, daysAgo = 0) => {
      const c = id("hcv");
      await asPlatform(() => db.query(`INSERT INTO harness_champions (id, org_id, target_kind, target_id, version, status, evaluation_id, program_id, candidate, created_by, created_at)
        VALUES ($1, $2, 'mold_ref', $3, 1, 'champion', $4, 'improve-it', '{}', 'the guardian', now() - make_interval(days => $5))`, [c, A.orgId, `example-mold-${c}`, evaluationId, daysAgo]));
      return c;
    };

    // On start: open -> improving, as the person who started it.
    await RA.asWriter({ by: "people", id: "seed" }, () => rec.put("items", "it-2", { title: "Flaky checkout", data: { statement: "Checkout fails sometimes" } }));
    const m0 = await RO.moveOnStart(A.orgId, "items", "it-2", action, { userId: "u-starter" });
    assert.deepEqual([m0?.from, m0?.to, await stateOf("items", "it-2")], ["open", "improving", "improving"]);
    assert.equal(await RO.moveOnStart(A.orgId, "items", "it-2", action, { userId: "u-starter" }), null, "already there: nothing moves");

    // needs_review -> in_review; then staff accept -> solved (the review's own words in the reason field).
    const t1 = await session({ area: "items", key: "it-2" });
    const e1 = await evaluation(t1.s, "improve-it", "needs_review", ["no current best to beat"]);
    const m1 = await RO.afterEvaluation(A.orgId, e1);
    assert.deepEqual([m1?.to, await stateOf("items", "it-2")], ["in_review", "in_review"]);
    assert.match(String((await RA.getFor(A.orgId, "items", "it-2"))?.data.why), /waits for a staff review/);
    const N = await import("../src/nested-runs.js");
    await N.reviewEvaluation("staff-one", e1, { decision: "accept", reason: "Looks right" });
    assert.equal(await stateOf("items", "it-2"), "solved", "the staff accept moves it on (src/nested-runs.ts reviewEvaluation)");
    assert.match(String((await RA.getFor(A.orgId, "items", "it-2"))?.data.why), /accepted the result: accepted by staff, Looks right/);
    assert.equal(await RO.afterEvaluation(A.orgId, e1), null, "seen twice: nothing moves");
    const ev = await asPlatform(() => db.query<{ type: string; data: any }>("SELECT type, data FROM run_events WHERE run_id = $1 AND type = 'record_moved' ORDER BY id", [t1.wake]));
    assert.deepEqual(ev.map((x) => [x.data.from, x.data.to, x.data.outcome]), [["improving", "in_review", "needs_review"], ["in_review", "solved", "accepted"]], "each move said on the run's trace");
    const hist = await (await import("../src/record-history.js")).recordHistory(A.orgId, itemsArea, "it-2");
    assert.equal(hist.lines.filter((l) => l.action === "moved").length, 3, "three moves: on start, in review, solved");
    assert.ok(hist.lines.some((l) => l.changes.some((c) => c.field === "why")), "the reason is in the history");
    assert.ok(hist.lines.some((l) => l.action === "moved" && l.by === "people:u-starter"), "the start's move is the person's");

    // refused -> back to open, with its reason; a person's own move afterwards stands against a late outcome.
    await RA.asWriter({ by: "people", id: "seed" }, () => rec.put("items", "it-3", { title: "Wrong totals", data: { statement: "Totals are off" } }));
    await RO.moveOnStart(A.orgId, "items", "it-3", action, { userId: null });
    const t2 = await session({ area: "items", key: "it-3" });
    await RO.afterEvaluation(A.orgId, await evaluation(t2.s, "improve-it", "refused", ["the candidate scored lower than the current best"]));
    const r3 = await RA.getFor(A.orgId, "items", "it-3");
    assert.deepEqual([r3?.data.status, r3?.data.why], ["open", "The evaluation refused the result: the candidate scored lower than the current best"]);
    await rec.move("items", "it-3", "rejected");
    assert.equal(await RO.afterEvaluation(A.orgId, await evaluation(t2.s, "improve-it", "accepted")), null, "rejected by a person: a late accept does not move it");
    assert.equal(await stateOf("items", "it-3"), "rejected");

    // accepted -> solved; a version applied later: already solved, nothing more. A note's rule change accepted -> applied.
    await RA.asWriter({ by: "people", id: "seed" }, () => rec.put("notes", "n-1", { title: "Stop retrying", data: { body: "Retries hide failures" } }));
    const t3 = await session({ area: "notes", key: "n-1" });
    const e3 = await evaluation(t3.s, "change-rule", "accepted");
    assert.equal((await RO.afterEvaluation(A.orgId, e3))?.to, "applied");
    assert.equal(await stateOf("notes", "n-1"), "applied", "a learning-like note is applied when its rule change is accepted");
    assert.equal(RO.actionFor(notesArea, ["change-rule"])?.program, "change-rule");

    // A version applied by staff moves an item still in review to solved (applyChampion, a mold target).
    await RA.asWriter({ by: "people", id: "seed" }, () => rec.put("items", "it-4", { title: "Old tables", data: {} }));
    await RO.moveOnStart(A.orgId, "items", "it-4", action, { userId: null });
    const t4 = await session({ area: "items", key: "it-4" });
    const e4 = await evaluation(t4.s, "improve-it", "needs_review");
    await RO.afterEvaluation(A.orgId, e4);
    assert.equal(await stateOf("items", "it-4"), "in_review");
    const c4 = await champion(e4);
    await N.applyChampion("staff-one", c4, { ref: "merged upstream" });
    assert.equal(await stateOf("items", "it-4"), "solved", "applied: solved");

    // A run that ended with no decision: the sweep moves it back to open (failed), saying why; a newer live run holds it.
    await RA.asWriter({ by: "people", id: "seed" }, () => rec.put("items", "it-5", { title: "Lost run", data: {} }));
    await RO.moveOnStart(A.orgId, "items", "it-5", action, { userId: null });
    await session({ area: "items", key: "it-5" }, "failed", "crashed 3 times in a row: no sandbox");
    await session({ area: "items", key: "it-5" }, "live");
    await RO.sweepRecordOutcomes();
    assert.equal(await stateOf("items", "it-5"), "improving", "a newer run on it is still live: it stays improving");
    await RA.asWriter({ by: "people", id: "seed" }, () => rec.put("items", "it-6", { title: "Crashed run", data: {} }));
    await RO.moveOnStart(A.orgId, "items", "it-6", action, { userId: null });
    await session({ area: "items", key: "it-6" }, "failed", "crashed 3 times in a row: no sandbox");
    assert.ok(await RO.sweepRecordOutcomes() >= 1);
    const r6 = await RA.getFor(A.orgId, "items", "it-6");
    assert.deepEqual([r6?.data.status, r6?.data.why], ["open", "The run ended without a result: crashed 3 times in a row: no sandbox"]);
    assert.equal(await RO.sweepRecordOutcomes(), 0, "a second sweep moves nothing");
    ok("a start_program action's moves: the pack's checks; on start; needs_review then a staff accept; refused with its reason; a person's move stands; a note applied; a version applied; the sweep for a run with no decision, held by a newer live run");
  }

  // ---------- 3. new picks only ----------
  if (want("new picks")) {
    await rec.put("catalog", "base-a", { title: "Base A", data: { maturity: "ga" } });
    await rec.put("catalog", "base-b", { title: "Base B", data: { maturity: "ga" } });
    await rec.put("apps", "app-1", { title: "App 1", data: { base: "base-a", strict_base: "base-b" } });
    await rec.put("catalog", "base-a", { title: "Base A", data: { maturity: "retired" } });
    await rec.put("catalog", "base-b", { title: "Base B", data: { maturity: "retired" } });
    await rec.put("apps", "app-1", { title: "App 1 renamed", data: { base: "base-a" } });
    assert.equal((await RA.getFor(A.orgId, "apps", "app-1"))?.title, "App 1 renamed", "an app on a base retired since still saves");
    await assert.rejects(rec.put("apps", "app-2", { title: "App 2", data: { base: "base-a" } }), /base-a is not one of the Catalog whose maturity is ga or deprecated/, "a new pick of a retired base is refused");
    await assert.rejects(rec.put("apps", "app-1", { title: "App 1", data: { base: "base-a", strict_base: "base-b" } }), /field strict_base/, "without filter_new_only the stored value is refused as before");
    const noWhere = PA.RecordFieldSchema.safeParse({ name: "x_ref", label: "X", type: "reference", to: "catalog", filter_new_only: true });
    assert.ok(!noWhere.success && /give where too/.test(JSON.stringify(noWhere.error.issues)), "filter_new_only needs where");
    const { formField } = await import("../src/tab-actions.js");
    assert.equal((formField(PACK.record_areas[3]!.fields[0]) as { filter_new_only?: boolean }).filter_new_only, true, "the picker is told: new picks only");
    ok("new picks only: a record keeps a value retired since; a new pick of it is refused; without the flag, refused as before; the picker is told");
  }

  // ---------- 4. one run vocabulary ----------
  if (want("vocabulary")) {
    const web = readFileSync(path.join(ROOT, "web", "src", "lib", "run-status.ts"), "utf8");
    const obj = (name: string, src: string) => {
      const m = new RegExp(`${name}[^=]*= \\{([^}]*)\\}`).exec(src);
      return Object.fromEntries([...(m?.[1] ?? "").matchAll(/([a-z_]+): ['"]([^'"]+)['"]/g)].map((x) => [x[1], x[2]]));
    };
    const srv = readFileSync(path.join(ROOT, "src", "run-words.ts"), "utf8");
    for (const k of ["RUN_STATUS_WORDS", "NEEDS_WORDS", "OUTCOME_WORDS", "const FROM"]) assert.deepEqual(obj(k, web), obj(k, srv), `${k}: the console's words are the server's`);
    assert.deepEqual(obj("RUN_STATUS_WORDS", web), W.RUN_STATUS_WORDS);
    for (const [raw, s] of [["cancelled", "stopped"], ["error", "failed"], ["done", "succeeded"], ["awaiting_approval", "needs_you"], ["parked", "paused"], ["starting", "queued"], ["pending", "queued"]] as const)
      assert.equal(W.runStatusOf(raw), s, raw);
    assert.equal(W.outcomeOf({ status: "decided", outcome: "needs_review", review_decision: null }), "waiting_for_staff");
    assert.equal(W.outcomeOf({ status: "decided", outcome: "accepted" }, { status: "champion", applied_at: new Date() }), "applied");
    assert.equal(W.outcomeOf({ status: "decided", outcome: "accepted" }, { status: "rolled_back", applied_at: null }), "rolled_back");
    assert.equal(W.outcomeOf({ status: "decided", outcome: "needs_review", review_decision: "decline" }), "refused");
    assert.equal(W.outcomeOf({ status: "running", outcome: null }), null);
    assert.equal(W.failedWhy("approval_timeout: web"), "timed out");
    // No page keeps its own words for these any more.
    for (const f of ["web/src/features/agent/agent-page.tsx", "web/src/features/agent/dock/run-view.tsx", "web/src/features/records/detail-page.tsx", "web/src/features/agent/programs-page.tsx"]) {
      const s = readFileSync(path.join(ROOT, f), "utf8");
      for (const old of ["Waiting for you", "Needs a decision", "Needs a person", "'Parked'"]) assert.ok(!s.includes(old), `${f} no longer says ${old}`);
    }

    // Active runs: a tree at work, its attention drawn; a tree waiting on staff; the Finished view keeps a failed and a refused run.
    const D = await import("../src/agent-dock.js");
    const mk = async (title: string, state: string, children: { status: string; attention?: boolean; settled?: boolean }[], reason: string | null = null) => {
      const s = id("hss");
      await asPlatform(async () => {
        await db.query(`INSERT INTO harness_sessions (id, org_id, title, flavour, model, provider, budget_usd, state, state_reason, root_id, depth) VALUES ($1, $2, $3, 'claude_code', 'model-large', 'anthropic', 2, $4, $5, $1, 0)`, [s, A.orgId, title, state, reason]);
        for (const [i, c] of children.entries()) await db.query(`INSERT INTO harness_children (id, org_id, root_id, parent_id, kind, program_id, program_version, name, child_no, budget_usd, status, attention, error, settled_at)
          VALUES ($1, $2, $3, $3, 'program', 'improve-it', 1, 'improve-it', $4, 0.5, $5, $6, $7, CASE WHEN $8 THEN now() END)`, [id("hch"), A.orgId, s, i + 1, c.status, !!c.attention, c.status === "error" ? "the tests failed" : null, !!c.settled]);
      });
      return s;
    };
    const working = await mk("Working tree", "parked", [{ status: "running" }, { status: "error", attention: true, settled: true }]);
    const staff = await mk("Waiting on staff", "parked", [{ status: "running" }]);
    await asPlatform(() => db.query(`INSERT INTO harness_evaluations (id, org_id, program_id, program_version, root_id, target_kind, target_id, candidate, acceptance, status, outcome, decided_at)
      VALUES ($1, $2, 'improve-it', 1, $3, 'mold_ref', 'example-mold', '{}', '{}', 'decided', 'needs_review', now())`, [id("hev"), A.orgId, staff]));
    const failed = await mk("Failed tree", "failed", [{ status: "error", settled: true }], "crashed 3 times in a row: no sandbox");
    const refused = await mk("Refused tree", "stopped", [{ status: "done", settled: true }], "done");
    await asPlatform(() => db.query(`INSERT INTO harness_evaluations (id, org_id, program_id, program_version, root_id, target_kind, target_id, candidate, acceptance, status, outcome, decided_at)
      VALUES ($1, $2, 'improve-it', 1, $3, 'mold_ref', 'example-mold', '{}', '{}', 'decided', 'refused', now())`, [id("hev"), A.orgId, refused]));
    const active = await D.activeRuns(A.orgId);
    const a1 = active.find((r) => r.id === working)!, a2 = active.find((r) => r.id === staff)!;
    assert.deepEqual([a1.status, a1.attention, a1.finished], ["running", true, false], "at work, its escalated failure drawn");
    assert.deepEqual([a2.status, a2.needs, a2.outcome], ["needs_you", "staff", "waiting_for_staff"], "waiting on a staff review: says whose");
    assert.ok(!active.some((r) => r.id === failed || r.id === refused), "finished runs are not active");
    const done = await D.activeRuns(A.orgId, { finished: true });
    const f1 = done.find((r) => r.id === failed)!, f2 = done.find((r) => r.id === refused)!;
    assert.deepEqual([f1.status, f1.why, f1.finished], ["failed", "stopped unexpectedly", true], "the Finished view keeps a failed run, with why");
    assert.deepEqual([f2.status, f2.outcome], ["succeeded", "refused"], "and a refused one, its outcome badge");
    const page = readFileSync(path.join(ROOT, "web", "src", "features", "agent", "dock", "active-runs-page.tsx"), "utf8");
    for (const s of ["/runs?view=finished", "AttentionMark", "OutcomeBadge", "'Finished'", "Need attention"]) assert.ok(page.includes(s), `Active runs draws ${s}`);
    ok("one run vocabulary: the server's and the console's words are the same, no page keeps its own; Active runs' status, whose decision, outcome and attention; the Finished view keeps a failed and a refused run");
  }

  // ---------- 5. access ----------
  if (want("access")) {
    const admin = await import("../src/admin.js");
    assert.equal(admin.keyExpiry(undefined), null, "no expiry: never expires, as before");
    assert.throws(() => admin.keyExpiry(0), /whole number of days/);
    assert.throws(() => admin.keyExpiry(1000), /whole number of days/);
    assert.ok(Math.abs(admin.keyExpiry(30)!.getTime() - Date.now() - 30 * 86_400_000) < 5000);
    const soon = await createApiKey(A.orgId, "expiring", null, new Date(Date.now() + 60_000));
    assert.ok(await resolveKey(soon), "a key before its expiry works");
    const gone = await createApiKey(A.orgId, "expired", null, new Date(Date.now() - 1000));
    assert.equal(await resolveKey(gone), null, "a key after its expiry is refused");
    const MK = await import("../src/member-keys.js");
    const day = 86_400_000, now = Date.now();
    assert.equal(MK.isUnused({ state: "active", last_used_at: null, created_at: new Date(now - 91 * day) }, now), true, "never used in 90 days");
    assert.equal(MK.isUnused({ state: "active", last_used_at: new Date(now - 100 * day), created_at: new Date(now - 200 * day) }, now), true, "not used for 90 days");
    assert.equal(MK.isUnused({ state: "active", last_used_at: new Date(now - day), created_at: new Date(now - 200 * day) }, now), false);
    assert.equal(MK.isUnused({ state: "revoked", last_used_at: null, created_at: new Date(now - 200 * day) }, now), false, "only an active key is flagged");
    assert.equal(MK.UNUSED_DAYS, Number(/UNUSED_DAYS = (\d+)/.exec(readFileSync(path.join(ROOT, "web", "src", "lib", "access-words.ts"), "utf8"))![1]), "the console's days are the server's");
    const words = readFileSync(path.join(ROOT, "web", "src", "lib", "access-words.ts"), "utf8");
    assert.match(words, /revoked: 'Cancelled'/, "an invitation withdrawn is cancelled");
    for (const f of ["web/src/features/portal/billing.tsx", "web/src/features/admin/account-peek.tsx", "web/src/features/admin/account-detail.tsx"]) {
      const s = readFileSync(path.join(ROOT, f), "utf8");
      assert.ok(!/Invitation revoked|Revoke the invitation/.test(s), `${f}: an invitation is cancelled, never revoked`);
    }
    const billing = readFileSync(path.join(ROOT, "web", "src", "features", "portal", "billing.tsx"), "utf8");
    assert.ok(!/'Invited' \? 'outline' : 'destructive'|variant='destructive'>\{statusOf/.test(billing), "suspended and expired are never red");
    ok("access: a workspace key may expire (refused after); the unused flag; invitations cancelled everywhere; suspended and expired neutral");
  }

  // ---------- 6. reminders ----------
  if (want("reminders")) {
    const R = await import("../src/run-reminders.js");
    const S = await import("../src/schedules.js");
    const mk = async (title: string) => {
      const s = id("hss");
      await asPlatform(() => db.query(`INSERT INTO harness_sessions (id, org_id, title, flavour, model, provider, budget_usd, state, root_id, depth) VALUES ($1, $2, $3, 'claude_code', 'model-large', 'anthropic', 2, 'parked', $1, 0)`, [s, A.orgId, title]));
      return s;
    };
    const review = await mk("Waiting review"), apply = await mk("Waiting apply"), fresh = await mk("Fresh review");
    const ev = async (root: string, outcome: string, days: number) => {
      const e = id("hev");
      await asPlatform(() => db.query(`INSERT INTO harness_evaluations (id, org_id, program_id, program_version, root_id, target_kind, target_id, candidate, acceptance, status, outcome, decided_at)
        VALUES ($1, $2, 'improve-it', 1, $3, 'mold_ref', 'example-mold', '{}', '{}', 'decided', $4, now() - make_interval(days => $5))`, [e, A.orgId, root, outcome, days]));
      return e;
    };
    await ev(review, "needs_review", 4);
    await ev(fresh, "needs_review", 1);
    const ea = await ev(apply, "accepted", 9);
    await asPlatform(() => db.query(`INSERT INTO harness_champions (id, org_id, target_kind, target_id, version, status, evaluation_id, program_id, candidate, created_by, created_at)
      VALUES ($1, $2, 'mold_ref', 'example-mold-apply', 1, 'champion', $3, 'improve-it', '{}', 'the guardian', now() - interval '8 days')`, [id("hcv"), A.orgId, ea]));
    const rep = await R.runReminders();
    const mine = (await S.listNotices(A.orgId, { actor: { role: "member", userId: "u1" } })).filter((x) => x.kind === "run");
    const by = (root: string) => mine.find((x) => x.key === root);
    assert.ok(rep.notices >= 2);
    assert.deepEqual([by(review)?.area, by(review)?.href, by(review)?.area_label], ["run_review", `/app/agent/runs/${review}`, "Agent runs"], "a review waiting 3 days or more");
    assert.match(by(review)!.what!, /staff review/);
    assert.equal(by(apply)?.area, "run_apply", "a version accepted and not applied 7 days or more");
    assert.equal(by(fresh), undefined, "a review decided a day ago: not yet");
    assert.equal((await R.runReminders()).notices, 0, "once a day");
    const notices = readFileSync(path.join(ROOT, "web", "src", "features", "schedules", "notices-page.tsx"), "utf8");
    assert.ok(notices.includes("'Open run'") && notices.includes("n.href ??"), "the notice opens its run");
    ok("reminders: a review waiting 3 days and a version unapplied 7 days are run notices (Open run), once a day; a fresh one is not");
  }
  F.setFeaturesForTest(null);
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  cleanup();
}
process.exit(code);

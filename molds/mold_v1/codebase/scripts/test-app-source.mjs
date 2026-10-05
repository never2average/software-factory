/**
 * test:app-source — what can generate an app's document, decided once (lib/app-source.ts). Offline.
 *
 * The Apps form offered every workflow row as a source, the create route stored whichever was picked, and the refresh
 * ran scripts only: an app made from a specialist's row was saved and could only fail. This holds the decision and
 * the places that must ask it:
 *
 *   1. the rules, under the default profile and under the relabelling fixture with a pack's specialist: a script, a
 *      specialist's row and a prompt can run; a row with no script that is nobody's specialist, the row of an
 *      excluded specialist, a script that delegates to one, a missing workflow and a prompt pinned to a specialist
 *      the deployment does not have cannot, each with a reason and what to do;
 *   2. what a specialist is asked for: the app's brief, or its name and description; the account in the profile's word;
 *   3. every door asks: the create and edit routes before they write, the agent's create_app and update_app, the
 *      refresh, both list routes;
 *   4. the form says a refusal where the person is looking, the picker cannot pick what cannot run, a failed app
 *      shows its error with what to do and a retry, and a failed refresh is refetched so the error appears.
 *
 * The routes against a database are scripts/test-app-source-db.mjs (CI's isolation job).
 *
 * On the commit before this one it fails at the first import: lib/app-source.ts did not exist.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`);
    process.exitCode = 1;
  }
};
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const vocab = await import("../agent/lib/agent-vocabulary.ts");
const src = await import("../lib/app-source.ts");

/** The relabelling fixture, merged by the real generator, with a pack's specialist beside the base ones it keeps. */
function relabelled(specialists = ["app-author", "browser", "workflow-author", "ledger-reader"]) {
  const dir = mkdtempSync(join(tmpdir(), "app-source-profiles-"));
  cpSync(join(ROOT, "profiles/00-default.json"), join(dir, "00-default.json"));
  cpSync(join(ROOT, "scripts/fixtures/agent-vocabulary/50-relabelled.json"), join(dir, "50-relabelled.json"));
  const r = spawnSync(process.execPath, ["scripts/gen-deployment-profile.mjs", "--print"], { cwd: ROOT, env: { ...process.env, PROFILES_DIR: dir }, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  const profile = JSON.parse(r.stdout);
  return vocab.createVocabulary(profile, specialists);
}
const V = relabelled();
const D = vocab.VOCABULARY;
const EXCLUDED = V.excludedSpecialists[0];

console.log("\n1. The rules");
await check("a row with a script is a source", () => assert.deepEqual(src.workflowAppSource({ name: "kpi", script: 'return await agent("x");', trigger: "manual" }, "kpi", V), { ok: true, kind: "script" }));
await check("a specialist's scriptless row is a source, and names the specialist (a pack's, and a base one)", () => {
  assert.deepEqual(src.workflowAppSource({ name: "ledger-reader", script: null, trigger: "on delegation" }, "ledger-reader", V), { ok: true, kind: "specialist", specialist: "ledger-reader" });
  assert.deepEqual(src.workflowAppSource({ name: "browser", script: "  ", trigger: "on delegation" }, "browser", D), { ok: true, kind: "specialist", specialist: "browser" });
});
await check("a scriptless row that is nobody's specialist is not: the reason names it, the fix says what to do", () => {
  const s = src.workflowAppSource({ name: "weekly-notes", script: null }, "weekly-notes", V);
  assert.equal(s.ok, false);
  assert.match(s.reason, /^"weekly-notes" has no script and is not one of this workspace's specialists, so there is nothing to run\.$/);
  assert.match(s.fix, /^Give it a script under Workflows, or pick a workflow that has one\.$/);
});
await check("the row of a specialist the profile excludes is not, though the same row is under the default profile", () => {
  assert.equal(src.workflowAppSource({ name: EXCLUDED, script: null, trigger: "on delegation" }, EXCLUDED, V).ok, false);
  assert.equal(src.workflowAppSource({ name: EXCLUDED, script: null, trigger: "on delegation" }, EXCLUDED, D).ok, true);
});
await check("a workflow that does not exist is not, by name", () => {
  const s = src.workflowAppSource(undefined, "ghost", V);
  assert.equal(s.ok, false);
  assert.match(s.reason, /There is no workflow named "ghost" in this workspace\./);
});
await check("a prompt runs as the document author, or as the specialist it names", () => {
  assert.deepEqual(src.promptAppSource(null, V), { ok: true, kind: "prompt", specialist: "app-author" });
  assert.deepEqual(src.promptAppSource("ledger-reader", V), { ok: true, kind: "prompt", specialist: "ledger-reader" });
  assert.equal(src.DEFAULT_PROMPT_SPECIALIST, "app-author");
});
await check("a prompt pinned to a specialist the deployment does not have is not; nor one with no document author at all", () => {
  const s = src.promptAppSource(EXCLUDED, V);
  assert.equal(s.ok, false);
  assert.match(s.reason, /is not one of this workspace's specialists/);
  const none = src.promptAppSource(null, relabelled(["ledger-reader"]));
  assert.equal(none.ok, false);
  assert.match(none.fix, /from a workflow or from one of this workspace's specialists/);
});
await check("an app: its kind decides which rule; an app with nothing set says which field is missing", async () => {
  const rows = [{ name: "ledger-reader", script: null }, { name: "kpi", script: "return 1;" }];
  assert.equal(src.appSourceAmong({ sourceKind: "workflow", workflow: "ledger-reader" }, rows, V).kind, "specialist");
  assert.equal(src.appSourceAmong({ sourceKind: "workflow", workflow: " kpi " }, rows, V).kind, "script");
  assert.match(src.appSourceAmong({ sourceKind: "workflow", workflow: null }, rows, V).reason, /No workflow is set/);
  assert.match(src.appSourceAmong({ sourceKind: "prompt", prompt: " " }, rows, V).reason, /No prompt is set/);
  assert.equal(src.appSourceAmong({ sourceKind: "prompt", prompt: "Summarise." }, rows, V).ok, true);
});
await check("appSource asks the workspace for the row by name, once, and only for a workflow app", async () => {
  const calls = [];
  const find = async (name) => (calls.push(name), { name, script: null });
  const a = await src.appSource({ sourceKind: "workflow", workflow: "ledger-reader" }, find, V);
  const b = await src.appSource({ sourceKind: "prompt", prompt: "x" }, find, V);
  assert.deepEqual([a.kind, b.kind, calls], ["specialist", "prompt", ["ledger-reader"]]);
});
await check("sourceProblem is one sentence a person can act on, or null", () => {
  assert.equal(src.sourceProblem({ ok: true, kind: "script" }), null);
  assert.equal(src.sourceProblem(src.workflowAppSource({ name: "weekly-notes", script: null }, "weekly-notes", V)), `"weekly-notes" has no script and is not one of this workspace's specialists, so there is nothing to run. Give it a script under Workflows, or pick a workflow that has one.`);
});

console.log("\n2. What a specialist is asked for");
await check("the app's brief when it has one; never both", () => {
  const t = src.specialistBrief({ name: "Borrowings mix", description: "d", prompt: "Table of borrowings by instrument." }, V);
  assert.match(t, /^Table of borrowings by instrument\.\n\nReply with the finished document itself/);
  assert.doesNotMatch(t, /Produce the document for the app/);
});
await check("its name and description when it has none (an app saved before the form asked)", () => {
  const t = src.specialistBrief({ name: "Balance sheet of the companies", description: " Total assets. ", prompt: null }, V);
  assert.match(t, /^Produce the document for the app "Balance sheet of the companies"\.\nWhat it is for: Total assets\.\n\n/);
});
await check("the account it is about, in the profile's word", () => {
  assert.match(src.specialistBrief({ name: "n", customerId: "acme" }, V), /It is about one company: acme\./);
  assert.match(src.specialistBrief({ name: "n", customerId: "acme" }, D), /It is about one account: acme\./);
});
await check("it is asked for the document itself, not the dashboard spec the document author knows", () => {
  assert.match(src.DOCUMENT_CONTRACT, /finished document itself and nothing else/);
  assert.doesNotMatch(src.DOCUMENT_CONTRACT, /JSON/);
});

console.log("\n3. Every door asks");
await check("POST /api/ops/apps decides before it inserts, and answers 400 with the sentence", () => {
  const s = read("app/api/ops/apps/route.ts");
  assert.ok(s.indexOf("appSource(data") > 0 && s.indexOf("appSource(data") < s.indexOf(".insert(apps)"), "the decision comes before the insert");
  assert.match(s, /if \(!source\.ok\) \{\s*return NextResponse\.json\(\{ error: sourceProblem\(source\), source \}, \{ status: 400 \}\)/);
});
await check("GET /api/ops/apps annotates every app with its source", () => assert.match(read("app/api/ops/apps/route.ts"), /source: appSourceAmong\(a, rows\)/));
await check("PATCH refuses a changed source that cannot run, and clears the old source's error", () => {
  const s = read("app/api/ops/apps/[id]/route.ts");
  assert.match(s, /if \(sourceChanged && !source\.ok\)/);
  assert.match(s, /sourceChanged \? \{ lastError: null \} : \{\}/);
});
await check("the refresh runs the three kinds and fails with the same sentence; the route answers 409 for a source problem", () => {
  const s = read("lib/app-refresh.ts");
  assert.match(s, /workflowAppSource\(wf, name\)/);
  assert.match(s, /source\.kind === "specialist"/);
  assert.match(s, /delegate\(specialistBrief\(app\), source\.specialist/);
  assert.match(s, /promptAppSource\(app\.subagent\)/);
  assert.doesNotMatch(s, /has no script\.`/);
  assert.match(read("app/api/ops/apps/[id]/refresh/route.ts"), /outcome\.cause === "source" \? 409 : 500/);
});
await check("the agent's create_app and update_app refuse the same sources", () => {
  const s = read("agent/lib/app-tools.ts");
  assert.match(s, /await assertSource\(orgId, input\)/);
  assert.match(s, /await assertSource\(updateOrg, after\)/);
});
await check("GET /api/ops/workflows says of each row whether it can generate an app", () => assert.match(read("app/api/ops/workflows/route.ts"), /appSource: workflowAppSource\(w, w\.name\)/));

console.log("\n4. The person is told, where they are looking");
{
  const panel = read("app/_components/ops/apps-panel.tsx");
  const picker = read("app/_components/ops/primitives.tsx");
  await check("the create form shows a refused create in the form itself", () => {
    assert.match(panel, /error=\{createError\}/);
    assert.match(panel, /data-app-create-error/);
    assert.match(panel, /if \(id === null\) setCreateError\(errMessage\(e\)\)/);
  });
  await check("the create button is off while the picked source cannot run, and the reason is beside the picker", () => {
    assert.match(panel, /Boolean\(workflow\) && pickedSource\?\.ok !== false/);
    assert.match(panel, /data-app-source-refused/);
  });
  await check("the app picker has no 'none', marks a specialist, and cannot pick a row that cannot run", () => {
    assert.equal((panel.match(/<WorkflowSelect\s+forApp/g) ?? []).length, 2, "both the create form and the app's settings");
    assert.match(picker, /disabled=\{forApp && w\.appSource\?\.ok === false\}/);
    assert.match(picker, /\{forApp \? null : \(/);
    assert.match(picker, /Cannot generate an app: \{w\.appSource\.reason\}/);
  });
  await check("a specialist app asks what it should produce, in the form and in its settings", () => assert.equal((panel.match(/label="What should it produce\?"/g) ?? []).length, 2));
  await check("an app that cannot refresh says why and what to do before anyone tries; a failed one offers a retry", () => {
    assert.match(panel, /data-app-source-problem/);
    assert.match(panel, /\{app\.source\.fix\}/);
    assert.match(panel, /data-app-refresh-error/);
    assert.match(panel, /Try again/);
    assert.match(panel, /Change what generates it/);
  });
  await check("the list shows the problem on the row at any width", () => assert.match(panel, /data-app-problem/));
  await check("a failed action still refetches, so the error the refresh wrote on the app is shown", () => {
    const run = panel.slice(panel.indexOf("const run = async"), panel.indexOf("const patch ="));
    assert.match(run, /finally \{[\s\S]*await refetch\(\)/);
  });
}

console.log(`\napp source: ${passed} check(s) passed${process.exitCode ? " — AND SOME FAILED" : ""}`);

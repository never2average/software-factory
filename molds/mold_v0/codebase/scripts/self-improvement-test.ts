// The self-improvement loop's generic capabilities (mold_v0-303): one item per capability, offline, each run on its own so a
// failure names itself.
//   npx tsx scripts/self-improvement-test.ts          (ONLY=<words> runs the items whose name has them)
//   M2  the candidate step is given its target read-only in .target/, and its .candidate/ is an overlay on it
//   M3  the evaluator scores the target with the overlay laid over it; with no champion the target's current version is the
//       baseline, so the guardian decides the first run
//   M4  the target's kind from the run's input (recipe, harness_policy, mold); a harness_policy version is applied as an agent
//       profile proposal staff decide; a mold version is proposed, with a patch for a person's pull request
//   M5  a declared placeholder with no value yet is blank
//   M6  a test declared from a recipe, frozen by sha when the program is saved; the built-in scorers (exact, json-schema,
//       governance-sim) and the built-in file candidate
//   M7  a program's results kept as workspace records by the server, provenance the run; an area or field that is not there
//       refused when the program is saved
//   M10 the tree's ceiling: generous by default, settable, never past the hard maximum
//   wording only goes to a person
// The guardian runs here in-process with the evaluator's same-user mode (no root needed); scripts/nested-runs-review-test.ts
// runs it with its three users and empty networks as root.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanup, startHttp, STAMP, TMP } from "./lib/test-world.js";

process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];

let failed = 0, ran = 0;
async function item(name: string, fn: () => Promise<void>) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  ran++;
  try { await fn(); console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}\n    ${String((e as Error).stack ?? (e as Error).message).split("\n").slice(0, 6).join("\n    ").slice(0, 1200)}`); }
}
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const S = await import("../src/program-spec.js");
const A = await import("../src/program-acceptance.js");
const SC = await import("../src/program-scorers.js");
const T = await import("../src/program-target.js");
const RO = await import("../src/program-records.js");

// ---------- pure ----------
await item("M5: a declared placeholder with no value yet is blank; an undeclared one is left as written", async () => {
  assert.equal(S.renderPrompt("Improve {target}. Earlier: {feedback}. {other}", { target: "kit" }, ["feedback"]), "Improve kit. Earlier: . {other}");
  assert.equal(S.renderPrompt("x {a} {b} {c}", { a: "A", b: { k: 1 } }), 'x A {"k":1} {c}', "with nothing declared, as before");
  assert.deepEqual(S.declaredInputs({ type: "object", properties: { a: {}, b: {} } }), ["a", "b"]);
});

const hash = (s: string) => sha(s);
const machine = { max_transitions: 4, states: [{ id: "candidate", entry: true, prompt: "Improve {target}" }, { id: "accept", kind: "acceptance", candidate_from: "candidate" }], transitions: [{ from: "candidate", to: "accept" }] };
const baseAcceptance = { metric: "score", direction: "maximize", surface: ["policy.json"], target: { kind_from_input: "kind", kinds: ["harness_policy", "mold_ref"], from_input: "target" } };
await item("M4/M6/M7/M10: the spec takes a kind from the input, a test from a recipe with built-ins, a record mapping, a bounded ceiling", async () => {
  const ok = S.parseProgram({ prompt: "x", machine, acceptance: { ...baseAcceptance, test: { recipe: { id: "policy-test" }, cases_path: "cases.json", candidate_command: ["builtin:file", "policy.json"], scorer_command: ["builtin:governance-sim"] } } }, hash);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.config!.acceptance!.target, { kind_from_input: "kind", kinds: ["harness_policy", "mold"], from_input: "target" }, "mold_ref is read as mold");
  assert.deepEqual(ok.config!.acceptance!.test!.files, [], "declared from a recipe: not frozen yet");
  assert.equal(S.testFrozen(ok.config!.acceptance!.test), false);
  const bad = (acc: Record<string, unknown>) => S.parseProgram({ prompt: "x", machine, acceptance: { ...baseAcceptance, ...acc } }, hash).problems.join("; ");
  assert.match(bad({ target: { kind: "recipe", kind_from_input: "kind", id: "x" } }), /exactly one of kind/);
  assert.match(bad({ target: { kind: "recipe", kinds: ["recipe"], id: "x" } }), /only with kind_from_input/);
  assert.match(bad({ target: { kind: "branch", id: "x" } }), /target\.kind: recipe, harness_policy, mold/);
  assert.match(bad({ target: { kind_from_input: "kind", kinds: ["nope"], id: "x" } }), /target\.kinds/);
  assert.equal(bad({ target: { kind: "mold", id: "base-mold" } }), "");
  assert.match(bad({ test: { recipe: { id: "kit-test" }, cases_path: "c.json", candidate_command: ["x"], scorer_command: ["builtin:magic"] } }), /a built-in scorer is one of/);
  assert.match(bad({ test: { recipe: { id: "kit-test" }, cases_path: "c.json", candidate_command: ["builtin:file", "../x"], scorer_command: ["builtin:exact"] } }), /the built-in candidate/);
  assert.match(bad({ test: { cases_path: "c.json", candidate_command: ["x"], scorer_command: ["y"] } }), /test\.files/, "with no recipe, files are needed");
  // A record: its shape always; its area and fields when the areas are known.
  const areas = [{ name: "problems", scope: "workspace", fields: ["statement", "severity"] }, { name: "library", scope: "platform", fields: ["title"] }];
  const rec = (record: unknown) => S.parseProgram({ prompt: "x", record }, hash, { areas }).problems.join("; ");
  assert.equal(rec({ area: "problems", items: "problems", key: "id", fields: { statement: "statement", severity: "severity" } }), "");
  assert.match(rec({ area: "nope", fields: { statement: "s" } }), /not a record area of this app/);
  assert.match(rec({ area: "problems", fields: { colour: "c" } }), /record\.fields\.colour: problems has no such field/);
  assert.match(rec({ area: "library", fields: { title: "t" } }), /not a workspace area/);
  assert.match(rec({ area: "problems", fields: {} }), /record\.fields/);
  assert.equal(S.parseProgram({ prompt: "x", record: { area: "nope", fields: { a: "b" } } }, hash).problems.length, 0, "without the areas, only the shape");
  // The ceiling: a machine may ask for up to the hard maximum, never past it.
  assert.equal(S.parseProgram({ prompt: "x", machine: { ...machine, max_children: 64 }, acceptance: { ...baseAcceptance } }, hash).problems.length, 0);
  assert.match(S.parseProgram({ prompt: "x", machine: { ...machine, max_children: 257 }, acceptance: { ...baseAcceptance } }, hash).problems.join(";"), /from 1 to 256/);
});

await item("wording only goes to a person; a change of nothing, or an unfrozen test, is refused", async () => {
  const acc = S.parseProgram({ prompt: "x", machine, acceptance: { ...baseAcceptance, surface: ["**"], test: { recipe: { id: "kit-test" }, cases_path: "c.json", candidate_command: ["x"], scorer_command: ["y"] } } }, hash).config!.acceptance!;
  assert.ok(A.wordingOnly([".claude/skills/build/SKILL.md", "README.md", "notes/a.txt"]));
  assert.ok(!A.wordingOnly(["SKILL.md", "scripts/check.py"]) && !A.wordingOnly([]));
  const w = A.decideAcceptance(acc, { measured: null, offSurfacePaths: [], hasBest: true, seed: 1, changedPaths: [".claude/skills/build/SKILL.md"] });
  assert.equal(w.outcome, "needs_review"); assert.match(w.reasons[0]!, /wording only/);
  assert.equal(A.decideAcceptance(acc, { measured: null, offSurfacePaths: [], hasBest: true, seed: 1, changedPaths: [] }).outcome, "refused");
  const u = A.decideAcceptance(acc, { measured: { cases: [], tampered: null }, offSurfacePaths: [], hasBest: true, seed: 1, changedPaths: ["scripts/x.py"] });
  assert.equal(u.outcome, "refused"); assert.match(u.reasons[0]!, /never frozen/);
});

await item("M6: the built-in scorers", async () => {
  assert.deepEqual(SC.builtinScore("builtin:exact", { id: "a", input: 1, expected: { n: 2 } }, ' {"n": 2} '), { score: 1, exact: 1 });
  assert.deepEqual(SC.builtinScore("builtin:exact", { id: "a", input: 1, expected: "yes" }, "no\n"), { score: 0, exact: 0 });
  assert.deepEqual(SC.builtinScore("builtin:exact", { id: "a", input: 1, expected: "x" }, null), {}, "no output, no measurement");
  const schema = { type: "object", required: ["n"], properties: { n: { type: "integer" } } };
  assert.equal(SC.builtinScore("builtin:json-schema", { id: "a", input: null, expected: { schema } }, '{"n": 3}').score, 1);
  assert.equal(SC.builtinScore("builtin:json-schema", { id: "a", input: null, expected: { schema } }, '{"n": "3"}').score, 0);
  // The output a schema, judged by examples.
  assert.equal(SC.builtinScore("builtin:json-schema", { id: "a", input: { n: 1 }, expected: { valid: true } }, JSON.stringify(schema)).score, 1);
  assert.equal(SC.builtinScore("builtin:json-schema", { id: "a", input: { n: "x" }, expected: { valid: false } }, JSON.stringify(schema)).score, 1);
  assert.equal(SC.builtinScore("builtin:json-schema", { id: "a", input: { n: 1 }, expected: { valid: true } }, '{"type": "bogus"}').valid, 0);
  const policy = { web: { enabled: true, web_search_enabled: false, web_fetch_enabled: true, web_fetch_allowed_domains: ["example.com"], max_calls: 10 }, egress_approvals: false };
  const fetchCase = (url: string, expected: string) => ({ id: url, input: { tool: { name: "WebFetch", input: { url } } }, expected });
  assert.deepEqual(SC.builtinScore("builtin:governance-sim", fetchCase("https://example.com/a", "allow"), JSON.stringify(policy)), { score: 1, valid: 1, false_allow: 0 });
  assert.deepEqual(SC.builtinScore("builtin:governance-sim", fetchCase("https://evil.example.net/", "deny"), JSON.stringify({ ...policy, web: { ...policy.web, web_fetch_allowed_domains: ["*"] } })), { score: 0, valid: 1, false_allow: 1 });
  assert.deepEqual(SC.builtinScore("builtin:governance-sim", { id: "s", input: { tool: { name: "WebSearch", input: {} } }, expected: { decision: "deny" } }, JSON.stringify(policy)), { score: 1, valid: 1, false_allow: 0 });
  assert.equal(SC.builtinScore("builtin:governance-sim", fetchCase("https://example.com/a", "allow"), "not json").valid, 0);
});

await item("M2/M4: an overlay on its base, what it changed, a patch, the kind from the input", async () => {
  const f = (p: string, body: string, executable = false) => ({ path: p, body: Buffer.from(body), executable });
  const base = [f("run.js", "old\n"), f("README.md", "about\n"), f("bin/go", "#!/bin/sh\necho\n", true)];
  const merged = T.overlay(base, [f("run.js", "new\n"), f("lib/x.js", "x")]);
  assert.deepEqual(merged.map((x) => x.path), ["README.md", "bin/go", "lib/x.js", "run.js"]);
  assert.ok(merged.find((x) => x.path === "bin/go")!.executable, "a base file keeps its flag");
  assert.deepEqual(T.changedPaths(base, merged), ["lib/x.js", "run.js"]);
  assert.deepEqual(T.changedPaths(base, T.overlay(base, [f("run.js", "old\n")])), [], "a copy of the base changes nothing");
  const p = T.unifiedPatch(base, merged);
  assert.deepEqual(p.files, [{ path: "lib/x.js", change: "added", binary: false }, { path: "run.js", change: "modified", binary: false }]);
  assert.match(p.patch, /diff --git a\/run\.js b\/run\.js\n--- a\/run\.js\n\+\+\+ b\/run\.js\n@@ -1,1 \+1,1 @@\n-old\n\+new\n/);
  assert.match(p.patch, /new file mode 100644\n--- \/dev\/null\n\+\+\+ b\/lib\/x\.js\n@@ -0,0 \+1,1 @@\n\+x\n\\ No newline at end of file\n/);
  const acc = S.parseProgram({ prompt: "x", machine, acceptance: baseAcceptance }, hash).config!.acceptance!;
  assert.deepEqual(T.targetKindFor(acc, { kind: "mold" }), { kind: "mold" });
  assert.deepEqual(T.targetKindFor(acc, { kind: "mold_ref" }), { kind: "mold" });
  assert.match((T.targetKindFor(acc, { kind: "recipe" }) as { problem: string }).problem, /improves harness_policy or mold, not recipe/);
  assert.match((T.targetKindFor(acc, {}) as { problem: string }).problem, /does not name a kind/);
  assert.equal(T.targetIdFor(acc, { target: "pol" }), "pol");
});

await item("M7: a result mapped to record operations", async () => {
  const rec = { area: "problems", items: "problems", key: "id", title: "statement", fields: { statement: "statement", severity: "$.severity" } };
  assert.deepEqual(RO.recordOps(rec, { problems: [{ id: "p1", statement: "slow builds", severity: 3 }, { id: "p2", statement: "flaky", severity: 1 }] }, "hch_x"), [
    { op: "put", area: "problems", key: "p1", title: "slow builds", data: { statement: "slow builds", severity: 3 } },
    { op: "put", area: "problems", key: "p2", title: "flaky", data: { statement: "flaky", severity: 1 } }]);
  assert.deepEqual(RO.recordOps({ area: "problems", fields: { statement: "summary" } }, { summary: "one" }, "hch_y"), [{ op: "put", area: "problems", key: "hch_y", data: { statement: "one" } }], "no key: the run's handle");
  assert.throws(() => RO.recordOps(rec, { problems: "x" }, "h"), /no list at problems/);
  assert.throws(() => RO.recordOps(rec, { problems: [{ statement: "no id" }] }, "h"), /item 1: no key at id/);
});

await item("M2: the runner makes .target/ read-only (root's, when the run has a user of its own)", async () => {
  const { lockTarget } = await import("../src/agent-harness.js");
  const { statSync } = await import("node:fs");
  const d = mkdtempSync(path.join(TMP, "target-"));
  mkdirSync(path.join(d, "scripts"), { recursive: true });
  writeFileSync(path.join(d, "SKILL.md"), "x"); writeFileSync(path.join(d, "scripts", "go"), "#!/bin/sh\n", { mode: 0o700 });
  const asRoot = process.getuid?.() === 0;
  lockTarget(d, asRoot);
  assert.equal(statSync(path.join(d, "SKILL.md")).mode & 0o777, 0o444);
  assert.equal(statSync(path.join(d, "scripts", "go")).mode & 0o777, 0o555, "an executable stays one");
  if (asRoot) { assert.equal(statSync(path.join(d, "scripts")).mode & 0o777, 0o555); assert.equal(statSync(path.join(d, "SKILL.md")).uid, 0); }
});

// ---------- the world ----------
const F = await import("../src/features.js");
F.setAdminRecordsForTest(["recipes"]);
F.setFeaturesForTest({ agent_harness: true, nested_runs: true, workspace_recipes: true });
const { getDb } = await import("../src/db.js");
const db = await getDb();
await import("../src/server.js");
const { setPacksForTest } = await import("../src/packs.js");
const { definePack } = await import("../src/pack-api.js");
setPacksForTest([{ manifest: { id: "fixture_si", name: "Fixture self-improvement", version: "1", entry: null, migrations: null, words: {}, dir: TMP },
  definition: definePack({ id: "fixture_si", recordAreas: [{ name: "si_problems", label: "Problems", role: "check", scope: "workspace", fields: [{ name: "statement", label: "Statement" }, { name: "severity", label: "Severity", type: "number" }] }] as never }) } as never]);
const harness = await import("../src/run-harness.js");
const H = await import("../src/harness-sessions.js");
const N = await import("../src/nested-runs.js");
const P = await import("../src/programs.js");
const R = await import("../src/recipes.js");
const C = await import("../src/agent-harness-config.js");
const AP = await import("../src/agent-profiles.js");
const Reach = await import("../src/harness-reach.js");
const RA = await import("../src/record-areas.js");
const { packBundle } = await import("../src/workspace-bundle.js");
const { createOrg } = await import("../src/auth.js");
const { saveSettingValues } = await import("../src/platform-keys.js");
type Actor = import("../src/harness-sessions.js").Actor;
type Claim = import("../src/runs.js").Claim;
type OrgT = import("../src/auth.js").Org;

await saveSettingValues("test-staff", { AGENT_CHECKPOINT_SECONDS: 0, AGENT_SESSION_BUDGET_USD: 10, AGENT_BUDGET_CEILING_USD: 20 });
const http = await startHttp();
const org = (await createOrg(`Self-improvement ${STAMP}`)).org;
const signedIn = await http.signInAs(org, "owner");
const person: Actor = { kind: "person", user: signedIn.userId, name: "si@example.org", role: "owner" };
const client = await harness.localRunnerClient("w-si");
const SESSION_KIND = `${C.AGENT_PACK}/${C.AGENT_KIND}`;
const runs = await import("../src/runs.js");
/** The queued wake of one session, claimed by its id: what an earlier item left queued is never taken instead. */
const claim = async (sessionId: string) => {
  const [r] = await db.query<{ id: string }>("SELECT id FROM runs WHERE harness_session_id = $1 AND status = 'queued' ORDER BY created_at DESC LIMIT 1", [sessionId]);
  assert.ok(r, `a queued wake of ${sessionId}`);
  const c = await runs.claimRun("w-si", { runId: r!.id });
  assert.ok(c, "claimed"); return c!;
};
const start = async (c: Claim) => { const w = await H.wakeStart(c.run.id, c.lease_token); const r = await Reach.resolveToolToken(w.workspace!.token); assert.ok("org" in r, "a token that resolves"); const o = (r as { org: OrgT }).org; return { w, ctx: { orgId: org.orgId, sessionId: w.session_id, runId: o.agentSession!.run!, role: o.role ?? null } }; };
const finish = async (c: Claim, reason: import("../src/harness-sessions.js").EndReason = "done") => { await H.wakeEnd(c.run.id, c.lease_token, { reason }); return client.complete(c.run.id, c.lease_token, { outcome: "succeeded", results: [] }); };
const rootWake = async (budget = 8) => { const s = await H.startSession(org.orgId, person, { message: "root", budget_usd: budget }); const c = await claim(s.id); return { s, c, ...(await start(c)) }; };
const bundle = (files: Record<string, string>) => { const d = mkdtempSync(path.join(TMP, "bundle-")); for (const [f, body] of Object.entries(files)) { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), body); } return packBundle(d).bundle; };
const upload = async (rel: string, body: string, executable = false) => { const u = await AP.storeUploadBytes("staff-1", Buffer.from(body)); return { id: u.id, path: rel, bytes: u.bytes, sha256: u.sha256, executable }; };
/** The guardian's run of one machine's evaluation, carried out here. */
const AS_ROOT = process.getuid?.() === 0;
const uidDir = () => { const d = path.join(TMP, `uids-${Math.random().toString(36).slice(2)}`); mkdirSync(d, { recursive: true }); return d; };
const runEval = async (machineHandle: string, isolated = false) => {
  const ev = await evaluationOf(machineHandle);
  assert.ok(ev?.run_id, `an evaluation run was started (${ev?.outcome}: ${ev?.reasons})`);
  const k = await runs.claimRun("w-si", { runId: ev.run_id! });
  assert.ok(k, "the evaluation was claimed");
  // Isolated: the candidate, the baseline and the scorer each a run user of its own, each in an empty network (as root).
  return harness.runWorkspaceHarness(client, k!, isolated ? { runUsers: { first: 62500, last: 62560 }, runUidDir: uidDir(), egress: "off", noNewPrivs: true } : { allowSameUser: true, egress: "off" });
};
const evaluationOf = async (machineHandle: string) => (await db.query<{ id: string; outcome: string; reasons: string[]; cases: { baseline: number | null; candidate: number | null }[] | null; candidate: Record<string, any>; target_kind: string; run_id: string | null }>(
  "SELECT id, outcome, reasons, cases, candidate, target_kind, run_id FROM harness_evaluations WHERE handle_id IN (SELECT id FROM harness_children WHERE step_of = $1) ORDER BY created_at DESC LIMIT 1", [machineHandle]))[0]!;
/** One run of an improvement program: the root, its machine, the candidate step (what it was given), the candidate sent. */
async function improve(program: string, inputs: Record<string, unknown>, candidate: Buffer | null) {
  const root = await rootWake();
  const m = await N.spawnChild(root.ctx, { program, inputs, budget_usd: 3 });
  const [step] = await db.query<{ session_id: string }>("SELECT session_id FROM harness_children WHERE step_of = $1 ORDER BY child_no", [m.handle]);
  const c = await claim(step!.session_id);
  const s = await start(c);
  if (candidate) await client.agent!.candidate!(c.run.id, c.lease_token, candidate);
  await finish(c);
  await N.nestedTick();
  return { root, m, step: s };
}

const NODE_SCORER = `let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const c=JSON.parse(s);const got=Number(String(c.output).trim());process.stdout.write(JSON.stringify({score:c.expected===got?1:0.3+got/1000,safety:1}));});`;
const CASES = JSON.stringify({ cases: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, input: i, expected: i * 2 })) });
const stdinJson = `let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const c=JSON.parse(s);`;
const GOOD = `${stdinJson}process.stdout.write(String(c.input*2));});`;
const WEAK = `${stdinJson}process.stdout.write("5");});`;
const LIB = "module.exports = (x) => x * 2;\n";
const USES_LIB = `${stdinJson}process.stdout.write(String(require("./lib.js")(c.input)));});`;

await item("M2/M3/M5: the candidate step gets the recipe read-only in .target/; an overlay of one file is scored over it; the first run is decided against the recipe's current version", async () => {
  // The recipe as it is: a weak run.js, the library it could use, and words.
  const files = [await upload("run.js", WEAK), await upload("lib.js", LIB), await upload("README.md", "How to run it.\n")];
  await R.createRecipe("staff-1", { id: "calc", name: "Calc", files: files.map((f) => ({ id: f.id, path: f.path, executable: false })) });
  const test = { files: [await upload("cases.json", CASES), await upload("score.js", NODE_SCORER)], cases_path: "cases.json", candidate_command: [process.execPath, "run.js"], scorer_command: [process.execPath, "score.js"], timeout_seconds: 20 };
  const acceptance = { metric: "score", direction: "maximize", min_lift: 0.05, floors: [{ metric: "safety", min: 0.5 }], surface: ["run.js", "*.md", "**/*.md"], target: { kind: "recipe", from_input: "target" }, test };
  const m = { max_transitions: 6, states: [{ id: "candidate", entry: true, prompt: "Improve {target}. Earlier attempts: {feedback}", inputs: { feedback: "accept.reasons" } }, { id: "accept", kind: "acceptance", candidate_from: "candidate" }], transitions: [{ from: "candidate", to: "accept" }] };
  await P.createProgram("staff-1", { id: "improve-recipe", name: "Improve a recipe", config: { inputs: { type: "object", required: ["target"], properties: { target: { type: "string" } } }, outputs: { type: "object" }, budget_usd: 2, spawned_by: ["*"], machine: m, acceptance } });

  const r = await improve("improve-recipe", { target: "calc" }, bundle({ "run.js": USES_LIB }));
  const text = r.step.w.first[0]!.text;
  assert.match(text, /Improve calc\. Earlier attempts: \n/, "M5: the first pass has no feedback, and says no placeholder");
  assert.ok(!text.includes("{feedback}"));
  assert.match(text, /## The target\nYou improve the recipe calc \(recipe calc version 1\)\.\nIts current files are in \.target\/, read-only: [^\n]*\n[^\n]*under \.candidate\//, "it is told its target and the overlay");
  for (const f of ["README.md", "lib.js", "run.js"]) assert.ok(text.includes(f), `the brief names ${f}`);
  const given = r.step.w.uploads.filter((u) => u.path.startsWith(".target/")).map((u) => [u.path, u.sha256]).sort();
  assert.deepEqual(given, files.map((f) => [`.target/${f.path}`, f.sha256]).sort(), "M2: the recipe's current files, as uploads at .target/");
  const ev = await evaluationOf(r.m.handle);
  assert.deepEqual(ev.candidate.changed, ["run.js"], "what it changed against its base");
  assert.equal(ev.candidate.base.label, "recipe calc version 1");
  assert.deepEqual(ev.candidate.full.paths, ["README.md", "lib.js", "run.js"], "the whole candidate is the base with the overlay laid over it");
  assert.ok(await runEval(r.m.handle));
  const d = await evaluationOf(r.m.handle);
  assert.equal(d.outcome, "accepted", `M3: decided by the guardian on the first run: ${d.reasons}`);
  assert.ok(d.cases!.every((c) => c.baseline !== null && c.candidate === 1), "the recipe's current version was measured as the baseline, and the overlay ran with the base's lib.js");
  const champ = (await N.listChampions(org.orgId, { target: "calc" })).find((c) => c.status === "champion")!;
  assert.equal(champ.version, 1); assert.equal(champ.target.kind, "recipe");
  const patch = await N.championPatch(champ.id);
  assert.equal(patch.base, "recipe calc version 1");
  assert.deepEqual(patch.files, [{ path: "run.js", change: "modified", binary: false }]);
  // Applied: a recipe proposal of what differs from the recipe now (run.js), never the whole version.
  const applied = await N.applyChampion("op", champ.id, {});
  assert.match(applied.applied_ref!, /^recipe proposal rpp_/);
  const prop = (await R.readRecipe("calc")).proposals.find((p) => p.status === "pending")!;
  assert.deepEqual(prop.changed, ["run.js"]);
  await finish(r.root.c, "parked");

  // The next run's base is the champion's whole files (not the recipe's): a copy of them changes nothing and is refused.
  const again = await improve("improve-recipe", { target: "calc" }, bundle({ "run.js": USES_LIB }));
  assert.match(again.step.w.first[0]!.text, /version 1, the current best/);
  const e2 = await evaluationOf(again.m.handle);
  assert.equal(e2.outcome, "refused"); assert.match(e2.reasons[0]!, /changes nothing/);
  await finish(again.root.c, "parked");
});

await item("M3, as root: the overlay is scored over its base by the evaluator's three users, each with no network", async () => {
  if (!AS_ROOT) { console.log("  (skipped: not root, so the evaluator cannot switch to its run users)"); return; }
  const files = [await upload("run.js", WEAK), await upload("lib.js", LIB)];
  await R.createRecipe("staff-1", { id: "calc-iso", name: "Calc isolated", files: files.map((f) => ({ id: f.id, path: f.path, executable: false })) });
  const r = await improve("improve-recipe", { target: "calc-iso" }, bundle({ "run.js": USES_LIB }));
  assert.ok(await runEval(r.m.handle, true));
  const d = await evaluationOf(r.m.handle);
  assert.equal(d.outcome, "accepted", `${d.reasons}`);
  assert.ok(d.cases!.every((c) => c.candidate === 1 && c.baseline !== null && c.baseline < 1), "the base's lib.js was there for the overlay, and the recipe's own run.js was the baseline");
  await finish(r.root.c, "parked");
});

await item("wording only: a change of a recipe's words alone goes to a person, with nothing run", async () => {
  const r = await improve("improve-recipe", { target: "calc" }, bundle({ "README.md": "How to run it, better.\n" }));
  const d = await evaluationOf(r.m.handle);
  assert.equal(d.outcome, "needs_review"); assert.match(d.reasons[0]!, /wording only/);
  assert.equal(d.run_id, null, "no evaluation was run");
  await finish(r.root.c, "parked");
});

const POLICY = { web: { enabled: true, web_search_enabled: false, web_fetch_enabled: true, web_fetch_allowed_domains: ["example.com"], max_calls: 10 }, egress_approvals: false };
await item("M4/M6: a governance policy improved: kind from the input, a test frozen from a recipe, the built-in file and governance-sim; applied as a profile proposal staff accept", async () => {
  await AP.createProfile("staff-1", { id: "pol-agent", name: "Policy agent", config: { governance: POLICY } });
  const fetchCase = (i: number, url: string, expected: string) => ({ id: `c${i}`, input: { tool: { name: "WebFetch", input: { url } } }, expected });
  const cases = [...[0, 1, 2, 3].map((i) => fetchCase(i, `https://docs.example.org/p${i}`, "allow")), fetchCase(4, "https://example.com/a", "allow"), fetchCase(5, "https://example.com/b", "allow"), fetchCase(6, "https://evil.example.net/", "deny"), fetchCase(7, "https://other.example.net/", "deny")];
  const cf = await upload("cases.json", JSON.stringify({ cases }));
  await R.createRecipe("staff-1", { id: "policy-test", name: "Policy test", files: [{ id: cf.id, path: "cases.json", executable: false }] });
  const acceptance = { metric: "score", direction: "maximize", min_lift: 0.05, floors: [{ metric: "false_allow", max: 0 }, { metric: "valid", min: 1 }], surface: ["policy.json"],
    target: { kind_from_input: "kind", kinds: ["harness_policy", "mold"], from_input: "target" },
    test: { recipe: { id: "policy-test" }, cases_path: "cases.json", candidate_command: ["builtin:file", "policy.json"], scorer_command: ["builtin:governance-sim"], timeout_seconds: 30 } };
  await P.createProgram("staff-1", { id: "improve-policy", name: "Improve a policy", config: { inputs: { type: "object", required: ["kind", "target"], properties: { kind: { type: "string" }, target: { type: "string" } } }, outputs: { type: "object" }, budget_usd: 2, spawned_by: ["*"], machine, acceptance } });
  const frozen = (await P.readProgram("improve-policy")).config.acceptance!.test!;
  assert.deepEqual(frozen.files.map((f) => [f.path, f.sha256]), [["cases.json", cf.sha256]], "M6: frozen from the recipe, file by file");
  assert.deepEqual(frozen.recipe, { id: "policy-test", version: 1 }); assert.match(frozen.sha256, /^[0-9a-f]{64}$/);
  await assert.rejects(P.createProgram("staff-1", { id: "bad-test", name: "Bad test", config: { inputs: { type: "object" }, machine, acceptance: { ...acceptance, test: { ...acceptance.test, recipe: { id: "no-such-recipe" } } } } }), /no recipe called no-such-recipe/);

  // A kind the program does not take: refused, with nothing run.
  const wrong = await improve("improve-policy", { kind: "recipe", target: "calc" }, bundle({ "policy.json": "{}" }));
  assert.match((await evaluationOf(wrong.m.handle)).reasons[0]!, /improves harness_policy or mold, not recipe/);
  await finish(wrong.root.c, "parked");

  const better = { ...POLICY, web: { ...POLICY.web, web_fetch_allowed_domains: ["docs.example.org", "example.com"] } };
  const r = await improve("improve-policy", { kind: "harness_policy", target: "pol-agent" }, bundle({ "policy.json": JSON.stringify(better) }));
  const given = r.step.w.uploads.find((u) => u.path === ".target/policy.json");
  assert.ok(given, "M2: the profile's policy, as .target/policy.json");
  assert.match(r.step.w.first[0]!.text, /governance policy pol-agent \(agent profile pol-agent version 1\)/);
  assert.ok(await runEval(r.m.handle));
  const d = await evaluationOf(r.m.handle);
  assert.equal(d.target_kind, "harness_policy");
  assert.equal(d.outcome, "accepted", `measured against the profile's policy now: ${d.reasons}`);
  assert.deepEqual(d.cases!.map((c) => c.baseline), [0, 0, 0, 0, 1, 1, 1, 1]);
  await finish(r.root.c, "parked");
  const champ = (await N.listChampions(org.orgId, { target: "pol-agent" })).find((c) => c.status === "champion")!;
  assert.equal(champ.target.kind, "harness_policy");
  // Apply: a proposal, the profile unchanged until staff accept it.
  const proposed = await N.applyChampion("op", champ.id, {});
  assert.match(proposed.applied_ref!, /^agent profile proposal: pol-agent from version 1 \(pending\)$/); assert.equal(proposed.applied_at, null);
  assert.equal((await AP.readProfile("pol-agent")).version, 1);
  await assert.rejects(N.applyChampion("op", champ.id, {}), /proposed already/);
  await assert.rejects(N.decidePolicyProposal("staff-2", champ.id, { decision: "accept" }), /reason/);
  const accepted = await N.decidePolicyProposal("staff-2", champ.id, { decision: "accept", reason: "measured better" });
  assert.match(accepted.applied_ref!, /^agent profile pol-agent version 2 \(accepted by staff-2: measured better\)$/); assert.ok(accepted.applied_at);
  const prof = await AP.readProfile("pol-agent");
  assert.equal(prof.version, 2); assert.deepEqual(prof.config.governance?.web?.web_fetch_allowed_domains, ["docs.example.org", "example.com"]);
  await assert.rejects(N.decidePolicyProposal("staff-2", champ.id, { decision: "accept", reason: "again" }), /no proposal waiting/);
});

await item("M4: a mold is only proposed: no base, a person decides, Apply records it as proposed with a patch to open the pull request from", async () => {
  const r = await improve("improve-policy", { kind: "mold", target: "base-mold" }, bundle({ "policy.json": JSON.stringify(POLICY) }));
  assert.match(r.step.w.first[0]!.text, /it has no version here yet[\s\S]*only ever proposed/);
  assert.ok(!r.step.w.uploads.some((u) => u.path.startsWith(".target/")), "nothing of a mold in .target/");
  assert.ok(await runEval(r.m.handle));
  const d = await evaluationOf(r.m.handle);
  assert.equal(d.target_kind, "mold_ref"); assert.equal(d.outcome, "needs_review", `${d.reasons}`);
  await finish(r.root.c, "parked");
  await N.reviewEvaluation("reviewer", d.id, { decision: "accept", reason: "worth proposing" });
  const champ = (await N.listChampions(org.orgId, { target: "base-mold" })).find((c) => c.status === "champion")!;
  assert.equal(champ.target.kind, "mold");
  const applied = await N.applyChampion("op", champ.id, {});
  assert.match(applied.applied_ref!, /^proposed to the mold base-mold/); assert.ok(applied.applied_at);
  const p = await N.championPatch(champ.id);
  assert.equal(p.base, null);
  assert.match(p.patch, /^diff --git a\/policy\.json b\/policy\.json\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/policy\.json\n/);
});

await item("M7: a program's results are written as workspace records by the server, provenance the run; an area or field that is not there is refused when saved", async () => {
  const outputs = { type: "object", required: ["problems"], properties: { problems: { type: "array", items: { type: "object", required: ["id", "statement"], properties: { id: { type: "string" }, statement: { type: "string" }, severity: { type: "number" } } } } } };
  const record = { area: "si_problems", items: "problems", key: "id", title: "statement", fields: { statement: "statement", severity: "severity" } };
  await assert.rejects(P.createProgram("staff-1", { id: "bad-area", name: "Bad area", config: { prompt: "x", outputs, record: { ...record, area: "si_nothing" } } }), /si_nothing is not a record area/);
  await assert.rejects(P.createProgram("staff-1", { id: "bad-field", name: "Bad field", config: { prompt: "x", outputs, record: { ...record, fields: { colour: "c" } } } }), /si_problems has no such field/);
  await P.createProgram("staff-1", { id: "find-problems", name: "Find problems", config: { prompt: "Find problems", outputs, spawned_by: ["*"], record } });
  const root = await rootWake();
  const h = await N.spawnChild(root.ctx, { program: "find-problems", budget_usd: 1 });
  const c = await claim(h.session_id!); const s = await start(c);
  assert.equal((await N.submitOutputs(s.ctx, { outputs: { problems: [{ id: "p-1", statement: "builds are slow", severity: 3 }, { id: "p-2", statement: "deploys fail", severity: 5 }] } })).ok, true);
  await finish(c);
  const got = (await N.collect(root.ctx, { handles: [h.handle] })).children[0]!;
  assert.equal(got.status, "done");
  const byKey = new Map((await RA.listFor(org.orgId, "si_problems")).records.map((x) => [x.key, x]));
  assert.equal(byKey.get("p-1")?.title, "builds are slow"); assert.deepEqual(byKey.get("p-2")?.data, { statement: "deploys fail", severity: 5 });
  const [prov] = await db.query<{ provenance: string; written_by: string }>("SELECT provenance, written_by FROM workspace_records WHERE org_id = $1 AND area = 'si_problems' AND key = 'p-1'", [org.orgId]);
  assert.equal(prov!.provenance, "run"); assert.equal(prov!.written_by, `run:program:find-problems:${h.handle}`);
  await finish(root.c, "parked");
});

await item("M10: the tree's ceiling is generous by default, settable, never past the hard maximum", async () => {
  assert.deepEqual(N.nestedLimits(), { depth: 2, children: 32, concurrent: 4 });
  N.setNestedRunsForTest({ max_children: 10_000, max_depth: 9, max_concurrent: 99 });
  assert.deepEqual(N.nestedLimits(), { depth: 3, children: 256, concurrent: 16 });
  N.setNestedRunsForTest({ max_children: 3 });
  try {
    const root = await rootWake(8);
    for (let i = 0; i < 3; i++) await N.spawnChild(root.ctx, { prompt: `c${i}`, budget_usd: 0.2 });
    await assert.rejects(N.spawnChild(root.ctx, { prompt: "one too many", budget_usd: 0.2 }), /started its 3 children/);
    await N.cancelChildrenOf(org.orgId, root.s.id, "done with the test");
    await finish(root.c, "parked");
  } finally { N.setNestedRunsForTest(null); }
});

await item("integration (mold_v0-303): a person's start of a stepped program only people start permits its root to spawn exactly it; program roles; a pack's bad record refused at load; the proposal and patch routes", async () => {
  // A stepped program only people start (spawned_by []): no ordinary session may spawn it.
  const stepped = { prompt: "x", spawned_by: [], machine: { states: [{ id: "one", entry: true, prompt: "Do it." }], transitions: [], max_transitions: 4 } };
  await P.createProgram("staff-1", { id: "people-stepped", name: "People stepped", config: stepped });
  const plain = await rootWake();
  await assert.rejects(N.spawnChild(plain.ctx, { program: "people-stepped", inputs: {}, budget_usd: 1 }), /may not spawn the program people-stepped/);
  await finish(plain.c, "parked");
  // A person starts it: the runner root carries the permit, and spawns it; it may not spawn another people-only program.
  await P.createProgram("staff-1", { id: "people-other", name: "People other", config: { ...stepped } });
  const S = await import("../src/program-start.js");
  assert.deepEqual(S.personStart((await P.readProgram("people-stepped")).config), { via: "runner", profile: "default", permit: true });
  const started = await S.startProgram(org.orgId, person, "people-stepped", { inputs: {} });
  const [frozen] = await db.query<{ permit: string | null }>("SELECT policy->'nested'->>'permit_program' AS permit FROM harness_sessions WHERE id = $1", [started.session.id]);
  assert.equal(frozen?.permit, "people-stepped", "the root's permit names it (frozen with its policy)");
  const c = await claim(started.session.id);
  const root = await start(c);
  const m = await N.spawnChild(root.ctx, { program: "people-stepped", inputs: {}, budget_usd: 1 });
  assert.ok(m.handle, "the permitted root spawns it");
  await assert.rejects(N.spawnChild(root.ctx, { program: "people-other", inputs: {}, budget_usd: 1 }), /may not spawn the program people-other/, "exactly that program");
  await N.cancelChildrenOf(org.orgId, root.w.session_id, "done with the test");
  await finish(c, "parked");
  // roles: account roles that may start it, refused when not one.
  const hash = (t: string) => t;
  const Spec = await import("../src/program-spec.js");
  assert.deepEqual(Spec.parseProgram({ prompt: "x", roles: ["owner", "member"] }, hash).config?.roles, ["owner", "member"]);
  assert.match(Spec.parseProgram({ prompt: "x", roles: ["boss"] }, hash).problems.join(";"), /roles: account roles/);
  assert.deepEqual(S.programRoles(Spec.parseProgram({ prompt: "x", roles: ["owner"] }, hash).config!), ["owner"]);
  // A pack's program whose record names an area or field the build does not have is refused when the packs load.
  const { installPacks } = await import("../src/packs.js");
  const area = { name: "si_load", label: "Load", role: "check", scope: "workspace", fields: [{ name: "statement", label: "Statement" }] };
  const withRecord = (record: unknown) => () => installPacks([{ manifest: { id: "fixture_si_load", name: "Load", version: "1", entry: null, migrations: null, words: {} },
    definition: definePack({ id: "fixture_si_load", recordAreas: [area], programs: [{ id: "load-prog", name: "Load prog", config: { prompt: "x", record } }] } as never) } as never]);
  assert.throws(withRecord({ area: "si_nowhere", fields: { statement: "s" } }), /programs\[0\] load-prog: record\.area: si_nowhere is not a record area/);
  assert.throws(withRecord({ area: "si_load", fields: { colour: "c" } }), /record\.fields\.colour: si_load has no such field/);
  // The staff routes: a policy proposal decided, a version's patch.
  const { default: express } = await import("express");
  const router = express.Router();
  (await import("../src/program-routes.js")).programAdminRoutes(router, () => (_q, _r, next) => next(), () => "staff-1");
  const paths = (router.stack as unknown as { route?: { path: string; methods: Record<string, boolean> } }[]).flatMap((l) => (l.route ? Object.keys(l.route.methods).map((x) => `${x.toUpperCase()} ${l.route!.path}`) : []));
  for (const want of ["POST /program-champions/:id/proposal", "GET /program-champions/:id/patch"]) assert.ok(paths.includes(want), `${want}: ${paths.join(", ")}`);
});

console.log(`\nself-improvement: ${ran - failed} of ${ran} passed`);
cleanup();
process.exit(failed ? 1 : 0);

// Nested runs, the review's defects (mold_v0-291): one regression per finding, each run on its own so a failure names itself.
//   npx tsx scripts/nested-runs-review-test.ts     (part of npm run test:nested-runs)
// The evaluator's items need a runner started as root (to switch to the run users), as a sandbox's is; off root they are
// skipped and say so.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { cleanup, startHttp, STAMP, TMP } from "./lib/test-world.js";

process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];

let failed = 0, ran = 0;
async function item(name: string, fn: () => Promise<void>) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  ran++;
  try { await freshWorkspace(); await fn(); console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}\n    ${String((e as Error).message).split("\n").slice(0, 4).join("\n    ").slice(0, 700)}`); }
}
const AS_ROOT = process.getuid?.() === 0;

const F = await import("../src/features.js");
F.setFeaturesForTest({ agent_harness: true, nested_runs: true });
const { getDb } = await import("../src/db.js");
const db = await getDb();
await import("../src/server.js");
const runs = await import("../src/runs.js");
const harness = await import("../src/run-harness.js");
const H = await import("../src/harness-sessions.js");
const N = await import("../src/nested-runs.js");
const P = await import("../src/programs.js");
const Reach = await import("../src/harness-reach.js");
const { storeUploadBytes } = await import("../src/agent-profiles.js");
const { packBundle } = await import("../src/workspace-bundle.js");
const { createOrg } = await import("../src/auth.js");
const { saveSettingValues } = await import("../src/platform-keys.js");
const kv = await import("../src/keyvault.js");
type Actor = import("../src/harness-sessions.js").Actor;
type Claim = import("../src/runs.js").Claim;
type OrgT = import("../src/auth.js").Org;

await saveSettingValues("test-staff", { AGENT_CHECKPOINT_SECONDS: 0, AGENT_SESSION_BUDGET_USD: 10, AGENT_BUDGET_CEILING_USD: 20 });
const http = await startHttp();
process.env.PUBLIC_URL = http.base;
const seen: unknown[] = [];
const upstream = createServer((req, res) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => { seen.push(Buffer.concat(c).toString()); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 1 } })); }); });
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
await kv.upsertProvider({ slug: "anthropic", mode: "gateway", enabled: true, upstream_url: `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}`, auth_header: "x-api-key", auth_prefix: "", env_vars: ["ANTHROPIC_API_KEY"] });
await kv.setCredential("anthropic", "sk-fixture-real-key");
const client = await harness.localRunnerClient("w-review");

// Each item has a workspace of its own: what one leaves running cannot use up another's places.
let org: OrgT, person: Actor, worldNo = 0;
async function freshWorkspace() {
  org = (await createOrg(`Review ${STAMP} ${++worldNo}`)).org;
  const signedIn = await http.signInAs(org, "owner");
  person = { kind: "person", user: signedIn.userId, name: "r@example.org", role: "owner" };
}

const claimOf = async (sessionId: string): Promise<Claim> => {
  const [r] = await db.query<{ id: string }>("SELECT id FROM runs WHERE harness_session_id = $1 AND status = 'queued' ORDER BY created_at DESC LIMIT 1", [sessionId]);
  assert.ok(r, `a queued wake of ${sessionId}`);
  const c = await runs.claimRun("w-review", { runId: r!.id });
  assert.ok(c, "claimed");
  return c!;
};
const startWake = async (c: Claim) => {
  const w = await H.wakeStart(c.run.id, c.lease_token);
  const r = await Reach.resolveToolToken(w.workspace!.token);
  assert.ok("org" in r, `a token that resolves: ${JSON.stringify(r)}`);
  const o = (r as { org: OrgT }).org;
  return { w, org: o, ctx: { orgId: org.orgId, sessionId: w.session_id, runId: o.agentSession!.run!, role: o.role ?? null } };
};
const finish = async (c: Claim, reason: import("../src/harness-sessions.js").EndReason = "done") => { await H.wakeEnd(c.run.id, c.lease_token, { reason }); return client.complete(c.run.id, c.lease_token, { outcome: "succeeded", results: [] }); };
const rootWake = async (budget = 8) => { const s = await H.startSession(org.orgId, person, { message: "root", budget_usd: budget }); const c = await claimOf(s.id); return { s, c, ...(await startWake(c)) }; };
const charge = async (runId: string, usd: number) => { await db.query("INSERT INTO gateway_tokens (token_hash, kind, run_id, providers, expires_at) VALUES ($1, 'run', $2, '{}', now() + interval '1 hour') ON CONFLICT DO NOTHING", [`t-${runId}`, runId]); await db.query("INSERT INTO gateway_usage (token_hash, provider, run_id, requests, errors, input_tokens, output_tokens, bytes, cost_usd, last_at) VALUES ($1, 'anthropic', $2, 1, 0, 1, 1, 1, $3, now()) ON CONFLICT (token_hash, provider) DO UPDATE SET cost_usd = gateway_usage.cost_usd + excluded.cost_usd", [`t-${runId}`, runId, usd]); };
const handleRow = async (id: string) => (await db.query<Record<string, any>>("SELECT * FROM harness_children WHERE id = $1", [id]))[0]!;
const stepsOf = async (id: string) => db.query<Record<string, any>>("SELECT * FROM harness_children WHERE step_of = $1 ORDER BY child_no", [id]);
const sessionRow = async (id: string) => (await db.query<Record<string, any>>("SELECT * FROM harness_sessions WHERE id = $1", [id]))[0]!;
const OUT = { type: "object", required: ["answer"], properties: { answer: { type: "string" } } };
const program = (id: string, name: string, config: Record<string, unknown>) => P.createProgram("staff-1", { id, name, config: { budget_usd: 2, spawned_by: ["*"], failure_policy: "continue", retries: 1, ...config } });

// ---------- the evaluator's users (items 1, 2) ----------
const workBundle = (files: Record<string, string>) => { const d = mkdtempSync(path.join(TMP, "bundle-")); for (const [f, body] of Object.entries(files)) { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), body); } return packBundle(d).bundle; };
const upload = async (rel: string, body: string, executable = false) => { const u = await storeUploadBytes("staff-1", Buffer.from(body)); return { id: u.id, path: rel, bytes: u.bytes, sha256: u.sha256, executable }; };
const CASES = JSON.stringify({ cases: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, input: i, expected: i * 2 })) });
const NODE_SCORER = `let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const c=JSON.parse(s);const got=Number(String(c.output).trim());process.stdout.write(JSON.stringify({score:c.expected===got?1:0.1,safety:1,uid:process.getuid()}));});`;
const PY_SCORER = `import json,os,sys\nc=json.load(sys.stdin)\ngot=float(str(c["output"]).strip() or -1)\nprint(json.dumps({"score":1 if c["expected"]==got else 0.1,"safety":1,"uid":os.getuid()}))\n`;
const stdinJson = `let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const c=JSON.parse(s);`;
const GOOD = `${stdinJson}process.stdout.write(String(c.input*2));});`;
const uidDir = () => { const d = path.join(TMP, `uids-${Math.random().toString(36).slice(2)}`); mkdirSync(d, { recursive: true }); return d; };
const isoOpts = () => ({ runUsers: { first: 62400, last: 62460 }, runUidDir: uidDir(), egress: "off" as const, noNewPrivs: true });
let programNo = 0;
async function evalWorld(scorer: { file: string; body: string; command: string[] }) {
  const files = [await upload("cases.json", CASES), await upload(scorer.file, scorer.body)];
  const test = { files, cases_path: "cases.json", candidate_command: [process.execPath, "run.js"], scorer_command: scorer.command, timeout_seconds: 20 };
  const acceptance = { metric: "score", direction: "maximize", min_lift: 0.05, floors: [{ metric: "uid", min: 0 }], surface: ["run.js"], target: { kind: "recipe", from_input: "target" }, test };
  const machine = { max_transitions: 4, states: [{ id: "candidate", entry: true, prompt: "Improve {target}" }, { id: "accept", kind: "acceptance", candidate_from: "candidate" }], transitions: [{ from: "candidate", to: "accept" }] };
  const id = `eval-${++programNo}`;
  await program(id, `Eval ${programNo}`, { inputs: { type: "object", required: ["target"], properties: { target: { type: "string" } } }, outputs: { type: "object" }, machine, acceptance });
  const target = `kit-${id}`;
  const once = async (candidate: Buffer) => {
    const root = await rootWake();
    const m = await N.spawnChild(root.ctx, { program: id, inputs: { target }, budget_usd: 3 });
    const [step] = await stepsOf(m.handle);
    const c = await claimOf(step!.session_id);
    await startWake(c);
    await client.agent!.candidate!(c.run.id, c.lease_token, candidate);
    await finish(c);
    await N.nestedTick();
    const [ev] = await db.query<{ id: string; run_id: string }>("SELECT e.id, e.run_id FROM harness_evaluations e JOIN harness_children h ON h.id = e.handle_id WHERE h.step_of = $1", [m.handle]);
    assert.ok(ev?.run_id, "an evaluation run was started");
    const k = await runs.claimRun("w-review", { runId: ev!.run_id });
    assert.ok(k, "the evaluation was claimed");
    await harness.runWorkspaceHarness(client, k!, isoOpts());
    const [d] = await db.query<{ outcome: string; reasons: string[]; cases: { floors: { uid: number }; candidate: number | null; baseline: number | null }[] }>("SELECT outcome, reasons, cases FROM harness_evaluations WHERE id = $1", [ev!.id]);
    await finish(root.c, "parked");
    return { d: d!, evId: ev!.id };
  };
  return { once, target };
}
/** A first version accepted by a person, so a later run has a current best to beat. */
async function withChampion(w: Awaited<ReturnType<typeof evalWorld>>, code: string) {
  const first = await w.once(workBundle({ "run.js": code }));
  assert.equal(first.d.outcome, "needs_review", `first: ${first.d.reasons}`);
  await N.reviewEvaluation("reviewer", first.evId, { decision: "accept", reason: "first version" });
}

if (AS_ROOT) {
  await item("1. a candidate cannot overwrite the champion it is measured against", async () => {
    const w = await evalWorld({ file: "score.js", body: NODE_SCORER, command: [process.execPath, "score.js"] });
    await withChampion(w, GOOD);
    // Exactly the champion's answers, plus an attempt on the champion's files: the only way to "improve" is to break the baseline.
    const sabotage = `const fs=require("fs");try{fs.writeFileSync("../champion/run.js","process.stdout.write('0');")}catch{};${GOOD}`;
    const r = await w.once(workBundle({ "run.js": sabotage }));
    assert.equal(r.d.outcome, "refused", `the outcome was ${r.d.outcome}: ${r.d.reasons}`);
    assert.match(r.d.reasons.join(";"), /does not beat|below the required|lower bound/);
    assert.ok(r.d.cases.every((c) => c.baseline === 1), "the baseline was measured untouched");
  });

  await item("2. a candidate cannot run code as the scorer, and the scorer is a user of its own", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hijack-"));
    chmodSync(dir, 0o777);
    const marker = path.join(dir, "ran-as");
    const w = await evalWorld({ file: "score.py", body: PY_SCORER, command: ["/usr/bin/python3", "score.py"] });
    // Plant a user-site module under the HOME the candidate was given: python imports it at start, in whichever process has that HOME.
    const plant = `const fs=require("fs"),cp=require("child_process");try{const site=cp.execFileSync("/usr/bin/python3",["-c","import site;print(site.getusersitepackages())"],{encoding:"utf8"}).trim();fs.mkdirSync(site,{recursive:true});fs.writeFileSync(site+"/usercustomize.py","import os\\nopen('${marker}','w').write(str(os.getuid()))\\n")}catch{};${GOOD}`;
    const r = await w.once(workBundle({ "run.js": plant }));
    assert.ok(!existsSync(marker), `the planted code ran, as uid ${existsSync(marker) ? readFileSync(marker, "utf8") : ""}`);
    assert.ok(r.d.cases.length > 0 && r.d.cases.every((c) => typeof c.floors.uid === "number"), `the scorer ran: ${JSON.stringify(r.d).slice(0, 300)}`);
    const uids = new Set(r.d.cases.map((c) => c.floors.uid));
    assert.equal(uids.size, 1); assert.ok(![...uids].includes(0), "the scorer is not the runner");
  });

  await item("1, 2. no program of an evaluation reaches the network, whichever user it runs as", async () => {
    const hits: string[] = [];
    const probe = createServer((req, res) => { hits.push(String(req.url)); res.end("ok"); });
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(probe.address() as import("node:net").AddressInfo).port}`;
    const calling = (who: string, body: string) => `const call=fetch(${JSON.stringify(url)}+"/${who}").catch(()=>{});` + body.replace('process.stdout.write(', 'call.then(()=>process.stdout.write(').replace(/\);\}\);$/, '));});');
    const w = await evalWorld({ file: "score.js", body: calling("scorer", NODE_SCORER), command: [process.execPath, "score.js"] });
    await withChampion(w, calling("champion", GOOD));
    const r = await w.once(workBundle({ "run.js": calling("candidate", GOOD) }));
    probe.close();
    assert.deepEqual([...new Set(hits)], [], `reached the network: ${[...new Set(hits)].join(" ")}`);
    assert.ok(r.d.cases.length > 0 && r.d.cases.every((c) => typeof c.candidate === "number" && typeof c.baseline === "number"), `each still measured: ${JSON.stringify(r.d).slice(0, 300)}`);
  });

  await item("1. the sandbox's no-new-privileges reaches every program of an evaluation", async () => {
    const w = await evalWorld({ file: "score.js", body: NODE_SCORER, command: [process.execPath, "score.js"] });
    const checks = `${stdinJson}const nnp=require("fs").readFileSync("/proc/self/status","utf8").includes("NoNewPrivs:\\t1");process.stdout.write(nnp?String(c.input*2):"0");});`;
    const r = await w.once(workBundle({ "run.js": checks }));
    assert.ok(r.d.cases.length > 0 && r.d.cases.every((c) => c.candidate === 1), `candidate scores: ${r.d.cases.map((c) => c.candidate)}`);
  });
} else console.log("- 1, 2: the evaluator's run users need a runner started as root: skipped");

await item("the evaluator keeps its lease while a slow test runs", async () => {
  const w = await program("eval-slow", "Slow", { outputs: { type: "object" }, inputs: { type: "object" }, machine: { max_transitions: 3, states: [{ id: "candidate", entry: true, prompt: "go" }, { id: "accept", kind: "acceptance", candidate_from: "candidate" }], transitions: [{ from: "candidate", to: "accept" }] },
    acceptance: { metric: "score", direction: "maximize", min_lift: 0.05, surface: ["run.js"], target: { kind: "recipe", id: "kit-slow" }, test: { files: [await upload("cases.json", JSON.stringify({ cases: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, input: i, expected: i })) })), await upload("score.js", NODE_SCORER)], cases_path: "cases.json", candidate_command: [process.execPath, "-e", `setTimeout(()=>process.stdout.write("1"),350)`], scorer_command: [process.execPath, "score.js"], timeout_seconds: 20 } } });
  void w;
  const root = await rootWake();
  const m = await N.spawnChild(root.ctx, { program: "eval-slow", inputs: {}, budget_usd: 2 });
  const [step] = await stepsOf(m.handle);
  const c = await claimOf(step!.session_id);
  await startWake(c);
  await client.agent!.candidate!(c.run.id, c.lease_token, workBundle({ "run.js": "1" }));
  await finish(c);
  await N.nestedTick();
  const [ev] = await db.query<{ run_id: string }>("SELECT e.run_id FROM harness_evaluations e JOIN harness_children h ON h.id = e.handle_id WHERE h.step_of = $1", [m.handle]);
  const k = await runs.claimRun("w-review", { runId: ev!.run_id });
  let beats = 0;
  const counted = { ...client, heartbeat: (id: string, lease: string) => { beats++; return client.heartbeat(id, lease); } };
  await harness.runWorkspaceHarness(counted as typeof client, { ...k!, lease_seconds: 1 } as Claim, { allowSameUser: true, egress: "off" });
  assert.ok(beats >= 1, "it heartbeat while the test ran");
  await finish(root.c, "parked");
});

// ---------- 3. machines ----------
const LONG = "s".repeat(39);
await item("3. a machine that cannot go on is not settled while a step can still spend", async () => {
  await program("fails-midway", "Fails midway", { outputs: { type: "object" }, inputs: { type: "object" }, machine: { max_transitions: 6, max_children: 3,
    states: [{ id: "a", entry: true, prompt: "a", budget_usd: 0.5 }, { id: "c", entry: true, prompt: "c", budget_usd: 0.5 }, { id: "fan", prompt: "x", budget_usd: 0.2, inputs: { it: "item" }, foreach: { from: "a.items", as: "item", max: 3, join: "all" } }],
    transitions: [{ from: "a", to: "fan" }] } });
  const root = await rootWake();
  const before = (await H.readSession(org.orgId, root.s.id, person)).remaining_usd;
  const m = await N.spawnChild(root.ctx, { program: "fails-midway", inputs: {}, budget_usd: 3 });
  const steps = await stepsOf(m.handle);
  const a = steps.find((s) => s.state_id === "a")!, c = steps.find((s) => s.state_id === "c")!;
  const ca = await claimOf(a.session_id); const sa = await startWake(ca);
  const cc = await claimOf(c.session_id); await startWake(cc);
  await charge(cc.run.id, 0.2);
  void sa;
  await H.wakeTurn(ca.run.id, ca.lease_token, { text: "listed" });
  await db.query("UPDATE harness_children SET outputs = $2 WHERE id = $1", [a.id, JSON.stringify({ items: [1, 2, 3] })]);
  await finish(ca); // the fan-out goes past max_children: the machine fails while c is still running
  assert.equal((await handleRow(m.handle)).settled_at, null, "still open: step c can still spend");
  assert.ok((await handleRow(c.id)).cancel_requested_at, "the step still running was told to stop");
  await client.complete(cc.run.id, cc.lease_token, { outcome: "failed", error_kind: "run", error: "stopped" });
  await N.nestedTick();
  const done = await handleRow(m.handle);
  assert.equal(done.status, "error"); assert.match(done.error, /could not continue/);
  assert.equal(Number(done.spent_usd), 0.2, "its cost is what its steps cost");
  const after = await H.readSession(org.orgId, root.s.id, person);
  assert.equal(after.nested!.carved_usd, 0);
  assert.equal(after.nested!.children_spent_usd, 0.2);
  assert.equal(Number(after.remaining_usd.toFixed(6)), Number((before - 0.2).toFixed(6)), "the parent is charged what was really spent");
  await finish(root.c, "parked");
});

await item("3. steps queued when a machine fails never start", async () => {
  await program("fans-too-far", "Fans too far", { outputs: { type: "object" }, inputs: { type: "object" }, machine: { max_transitions: 4, max_children: 2, states: [{ id: "fan", entry: true, prompt: "x", budget_usd: 0.2, inputs: { it: "item" }, foreach: { from: "$inputs.items", as: "item", max: 3, join: "all" } }], transitions: [] } });
  const root = await rootWake();
  const m = await N.spawnChild(root.ctx, { program: "fans-too-far", inputs: { items: [1, 2, 3] }, budget_usd: 2 });
  await N.nestedTick();
  const steps = await stepsOf(m.handle);
  assert.ok(steps.every((s) => s.session_id === null), `a step started: ${steps.map((s) => s.session_id)}`);
  assert.ok(steps.every((s) => s.settled_at), "and each is settled");
  assert.equal((await handleRow(m.handle)).status, "error");
  assert.equal((await H.readSession(org.orgId, root.s.id, person)).nested!.carved_usd, 0);
  await finish(root.c, "parked");
});

await item("3. a default-budget foreach gives every item a share", async () => {
  await program("fans-evenly", "Fans evenly", { outputs: { type: "object" }, inputs: { type: "object" }, machine: { max_transitions: 4, max_children: 5, states: [{ id: "fan", entry: true, prompt: "x", inputs: { it: "item" }, foreach: { from: "$inputs.items", as: "item", max: 4, join: "all" } }, { id: "after", prompt: "y" }], transitions: [{ from: "fan", to: "after" }] } });
  const root = await rootWake();
  const m = await N.spawnChild(root.ctx, { program: "fans-evenly", inputs: { items: [1, 2, 3] }, budget_usd: 2 });
  const steps = await stepsOf(m.handle);
  assert.equal(steps.length, 3);
  assert.ok(steps.every((s) => Number(s.budget_usd) >= N.MIN_CHILD_BUDGET), `shares: ${steps.map((s) => s.budget_usd)}`);
  assert.equal(new Set(steps.map((s) => Number(s.budget_usd))).size, 1, "an even share");
  assert.equal((await handleRow(m.handle)).settled_at, null);
  assert.ok(steps.reduce((t, s) => t + Number(s.budget_usd), 0) <= 2 + 1e-9);
  await N.cancelChild(root.ctx, m.handle);
  await finish(root.c, "parked");
});

await item("5. a long name cannot break a machine's step", async () => {
  await program("long-name", "N".repeat(80), { outputs: { type: "object" }, inputs: { type: "object" }, machine: { max_transitions: 2, states: [{ id: LONG, entry: true, prompt: "x" }], transitions: [] } });
  const root = await rootWake();
  const m = await N.spawnChild(root.ctx, { program: "long-name", inputs: {}, budget_usd: 1 });
  const [s] = await stepsOf(m.handle);
  assert.ok(s!.name.length <= 80);
  await N.cancelChild(root.ctx, m.handle);
  await finish(root.c, "parked");
});

// ---------- 4. a cancelled acceptance ----------
const acceptProgram = async (id: string, target: string) => program(id, id, { outputs: { type: "object" }, inputs: { type: "object" }, machine: { max_transitions: 3, states: [{ id: "candidate", entry: true, prompt: "go" }, { id: "accept", kind: "acceptance", candidate_from: "candidate" }], transitions: [{ from: "candidate", to: "accept" }] },
  acceptance: { metric: "score", direction: "maximize", min_lift: 0.05, surface: ["run.js"], target: { kind: "recipe", id: target }, test: { files: [await upload("cases.json", CASES), await upload("score.js", NODE_SCORER)], cases_path: "cases.json", candidate_command: [process.execPath, "run.js"], scorer_command: [process.execPath, "score.js"], timeout_seconds: 20 } } });
const startedEvaluation = async (programId: string, target: string) => {
  // A champion to beat, so a good measurement would promote.
  await db.query("INSERT INTO harness_champions (id, org_id, target_kind, target_id, version, status, candidate, created_by) VALUES ($1, $2, 'recipe', $3, 1, 'champion', '{}', 's') ON CONFLICT DO NOTHING", [`hcv_${programId.replace(/[^a-z]/g, "")}xxxxxxxx`.slice(0, 30), org.orgId, target]);
  const root = await rootWake();
  const m = await N.spawnChild(root.ctx, { program: programId, inputs: {}, budget_usd: 2 });
  const [step] = await stepsOf(m.handle);
  const c = await claimOf(step!.session_id);
  await startWake(c);
  await client.agent!.candidate!(c.run.id, c.lease_token, workBundle({ "run.js": GOOD }));
  await finish(c);
  await N.nestedTick();
  const [ev] = await db.query<{ id: string; run_id: string; handle_id: string }>("SELECT e.id, e.run_id, e.handle_id FROM harness_evaluations e JOIN harness_children h ON h.id = e.handle_id WHERE h.step_of = $1", [m.handle]);
  assert.ok(ev?.run_id, "an evaluation is running");
  const k = await runs.claimRun("w-review", { runId: ev!.run_id });
  return { root, m, ev: ev!, k: k! };
};
const goodCases = { tampered: null, cases: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, baseline: 0.5 + (i % 3) * 0.01, candidate: 0.9 + (i % 3) * 0.01, floors: {} })) };

await item("4. a cancelled acceptance is refused, its run stopped, and a late result promotes nothing", async () => {
  await acceptProgram("cancel-accept", "kit-cancel");
  const { root, m, ev, k } = await startedEvaluation("cancel-accept", "kit-cancel");
  await N.cancelChild(root.ctx, m.handle);
  const [d] = await db.query<{ outcome: string | null; reasons: string[] }>("SELECT outcome, reasons FROM harness_evaluations WHERE id = $1", [ev.id]);
  assert.equal(d!.outcome, "refused", "decided as refused when cancelled");
  const [r] = await db.query<{ cancel_requested_at: Date | null; status: string }>("SELECT cancel_requested_at, status FROM runs WHERE id = $1", [ev.run_id]);
  assert.ok(r!.cancel_requested_at || r!.status === "cancelled", "and its run was asked to stop");
  const late = await N.evaluationResult(ev.run_id, k.lease_token, goodCases);
  assert.equal(late.outcome, "refused");
  assert.equal((await N.listChampions(org.orgId, { target: "kit-cancel" })).filter((c) => c.status === "champion")[0]!.version, 1, "nothing was promoted");
  await finish(root.c, "parked");
});

await item("4. a result for a handle that has settled promotes nothing", async () => {
  await acceptProgram("settled-accept", "kit-settled");
  const { root, ev, k } = await startedEvaluation("settled-accept", "kit-settled");
  await H.tx((q) => N.settleHandle(q, org.orgId, ev.handle_id, { status: "cancelled", error: "gone" }));
  const r = await N.evaluationResult(ev.run_id, k.lease_token, goodCases);
  assert.equal(r.outcome, "refused", `the outcome was ${r.outcome}`);
  assert.equal((await N.listChampions(org.orgId, { target: "kit-settled" })).filter((c) => c.status === "champion")[0]!.version, 1);
  await finish(root.c, "parked");
});

// ---------- 5. reconcile ----------
const OLD = "now() - interval '10 minutes'";
await item("5. a child whose start was lost goes back to the queue, of any kind", async () => {
  const root = await rootWake();
  const list = [];
  for (let i = 0; i < 5; i++) list.push(await N.spawnChild(root.ctx, { prompt: `p${i}`, budget_usd: 0.2 }));
  const queued = (await db.query<{ id: string }>("SELECT id FROM harness_children WHERE org_id = $1 AND root_id = $2 AND status = 'queued'", [org.orgId, root.s.id]))[0]!;
  await db.query(`UPDATE harness_children SET status = 'running', updated_at = ${OLD} WHERE id = $1`, [queued.id]);
  await N.nestedTick();
  assert.equal((await handleRow(queued.id)).status, "queued", "a prompt child's lost start is requeued");
  for (const c of await N.listChildren(root.ctx)) if (!c.settled) await N.cancelChild(root.ctx, c.handle);
  await finish(root.c, "parked");
});

await item("5. a step just started is not requeued because the machine is old", async () => {
  await program("young-step", "Young", { outputs: { type: "object" }, inputs: { type: "object" }, machine: { max_transitions: 2, states: [{ id: "a", entry: true, prompt: "a" }], transitions: [] } });
  const root = await rootWake();
  const m = await N.spawnChild(root.ctx, { program: "young-step", inputs: {}, budget_usd: 1 });
  const [s] = await stepsOf(m.handle);
  await db.query("UPDATE harness_children SET status = 'running', session_id = NULL, created_at = now() - interval '1 hour', updated_at = now() WHERE id = $1", [s!.id]);
  await N.nestedTick();
  assert.equal((await handleRow(s!.id)).status, "running", "recently touched: left alone");
  await db.query("UPDATE harness_children SET session_id = $2 WHERE id = $1", [s!.id, s!.session_id]);
  await N.cancelChild(root.ctx, m.handle);
  await finish(root.c, "parked");
});

await item("5. a session stuck starting gets its wake", async () => {
  const root = await rootWake();
  const h = await N.spawnChild(root.ctx, { prompt: "lost its wake", budget_usd: 0.5 });
  const run = (await sessionRow(h.session_id!)).current_run_id as string;
  await db.query("UPDATE runs SET status = 'cancelled', ended_at = now() WHERE id = $1", [run]);
  await db.query(`UPDATE harness_sessions SET current_run_id = NULL, state = 'starting', updated_at = ${OLD} WHERE id = $1`, [h.session_id]);
  await db.query(`UPDATE harness_children SET updated_at = ${OLD} WHERE id = $1`, [h.handle]);
  await N.nestedTick();
  const s = await sessionRow(h.session_id!);
  assert.ok(s.current_run_id && s.current_run_id !== run, "a new wake is queued");
  await N.cancelChild(root.ctx, h.handle);
  await finish(root.c, "parked");
});

await item("5. a machine whose advance was lost moves on", async () => {
  await program("lost-advance", "Lost", { outputs: { type: "object" }, inputs: { type: "object" }, machine: { max_transitions: 3, states: [{ id: "a", entry: true, prompt: "a", budget_usd: 0.3 }, { id: "b", prompt: "b", budget_usd: 0.3 }], transitions: [{ from: "a", to: "b" }] } });
  const root = await rootWake();
  const m = await N.spawnChild(root.ctx, { program: "lost-advance", inputs: {}, budget_usd: 2 });
  const [a] = await stepsOf(m.handle);
  const c = await claimOf(a!.session_id); await startWake(c);
  await H.wakeEnd(c.run.id, c.lease_token, { reason: "done" });
  // The step settles and the process dies before it moves the machine.
  await db.query("UPDATE harness_sessions SET state = 'stopped', state_reason = 'done', current_run_id = NULL, ended_at = now() WHERE id = $1", [a!.session_id]);
  await db.query("UPDATE runs SET status = 'succeeded', ended_at = now() WHERE id = $1", [c.run.id]);
  await H.tx((q) => N.settleHandle(q, org.orgId, a!.id, { status: "done", outputs: {} }));
  assert.equal((await stepsOf(m.handle)).length, 1);
  await N.nestedTick();
  assert.equal((await stepsOf(m.handle)).length, 2, "the next state started");
  await N.cancelChild(root.ctx, m.handle);
  await finish(root.c, "parked");
});

await item("5. an evaluation whose run never started is refused", async () => {
  await db.query(`INSERT INTO harness_evaluations (id, org_id, program_id, program_version, root_id, target_kind, target_id, candidate, acceptance, status, created_at) VALUES ('hev_lostrun001', $1, 'p', 1, 'r', 'recipe', 'k', '{}', '{}', 'running', ${OLD})`, [org.orgId]);
  await N.nestedTick();
  assert.equal((await db.query<{ outcome: string }>("SELECT outcome FROM harness_evaluations WHERE id = 'hev_lostrun001'"))[0]!.outcome, "refused");
});

await item("5. two starts of one child leave one session", async () => {
  const root = await rootWake();
  const list = [];
  for (let i = 0; i < 5; i++) list.push(await N.spawnChild(root.ctx, { prompt: `q${i}`, budget_usd: 0.2 }));
  const [row] = await db.query<Record<string, any>>("SELECT * FROM harness_children WHERE org_id = $1 AND root_id = $2 AND status = 'queued' LIMIT 1", [org.orgId, root.s.id]);
  const both = await Promise.allSettled([N.startHandleForTest(org.orgId, row as never), N.startHandleForTest(org.orgId, row as never)]);
  // A second start that throws is settled as an error by pump, refunding a budget the first start's session is still spending.
  assert.deepEqual(both.map((b) => b.status), ["fulfilled", "fulfilled"], `the second start: ${String((both[1] as PromiseRejectedResult).reason?.message).slice(0, 160)}`);
  const made = await db.query("SELECT id FROM harness_sessions WHERE parent_id = $1 AND title = $2", [root.s.id, row!.name]);
  assert.equal(made.length, 1, `${made.length} sessions for one child`);
  for (const c of await N.listChildren(root.ctx)) if (!c.settled) await N.cancelChild(root.ctx, c.handle);
  await finish(root.c, "parked");
});

// ---------- 6, 7, 8, 9 ----------
await item("6. a person's stop is not undone by the retry for missing outputs", async () => {
  await program("typed-child", "Typed", { prompt: "do it", outputs: OUT, inputs: { type: "object" } });
  const root = await rootWake();
  const h = await N.spawnChild(root.ctx, { program: "typed-child", inputs: {}, budget_usd: 1 });
  const c = await claimOf(h.session_id!); await startWake(c);
  await H.stopSession(org.orgId, h.session_id!, person);
  await finish(c, "stopped");
  await N.nestedTick();
  const r = await handleRow(h.handle);
  assert.equal(r.status, "cancelled", `settled as ${r.status}`);
  assert.equal((await sessionRow(h.session_id!)).current_run_id, null, "no retry wake");
  await finish(root.c, "parked");
});

await item("6. a stop asked while the harness says done is still a stop", async () => {
  const root = await rootWake();
  const prog = await P.readProgram("typed-child");
  void prog;
  const h = await N.spawnChild(root.ctx, { program: "typed-child", inputs: {}, budget_usd: 1 });
  const c = await claimOf(h.session_id!); await startWake(c);
  await H.stopSession(org.orgId, h.session_id!, person);
  await finish(c, "done");
  await N.nestedTick();
  assert.equal((await handleRow(h.handle)).status, "cancelled");
  await finish(root.c, "parked");
});

await item("7. a prompt and a name are redacted", async () => {
  const secret = "sk-" + "ant-api03-" + "C".repeat(40);
  const root = await rootWake();
  const h = await N.spawnChild(root.ctx, { prompt: `use ${secret} please`, name: `named ${secret}`, budget_usd: 0.5 });
  const r = await handleRow(h.handle);
  assert.ok(!r.name.includes(secret), "the name");
  const c = await claimOf(h.session_id!); const s = await startWake(c);
  assert.ok(!s.w.first[0]!.text.includes(secret), "the first message");
  assert.ok(!(await sessionRow(h.session_id!)).title.includes(secret), "the session's title");
  await finish(c);
  await finish(root.c, "parked");
});

await item("8. a machine's steps count against the tree's cap", async () => {
  await program("fans-wide", "Fans wide", { outputs: { type: "object" }, inputs: { type: "object" }, machine: { max_transitions: 2, max_children: 20, states: [{ id: "fan", entry: true, prompt: "x", inputs: { it: "item" }, foreach: { from: "$inputs.items", as: "item", max: 12, join: "all" } }], transitions: [] } });
  const root = await rootWake();
  const m = await N.spawnChild(root.ctx, { program: "fans-wide", inputs: { items: Array.from({ length: 9 }, (_, i) => i) }, budget_usd: 3 });
  await N.nestedTick();
  const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM harness_children WHERE org_id = $1 AND root_id = $2 AND kind <> 'machine' AND session_id IS NOT NULL", [org.orgId, root.s.id]);
  assert.ok(n <= 8, `${n} sandboxes started in one tree`);
  const r = await handleRow(m.handle);
  assert.equal(r.status, "error"); assert.match(r.error, /8 children/);
  await finish(root.c, "parked");
});

await item("8. a prompt child is refused once steps have filled the tree", async () => {
  await program("eight-steps", "Eight", { outputs: { type: "object" }, inputs: { type: "object" }, machine: { max_transitions: 2, max_children: 20, states: [{ id: "fan", entry: true, prompt: "x", budget_usd: 0.1, inputs: { it: "item" }, foreach: { from: "$inputs.items", as: "item", max: 12, join: "all" } }], transitions: [] } });
  const root = await rootWake();
  const m = await N.spawnChild(root.ctx, { program: "eight-steps", inputs: { items: Array.from({ length: 8 }, (_, i) => i) }, budget_usd: 3 });
  await assert.rejects(N.spawnChild(root.ctx, { prompt: "one more", budget_usd: 0.2 }), /8 children/);
  await N.cancelChild(root.ctx, m.handle);
  await finish(root.c, "parked");
});

await item("9. a person demoted below launching cannot spawn", async () => {
  const root = await rootWake();
  await assert.rejects(N.spawnChild({ ...root.ctx, role: "viewer" }, { prompt: "x", budget_usd: 0.2 }), /role/);
  await finish(root.c, "parked");
});

// ---------- the gateway ----------
await item("a tree's model request that cannot be held is refused", async () => {
  const root = await rootWake();
  const before = seen.length;
  const res = await fetch(`${http.base}/gw/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": root.c.gateway.token!, "content-type": "text/plain", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 100000, messages: [] }) });
  assert.equal(res.status, 415, `answered ${res.status}`);
  assert.equal(seen.length, before, "nothing was sent upstream");
  await finish(root.c, "parked");
});

await item("OpenAI's n multiplies what a request holds", async () => {
  const root = await rootWake();
  const run = { id: root.c.run.id, org_id: org.orgId, budget_usd: 8 };
  const held = async (extra: Record<string, unknown>) => {
    const a = await N.admitTreeRequest(run, Buffer.from(JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 1000, messages: [], ...extra })), "claude-sonnet-5-5");
    assert.ok(!("refused" in a));
    const [h] = await db.query<{ usd: string }>("SELECT usd FROM harness_gateway_holds WHERE id = $1", [(a as { hold: string }).hold]);
    await N.releaseHold((a as { hold: string }).hold);
    return Number(h!.usd);
  };
  const one = await held({}), four = await held({ n: 4 });
  assert.ok(four > one * 3, `n = 4 held ${four} against ${one}`);
  await finish(root.c, "parked");
});

upstream.close();
console.log(`\nnested-runs review: ${ran - failed} of ${ran} passed`);
cleanup();
process.exit(failed ? 1 : 0);

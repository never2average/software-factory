// Nested runs and Programs (mold_v0-291, flag nested_runs; src/nested-runs.ts, src/programs.ts, src/program-spec.ts,
// src/program-machine.ts, src/program-acceptance.ts, src/nested-policy.ts, src/program-evaluator.ts), offline: an embedded
// database, the run engine in this process, stand-ins for the sandbox and the model.
//   npm run test:nested-runs
//
//  0. Off (the default): no tool, kind or route; the sessions are as before
//  1. Pure: the schema validator enforces what it declares and refuses what it cannot; a program's shape; the machine
//     (guards, foreach, joins, cycles bounded); the acceptance rule; the intersection of a child's policy
//  2. Spawn and collect: typed outputs, a number AGI-001.1, one carved budget and its refund, the parent woken
//  3. Depth, the child cap, queueing when full (said plainly)
//  4. Budgets: carving is atomic under concurrent spawns; the gateway's holds keep concurrent requests under budget and
//     lower a request's limit; a child cannot be raised
//  5. Cancelling a tree; a crash reconciled by the tick; a parent that ended reaps its children
//  6. Outputs: a missing or invalid output retried once, then fail_fast, continue, escalate
//  7. Governance: a child never widens and never asks; it never receives the sandbox provider's key
//  8. Tenant isolation; 9. Redaction; 10. Machines end to end; 11. Acceptance (accepted, tampered, off surface, floor, no
//     test, a person's review, rollback); 12. Staff CRUD, versions, a pack's declared programs
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";

process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
const ok = (what: string) => console.log(`✓ ${what}`);
const sha = (s: Buffer | string) => createHash("sha256").update(s).digest("hex");

try {
  const F = await import("../src/features.js");
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const runs = await import("../src/runs.js");
  const harness = await import("../src/run-harness.js");
  const H = await import("../src/harness-sessions.js");
  const C = await import("../src/agent-harness-config.js");
  const N = await import("../src/nested-runs.js");
  const P = await import("../src/programs.js");
  const S = await import("../src/program-spec.js");
  const M = await import("../src/program-machine.js");
  const Acc = await import("../src/program-acceptance.js");
  const Pol = await import("../src/nested-policy.js");
  const Reach = await import("../src/harness-reach.js");
  const Prof = await import("../src/agent-profiles.js");
  const { packBundle } = await import("../src/workspace-bundle.js");
  const { agentAppRouter } = await import("../src/agent-routes.js");
  const { createOrg } = await import("../src/auth.js");
  const { saveSettingValues } = await import("../src/platform-keys.js");
  type Actor = import("../src/harness-sessions.js").Actor;
  type JsonSchema = import("../src/program-spec.js").JsonSchema;
  type Machine = import("../src/program-spec.js").Machine;
  type AcceptanceT = import("../src/program-spec.js").Acceptance;
  type MeasuredCase = import("../src/program-acceptance.js").MeasuredCase;
  type Measurement = import("../src/program-acceptance.js").Measurement;

  // ---------- 0. off ----------
  {
    F.setFeaturesForTest({ agent_harness: true });
    assert.equal(F.featureOn("nested_runs"), false, "off by default, even with the agent on");
    assert.ok(!runs.runnableKinds().some((k) => k.name === C.ACCEPTANCE_KIND), "no evaluator kind");
    assert.equal(N.nestedOn(), false);
    assert.equal((await N.nestedTick()).pumped, 0);
    assert.deepEqual(await H.nestedModule(), null);
    const org = (await createOrg(`Nested off ${STAMP}`)).org;
    const person: Actor = { kind: "person", user: "user_off", name: "o@example.org", role: "owner" };
    const s = await H.startSession(org.orgId, person, { message: "plain" });
    assert.equal(s.nested, undefined, "a session has no tree");
    await H.stopSession(org.orgId, s.id, person); // its queued wake withdrawn: nothing is left for the claims below
    const [row] = await db.query<{ root_id: string | null; ref: string | null; policy: { nested?: unknown; tools: string[] } }>("SELECT root_id, ref, policy FROM harness_sessions WHERE id = $1", [s.id]);
    assert.equal(row!.root_id, null); assert.equal(row!.ref, null); assert.equal(row!.policy.nested, undefined);
    assert.ok(!row!.policy.tools.some((t) => /spawn|collect/.test(t)), "no tool in its policy");
    const m = await connect({ ...org, role: "owner" });
    const tools = (await m.client.listTools()).tools.map((t) => t.name);
    assert.ok(!tools.some((t) => ["spawn", "collect", "list_children", "cancel_child", "submit_outputs"].includes(t)), "no tool listed");
    await m.close();
    // A customer's MCP is not given them even with the flag on: only a session's own token (section 2).
    F.setFeaturesForTest({ agent_harness: true, nested_runs: true });
    const m2 = await connect({ ...org, role: "owner" });
    assert.ok(!(await m2.client.listTools()).tools.some((t) => t.name === "spawn"), "on: still not for a person");
    await m2.close();
    F.setFeaturesForTest({ agent_harness: true });
    assert.ok(((agentAppRouter() as unknown as { stack: { route?: { path: string } }[] }).stack).every((l) => !String(l.route?.path ?? "").includes("/tree")), "no route");
    ok("off: no tool, kind or route; a session has no tree");
  }

  // ---------- 1. pure ----------
  {
    // The validator: what it declares it enforces, in words; what it cannot enforce it refuses.
    const schema: JsonSchema = { type: "object", required: ["problems"], additionalProperties: false, properties: { problems: { type: "array", minItems: 1, items: { type: "object", required: ["statement", "severity"], properties: { statement: { type: "string", minLength: 3 }, severity: { enum: ["low", "high"] }, score: { type: "number", minimum: 0, maximum: 1 } } } } } };
    assert.deepEqual(S.schemaProblems(schema), []);
    assert.deepEqual(S.validateJson({ problems: [{ statement: "abc", severity: "low", score: 0.5 }] }, schema), []);
    assert.match(S.validateJson({}, schema)[0]!, /problems: is required/);
    assert.match(S.validateJson({ problems: [] }, schema)[0]!, /at least 1 items/);
    assert.match(S.validateJson({ problems: [{ statement: "ab", severity: "x" }] }, schema).join(";"), /at least 3 characters.*one of/);
    assert.match(S.validateJson({ problems: [{ statement: "abc", severity: "low", score: 2 }] }, schema)[0]!, /at most 1/);
    assert.match(S.validateJson({ problems: [{ statement: "abc", severity: "low" }], extra: 1 }, schema)[0]!, /extra: is not allowed/);
    assert.match(S.schemaProblems({ type: "object", if: {} })[0]!, /not supported/, "an unknown keyword is refused, never ignored");
    assert.match(S.schemaProblems({ $ref: "https://example.com/x" })[0]!, /local/);
    const shared = { $defs: { a: { type: "number" } }, type: "object", properties: { n: { $ref: "#/$defs/a" } } };
    assert.deepEqual(S.schemaProblems(shared), []);
    assert.equal(S.validateJson({ n: "x" }, shared).length, 1, "$ref is followed");

    const good = { prompt: "Look at {topic}", inputs: { type: "object", properties: { topic: { type: "string" } } }, outputs: { type: "object" }, budget_usd: 1, spawned_by: ["*"] };
    assert.deepEqual(S.parseProgram(good, P.sha256).problems, []);
    assert.match(S.parseProgram({ ...good, nonsense: 1 }, P.sha256).problems[0]!, /nonsense: not a field/);
    assert.match(S.parseProgram({ ...good, outputs: { type: "object", if: {} } }, P.sha256).problems[0]!, /outputs\.if: this keyword is not supported/);
    assert.match(S.parseProgram({ ...good, failure_policy: "explode" }, P.sha256).problems[0]!, /failure_policy/);
    assert.match(S.parseProgram({ ...good, acceptance: { metric: "m", direction: "maximize", surface: ["a"], target: { kind: "recipe", id: "x" } } }, P.sha256).problems[0]!, /carried out by an acceptance state/);
    assert.equal(S.renderPrompt("x {a} {b} {c}", { a: "A", b: { k: 1 } }), 'x A {"k":1} {c}');
    assert.ok(S.globMatch("src/**", "src/a/b.ts") && S.globMatch("*.md", "a.md") && !S.globMatch("*.md", "a/b.md") && !S.globMatch("src/*", "src/a/b"));

    // A machine: cycles bounded, joins, foreach, guards.
    const machine: Machine = { max_transitions: 6, states: [{ id: "a", entry: true, prompt: "go" }, { id: "b", prompt: "next" }], transitions: [{ from: "a", to: "b" }, { from: "b", to: "a", when: { output: "again", op: "eq", value: true } }] };
    assert.deepEqual(S.parseProgram({ machine, outputs: { type: "object" } }, P.sha256).problems, []);
    assert.match(S.parseProgram({ machine: { ...machine, max_transitions: undefined }, outputs: {} }, P.sha256).problems[0]!, /max_transitions/);
    assert.match(S.parseProgram({ machine: { ...machine, transitions: [{ from: "a", to: "nope" }] }, outputs: {} }, P.sha256).problems.join(";"), /nope is not a state/);
    assert.match(S.parseProgram({ machine: { ...machine, states: [machine.states[0], { id: "c", prompt: "x" }], transitions: [] }, outputs: {} }, P.sha256).problems.join(";"), /c can never be reached/);
    let { run, start } = M.machineBegin(machine, {}, "continue");
    assert.deepEqual(start.map((s) => s.state), ["a"]);
    // a -> b -> a -> ... until max_transitions.
    for (let i = 0; i < 20 && run.status === "running"; i++) {
      const cur = run.running[0]!;
      ({ run, start } = (({ run: r, start: st }) => ({ run: r, start: st }))(M.machineStep(machine, run, {}, { state: cur.state, entry: cur.entry, index: 0, status: "done", outputs: { again: true } }, "continue")));
    }
    assert.equal(run.status, "error"); assert.match(run.error!, /past its 6 transitions/, "a cycle is bounded");
    // foreach: each item one step; join any cancels the rest.
    const fe: Machine = { max_transitions: 4, states: [{ id: "l", entry: true, prompt: "list" }, { id: "m", prompt: "x", inputs: { it: "item" }, foreach: { from: "l.items", as: "item", max: 3, join: "any" } }, { id: "end", prompt: "y", inputs: { r: "m.results" } }], transitions: [{ from: "l", to: "m" }, { from: "m", to: "end" }] };
    let b = M.machineBegin(fe, {}, "continue");
    let step = M.machineStep(fe, b.run, {}, { state: "l", entry: 1, index: 0, status: "done", outputs: { items: ["p", "q"] } }, "continue");
    assert.deepEqual(step.start.map((s) => s.bindings.item), ["p", "q"]);
    step = M.machineStep(fe, step.run, {}, { state: "m", entry: 1, index: 0, status: "done", outputs: { v: 1 } }, "continue");
    assert.deepEqual(step.cancel, [{ state: "m", entry: 1, index: 1 }], "join any: the other item is cancelled");
    assert.deepEqual(step.start.map((s) => s.state), ["end"]);
    assert.deepEqual(step.start[0]!.bindings.r, [{ v: 1 }]);
    // A join waits for every parent.
    const jm: Machine = { max_transitions: 5, states: [{ id: "a", entry: true, prompt: "a" }, { id: "b", entry: true, prompt: "b" }, { id: "c", prompt: "c", join: { all: ["a", "b"] } }], transitions: [{ from: "a", to: "c" }, { from: "b", to: "c" }] };
    let j = M.machineBegin(jm, {}, "continue");
    const ja = M.machineStep(jm, j.run, {}, { state: "a", entry: 1, index: 0, status: "done", outputs: {} }, "continue");
    assert.equal(ja.start.length, 0, "the join waits"); assert.deepEqual(ja.run.held, ["c"]);
    const jb = M.machineStep(jm, ja.run, {}, { state: "b", entry: 1, index: 0, status: "done", outputs: {} }, "continue");
    assert.deepEqual(jb.start.map((s) => s.state), ["c"]);
    // Guards are JSON-strict and fail shut.
    assert.equal(M.guardPasses({ output: "v", op: "eq", value: 1 }, { v: true }), false);
    assert.equal(M.guardPasses({ output: "v", op: "gt", value: 1 }, {}), false);
    assert.equal(M.guardPasses({ output: "v", op: "exists" }, {}), false);
    // Failure policy: a failed entry passes only unguarded transitions, and only on continue.
    const pm: Machine = { max_transitions: 4, states: [{ id: "a", entry: true, prompt: "a" }, { id: "b", prompt: "b" }], transitions: [{ from: "a", to: "b" }] };
    assert.deepEqual(M.machineStep(pm, M.machineBegin(pm, {}, "continue").run, {}, { state: "a", entry: 1, index: 0, status: "error", error: "x" }, "continue").start.map((s) => s.state), ["b"]);
    assert.equal(M.machineStep(pm, M.machineBegin(pm, {}, "fail_fast").run, {}, { state: "a", entry: 1, index: 0, status: "error", error: "x" }, "fail_fast").run.status, "error");

    // The acceptance rule (src/program-acceptance.ts).
    const rule: AcceptanceT = { metric: "score", direction: "maximize", min_lift: 0.05, floors: [{ metric: "safety", min: 0.9 }], surface: ["src/**"], target: { kind: "recipe", id: "kit" }, test: { files: [], sha256: "", cases_path: "c", candidate_command: ["x"], scorer_command: ["x"], timeout_seconds: 30 } };
    const cases = (b0: number, c0: number, floor = 1): MeasuredCase[] => Array.from({ length: 12 }, (_, i) => ({ id: String(i), baseline: b0 + (i % 3) * 0.01, candidate: c0 + (i % 3) * 0.01, floors: { safety: floor } }));
    const seed = Acc.seedOf("e1");
    const decide = (m: Measurement | null, extra: Partial<Parameters<typeof Acc.decideAcceptance>[1]> = {}, a = rule) => Acc.decideAcceptance(a, { measured: m, offSurfacePaths: [], hasBest: true, seed, ...extra });
    assert.equal(decide({ cases: cases(0.5, 0.6), tampered: null }).outcome, "accepted");
    assert.deepEqual(decide({ cases: cases(0.5, 0.6), tampered: null }).reasons, decide({ cases: cases(0.5, 0.6), tampered: null }).reasons, "deterministic");
    assert.match(decide({ cases: [], tampered: "the test's files changed" }).reasons[0]!, /tampered/);
    assert.equal(decide({ cases: cases(0.5, 0.6), tampered: null }, { offSurfacePaths: ["config/secret"] }).outcome, "refused");
    assert.match(decide({ cases: cases(0.5, 0.6, 0.5), tampered: null }).reasons[0]!, /floor safety/);
    assert.match(decide({ cases: cases(0.5, 0.6).map((c) => ({ ...c, floors: {} })), tampered: null }).reasons[0]!, /fails closed/);
    assert.match(decide({ cases: cases(0.5, 0.51), tampered: null }).reasons.join(";"), /below the required 5\.0%/);
    assert.match(decide({ cases: cases(0.5, 0.49), tampered: null }).reasons.join(";"), /does not beat/);
    const noisy = Array.from({ length: 12 }, (_, i) => ({ id: String(i), baseline: 0.5, candidate: i % 2 ? 0.9 : 0.15, floors: { safety: 1 } }));
    assert.match(decide({ cases: noisy, tampered: null }).reasons.join(";"), /lower bound/);
    assert.match(decide({ cases: cases(0.5, 0.6).slice(0, 3), tampered: null }).reasons.join(";"), /at least 5/);
    assert.equal(decide({ cases: cases(0.5, 0.6), tampered: null }, { hasBest: false }).outcome, "needs_review", "no best to beat: a person decides");
    assert.equal(decide(null, {}, { ...rule, test: undefined }).outcome, "needs_review", "no test: a person decides");
    assert.equal(decide({ cases: cases(0.5, 0.6).map((c) => ({ ...c, baseline: null })), tampered: null }).outcome, "refused", "an unmeasured baseline fails closed");
    assert.equal(decide({ cases: cases(0.6, 0.5), tampered: null }, {}, { ...rule, direction: "minimize", floors: [] }).outcome, "accepted", "minimize");

    // The intersection (src/nested-policy.ts): every field never wider than the parent's.
    assert.deepEqual(Pol.intersectRules(["a.example.com", "*.example.org", "only.example.net"], ["*.example.com", "b.example.org"]), ["a.example.com", "b.example.org"]);
    assert.deepEqual(Pol.intersectRules(["*"], ["a.example.com"]), ["a.example.com"]);
    assert.deepEqual(Pol.intersectRules(["a.example.com"], ["*"]), ["a.example.com"]);
    assert.deepEqual(Pol.intersectRules(["*.example.com"], ["*.deep.example.com"]), ["*.deep.example.com"]);
    const parent = C.currentPolicy("conversation");
    Object.assign(parent, { provider: "anthropic", web: { tools: "fetch", hosts: ["a.example.com"], calls_max: 5 }, tools: ["Read", "Bash", "mcp__app__read_x"], credentials: ["p/a"], vault_keys: [{ provider: "acme", label: "k", env: "K" }], workspace: { server: "app", acts_as: { kind: "person", name: "x", role: "owner" }, free: "reads", named: [], tools: [{ name: "read_x", title: null, read: true }, { name: "write_x", title: null, read: false }], hidden: ["secret_x"], context: { text: "ctx", max_chars: 100, parts: [] } } });
    const wider: import("../src/nested-policy.js").ProgramSide = { flavour: "claude-code", model: "m", provider: "anthropic", hooks: [], web: { search: true, fetch: true, rules: ["a.example.com", "evil.example.com"], max: 50 }, tools_rule: null, retention_days: null,
      credentials: ["p/a", "p/b"], vault_keys: [{ provider: "acme", label: "k", env: "K" }, { provider: "freestyle", label: "secret", env: "FREESTYLE_API_KEY" }], inference_key: null, free_tools: ["mcp__app__read_x", "mcp__app__write_x"], uploads: [], files: [], recipes: [] };
    const kid = Pol.intersectChildPolicy(parent, wider, C.currentPolicy("task"));
    assert.equal(kid.web.tools, "fetch", "search off because the parent has no search");
    assert.deepEqual(kid.web.hosts, ["a.example.com"]); assert.equal(kid.web.calls_max, 5);
    assert.deepEqual(kid.credentials, ["p/a"], "a credential the parent lacks is dropped");
    assert.deepEqual(kid.vault_keys, [{ provider: "acme", label: "k", env: "K" }], "and a sandbox provider's key never reaches a child");
    assert.ok(!kid.tools.includes("mcp__app__write_x"), "a tool the parent does not have free is not free");
    assert.ok(kid.tools.includes("mcp__app__read_x"));
    assert.deepEqual(kid.workspace?.hidden, ["secret_x"]);
    assert.equal(kid.governance?.egress_approvals, false, "a child never asks");
    assert.equal(kid.mode, "task");
    assert.throws(() => Pol.intersectChildPolicy(parent, { ...wider, provider: "openai" }, C.currentPolicy("task")), /does not/);
    assert.throws(() => Pol.intersectChildPolicy(parent, { ...wider, inference_key: "other" }, C.currentPolicy("task")), /does not/);
    ok("pure: the schema validator, a program's shape, the machine (guards, foreach, join, a cycle bounded), the acceptance rule, the intersection");
  }

  // ---------- the world, on ----------
  F.setFeaturesForTest({ agent_harness: true, nested_runs: true });
  assert.equal(N.nestedOn(), true);
  await saveSettingValues("test-staff", { AGENT_CHECKPOINT_SECONDS: 0, AGENT_SESSION_BUDGET_USD: 10, AGENT_BUDGET_CEILING_USD: 20 });
  const org = (await createOrg(`Nested ${STAMP}`)).org;
  const http = await startHttp();
  const signedIn = await http.signInAs(org, "owner");
  const person: Actor = { kind: "person", user: signedIn.userId, name: "n@example.org", role: "owner" };
  const client = await harness.localRunnerClient("w-nested");
  const SESSION_KIND = `${C.AGENT_PACK}/${C.AGENT_KIND}`;
  const mine = async (id: string) => H.readSession(org.orgId, id, person);
  // A wake, as a stand-in harness: claim it, start it, take its tool token, and let the test say what happens.
  const claim = async (sessionId?: string) => { const c = await client.claim([SESSION_KIND]); assert.ok(c, "a wake to claim"); if (sessionId) { const [r] = await db.query<{ harness_session_id: string }>("SELECT harness_session_id FROM runs WHERE id = $1", [c!.run.id]); assert.equal(r!.harness_session_id, sessionId); } return c!; };
  const start = async (c: import("../src/runs.js").Claim) => { const w = await H.wakeStart(c.run.id, c.lease_token); const r = await Reach.resolveToolToken(w.workspace!.token); assert.ok("org" in r, "a token that resolves"); return { w, org: (r as { org: import("../src/auth.js").Org }).org, ctx: { orgId: org.orgId, sessionId: w.session_id, runId: (r as { org: import("../src/auth.js").Org }).org.agentSession!.run!, role: (r as { org: import("../src/auth.js").Org }).org.role ?? null } }; };
  const finish = async (c: import("../src/runs.js").Claim, reason: import("../src/harness-sessions.js").EndReason = "done") => { await H.wakeEnd(c.run.id, c.lease_token, { reason }); return client.complete(c.run.id, c.lease_token, { outcome: "succeeded", results: [] }); };
  const charge = async (runId: string, usd: number) => { await db.query("INSERT INTO gateway_tokens (token_hash, kind, run_id, providers, expires_at) VALUES ($1, 'run', $2, '{}', now() + interval '1 hour') ON CONFLICT DO NOTHING", [`t-${runId}`, runId]); await db.query(`INSERT INTO gateway_usage (token_hash, provider, run_id, requests, errors, input_tokens, output_tokens, bytes, cost_usd, last_at) VALUES ($1, 'anthropic', $2, 1, 0, 1, 1, 1, $3, now()) ON CONFLICT (token_hash, provider) DO UPDATE SET cost_usd = gateway_usage.cost_usd + excluded.cost_usd`, [`t-${runId}`, runId, usd]); };
  const rootWake = async (message = "root work", opts: { budget_usd?: unknown; profile?: string } = {}) => { const s = await H.startSession(org.orgId, person, { message, ...opts }); const c = await claim(s.id); const st = await start(c); return { s, c, ...st }; };

  const programOut = { type: "object", required: ["problems"], properties: { problems: { type: "array", minItems: 1, items: { type: "object", required: ["statement"], properties: { statement: { type: "string" } } } } } };
  await P.createProgram("staff-1", { id: "discover", name: "Discover problems", config: { prompt: "Find problems in {area}", inputs: { type: "object", required: ["area"], properties: { area: { type: "string" } } }, outputs: programOut, budget_usd: 1, retries: 1, spawned_by: ["*"], failure_policy: "continue" } });

  // ---------- 2. spawn and collect ----------
  {
    const root = await rootWake();
    assert.match(root.s.nested!.ref!, /^AGI-\d{3}$/, "a root gets a number");
    // The tools are the token's own: listed for this wake, nobody else.
    const m = await connect(root.org);
    const names = (await m.client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("spawn") && names.includes("collect") && names.includes("list_children") && names.includes("cancel_child"));
    assert.ok(!names.includes("submit_outputs"), "only a child hands in outputs");
    await m.close();
    await assert.rejects(N.spawnChild(root.ctx, { program: "discover", inputs: {} }), /inputs do not match/);
    await assert.rejects(N.spawnChild(root.ctx, { program: "discover", inputs: { area: "x" }, budget_usd: 999 }), /Not enough budget/);
    await assert.rejects(N.spawnChild(root.ctx, { program: "nope" }), /no such program/);
    await assert.rejects(N.spawnChild(root.ctx, {}), /either program/);
    await assert.rejects(N.spawnChild({ ...root.ctx, runId: "run_other" }, { prompt: "x" }), /Only a running wake/, "only this session's own wake");
    const before = await mine(root.s.id);
    const h = await N.spawnChild(root.ctx, { program: "discover", inputs: { area: "billing" }, budget_usd: 2 });
    assert.equal(h.status, "queued", "its wake waits for a sandbox: it says so"); assert.equal(h.waiting, "waiting for a sandbox"); assert.equal(h.settled, false);
    // Carved: the parent has that much less, and its running wake too.
    const [run] = await db.query<{ budget_usd: string }>("SELECT budget_usd FROM runs WHERE id = $1", [root.c.run.id]);
    assert.equal(Number(run!.budget_usd), Number((before.remaining_usd - 2).toFixed(6)), "the wake's own budget is lowered at once");
    assert.equal((await mine(root.s.id)).remaining_usd, before.remaining_usd - 2);
    const childC = await claim();
    const cs = await start(childC);
    const child = await mine(h.session_id!);
    assert.equal(child.nested!.ref, `${root.s.nested!.ref}.1`, "a child's number");
    assert.equal(child.nested!.parent_id, root.s.id); assert.equal(child.nested!.depth, 1); assert.equal(child.budget_usd, 2);
    assert.equal(child.started_by, "n@example.org", "acts as the root's person");
    assert.match(cs.w.first[0]!.text, /Find problems in billing/);
    const m2 = await connect(cs.org);
    assert.ok((await m2.client.listTools()).tools.map((t) => t.name).includes("submit_outputs"));
    await m2.close();
    const sub = await N.submitOutputs(cs.ctx, { answer: "found one", outputs: { problems: [{ statement: "late invoices" }] } });
    assert.equal(sub.ok, true);
    await charge(childC.run.id, 0.5);
    await finish(childC);
    const got = (await N.collect(root.ctx, { handles: [h.handle] })).children[0]!;
    assert.equal(got.status, "done"); assert.equal(got.settled, true); assert.deepEqual(got.outputs, { problems: [{ statement: "late invoices" }] }); assert.equal(got.answer, "found one");
    assert.equal(got.spent_usd, 0.5);
    const after = await mine(root.s.id);
    assert.equal(after.remaining_usd, before.remaining_usd - 0.5, "what it did not use comes back");
    const [run2] = await db.query<{ budget_usd: string }>("SELECT budget_usd FROM runs WHERE id = $1", [root.c.run.id]);
    assert.equal(Number(run2!.budget_usd), Number((before.remaining_usd - 0.5).toFixed(6)), "and the parent's running wake gets it back too");
    assert.equal(after.nested!.carved_usd, 0); assert.equal(after.nested!.children_spent_usd, 0.5);
    // Its transcript and trace: the spawn is on the parent's events.
    const ev = (await db.query<{ type: string }>("SELECT type FROM run_events WHERE run_id = $1 ORDER BY id", [root.c.run.id])).map((e) => e.type);
    assert.ok(ev.includes("child_spawned") && ev.includes("child_settled"));
    // Prompt children have no schema: their answer is their last words.
    const p = await N.spawnChild(root.ctx, { prompt: "summarise it", budget_usd: 0.5, name: "Summary" });
    const pc = await claim(); await start(pc);
    await H.wakeTurn(pc.run.id, pc.lease_token, { text: "It is summarised." });
    await finish(pc);
    assert.equal((await N.collect(root.ctx, { handles: [p.handle] })).children[0]!.answer, "It is summarised.");
    await finish(root.c, "parked");
    ok("spawn and collect: inputs checked, a carved budget off the parent and its running wake, typed outputs, what is unused returned");
  }

  // ---------- 3. depth, caps and queueing ----------
  {
    const root = await rootWake("caps", { budget_usd: 12 });
    // Depth: a child spawns one, a grandchild cannot.
    const h1 = await N.spawnChild(root.ctx, { prompt: "level one", budget_usd: 2 });
    const c1 = await claim(); const s1 = await start(c1);
    const h2 = await N.spawnChild(s1.ctx, { prompt: "level two", budget_usd: 0.5 });
    const c2 = await claim(); const s2 = await start(c2);
    assert.equal(s2.w.policy.nested!.can_spawn, false, "at the limit it cannot spawn");
    await assert.rejects(N.spawnChild(s2.ctx, { prompt: "level three", budget_usd: 0.2 }), /at most 2 levels/);
    const m = await connect(s2.org);
    assert.ok(!(await m.client.listTools()).tools.map((t) => t.name).includes("spawn"), "and is not offered the tool");
    await m.close();
    // A child's own children settle before it does, and their cost reaches it.
    await charge(c2.run.id, 0.2);
    await finish(c2);
    assert.equal((await N.collect(s1.ctx, { handles: [h2.handle] })).children[0]!.spent_usd, 0.2);
    const parent = await mine(h1.session_id!);
    assert.equal(parent.nested!.children_spent_usd, 0.2);
    await charge(c1.run.id, 0.3);
    await finish(c1);
    assert.equal((await N.collect(root.ctx, { handles: [h1.handle] })).children[0]!.spent_usd, 0.5, "a child's cost includes its own children's");

    // The child cap is the tree's: 8 children in all, whichever level started them. Six more bring it to 8.
    const open: Awaited<ReturnType<typeof N.spawnChild>>[] = [];
    for (let i = 0; i < 6; i++) open.push(await N.spawnChild(root.ctx, { prompt: `c${i}`, budget_usd: 0.2 }));
    await assert.rejects(N.spawnChild(root.ctx, { prompt: "one too many", budget_usd: 0.2 }), /started its 8 children/);
    // Concurrency: four at once; the rest wait, saying so plainly.
    const waiting = open.filter((x) => /4 children are already running/.test(x.waiting ?? ""));
    assert.equal(open.length - waiting.length, 4, "four at once"); assert.equal(waiting.length, 2);
    assert.equal(waiting[0]!.status, "queued"); assert.match(waiting[0]!.waiting!, /4 children are already running/);
    // One finishes: the queue moves, without anyone asking.
    const c3 = await claim(); await start(c3); await finish(c3);
    await N.nestedTick();
    const list = await N.listChildren(root.ctx);
    const dbRunning = await db.query("SELECT 1 FROM harness_children WHERE org_id = $1 AND root_id = $2 AND status = 'running' AND kind <> 'machine'", [org.orgId, root.s.id]);
    assert.equal(dbRunning.length, 4, "the next started");
    for (const x of list.filter((y) => !y.settled)) await N.cancelChild(root.ctx, x.handle);
    await finish(root.c, "parked");
    ok("depth 2, eight children to a tree, four at once, queueing said plainly, a child's cost includes its own children's");
  }

  // ---------- 4. budgets under concurrency ----------
  {
    const root = await rootWake("budgets", { budget_usd: 5 });
    // Twenty spawns at once for $1 each out of $5: at most five pass, and the carve never over-commits.
    const settled = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => N.spawnChild(root.ctx, { prompt: `race ${i}`, budget_usd: 1 })));
    const won = settled.filter((r) => r.status === "fulfilled").length;
    assert.ok(won <= 5, `at most 5 of 20 were carved (got ${won})`);
    const refusals = settled.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason?.message));
    assert.ok(refusals.every((m) => /Not enough budget|started its 8 children/.test(m)), `refused in words: ${refusals[0]}`);
    const s = await mine(root.s.id);
    assert.ok(s.nested!.carved_usd <= 5 && s.remaining_usd >= -1e-9);
    assert.equal(s.nested!.carved_usd, won);
    assert.ok(won <= 4, "a parent always keeps enough to read its children's results");
    // Carved to the margin, it still works: its token resolves and its beat does not stop it for budget.
    assert.ok("org" in await Reach.resolveToolToken(root.w.workspace!.token), "its token works while most of its budget is carved");
    assert.equal((await H.wakeBeat(root.c.run.id, root.c.lease_token, { in_turn: true })).budget, false, "its beat does not stop it");
    for (const c of await N.listChildren(root.ctx)) if (!c.settled) await N.cancelChild(root.ctx, c.handle);
    assert.equal((await mine(root.s.id)).nested!.carved_usd, 0, "cancelling returns every carve");
    await finish(root.c, "parked");

    // The gateway's holds (src/nested-runs.ts admitTreeRequest): concurrent requests never over-commit a run's budget.
    const [{ id: runId }] = await db.query<{ id: string }>("SELECT id FROM runs WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1", [org.orgId]);
    await db.query("UPDATE runs SET budget_usd = 1 WHERE id = $1", [runId]);
    await db.query("DELETE FROM gateway_usage WHERE run_id = $1", [runId]);
    const model = "claude-sonnet-5-5";
    const body = Buffer.from(JSON.stringify({ model, max_tokens: 20000, messages: [{ role: "user", content: "hi" }] }));
    const outPerTok = (await (await import("../src/usage.js")).costOf(model, { input: 2_000_000, cached: 2_000_000, output: 1_000_000, cacheWrite: 0, cacheWrite1h: 0 }))! - (await (await import("../src/usage.js")).costOf(model, { input: 2_000_000, cached: 2_000_000, output: 0, cacheWrite: 0, cacheWrite1h: 0 }))!;
    assert.ok(outPerTok > 0, "a priced model");
    const results = await Promise.all(Array.from({ length: 40 }, () => N.admitTreeRequest({ id: runId, org_id: org.orgId, budget_usd: 1 }, body, model)));
    const heldSum = (await db.query<{ s: string }>("SELECT coalesce(sum(usd), 0) AS s FROM harness_gateway_holds WHERE run_id = $1", [runId]))[0]!.s;
    assert.ok(Number(heldSum) <= 1.0000001, `holds never exceed the budget (${heldSum})`);
    const accepted = results.filter((r) => !("refused" in r));
    assert.ok(accepted.length >= 1 && results.some((r) => "refused" in r), "some requests were refused rather than over-committing");
    assert.match((results.find((r) => "refused" in r) as { refused: string }).refused, /budget/);
    const hold = (accepted[0] as { hold: string }).hold;
    await N.releaseHold(hold);
    assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM harness_gateway_holds WHERE id = $1", [hold]))[0]!.n, 0, "the hold goes once its cost is known");
    await db.query("DELETE FROM harness_gateway_holds WHERE run_id = $1", [runId]);
    // A request larger than what is left has its limit lowered to what the budget can pay for; below any useful size it is refused.
    await db.query("UPDATE runs SET budget_usd = 0.02 WHERE id = $1", [runId]);
    const small = await N.admitTreeRequest({ id: runId, org_id: org.orgId, budget_usd: 0.02 }, body, model);
    assert.ok(!("refused" in small));
    assert.equal((small as { rewritten: boolean }).rewritten, true);
    const lowered = JSON.parse((small as { body: Buffer }).body.toString()) as { max_tokens: number };
    assert.ok(lowered.max_tokens > 0 && lowered.max_tokens < 20000, `lowered to ${lowered.max_tokens}`);
    await db.query("DELETE FROM harness_gateway_holds WHERE run_id = $1", [runId]);
    await db.query("UPDATE runs SET budget_usd = 0.00001 WHERE id = $1", [runId]);
    assert.ok("refused" in await N.admitTreeRequest({ id: runId, org_id: org.orgId, budget_usd: 0.00001 }, body, model), "nothing useful fits: refused");
    await db.query("DELETE FROM harness_gateway_holds WHERE run_id = $1", [runId]);

    // A child is not raised, and its parent's own floor includes what it carved.
    const r2 = await rootWake("no raise", { budget_usd: 2 });
    const h = await N.spawnChild(r2.ctx, { prompt: "x", budget_usd: 1 });
    const c = await claim(); await start(c);
    await assert.rejects(H.raiseBudget(org.orgId, h.session_id!, person, { to_usd: 5, reason: "more" }), /comes from its parent/);
    assert.equal((await mine(h.session_id!)).budget_change.allowed, false);
    await assert.rejects(H.raiseBudget(org.orgId, r2.s.id, person, { to_usd: 0.5, reason: "lower" }), /below what the session has already spent/, "the floor includes what is carved");
    assert.equal((await mine(r2.s.id)).budget_change.floor_usd, 1);
    await finish(c);
    await finish(r2.c, "parked");
    ok("budgets: carving is atomic under concurrent spawns; the gateway's holds never over-commit and lower a request's limit; a child cannot be raised");
  }

  // ---------- 5. cancelling and crashes ----------
  {
    const root = await rootWake("cancel tree", { budget_usd: 6 });
    const a = await N.spawnChild(root.ctx, { prompt: "a", budget_usd: 1 });
    const ca = await claim(); const sa = await start(ca);
    const g = await N.spawnChild(sa.ctx, { prompt: "grandchild", budget_usd: 0.5 });
    const cg = await claim(); await start(cg);
    // Stopping the root cancels the whole tree.
    await H.stopSession(org.orgId, root.s.id, person);
    const child = await db.query<{ cancel_requested_at: Date | null; status: string }>("SELECT cancel_requested_at, status FROM harness_children WHERE id = ANY ($1)", [[a.handle, g.handle]]);
    assert.ok(child.every((c) => c.cancel_requested_at), "cancelled");
    // Their runners see the cancel and end.
    await client.complete(cg.run.id, cg.lease_token, { outcome: "succeeded", results: [] }).catch(() => {});
    await client.complete(ca.run.id, ca.lease_token, { outcome: "succeeded", results: [] }).catch(() => {});
    await N.nestedTick();
    assert.equal((await db.query<{ status: string }>("SELECT status FROM harness_children WHERE id = $1", [a.handle]))[0]!.status, "cancelled");
    assert.equal((await db.query<{ status: string }>("SELECT status FROM harness_children WHERE id = $1", [g.handle]))[0]!.status, "cancelled");
    await finish(root.c).catch(() => {});

    // A crash: the child's runner dies. The sweep reconciles it, from the database alone.
    const root2 = await rootWake("crash", { budget_usd: 4 });
    const h = await N.spawnChild(root2.ctx, { prompt: "will crash", budget_usd: 1 });
    const c = await claim(); await start(c);
    await H.wakeBeat(c.run.id, c.lease_token, { in_turn: true, session_id: "harness-session-1" });
    // No wakeEnd, no completion; the lease lapses (the sweep of runs fails it), then the tick reconciles.
    await db.query("UPDATE runs SET lease_expires_at = now() - interval '1 hour', heartbeat_at = now() - interval '1 hour' WHERE id = $1", [c.run.id]);
    await runs.sweepRuns();
    // auto_resume restarts it once (the child's crash_resumes); that wake crashes too.
    const c2 = await claim(h.session_id!);
    await start(c2);
    await db.query("UPDATE runs SET lease_expires_at = now() - interval '1 hour', heartbeat_at = now() - interval '1 hour' WHERE id = $1", [c2.run.id]);
    await runs.sweepRuns();
    await N.nestedTick();
    const after = (await N.collect(root2.ctx, { handles: [h.handle] })).children[0]!;
    assert.equal(after.status, "error"); assert.match(after.error!, /crashed|stopped/);
    assert.equal((await mine(root2.s.id)).nested!.carved_usd, 0, "its carve came back");
    await finish(root2.c, "parked");

    // A parent that ended reaps a child even if nobody cancelled it: a lost process, seen by the tick alone.
    const root3 = await rootWake("reap", { budget_usd: 3 });
    const q = await N.spawnChild(root3.ctx, { prompt: "orphan", budget_usd: 1 });
    await db.query("UPDATE harness_sessions SET state = 'failed', state_reason = 'test', current_run_id = NULL, ended_at = now() WHERE id = $1", [root3.s.id]);
    await db.query("UPDATE runs SET status = 'failed', ended_at = now() WHERE id = $1", [root3.c.run.id]);
    const orphan = await client.claim([SESSION_KIND]);
    assert.ok(orphan, "its wake is still queued");
    await N.nestedTick();
    await client.complete(orphan!.run.id, orphan!.lease_token, { outcome: "failed", error_kind: "run", error: "x" }).catch(() => {});
    await N.nestedTick();
    assert.equal((await db.query<{ status: string }>("SELECT status FROM harness_children WHERE id = $1", [q.handle]))[0]!.status, "cancelled");
    ok("cancelling: stopping the root cancels the tree; a crash is settled by the sweep alone; a parent that ended reaps its children");
  }

  // ---------- 6. outputs and failure policy ----------
  {
    const fp = (id: string, policy: string) => P.createProgram("staff-1", { id, name: id, config: { prompt: "do it", outputs: programOut, budget_usd: 1, retries: 1, spawned_by: ["*"], failure_policy: policy } });
    await fp("fast-fail", "fail_fast"); await fp("escalates", "escalate");
    const root = await rootWake("outputs", { budget_usd: 8 });
    const h = await N.spawnChild(root.ctx, { program: "discover", inputs: { area: "x" }, budget_usd: 1 });
    const c = await claim(); await start(c);
    // Finishing without handing in anything: one retry, the reason said.
    await finish(c);
    const c2 = await claim(h.session_id!);
    const s2 = await start(c2);
    assert.match(s2.w.first[0]!.text, /submit_outputs was not called/);
    // An invalid hand-in is refused with words, and counted: it had its retry.
    const bad = await N.submitOutputs(s2.ctx, { outputs: { problems: [] } });
    assert.equal(bad.ok, false); assert.match(bad.errors[0]!, /at least 1 items/); assert.equal(bad.retries_left, 0);
    await finish(c2);
    await N.nestedTick();
    const failed = (await N.collect(root.ctx, { handles: [h.handle] })).children[0]!;
    assert.equal(failed.status, "error"); assert.match(failed.error!, /without outputs/);
    // Spending its budget is an error, never a request a person sees.
    const b = await N.spawnChild(root.ctx, { prompt: "spend", budget_usd: 0.2 });
    const cb = await claim(); await start(cb);
    await charge(cb.run.id, 0.2);
    await H.wakeEnd(cb.run.id, cb.lease_token, { reason: "budget" });
    await client.complete(cb.run.id, cb.lease_token, { outcome: "succeeded", results: [] });
    const spent = (await N.collect(root.ctx, { handles: [b.handle] })).children[0]!;
    assert.equal(spent.status, "error"); assert.match(spent.error!, /spent its budget/);
    assert.equal((await db.query("SELECT 1 FROM harness_session_requests WHERE session_id = $1 AND status = 'pending'", [b.session_id])).length, 0, "no one is asked");
    // fail_fast: the siblings are cancelled.
    const ff = await N.spawnChild(root.ctx, { program: "fast-fail", inputs: {}, budget_usd: 0.5 });
    const sib = await N.spawnChild(root.ctx, { prompt: "sibling", budget_usd: 0.5 });
    const cf = await claim(ff.session_id!); const sf = await start(cf);
    const c3s = await claim(sib.session_id!); await start(c3s);
    await N.submitOutputs(sf.ctx, { outputs: { problems: [] } }); await N.submitOutputs(sf.ctx, { outputs: { problems: [] } });
    await finish(cf); await N.nestedTick();
    const c4 = await client.claim([SESSION_KIND]); // its one retry wake
    if (c4) { await H.wakeStart(c4.run.id, c4.lease_token); await finish(c4); await N.nestedTick(); }
    await client.complete(c3s.run.id, c3s.lease_token, { outcome: "succeeded", results: [] }).catch(() => {});
    await N.nestedTick();
    assert.equal((await db.query<{ status: string }>("SELECT status FROM harness_children WHERE id = $1", [sib.handle]))[0]!.status, "cancelled", "fail_fast cancelled its sibling");
    // escalate: a person is told.
    const esc = await N.spawnChild(root.ctx, { program: "escalates", inputs: {}, budget_usd: 0.5 });
    const ce = await claim(esc.session_id!); await start(ce); await finish(ce); await N.nestedTick();
    const ce2 = await client.claim([SESSION_KIND]);
    if (ce2) { await H.wakeStart(ce2.run.id, ce2.lease_token); await finish(ce2); await N.nestedTick(); }
    const e = (await N.collect(root.ctx, { handles: [esc.handle] })).children[0]!;
    assert.equal(e.status, "error"); assert.equal(e.attention, true);
    assert.ok((await mine(root.s.id)).messages.some((m) => m.role === "system" && /needs someone to look/.test(m.body)));
    await finish(root.c, "parked");
    ok("outputs: invalid refused with words and retried once, then fail_fast, continue or escalate; a child never asks for budget");
  }

  // ---------- 7. governance ----------
  {
    const governed = await Prof.createProfile("staff-1", { name: `Narrow ${STAMP}`, config: { harness: "claude-code", governance: { web: { enabled: true, web_search_enabled: false, web_fetch_enabled: true, web_fetch_allowed_domains: ["a.example.com"], max_calls: 3 } } } });
    const wide = await Prof.createProfile("staff-1", { name: `Wide ${STAMP}`, config: { harness: "claude-code", governance: { web: { enabled: true, web_search_enabled: true, web_fetch_enabled: true, web_fetch_allowed_domains: ["*"], max_calls: 100 } } } });
    await P.createProgram("staff-1", { id: "wide-web", name: "Wide", config: { prompt: "reach the web", agent_profile: wide.id, outputs: { type: "object" }, budget_usd: 0.5, spawned_by: ["*"] } });
    const root = await rootWake("governed", { budget_usd: 3, profile: governed.id });
    const h = await N.spawnChild(root.ctx, { program: "wide-web", inputs: {}, budget_usd: 0.5 });
    const c = await claim(h.session_id!); const s = await start(c);
    const p = s.w.policy;
    assert.deepEqual(p.web.hosts, ["a.example.com"], "the parent's allowlist is the most it gets");
    assert.equal(p.web.tools, "fetch"); assert.equal(p.governance!.web!.max_calls, 3);
    assert.equal(p.governance!.egress_approvals, false);
    // It cannot ask (the runner's check) and the server refuses it too.
    const { checkToolUse } = await import("../src/agent-harness.js");
    assert.deepEqual(checkToolUse({ id: "1", name: "WebFetch", input: { url: "https://b.example.com/x" } }, p, 0), { ok: false, violation: "web_fetch_domain_not_allowed" }, "a host outside it ends the child");
    await assert.rejects(H.wakeRequest(c.run.id, c.lease_token, { kind: "web", subject: "b.example.com" }), /never asks/);
    // A request made before it was a child cannot be approved into one (defence in depth).
    await db.query("INSERT INTO harness_session_requests (id, session_id, org_id, run_id, kind, subject, detail) VALUES ('hsr_testtest1', $1, $2, $3, 'web', 'b.example.com', '{}')", [h.session_id, org.orgId, c.run.id]);
    await assert.rejects(H.decideRequest(org.orgId, h.session_id!, "hsr_testtest1", person, "approve"), /cannot be given more than its parent/);
    await db.query("DELETE FROM harness_session_requests WHERE id = 'hsr_testtest1'");
    // No provider key or broader token in what the child sees.
    assert.ok(!JSON.stringify(p).toLowerCase().includes("freestyle"), "no sandbox provider in its policy");
    assert.equal((await db.query("SELECT 1 FROM gateway_tokens WHERE run_id = $1 AND array_length(providers, 1) > 1", [c.run.id])).length, 0, "its gateway token is its own run's, for its provider only");
    await finish(c);
    await finish(root.c, "parked");
    ok("governance: a child's allowlist is the intersection, it can never ask, and approving a request for it is refused");
  }

  // ---------- 8 and 9. tenant isolation and redaction ----------
  {
    const other = (await createOrg(`Nested other ${STAMP}`)).org;
    const root = await rootWake("isolation", { budget_usd: 4 });
    const h = await N.spawnChild(root.ctx, { prompt: "secret", budget_usd: 0.5, inputs: { note: "token " + "sk-" + "ant-api03-" + "A".repeat(40) } });
    assert.ok(!JSON.stringify(await db.query("SELECT inputs FROM harness_children WHERE id = $1", [h.handle])).includes("sk-ant-api03-AAAA"), "inputs are redacted before they are kept");
    const c = await claim(h.session_id!); const s = await start(c);
    assert.ok(!s.w.first[0]!.text.includes("sk-ant-api03-AAAA"), "and before the child reads them");
    await assert.rejects(N.collect({ ...root.ctx, orgId: other.orgId }, {}).then((r) => { assert.equal(r.children.length, 0); throw new Error("no such"); }), /no such/);
    await assert.rejects(N.cancelChild({ ...root.ctx, orgId: other.orgId }, h.handle), /no such child/, "another workspace's child is not found");
    await assert.rejects(H.readSession(other.orgId, h.session_id!, person), /no such session/);
    const [t] = await db.query("SELECT 1 FROM harness_session_tokens WHERE org_id = $1", [other.orgId]);
    assert.equal(t, undefined, "no token of its is another's");
    await N.submitOutputs(s.ctx, { answer: "see " + "sk-" + "ant-api03-" + "B".repeat(40) });
    await finish(c);
    const got = (await N.collect(root.ctx, { handles: [h.handle] })).children[0]!;
    assert.ok(!(got.answer ?? "").includes("sk-ant-api03-BBBB"), "outputs are redacted as they are submitted");
    await finish(root.c, "parked");
    // Past retention, what passed to and from a child goes with the conversation; what it cost stays.
    await db.query("UPDATE harness_sessions SET retention_until = now() - interval '1 day', current_run_id = NULL WHERE id = $1", [root.s.id]);
    await H.sweepHarnessSessions();
    const [pruned] = await db.query<{ answer: string | null; inputs: Record<string, unknown>; spent_usd: string }>("SELECT answer, inputs, spent_usd FROM harness_children WHERE id = $1", [h.handle]);
    assert.equal(pruned!.answer, null); assert.deepEqual(pruned!.inputs, {});
    ok("tenant isolation: another workspace reads and cancels nothing; inputs and outputs are redacted");
  }

  // ---------- 10 and 11. machines and acceptance ----------
  {
    const { storeUploadBytes } = await import("../src/agent-profiles.js");
    const scratch = mkdtempSync(path.join(TMP, "contract-"));
    const upload = async (rel: string, body: string, executable = true) => { const u = await storeUploadBytes("staff-1", Buffer.from(body)); return { id: u.id, path: rel, bytes: u.bytes, sha256: u.sha256, executable }; };
    const scorer = `#!/usr/bin/env node\nlet s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const c=JSON.parse(s);const got=Number(String(c.output).trim());process.stdout.write(JSON.stringify({score:c.expected===got?1:0.3+got/1000,safety:1}));});`;
    const casesBody = JSON.stringify({ cases: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, input: i, expected: i * 2 })) });
    const files = [await upload("cases.json", casesBody, false), await upload("score.js", scorer)];
    const test = { files, cases_path: "cases.json", candidate_command: [process.execPath, "run.js"], scorer_command: [process.execPath, "score.js"], timeout_seconds: 20 };
    const acceptance = { metric: "score", direction: "maximize", min_lift: 0.05, floors: [{ metric: "safety", min: 0.5 }], surface: ["run.js", "lib/**"], target: { kind: "recipe", from_input: "target" }, test };
    const machine = { max_transitions: 6, states: [{ id: "candidate", entry: true, prompt: "Make a better recipe for {target}", outputs: { type: "object" } }, { id: "accept", kind: "acceptance", candidate_from: "candidate", hypothesis: "$inputs.hypothesis" }], transitions: [{ from: "candidate", to: "accept" }] };
    const config = { inputs: { type: "object", required: ["target"], properties: { target: { type: "string" }, hypothesis: { type: "string" } } }, outputs: { type: "object", required: ["decision"], properties: { decision: { type: "string" }, version: { type: ["number", "null"] } } }, budget_usd: 2, spawned_by: ["*"], failure_policy: "continue", machine, acceptance };
    await P.createProgram("staff-1", { id: "improver", name: "Improver", config });
    const champ = (await P.readProgram("improver")).config.acceptance!;
    assert.equal(champ.test!.sha256.length, 64, "the contract is frozen by its own contents");

    const workBundle = (files: Record<string, string>) => { const d = mkdtempSync(path.join(scratch, "b-")); for (const [f, body] of Object.entries(files)) { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), body); } return packBundle(d).bundle; };
    const goodRun = `let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const c=JSON.parse(s);process.stdout.write(String(c.input*2));});`;
    const weakRun = `let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{process.stdout.write("5");});`;
    const evalOpts = { allowSameUser: true, egress: "off" as const };
    const runEval = async () => { const k = await client.claim([`${C.AGENT_PACK}/${C.ACCEPTANCE_KIND}`]); assert.ok(k, "an evaluation to run"); return harness.runWorkspaceHarness(client, k!, evalOpts); };
    /** One program run: a root, its machine, a candidate step, then the guardian. */
    const improve = async (candidate: Buffer | null, target = "kit-a") => {
      const root = await rootWake(`improve ${target}`, { budget_usd: 6 });
      const m = await N.spawnChild(root.ctx, { program: "improver", inputs: { target, hypothesis: "doubling helps" }, budget_usd: 3 });
      assert.equal(m.kind, "machine");
      const c = await claim(); const s = await start(c);
      assert.match(s.w.first[0]!.text, new RegExp(`better recipe for ${target}`));
      if (candidate) await client.agent!.candidate!(c.run.id, c.lease_token, candidate);
      await N.submitOutputs(s.ctx, { answer: "done", outputs: {} });
      await charge(c.run.id, 0.25);
      await finish(c);
      return { root, m };
    };
    const decision = async (id: string) => (await db.query<{ outcome: string; reasons: string[]; metrics: { lift?: number } }>("SELECT outcome, reasons, metrics FROM harness_evaluations WHERE handle_id IN (SELECT id FROM harness_children WHERE step_of = $1) ORDER BY created_at DESC LIMIT 1", [id]))[0]!;

    // No champion yet: measured and sent to a person (nothing is promoted by itself), and the machine's own output says so.
    const r1 = await improve(workBundle({ "run.js": goodRun }));
    assert.ok(await runEval());
    let d1 = await decision(r1.m.handle);
    assert.equal(d1.outcome, "needs_review");
    assert.match(d1.reasons[0]!, /no current best/);
    assert.equal((await db.query("SELECT 1 FROM harness_champions")).length, 0, "nothing promoted");
    const col = (await N.collect(r1.root.ctx, { handles: [r1.m.handle] })).children[0]!;
    assert.equal(col.status, "done"); assert.equal((col.outputs as { decision: string }).decision, "needs_review");
    assert.equal(((await N.listChildren(r1.root.ctx)) as { spent_usd: number }[]).find((x) => x.spent_usd > 0)!.spent_usd, 0.25, "the machine's cost is what its steps cost");
    await finish(r1.root.c, "parked");
    // A person accepts: it becomes the first champion, against a recorded reason.
    const ev1 = (await db.query<{ id: string }>("SELECT id FROM harness_evaluations WHERE handle_id IN (SELECT id FROM harness_children WHERE step_of = $1)", [r1.m.handle]))[0]!.id;
    await assert.rejects(N.reviewEvaluation("reviewer", ev1, { decision: "accept" }), /reason/);
    const reviewed = await N.reviewEvaluation("reviewer", ev1, { decision: "accept", reason: "looks right" });
    assert.equal(reviewed.review_decision, "accept"); assert.ok(reviewed.promoted_id);
    await assert.rejects(N.reviewEvaluation("reviewer", ev1, { decision: "accept", reason: "again" }), /already decided/);
    const v1 = (await N.listChampions(org.orgId)).find((c) => c.target.id === "kit-a")!;
    assert.equal(v1.version, 1); assert.equal(v1.status, "champion");

    // A worse candidate is refused: it does not beat the current best.
    const r2 = await improve(workBundle({ "run.js": weakRun }));
    assert.ok(await runEval());
    const d2 = await decision(r2.m.handle);
    assert.equal(d2.outcome, "refused"); assert.match(d2.reasons.join(";"), /does not beat/);
    assert.equal((await N.listChampions(org.orgId)).find((c) => c.target.id === "kit-a" && c.status === "champion")!.version, 1, "the champion stands");
    await finish(r2.root.c, "parked");

    // Off the declared surface: refused without running anything.
    const r3 = await improve(workBundle({ "run.js": goodRun, "config/hack.txt": "x" }));
    const d3 = await decision(r3.m.handle);
    assert.equal(d3.outcome, "refused"); assert.match(d3.reasons[0]!, /outside its declared surface.*config\/hack\.txt/);
    assert.equal((await db.query("SELECT 1 FROM runs WHERE kind = 'acceptance' AND status = 'queued'")).length, 0, "no evaluation queued");
    await finish(r3.root.c, "parked");

    // The test tampered with: an upload whose bytes no longer match what was frozen is refused, and fails closed.
    await (await (await import("../src/storage.js")).objectStore()).put(`agent-profiles/uploads/${files[1]!.id}/0.part`, Buffer.from("console.log('{\"score\":100,\"safety\":1}')"), "application/octet-stream");
    const r4 = await improve(workBundle({ "run.js": goodRun }), "kit-b");
    assert.ok(await runEval());
    const d4 = await decision(r4.m.handle);
    assert.equal(d4.outcome, "refused"); assert.match(d4.reasons[0]!, /tampered/);
    await finish(r4.root.c, "parked");

    // A candidate that cannot be asked: no test means needs_review, and no candidate at all is refused.
    await P.createProgram("staff-1", { id: "no-test", name: "No test", config: { ...config, acceptance: { ...acceptance, test: undefined } } });
    const rootN = await rootWake("no test", { budget_usd: 6 });
    const mN = await N.spawnChild(rootN.ctx, { program: "no-test", inputs: { target: "kit-c" }, budget_usd: 2 });
    const cN = await claim(); const sN = await start(cN);
    await client.agent!.candidate!(cN.run.id, cN.lease_token, workBundle({ "run.js": goodRun }));
    await N.submitOutputs(sN.ctx, { outputs: {} });
    await finish(cN);
    assert.equal((await decision(mN.handle)).outcome, "needs_review");
    const noCand = await rootWake("no candidate", { budget_usd: 6 });
    const mC = await N.spawnChild(noCand.ctx, { program: "no-test", inputs: { target: "kit-d" }, budget_usd: 2 });
    const cC = await claim(); const sC = await start(cC);
    await N.submitOutputs(sC.ctx, { outputs: {} });
    await finish(cC);
    const dC = await decision(mC.handle);
    assert.equal(dC.outcome, "refused"); assert.match(dC.reasons[0]!, /no candidate/);
    await finish(rootN.c, "parked"); await finish(noCand.c, "parked");

    // A true improvement over the champion: restored bytes so the contract matches, a candidate that beats kit-a's champion.
    await (await (await import("../src/storage.js")).objectStore()).put(`agent-profiles/uploads/${files[1]!.id}/0.part`, Buffer.from(scorer), "application/octet-stream");
    const champRow = (await db.query<{ candidate: { key: string } }>("SELECT candidate FROM harness_champions WHERE target_id = 'kit-a' AND status = 'champion'"))[0]!;
    // Seed a baseline that is measurably worse so that the improvement is real; the guardian measures both.
    assert.ok(champRow.candidate.key, "the champion keeps its candidate");
    const { objectStore } = await import("../src/storage.js");
    const { sealBytes } = await import("../src/orgcrypto.js");
    const weakBundle = workBundle({ "run.js": weakRun });
    await (await objectStore()).put(champRow.candidate.key, await sealBytes(org.orgId, weakBundle, `harness-candidate:${champRow.candidate.key}`), "application/octet-stream");
    await db.query("UPDATE harness_champions SET candidate = jsonb_set(candidate, '{sha256}', to_jsonb($1::text)) WHERE target_id = 'kit-a' AND status = 'champion'", [sha(weakBundle)]);
    const r5 = await improve(workBundle({ "run.js": goodRun }));
    assert.ok(await runEval());
    const d5 = await decision(r5.m.handle);
    assert.equal(d5.outcome, "accepted", `reasons: ${d5.reasons}`);
    const v2 = (await N.listChampions(org.orgId)).find((c) => c.target.id === "kit-a" && c.status === "champion")!;
    assert.equal(v2.version, 2);
    const col5 = (await N.collect(r5.root.ctx, { handles: [r5.m.handle] })).children[0]!;
    assert.equal((col5.outputs as { decision: string; version: number }).decision, "accepted");
    assert.equal((col5.outputs as { version: number }).version, 2);
    // The agent cannot move any of this: no tool writes a decision, a champion or a version.
    const c5 = await connect(r5.root.org);
    const tools5 = (await c5.client.listTools()).tools.map((t) => t.name);
    assert.ok(!tools5.some((t) => /accept|promote|champion|evaluation/.test(t)), "no tool can self-approve");
    await c5.close();
    await finish(r5.root.c, "parked");

    // Rollback: a person's, with a reason; the previous version is the champion again, and this one is kept, marked.
    await assert.rejects(N.rollbackChampion("op", v1.id, { reason: "x" }), /current champion/);
    await assert.rejects(N.rollbackChampion("op", v2.id, {}), /reason/);
    const rolled = await N.rollbackChampion("op", v2.id, { reason: "regressed in the field" });
    assert.equal(rolled.status, "rolled_back"); assert.equal(rolled.rollback_reason, "regressed in the field");
    const now = await N.listChampions(org.orgId, { target: "kit-a" });
    assert.equal(now.find((c) => c.version === 1)!.status, "champion");
    assert.equal(now.find((c) => c.version === 2)!.status, "rolled_back");
    // Applying is a person's, and a mold ref or policy applies nothing by itself.
    await assert.rejects(N.applyChampion("op", v2.id, {}), /current champion/);
    await assert.rejects(N.applyChampion("op", v1.id, {}), /recipes are not on/i);
    // A mold ref or a policy: this shell applies nothing itself; a person says what they did, and it is kept.
    await db.query("INSERT INTO harness_champions (id, org_id, target_kind, target_id, version, status, candidate, created_by) VALUES ('hcv_moldref01', $1, 'mold_ref', 'main-mold', 1, 'champion', '{}', 'the guardian')", [org.orgId]);
    await assert.rejects(N.applyChampion("op", "hcv_moldref01", {}), /say what was applied/);
    const applied = await N.applyChampion("op", "hcv_moldref01", { ref: "reviewed and merged by hand" });
    assert.equal(applied.applied_by, "op"); assert.equal(applied.applied_ref, "reviewed and merged by hand");
    await assert.rejects(N.applyChampion("op", "hcv_moldref01", { ref: "again" }), /already applied/);
    // Recipes on: applying is a proposal staff accept, never a new version by itself.
    F.setAdminRecordsForTest(["recipes"]);
    F.setFeaturesForTest({ agent_harness: true, nested_runs: true, workspace_recipes: true });
    const R = await import("../src/recipes.js");
    await R.createRecipe("staff-1", { id: "kit-a", name: "Kit A" });
    await assert.rejects(N.applyChampion("op", v1.id, {}), /no version yet/, "a recipe with no version has nothing to propose against");
    const firstFile = await storeUploadBytes("staff-1", Buffer.from("first"));
    await R.saveRecipeVersion("staff-1", "kit-a", { version: 0, files: [{ id: firstFile.id, path: "run.js", executable: false }] });
    const before = (await R.readRecipe("kit-a")).version;
    const toRecipe = await N.applyChampion("op", v1.id, {});
    assert.match(toRecipe.applied_ref!, /^recipe proposal rpp_/);
    const after = await R.readRecipe("kit-a");
    assert.equal(after.version, before, "the recipe has no new version until staff accept it");
    assert.equal(after.proposals.filter((p) => p.status === "pending").length, 1);
    F.setAdminRecordsForTest(null);
    F.setFeaturesForTest({ agent_harness: true, nested_runs: true });
    ok("machines and acceptance: measured in a clean run against a held-out split; no best or no test goes to a person; worse, off-surface and tampered refused; beats the champion promotes; rollback; never self-approved");
  }

  // ---------- 12. staff and packs ----------
  {
    const p = await P.readProgram("discover");
    assert.equal(p.version, 1);
    await assert.rejects(P.updateProgram("staff-2", "discover", { version: 99, config: { prompt: "x" } }), /changed meanwhile/);
    const next = await P.updateProgram("staff-2", "discover", { version: 1, name: "Discover", config: { prompt: "Find {area}", inputs: p.config.inputs, outputs: p.config.outputs, budget_usd: 2, spawned_by: ["default"], failure_policy: "continue" }, note: "narrower" });
    assert.equal(next.version, 2); assert.equal(next.versions.length, 2); assert.equal(next.spawned_by[0], "default");
    assert.equal((await P.readProgramVersion("discover", 1)).config.budget_usd, 1, "an old version is kept as it was");
    await assert.rejects(P.createProgram("staff-1", { id: "discover", name: "again", config: { prompt: "x" } }), /already exists/);
    await assert.rejects(P.createProgram("staff-1", { name: "Bad", config: { prompt: "x", outputs: { nonsense: true } } }), /not supported/);
    await P.setProgramArchived("staff-1", "discover", true);
    await assert.rejects(P.programForSpawn("discover", "default"), /archived/);
    await P.setProgramArchived("staff-1", "discover", false);
    // spawned_by narrows who may use it.
    await assert.rejects(P.programForSpawn("discover", "other-profile"), /may not spawn/);
    // A pack's declared program: JSON, checked by the manifest, brought in once, not stamping on staff's edits.
    const { compileDeclarations } = await import("../src/pack-manifest.js");
    const declared = compileDeclarations({ id: "test_pack", name: "t", version: "1.0.0", programs: [{ id: "declared-one", name: "Declared", config: { prompt: "do", spawned_by: ["*"] } }] });
    assert.equal(declared.programs?.[0]?.id, "declared-one");
    assert.throws(() => compileDeclarations({ id: "test_pack", name: "t", version: "1.0.0", programs: [{ id: "Bad Id", name: "x", config: {} }] }));
    ok("programs: versions, a save against an old version refused, archived and narrowed spawn, a pack's declaration");
  }

  // ---------- 13. through the doors: the customer MCP's own endpoint, and the gateway with a provider behind it ----------
  {
    process.env.PUBLIC_URL = http.base;
    const kv = await import("../src/keyvault.js");
    const seen: { max_tokens?: number }[] = [];
    const { createServer } = await import("node:http");
    const upstream = createServer((req, res) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => { seen.push(JSON.parse(Buffer.concat(c).toString())); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [], usage: { input_tokens: 3, output_tokens: 2 } })); }); });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    await kv.upsertProvider({ slug: "anthropic", mode: "gateway", enabled: true, upstream_url: `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}`, auth_header: "x-api-key", auth_prefix: "", env_vars: ["ANTHROPIC_API_KEY"] });
    await kv.setCredential("anthropic", "sk-fixture-real-key");
    const root = await rootWake("through the doors", { budget_usd: 4 });
    // The tool, over the real endpoint, with the session's own token: a person's or a stranger's token cannot.
    const mcp = async (token: string, name: string, args: unknown) => { const r = await fetch(`${http.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }); const t = await r.text(); return { status: r.status, body: (t.trim().startsWith("{") ? JSON.parse(t) : JSON.parse(t.split("\n").find((l) => l.startsWith("data:"))!.slice(5))) as { result?: { isError?: boolean; structuredContent?: { handle?: string } } } }; };
    const got = await mcp(root.w.workspace!.token, "spawn", { prompt: "from the tool", budget_usd: 0.5 });
    assert.ok(!got.body.result?.isError && got.body.result?.structuredContent?.handle, `spawn over /mcp: ${JSON.stringify(got.body).slice(0, 300)}`);
    assert.equal((await mcp("hst_not_a_token_at_all_xxxxxxxxx", "spawn", { prompt: "x", budget_usd: 0.5 })).status, 401, "a token that is nobody's");
    // The child's own gateway token, and its hold: a request asking for more than it has is lowered to fit.
    const c = await claim(); await start(c);
    const call = async (body: Record<string, unknown>) => (await fetch(`${http.base}/gw/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": c.gateway.token!, "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }], ...body }) })).status;
    assert.equal(await call({ max_tokens: 500000 }), 200);
    assert.ok(seen.at(-1)!.max_tokens! < 500000 && seen.at(-1)!.max_tokens! > 0, `the upstream saw a lowered limit (${seen.at(-1)!.max_tokens})`);
    assert.equal((await db.query("SELECT 1 FROM harness_gateway_holds WHERE run_id = $1", [c.run.id])).length, 0, "the hold is gone once its cost is recorded");
    assert.ok((await db.query<{ n: number }>("SELECT coalesce(sum(requests),0)::int AS n FROM gateway_usage WHERE run_id = $1", [c.run.id]))[0]!.n >= 1, "metered");
    // At its carved budget: refused at the gateway.
    await db.query("UPDATE runs SET budget_usd = 0.000001 WHERE id = $1", [c.run.id]);
    assert.equal(await call({ max_tokens: 1000 }), 429, "over its carved budget, the gateway refuses it");
    await finish(c);
    await finish(root.c, "parked");
    upstream.close();
    ok("through the doors: spawn over the customer MCP endpoint with the session's token; a carved budget lowered and enforced at the gateway");
  }

  console.log("\nnested-runs: all checks passed");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  cleanup();
}
process.exit(process.exitCode ?? 0);

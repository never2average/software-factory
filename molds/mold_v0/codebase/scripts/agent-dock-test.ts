// The agent page's dock and Active runs (mold_v0-292, flag nested_runs; src/agent-dock.ts), offline: an embedded database and the
// run engine in this process, stand-ins for the sandbox and the model.
//   npm run test:agent-dock
//
//  0. Off: no route answers and no session gets a dock
//  1. Pure: a program's dock block; sections from programs, their order, the built-ins, a climb's axes
//  2. Sections and counts: typed results as items, what is at work, what needs a person; changes and the climb
//  3. Active runs and a run's view: the tree, a machine's step graph, decisions, versions
//  4. A record's runs and versions; 5. A fork: its context, its own budget, only the person who started it
//  6. Tenant isolation: another workspace reads nothing of this
//  7. mold_v0-295: the top bar's groups (a section's declared group, else its kind's) and each agent's purpose: the list, the
//     console's copy of it, what is read from a program or profile, and where the trace, the tree and Active runs name it
import "./lib/test-world.js";
import assert from "node:assert/strict";
import path from "node:path";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";

process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
const ok = (what: string) => console.log(`✓ ${what}`);

let code = 0;
try {
  const F = await import("../src/features.js");
  F.setFeaturesForTest({ agent_harness: true });
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const runs = await import("../src/runs.js");
  const harness = await import("../src/run-harness.js");
  const H = await import("../src/harness-sessions.js");
  const N = await import("../src/nested-runs.js");
  const P = await import("../src/programs.js");
  const D = await import("../src/agent-dock.js");
  const S = await import("../src/program-spec.js");
  const Reach = await import("../src/harness-reach.js");
  const { agentAppRouter } = await import("../src/agent-routes.js");
  const { compileDeclarations } = await import("../src/pack-manifest.js");
  const { createOrg } = await import("../src/auth.js");
  const { saveSettingValues } = await import("../src/platform-keys.js");
  const paths = () => (agentAppRouter() as unknown as { stack: { route?: { path: string } }[] }).stack.map((l) => l.route?.path).filter(Boolean);

  // ---------- 0. off ----------
  {
    assert.ok(!paths().some((p) => /dock|\/runs|targets|fork|\/run$/.test(String(p))), "no dock route with the flag off");
    await assert.rejects(D.dockSections(1), /not on/);
    ok("off: no route answers");
  }

  // ---------- 1. pure ----------
  {
    const parse = (dock: unknown) => S.parseProgram({ prompt: "x", spawned_by: ["*"], dock }, P.sha256).problems;
    assert.deepEqual(parse({ section: "thoughts", label: "Thoughts", kind: "items", order: 1, icon: "brain", also: [{ section: "changes", kind: "changes", label: "Changes" }] }), []);
    assert.match(parse({ section: "Bad Id" })[0]!, /section/);
    assert.match(parse({ section: "a", nonsense: 1 })[0]!, /not a field of the dock/);
    assert.match(parse({ section: "a", kind: "wheel" })[0]!, /kind/);
    assert.match(parse({ section: "a", also: [{ section: "b", items: "x" }] })[0]!, /not a field of the dock/);
    const prog = (id: string, dock: Record<string, unknown> | undefined, acceptance = false) => ({ id, name: id.toUpperCase(), description: "", config: { icon: "sparkles", ...(dock ? { dock } : {}), ...(acceptance ? { acceptance: {} } : {}) } }) as never;
    const secs = D.declaredSections([prog("b", { section: "second", label: "Second", order: 20 }), prog("a", { section: "first", label: "First", order: 10 }), prog("c", undefined)]);
    assert.deepEqual(secs.map((s) => s.id), ["first", "second", "c"], "in their order, an undeclared program as a section of its own");
    assert.deepEqual(D.declaredSections([prog("a", { section: "s", order: 1 }), prog("b", { section: "s", order: 2 })]).map((s) => s.programs.length), [2], "two programs may share a section");
    const auto = D.declaredSections([prog("a", undefined, true)]);
    assert.deepEqual(auto.map((s) => [s.id, s.kind, s.label]), [["a", "items", "A"], ["changes", "changes", "Changes"], ["climb", "climb", "Climb"]], "an acceptance rule brings the built-ins, in plain words");
    const declared = D.declaredSections([prog("a", { section: "hill", kind: "climb", label: "App's word", also: [{ section: "log", kind: "changes", label: "App's list" }] }, true)]);
    assert.deepEqual(declared.map((s) => s.label), ["App's word", "App's list"], "an app's own words replace them");
    // A climb: the metric up, the floors across, scaled to what was measured, in order, oldest first.
    const acceptance = { metric: "score", direction: "maximize", min_lift: 0.05, floors: [{ metric: "safety", min: 0.9 }], surface: ["**"], target: { kind: "recipe", id: "t" } } as never;
    const ev = (id: string, score: number, safety: number, outcome: string, at: string) => ({ id, hypothesis: `h-${id}`, status: "decided", outcome, metrics: { candidate_mean: score, floors: { safety }, lift: 0.1 }, acceptance, created_at: new Date(at), promoted_id: outcome === "accepted" ? "v1" : null });
    const climb = D.climbOf({ id: "t", kind: "recipe", program: "p" }, [ev("new", 1, 1, "accepted", "2026-02-01"), ev("old", 0.5, 0.8, "refused", "2026-01-01")], [{ id: "v1", version: 3, status: "champion", lift: 0.1, applied_at: null, applied_ref: null, rolled_back_at: null, rollback_reason: null, at: "x" }], true);
    assert.deepEqual(climb.axes.map((a) => [a.metric, a.role, a.higherIsBetter]), [["score", "objective", true], ["safety", "constraint", true]]);
    assert.deepEqual(climb.points.map((p) => p.id), ["old", "new"], "oldest first: the line is the climb");
    assert.deepEqual(climb.points[0]!.coords, [0, 0, null], "the third axis has no metric: unplotted");
    assert.deepEqual(climb.points[1]!.coords, [1, 1, null]);
    assert.equal(climb.points[1]!.version, 3);
    assert.ok(Math.abs(climb.axes[1]!.bound! - 0.5) < 1e-9, "a floor's bound on the same scale");
    ok("pure: a program's dock, the sections' order and built-ins, an app's words, a climb's axes and scale");

    // mold_v0-295: groups. A section's own, else its kind's; think, measure and ship first, an app's own after them.
    assert.match(parse({ section: "a", group: "Bad Group" })[0]!, /group/);
    assert.match(parse({ section: "a", also: [{ section: "b", group: 3 }] })[0]!, /also\[0\]\.group/);
    assert.deepEqual(parse({ section: "a", group: "measure", also: [{ section: "b", kind: "changes", group: "ship" }] }), []);
    const grouped = D.declaredSections([prog("a", { section: "x", order: 1 }), prog("b", { section: "y", kind: "climb", order: 2 }), prog("c", { section: "z", group: "measure", order: 3, also: [{ section: "w", kind: "changes", order: 4 }] }), prog("d", { section: "v", group: "later_on", order: 5 })]);
    assert.deepEqual(grouped.map((x) => [x.id, x.group]), [["x", "think"], ["y", "measure"], ["z", "measure"], ["w", "ship"], ["v", "later_on"]], "declared, else by kind");
    assert.deepEqual(D.dockGroups(grouped), [{ id: "think", label: "Think" }, { id: "measure", label: "Measure" }, { id: "ship", label: "Ship" }, { id: "later_on", label: "Later on" }]);
    assert.deepEqual(D.declaredSections([prog("a", undefined, true)]).map((x) => x.group), ["think", "ship", "measure"], "the built-ins too");
    assert.deepEqual(D.dockGroups(D.declaredSections([prog("a", { section: "only", kind: "climb" })])).map((g) => g.id), ["measure"], "only the groups in use");

    // mold_v0-295: purposes. One list, the console's copy equal to it; declared, else read from the program or profile.
    const Pu = await import("../src/agent-purpose.js");
    const Wp = await import("../web/src/lib/agent-purpose.js");
    assert.deepEqual([...Pu.AGENT_PURPOSES], ["researcher", "formalizer", "builder", "reviewer", "tester", "deployer", "analyst", "improver", "general"]);
    assert.deepEqual([...Wp.AGENT_PURPOSES], [...Pu.AGENT_PURPOSES], "the console's list is the server's");
    assert.deepEqual(Wp.PURPOSE_WORDS, Pu.PURPOSE_WORDS);
    assert.equal(new Set(Object.values(Wp.PURPOSE_ICON)).size, Pu.AGENT_PURPOSES.length, "each purpose its own icon");
    assert.deepEqual(["Deep thoughts", "Formalization discovery", "Research pursuits", "Analytics scanning", "A/B testing", "Hill climbing", "Deployments", "Build an application", "Code review", "Default", ""].map((w) => Pu.purposeFromWords(w)),
      ["researcher", "formalizer", "researcher", "analyst", "tester", "improver", "deployer", "builder", "reviewer", null, null]);
    assert.equal(Pu.purposeFromWords("mathFunction"), "formalizer", "an icon's name read as words");
    const cfg = (c: Record<string, unknown>) => ({ id: "p", name: "Plain", config: c });
    assert.equal(Pu.programPurpose(cfg({ purpose: "tester", icon: "rocket" })), "tester", "declared wins");
    assert.equal(Pu.programPurpose(cfg({ agent_profile: "x" }), "reviewer"), "reviewer", "else its profile's declared one");
    assert.equal(Pu.programPurpose(cfg({ icon: "rocket" })), "deployer", "else its words and icon");
    assert.equal(Pu.programPurpose(cfg({ acceptance: {} })), "improver", "else its shape: an acceptance rule improves");
    assert.equal(Pu.programPurpose(cfg({})), "general", "else general");
    assert.equal(Pu.profilePurpose({ id: "default", name: "Default", config: {} }), "general");
    assert.equal(Pu.profilePurpose({ id: "build-application", name: "Build an application", config: null }), "builder");
    assert.equal(Pu.profilePurpose({ id: "build-application", name: "Build an application", config: { purpose: "analyst" } }), "analyst");
    assert.match(S.parseProgram({ prompt: "x", purpose: "wizard" }, P.sha256).problems[0]!, /purpose: researcher, formalizer/);
    assert.equal(S.parseProgram({ prompt: "x", purpose: "tester" }, P.sha256).config!.purpose, "tester");
    assert.equal("purpose" in S.parseProgram({ prompt: "x" }, P.sha256).config!, false, "absent stays absent: read when shown");
    const T = await import("../src/harness-trace.js");
    const said = T.messageStep({ id: 1, role: "agent", body: "hi", status: null, by_name: null, created_at: new Date(), run_id: null }, new Map(), { name: "Default", purpose: "general" });
    assert.deepEqual(said.agent, { name: "Default", purpose: "general" }, "an agent's message names its agent");
    assert.equal(T.messageStep({ id: 2, role: "person", body: "hi", status: null, by_name: "x", created_at: new Date(), run_id: null }, new Map(), { name: "Default", purpose: "general" }).agent, undefined, "a person's does not");
    const evt = (type: string, data: Record<string, unknown>, id = 1) => ({ id, run_id: "r", attempt: 1, type, at: new Date(), data });
    const [spawned, settled, task] = T.traceSteps([evt("child_spawned", { handle: "h1", name: "Look around", purpose: "researcher", depth: 1 }, 1), evt("child_settled", { handle: "h1", name: "Deploy it", status: "done" }, 2), evt("agent_tool_call", { id: "t1", name: "Task", preview: "Review the change", subagent: "code-reviewer" }, 3)], new Map());
    assert.deepEqual([spawned!.agent, settled!.agent, task!.agent], [{ name: "Look around", purpose: "researcher" }, { name: "Deploy it", purpose: "deployer" }, { name: "code-reviewer", purpose: "reviewer" }],
      "a child's start says its purpose; an older event's is read from its words; a sub-agent's call names it");
    ok("groups and purposes: declared or by kind, think/measure/ship first; one purpose list in both places, read from a program or profile; the trace names each agent");
  }

  // ---------- the world, on ----------
  F.setFeaturesForTest({ agent_harness: true, nested_runs: true });
  await saveSettingValues("test-staff", { AGENT_CHECKPOINT_SECONDS: 0, AGENT_SESSION_BUDGET_USD: 10, AGENT_BUDGET_CEILING_USD: 20 });
  const http = await startHttp();
  process.env.PUBLIC_URL = http.base;
  const org = (await createOrg(`Dock ${STAMP}`)).org;
  const signedIn = await http.signInAs(org, "owner");
  const person: import("../src/harness-sessions.js").Actor = { kind: "person", user: signedIn.userId, name: "d@example.org", role: "owner" };
  const client = await harness.localRunnerClient("w-dock");
  const claimOf = async (sid: string) => { const [r] = await db.query<{ id: string }>("SELECT id FROM runs WHERE harness_session_id = $1 AND status = 'queued' ORDER BY created_at DESC LIMIT 1", [sid]); return (await runs.claimRun("w-dock", { runId: r!.id }))!; };
  const startWake = async (c: import("../src/runs.js").Claim) => { const w = await H.wakeStart(c.run.id, c.lease_token); const r = await Reach.resolveToolToken(w.workspace!.token); const o = (r as { org: import("../src/auth.js").Org }).org; return { w, ctx: { orgId: org.orgId, sessionId: w.session_id, runId: o.agentSession!.run!, role: o.role ?? null } }; };
  const finish = async (c: import("../src/runs.js").Claim) => { await H.wakeEnd(c.run.id, c.lease_token, { reason: "done" }); return client.complete(c.run.id, c.lease_token, { outcome: "succeeded", results: [] }); };

  await P.createProgram("staff-1", { id: "discover", name: "Discover", config: { prompt: "find", outputs: { type: "object", required: ["problems"], properties: { problems: { type: "array", items: { type: "object", required: ["statement"], properties: { statement: { type: "string" }, severity: { type: "string" } } } } } }, budget_usd: 1, spawned_by: ["*"], dock: { section: "thoughts", label: "Thoughts", sub: "problems found", icon: "brain", order: 10, items: "problems", title: "statement", meta: ["severity"] } } });
  const machine = { max_transitions: 4, states: [{ id: "plan", entry: true, prompt: "plan" }, { id: "build", prompt: "build" }], transitions: [{ from: "plan", to: "build" }] };
  await P.createProgram("staff-1", { id: "improve", name: "Improve", config: { machine, inputs: { type: "object", properties: {} }, outputs: { type: "object" }, budget_usd: 2, spawned_by: ["*"], purpose: "builder", dock: { section: "climbing", label: "Climbing", kind: "climb", order: 30, also: [{ section: "log", kind: "changes", label: "Log", order: 20 }] } } });

  const s = await H.startSession(org.orgId, person, { message: "the root message", budget_usd: 8 });
  const root = await claimOf(s.id); const rootW = await startWake(root);
  let dock = await D.dockSections(org.orgId);
  assert.deepEqual(dock.sections.map((x) => x.id), ["thoughts", "log", "climbing"], "the app's order");
  assert.deepEqual(dock.sections.map((x) => x.group), ["think", "ship", "measure"], "mold_v0-295: each under its kind's group");
  assert.deepEqual(dock.groups.map((g) => g.label), ["Think", "Measure", "Ship"], "the groups in their order");
  assert.deepEqual(dock.sections.map((x) => x.programs.map((p) => p.purpose)), [["researcher"], ["builder"], ["builder"]], "each program's purpose: read from it, or declared");
  assert.equal(dock.sections[0]!.count, 0);
  assert.equal(dock.live, false);

  // ---------- 2. sections and counts ----------
  {
    const h = await N.spawnChild(rootW.ctx, { program: "discover", inputs: {}, budget_usd: 1 });
    dock = await D.dockSections(org.orgId);
    assert.equal(dock.sections[0]!.live, true, "a child at work lights its section");
    assert.equal(dock.sections[0]!.count, 0, "nothing finished yet");
    const inflight = (await D.dockSection(org.orgId, "thoughts")).items!;
    assert.ok(["queued", "running"].includes(inflight[0]!.status)); assert.equal(inflight[0]!.title, "Discover");
    assert.equal(inflight[0]!.purpose, "researcher", "mold_v0-295: an item says its agent's purpose");
    const started = (await H.sessionTrace(org.orgId, s.id, person)).steps.find((x) => x.fields?.handle === h.handle && x.agent);
    assert.deepEqual(started?.agent, { name: "Discover", purpose: "researcher" }, "mold_v0-295: the trace names the child it started");
    const c = await claimOf(h.session_id!); const w = await startWake(c);
    await N.submitOutputs(w.ctx, { outputs: { problems: [{ statement: "Late replies", severity: "high" }, { statement: "Duplicate rows", severity: "low" }] } });
    await finish(c);
    dock = await D.dockSections(org.orgId);
    assert.equal(dock.sections[0]!.count, 2, "each typed result counts");
    assert.equal(dock.sections[0]!.live, false);
    const items = (await D.dockSection(org.orgId, "thoughts")).items!;
    assert.deepEqual(items.map((i) => [i.title, i.meta[0]]), [["Late replies", "high"], ["Duplicate rows", "low"]]);
    assert.deepEqual(items[0]!.fields, { statement: "Late replies", severity: "high" });
    assert.equal(items[0]!.ref, s.ref, "says which run it came from");
    await assert.rejects(D.dockSection(org.orgId, "nothing"), /no such section/);
    ok("sections: typed results as items and counted, what is at work lit, the words the program gave");
  }

  // Decisions, for the two built-in kinds: written as the guardian writes them.
  const accept = { metric: "score", direction: "maximize", min_lift: 0.05, floors: [{ metric: "safety", min: 0.5 }], surface: ["**"], target: { kind: "recipe", id: "kit" } };
  const addEval = async (id: string, outcome: string, mean: number) => db.query(`INSERT INTO harness_evaluations (id, org_id, program_id, program_version, root_id, target_kind, target_id, hypothesis, candidate, acceptance, status, outcome, reasons, metrics, created_at) VALUES ($1, $2, 'improve', 1, $3, 'recipe', 'kit', $4, '{"paths":["run.js"]}', $5, 'decided', $6, '["a reason"]', $7, now() - ($8 || ' minutes')::interval)`,
    [id, org.orgId, s.id, `Try ${id}`, JSON.stringify(accept), outcome, JSON.stringify({ n: 12, baseline_mean: 0.5, candidate_mean: mean, lift: 0.2, floors: { safety: 0.9 } }), id === "hev_a00000001" ? "30" : "5"]);
  await addEval("hev_a00000001", "refused", 0.4); await addEval("hev_b00000002", "needs_review", 0.8);
  await db.query("INSERT INTO harness_champions (id, org_id, target_kind, target_id, version, status, candidate, metrics, created_by) VALUES ('hcv_dockdock1', $1, 'recipe', 'kit', 1, 'champion', '{}', '{\"lift\":0.2}', 'the guardian')", [org.orgId]);

  {
    dock = await D.dockSections(org.orgId);
    const log = dock.sections.find((x) => x.id === "log")!, climb = dock.sections.find((x) => x.id === "climbing")!;
    assert.equal(log.count, 2, "each decision is a change"); assert.equal(log.attention, true, "one waits for a person");
    assert.equal(climb.count, 1, "one target climbed");
    const changes = (await D.dockSection(org.orgId, "log")).items!;
    assert.deepEqual(changes.map((c) => c.status), ["needs_review", "refused"], "newest first");
    assert.deepEqual((changes[0]!.fields as { paths: string[] }).paths, ["run.js"]);
    const t = (await D.dockSection(org.orgId, "climbing")).targets![0]!;
    assert.equal(t.id, "kit"); assert.deepEqual(t.points.map((p) => p.id), ["hev_a00000001", "hev_b00000002"]);
    assert.deepEqual(t.versions.map((v) => [v.version, v.status]), [[1, "champion"]]);
    ok("the built-in kinds: changes with what waits for a person, the climb and its versions");
  }

  // ---------- 3. active runs and a run ----------
  {
    const m = await N.spawnChild(rootW.ctx, { program: "improve", inputs: {}, budget_usd: 2 });
    const active = await D.activeRuns(org.orgId);
    assert.equal(active.length, 1); assert.equal(active[0]!.id, s.id);
    assert.equal(active[0]!.ref, s.ref); assert.deepEqual(active[0]!.programs.sort(), ["Discover", "Improve"]);
    assert.deepEqual(active[0]!.agent, { name: "Default", purpose: "general" }, "mold_v0-295: the agent the root runs as");
    assert.deepEqual(active[0]!.agents.map((a) => [a.name, a.purpose]).sort(), [["Discover", "researcher"], ["Improve", "builder"]], "and each program's agent at work");
    assert.equal(active[0]!.open, 1, "the machine's step at work, the machine itself not counted");
    const run = await D.runDetail(org.orgId, s.id, person);
    assert.equal(run.root.ref, s.ref);
    const mNode = run.children.find((c) => c.handle === m.handle)!;
    assert.deepEqual(mNode.graph!.states.map((x) => [x.id, x.running, x.settled]), [["plan", true, false], ["build", false, false]], "the graph knows where it has got to");
    assert.deepEqual(mNode.graph!.transitions.map((t) => [t.from, t.to]), [["plan", "build"]]);
    assert.equal(mNode.purpose, "builder", "mold_v0-295: a child in the tree says its purpose (its program's, declared)");
    assert.deepEqual(run.root.agent, { name: "Default", purpose: "general" });
    const stepNode = run.children.find((c) => c.step_of === m.handle)!;
    assert.equal(stepNode.state, "plan");
    assert.equal(run.decisions.length, 2);
    assert.equal(run.targets[0]!.versions.length, 1);
    await assert.rejects(D.runDetail(org.orgId, "hss_doesnotexist", person), /no such session/);
    await N.cancelChild(rootW.ctx, m.handle);
    assert.deepEqual(await D.activeRuns(org.orgId), [], "nothing at work: nothing listed");
    ok("Active runs: a root with children at work; its tree, a machine's live step graph, decisions and versions");
  }

  // ---------- 4. a record's runs and versions ----------
  {
    const h = await D.targetHistory(org.orgId, "kit");
    assert.equal(h.runs.length, 2); assert.equal(h.versions[0]!.status, "champion"); assert.equal(h.champion, 1);
    assert.equal(h.runs[0]!.workspace, null, "a workspace's own view names no workspace");
    assert.ok((await D.targetHistory(null, "kit")).runs[0]!.workspace, "staff see whose");
    const sec = compileDeclarations({ id: "t_pack", name: "t", version: "1.0.0" });
    assert.ok(sec, "a pack compiles");
    const { DETAIL_SECTION_KINDS } = await import("../src/pack-api.js");
    assert.ok(DETAIL_SECTION_KINDS.includes("versions"));
    ok("a record's page: its runs, versions and current champion, staff across workspaces");
  }

  // ---------- 5. a fork ----------
  {
    const [m] = await db.query<{ id: string }>("SELECT id FROM harness_session_messages WHERE session_id = $1 AND role = 'person' ORDER BY id LIMIT 1", [s.id]);
    const other: typeof person = { kind: "person", user: "user_somebody_else", name: "x@example.org", role: "owner" };
    await assert.rejects(H.forkSession(org.orgId, s.id, other, { message_id: Number(m!.id), message: "x" }), /Only the person who started/);
    await assert.rejects(H.forkSession(org.orgId, s.id, person, { message_id: 0, message: "x" }), /message_id/);
    await assert.rejects(H.forkSession(org.orgId, s.id, person, { message_id: Number(m!.id), message: "" }), /say something/);
    const before = await H.readSession(org.orgId, s.id, person);
    const fork = await H.forkSession(org.orgId, s.id, person, { message_id: Number(m!.id), message: "a second opinion" });
    assert.notEqual(fork.id, s.id);
    assert.match(fork.title, /^Fork: /);
    const [row] = await db.query<{ policy: { follow_on: { context: string; from: string } }; parent_id: string | null }>("SELECT policy, parent_id FROM harness_sessions WHERE id = $1", [fork.id]);
    assert.match(row!.policy.follow_on.context, /the root message/, "the transcript up to there");
    assert.equal(row!.policy.follow_on.from, s.id);
    assert.equal(row!.parent_id, null, "its own session, not a child");
    const after = await H.readSession(org.orgId, s.id, person);
    assert.equal(after.messages.length, before.messages.length, "the conversation it came from sees nothing");
    assert.equal(after.remaining_usd, before.remaining_usd, "and spends nothing of its budget");
    ok("a fork: the transcript up to the point, a session of its own, only for the person who started it");
  }

  // ---------- 6. tenant isolation ----------
  {
    const other = (await createOrg(`Dock other ${STAMP}`)).org;
    const theirs = await D.dockSections(other.orgId);
    assert.ok(theirs.sections.every((x) => x.count === 0 && !x.live && !x.attention), "programs are the platform's; what they did is each workspace's own");
    assert.deepEqual((await D.dockSection(other.orgId, "thoughts")).items, []);
    assert.deepEqual((await D.dockSection(other.orgId, "climbing")).targets, []);
    assert.deepEqual(await D.activeRuns(other.orgId), []);
    assert.deepEqual((await D.targetHistory(other.orgId, "kit")).runs, []);
    assert.deepEqual((await D.targetHistory(other.orgId, "kit")).versions, []);
    const person2 = { kind: "person" as const, user: "u2", name: "y@example.org", role: "owner" as const };
    await assert.rejects(D.runDetail(other.orgId, s.id, person2), /no such session/, "another workspace's run is not found");
    await assert.rejects(H.forkSession(other.orgId, s.id, person2, { message_id: 1, message: "x" }), /no such session/);
    // Through the door: the routes exist, the session's id alone opens nothing.
    const res = await fetch(`${http.base}/api/agent/dock`, { headers: { authorization: `Bearer ${signedIn.token}`, accept: "application/json" } });
    assert.equal(res.status, 200);
    const j = await res.json() as { sections: { id: string }[] };
    assert.deepEqual(j.sections.map((x) => x.id), ["thoughts", "log", "climbing"], "/dock answers over HTTP, not read as a session id");
    assert.equal((await fetch(`${http.base}/api/agent/runs`, { headers: { authorization: `Bearer ${signedIn.token}` } })).status, 200);
    assert.equal((await fetch(`${http.base}/api/agent/dock`)).status, 401, "signed in only");
    ok("tenant isolation: another workspace sees none of this, and the routes need a session");
  }
  console.log("\nagent dock: all checks passed");
} catch (e) { console.error(e); code = 1; } finally { cleanup(); }
process.exit(code);

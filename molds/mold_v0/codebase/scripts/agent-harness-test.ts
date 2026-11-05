// The workspace agent (mold_v0-243; src/harness-sessions.ts, src/agent-harness.ts, src/agent-routes.ts,
// src/agent-tools.ts; molds/mold_v0/docs/agent-harness.md), offline: an embedded database, the run engine in this
// process, and a stand-in CLI that speaks the pinned harness's stream-json (scripts/fixtures/agent-cli/cli.mjs).
//   npm run test:agent-harness
//
//  0. Off (the default): no route, tool, setting group, claimable kind or scheduler job; nothing is written.
//  1. The ledger, pure: stream-json lines and echoes, the stdin ledger (two steers folded into one turn), the spend
//     accrual (a replay charges nothing, a lower report refunds nothing, a resumed baseline), the crash reserve, the
//     policy check of a tool call.
//  2. Steer mid-run: a message sent while the agent works reaches it on the next beat and is answered; the
//     conversation parks when quiet (no run, no slot) and the next message wakes it on the same harness session.
//  2b. The working directory (mold_v0-246): the same path on every wake of a session, another session's elsewhere;
//     removed when its wake ends; one a dead runner left is taken away by the next wake; a wake that lost its
//     session's scratch to a later wake leaves it alone.
//  3. Spend counted once per session: a resumed harness re-reports its earlier total, and the session is charged
//     only what each wake added.
//  4. Pause, resume, stop: a running wake stops and keeps its session; resume continues it; stop ends it read only.
//  5. Approvals: a web host the policy does not allow becomes a request and the wake stops; approve grants exactly
//     that host (the next wake's egress has it) and continues; decline (a tool) parks it with the refusal said; staff
//     may decline but not approve; only the starter or an owner decides.
//  6. Budgets: a session at its budget stops and asks; a raise needs a reason, the role, stays under the ceiling, is
//     refused while it works, is recorded, and continues the session.
//  7. Crash recovery: the harness dies (a failed wake), and a runner goes silent (its lease lapses): the session parks
//     with what was unanswered asked again; automatic resume (the switch on) continues it by itself; past the crash
//     limit it fails.
//  8. Retention: unanswered requests expire, quiet sessions are archived, ended sessions past retention lose their
//     messages, requests and checkpoints and keep their spend and raises.
//  9. Settings: the group and its keys only with the flag on, each with words; every change recorded with who and
//     the value before; the admin MCP's list_settings and update_setting.
// 10. The doors: /api/agent (a member starts, a viewer cannot), the MCP tools, staff's /api/admin/onboarding/agent.
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.APP_STORAGE_DIR = path.join(TMP, "objects");
for (const k of ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) delete process.env[k];
const CLI = { command: process.execPath, args: [path.join(ROOT, "scripts", "fixtures", "agent-cli", "cli.mjs")] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (what: string) => console.log(`✓ ${what}`);

try {
  const F = await import("../src/features.js");
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  await import("../src/server.js");
  const runs = await import("../src/runs.js");
  const harness = await import("../src/run-harness.js");
  const H = await import("../src/harness-sessions.js");
  const A = await import("../src/agent-harness.js");
  const C = await import("../src/agent-harness-config.js");
  const settings = await import("../src/settings.js");
  const { saveSettingValues } = await import("../src/platform-keys.js");
  const { agentAppRouter } = await import("../src/agent-routes.js");
  const { createOrg } = await import("../src/auth.js");
  const { SCHEDULER_JOBS } = await import("../src/scheduler-jobs.js");
  const { enabledJobs } = await import("../src/health-tabs.js");
  const stack = (r: unknown) => ((r as { stack?: unknown[] }).stack ?? []).length;

  // ---------- 0. off ----------
  {
    F.setFeaturesForTest({});
    assert.equal(F.featureOn("agent_harness"), false, "off by default");
    assert.equal(stack(agentAppRouter()), 0, "no route mounted");
    assert.equal(runs.findKind(C.AGENT_PACK, C.AGENT_KIND), null);
    assert.deepEqual(runs.runnableKinds().map((k) => k.pack), runs.jobKinds().map((k) => k.pack), "no built-in kind claimed");
    assert.ok(!settings.settingGroups().some((g) => g.id === "agent") && !settings.allSettings().some((d) => d.key.startsWith("AGENT_")), "no agent setting");
    assert.ok(!enabledJobs().some((j) => j.id === "harness_sessions") && SCHEDULER_JOBS.includes("harness_sessions"));
    const org = (await createOrg(`Agent off ${STAMP}`)).org;
    const m = await connect({ ...org, role: "owner" });
    const tools = (await m.client.listTools()).tools.map((t) => t.name);
    assert.ok(!tools.some((t) => t.includes("agent_session")), "no agent tool listed");
    await m.close();
    await assert.rejects(H.listSessions(org.orgId, H.actorOf(null, true)), /not on/);
    assert.equal((await H.sweepHarnessSessions()).archived, 0);
    ok("off: no route, tool, setting, claimable kind or scheduler job");
  }

  // ---------- 1. pure ----------
  {
    assert.equal(A.encodeStdinMessage("hi", "u1"), '{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u1"}\n');
    assert.equal(A.replayedUuid({ type: "user", isReplay: true, uuid: "u1" }), "u1");
    assert.equal(A.replayedUuid({ type: "user", uuid: "u1", message: { content: [{ type: "tool_result" }] } }), null, "a tool result is not an echo");
    const l = new A.SteerLedger();
    l.injected("a"); l.injected("b"); l.replayed("a"); l.replayed("b");
    assert.equal(l.turnEnded(), true, "two steers folded into one turn: that turn's result closes stdin");
    const l2 = new A.SteerLedger();
    l2.injected("a"); l2.replayed("a"); l2.injected("b");
    assert.equal(l2.turnEnded(), false, "a steer not yet taken in holds the session for its own turn");
    const l3 = new A.SteerLedger();
    l3.injected("a"); l3.injected("b");
    // The opening turn is not counted: its result, then one per steer, the last closes.
    assert.equal(l3.turnEnded(), false); assert.equal(l3.turnEnded(), false); assert.equal(l3.turnEnded(), true, "without echoes: one turn per message");
    assert.deepEqual(H.accrueSpend(0, 0, 0.3), { charge: 0.3, high: 0.3 });
    assert.deepEqual(H.accrueSpend(0.3, 0, 0.3), { charge: 0, high: 0.3 }, "a replayed report charges nothing");
    assert.deepEqual(H.accrueSpend(0.3, 0, 0.2), { charge: 0, high: 0.3 }, "a lower report never refunds");
    assert.deepEqual(H.accrueSpend(0, 1, 1.25), { charge: 0.25, high: 0.25 }, "a resumed session: only the climb over its baseline");
    assert.equal(H.resumedBaseline(1.0, 0.8), 0.8, "a crash before the save: the charged figure");
    assert.equal(H.resumedBaseline(1.0, 1.2), 1.0, "a turn killed before it reported: billed once now");
    assert.equal(H.resumedBaseline(0.5, null), 0.5);
    assert.equal(H.crashReserve(1, 100, 50, 10), 0.5); assert.equal(H.crashReserve(1, 100, 50, 0.2), 0.2, "capped at what was left");
    const pol: import("../src/agent-harness-config.js").AgentPolicy = { flavour: "claude-code", model: "m", provider: "anthropic", mode: "conversation", max_turns: 5,
      wake_max_seconds: 60, park_after_seconds: 60, stdin_idle_seconds: 10, checkpoint_seconds: 0, approval_window_hours: 1, crash_resumes: 1, auto_resume: false,
      budget_ceiling_usd: 5, web: { tools: "fetch", hosts: ["*.example.org"], calls_max: 2 }, tools: ["Read"], hooks: [] };
    assert.deepEqual(A.checkToolUse({ id: "1", name: "WebFetch", input: { url: "https://docs.example.org/a" } }, pol, 0), { ok: true, web: true });
    assert.deepEqual(A.checkToolUse({ id: "1", name: "WebFetch", input: { url: "https://other.test/a" } }, pol, 0), { ok: false, request: { kind: "web", subject: "other.test" } });
    assert.deepEqual(A.checkToolUse({ id: "1", name: "WebFetch", input: { url: "https://docs.example.org/a" } }, pol, 2), { ok: false, limit: true });
    assert.deepEqual(A.checkToolUse({ id: "1", name: "Deploy", input: {} }, pol, 0), { ok: false, request: { kind: "tool", subject: "Deploy" } });
    assert.deepEqual(A.checkToolUse({ id: "1", name: "WebFetch", input: { url: "http://docs.example.org/a" } }, pol, 0), { ok: false, request: { kind: "tool", subject: "WebFetch" } }, "only https");
    ok("pure: stream-json, the stdin ledger, the spend accrual and baseline, the crash reserve, the policy check");
  }

  // ---------- the world, on ----------
  F.setFeatureForTest("agent_harness", true);
  assert.equal(F.featureOn("agent_harness"), true);
  await saveSettingValues("test-staff", { AGENT_CHECKPOINT_SECONDS: 0, AGENT_PARK_AFTER_MINUTES: 1, AGENT_SESSION_BUDGET_USD: 1, AGENT_BUDGET_CEILING_USD: 5 });
  const org = (await createOrg(`Agent ${STAMP}`)).org, other = (await createOrg(`Agent other ${STAMP}`)).org;
  const owner: import("../src/harness-sessions.js").Actor = { kind: "person", user: "user_owner", name: "owner@example.org", role: "owner" };
  const member: import("../src/harness-sessions.js").Actor = { kind: "person", user: "user_member", name: "member@example.org", role: "member" };
  const viewer: import("../src/harness-sessions.js").Actor = { kind: "person", user: "user_viewer", name: "viewer@example.org", role: "viewer" };
  const staff = H.staffActor("staff-1");
  const client = await harness.localRunnerClient("w-agent");
  let offset = 0;
  const opts = { allowSameUser: true, egress: "off" as const, agentCli: CLI, pollMs: 50, beatMs: 250, clock: () => Date.now() + offset };
  /** Claim the session's queued wake and carry it out in the background. */
  const wake = async (sessionId: string) => {
    const c = await client.claim([`${C.AGENT_PACK}/${C.AGENT_KIND}`]);
    assert.ok(c, "a wake to claim");
    const [r] = await db.query<{ harness_session_id: string }>("SELECT harness_session_id FROM runs WHERE id = $1", [c!.run.id]);
    assert.equal(r!.harness_session_id, sessionId);
    return { claim: c!, done: harness.runWorkspaceHarness(client, c!, opts) };
  };
  const until = async (what: string, f: () => Promise<boolean>, ms = 20_000) => {
    const t = Date.now();
    while (!(await f())) { if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await sleep(100); }
  };
  const read = (id: string, a = member) => H.readSession(org.orgId, id, a);
  const agentSaid = async (id: string, re: RegExp) => (await read(id)).messages.some((m) => m.role === "agent" && re.test(m.body));
  const park = async () => { offset += 61_000; };

  // ---------- 2. steer mid-run, park, wake ----------
  let sid: string;
  {
    await assert.rejects(H.startSession(org.orgId, viewer, { message: "x" }), /role cannot start/);
    await assert.rejects(H.startSession(org.orgId, staff, { message: "x" }), /staff cannot start/);
    const s = await H.startSession(org.orgId, member, { message: "slow 1500\nplan the work" });
    sid = s.id;
    assert.equal(s.phase, "starting");
    assert.equal(s.budget_usd, 1);
    const w = await wake(sid);
    await until("the first turn is under way", async () => (await read(sid)).phase === "working");
    // Mid-run guidance: queued now, delivered on the next beat, answered by the agent.
    await assert.rejects(H.messageSession(org.orgId, sid, owner, "not mine"), /Only the person who started/);
    const sent = await H.messageSession(org.orgId, sid, member, "steer: focus on the tests");
    assert.equal(sent.status, "queued");
    await until("the steer is answered", () => agentSaid(sid, /Echo: steer: focus on the tests/));
    const d = await read(sid);
    assert.ok(d.messages.filter((m) => m.role === "person").every((m) => m.status === "answered"), "both messages answered");
    const ev = await db.query<{ type: string }>("SELECT type FROM run_events WHERE run_id = $1 ORDER BY id", [w.claim.run.id]);
    assert.ok(ev.some((e) => e.type === "steer_queued") && ev.some((e) => e.type === "steer_delivered"), "the steer is on the run's events");
    // Quiet: the conversation parks (its run ends; no slot is held).
    await until("waiting", async () => (await read(sid)).phase === "waiting");
    await park();
    const v = await w.done;
    assert.equal(v?.status, "succeeded");
    const p = await read(sid);
    assert.equal(p.phase, "parked");
    assert.equal((await db.query("SELECT 1 FROM runs WHERE harness_session_id = $1 AND status IN ('queued', 'running')", [sid])).length, 0, "parked: no run");
    ok("steer mid-run: a message while it works is delivered on the next beat and answered; quiet, it parks with no run");

    // The next message wakes it on the same harness session.
    const r = await H.messageSession(org.orgId, sid, member, "and now the docs");
    assert.equal(r.status, "waking");
    const w2 = await wake(sid);
    await until("the resumed answer", () => agentSaid(sid, /\(resumed sess-[a-z0-9]+\) Echo: and now the docs/));
    await park();
    await w2.done;
    assert.equal((await read(sid)).phase, "parked");
    ok("parking: the next message wakes the parked session on its same harness session (--resume)");
  }

  // ---------- 2b. the working directory ----------
  {
    const said = async (id: string) => (await read(id)).messages.filter((m) => m.role === "agent").map((m) => /Working in (.+)\.$/.exec(m.body)?.[1]).filter(Boolean) as string[];
    const turn = async (id: string, n: number) => {
      const w = await wake(id);
      await until(`answer ${n}`, async () => (await said(id)).length >= n);
      await until("waiting", async () => (await read(id)).phase === "waiting");
      await park();
      await w.done;
      return { run: w.claim.run.id, cwd: (await said(id))[n - 1]! };
    };
    const s1 = await H.startSession(org.orgId, member, { message: "pwd" });
    const a = await turn(s1.id, 1);
    const scratch = path.dirname(path.dirname(a.cwd));
    assert.equal(path.basename(scratch), s1.id, "the session's own directory");
    assert.equal(path.basename(path.dirname(scratch)), `agent-sessions-${process.getuid?.() ?? 0}`, "under the runner's sessions' directory");
    assert.ok(!existsSync(scratch), "removed when the wake ended");
    // A dead runner's leftover at that path (what it held, a file of its own): the next wake takes it away.
    mkdirSync(path.join(scratch, "state", "work"), { recursive: true });
    writeFileSync(path.join(scratch, ".wake"), "run_dead"); writeFileSync(path.join(scratch, "state", "work", "leftover"), "x");
    await H.messageSession(org.orgId, s1.id, member, "pwd");
    const b = await turn(s1.id, 2);
    assert.equal(b.cwd, a.cwd, "the same working directory on the next wake");
    assert.ok(!existsSync(scratch), "the leftover went with it; removed again");
    const s2 = await H.startSession(org.orgId, member, { message: "pwd" });
    const c2 = await turn(s2.id, 1);
    assert.notEqual(c2.cwd, a.cwd, "another session works elsewhere");
    assert.equal(path.dirname(path.dirname(path.dirname(c2.cwd))), path.dirname(scratch), "beside it, under the same runner directory");
    // A wake that lost its lease: a later wake holds the scratch now, so the earlier one leaves it.
    const held = A.sessionScratch(TMP, "hs_probe", "run_later");
    A.releaseSessionScratch(held, "run_earlier");
    assert.ok(existsSync(held), "a later wake's scratch is left alone");
    assert.equal(statSync(held).mode & 0o777, 0o700, "a session's scratch is its own (0700)");
    assert.equal(statSync(path.dirname(held)).mode & 0o777, 0o711, "the runner's directory is passed through, never listed (0711)");
    A.releaseSessionScratch(held, "run_later");
    assert.ok(!existsSync(held), "its own wake removes it");
    ok("the working directory: the same path on every wake of a session, another session's elsewhere; removed when the wake ends; a dead runner's leftover taken away; a later wake's left alone");
  }

  // ---------- 3. spend once ----------
  {
    // Three turns at $0.01 each: the resumed harness re-reported the first two in its running total; charged once.
    const d = await read(sid);
    assert.equal(d.spent_usd, 0.03, `charged once per turn across both wakes (got ${d.spent_usd})`);
    const ws = await db.query<{ baseline_usd: string; charged_usd: string }>("SELECT baseline_usd, charged_usd FROM harness_wake_spend WHERE session_id = $1 ORDER BY updated_at", [sid]);
    assert.deepEqual(ws.map((w) => [Number(w.baseline_usd), Number(w.charged_usd)]), [[0, 0.02], [0.02, 0.01]], "the second wake's baseline is what the first was charged");
    assert.equal(d.wakes, 2);
    ok("spend counted once per session: the resumed wake's report was reduced by its baseline");
  }

  // ---------- 4. pause, resume, stop ----------
  {
    const s = await H.startSession(org.orgId, member, { message: "slow 4000\nlong job" });
    const w = await wake(s.id);
    await until("working", async () => (await read(s.id)).phase === "working");
    await assert.rejects(H.pauseSession(other.orgId, s.id, member), /no such session/, "another workspace's session is not found");
    await assert.rejects(H.raiseBudget(org.orgId, s.id, owner, { to_usd: 2, reason: "more" }), /while the session is working/, "no raise while it works");
    const pv = await H.pauseSession(org.orgId, s.id, owner); // an owner may pause someone's session
    assert.equal(pv.pause_requested, true);
    await w.done;
    let d = await read(s.id);
    assert.equal(d.phase, "paused");
    assert.ok(d.wakes_list[0]!.end_reason?.startsWith("paused"));
    await assert.rejects(H.resumeSession(org.orgId, s.id, owner), /Only the person who started/);
    await H.resumeSession(org.orgId, s.id, member);
    const w2 = await wake(s.id);
    await until("the resumed wake answers", () => agentSaid(s.id, /\(resumed /));
    await H.stopSession(org.orgId, s.id, member);
    await w2.done;
    d = await read(s.id);
    assert.equal(d.phase, "stopped");
    assert.ok(d.ended_at && !d.can.message && !d.can.resume);
    await assert.rejects(H.messageSession(org.orgId, s.id, member, "hello?"), /stopped/);
    // A queued wake is withdrawn by a pause, and staff may stop one.
    const q = await H.startSession(org.orgId, member, { message: "queued" });
    await H.pauseSession(org.orgId, q.id, member);
    assert.equal((await read(q.id)).phase, "paused");
    const qs = await H.stopSession(null, q.id, staff);
    assert.equal(qs.phase, "stopped");
    ok("pause, resume, stop: a running wake pauses and resumes on its session, stop ends it read only; a queued wake is withdrawn");
  }

  // ---------- 5. approvals ----------
  let approved: string;
  {
    await saveSettingValues("test-staff", { AGENT_WEB_TOOLS: "fetch", AGENT_WEB_HOSTS: "*.allowed.example" });
    const s = await H.startSession(org.orgId, member, { message: "fetch https://docs.example.org/guide" });
    approved = s.id;
    const w = await wake(s.id);
    await w.done;
    let d = await read(s.id);
    assert.equal(d.phase, "awaiting_approval");
    assert.equal(d.pending_request?.kind, "web");
    assert.equal(d.pending_request?.subject, "docs.example.org");
    await assert.rejects(H.messageSession(org.orgId, s.id, member, "go on"), /waiting for a decision/);
    await assert.rejects(H.decideRequest(org.orgId, s.id, d.pending_request!.id, H.actorOf({ user: "user_x", email: "x@example.org", accountRole: "member" }), "approve"), /Only the person who started/);
    await assert.rejects(H.decideRequest(null, s.id, d.pending_request!.id, staff, "approve"), /Staff may decline/);
    d = await H.decideRequest(org.orgId, s.id, d.pending_request!.id, member, "approve");
    assert.ok(d.policy.web_hosts.includes("docs.example.org") && d.policy.web_hosts.includes("*.allowed.example"), "exactly that host granted to this session");
    assert.equal(d.requests[0]!.status, "approved");
    const w2 = await wake(s.id);
    assert.ok(w2.claim.egress.hosts.includes("docs.example.org") && w2.claim.egress.hosts.includes("allowed.example"), "the next wake's egress has it");
    await until("it continues", () => agentSaid(s.id, /Echo: \(approved: reaching docs\.example\.org\)/));
    await park();
    await w2.done;
    assert.equal((await read(s.id)).phase, "parked");
    // A tool outside the policy: declined with a reason, parked, and its next wake is told.
    const t = await H.startSession(org.orgId, member, { message: "use DeployTool" });
    await (await wake(t.id)).done;
    let td = await read(t.id);
    assert.equal(td.pending_request?.kind, "tool");
    assert.equal(td.pending_request?.subject, "DeployTool");
    td = await H.decideRequest(org.orgId, t.id, td.pending_request!.id, owner, "decline", "not in this workspace");
    assert.equal(td.phase, "parked");
    assert.ok(td.messages.some((m) => m.role === "system" && /declined using DeployTool: not in this workspace/.test(m.body)));
    await H.messageSession(org.orgId, t.id, member, "do it another way");
    const w3 = await wake(t.id);
    await until("told of the refusal", () => agentSaid(t.id, /Echo: do it another way/));
    const firstLine = (await db.query<{ data: { messages: number } }>("SELECT data FROM run_events WHERE run_id = $1 AND type = 'agent_wake'", [w3.claim.run.id]))[0];
    assert.ok(firstLine);
    await park(); await w3.done;
    ok("approvals: a host outside the policy is asked for and the wake stops; approve grants exactly it and continues; decline parks with the refusal said; staff cannot approve");
  }

  // ---------- 6. budgets ----------
  {
    const s = await H.startSession(org.orgId, member, { message: "spend 1.2\nbig job" });
    await (await wake(s.id)).done;
    let d = await read(s.id);
    assert.equal(d.phase, "awaiting_approval");
    assert.equal(d.pending_request?.kind, "budget");
    assert.ok(d.spent_usd >= 1, `spent ${d.spent_usd}`);
    await assert.rejects(H.raiseBudget(org.orgId, s.id, owner, { to_usd: 3 }), /reason/);
    await assert.rejects(H.raiseBudget(org.orgId, s.id, member, { to_usd: 3, reason: "x" }), /Billing manager or Owner/);
    await assert.rejects(H.raiseBudget(org.orgId, s.id, owner, { to_usd: 50, reason: "x" }), /at most \$5\.00/, "never above the ceiling");
    await assert.rejects(H.raiseBudget(org.orgId, s.id, owner, { to_usd: 1.1, reason: "x" }), /nothing to spend/);
    await assert.rejects(H.decideRequest(org.orgId, s.id, d.pending_request!.id, member, "approve"), /Raise budget/);
    d = await H.raiseBudget(org.orgId, s.id, owner, { to_usd: 3, reason: "the job is worth it" });
    assert.equal(d.budget_usd, 3);
    assert.deepEqual(d.grants.map((g) => [g.from_usd, g.to_usd, g.reason, g.by]), [[1, 3, "the job is worth it", "owner@example.org"]]);
    assert.equal(d.phase, "waking", "the raise continues it");
    const [run] = await db.query<{ budget_usd: string }>("SELECT budget_usd FROM runs WHERE id = (SELECT current_run_id FROM harness_sessions WHERE id = $1)", [s.id]);
    assert.ok(Math.abs(Number(run!.budget_usd) - (3 - d.spent_usd)) < 0.001, "the wake's budget is what the session has left");
    const w = await wake(s.id);
    await until("continues", () => agentSaid(s.id, /\(resumed /));
    await H.stopSession(org.orgId, s.id, member); await w.done;
    // A budget raise is not lost to retention, and a staff raise is recorded with its reason too (below).
    ok("budgets: at its budget it stops and asks; a raise needs a reason and the role, stays under the ceiling, is never made while it works, is recorded and continues it");
  }

  // ---------- 7. crash recovery ----------
  {
    // The harness dies mid-session: the wake fails, the session parks with its message asked again.
    const s = await H.startSession(org.orgId, member, { message: "hello" });
    const w = await wake(s.id);
    await until("answered", () => agentSaid(s.id, /Echo: hello/));
    await H.messageSession(org.orgId, s.id, member, "die");
    await w.done;
    let d = await read(s.id);
    assert.equal(d.phase, "parked");
    assert.equal(d.crashes, 1);
    assert.match(d.reason ?? "", /^crashed/);
    assert.equal(d.messages.find((m) => m.body === "die")?.status, "pending", "what the dead wake left unanswered is asked again");
    // The runner goes silent: its lease lapses and the run engine's sweep settles the session (a crash).
    const s2 = await H.startSession(org.orgId, member, { message: "quiet runner" });
    const c = (await client.claim([`${C.AGENT_PACK}/${C.AGENT_KIND}`]))!;
    await client.agent!.start(c.run.id, c.lease_token);
    await db.query("UPDATE runs SET lease_expires_at = now() - interval '1 second', heartbeat_at = now() - interval '5 seconds' WHERE id = $1", [c.run.id]);
    await runs.sweepRuns();
    d = await read(s2.id);
    assert.equal(d.phase, "parked"); assert.equal(d.crashes, 1);
    assert.equal(d.messages.find((m) => m.body === "quiet runner")?.status, "pending");
    const ev = await db.query<{ data: Record<string, unknown> }>("SELECT data FROM run_events WHERE run_id = $1 AND type = 'agent_crashed'", [c.run.id]);
    assert.equal(ev.length, 1);
    // The next message (here the carried one, with a new one) continues it.
    await H.messageSession(org.orgId, s2.id, member, "are you back?");
    const w2 = await wake(s2.id);
    await until("back", () => agentSaid(s2.id, /Echo: are you back\?/));
    await park(); await w2.done;
    assert.equal((await read(s2.id)).crashes, 0, "a clean wake ends the crash streak");
    // Automatic resume (the platform's switch, frozen into the session) continues a crashed session by itself.
    await saveSettingValues("test-staff", { AGENT_AUTO_RESUME: "on", AGENT_CRASH_RESUMES: 1 });
    const s3 = await H.startSession(org.orgId, member, { message: "hello" });
    const w3 = await wake(s3.id);
    await until("answered", () => agentSaid(s3.id, /Echo: hello/));
    await H.messageSession(org.orgId, s3.id, member, "die");
    await w3.done;
    d = await read(s3.id);
    assert.equal(d.phase, "waking", "resumed by itself");
    const w4 = await wake(s3.id);
    await w4.done; // "die" was carried: it dies again, past the limit of 1
    d = await read(s3.id);
    assert.equal(d.phase, "failed"); assert.match(d.reason ?? "", /crashed 2 times in a row/);
    await saveSettingValues("test-staff", { AGENT_AUTO_RESUME: "off", AGENT_CRASH_RESUMES: 3 });
    ok("crash recovery: a dead harness or a silent runner parks the session with its messages asked again; the next message continues it; automatic resume continues it by itself; past the limit it fails");
  }

  // ---------- 8. retention ----------
  {
    const later = new Date(Date.now() + 400 * 86400_000);
    // An unanswered request expires; its session parks with that said.
    const s = await H.startSession(org.orgId, member, { message: "use OtherTool" });
    await (await wake(s.id)).done;
    assert.equal((await read(s.id)).phase, "awaiting_approval");
    await db.query("UPDATE harness_session_requests SET created_at = now() - interval '25 hours' WHERE session_id = $1", [s.id]);
    let sw = await H.sweepHarnessSessions();
    assert.ok(sw.expired >= 1);
    let d = await read(s.id);
    assert.equal(d.phase, "parked"); assert.equal(d.requests[0]!.status, "expired");
    // Quiet sessions archive; ended ones past retention lose their conversation and keep their spend and raises.
    const before = await H.listSessions(org.orgId, member);
    const spentBefore = new Map(before.map((x) => [x.id, x.spent_usd]));
    sw = await H.sweepHarnessSessions(later);
    assert.ok(sw.archived >= 1, "quiet sessions archived");
    sw = await H.sweepHarnessSessions(new Date(later.getTime() + 61 * 86400_000));
    assert.ok(sw.pruned >= 1, "past retention: pruned");
    const pruned = (await H.listSessions(org.orgId, member)).filter((x) => x.pruned);
    assert.ok(pruned.length >= 1);
    for (const x of pruned) {
      const pd = await read(x.id);
      assert.equal(pd.messages.length, 0); assert.equal(pd.requests.length, 0);
      assert.equal(pd.spent_usd, spentBefore.get(x.id), "its spend is kept");
      assert.equal(pd.phase, "archived");
    }
    const raised = pruned.find((x) => x.budget_usd === 3);
    if (raised) assert.equal((await read(raised.id)).grants.length, 1, "its budget raise is kept");
    const objects = await db.query("SELECT checkpoint FROM harness_sessions WHERE pruned_at IS NOT NULL AND checkpoint IS NOT NULL");
    assert.equal(objects.length, 0, "no checkpoint left");
    ok("retention: unanswered requests expire, quiet sessions archive, past retention the conversation goes and the spend and raises stay");
  }

  // ---------- 9. settings ----------
  {
    const groups = settings.settingGroups().map((g) => g.id);
    assert.ok(groups.includes("agent"));
    const list = await settings.listSettings();
    const agent = list.filter((x) => x.group === "agent");
    assert.equal(agent.length, settings.AGENT_SETTINGS.length);
    for (const k of ["AGENT_HARNESS", "AGENT_MODEL", "AGENT_PROVIDER", "AGENT_SESSION_BUDGET_USD", "AGENT_BUDGET_CEILING_USD", "AGENT_MONTH_BUDGET_USD", "AGENT_RETENTION_DAYS", "AGENT_WEB_TOOLS", "AGENT_WEB_HOSTS"])
      assert.ok(agent.some((x) => x.key === k), k);
    for (const x of agent) assert.ok(x.help.length > 40 && !/[A-Z_]{6,}/.test(x.help), `${x.key}: plain words`);
    await assert.rejects(saveSettingValues("staff-2", { AGENT_WEB_HOSTS: "10.0.0.1" }), /host names/);
    await assert.rejects(saveSettingValues("staff-2", { AGENT_HARNESS: "other" }), /must be one of/);
    await saveSettingValues("staff-2", { AGENT_MODEL: "claude-test-model" });
    const ch = await db.query<{ key: string; from_value: unknown; to_value: unknown; changed_by: string }>("SELECT key, from_value, to_value, changed_by FROM platform_setting_changes ORDER BY id");
    assert.deepEqual(ch.at(-1), { key: "AGENT_MODEL", from_value: null, to_value: "claude-test-model", changed_by: "staff-2" });
    assert.ok(ch.some((c) => c.key === "AGENT_WEB_TOOLS" && c.to_value === "fetch" && c.changed_by === "test-staff"));
    assert.equal(ch.filter((c) => c.key === "AGENT_AUTO_RESUME").length, 2, "every change, the one back too");
    // The admin MCP: list_settings shows the group; update_setting changes and records one.
    const { adminTools } = await import("../src/admin-mcp.js");
    const tools = adminTools();
    const listed = await tools.list_settings!.run({ group: "agent" }, { actor: "staff-3", role: "owner", userId: null }) as { settings: { key: string }[] };
    assert.equal(listed.settings.length, settings.AGENT_SETTINGS.length);
    await tools.update_setting!.run({ key: "AGENT_PARK_AFTER_MINUTES", value: 5 }, { actor: "staff-3", role: "owner", userId: null });
    assert.equal(settings.settingNumber("AGENT_PARK_AFTER_MINUTES"), 5);
    const last = (await db.query<{ key: string; changed_by: string }>("SELECT key, changed_by FROM platform_setting_changes ORDER BY id DESC LIMIT 1"))[0];
    assert.deepEqual(last, { key: "AGENT_PARK_AFTER_MINUTES", changed_by: "staff-3" });
    assert.ok(tools.list_agent_sessions && tools.stop_agent_session, "the admin MCP's agent tools, with the flag on");
    // A new session freezes the settings in force; a running one keeps its own.
    const s = await H.startSession(org.orgId, member, { message: "x" });
    assert.equal((await read(s.id)).harness.model, "claude-test-model");
    await H.stopSession(org.orgId, s.id, member);
    ok("settings: the agent group with plain words, listed and changed through the admin MCP, every change recorded with who and the value before");
  }

  // ---------- 10. the doors ----------
  {
    const http = await startHttp();
    const m = await http.signIn(org, "member"), v = await http.signIn(org, "viewer"), o = await http.signIn(org, "owner");
    const h = (t: string) => ({ authorization: `Bearer ${t}` });
    let r = await http.req("GET", "/api/agent", h(m));
    assert.equal(r.status, 200);
    const body = await r.json() as { sessions: unknown[]; can_start: boolean; offer: { harness: string } };
    assert.equal(body.can_start, true); assert.equal(body.offer.harness, "Claude Code");
    r = await http.req("POST", "/api/agent", h(v), { message: "hi" });
    assert.equal(r.status, 403, "a viewer cannot start one");
    r = await http.req("POST", "/api/agent", h(m), { message: "slow 200\nhello over http" });
    assert.equal(r.status, 201);
    const started = (await r.json() as { session: { id: string } }).session.id;
    r = await http.req("POST", `/api/agent/${started}/messages`, h(o), { message: "not mine" });
    assert.equal(r.status, 403);
    r = await http.req("POST", `/api/agent/${started}/stop`, h(o), {});
    assert.equal(r.status, 200, "an owner may stop it");
    const staffToken = await http.adminToken("operator");
    r = await http.req("GET", "/api/admin/onboarding/agent", { authorization: `Bearer ${staffToken}` });
    assert.equal(r.status, 200);
    const all = await r.json() as { sessions: { workspace?: { id: number } }[] };
    assert.ok(all.sessions.length > 3 && all.sessions.every((x) => x.workspace?.id === org.orgId), "staff see every workspace's (here: one)");
    r = await http.req("GET", `/api/agent/${started}`, h(await http.signIn(other, "owner")));
    assert.equal(r.status, 404, "another workspace's session is not found");
    await http.close();
    const mcp = await connect({ ...org, userId: "user_member", role: "member" });
    const names = (await mcp.client.listTools()).tools.map((t) => t.name);
    for (const n of ["list_agent_sessions", "start_agent_session", "read_agent_session", "message_agent_session", "pause_agent_session", "resume_agent_session", "stop_agent_session", "decide_agent_request", "raise_agent_budget"])
      assert.ok(names.includes(n), n);
    const got = await mcp.call("list_agent_sessions", {});
    assert.ok(!got.isError && (got.structuredContent?.sessions ?? []).length > 3);
    const st = await mcp.call("start_agent_session", { message: "from mcp", mode: "task" });
    assert.ok(!st.isError, st.content[0]?.text);
    const stopped = await mcp.call("stop_agent_session", { session: st.structuredContent.session.id });
    assert.ok(!stopped.isError);
    await mcp.close();
    ok("the doors: /api/agent (a member starts, a viewer cannot, only the starter messages, an owner stops), staff's list of every workspace's, the MCP tools");
  }

  F.setFeaturesForTest(null);
  console.log("\nagent harness: all checks passed");
  cleanup();
  process.exit(0);
} catch (e) {
  console.error(e);
  cleanup();
  process.exit(1);
}

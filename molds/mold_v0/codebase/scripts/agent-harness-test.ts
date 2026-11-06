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
// 11. What a session reaches of its workspace (mold_v0-250; src/harness-reach.ts):
//     a. the context, pure: composed and capped (a third for the app's instructions, the rest for the context), and
//        which tools are used without asking under each setting (reads, reads and named, all)
//     b. at its start: the app's own tools as the person who started it (no agent session tool among them), reads
//        without asking and the rest asking first, the context frozen into its policy within its cap
//     c. a wake end to end: its CLI gets the workspace's server by --mcp-config and its token by reference, and the
//        standing instructions; it reads the workspace's records and memory through the tools (reads free); another
//        workspace's record is not found; a write becomes an approval request (and the server refuses it meanwhile);
//        approved, the next wake writes it
//     d. the token, directly: scoped to its session's workspace (another workspace's record refused), reads free,
//        writes refused by the server, no other door opens with it; revoked at pause, park, stop and budget, and when
//        the person is no longer a member; a newer wake's token works while the older one does not
// 12. Agent profiles (mold_v0-261; src/agent-profiles.ts):
//     a. pure: what a profile resolves to (unset: the platform setting; a workspace's override), the first message from
//        a record and the on_start template, what its shape cannot say, a hidden tool never asked for
//     b. CRUD, versioning and audit: the Default (the global settings) and a pack's profile written once; created,
//        edited (a new version; an older one refused), archived and restored by staff, each change with who, before and
//        after; refusals (an unpriced model, a path out of the workspace, a tool in two lists, an unknown workspace, a
//        viewer, a budget over its ceiling, a staff viewer)
//     c. role gating: offered and started only by its roles, on the server too
//     d. per-workspace overrides: a named workspace's budget and model; budgets and the ceiling held
//     e. tools free, ask and hidden; files written into the workspace; its instructions and on_start reaching the
//        stand-in CLI; the version frozen while staff change the profile
//     f. start_agent from a record: the message filled from the record on the server, the session linked back and in
//        the record's runs section; the list's action; archived and unpriced refusals
//     g. off: nothing of it
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
    // The start dialog's budget range (mold_v0-249): a member may lower the default, never pass it.
    const range = (body as unknown as { offer: { budget: { default_usd: number; max_usd: number; ceiling_usd: number } } }).offer.budget;
    assert.deepEqual(range, { default_usd: 1, max_usd: 1, ceiling_usd: 5 }, "a member: the setting's budget at most");
    r = await http.req("POST", "/api/agent", h(m), { message: "x", budget_usd: 3 });
    assert.equal(r.status, 400, "a member cannot start above the setting's budget");
    r = await http.req("POST", "/api/agent", h(o), { message: "x", budget_usd: 0.5 });
    assert.equal(r.status, 201);
    const lowered = (await r.json() as { session: { id: string; budget_usd: number } }).session;
    assert.equal(lowered.budget_usd, 0.5, "a lower budget is kept");
    await http.req("POST", `/api/agent/${lowered.id}/stop`, h(o), {});
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

  // ---------- 11. what a session reaches of its workspace ----------
  {
    const R = await import("../src/harness-reach.js");
    // a. pure
    {
      const tools = [{ name: "list_records", read: true }, { name: "search_memory", read: true }, { name: "fx_put_item", read: false }, { name: "save_memory", read: false }];
      assert.deepEqual(C.freeWorkspaceTools(tools, "reads", ["fx_put_item"]), ["list_records", "search_memory"], "reads: the named are ignored");
      assert.deepEqual(C.freeWorkspaceTools(tools, "reads_and_named", ["fx_put_item"]), ["list_records", "search_memory", "fx_put_item"]);
      assert.deepEqual(C.freeWorkspaceTools(tools, "all", []), tools.map((t) => t.name));
      const c = R.composeContext({ workspace: "W", who: "p@example.org", role: "member", tools, free: ["list_records", "search_memory"], instructions: "I".repeat(5000), context: "word ".repeat(2000), max: 3000 });
      assert.ok(c.text.startsWith("## This workspace") && /Without asking you may use: list_records, search_memory\./.test(c.text) && /ask the person first[^\n]*fx_put_item, save_memory/.test(c.text), c.text.slice(0, 600));
      assert.deepEqual(c.parts.map((x) => [x.part, x.chars]), [["instructions", 5000], ["context", 9999]]);
      assert.ok(c.parts[0]!.kept === 1000 && c.parts[1]!.kept <= 2000 && c.parts[1]!.kept > 1800, JSON.stringify(c.parts));
      assert.ok(/\[…shortened\]/.test(c.text), "a cut part says so");
      const none = R.composeContext({ workspace: "W", who: "x", role: null, tools, free: [], instructions: "abc", context: "def", max: 0 });
      assert.ok(none.parts.every((x) => x.kept === 0) && !/### /.test(none.text), "0: no context, only who it acts for and its tools");
      ok("reach, pure: the context composed and capped (a third for the app's instructions, the rest for the context); the tools used without asking under reads, reads and named, all");
    }
    const { setPacksForTest } = await import("../src/packs.js");
    const { setPackConfigsForTest } = await import("../src/host.js");
    const { definePack, defineTool, z } = await import("../src/pack-api.js");
    const ctx = await import("../src/account-context.js");
    const { memberships } = await import("../src/clerk.js");
    setPacksForTest([{ manifest: { id: "fixture_reach", name: "fixture_reach", version: "1", entry: "index.ts", migrations: null, words: {} }, definition: definePack({
      id: "fixture_reach",
      recordAreas: [{ name: "fx_items", label: "Items", role: "check", scope: "workspace", fields: [{ name: "summary", label: "Summary" }] }],
      tools: [defineTool({ name: "fx_put_item", description: "Save an item (test).", inputSchema: { key: z.string(), summary: z.string() },
        handler: async (_ws, a, { records }) => records.put("fx_items", a.key, { title: `Item ${a.key}`, data: { summary: a.summary } }) })],
    }) }]);
    setPackConfigsForTest([{ pack: "fixture_reach", memory: { scopes: ["company", "user"], tools: { save: "save_memory", search: "search_memory" } } }]);
    const http = await startHttp();
    process.env.PUBLIC_URL = http.base; // the wake's gateway and workspace server: the API itself
    const A = (await createOrg(`Reach A ${STAMP}`)).org, B = (await createOrg(`Reach B ${STAMP}`)).org;
    const am = await http.signInAs(A, "member");
    const person = { kind: "person" as const, user: am.userId, name: "a.member@example.org", role: "member" as const };
    const ca = await connect({ ...A, role: "owner" }), cb = await connect({ ...B, role: "owner" });
    for (const [k, t] of [["a-1", `A first ${STAMP}`], ["a-2", `A second ${STAMP}`]]) assert.ok(!(await ca.call("fx_put_item", { key: k, summary: t })).isError);
    assert.ok(!(await cb.call("fx_put_item", { key: "b-secret", summary: `B private ${STAMP}` })).isError);
    await ctx.saveCompany(A.orgId, "owner", { about: `A keeps items for its reach test ${STAMP}.`, notes_for_ai: "Answer in plain words." });
    await ctx.addMemory(A.orgId, "owner", { scope: "company", body: `The reach marker is ${STAMP}.` }, "");
    await ctx.addMemory(B.orgId, "owner", { scope: "company", body: `B's own memory ${STAMP}.` }, "");
    await saveSettingValues("test-staff", { AGENT_WORKSPACE_TOOLS: "reads", AGENT_CONTEXT_MAX_CHARS: 12000, AGENT_PARK_AFTER_MINUTES: 1, AGENT_SESSION_BUDGET_USD: 1 });
    const h = (t: string) => ({ authorization: `Bearer ${t}` });
    const rd = (id: string) => H.readSession(A.orgId, id, person);
    const said = async (id: string, re: RegExp) => (await rd(id)).messages.some((m) => m.role === "agent" && re.test(m.body));
    const lastAgent = async (id: string) => (await rd(id)).messages.filter((m) => m.role === "agent").at(-1)?.body ?? "";
    // b. at its start
    let r = await http.req("POST", "/api/agent", h(am.token), { message: "standing" });
    assert.equal(r.status, 201);
    const sid = (await r.json() as { session: { id: string } }).session.id;
    const d0 = await rd(sid);
    const reach = d0.reach!;
    assert.deepEqual([reach.acts_as.kind, reach.acts_as.role, reach.free], ["person", "member", "reads"]);
    const byName = new Map(reach.tools.map((t) => [t.name, t]));
    for (const n of ["list_records", "get_record", "search_memory"]) assert.equal(byName.get(n)?.asks, false, `${n}: a read, without asking`);
    for (const n of ["fx_put_item", "save_memory"]) assert.equal(byName.get(n)?.asks, true, `${n}: a change, asks first`);
    assert.ok(!reach.tools.some((t) => /agent_session/.test(t.name)), "no agent session tool: an agent does not start or steer sessions");
    assert.ok(!d0.policy.tools.some((t) => t.startsWith("mcp__")), "the card's own tools list stays the harness's");
    const [pol] = await db.query<{ policy: import("../src/agent-harness-config.js").AgentPolicy }>("SELECT policy FROM harness_sessions WHERE id = $1", [sid]);
    assert.ok(pol!.policy.tools.includes("mcp__app__list_records") && !pol!.policy.tools.includes("mcp__app__fx_put_item"), "frozen: reads in its allowed tools, writes not");
    const text = pol!.policy.workspace!.context.text;
    assert.ok(text.includes(`The reach marker is ${STAMP}`) && text.includes("A keeps items") && !text.includes("B's own memory"), "its own workspace's context and memory, no other's");
    assert.ok(reach.context.parts.every((x) => x.chars > 0 && x.kept === x.chars), JSON.stringify(reach.context.parts));
    assert.ok(!/hss_|hst_|run_|org-|"id"/.test(JSON.stringify(reach)), "the card's reach names no internal id");
    // Capped: a long company context is cut to its share, and the session says so.
    await ctx.saveCompany(A.orgId, "owner", { about: `A keeps items. ${"Long background. ".repeat(400)}` });
    await saveSettingValues("test-staff", { AGENT_CONTEXT_MAX_CHARS: 900 });
    const capped = await H.startSession(A.orgId, person, { message: "x" });
    const cr = (await rd(capped.id)).reach!;
    const cp = cr.context.parts.find((x) => x.part === "context")!;
    assert.ok(cr.context.max_chars === 900 && cp.chars > 1500 && cp.kept < cp.chars && cr.context.parts.reduce((t, x) => t + x.kept, 0) <= 900, JSON.stringify(cr.context));
    await H.stopSession(A.orgId, capped.id, person);
    await saveSettingValues("test-staff", { AGENT_CONTEXT_MAX_CHARS: 12000 });
    await ctx.saveCompany(A.orgId, "owner", { about: `A keeps items for its reach test ${STAMP}.` });
    // Reads and named: the named tool is used without asking; a bad name is refused by the setting.
    await assert.rejects(saveSettingValues("test-staff", { AGENT_WORKSPACE_TOOLS_NAMED: "fx put item" }), /tool names/);
    await saveSettingValues("test-staff", { AGENT_WORKSPACE_TOOLS: "reads_and_named", AGENT_WORKSPACE_TOOLS_NAMED: "fx_put_item" });
    const named = await H.startSession(A.orgId, person, { message: "x" });
    assert.equal((await rd(named.id)).reach!.tools.find((t) => t.name === "fx_put_item")?.asks, false, "reads and named: the named one without asking");
    assert.equal((await rd(named.id)).reach!.tools.find((t) => t.name === "save_memory")?.asks, true, "the others still ask");
    await H.stopSession(A.orgId, named.id, person);
    await saveSettingValues("test-staff", { AGENT_WORKSPACE_TOOLS: "reads", AGENT_WORKSPACE_TOOLS_NAMED: "" });
    ok("reach at its start: the app's own tools as the person who started it (reads without asking, the rest ask first; reads and named; no agent session tool), its own workspace's context and memory frozen in, capped");

    // c. a wake, end to end with the stand-in CLI
    {
      const w = await wake(sid);
      await until("standing", () => said(sid, /^Standing: \d+ characters; workspace: yes; servers: app; token: set$/), 20_000);
      const cfg = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM harness_session_tokens WHERE session_id = $1 AND revoked_at IS NULL", [sid]);
      assert.equal(cfg[0]!.n, 1, "one live token: this wake's");
      await H.messageSession(A.orgId, sid, person, 'mcp list_records {"area":"fx_items"}');
      await until("its records", () => said(sid, /^MCP list_records: /));
      const listed = await lastAgent(sid);
      assert.ok(listed.includes(`A first ${STAMP}`) && listed.includes(`A second ${STAMP}`) && !listed.includes("B private"), listed);
      await H.messageSession(A.orgId, sid, person, 'mcp get_record {"area":"fx_items","key":"b-secret"}');
      await until("another workspace's record", () => said(sid, /^MCP get_record: /));
      assert.match(await lastAgent(sid), /error: .*no record b-secret/, "another workspace's record is not found through the session");
      await H.messageSession(A.orgId, sid, person, 'mcp search_memory {"query":"reach marker"}');
      await until("its memory", () => said(sid, /^MCP search_memory: /));
      assert.ok((await lastAgent(sid)).includes(`The reach marker is ${STAMP}`) && !(await lastAgent(sid)).includes("B's own memory"));
      // A write: asked for, the wake stops; the server refused the call meanwhile, so nothing was written.
      await H.messageSession(A.orgId, sid, person, `mcp fx_put_item {"key":"a-new","summary":"written by the agent ${STAMP}"}`);
      await w.done;
      let d = await rd(sid);
      assert.equal(d.phase, "awaiting_approval");
      assert.equal(d.pending_request?.kind, "tool");
      assert.equal(d.pending_request?.subject, "mcp__app__fx_put_item");
      assert.equal(d.pending_request?.detail.workspace_tool, "fx_put_item");
      assert.match(String(d.pending_request?.detail.input), /a-new/, "what it wanted to send is shown with the request");
      assert.ok(d.messages.some((m) => m.role === "system" && m.body === "The agent asks to use the workspace tool fx_put_item."));
      assert.ok((await ca.call("get_record", { area: "fx_items", key: "a-new" })).isError, "nothing written before the decision");
      const [t1] = await db.query<{ revoked_reason: string }>("SELECT revoked_reason FROM harness_session_tokens WHERE run_id = $1", [w.claim.run.id]);
      assert.equal(t1!.revoked_reason, "awaiting a decision", "the wake's token revoked as it stopped");
      d = await H.decideRequest(A.orgId, sid, d.pending_request!.id, person, "approve");
      assert.equal(d.reach!.tools.find((t) => t.name === "fx_put_item")?.asks, false, "approved: this session uses it without asking from now on");
      const w2 = await wake(sid);
      await until("woken", () => said(sid, /approved: using the workspace tool fx_put_item/));
      await H.messageSession(A.orgId, sid, person, `mcp fx_put_item {"key":"a-new","summary":"written by the agent ${STAMP}"}`);
      await until("written", () => said(sid, /^MCP fx_put_item: /));
      const got = await ca.call("get_record", { area: "fx_items", key: "a-new" });
      assert.ok(!got.isError && JSON.stringify(got.structuredContent).includes(`written by the agent ${STAMP}`), "approved, the next wake wrote it as the person");
      await until("waiting", async () => (await rd(sid)).phase === "waiting");
      await park(); await w2.done;
      const [t2] = await db.query<{ revoked_reason: string }>("SELECT revoked_reason FROM harness_session_tokens WHERE run_id = $1", [w2.claim.run.id]);
      assert.equal(t2!.revoked_reason, "parked", "parked: its token revoked");
      offset = 0;
      ok("a wake end to end: its CLI gets the workspace's server and token and the standing instructions; it reads records and memory (reads free), another workspace's record is not found, a write becomes an approval request (the server refused it meanwhile) and, approved, the next wake writes it");
    }

    // d. the token, directly
    {
      const rpc = async (token: string, method: string, params: Record<string, unknown> = {}, p = "/mcp") => {
        const res = await http.req("POST", p, { ...h(token), accept: "application/json, text/event-stream" }, { jsonrpc: "2.0", id: 1, method, params });
        const t = await res.text();
        const j = t.trim().startsWith("{") ? JSON.parse(t) : JSON.parse((t.split("\n").find((l) => l.startsWith("data:")) ?? "data: {}").slice(5));
        return { status: res.status, json: j as { error?: { message: string }; result?: { isError?: boolean; content: { text: string }[]; tools?: { name: string }[] } } };
      };
      const textOf = (x: Awaited<ReturnType<typeof rpc>>) => (x.json.result?.content ?? []).map((c) => c.text).join(" ");
      const manual = async (id: string) => {
        const c = (await client.claim([`${C.AGENT_PACK}/${C.AGENT_KIND}`]))!;
        const ws = await client.agent!.start(c.run.id, c.lease_token);
        return { c, token: ws.workspace!.token };
      };
      const endWake = async (c: { run: { id: string }; lease_token: string }, reason: "parked" | "paused" | "stopped" | "budget") => {
        await client.agent!.end(c.run.id, c.lease_token, { reason });
        await client.complete(c.run.id, c.lease_token, { outcome: "succeeded", results: [] });
      };
      const s2 = await H.startSession(A.orgId, person, { message: "direct" });
      const m1 = await manual(s2.id);
      assert.ok(m1.token.startsWith("hst_"));
      let x = await rpc(m1.token, "tools/list");
      const names = (x.json.result?.tools ?? []).map((t) => t.name);
      assert.ok(names.includes("list_records") && names.includes("fx_put_item") && !names.some((n) => /agent_session/.test(n)), names.join(","));
      x = await rpc(m1.token, "tools/call", { name: "list_records", arguments: { area: "fx_items" } });
      assert.ok(x.status === 200 && textOf(x).includes(`A first ${STAMP}`) && !textOf(x).includes("B private"), "reads: its workspace's records only");
      x = await rpc(m1.token, "tools/call", { name: "get_record", arguments: { area: "fx_items", key: "b-secret" } });
      assert.ok(x.json.result?.isError && /no record b-secret/.test(textOf(x)), "another workspace's record is refused with the session's token");
      x = await rpc(m1.token, "tools/call", { name: "fx_put_item", arguments: { key: "a-sneak", summary: "x" } });
      assert.equal(x.status, 403); assert.match(x.json.error!.message, /must ask the person before it uses fx_put_item/, "a write the session must ask for is refused by the server too");
      assert.ok((await ca.call("get_record", { area: "fx_items", key: "a-sneak" })).isError, "nothing written");
      for (const [m, p] of [["GET", "/api/agent"], ["GET", "/api/records/fx_items"], ["GET", "/api/app/context"]] as const)
        assert.equal((await http.req(m, p, h(m1.token))).status, 401, `${p}: no other door opens with it`);
      assert.equal((await rpc(m1.token, "tools/list", {}, `/mcp/${m1.token}`)).status, 401, "never in a URL");
      // Pause: refused at once; the wake ends paused.
      await H.pauseSession(A.orgId, s2.id, person);
      x = await rpc(m1.token, "tools/list");
      assert.equal(x.status, 401); assert.match(x.json.error!.message, /revoked \(paused\)/);
      await endWake(m1.c, "paused");
      // Resume: a new wake, a new token; the older one stays refused.
      await H.resumeSession(A.orgId, s2.id, person);
      const m2 = await manual(s2.id);
      assert.equal((await rpc(m2.token, "tools/list")).status, 200);
      assert.equal((await rpc(m1.token, "tools/list")).status, 401, "the older wake's token stays refused");
      // Park: its wake ends, its token goes.
      await endWake(m2.c, "parked");
      x = await rpc(m2.token, "tools/list");
      assert.equal(x.status, 401); assert.match(x.json.error!.message, /revoked \(parked\)/);
      // Stop: refused as soon as it is asked.
      await H.messageSession(A.orgId, s2.id, person, "again");
      const m3 = await manual(s2.id);
      assert.equal((await rpc(m3.token, "tools/list")).status, 200);
      await H.stopSession(A.orgId, s2.id, person);
      x = await rpc(m3.token, "tools/list");
      assert.equal(x.status, 401); assert.match(x.json.error!.message, /revoked \(stopped\)/);
      await endWake(m3.c, "stopped");
      // Budget: a session out of budget is refused (and its token revoked), before any beat says so.
      const s3 = await H.startSession(A.orgId, person, { message: "budget" });
      const m4 = await manual(s3.id);
      assert.equal((await rpc(m4.token, "tools/list")).status, 200);
      await db.query("UPDATE harness_sessions SET spent_usd = budget_usd WHERE id = $1", [s3.id]);
      x = await rpc(m4.token, "tools/list");
      assert.equal(x.status, 401); assert.match(x.json.error!.message, /reached its budget/);
      const [t4] = await db.query<{ revoked_reason: string }>("SELECT revoked_reason FROM harness_session_tokens WHERE run_id = $1", [m4.c.run.id]);
      assert.equal(t4!.revoked_reason, "budget");
      await endWake(m4.c, "budget");
      await H.stopSession(A.orgId, s3.id, person);
      // The person: their membership is read on every call; once they leave the workspace the token is refused.
      await db.query("UPDATE harness_sessions SET spent_usd = 0 WHERE id = $1", [s3.id]);
      const s4 = await H.startSession(A.orgId, person, { message: "member" });
      const m5 = await manual(s4.id);
      assert.equal((await rpc(m5.token, "tools/list")).status, 200);
      await memberships.remove(am.clerkOrg, am.userId);
      x = await rpc(m5.token, "tools/list");
      assert.equal(x.status, 401); assert.match(x.json.error!.message, /no longer a member/);
      await endWake(m5.c, "stopped");
      // An expired token, and one never issued.
      await db.query("UPDATE harness_session_tokens SET expires_at = now() - interval '1 second', revoked_at = NULL WHERE run_id = $1", [m5.c.run.id]);
      assert.match((await rpc(m5.token, "tools/list")).json.error!.message, /expired/);
      assert.match((await rpc("hst_not-a-token-at-all-000000", "tools/list")).json.error!.message, /not known/);
      // Never stored: only hashes.
      const stored = await db.query<{ token_hash: string }>("SELECT token_hash FROM harness_session_tokens WHERE org_id = $1", [A.orgId]);
      assert.ok(stored.length >= 6 && stored.every((t) => /^[0-9a-f]{64}$/.test(t.token_hash)) && !stored.some((t) => [m1, m2, m3, m4, m5].some((m) => t.token_hash === m.token)));
      ok("the token: scoped to its session's workspace (another workspace's record refused), reads free, writes refused by the server, no other door or a URL; revoked at pause, park, stop and budget, and when the person leaves; a newer wake's works while the older's does not; expired and unknown refused; only hashes kept");
    }
    await ca.close(); await cb.close();
    await http.close();
    setPacksForTest(null); setPackConfigsForTest([]);
  }

  // ---------- 12. agent profiles (mold_v0-261; src/agent-profiles.ts, src/agent-profile-spec.ts) ----------
  {
    const P = await import("../src/agent-profiles.js");
    const S = await import("../src/agent-profile-spec.js");
    // a. pure: what a profile resolves to (each unset setting the platform's; a workspace's override over the profile),
    //    the first message from a record and the on_start template, what its shape cannot say, a hidden tool never asked for.
    {
      const d = P.effectiveOf({});
      assert.deepEqual([d.model, d.budget_usd, d.from.model, d.from.budget_usd], [settings.settingText("AGENT_MODEL"), Math.min(settings.settingNumber("AGENT_SESSION_BUDGET_USD"), settings.settingNumber("AGENT_BUDGET_CEILING_USD")), "setting", "setting"],
        "the Default (nothing set): the platform settings");
      assert.deepEqual(d.roles, ["member", "billing", "owner"]);
      const c = { model: "claude-sonnet-5-5", budget_usd: 2, ceiling_usd: 3, overrides: [{ workspace: "acme", budget_usd: 2.5, model: "claude-haiku-5-5" }] };
      const e = P.effectiveOf(c, "acme"), f = P.effectiveOf(c, "elsewhere");
      assert.deepEqual([e.model, e.budget_usd, e.from.model, e.workspace], ["claude-haiku-5-5", 2.5, "workspace", "acme"], "a named workspace's override");
      assert.deepEqual([f.model, f.budget_usd, f.from.budget_usd, f.workspace], ["claude-sonnet-5-5", 2, "profile", null], "any other workspace: the profile");
      assert.equal(P.effectiveOf({ budget_usd: 9, ceiling_usd: 4 }).budget_usd, 4, "a budget is never over its ceiling");
      const t = P.effectiveOf({ tools: { base: "reads", free: ["a"], ask: ["b"], hidden: ["c", "a"] } }).tools;
      assert.deepEqual(t, { base: "reads", free: [], ask: ["b"], hidden: ["c", "a"] }, "hidden wins over free");
      assert.equal(S.fillTemplate("Build {{title}} ({{key}}) on {{stack}}: {{summary}}{{missing}}", { key: "shop", title: "Shop", data: { stack: ["ts", "pg"], summary: "A shop" } }), "Build Shop (shop) on ts, pg: A shop");
      assert.equal(S.applyOnStart("Plan first.\n\n{{message}}\n\nThen build.", "ship it"), "Plan first.\n\nship it\n\nThen build.");
      assert.equal(S.applyOnStart("Plan first.", "ship it"), "Plan first.\n\nship it", "without {{message}}: the words follow it");
      assert.equal(S.applyOnStart(null, "ship it"), "ship it");
      assert.deepEqual(S.configProblems({ tools: { free: ["x"], hidden: ["x"] }, files: [{ path: "a.md", content: "1" }, { path: "A.md", content: "2" }], budget_usd: 5, ceiling_usd: 2 }).length, 3);
      for (const bad of ["../x.md", "/etc/x", "a/../b", "a/./b", ""]) assert.ok(!S.ProfileFileSchema.safeParse({ path: bad, content: "" }).success, `${bad || "(empty)"}: a path outside the working directory is refused`);
      for (const good of [".claude/skills/build/SKILL.md", "notes/brief.md", "a.txt"]) assert.ok(S.ProfileFileSchema.safeParse({ path: good, content: "" }).success, good);
      const pol = { ...C.currentPolicy(), workspace: { server: "app", acts_as: { kind: "person" as const, name: null, role: null }, free: "reads" as const, named: [], tools: [], hidden: ["fx_drop"], context: { text: "", max_chars: 0, parts: [] } } };
      assert.deepEqual(A.checkToolUse({ id: "1", name: "mcp__app__fx_drop", input: {} }, pol, 0), { ok: false, hidden: true }, "a hidden tool is never asked for");
      assert.deepEqual(A.checkToolUse({ id: "1", name: "mcp__app__fx_peek", input: {} }, pol, 0), { ok: false, request: { kind: "tool", subject: "mcp__app__fx_peek" } });
      ok("profiles, pure: each unset setting the platform's, a workspace's override over the profile, a budget within its ceiling, hidden over free; a first message filled from a record and the on_start template; paths inside the working directory only; a hidden tool never asked for");
    }

    // The world: a pack that brings a profile ("builder") and a record page whose Build button starts it.
    const { setPacksForTest } = await import("../src/packs.js");
    const { definePack, defineTool, z } = await import("../src/pack-api.js");
    const ra = await import("../src/record-areas.js");
    F.setFeatureForTest("record_pages", true);
    const BUILDER = {
      id: "builder", name: "Build an application", description: "Builds an application from its record.",
      instructions: { append_system: "You build applications. PROFILE-MARK", on_start: "Plan first, then build.\n\n{{message}}", on_resume: "Back to the build." },
      budget_usd: 2, ceiling_usd: 3, max_turns: 12, wake_max_minutes: 20,
      tools: { base: "reads" as const, free: ["fx_put_item"], ask: ["fx_peek"], hidden: ["fx_drop"] },
      web: { tools: "fetch" as const, hosts: ["docs.example.org"] },
      files: [{ path: ".claude/skills/build/SKILL.md", content: "# Build skill\nSKILL-MARK" }, { path: "notes/brief.md", content: "Brief: BRIEF-MARK" }],
      roles: ["member" as const, "owner" as const],
    };
    setPacksForTest([{ manifest: { id: "fixture_profiles", name: "fixture_profiles", version: "1", entry: "index.ts", migrations: null, words: {} }, definition: definePack({
      id: "fixture_profiles",
      recordAreas: [{ name: "fx_apps", label: "Applications", role: "check", scope: "workspace", fields: [{ name: "summary", label: "Summary" }, { name: "stack", label: "Stack" }],
        detail: { tabs: [{ label: "Overview", sections: [{ title: "About", fields: ["summary", "stack"] }, { title: "Runs and sessions", runs: {} }] }],
          actions: [{ kind: "start_agent", place: "primary", label: "Build", profile: "builder", first_message: "Build the application {{title}} ({{key}}) on {{stack}}: {{summary}}" }] } }],
      tabs: [{ id: "apps", kind: "area", area: "fx_apps", icon: "rocket", group: "Build", charts: [], views: ["table"], action: { kind: "start_agent", profile: "builder", first_message: "Plan a new application." } }],
      tools: [
        defineTool({ name: "fx_put_item", description: "Save an application (test).", inputSchema: { key: z.string(), summary: z.string() },
          handler: async (_ws, a, { records }) => records.put("fx_apps", a.key, { title: `App ${a.key}`, data: { summary: a.summary } }) }),
        defineTool({ name: "fx_peek", description: "Read the build queue (test).", inputSchema: {}, annotations: { readOnlyHint: true }, handler: async () => ({ queue: [] }) }),
        defineTool({ name: "fx_drop", description: "Drop every application (test).", inputSchema: {}, handler: async () => ({ dropped: true }) }),
      ],
      agentProfiles: [BUILDER],
    } as never) }]);
    P.resetProfileSeedForTest();
    const http = await startHttp();
    process.env.PUBLIC_URL = http.base;
    const W = (await createOrg(`Profiles ${STAMP}`)).org, W2 = (await createOrg(`Profiles two ${STAMP}`)).org;
    const mem = await http.signInAs(W, "member"), own = await http.signInAs(W, "owner"), view = await http.signInAs(W, "viewer"), own2 = await http.signInAs(W2, "owner");
    const staffTok = await http.adminToken("operator"), readerTok = await http.adminToken("viewer");
    const h = (t: string) => ({ authorization: `Bearer ${t}`, "x-pack-request": "1" });
    const adm = async (method: string, p: string, body?: unknown, tok = staffTok) => {
      const r = await http.req(method, `/api/admin/onboarding/agent-profiles${p}`, { authorization: `Bearer ${tok}` }, body);
      return { status: r.status, body: await r.json().catch(() => ({})) as any };
    };
    const app = async (tok: string, method: string, p: string, body?: unknown) => {
      const r = await http.req(method, p, h(tok), body);
      return { status: r.status, body: await r.json().catch(() => ({})) as any };
    };
    const [priced, priced2] = (await db.query<{ model: string }>("SELECT model FROM model_prices WHERE model IN ('claude-sonnet-5-5', 'claude-haiku-5-5') ORDER BY model DESC")).map((x) => x.model);
    assert.ok(priced && priced2, "two priced models");

    // b. CRUD, versioning and audit
    {
      let r = await adm("GET", "");
      assert.equal(r.status, 200);
      const byId = new Map((r.body.profiles as { id: string }[]).map((x) => [x.id, x as any]));
      assert.deepEqual([byId.get("default")?.version, byId.get("default")?.source, byId.get("default")?.is_default], [1, "platform", true], "the Default profile: the global settings, version 1");
      assert.deepEqual([byId.get("builder")?.source, byId.get("builder")?.pack, byId.get("builder")?.version], ["pack", "fixture_profiles", 1], "the pack's own, written once as version 1");
      assert.ok(r.body.models.includes(priced) && !r.body.models.includes("claude-test-model"), "the editor offers the priced models only");
      assert.ok(["fx_put_item", "fx_peek", "fx_drop"].every((n) => r.body.tools.some((t: { name: string }) => t.name === n)) && !r.body.tools.some((t: { name: string }) => /agent_session/.test(t.name)), "the app's own tools, no agent session tool");
      assert.ok(r.body.workspaces.some((w: { slug: string }) => w.slug === W2.slug));
      const [changes0] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_profile_changes WHERE profile_id = 'builder' AND action = 'created' AND changed_by = 'pack fixture_profiles'");
      assert.equal(changes0!.n, 1, "the pack's profile's creation is audited");
      // Seeding again (another process start) writes nothing new, and keeps staff's edits.
      P.resetProfileSeedForTest(); await P.ensureProfiles();
      assert.equal((await db.query("SELECT 1 FROM agent_profile_versions WHERE profile_id = 'builder'")).length, 1, "written once");
      const body = { name: "Release notes writer", description: "Writes release notes.", config: { model: priced, budget_usd: 1, ceiling_usd: 2, overrides: [{ workspace: W2.slug, budget_usd: 1.5, model: priced2 }] } };
      r = await adm("POST", "", body, readerTok);
      assert.equal(r.status, 403, "a staff viewer cannot create one");
      r = await adm("POST", "", body);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual([r.body.profile.id, r.body.profile.version, r.body.profile.changes[0].action, r.body.profile.changes[0].before, r.body.profile.changes[0].after.config.budget_usd],
        ["release-notes-writer", 1, "created", null, 1], "created as version 1, audited with what it was");
      for (const [why, b, re] of [
        ["an unpriced model", { name: "X1", config: { model: "no-such-model" } }, /no price/],
        ["a path out of the working directory", { name: "X2", config: { files: [{ path: "../x", content: "" }] } }, /working directory/],
        ["a tool in two lists", { name: "X3", config: { tools: { free: ["fx_drop"], hidden: ["fx_drop"] } } }, /free and in hidden/],
        ["a workspace that does not exist", { name: "X4", config: { overrides: [{ workspace: "no-such-workspace", budget_usd: 1 }] } }, /no workspace is called/],
        ["a viewer", { name: "X5", config: { roles: ["viewer"] } }, /viewer is read only/],
        ["a budget over its ceiling", { name: "X6", config: { budget_usd: 5, ceiling_usd: 2 } }, /over its ceiling/],
        ["no name", { name: " ", config: {} }, /give the profile a name/],
      ] as const) { const x = await adm("POST", "", b); assert.ok(x.status === 400 && re.test(x.body.error), `${why}: ${x.status} ${x.body.error}`); }
      assert.equal((await adm("POST", "", body)).status, 409, "a second profile with one id refused");
      r = await adm("PUT", "/release-notes-writer", { version: 1, config: { ...body.config, budget_usd: 1.25 } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const p2 = r.body.profile;
      assert.equal(p2.version, 2);
      assert.deepEqual([p2.changes[0].action, p2.changes[0].version, p2.changes[0].before.config.budget_usd, p2.changes[0].after.config.budget_usd, p2.changes[0].changed], ["edited", 2, 1, 1.25, ["budget_usd"]],
        "an edit: a new version, audited with who, before and after");
      assert.ok(p2.changes[0].by.length > 0 && p2.versions.map((v: { version: number }) => v.version).join() === "2,1");
      assert.equal((await adm("GET", "/release-notes-writer/versions/1")).body.version.config.budget_usd, 1, "version 1 kept as it was");
      r = await adm("PUT", "/release-notes-writer", { version: 1, config: { ...body.config, budget_usd: 1.5 } });
      assert.ok(r.status === 409 && /saved version 2/.test(r.body.error), "an edit of an older version refused, never overwritten");
      assert.equal((await adm("PUT", "/release-notes-writer", { version: 2, config: { ...body.config, budget_usd: 1.25 } })).status, 400, "nothing changed: refused");
      assert.ok((await adm("POST", "/default/archive")).status === 409, "the Default is never archived");
      r = await adm("POST", "/release-notes-writer/archive");
      assert.deepEqual([r.status, r.body.profile.status, r.body.profile.changes[0].action], [200, "archived", "archived"]);
      assert.equal((await adm("PUT", "/release-notes-writer", { version: 2, config: { ...body.config, budget_usd: 1.75 } })).status, 409, "an archived profile is not edited");
      const listed = (await app(mem.token, "GET", "/api/agent")).body.profiles.map((x: { id: string }) => x.id);
      assert.ok(!listed.includes("release-notes-writer"), "an archived profile is not offered");
      r = await app(own.token, "POST", "/api/agent", { message: "x", profile: "release-notes-writer" });
      assert.ok(r.status === 409 && /archived/.test(r.body.error), "nor started");
      r = await adm("POST", "/release-notes-writer/restore");
      assert.deepEqual([r.status, r.body.profile.status], [200, "active"]);
      const trail = await db.query<{ action: string; version: number; changed_by: string }>("SELECT action, version, changed_by FROM agent_profile_changes WHERE profile_id = 'release-notes-writer' ORDER BY id");
      assert.deepEqual(trail.map((x) => `${x.action}@${x.version}`), ["created@1", "edited@2", "archived@2", "restored@2"], "every change in the audit trail");
      assert.ok(trail.every((x) => x.changed_by === trail[0]!.changed_by && x.changed_by.length > 0), "each with who made it");
      ok("profiles: listed (the Default, version 1; the pack's, written once), created, edited as new versions, archived and restored by staff, each change audited with who, before and after; refused: an unpriced model, a path out of the workspace, a tool in two lists, an unknown workspace, a viewer, a budget over its ceiling, a staff viewer, an older version, an archived profile");
    }

    // c. role gating, d. per-workspace overrides
    {
      const offered = async (tok: string) => (await app(tok, "GET", "/api/agent")).body;
      assert.deepEqual((await offered(mem.token)).profiles.map((x: { id: string }) => x.id), ["default", "builder", "release-notes-writer"], "a member: every active profile for members");
      assert.deepEqual((await offered(view.token)).profiles, [], "a viewer: none");
      const b0 = (await adm("GET", "/builder")).body.profile;
      let r = await adm("PUT", "/builder", { version: b0.version, config: { ...b0.config, roles: ["owner"] } });
      assert.equal(r.status, 200);
      assert.ok(!(await offered(mem.token)).profiles.some((x: { id: string }) => x.id === "builder"), "for owners only: not offered to a member");
      r = await app(mem.token, "POST", "/api/agent", { message: "x", profile: "builder" });
      assert.ok(r.status === 403 && /for owners/.test(r.body.error), `refused to a member on the server too: ${r.body.error}`);
      r = await app(own.token, "POST", "/api/agent", { message: "x", profile: "builder" });
      assert.equal(r.status, 201, "an owner starts it");
      await app(own.token, "POST", `/api/agent/${r.body.session.id}/stop`, {});
      const b1 = (await adm("GET", "/builder")).body.profile;
      assert.equal((await adm("PUT", "/builder", { version: b1.version, config: { ...b1.config, roles: ["member", "owner"] } })).status, 200);
      await assert.rejects(H.startSession(W.orgId, { kind: "person", user: "user_billing", name: "billing@example.org", role: "billing" }, { message: "x", profile: "builder" }), /for members and owners/, "a billing manager is not one of its roles");
      assert.equal((await adm("POST", "", { name: "Members only", config: { roles: ["member"] } })).status, 201);
      await assert.rejects(H.startSession(W.orgId, H.actorOf(null, true), { message: "x", profile: "members-only" }), /an account key starts only a profile owners may start/, "an account key: only a profile owners may start");
      await adm("POST", "/members-only/archive");
      assert.equal((await app(mem.token, "POST", "/api/agent", { message: "x", profile: "no-such-profile" })).status, 404, "an unknown profile");
      // d. A named workspace's override: its own budget and model; every other workspace the profile's.
      const inW = await app(own.token, "POST", "/api/agent", { message: "x", profile: "release-notes-writer" });
      const inW2 = await app(own2.token, "POST", "/api/agent", { message: "x", profile: "release-notes-writer" });
      assert.deepEqual([inW.body.session.budget_usd, inW.body.session.harness.model], [1.25, priced], "this workspace: the profile's budget and model");
      assert.deepEqual([inW2.body.session.budget_usd, inW2.body.session.harness.model], [1.5, priced2], "the named workspace: its override");
      assert.deepEqual([inW.body.session.ceiling_usd, inW2.body.session.ceiling_usd], [2, 2], "the profile's ceiling");
      r = await app(mem.token, "POST", "/api/agent", { message: "x", profile: "release-notes-writer", budget_usd: 1.9 });
      assert.ok(r.status === 400 && /at most \$1\.25/.test(r.body.error), "a member cannot start over the profile's budget");
      await app(own.token, "POST", `/api/agent/${inW.body.session.id}/stop`, {});
      // A raise stays within the profile's ceiling.
      const parkedId = inW2.body.session.id;
      await db.query("UPDATE harness_sessions SET state = 'parked' WHERE id = $1", [parkedId]);
      await db.query("UPDATE runs SET status = 'cancelled' WHERE harness_session_id = $1", [parkedId]);
      await db.query("UPDATE harness_sessions SET current_run_id = NULL WHERE id = $1", [parkedId]);
      r = await app(own2.token, "POST", `/api/agent/${parkedId}/budget`, { to_usd: 2.5, reason: "more" });
      assert.ok(r.status === 400 && /at most \$2\.00/.test(r.body.error), `a raise past the profile's ceiling refused (${r.body.error})`);
      await app(own2.token, "POST", `/api/agent/${parkedId}/stop`, {});
      ok("role gating: a profile is offered and started only by its roles (a member refused an owners' profile on the server too, a billing manager not among them, a viewer none, an unknown profile not found); per-workspace overrides: the named workspace's budget and model, every other the profile's; the profile's budget and ceiling hold");
    }

    // e. tools free, ask and hidden; files written into the workspace; instructions; the frozen version; a stand-in CLI end to end
    let builtSid = "";
    {
      const owner = { kind: "person" as const, user: own.userId, name: "owner@example.org", role: "owner" as const };
      const s = await H.startSession(W.orgId, owner, { message: "said\nship it", profile: "builder" });
      builtSid = s.id;
      const rd = () => H.readSession(W.orgId, s.id, owner);
      const said = async (re: RegExp) => (await rd()).messages.some((m) => m.role === "agent" && re.test(m.body));
      const last = async () => (await rd()).messages.filter((m) => m.role === "agent").at(-1)?.body ?? "";
      let d = await rd();
      const version = d.profile!.version;
      assert.deepEqual([d.profile?.id, d.profile?.name], ["builder", "Build an application"]);
      const tool = (n: string) => d.reach!.tools.find((t) => t.name === n);
      assert.equal(tool("fx_put_item")?.asks, false, "free: a change that runs freely");
      assert.equal(tool("fx_peek")?.asks, true, "ask: a read that asks first");
      assert.equal(tool("list_records")?.asks, false, "a read the base leaves free");
      assert.equal(tool("fx_drop"), undefined, "hidden: not among its tools");
      assert.deepEqual(d.policy.hidden_tools, ["fx_drop"]);
      assert.deepEqual(d.policy.files, [".claude/skills/build/SKILL.md", "notes/brief.md"]);
      assert.deepEqual([d.policy.max_turns, d.policy.wake_max_minutes, d.policy.web_tools, d.policy.web_hosts, d.budget_usd, d.ceiling_usd], [12, 20, "fetch", ["docs.example.org"], 2, 3], "its limits and web access");
      assert.deepEqual(d.hooks.map((x) => [x.event, x.source]), [["on_start", "profile"], ["on_resume", "profile"], ["append_system", "profile"]], "its instructions, from the profile");
      const [row] = await db.query<{ profile_id: string; profile_version: number }>("SELECT profile_id, profile_version FROM harness_sessions WHERE id = $1", [s.id]);
      assert.deepEqual([row!.profile_id, row!.profile_version], ["builder", version], "the version frozen with the session");
      // Staff change the profile while it runs: the session keeps the version it started with.
      const b = (await adm("GET", "/builder")).body.profile;
      assert.equal((await adm("PUT", "/builder", { version: b.version, config: { ...b.config, instructions: { ...b.config.instructions, append_system: "You build applications. V2-MARK" } } })).status, 200);
      const w = await wake(s.id);
      await until("the first turn", () => said(/^Said: /));
      assert.equal(await last(), "Said: Plan first, then build. | said | ship it", "the first message: its on_start template around the person's words");
      assert.equal((await rd()).messages.find((m) => m.role === "person")!.body, "said\nship it", "the transcript keeps the person's own words");
      await H.messageSession(W.orgId, s.id, owner, "system");
      await until("its standing instructions", () => said(/^System: /));
      assert.ok((await last()).includes("You build applications. PROFILE-MARK") && !(await last()).includes("V2-MARK") && (await last()).includes("## This workspace"), "its profile's standing instructions, as frozen, then the workspace's");
      await H.messageSession(W.orgId, s.id, owner, "files");
      await until("its files", () => said(/^Files: /));
      assert.equal(await last(), "Files: .claude/skills/build/SKILL.md, notes/brief.md", "the profile's files in its working directory");
      await H.messageSession(W.orgId, s.id, owner, "cat .claude/skills/build/SKILL.md");
      await until("a file", () => said(/^File \.claude/));
      assert.equal(await last(), "File .claude/skills/build/SKILL.md: # Build skill | SKILL-MARK");
      // The hidden tool: never asked for; the server refuses the call. The free write runs; the read that asks stops it.
      await H.messageSession(W.orgId, s.id, owner, "mcp fx_drop {}");
      await until("the hidden tool", () => said(/^MCP fx_drop/));
      assert.match(await last(), /^MCP fx_drop refused: This session's agent profile does not give it fx_drop/, "hidden: refused by the server");
      assert.equal((await rd()).pending_request, null, "and never asked for");
      await H.messageSession(W.orgId, s.id, owner, `mcp fx_put_item {"key":"made-by-agent","summary":"free ${STAMP}"}`);
      await until("the free write", () => said(/^MCP fx_put_item/));
      assert.ok(!/refused|error/.test(await last()), await last());
      assert.equal((await ra.workspaceRecords("fixture_profiles", W.orgId).get("fx_apps", "made-by-agent"))?.data.summary, `free ${STAMP}`, "free: it wrote without asking");
      await H.messageSession(W.orgId, s.id, owner, "mcp fx_peek {}");
      await w.done;
      d = await rd();
      assert.deepEqual([d.phase, d.pending_request?.subject], ["awaiting_approval", "mcp__app__fx_peek"], "ask: a read the profile asks first for stops the wake with a request");
      await H.stopSession(W.orgId, s.id, owner);
      // The token, directly: tools/list leaves the hidden tool out; a request for it is refused.
      const s2 = await H.startSession(W.orgId, owner, { message: "x", profile: "builder" });
      assert.equal((await H.readSession(W.orgId, s2.id, owner)).profile!.version, version + 1, "a new session starts with the newer version");
      const c = (await client.claim([`${C.AGENT_PACK}/${C.AGENT_KIND}`]))!;
      const ws = await client.agent!.start(c.run.id, c.lease_token);
      assert.ok(ws.policy.files?.length === 2, "the wake is told its files");
      const res = await http.req("POST", "/mcp", { authorization: `Bearer ${ws.workspace!.token}`, accept: "application/json, text/event-stream" }, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      const tt = await res.text();
      const listed = (tt.trim().startsWith("{") ? JSON.parse(tt) : JSON.parse((tt.split("\n").find((l) => l.startsWith("data:")) ?? "data: {}").slice(5))).result.tools.map((x: { name: string }) => x.name);
      assert.ok(listed.includes("fx_put_item") && listed.includes("fx_peek") && !listed.includes("fx_drop"), `the hidden tool is not listed to the session (${listed.join(",")})`);
      await assert.rejects(client.agent!.request(c.run.id, c.lease_token, { kind: "tool", subject: "mcp__app__fx_drop" }), /does not give it fx_drop/, "a request for a hidden tool refused");
      await client.agent!.end(c.run.id, c.lease_token, { reason: "stopped" });
      await client.complete(c.run.id, c.lease_token, { outcome: "succeeded", results: [] });
      ok("a profile's session: free, ask and hidden tools (a change runs freely, a read asks first, the hidden one is never listed, asked for or served); its files in the working directory and its standing instructions reach the stand-in CLI, its on_start around the person's words; the version frozen while staff change the profile, the next session on the newer one");
    }

    // f. start_agent from a record: the template filled from the record on the server, the session linked back, its runs section
    {
      const rec = ra.workspaceRecords("fixture_profiles", W.orgId);
      await ra.asWriter({ by: "people", id: own.userId }, () => rec.put("fx_apps", "shop", { title: "Shop", data: { summary: "An online shop", stack: "typescript" } }));
      const page = async (tok: string) => app(tok, "GET", "/api/records/_page/fx_apps/shop");
      let p = await page(mem.token);
      assert.equal(p.status, 200, JSON.stringify(p.body));
      const a = p.body.actions.find((x: { id: string }) => x.id === "start_agent.builder");
      assert.deepEqual([a?.label, a?.place, a?.disabled, a?.agent?.message], ["Build", "primary", null, "Build the application Shop (shop) on typescript: An online shop"], "the Build button, its message filled from the record");
      assert.ok(!(await page(view.token)).body.actions.some((x: { id: string }) => x.id === "start_agent.builder"), "a viewer is not offered it");
      assert.equal((await app(view.token, "POST", "/api/records/_page/fx_apps/shop/actions/start_agent.builder", {})).status, 403, "nor may take it");
      const r = await app(mem.token, "POST", "/api/records/_page/fx_apps/shop/actions/start_agent.builder", { message: "whatever the browser says", profile: "release-notes-writer" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const sess = r.body.session;
      assert.deepEqual([sess.profile.id, sess.record, sess.title], ["builder", { area: "fx_apps", key: "shop" }, "Build an application: Shop"], "the action's profile, linked back to the record");
      assert.equal(sess.messages.find((m: { role: string }) => m.role === "person").body, "Build the application Shop (shop) on typescript: An online shop", "its first message from the record, not from the browser");
      p = await page(mem.token);
      const runs = p.body.sections["0-1"];
      assert.deepEqual(runs.sessions.rows.map((x: { id: string }) => x.id), [sess.id], "the record's runs section lists the session");
      assert.equal(runs.sessions.rows[0].profile.name, "Build an application");
      const other = await app(own2.token, "GET", "/api/records/_page/fx_apps/shop");
      assert.equal(other.status, 404, "another workspace never sees the record or its sessions");
      await H.stopSession(W.orgId, sess.id, H.actorOf({ user: mem.userId, email: "m@example.org", accountRole: "member" }));
      // The list tab's action: the Start a session dialog with the profile and its message.
      const t = await app(mem.token, "GET", "/api/tab-actions/fixture_profiles/apps");
      assert.deepEqual([t.body.kind, t.body.allowed, t.body.profile?.id, t.body.message], ["start_agent", true, "builder", "Plan a new application."], "the tab's action opens the dialog with its profile");
      assert.equal((await app(view.token, "GET", "/api/tab-actions/fixture_profiles/apps")).body.allowed, false, "not for a viewer");
      // Archived: the button stays, disabled with why; the server refuses it.
      const b = (await adm("POST", "/builder/archive")).body.profile;
      assert.equal(b.status, "archived");
      const dis = (await page(mem.token)).body.actions.find((x: { id: string }) => x.id === "start_agent.builder");
      assert.match(String(dis?.disabled), /archived/, "archived: disabled, with why");
      assert.equal((await app(mem.token, "POST", "/api/records/_page/fx_apps/shop/actions/start_agent.builder", {})).status, 409, "and refused");
      assert.equal((await app(mem.token, "GET", "/api/tab-actions/fixture_profiles/apps")).body.allowed, false);
      await adm("POST", "/builder/restore");
      // A price removed since the profile was saved: the start is refused, in words.
      await db.query("INSERT INTO model_prices (model, input_per_mtok, cached_input_per_mtok, output_per_mtok, source) VALUES ('claude-temp-261', 1, 0.1, 2, 'test') ON CONFLICT DO NOTHING");
      const { forgetPrices } = await import("../src/usage.js");
      forgetPrices();
      assert.equal((await adm("POST", "", { name: "Temporary", config: { model: "claude-temp-261" } })).status, 201);
      await db.query("DELETE FROM model_prices WHERE model = 'claude-temp-261'");
      forgetPrices();
      const gone = await app(own.token, "POST", "/api/agent", { message: "x", profile: "temporary" });
      assert.ok(gone.status === 409 && /no price/.test(gone.body.error), `a model whose price was removed refused at the start (${gone.body.error})`);
      ok("start_agent from a record: the Build button offered to the roles that may start its profile, its first message filled from the record on the server (never the browser's), the session linked back and listed in the record's runs section, never another workspace's; the list's action opens the dialog with its profile; archived: disabled with why and refused; a model whose price went: refused");
    }

    // g. off: nothing of it
    {
      F.setFeatureForTest("agent_harness", false);
      const p = await app(mem.token, "GET", "/api/records/_page/fx_apps/shop");
      assert.ok(!p.body.actions.some((x: { kind: string }) => x.kind === "start_agent"), "flag off: no start_agent action");
      assert.equal(p.body.sections["0-1"].sessions, undefined, "and no sessions in the runs section");
      await assert.rejects(P.listProfiles(), /not on/);
      F.setFeatureForTest("agent_harness", true);
      ok("off: no profile is read or written, no start_agent action, no session in a record's runs");
    }
    void builtSid;
    await http.close();
    setPacksForTest(null);
    F.setFeatureForTest("record_pages", null);
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

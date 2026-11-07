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
// 12. Agent profiles (mold_v0-261, redesigned by mold_v0-267; src/agent-profiles.ts, src/agent-governance.ts):
//     a. pure: exactly five items; the governance policy's rules (the web policy, matching, a download command, every
//        call decided with the reference's codes, exceptions until their date)
//     b. CRUD, versioning and audit; the editor's choices; the refusals
//     c. uploads: in parts to the object store, finished by sha256, within AGENT_UPLOAD_MAX_MB
//     d. a session end to end: uploads in its workspace (the binary runs), keys injected and redacted, the allowlisted
//        tool free and another ending it; the version frozen
//     e. the primary inference provider's key used by the gateway
//     f. governance enforced on egress: owner approvals, exactly one host, a package host never widening the network,
//        a decline ending it, refusals outright, approval_timeout
//     g. start_agent from a record; h. off: nothing of it
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

  // ---------- 12. agent profiles (mold_v0-261, redesigned by mold_v0-267; src/agent-profiles.ts, src/agent-profile-spec.ts,
  //            src/agent-governance.ts) ----------
  {
    const P = await import("../src/agent-profiles.js");
    const S = await import("../src/agent-profile-spec.js");
    const G = await import("../src/agent-governance.js");
    // a. pure: the five items and nothing else; the governance policy's rules as the reference states and enforces them.
    {
      const d = P.effectiveOf({});
      assert.deepEqual([d.harness, d.model, d.provider, d.key, d.from.model, d.governance], [settings.settingText("AGENT_HARNESS"), settings.settingText("AGENT_MODEL"), settings.settingText("AGENT_PROVIDER"), null, "setting", null],
        "the Default (nothing set): the platform settings");
      for (const old of [{ model: "claude-sonnet-5-5" }, { budget_usd: 2 }, { max_turns: 3 }, { instructions: { append_system: "x" } }, { roles: ["owner"] }, { tools: { free: ["a"] } }, { files: [] }, { overrides: [] }])
        assert.ok(!S.ProfileConfigSchema.safeParse(old).success, `${Object.keys(old)[0]}: not part of a profile any more`);
      assert.deepEqual(Object.keys(S.ProfileConfigSchema.shape).sort(), ["governance", "harness", "inference", "keys", "uploads"], "a profile is exactly its harness, key vault, uploads and governance");
      // The web policy: its domains read as hosts, its rules.
      assert.deepEqual(G.normalizeDomains(["https://Docs.Example.com/", "docs.example.com", "*.example.org"]), { domains: ["*.example.org", "docs.example.com"], problems: [] }, "a bare address is read as its host, once");
      assert.equal(G.normalizeDomains(["https://example.com/private"]).problems.length, 1, "an address with a path is refused, never trimmed (that would widen it)");
      assert.equal(G.normalizeDomains(["*", "example.com"]).problems.length, 1, "* only on its own");
      assert.equal(G.normalizeDomains(["10.0.0.1"]).problems.length, 1, "an address is no domain");
      const wp = (x: Partial<import("../src/agent-governance.js").WebPolicy>) => G.webPolicyProblems({ enabled: false, web_search_enabled: false, web_fetch_enabled: false, web_fetch_allowed_domains: [], max_calls: 0, ...x });
      assert.match(wp({ web_fetch_enabled: true }).join(), /disabled web policy cannot grant/);
      assert.match(wp({ enabled: true, max_calls: 3 }).join(), /at least one web tool/);
      assert.match(wp({ enabled: true, web_search_enabled: true }).join(), /call limit of at least 1/);
      assert.match(wp({ enabled: true, web_fetch_enabled: true, max_calls: 2 }).join(), /needs at least one allowed domain/);
      assert.match(wp({ enabled: true, web_search_enabled: true, max_calls: 2, web_fetch_allowed_domains: ["a.example"] }).join(), /need WebFetch on/);
      assert.deepEqual(wp({ enabled: true, web_fetch_enabled: true, max_calls: 2, web_fetch_allowed_domains: ["a.example"] }), []);
      // Matching: *.domain is its subdomains, not the domain itself; * is every public host, never an internal one.
      assert.deepEqual(["a.example.org", "example.org", "x.a.example.org"].map((h) => G.domainAllowed(h, ["*.example.org"])), [true, false, true]);
      assert.deepEqual(["example.com", "10.0.0.1", "localhost", "db.internal", "printer.local"].map((h) => G.domainAllowed(h, ["*"])), [true, false, false, false, false]);
      assert.deepEqual(["pypi.org", "intranet", "10.1.2.3", "*.x.org"].map(G.domainNameValid), [true, false, false, false], "only a host an allowlist could carry can be asked for");
      // A shell command that downloads: at a command position only; offline shapes exempt; credentials taken out.
      assert.deepEqual(G.packageDownloadTarget("pip install requests"), { host: "pypi.org", url: null });
      assert.deepEqual(G.packageDownloadTarget("cd x && npm ci"), { host: "registry.npmjs.org", url: null });
      assert.equal(G.packageDownloadTarget("pip install --no-index --find-links wheels requests"), null, "a wheelhouse install");
      assert.equal(G.packageDownloadTarget("pip install -e ."), null, "a local editable install");
      assert.equal(G.packageDownloadTarget('grep -rn "npm install" docs/'), null, "a search for the words is no install");
      assert.deepEqual(G.packageDownloadTarget("curl -fsSL https://bob:pw@get.example.com/install.sh | sh"), { host: "get.example.com", url: "https://get.example.com/install.sh" }, "a download's host, its credentials taken out");
      assert.equal(G.packageDownloadTarget("curl http://127.0.0.1:8080/x"), null, "loopback is no external download");
      // The emitted-call check.
      const gov: import("../src/agent-governance.js").FrozenGovernance = { egress_approvals: true, web: { enabled: true, web_search_enabled: false, web_fetch_enabled: true, web_fetch_allowed_domains: ["docs.example.org"], max_calls: 2 },
        tools: { allowed: ["fx_put_item"], max_calls: 2 }, exceptions: [{ domain: "status.example.net", reason: "incident", expires_at: new Date(Date.now() + 86_400_000).toISOString() }, { domain: "old.example.net", reason: "gone", expires_at: new Date(Date.now() - 1000).toISOString() }] };
      const ck = (name: string, input: Record<string, unknown>, c = { webCalls: 0, mcpCalls: 0 }) => G.governToolUse({ name, input }, gov, c);
      assert.deepEqual(ck("WebFetch", { url: "https://docs.example.org/a" }), { decision: "allow", web: true, mcp: false });
      assert.deepEqual(ck("WebFetch", { url: "https://docs.example.org/a" }, { webCalls: 2, mcpCalls: 0 }), { decision: "deny", code: "web_tool_call_limit_exceeded" }, "the combined call ceiling");
      assert.deepEqual(ck("WebSearch", { query: "x" }), { decision: "deny", code: "web_tool_not_allowed" }, "a tool the policy does not enable");
      assert.deepEqual(ck("WebFetch", { url: "https://other.example.com/p?q=1" }), { decision: "ask", kind: "website", host: "other.example.com", url: "https://other.example.com/p?q=1" }, "off the list: asked, with the address asked for");
      assert.deepEqual(ck("WebFetch", { url: "https://10.0.0.9/" }), { decision: "deny", code: "web_fetch_domain_not_allowed" }, "an address is never asked for");
      for (const u of ["http://docs.example.org/a", "https://docs.example.org:8443/a", "https://u:p@docs.example.org/a", "https://docs.example.org/a#f"])
        assert.deepEqual(ck("WebFetch", { url: u }), { decision: "deny", code: "web_fetch_domain_not_allowed" }, `${u}: https on 443, no credentials or fragment`);
      assert.equal(ck("WebFetch", { url: "https://status.example.net/" }).decision, "allow", "an exception in force");
      assert.equal(ck("WebFetch", { url: "https://old.example.net/" }).decision, "ask", "an exception past its date grants nothing");
      assert.deepEqual(ck("Bash", { command: "pip install requests" }), { decision: "ask", kind: "package", host: "pypi.org", url: null });
      assert.deepEqual(ck("Bash", { command: "ls -la" }), { decision: "pass" });
      assert.deepEqual(ck("mcp__app__fx_put_item", {}), { decision: "allow", web: false, mcp: true });
      assert.deepEqual(ck("mcp__app__fx_drop", {}), { decision: "deny", code: "mcp_tool_not_allowed" }, "a tool off the allowlist");
      assert.deepEqual(ck("mcp__app__fx_put_item", {}, { webCalls: 0, mcpCalls: 2 }), { decision: "deny", code: "mcp_call_limit_exceeded" });
      assert.deepEqual(G.governToolUse({ name: "WebFetch", input: { url: "https://other.example.com/" } }, { ...gov, egress_approvals: false }, { webCalls: 0, mcpCalls: 0 }), { decision: "deny", code: "web_fetch_domain_not_allowed" }, "approvals off: refused");
      assert.deepEqual(G.governedEgressHosts({ ...gov, web: { ...gov.web!, web_fetch_allowed_domains: ["*"] } }), ["status.example.net"], "* opens no host of the network: the run's isolation is unchanged");
      // The runner's check: a violation, an egress request, or the session's other rules.
      const pol = { ...C.currentPolicy(), governance: gov };
      assert.deepEqual(A.checkToolUse({ id: "1", name: "mcp__app__fx_drop", input: {} }, pol, 0), { ok: false, violation: "mcp_tool_not_allowed" });
      assert.deepEqual(A.checkToolUse({ id: "1", name: "Bash", input: { command: "npm install left-pad" } }, pol, 0), { ok: false, request: { kind: "web", subject: "registry.npmjs.org", egress: "package", url: null } });
      assert.deepEqual(A.checkToolUse({ id: "1", name: "Bash", input: { command: "ls" } }, pol, 0), { ok: true, web: false });
      assert.match(S.configProblems({ keys: [{ kind: "platform", provider: "exa", label: "a", env: "X_KEY" }, { kind: "platform", provider: "exa", label: "b", env: "X_KEY" }] }).join(), /one environment variable/);
      assert.match(S.configProblems({ governance: { tools: { allowed: ["a", "a"], max_calls: 1 } } }).join(), /listed twice/);
      ok("profiles, pure: exactly five items (no model, budget, turns, instructions, roles, tools, files or overrides of their own); the governance policy ported: domains read as hosts and checked, the web policy's rules, *.domain and * matched as the reference does, a download command found at a command position only (offline shapes exempt, credentials taken out), every call decided (allowed, asked for, refused with the reference's code), exceptions in force only until their date, * opening no network host");
    }

    // The world: a pack that brings a profile ("builder") and a record page whose Build button starts it.
    const { setPacksForTest } = await import("../src/packs.js");
    const { definePack, defineTool, z } = await import("../src/pack-api.js");
    const ra = await import("../src/record-areas.js");
    const kv = await import("../src/keyvault.js");
    F.setFeatureForTest("record_pages", true);
    const BUILDER = {
      id: "builder", name: "Build an application", description: "Builds an application from its record.",
      harness: "claude-code", inference: { provider: "anthropic", model: "claude-sonnet-5-5" },
      governance: { egress_approvals: true, web: { enabled: true, web_search_enabled: false, web_fetch_enabled: true, web_fetch_allowed_domains: ["docs.example.org"], max_calls: 5 }, tools: { allowed: ["fx_put_item", "list_records"], max_calls: 5 } },
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
    /** Upload bytes as the console does: start, its parts, finish. */
    const upload = async (bytes: Buffer, tok = staffTok) => {
      const s0 = await adm("POST", "/uploads", { bytes: bytes.length }, tok);
      if (s0.status !== 201) return s0;
      const u = s0.body.upload as { id: string; parts: number; part_bytes: number };
      for (let n = 0; n < u.parts; n++) {
        const r = await fetch(`${http.base}/api/admin/onboarding/agent-profiles/uploads/${u.id}/parts/${n}`, { method: "PUT", body: bytes.subarray(n * u.part_bytes, (n + 1) * u.part_bytes),
          headers: { authorization: `Bearer ${tok}`, "content-type": "application/octet-stream", "x-app-admin": "1", "x-pack-request": "1" } });
        assert.equal(r.status, 200, `part ${n}: ${await r.text()}`);
      }
      return adm("POST", `/uploads/${u.id}/complete`, {}, tok);
    };
    const [priced] = (await db.query<{ model: string }>("SELECT model FROM model_prices WHERE model = 'claude-sonnet-5-5'")).map((x) => x.model);
    assert.ok(priced, "a priced model");
    // The key vault: two Anthropic keys (the default one, and the one a profile names) and a platform key to inject.
    const PRIMARY = `sk-primary-${STAMP}-0123456789`, DEFAULT_KEY = `sk-default-${STAMP}-0123456789`, TOOL_KEY = `exa-tool-${STAMP}-0123456789`;
    await kv.setCredential("anthropic", DEFAULT_KEY, { label: "default", priority: 10 });
    await kv.setCredential("anthropic", PRIMARY, { label: "primary", priority: 0 });
    await kv.setCredential("exa", TOOL_KEY, { label: "agent" });

    // b. CRUD, versioning and audit; the refusals
    {
      let r = await adm("GET", "");
      assert.equal(r.status, 200);
      const byId = new Map((r.body.profiles as { id: string }[]).map((x) => [x.id, x as any]));
      assert.deepEqual([byId.get("default")?.version, byId.get("default")?.source, byId.get("default")?.is_default], [1, "platform", true], "the Default profile, version 1");
      assert.deepEqual([byId.get("builder")?.source, byId.get("builder")?.pack, byId.get("builder")?.version, byId.get("builder")?.model], ["pack", "fixture_profiles", 1, priced], "the pack's own, written once as version 1");
      assert.deepEqual(r.body.harnesses.map((x: { id: string }) => x.id), ["claude-code"], "the harness selector offers the pinned harnesses only");
      assert.ok(r.body.models.includes(priced) && !r.body.models.includes("claude-test-model"), "the priced models only");
      assert.deepEqual(r.body.providers.find((x: { id: string }) => x.id === "anthropic").keys.map((k: { label: string }) => k.label).sort(), ["default", "primary"], "the provider's key vault entries, by label");
      assert.ok(r.body.keys.platform.some((k: { provider: string; label: string }) => k.provider === "exa" && k.label === "agent") && !r.body.keys.platform.some((k: { provider: string }) => k.provider === "object_storage"), "platform keys a session may be given");
      assert.ok(["fx_put_item", "fx_peek", "fx_drop"].every((n) => r.body.tools.some((t: { name: string }) => t.name === n)), "the app's own tools, for an allowlist");
      assert.ok(r.body.upload_max_bytes > 0 && r.body.part_bytes === 4 * 1024 * 1024);
      P.resetProfileSeedForTest(); await P.ensureProfiles();
      assert.equal((await db.query("SELECT 1 FROM agent_profile_versions WHERE profile_id = 'builder'")).length, 1, "written once");
      const body = { name: "Release notes writer", description: "Writes release notes.", config: { harness: "claude-code", inference: { provider: "anthropic", model: priced, key: "primary" },
        keys: [{ kind: "platform", provider: "exa", label: "agent", env: "SEARCH_KEY" }],
        governance: { web: { enabled: true, web_search_enabled: true, web_fetch_enabled: true, web_fetch_allowed_domains: ["https://Docs.Example.com/"], max_calls: 4 }, retention_days: 7,
          exceptions: [{ domain: "status.example.net", reason: "an incident page", expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), approved_by: "someone else" }] } } };
      r = await adm("POST", "", body, readerTok);
      assert.equal(r.status, 403, "a staff viewer cannot create one");
      r = await adm("POST", "", body);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const made = r.body.profile;
      assert.deepEqual([made.id, made.version, made.changes[0].action, made.changes[0].before], ["release-notes-writer", 1, "created", null], "created as version 1, audited");
      assert.deepEqual(made.config.governance.web.web_fetch_allowed_domains, ["docs.example.com"], "its domains stored as hosts");
      assert.ok(made.config.governance.exceptions[0].approved_by !== "someone else" && made.config.governance.exceptions[0].approved_by.length > 0, "an exception is stamped with who saved it, whatever was sent");
      const exp = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
      for (const [why, b, re] of [
        ["an unpriced model", { name: "X1", config: { inference: { provider: "anthropic", model: "no-such-model" } } }, /no price/],
        ["a harness that is not pinned", { name: "X2", config: { harness: "codex" } }, /not a harness this platform runs/],
        ["a provider the harness does not speak to", { name: "X3", config: { inference: { provider: "openai", model: priced } } }, /speaks to anthropic/],
        ["an inference key not in the vault", { name: "X4", config: { inference: { provider: "anthropic", model: priced, key: "nope" } } }, /no anthropic key labelled nope/],
        ["a platform key not in the vault", { name: "X5", config: { keys: [{ kind: "platform", provider: "exa", label: "nope", env: "A_KEY" }] } }, /no exa key labelled nope/],
        ["a key that reaches every workspace", { name: "X6", config: { keys: [{ kind: "platform", provider: "object_storage", label: "default", env: "A_KEY" }] } }, /never given one/],
        ["a variable the session sets itself", { name: "X7", config: { keys: [{ kind: "platform", provider: "exa", label: "agent", env: "ANTHROPIC_API_KEY" }] } }, /sets itself/],
        ["WebFetch with no domain", { name: "X8", config: { governance: { web: { enabled: true, web_search_enabled: false, web_fetch_enabled: true, web_fetch_allowed_domains: [], max_calls: 2 } } } }, /at least one allowed domain/],
        ["an exception past 90 days", { name: "X9", config: { governance: { web: { enabled: true, web_search_enabled: false, web_fetch_enabled: true, web_fetch_allowed_domains: ["a.example"], max_calls: 2 }, exceptions: [{ domain: "b.example", reason: "r", expires_at: exp(120) }] } } }, /time-bounded/],
        ["an exception with no reason", { name: "X10", config: { governance: { web: { enabled: true, web_search_enabled: false, web_fetch_enabled: true, web_fetch_allowed_domains: ["a.example"], max_calls: 2 }, exceptions: [{ domain: "b.example", reason: " ", expires_at: exp(3) }] } } }, /say why/],
        ["a retention longer than the platform's", { name: "X11", config: { governance: { retention_days: 365 } } }, /never longer/],
        ["a tool allowlist with no ceiling", { name: "X12", config: { governance: { tools: { allowed: ["fx_peek"], max_calls: 0 } } } }, /call limit of at least 1/],
        ["an upload never made", { name: "X13", config: { uploads: [{ id: "upl_aaaaaaaaaaaaaaaaaaaaaaaa", path: "bin/x", bytes: 1, sha256: "0".repeat(64), executable: true }] } }, /was not uploaded/],
        ["the old shape (instructions)", { name: "X14", config: { instructions: { append_system: "x" } } }, /Unrecognized key|unrecognized/i],
        ["no name", { name: " ", config: {} }, /give the profile a name/],
      ] as const) { const x = await adm("POST", "", b); assert.ok(x.status === 400 && re.test(x.body.error), `${why}: ${x.status} ${x.body.error}`); }
      assert.equal((await adm("POST", "", body)).status, 409, "a second profile with one id refused");
      const c2 = { ...made.config, governance: { ...made.config.governance, retention_days: 5 } };
      r = await adm("PUT", "/release-notes-writer", { version: 1, config: c2 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const p2 = r.body.profile;
      assert.deepEqual([p2.version, p2.changes[0].action, p2.changes[0].changed, p2.config.governance.exceptions[0].approved_by], [2, "edited", ["governance"], made.config.governance.exceptions[0].approved_by],
        "an edit: a new version, audited with what changed; an unchanged exception keeps who approved it");
      assert.equal((await adm("GET", "/release-notes-writer/versions/1")).body.version.config.governance.retention_days, 7, "version 1 kept as it was");
      r = await adm("PUT", "/release-notes-writer", { version: 1, config: c2 });
      assert.ok(r.status === 409 && /saved version 2/.test(r.body.error), "an edit of an older version refused, never overwritten");
      assert.equal((await adm("PUT", "/release-notes-writer", { version: 2, config: c2 })).status, 400, "nothing changed: refused");
      assert.ok((await adm("POST", "/default/archive")).status === 409, "the Default is never archived");
      r = await adm("POST", "/release-notes-writer/archive");
      assert.deepEqual([r.status, r.body.profile.status], [200, "archived"]);
      assert.ok(!(await app(mem.token, "GET", "/api/agent")).body.profiles.some((x: { id: string }) => x.id === "release-notes-writer"), "an archived profile is not offered");
      r = await app(own.token, "POST", "/api/agent", { message: "x", profile: "release-notes-writer" });
      assert.ok(r.status === 409 && /archived/.test(r.body.error), "nor started");
      assert.equal((await adm("POST", "/release-notes-writer/restore")).status, 200);
      const trail = await db.query<{ action: string; version: number; changed_by: string }>("SELECT action, version, changed_by FROM agent_profile_changes WHERE profile_id = 'release-notes-writer' ORDER BY id");
      assert.deepEqual(trail.map((x) => `${x.action}@${x.version}`), ["created@1", "edited@2", "archived@2", "restored@2"], "every change in the audit trail");
      assert.ok(trail.every((x) => x.changed_by.length > 0), "each with who made it");
      // A viewer is offered nothing; budgets are the platform's.
      assert.deepEqual((await app(view.token, "GET", "/api/agent")).body.profiles, [], "a viewer: none");
      const started = await app(mem.token, "POST", "/api/agent", { message: "x", profile: "release-notes-writer" });
      assert.equal(started.status, 201, JSON.stringify(started.body));
      assert.deepEqual([started.body.session.budget_usd, started.body.session.ceiling_usd, started.body.session.harness.model], [1, 5, priced], "the platform's budget and ceiling; the profile's model");
      await app(mem.token, "POST", `/api/agent/${started.body.session.id}/stop`, {});
      ok("profiles: listed with the harnesses this platform runs, the providers' key vault entries, the priced models, the keys a session may be given and the app's tools; created, edited as new versions, archived and restored, every change audited; refused: an unpriced model, an unpinned harness, a provider the harness does not speak to, a key not in the vault, a key that reaches every workspace, a variable the session sets itself, the web policy's rules, an exception past 90 days or without a reason, a longer retention, a tool allowlist without a ceiling, an upload never made, the old shape, a staff viewer, an older version; budgets are the platform's");
    }

    // c. uploads: in parts to the object store, finished by their sha256, within the platform's limit
    let tool: { id: string; sha256: string; bytes: number; executable: boolean }, blob: typeof tool, skill: typeof tool;
    {
      const script = Buffer.from("#!/bin/sh\necho \"HELLO-$1 from $(basename \"$0\")\"\n");
      let r = await upload(script);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      tool = r.body.upload;
      assert.deepEqual([tool.bytes, tool.executable], [script.length, true], "a script is a program: executable by default");
      const big = Buffer.alloc(5 * 1024 * 1024 + 17);
      for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) % 251;
      r = await upload(big);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      blob = r.body.upload;
      assert.deepEqual([blob.bytes, blob.executable, blob.sha256], [big.length, false, (await import("node:crypto")).createHash("sha256").update(big).digest("hex")], "a large binary file in two parts, its sha256 the server's");
      skill = (await upload(Buffer.from("# Build skill\nSKILL-MARK\n"))).body.upload;
      assert.equal((await upload(Buffer.from("x"), readerTok)).status, 403, "a staff viewer uploads nothing");
      await saveSettingValues("test-staff", { AGENT_UPLOAD_MAX_MB: 5 });
      r = await adm("POST", "/uploads", { bytes: 6 * 1024 * 1024 });
      assert.ok(r.status === 413 && /AGENT_UPLOAD_MAX_MB/.test(r.body.error), `past the platform's limit: refused (${r.body.error})`);
      r = await adm("POST", "", { name: "Too big", config: { uploads: [{ id: blob.id, path: "data/blob.bin", bytes: blob.bytes, sha256: blob.sha256, executable: false }] } });
      assert.ok(r.status === 400 && /at most 5\.0 MB/.test(r.body.error), `a profile past the limit refused (${r.body.error})`);
      await saveSettingValues("test-staff", { AGENT_UPLOAD_MAX_MB: 200 });
      r = await adm("POST", "", { name: "Lies", config: { uploads: [{ id: tool.id, path: "bin/x", bytes: tool.bytes, sha256: "f".repeat(64), executable: true }] } });
      assert.ok(r.status === 400 && /not the file that was uploaded/.test(r.body.error), "an upload named with another sha256 refused");
      ok("uploads: a file in parts of at most 4 MiB to the object store (a 5 MB binary in two), finished by the sha256 the server computes, programs recognised as executable; refused past the platform's AGENT_UPLOAD_MAX_MB, to a staff viewer, and when a profile names it with another sha256");
    }

    // d. a profile's session end to end with the stand-in CLI: its harness, its keys injected and redacted, its uploads in
    //    the workspace (the binary runs), its allowlisted tool free and any other refused; the version frozen.
    let builder: any;
    {
      const b0 = (await adm("GET", "/builder")).body.profile;
      const config = { ...b0.config, inference: { provider: "anthropic", model: priced, key: "primary" },
        keys: [{ kind: "platform", provider: "exa", label: "agent", env: "SEARCH_KEY" }],
        uploads: [{ id: tool.id, path: "bin/hello", bytes: tool.bytes, sha256: tool.sha256, executable: true }, { id: blob.id, path: "data/blob.bin", bytes: blob.bytes, sha256: blob.sha256, executable: false },
          { id: skill.id, path: ".claude/skills/build/SKILL.md", bytes: skill.bytes, sha256: skill.sha256, executable: false }] };
      const r = await adm("PUT", "/builder", { version: b0.version, config });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      builder = r.body.profile;
      const owner = { kind: "person" as const, user: own.userId, name: "owner@example.org", role: "owner" as const };
      const s = await H.startSession(W.orgId, owner, { message: "files", profile: "builder" });
      const rd = () => H.readSession(W.orgId, s.id, owner);
      const said = async (re: RegExp) => (await rd()).messages.some((m) => m.role === "agent" && re.test(m.body));
      const last = async () => (await rd()).messages.filter((m) => m.role === "agent").at(-1)?.body ?? "";
      let d = await rd();
      assert.deepEqual([d.profile?.id, d.profile?.version, d.harness.model], ["builder", builder.version, priced]);
      assert.deepEqual(d.policy.files, ["bin/hello", "data/blob.bin", ".claude/skills/build/SKILL.md"]);
      assert.deepEqual([d.policy.executables, d.policy.credentials], [["bin/hello"], ["exa/agent"]]);
      assert.match(String(d.policy.governance), /fetch 1 host, 5 calls · 2 tools/);
      assert.deepEqual(d.reach!.tools.map((t) => t.name).sort(), ["fx_put_item", "list_records"], "the allowlist: the only tools it is shown");
      // Staff change the profile while it runs: the session keeps the version it started with.
      assert.equal((await adm("PUT", "/builder", { version: builder.version, config: { ...config, governance: { ...config.governance, retention_days: 3 } } })).status, 200);
      const w = await wake(s.id);
      await until("its files", () => said(/^Files: /));
      assert.equal(await last(), "Files: .claude/skills/build/SKILL.md, bin/hello, data/blob.bin", "its uploads in the working directory, folders kept");
      await H.messageSession(W.orgId, s.id, owner, "run ./bin/hello world");
      await until("the binary", () => said(/^Ran: /));
      assert.equal(await last(), "Ran: 0 HELLO-world from hello", "the uploaded binary is executable in the scratch workspace and runs");
      await H.messageSession(W.orgId, s.id, owner, "run wc -c < data/blob.bin && test ! -x data/blob.bin && echo not-executable");
      await until("the blob", () => said(/^Ran: 0 5242897/));
      assert.equal(await last(), "Ran: 0 5242897 | not-executable", "the large binary arrived whole, and only executables are executable");
      await H.messageSession(W.orgId, s.id, owner, "env SEARCH_KEY");
      await until("the key", () => said(/^Env SEARCH_KEY/));
      assert.equal(await last(), "Env SEARCH_KEY: [credential vault:exa/agent]", "the platform key in its variable, redacted on its way out");
      assert.ok(!(await rd()).messages.some((m) => m.body.includes(TOOL_KEY)), "the value never leaves the wake");
      const ev = await db.query<{ type: string; data: any }>("SELECT type, data FROM run_events WHERE run_id = $1 ORDER BY id", [w.claim.run.id]);
      assert.deepEqual(ev.find((e) => e.type === "credentials")?.data.delivered, ["vault:exa/agent"], "its run records the key's name, never its value");
      assert.ok(!JSON.stringify(ev).includes(TOOL_KEY));
      await H.messageSession(W.orgId, s.id, owner, `mcp fx_put_item {"key":"made-by-agent","summary":"free ${STAMP}"}`);
      await until("the allowed tool", () => said(/^MCP fx_put_item/));
      assert.equal((await ra.workspaceRecords("fixture_profiles", W.orgId).get("fx_apps", "made-by-agent"))?.data.summary, `free ${STAMP}`, "an allowlisted tool runs without asking");
      await H.messageSession(W.orgId, s.id, owner, "mcp fx_drop {}");
      await w.done;
      d = await rd();
      assert.deepEqual([d.phase, d.reason, d.pending_request], ["failed", "policy: mcp_tool_not_allowed", null], "a tool off the allowlist ends the session (the reference's mcp_tool_not_allowed), never asked for");
      assert.ok(d.messages.some((m) => /Stopped by this session's governance policy: an app tool its governance policy does not allow \(mcp_tool_not_allowed/.test(m.body)));
      assert.equal((await ra.workspaceRecords("fixture_profiles", W.orgId).get("fx_apps", "made-by-agent"))?.title, "App made-by-agent", "and nothing was dropped");
      const [row] = await db.query<{ profile_version: number; retention_until: Date }>("SELECT profile_version, retention_until FROM harness_sessions WHERE id = $1", [s.id]);
      assert.equal(row!.profile_version, builder.version, "the version frozen with the session");
      assert.ok(new Date(row!.retention_until).getTime() <= Date.now() + 60 * 86_400_000 + 60_000, "kept for the platform's retention (the profile's frozen version set none)");
      ok("a profile's session with the stand-in CLI: its uploads written into its workspace (a folder's paths kept), the uploaded binary executable and running there, a 5 MB file whole and not executable; its platform key in its variable and redacted, its run recording only the name; its allowlisted tool free, another tool ending it with mcp_tool_not_allowed; the version frozen while staff changed the profile");
    }

    // e. the primary inference provider: the gateway sends the session's requests with the key the profile chose.
    {
      const { createServer } = await import("node:http");
      const seen: string[] = [];
      const upstream = createServer((req, res) => { seen.push(String(req.headers["x-api-key"] ?? "")); req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [], usage: { input_tokens: 3, output_tokens: 2 } })); }); });
      await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
      const before = await kv.getProvider("anthropic");
      await kv.upsertProvider({ ...before!, upstream_url: `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}` });
      const owner = { kind: "person" as const, user: own.userId, name: "owner@example.org", role: "owner" as const };
      const call = async (token: string) => (await fetch(`${http.base}/gw/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": token, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: priced, max_tokens: 5, messages: [{ role: "user", content: "hi" }] }) })).status;
      for (const [profile, want] of [["builder", PRIMARY], ["default", DEFAULT_KEY]] as const) {
        const s = await H.startSession(W.orgId, owner, { message: "x", profile });
        const c = (await client.claim([`${C.AGENT_PACK}/${C.AGENT_KIND}`]))!;
        assert.equal(await call(c.gateway.token!), 200);
        assert.equal(seen.at(-1), want, `${profile}: the gateway used ${want === PRIMARY ? "the profile's chosen key" : "the provider's default key"}`);
        await client.agent!.end(c.run.id, c.lease_token, { reason: "stopped" });
        await client.complete(c.run.id, c.lease_token, { outcome: "succeeded", results: [] });
        await H.stopSession(W.orgId, s.id, owner).catch(() => null);
      }
      await kv.upsertProvider(before!);
      upstream.close();
      ok("the primary inference provider: a session of a profile that names its key sends its model requests with that key (the gateway's), one without uses the provider's default");
    }

    // f. governance enforced on egress, as the reference enforces it: approvals by a workspace owner, exactly one host to
    //    exactly that session (a package host never widening the network), a decline ending it, a refusal outright.
    {
      const owner = { kind: "person" as const, user: own.userId, name: "owner@example.org", role: "owner" as const };
      const member = { kind: "person" as const, user: mem.userId, name: "member@example.org", role: "member" as const };
      const s = await H.startSession(W.orgId, member, { message: "fetch https://docs.example.org/guide", profile: "builder" });
      const rd = () => H.readSession(W.orgId, s.id, member);
      const said = async (re: RegExp) => (await rd()).messages.some((m) => m.role === "agent" && re.test(m.body));
      let w = await wake(s.id);
      assert.deepEqual(await H.wakeEgressHosts(w.claim.run.id), ["docs.example.org"], "its run's egress: the hosts its policy names");
      await until("a listed website", () => said(/^Read docs\.example\.org/));
      await H.messageSession(W.orgId, s.id, member, "fetch https://other.example.com/page");
      await w.done;
      let d = await rd();
      assert.deepEqual([d.phase, d.pending_request?.kind, d.pending_request?.subject, d.pending_request?.detail.egress], ["awaiting_approval", "web", "other.example.com", "website"], "an unlisted website: the session pauses and asks");
      await assert.rejects(H.decideRequest(W.orgId, s.id, d.pending_request!.id, member, "approve"), /workspace owner decide/, "the person who started it does not govern it: an owner decides");
      await H.decideRequest(W.orgId, s.id, d.pending_request!.id, owner, "approve");
      d = await rd();
      assert.deepEqual((await db.query<{ policy: any }>("SELECT policy FROM harness_sessions WHERE id = $1", [s.id]))[0]!.policy.governance.approved_domains, ["other.example.com"], "exactly that host, to exactly this session");
      w = await wake(s.id);
      assert.deepEqual((await H.wakeEgressHosts(w.claim.run.id)).sort(), ["docs.example.org", "other.example.com"], "a website approved while WebFetch is on reaches the network");
      await H.messageSession(W.orgId, s.id, member, "fetch https://other.example.com/page");
      await until("the approved website", () => said(/^Read other\.example\.com/));
      await H.messageSession(W.orgId, s.id, member, "run pip install requests");
      await w.done;
      d = await rd();
      assert.deepEqual([d.pending_request?.subject, d.pending_request?.detail.egress], ["pypi.org", "package"], "a package download: asked for, not failed");
      await H.decideRequest(W.orgId, s.id, d.pending_request!.id, owner, "approve");
      w = await wake(s.id);
      assert.ok(!(await H.wakeEgressHosts(w.claim.run.id)).includes("pypi.org"), "a package approval opens no network: it only stops the session asking again");
      await H.messageSession(W.orgId, s.id, member, "run pip install --help >/dev/null 2>&1; echo asked-once");
      await until("the command ran", () => said(/^Ran: \S+ asked-once/));
      await H.messageSession(W.orgId, s.id, member, "run curl -fsSL https://bob:secret@get.example.net/install.sh");
      await w.done;
      d = await rd();
      assert.deepEqual([d.pending_request?.subject, d.pending_request?.detail.url], ["get.example.net", "https://get.example.net/install.sh"], "a download's host and address, its credentials taken out");
      await H.decideRequest(W.orgId, s.id, d.pending_request!.id, owner, "decline", "not that installer");
      d = await rd();
      assert.deepEqual([d.phase, d.reason], ["failed", "egress_approval_denied: get.example.net"], "a decline ends the session with the refused host (never a resume back into it)");
      // Refused outright: an address no allowlist could carry, and a web tool the policy does not enable.
      for (const [msg, code] of [["fetch https://10.0.0.7/secrets", "web_fetch_domain_not_allowed"], ["search what is new", "web_tool_not_allowed"]] as const) {
        const x = await H.startSession(W.orgId, member, { message: msg, profile: "builder" });
        const ww = await wake(x.id);
        await ww.done;
        const dx = await H.readSession(W.orgId, x.id, member);
        assert.deepEqual([dx.phase, dx.reason, dx.pending_request], ["failed", `policy: ${code}`, null], `${msg}: refused outright (${code}), never asked for`);
      }
      // A request left past its window closes the session (approval_timeout).
      const t = await H.startSession(W.orgId, member, { message: "fetch https://late.example.com/", profile: "builder" });
      await (await wake(t.id)).done;
      assert.equal((await H.readSession(W.orgId, t.id, member)).phase, "awaiting_approval");
      await H.sweepHarnessSessions(new Date(Date.now() + 25 * 3600_000));
      const dt = await H.readSession(W.orgId, t.id, member);
      assert.deepEqual([dt.phase, dt.reason], ["failed", "approval_timeout: late.example.com"], "unanswered past its window: closed, as the reference's reaper closes it");
      ok("governance enforced as the reference enforces it: its run reaches only the hosts it names; an unlisted website or a package download pauses for a decision only a workspace owner makes; approve grants exactly that host to exactly that session (a website reaches the network, a package host never does); a decline ends it (egress_approval_denied); an address or a web tool it does not enable is refused outright; a request past its window closes it (approval_timeout)");
    }

    // g. start_agent from a record: the template filled from the record on the server, the session linked back, its runs section
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
      assert.deepEqual(p.body.sections["0-1"].sessions.rows.map((x: { id: string }) => x.id), [sess.id], "the record's runs section lists the session");
      assert.equal((await app(own2.token, "GET", "/api/records/_page/fx_apps/shop")).status, 404, "another workspace never sees the record or its sessions");
      await H.stopSession(W.orgId, sess.id, H.actorOf({ user: mem.userId, email: "m@example.org", accountRole: "member" }));
      const t = await app(mem.token, "GET", "/api/tab-actions/fixture_profiles/apps");
      assert.deepEqual([t.body.kind, t.body.allowed, t.body.profile?.id, t.body.message], ["start_agent", true, "builder", "Plan a new application."], "the tab's action opens the dialog with its profile");
      assert.equal((await adm("POST", "/builder/archive")).body.profile.status, "archived");
      assert.match(String((await page(mem.token)).body.actions.find((x: { id: string }) => x.id === "start_agent.builder")?.disabled), /archived/, "archived: disabled, with why");
      assert.equal((await app(mem.token, "POST", "/api/records/_page/fx_apps/shop/actions/start_agent.builder", {})).status, 409, "and refused");
      await adm("POST", "/builder/restore");
      await db.query("INSERT INTO model_prices (model, input_per_mtok, cached_input_per_mtok, output_per_mtok, source) VALUES ('claude-temp-261', 1, 0.1, 2, 'test') ON CONFLICT DO NOTHING");
      const { forgetPrices } = await import("../src/usage.js");
      forgetPrices();
      assert.equal((await adm("POST", "", { name: "Temporary", config: { inference: { provider: "anthropic", model: "claude-temp-261" } } })).status, 201);
      await db.query("DELETE FROM model_prices WHERE model = 'claude-temp-261'");
      forgetPrices();
      const gone = await app(own.token, "POST", "/api/agent", { message: "x", profile: "temporary" });
      assert.ok(gone.status === 409 && /no price/.test(gone.body.error), `a model whose price was removed refused at the start (${gone.body.error})`);
      ok("start_agent from a record: the Build button, its first message filled from the record on the server, the session linked back and listed in the record's runs section, never another workspace's; the list's action; archived: disabled with why and refused; a model whose price went: refused");
    }

    // h. off: nothing of it
    {
      F.setFeatureForTest("agent_harness", false);
      const p = await app(mem.token, "GET", "/api/records/_page/fx_apps/shop");
      assert.ok(!p.body.actions.some((x: { kind: string }) => x.kind === "start_agent"), "flag off: no start_agent action");
      assert.equal(p.body.sections["0-1"].sessions, undefined, "and no sessions in the runs section");
      await assert.rejects(P.listProfiles(), /not on/);
      assert.equal((await adm("POST", "/uploads", { bytes: 1 })).status, 404, "no upload route");
      F.setFeatureForTest("agent_harness", true);
      ok("off: no profile is read or written, no upload taken, no start_agent action, no session in a record's runs");
    }
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

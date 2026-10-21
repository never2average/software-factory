/**
 * THE MAIN AGENT'S STOP, OFFLINE (mold_v1-294) — agent/lib/specialist-stop.ts over a world that answers as eve does,
 * no database, no runtime. What it checks:
 *
 *   scope      only the CALLING session's own delegations can be named: a specialist of another chat (its name, its
 *              call id, its session id) is not found and nothing is cancelled; a specialist's own session stops
 *              nothing; with owner records, a session that is not a main thread, or a specialist whose record names
 *              another root or another workspace, is refused before anything is sent
 *   names      the target is what the chat calls it ("Research 2"), its kind when only one of that kind is out, or its
 *              call id; two of one kind are never guessed between
 *   the stop   the reason is delivered FIRST, as the delegation's own result (SUBAGENT_STOPPED, the person reads it on
 *              the card), to the calling session only; THEN eve's cancel of that specialist's session; once, under the
 *              sweep's ledger claim (a second stop, or a sweep holding it, does nothing)
 *   the slot   a stop whose cancel did not reach the run is ended by the sweep's backstop on a later pass, which frees
 *              its sandbox (agent/lib/specialist-sweep.ts `frozenToEnd`, now for kind "stopped" too)
 *   refusals   finished, not handed over, unreadable: nothing sent, the chat's specialists listed by name
 *
 * Run: npm run test:specialist-stop
 */
const S = await import("../agent/lib/specialist-stop.ts");
const Sweep = await import("../agent/lib/specialist-sweep.ts");
const { STOPPED_CODE, isDetachedResult, isStoppedDelegation } = await import("../lib/detached-delegation.ts");
const { specialistNames, callsFromEvents, withOrdinal } = await import("../lib/specialist-names.ts");
const { agentStops } = await import("../lib/specialist-relay.ts");

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed++;
  else failures.push(what);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `\n         ${(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 900)}`}`);
};

const NOW = Date.parse("2026-10-19T12:00:00Z");
const at = (ago = 0) => ({ at: new Date(NOW - ago).toISOString() });
const base = (key) => ({ research: "Research", browser: "Browser", "follow-ups": "Follow-ups" })[key] ?? key;

/** A main thread that called `calls` ([key, callId, childSessionId]) and had each handed over as "reports later". */
function mainThread(calls, { finished = [], notDetached = [], notDetachable = [], token = "tok_A" } = {}) {
  const ev = [{ type: "turn.started", data: { turnId: "turn_0" }, meta: at(600_000) }];
  for (const [key, callId, child] of calls) {
    ev.push({ type: "subagent.called", data: { callId, childSessionId: child, name: key, toolName: key, turnId: "turn_0", ...(notDetachable.includes(callId) ? {} : { detachable: true }) }, meta: at(590_000) });
  }
  for (const [key, callId, child] of calls) {
    if (notDetached.includes(callId)) continue;
    ev.push({ type: "action.result", data: { result: { callId, kind: "subagent-result", subagentName: key, output: { status: "running", childSessionId: child, name: key, note: "…" } } }, meta: at(580_000) });
  }
  ev.push({ type: "turn.completed", data: { turnId: "turn_0" }, meta: at(570_000) }, { type: "session.waiting", data: { continuationToken: token }, meta: at(570_000) });
  for (const callId of finished) {
    const [key] = calls.find((c) => c[1] === callId);
    ev.push({ type: "action.result", data: { result: { callId, kind: "subagent-result", subagentName: key, output: "DONE" } }, meta: at(100_000) });
  }
  // The main agent is in a turn of its own now (the one calling the tool).
  ev.push({ type: "turn.started", data: { turnId: "turn_2" }, meta: at(5_000) });
  return ev;
}

/** eve, as far as the stop reaches it: two chats' streams, deliveries kept only for an owed call of THAT session. */
function world(streams, { owners, ledger = true, cancelDoesNothing = false, cancelFails = false } = {}) {
  const log = [];
  const rows = new Map();
  const w = {
    log,
    rows,
    streams,
    history: async (id) => (streams[id] ? [...streams[id]] : undefined),
    async deliver(parent, token, result) {
      log.push(`deliver ${parent} ${result.callId}`);
      const events = streams[parent] ?? [];
      const ok = token === `tok_${parent}`;
      const owed = events.some((e) => e.type === "action.result" && e.data.result.callId === result.callId && isDetachedResult(e.data.result));
      const settled = events.some((e) => e.type === "action.result" && e.data.result.callId === result.callId && !isDetachedResult(e.data.result));
      if (ok && owed && !settled) events.push({ type: "action.result", data: { result }, meta: at(0) });
      return ok;
    },
    async cancel(child) {
      log.push(`cancel ${child}`);
      if (cancelFails) throw new Error("runtime unreachable");
      if (!cancelDoesNothing) (streams[child] ??= []).push({ type: "turn.cancelled", data: {}, meta: at(0) }, { type: "session.waiting", data: {}, meta: at(0) });
      return "accepted";
    },
    ...(ledger
      ? {
          ledger: {
            async claim(row) {
              const k = `${row.parentSessionId}/${row.callId}`;
              if (rows.has(k)) return "held";
              rows.set(k, { ...row, status: "claimed" });
              return "won";
            },
            async settle(p, c, status) {
              const r = rows.get(`${p}/${c}`);
              if (r?.status === "claimed") r.status = status;
            },
          },
        }
      : {}),
    ...(owners ? { owners } : {}),
  };
  return w;
}

const A = () => mainThread([["research", "call_r1", "wrun_r1"], ["research", "call_r2", "wrun_r2"], ["browser", "call_b1", "wrun_b1"]], { token: "tok_A" });
const B = () => mainThread([["research", "call_x1", "wrun_x1"]], { token: "tok_B" });
const stop = (w, target, extra = {}) => S.stopSpecialist(w, { sessionId: "A", delegated: false, target, reason: "The person changed the question.", baseName: base, ...extra });

/* ---- names --------------------------------------------------------------------------------------------------------- */
{
  const names = specialistNames(callsFromEvents(A()), base);
  check("two of one kind are told apart in call order: Research, Research 2; another kind keeps its bare name", names.get("call_r1") === "Research" && names.get("call_r2") === "Research 2" && names.get("call_b1") === "Browser", [...names]);
  check("a name never changes once shown: a later call only adds a higher number", withOrdinal("Scout", 1) === "Scout" && withOrdinal("Scout", 3) === "Scout 3");
  const roster = S.chatSpecialists(A(), base);
  check("the chat's specialists, as the main agent is told them", JSON.stringify(roster.map((r) => [r.name, r.status])) === JSON.stringify([["Research", "working"], ["Research 2", "working"], ["Browser", "working"]]), roster);
}

/* ---- the stop ------------------------------------------------------------------------------------------------------ */
{
  const w = world({ A: A(), B: B() });
  const out = await stop(w, "Research 2");
  check("\"Research 2\" stops the second research specialist, not the first", out.stopped === true && out.callId === "call_r2" && out.name === "Research 2", out);
  check("the reason is delivered FIRST, to the calling chat only, then eve's cancel of that specialist alone", JSON.stringify(w.log) === JSON.stringify(["deliver A call_r2", "cancel wrun_r2"]), w.log);
  const delivered = w.streams.A.find((e) => e.type === "action.result" && e.data.result.callId === "call_r2" && e.data.result.isError);
  check("…as the delegation's own result: SUBAGENT_STOPPED, with the reason the person reads on the card", delivered?.data.result.output.code === STOPPED_CODE && /^Stopped by the main agent: The person changed the question\. It returned no result\.$/.test(delivered.data.result.output.message), delivered?.data.result);
  check("…under the sweep's ledger, kind \"stopped\", settled once told", w.rows.get("A/call_r2")?.kind === "stopped" && w.rows.get("A/call_r2")?.status === "sent", [...w.rows.values()]);
  check("the other chat's stream is untouched", w.streams.B.length === B().length);
  const again = await stop(w, "Research 2");
  check("a second stop of the same specialist does nothing: it has finished (stopped)", again.stopped === false && again.why === "already-finished" && w.log.length === 2, { again, log: w.log });
  const answer = S.stopAnswer(out);
  check("the main agent is told by name, plainly", answer.stopped === true && answer.name === "Research 2" && /was stopped/.test(answer.message), answer);
  check("…and the answer carries the delegation's call id, which the chat puts the reason on (not a name that could drift)", answer.callId === "call_r2", answer);
}
{
  const w = world({ A: A(), B: B() });
  const held = world({ A: A() });
  held.ledger.claim({ parentSessionId: "A", callId: "call_b1" });
  const out = await stop(held, "browser");
  check("a delegation the sweep (or another stop) holds is left to it: nothing sent", out.stopped === false && out.why === "held" && held.log.length === 0, { out, log: held.log });
  for (const target of ["research", "Research", "RESEARCH"]) {
    const amb = await stop(w, target);
    check(`two of one kind working: the kind or bare name "${target}" is never guessed between (the first is shown "Research", but the main agent says the kind for the one it just called)`, amb.stopped === false && amb.why === "ambiguous" && w.log.length === 0 && /"<name> 1"/.test(S.stopAnswer(amb).message), amb);
  }
  const first = await stop(w, "Research 1");
  check("…\"Research 1\" names the first of the kind exactly", first.stopped === true && first.callId === "call_r1", first);
  const kindNow = await stop(w, "research");
  check("…and once the first is stopped, the kind names the one still working", kindNow.stopped === true && kindNow.callId === "call_r2", kindNow);
  // A pack's given name ("Scout"): the names are Scout, Scout 2, and the kind is said by its directory name.
  const given = (key) => (key === "research" ? "Scout" : base(key));
  const g = world({ A: A() });
  const gStop = (target) => S.stopSpecialist(g, { sessionId: "A", delegated: false, target, reason: "r", baseName: given });
  const one = await gStop("research");
  check("a kind with two specialists working is never guessed between", one.stopped === false && one.why === "ambiguous" && g.log.length === 0 && one.specialists.map((x) => x.name).join() === "Scout,Scout 2,Browser", one);
  const r1 = await gStop("call_r1");
  check("…a call id names exactly one", r1.stopped === true && r1.callId === "call_r1", r1);
  const r2 = await gStop("research");
  check("…and once one of the kind has finished, the kind names the one still working", r2.stopped === true && r2.callId === "call_r2" && r2.name === "Scout 2", r2);
  const kind = await stop(world({ A: A() }), "BROWSER");
  check("a kind with one specialist names it, whatever the case", kind.stopped === true && kind.callId === "call_b1", kind);
}

/* ---- scope --------------------------------------------------------------------------------------------------------- */
{
  const w = world({ A: A(), B: B() });
  for (const target of ["call_x1", "wrun_x1", "wrun_r1", "Research 3"]) {
    const out = await stop(w, target);
    check(`another chat's specialist (or a session id) cannot be named from this chat: "${target}" is not found`, out.stopped === false && out.why === "not-found" && out.specialists.length === 3, out);
  }
  check("…and nothing was sent or cancelled anywhere", w.log.length === 0 && w.streams.B.length === B().length, w.log);
  const fromB = await S.stopSpecialist(w, { sessionId: "B", delegated: false, target: "Research 2", reason: "x", baseName: base });
  check("chat B names only its own: its \"Research 2\" does not exist, chat A's is out of reach", fromB.stopped === false && fromB.why === "not-found" && w.log.length === 0, fromB);
  const child = await S.stopSpecialist(w, { sessionId: "wrun_r1", delegated: true, target: "Research", reason: "x", baseName: base });
  check("a specialist's own session stops nothing", child.stopped === false && child.why === "not-a-main-thread" && w.log.length === 0, child);
  const empty = await S.stopSpecialist(w, { sessionId: "", delegated: false, target: "Research", reason: "x", baseName: base });
  check("no calling session, no stop", empty.stopped === false && empty.why === "not-a-main-thread");
}
{
  // Owner records: the calling session must be a main thread here; the specialist's record must name it as its root.
  const records = { A: { root: null }, wrun_r1: { root: "A" }, wrun_r2: { root: "OTHER" }, wrun_b1: { root: "A" } };
  const owners = {
    isMainThread: async (id) => !records[id]?.root,
    isOwnSpecialist: async (parent, child) => records[child]?.root === parent,
  };
  const w = world({ A: A() }, { owners });
  const foreign = await stop(w, "Research 2");
  check("a specialist whose owner record names another root (or another workspace) is refused before anything is sent", foreign.stopped === false && foreign.why === "not-yours" && w.log.length === 0, { foreign, log: w.log });
  const own = await stop(w, "Research 1");
  check("…its own is stopped", own.stopped === true && own.callId === "call_r1");
  const notMain = await S.stopSpecialist(world({ A: A() }, { owners: { ...owners, isMainThread: async () => false } }), { sessionId: "A", delegated: false, target: "Research", reason: "x", baseName: base });
  check("a session whose record says it is a delegation stops nothing", notMain.stopped === false && notMain.why === "not-a-main-thread");
  const failing = await S.stopSpecialist(world({ A: A() }, { owners: { isMainThread: async () => { throw new Error("db down"); }, isOwnSpecialist: async () => true } }), { sessionId: "A", delegated: false, target: "Research", reason: "x", baseName: base });
  check("an owner read that fails is a refusal, never a stop", failing.stopped === false && failing.why === "not-a-main-thread");
}

/* ---- refusals ------------------------------------------------------------------------------------------------------ */
{
  const finished = world({ A: mainThread([["research", "call_r1", "wrun_r1"]], { finished: ["call_r1"] }) });
  const done = await stop(finished, "Research");
  check("a finished specialist is not stopped, and the answer says so", done.stopped === false && done.why === "already-finished" && finished.log.length === 0 && /already finished/.test(S.stopAnswer(done).message), done);
  const batch = world({ A: mainThread([["research", "call_r1", "wrun_r1"]], { notDetached: ["call_r1"] }) });
  const inStep = await stop(batch, "Research");
  check("one the main agent's own step still waits on (not handed over) is not stoppable from here", inStep.stopped === false && inStep.why === "not-stoppable" && batch.log.length === 0, inStep);
  const old = world({ A: mainThread([["research", "call_r1", "wrun_r1"]], { notDetachable: ["call_r1"] }) });
  const legacy = await stop(old, "Research");
  check("nor one eve does not report home itself (started before the eve patch)", legacy.stopped === false && legacy.why === "not-stoppable" && old.log.length === 0, legacy);
  const unreadable = await stop(world({}), "Research");
  check("a history that cannot be read stops nothing", unreadable.stopped === false && unreadable.why === "unreadable");
  const listed = S.stopAnswer(await stop(world({ A: A() }), "nobody"));
  check("a name that matches none lists the chat's specialists by name and status, no ids", listed.stopped === false && JSON.stringify(listed.specialists) === JSON.stringify([{ name: "Research", status: "working" }, { name: "Research 2", status: "working" }, { name: "Browser", status: "working" }]), listed);
  check("a reason is one line, bounded, never empty", S.cleanReason("  a\n  b  ") === "a b" && S.cleanReason("").length > 0 && S.cleanReason("x".repeat(500)).length === S.STOP_REASON_MAX);
  const noLedger = world({ A: A() }, { ledger: false });
  const free = await stop(noLedger, "Browser");
  check("without a database (no ledger) the stop still works, through the stream alone", free.stopped === true && noLedger.log.join() === "deliver A call_b1,cancel wrun_b1", noLedger.log);
}

/* ---- the card reads a delivered stop as stopped, not failed ------------------------------------------------------- */
{
  // The card's error text is the result's message; the main agent's and the sweep's carry a reason, not the code.
  check("the main agent's stopped result reads as stopped on its card (not failed)", isStoppedDelegation(S.stoppedByMainAgentMessage("Not needed.")));
  check("…as does the sweep's", isStoppedDelegation("Stopped by the system: this specialist showed no progress for 31 minutes (the limit is 30). It returned no result."));
  check("…and an ordinary error is still not a stop", !isStoppedDelegation("The eval suite could not be loaded.") && !isStoppedDelegation("Research stopped by the main agent? no"));
}

/* ---- the card finds its stop by call id ---------------------------------------------------------------------------- */
{
  // The chat's names can drift from the agent's (a delegation whose start failed is named last on the chat's side,
  // a given name spoken on one side only): the reason goes on the card the tool's own call id names.
  const part = (output) => ({ type: "dynamic-tool", toolName: "stop_specialist", state: "output-available", input: { reason: " Not\n needed. " }, output });
  const byName = new Map([["Research 2", "call_WRONG"]]);
  const stops = agentStops([{ parts: [part({ stopped: true, name: "Research 2", callId: "call_r2" })] }], (n) => byName.get(n));
  check("a stop's reason lands on the card of the call id the tool answered with, not the one a drifted name maps to", stops.get("call_r2") === "Not needed." && !stops.has("call_WRONG"), [...stops]);
  const legacy = agentStops([{ parts: [part({ stopped: true, name: "Research 2" })] }], (n) => byName.get(n));
  check("…an answer without a call id (an older transcript) still falls back to the name", legacy.get("call_WRONG") === "Not needed.", [...legacy]);
  const refused = agentStops([{ parts: [part({ stopped: false, message: "x" })] }], () => "call_r2");
  check("…and a stop that did not take turns no card", refused.size === 0);
}

/* ---- a stop that could not be told ---------------------------------------------------------------------------------- */
{
  // No continuation token on the main thread yet (its first turn): the reason cannot be delivered as the result.
  const noToken = () => mainThread([["browser", "call_b1", "wrun_b1"]], { token: null });
  const down = world({ A: noToken() }, { cancelFails: true });
  const none = await stop(down, "Browser");
  check("neither told nor cancelled: nothing was stopped, and the tool says so (the card is not turned to stopped)", none.stopped === false && none.why === "unreachable" && /not stopped/.test(S.stopAnswer(none).message), none);
  check("…its ledger row is left \"pending\", which a later pass may take over, never \"stopped\"", down.rows.get("A/call_b1")?.status === "pending", [...down.rows.values()]);
  const quiet = world({ A: noToken() });
  const cancelled = await stop(quiet, "Browser");
  check("not told but cancelled: stopped, told false", cancelled.stopped === true && cancelled.told === false && quiet.log.join() === "cancel wrun_b1", { cancelled, log: quiet.log });
  check("…and its row is \"pending\", not \"stopped\": if eve's own stop report is lost, the sweep may still report it (a \"stopped\" row is never taken over)", quiet.rows.get("A/call_b1")?.status === "pending", [...quiet.rows.values()]);
}

/* ---- the slot: a cancel that does not reach the run is ended by the sweep's backstop ---------------------------------- */
{
  const w = world({ A: A(), wrun_r1: [{ type: "turn.started", data: {}, meta: at(60_000) }, { type: "step.started", data: {}, meta: at(30_000) }] }, { cancelDoesNothing: true });
  const out = await stop(w, "Research 1");
  check("the stop is sent even when the cancel does not reach the run", out.stopped === true && w.log.join() === "deliver A call_r1,cancel wrun_r1", w.log);
  // The sweep's ledger as agent/lib/sweep-ledger.ts answers it: kind "frozen" OR "stopped", told or stopped, not ended.
  let clock = NOW + 5 * 60_000;
  const ended = [];
  const ledger = {
    claim: async () => "held",
    settle: async () => {},
    surfaceWaiting: async () => {},
    clearWaiting: async () => {},
    frozenToEnd: async (p) =>
      [...w.rows.values()]
        .filter((r) => r.parentSessionId === p && ["frozen", "stopped"].includes(r.kind) && ["delivered", "sent", "stopped"].includes(r.status) && !r.ended)
        .map((r) => ({ callId: r.callId, childSessionId: r.childSessionId, stoppedAt: NOW })),
    ended: async (p, c) => void (w.rows.get(`${p}/${c}`).ended = true),
  };
  const sweepWorld = {
    history: w.history,
    handOver: async () => false,
    deliver: async () => true,
    cancel: async () => "accepted",
    terminate: async (child) => (ended.push(child), true),
    inSandboxLine: () => false,
    ledger,
    settings: { frozenMs: 30 * 60_000, graceMs: 2 * 60_000, waitingMs: 4 * 3_600_000 },
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  };
  await Sweep.sweepMainThread(sweepWorld, "A");
  check("a later sweep pass ends the run the cancel did not reach (its sandbox is freed), once", ended.join() === "wrun_r1" && w.rows.get("A/call_r1").ended === true, { ended, row: w.rows.get("A/call_r1") });
  await Sweep.sweepMainThread(sweepWorld, "A");
  check("…and not again", ended.length === 1);
}

console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED:\n  - ${failures.join("\n  - ")}` : ""}`);
process.exit(failures.length ? 1 : 0);

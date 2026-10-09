/**
 * THE SPECIALIST SWEEP'S RULES, OFFLINE (mold_v1-196) — agent/lib/specialist-sweep.ts over a world that answers as eve
 * does, no database, no runtime. What the real runtime does with the sweep's two operations (`handOver`,
 * `deliverLateResult`) is `npm run test:specialist-detach` (scenarios sweephandover, sweeprace, sweepstale); the
 * ledger across processes and workspaces is `npm run test:specialist-sweep-db`.
 *
 *   a  FROZEN       stopped with a plain reason, delivered once as the delegation's result, the run stopped (and
 *                   ended on a later pass when a cancel does not reach it); never one that wrote within the bound, one
 *                   waiting on a person, one waiting for a free sandbox, or one whose stream cannot be read; "not
 *                   started yet" is frozen only past the same bound (never less than 10 minutes: Vercel's queue)
 *   b  UNDELIVERED  finished, its result never reached the main agent: delivered once (detached), or handed over with
 *                   its batch (the turn was holding it), or handed over and then delivered (it was lost)
 *   c  UNREPORTED   stopped or crashed without a report: reported once as its result
 *   d  WAITING      on a person past the bound: surfaced, never stopped, cleared once answered
 *   races           the specialist's own result and the sweep's copy; two sweeps at once; a frozen one that wakes up;
 *                   eve's own stop report after the sweep's
 *
 * Run: npm run test:specialist-sweep
 */
const S = await import("../agent/lib/specialist-sweep.ts");
const { specialistSweepSettings } = await import("../agent/lib/specialist-sweep-settings.ts");
const { isDetachedResult } = await import("../lib/detached-delegation.ts");

let passed = 0;
const failures = [];
const check = (what, ok, detail) => {
  if (ok) passed++;
  else failures.push(what);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : `\n         ${(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 900)}`}`);
};

const MIN = 60_000;
const NOW = Date.parse("2026-10-07T12:00:00Z");
const at = (agoMs) => ({ at: new Date(NOW - agoMs).toISOString() });
const SETTINGS = { frozenMs: 30 * MIN, graceMs: 2 * MIN, waitingMs: 4 * 60 * MIN };

/* ---- a world that answers as eve does ---------------------------------------------------------------------------- */

/**
 * The main thread `P` and its specialists. `handOver` behaves as the patched eve's sweep hook: when a batch is waiting
 * (`batch.waiting`), every delegation of it still out gets a "reports later" stand-in, except those whose result the
 * turn is holding (`batch.held`), which get their real result. `deliver` behaves as the session driver: a result is
 * kept only while its call is owed as "reports later"; the first one written settles it, every later copy is dropped.
 */
function world({ parent, children, batch, inLine = [], unreadable = [] }) {
  const streams = { P: parent, ...children };
  const log = [];
  const rows = new Map();
  let clock = NOW;
  const realFor = (callId) => streams.P.some((e) => e.type === "action.result" && e.data.result.callId === callId && !isDetachedResult(e.data.result));
  const standFor = (callId) => streams.P.some((e) => e.type === "action.result" && e.data.result.callId === callId && isDetachedResult(e.data.result));
  const ledger = {
    async claim(row) {
      const k = `${row.parentSessionId}/${row.callId}`;
      const old = rows.get(k);
      if (old && !["surfaced", "cleared"].includes(old.status) && !(["pending", "sent", "claimed"].includes(old.status) && clock - old.at > 2 * MIN)) return "held";
      rows.set(k, { ...row, status: "claimed", at: clock });
      return "won";
    },
    async settle(p, c, status) {
      const r = rows.get(`${p}/${c}`);
      if (r?.status === "claimed") Object.assign(r, { status, at: clock });
    },
    async surfaceWaiting(row) {
      const k = `${row.parentSessionId}/${row.callId}`;
      const old = rows.get(k);
      if (!old || (old.kind === "waiting" && ["surfaced", "cleared"].includes(old.status))) rows.set(k, { ...row, kind: "waiting", status: "surfaced", at: clock });
    },
    async clearWaiting(p, still) {
      for (const r of rows.values()) if (r.parentSessionId === p && r.kind === "waiting" && r.status === "surfaced" && !still.includes(r.callId)) r.status = "cleared";
    },
    async frozenToEnd(p) {
      return [...rows.values()].filter((r) => r.parentSessionId === p && r.kind === "frozen" && ["delivered", "sent", "stopped"].includes(r.status) && !r.ended).map((r) => ({ callId: r.callId, childSessionId: r.childSessionId, stoppedAt: r.at }));
    },
    async ended(p, c) {
      const r = rows.get(`${p}/${c}`);
      if (r) r.ended = true;
    },
  };
  const w = {
    streams,
    log,
    rows,
    advance: (ms) => (clock += ms),
    history: async (id) => (unreadable.includes(id) ? undefined : [...(streams[id] ?? [])]),
    async handOver(p, callIds) {
      log.push(`handOver ${callIds.join(",")}`);
      if (!batch?.waiting || !callIds.includes(batch.first)) return false;
      batch.waiting = false;
      for (const id of batch.calls) {
        if (realFor(id)) continue;
        const called = streams.P.find((e) => e.type === "subagent.called" && e.data.callId === id).data;
        const result = batch.held?.[id] !== undefined
          ? { callId: id, kind: "subagent-result", subagentName: called.toolName, output: batch.held[id] }
          : { callId: id, kind: "subagent-result", subagentName: called.toolName, output: { status: "running", childSessionId: called.childSessionId, name: called.name, note: "…" } };
        streams.P.push({ type: "action.result", data: { result }, meta: { at: new Date(clock).toISOString() } });
      }
      streams.P.push({ type: "turn.completed", data: {}, meta: { at: new Date(clock).toISOString() } }, { type: "session.waiting", data: { continuationToken: "tok_P" }, meta: { at: new Date(clock).toISOString() } });
      return true;
    },
    async deliver(p, token, result) {
      log.push(`deliver ${result.callId} ${JSON.stringify(result.output).slice(0, 60)}`);
      if (token !== "tok_P") return false;
      if (standFor(result.callId) && !realFor(result.callId)) streams.P.push({ type: "action.result", data: { result }, meta: { at: new Date(clock).toISOString() } });
      return true;
    },
    async cancel(child) {
      log.push(`cancel ${child}`);
      if (w.cancelDoesNothing) return "accepted";
      streams[child].push({ type: "turn.cancelled", data: {}, meta: { at: new Date(clock).toISOString() } }, { type: "session.waiting", data: {}, meta: { at: new Date(clock).toISOString() } });
      return "accepted";
    },
    async terminate(child) {
      log.push(`terminate ${child}`);
      return true;
    },
    inSandboxLine: (id) => inLine.includes(id),
    ledger,
    settings: SETTINGS,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  };
  return w;
}

/** A main thread `P` that called `calls` in one step of turn_0; `standIns`: the ones handed over as "reports later". */
function mainThread(calls, { standIns = [], calledAgo = 60 * MIN, detachable = true, extra = [] } = {}) {
  const ev = [{ type: "turn.started", data: { turnId: "turn_0" }, meta: at(calledAgo + 1000) }];
  for (const [name, childSessionId] of calls) {
    ev.push({ type: "subagent.called", data: { callId: `call_${name}`, childSessionId, name, toolName: name, turnId: "turn_0", ...(detachable ? { detachable: true } : {}) }, meta: at(calledAgo) });
  }
  for (const name of standIns) {
    const childSessionId = calls.find(([n]) => n === name)[1];
    ev.push({ type: "action.result", data: { result: { callId: `call_${name}`, kind: "subagent-result", subagentName: name, output: { status: "running", childSessionId, name, note: "…" } } }, meta: at(calledAgo - 10_000) });
  }
  if (standIns.length) ev.push({ type: "turn.completed", data: {}, meta: at(calledAgo - 20_000) }, { type: "session.waiting", data: { continuationToken: "tok_P" }, meta: at(calledAgo - 20_000) });
  return [...ev, ...extra];
}
const finished = (agoMs, text = "THE RESULT") => [
  { type: "turn.started", data: { turnId: "turn_0" }, meta: at(agoMs + 60_000) },
  { type: "message.completed", data: { message: "thinking about it", finishReason: "tool-calls" }, meta: at(agoMs + 30_000) },
  { type: "message.completed", data: { message: text, finishReason: "stop" }, meta: at(agoMs) },
  { type: "turn.completed", data: {}, meta: at(agoMs) },
  { type: "session.completed", data: {}, meta: at(agoMs) },
];
const working = (lastAgoMs) => [
  { type: "turn.started", data: { turnId: "turn_0" }, meta: at(lastAgoMs + 120_000) },
  { type: "step.started", data: {}, meta: at(lastAgoMs + 60_000) },
  { type: "message.appended", data: { delta: "…" }, meta: at(lastAgoMs) },
];
const asking = (agoMs) => [
  { type: "turn.started", data: { turnId: "turn_0" }, meta: at(agoMs + 30_000) },
  { type: "input.requested", data: { requests: [{ requestId: "r1" }] }, meta: at(agoMs) },
  { type: "turn.completed", data: {}, meta: at(agoMs) },
  { type: "session.waiting", data: {}, meta: at(agoMs) },
];
const stopped = (agoMs) => [...working(agoMs + 60_000), { type: "turn.cancelled", data: {}, meta: at(agoMs) }, { type: "session.waiting", data: {}, meta: at(agoMs) }];
const crashed = (agoMs) => [...working(agoMs + 60_000), { type: "session.failed", data: { message: "Sandbox bootstrap failed" }, meta: at(agoMs) }];
const realResults = (w, name) => w.streams.P.filter((e) => e.type === "action.result" && e.data.result.callId === `call_${name}` && !isDetachedResult(e.data.result));

/* ---- reading -------------------------------------------------------------------------------------------------------- */

console.log("reading a main thread and a specialist:");
{
  const owed = S.owedDelegations(mainThread([["alpha", "c_a"], ["beta", "c_b"]], { standIns: ["beta"] }));
  check("two out: the one with a stand-in is 'detached', the other 'batch'", JSON.stringify(owed.map((d) => `${d.name}:${d.where}`)) === '["alpha:batch","beta:detached"]', owed);
  const done = mainThread([["alpha", "c_a"]], { extra: [{ type: "action.result", data: { result: { callId: "call_alpha", kind: "subagent-result", subagentName: "alpha", output: "x" } }, meta: at(0) }] });
  check("a real result settles it", S.owedDelegations(done).length === 0);
  const later = mainThread([["alpha", "c_a"]], { extra: [{ type: "turn.started", data: { turnId: "turn_1" }, meta: at(0) }] });
  check("a batch delegation with a later turn started is not owed (the batch went on)", S.owedDelegations(later).length === 0);
  const cancelled = mainThread([["alpha", "c_a"]], { extra: [{ type: "turn.cancelled", data: { turnId: "turn_0" }, meta: at(0) }] });
  check("…nor one whose turn was cancelled (eve settles that itself)", S.owedDelegations(cancelled).length === 0);
  const laterButDetached = mainThread([["alpha", "c_a"]], { standIns: ["alpha"], extra: [{ type: "turn.started", data: { turnId: "turn_1" }, meta: at(0) }] });
  check("a 'reports later' one stays owed across later turns", S.owedDelegations(laterButDetached).length === 1);
  check("its specialist's name for the result is the call's toolName", S.owedDelegations(mainThread([["alpha", "c_a"]]))[0].subagentName === "alpha");
  const f = S.childFacts(finished(10 * MIN, "FINAL"), NaN);
  check("a finished specialist's result is its last answer, not a step's text", f.kind === "finished" && f.result === "FINAL", f);
  check("stopped / crashed / asking / live are told apart", S.childFacts(stopped(MIN), NaN).kind === "stopped" && S.childFacts(crashed(MIN), NaN).kind === "failed" && S.childFacts(asking(MIN), NaN).kind === "asking" && S.childFacts(working(MIN), NaN).kind === "live");
  const none = S.childFacts([], NOW - 5 * MIN);
  check("one that wrote nothing yet is live, not started, its progress dated from its call", none.kind === "live" && none.started === false && none.lastAt === NOW - 5 * MIN, none);
}

console.log("\nsettings:");
{
  const d = specialistSweepSettings({});
  check("defaults: frozen 30 min, grace 120 s, waiting 4 h, window 72 h, on", d.enabled && d.frozenMs === 30 * MIN && d.graceMs === 120_000 && d.waitingMs === 4 * 60 * MIN && d.lookbackMs === 72 * 60 * MIN, d);
  const low = specialistSweepSettings({ SPECIALIST_SWEEP_FROZEN_MIN: "2", SPECIALIST_SWEEP_GRACE_S: "1" });
  check("floors: frozen never under 10 min (Vercel's queue delays a start up to 300 s), grace never under 30 s", low.frozenMs === 10 * MIN && low.graceMs === 30_000, low);
  const bad = specialistSweepSettings({ SPECIALIST_SWEEP_FROZEN_MIN: "soon", SPECIALIST_SWEEP_WAITING_H: "-3" });
  check("a value that is not a number keeps the default (a typo never turns the sweep off)", bad.frozenMs === 30 * MIN && bad.waitingMs === 4 * 60 * MIN && bad.enabled);
  check("SPECIALIST_SWEEP=off turns it off", specialistSweepSettings({ SPECIALIST_SWEEP: "off" }).enabled === false);
}

/* ---- (b) undelivered ------------------------------------------------------------------------------------------------ */

console.log("\n(b) finished, its result never handed back:");
{
  const w = world({ parent: mainThread([["alpha", "c_a"]], { standIns: ["alpha"] }), children: { c_a: finished(10 * MIN, "ALPHA SAYS 42") } });
  const out = await S.sweepMainThread(w, "P");
  check("delivered through the late-result path, as the delegation's own result", out.length === 1 && out[0].kind === "undelivered" && out[0].action === "delivered" && realResults(w, "alpha").length === 1 && realResults(w, "alpha")[0].data.result.output === "ALPHA SAYS 42", { out, log: w.log });
  check("…nothing was stopped", !w.log.some((l) => l.startsWith("cancel") || l.startsWith("terminate")), w.log);
  const again = await S.sweepMainThread(w, "P");
  check("a second pass finds nothing owed", again.length === 0 && realResults(w, "alpha").length === 1, again);
  const fresh = world({ parent: mainThread([["alpha", "c_a"]], { standIns: ["alpha"] }), children: { c_a: finished(30_000) } });
  check("within the grace period it is left to eve (nothing done)", (await S.sweepMainThread(fresh, "P")).length === 0 && fresh.log.length === 0, fresh.log);
}
{
  // The turn waits on a batch of two; alpha finished long ago and the turn HOLDS its result (its bound's timer was lost
  // with a restarted process); beta works on.
  const w = world({
    parent: mainThread([["alpha", "c_a"], ["beta", "c_b"]], { calledAgo: 20 * MIN }),
    children: { c_a: finished(15 * MIN, "HELD RESULT"), c_b: working(30_000) },
    batch: { waiting: true, first: "call_alpha", calls: ["call_alpha", "call_beta"], held: { call_alpha: "HELD RESULT" } },
  });
  const out = await S.sweepMainThread(w, "P");
  check("a batch holding a finished result is handed over: the main agent gets the specialist's OWN result there and then", out.length === 1 && out[0].action === "handed-over" && realResults(w, "alpha")[0]?.data.result.output === "HELD RESULT", { out, log: w.log });
  check("…the sibling still working goes on as 'reports later', untouched, and nothing is delivered on top", !w.log.some((l) => l.startsWith("deliver") || l.startsWith("cancel")) && w.streams.P.some((e) => e.type === "action.result" && e.data.result.callId === "call_beta" && isDetachedResult(e.data.result)), w.log);
}
{
  const w = world({
    parent: mainThread([["alpha", "c_a"]], { calledAgo: 20 * MIN }),
    children: { c_a: finished(15 * MIN, "LOST RESULT") },
    batch: { waiting: true, first: "call_alpha", calls: ["call_alpha"] },
  });
  const out = await S.sweepMainThread(w, "P");
  check("a lone delegation whose result was lost: handed over, then its result delivered, once", out[0]?.action === "delivered" && realResults(w, "alpha").length === 1 && realResults(w, "alpha")[0].data.result.output === "LOST RESULT" && w.log[0].startsWith("handOver"), { out, log: w.log });
}
{
  const w = world({ parent: mainThread([["alpha", "c_a"]], { calledAgo: 20 * MIN }), children: { c_a: finished(15 * MIN) }, batch: { waiting: false, first: "call_alpha", calls: ["call_alpha"] } });
  const out = await S.sweepMainThread(w, "P");
  check("no batch to hand over (a turn started under an older build): pending, nothing delivered blind", out[0]?.action === "pending" && !w.log.some((l) => l.startsWith("deliver")), { out, log: w.log });
  w.advance(3 * MIN);
  check("…and the next pass tries again", (await S.sweepMainThread(w, "P"))[0]?.action === "pending" && w.log.filter((l) => l.startsWith("handOver")).length === 2, w.log);
}

/* ---- (c) unreported ------------------------------------------------------------------------------------------------- */

console.log("\n(c) stopped or crashed, never reported:");
{
  const w = world({ parent: mainThread([["alpha", "c_a"], ["beta", "c_b"]], { standIns: ["alpha", "beta"] }), children: { c_a: stopped(10 * MIN), c_b: crashed(10 * MIN) } });
  const out = await S.sweepMainThread(w, "P");
  const a = realResults(w, "alpha")[0]?.data.result;
  const b = realResults(w, "beta")[0]?.data.result;
  check("a stopped one is reported once as stopped (SUBAGENT_STOPPED)", a?.isError === true && a.output.code === "SUBAGENT_STOPPED" && realResults(w, "alpha").length === 1, a);
  check("a crashed one is reported once with its failure (SUBAGENT_EXECUTION_FAILED, eve's message)", b?.isError === true && b.output.code === "SUBAGENT_EXECUTION_FAILED" && /Sandbox bootstrap failed/.test(b.output.message), b);
  check("…both as 'unreported', delivered", out.every((o) => o.kind === "unreported" && o.action === "delivered") && out.length === 2, out);
}

/* ---- (a) frozen ----------------------------------------------------------------------------------------------------- */

console.log("\n(a) frozen:");
{
  const w = world({ parent: mainThread([["alpha", "c_a"]], { standIns: ["alpha"], calledAgo: 90 * MIN }), children: { c_a: working(41 * MIN) } });
  const out = await S.sweepMainThread(w, "P");
  const r = realResults(w, "alpha")[0]?.data.result;
  check("no progress for 41 min: the main agent gets 'stopped' with the plain reason, once", out[0]?.kind === "frozen" && out[0].action === "delivered" && r?.isError === true && r.output.code === "SUBAGENT_STOPPED" && /no progress for 41 minutes \(the limit is 30\)/.test(r.output.message) && realResults(w, "alpha").length === 1, { out, r });
  const order = w.log.map((l) => l.split(" ")[0]);
  check("…delivered FIRST, then the specialist is stopped (so its own stop report finds the delegation settled)", order.indexOf("deliver") >= 0 && order.indexOf("deliver") < order.indexOf("cancel"), w.log);
  // eve's own stop report arrives after: dropped (the delegation is no longer owed).
  await w.deliver("P", "tok_P", { callId: "call_alpha", kind: "subagent-result", subagentName: "alpha", isError: true, output: { code: "SUBAGENT_STOPPED", message: "This specialist was stopped before it finished. It returned no result." } });
  check("…and eve's own stop report, arriving after, reaches the main agent as nothing more", realResults(w, "alpha").length === 1 && /no progress/.test(realResults(w, "alpha")[0].data.result.output.message));
  await S.sweepMainThread(w, "P");
  check("its run is at rest after the cancel: nothing more (no terminate)", !w.log.includes("terminate c_a") && [...w.rows.values()][0].ended === true, w.log);
}
{
  const w = world({ parent: mainThread([["alpha", "c_a"]], { standIns: ["alpha"], calledAgo: 90 * MIN }), children: { c_a: working(41 * MIN) } });
  w.cancelDoesNothing = true;
  await S.sweepMainThread(w, "P");
  w.advance(MIN);
  await S.sweepMainThread(w, "P");
  check("a cancel that does not reach it: not ended within the grace period", !w.log.includes("terminate c_a"), w.log);
  w.advance(3 * MIN);
  await S.sweepMainThread(w, "P");
  check("…then its run is ended (its sandbox freed), once", w.log.filter((l) => l === "terminate c_a").length === 1, w.log);
  await S.sweepMainThread(w, "P");
  check("…and not again", w.log.filter((l) => l === "terminate c_a").length === 1);
}
{
  const w = world({ parent: mainThread([["alpha", "c_a"], ["beta", "c_b"]], { calledAgo: 90 * MIN }), children: { c_a: working(45 * MIN), c_b: working(30_000) }, batch: { waiting: true, first: "call_alpha", calls: ["call_alpha", "call_beta"] } });
  const out = await S.sweepMainThread(w, "P");
  check("frozen inside a waiting batch: handed over, then 'stopped, and why' delivered, then stopped", out[0]?.action === "delivered" && /no progress/.test(realResults(w, "alpha")[0]?.data.result.output.message ?? "") && w.log.join("|").match(/^handOver.*\|deliver.*\|cancel c_a$/), { out, log: w.log });
  check("…the sibling still working is not stopped and has no result", !w.log.includes("cancel c_b") && realResults(w, "beta").length === 0);
}
{
  const w = world({ parent: mainThread([["alpha", "c_a"]], { calledAgo: 90 * MIN }), children: { c_a: working(45 * MIN) }, batch: { waiting: false, first: "call_alpha", calls: ["call_alpha"] } });
  const out = await S.sweepMainThread(w, "P");
  check("frozen in a batch with no sweep hook (an older build): stopped all the same; eve reports the stop itself", out[0]?.action === "stopped" && w.log.includes("cancel c_a") && !w.log.some((l) => l.startsWith("deliver")), { out, log: w.log });
}
{
  const cases = [
    ["wrote 5 minutes ago (still working)", { c_a: working(5 * MIN) }, {}],
    ["waits on a person for 10 hours", { c_a: asking(10 * 60 * MIN) }, {}],
    ["waits for a free sandbox, silent for 40 minutes", { c_a: working(40 * MIN) }, { inLine: ["c_a"] }],
    ["cannot be read", { c_a: working(40 * MIN) }, { unreadable: ["c_a"] }],
  ];
  for (const [label, children, opts] of cases) {
    const w = world({ parent: mainThread([["alpha", "c_a"]], { standIns: ["alpha"], calledAgo: 90 * MIN }), children, ...opts });
    const out = await S.sweepMainThread(w, "P");
    check(`never stopped: one that ${label}`, !w.log.some((l) => l.startsWith("cancel") || l.startsWith("deliver") || l.startsWith("terminate")) && realResults(w, "alpha").length === 0 && out.every((o) => o.kind !== "frozen"), { out, log: w.log });
  }
  const notYet = world({ parent: mainThread([["alpha", "c_a"]], { standIns: ["alpha"], calledAgo: 8 * MIN }), children: { c_a: [] } });
  check("one not started yet 8 minutes after its call (Vercel's queue can delay a start 300 s) is left alone", (await S.sweepMainThread(notYet, "P")).length === 0 && notYet.log.length === 0);
  const never = world({ parent: mainThread([["alpha", "c_a"]], { standIns: ["alpha"], calledAgo: 40 * MIN }), children: { c_a: [] } });
  const nOut = await S.sweepMainThread(never, "P");
  check("…one that never started in 40 minutes is frozen", nOut[0]?.kind === "frozen" && nOut[0].action === "delivered", nOut);
}
{
  const w = world({ parent: mainThread([["alpha", "c_a"]], { standIns: ["alpha"], calledAgo: 90 * MIN, detachable: false }), children: { c_a: working(60 * MIN) } });
  check("a delegation eve does not report itself (not detachable: an older session, a program's) is left alone", (await S.sweepMainThread(w, "P")).length === 0 && w.log.length === 0);
}

/* ---- (d) waiting ---------------------------------------------------------------------------------------------------- */

console.log("\n(d) waiting on a person:");
{
  const w = world({ parent: mainThread([["alpha", "c_a"]], { standIns: ["alpha"], calledAgo: 6 * 60 * MIN }), children: { c_a: asking(5 * 60 * MIN) } });
  const out = await S.sweepMainThread(w, "P");
  check("past the bound: surfaced, and nothing else (not stopped, nothing delivered)", out[0]?.kind === "waiting" && out[0].action === "surfaced" && w.log.length === 0 && [...w.rows.values()][0].status === "surfaced", { out, log: w.log });
  const short = world({ parent: mainThread([["alpha", "c_a"]], { standIns: ["alpha"] }), children: { c_a: asking(60 * MIN) } });
  check("within the bound: nothing at all", (await S.sweepMainThread(short, "P")).length === 0 && short.rows.size === 0);
  w.streams.c_a.push({ type: "step.started", data: {}, meta: { at: new Date(NOW).toISOString() } });
  await S.sweepMainThread(w, "P");
  check("once answered (it works again), the note is cleared", [...w.rows.values()][0].status === "cleared", [...w.rows.values()]);
}

/* ---- races ---------------------------------------------------------------------------------------------------------- */

console.log("\nraces:");
{
  // The specialist's own late result lands between the sweep's look and its delivery.
  const w = world({ parent: mainThread([["alpha", "c_a"]], { standIns: ["alpha"] }), children: { c_a: finished(10 * MIN, "SWEEP COPY") } });
  const deliver = w.deliver;
  w.deliver = async (p, t, r) => {
    await deliver("P", "tok_P", { ...r, output: "THE SPECIALIST'S OWN" });
    return deliver(p, t, r);
  };
  const out = await S.sweepMainThread(w, "P");
  check("the specialist's own result and the sweep's copy land together: the main agent gets ONE (the first)", realResults(w, "alpha").length === 1 && realResults(w, "alpha")[0].data.result.output === "THE SPECIALIST'S OWN" && out[0]?.action === "delivered", { out, n: realResults(w, "alpha").length });
}
{
  const w = world({ parent: mainThread([["alpha", "c_a"]], { standIns: ["alpha"] }), children: { c_a: finished(10 * MIN) } });
  const [one, two] = await Promise.all([S.sweepMainThread(w, "P"), S.sweepMainThread(w, "P")]);
  const actions = [...one, ...two].map((o) => o.action).sort().join("+");
  check(`two sweeps at once (the schedule and a turn start): one acts, the other stands down (${actions}); one result`, actions === "delivered+held" && realResults(w, "alpha").length === 1 && w.log.filter((l) => l.startsWith("deliver")).length === 1, { actions, log: w.log });
}
{
  const w = world({ parent: mainThread([["alpha", "c_a"]], { standIns: ["alpha"], calledAgo: 90 * MIN }), children: { c_a: working(41 * MIN) } });
  const history = w.history;
  let reads = 0;
  w.history = async (id) => {
    if (id === "c_a" && ++reads === 1) w.streams.c_a.push({ type: "message.appended", data: { delta: "awake" }, meta: { at: new Date(NOW).toISOString() } });
    return history(id);
  };
  const out = await S.sweepMainThread(w, "P");
  check("a specialist that writes as the sweep looks is working, not frozen: left alone", out.length === 0 && w.log.length === 0, { out, log: w.log });
}
{
  // A copy delivered for a delegation that is not owed (already settled) changes nothing.
  const w = world({ parent: mainThread([["alpha", "c_a"]], { standIns: ["alpha"] }), children: { c_a: finished(10 * MIN, "FIRST") } });
  await S.sweepMainThread(w, "P");
  await w.deliver("P", "tok_P", { callId: "call_alpha", kind: "subagent-result", subagentName: "alpha", output: "LATE COPY" });
  check("a copy after the delivery reaches the main agent as nothing more", realResults(w, "alpha").length === 1 && realResults(w, "alpha")[0].data.result.output === "FIRST");
}

/* ---- what the person reads ------------------------------------------------------------------------------------------ */

console.log("\nthe chat's notes (lib/specialist-sweep-client.ts, the profile's words):");
{
  const C = await import("../lib/specialist-sweep-client.ts");
  const notes = C.readSweepNotes({ notes: [
    { kind: "frozen", status: "delivered", name: "research", facts: { name: "research", minutes: 34, limit: 30 }, since: NOW - 34 * MIN, at: NOW },
    { kind: "undelivered", status: "delivered", name: "reviewer", facts: {}, since: null, at: NOW },
    { kind: "unreported", status: "delivered", name: "filer", facts: { how: "failed" }, since: null, at: NOW },
    { kind: "unreported", status: "delivered", name: "filer", facts: { how: "stopped" }, since: null, at: NOW },
    { kind: "waiting", status: "surfaced", name: "approver", facts: {}, since: NOW - 5 * 60 * MIN, at: NOW },
    { kind: "nonsense", name: "x" }, { kind: "frozen" }, null,
  ] });
  check("the agent's answer is read defensively (unknown kinds and nameless notes left out)", notes.length === 5, notes);
  const lines = notes.map((n) => C.sweepNoteText(n, NOW));
  check("frozen: who, for how long, and that the main agent was told", lines[0] === "research showed no progress for 34 minutes, so it was stopped. The main agent has been told.", lines[0]);
  check("undelivered / failed / stopped each say what happened", /reviewer had finished, but its result had not reached the main agent/.test(lines[1]) && /filer failed without reporting back/.test(lines[2]) && /filer stopped without reporting back/.test(lines[3]), lines);
  check("waiting: how long, in plain units", lines[4] === "approver has been waiting for your answer for 5 hours.", lines[4]);
  check("plain units: minutes, hours, days", C.waitedText(45 * MIN) === "45 minutes" && C.waitedText(MIN) === "1 minute" && C.waitedText(5 * 60 * MIN) === "5 hours" && C.waitedText(3 * 24 * 60 * MIN) === "3 days");
  check("the words are the deployment profile's (a relabelling profile says them its own way)", C.sweepNoteText(notes[0], NOW, { frozen: "{name} stalled {minutes}m", undelivered: "", stopped: "", failed: "", waiting: "" }) === "research stalled 34m");
  check("an unreadable answer is no notes", C.readSweepNotes(null).length === 0 && C.readSweepNotes({ notes: "x" }).length === 0);
}

/* ---- the scheduled pass's one line (mold_v1-198) --------------------------------------------------------------------- */

console.log("\nthe scheduled pass writes one line, every time:");
{
  const R = await import("../agent/lib/specialist-sweep-run.ts");
  const SHAPE = /^\[specialist-sweep\] pass: \d+ thread\(s\) checked in \d+ workspace\(s\), \d+ delegation\(s\) outstanding, acted on \d+ \(frozen \d+, undelivered \d+, unreported \d+, surfaced \d+\) in \d+ ms$/;
  const on = { enabled: true, frozenMs: 30 * MIN, graceMs: 2 * MIN, waitingMs: 4 * 60 * MIN, lookbackMs: 72 * 60 * MIN };
  const run = async (db, settings = on) => {
    const out = [];
    const err = [];
    let t = 1_000;
    const tally = await R.sweepAllWorkspaces(db, { settings, log: (l) => out.push(l), logError: (l) => err.push(l), now: () => (t += 7) });
    return { out, err, tally };
  };
  const idle = await run({ listOrgs: async () => [], inOrg: async () => [] });
  check("a pass with nothing to do still writes exactly one line, of the fixed shape", idle.out.length === 1 && idle.err.length === 0 && SHAPE.test(idle.out[0]) && /pass: 0 thread\(s\) checked in 0 workspace\(s\), 0 delegation\(s\) outstanding, acted on 0/.test(idle.out[0]), idle);
  const broke = await run({ listOrgs: async () => { throw new Error("database\n  went away"); }, inOrg: async () => [] });
  check("a pass that fails writes its one line to the error log, with the error (on one line)", broke.out.length === 0 && broke.err.length === 1 && /^\[specialist-sweep\] pass: .* in \d+ ms; stopped early: database went away$/.test(broke.err[0]) && broke.tally.error === "database\n  went away", broke);
  const nodb = await run(null);
  check("…as does one with no database", nodb.err.length === 1 && /stopped early: no database configured$/.test(nodb.err[0]), nodb);
  const off = await run({ listOrgs: async () => ["w"], inOrg: async () => [] }, { ...on, enabled: false });
  check("SPECIALIST_SWEEP=off: one line saying so", off.out.length === 1 && off.out[0] === "[specialist-sweep] pass: off (SPECIALIST_SWEEP=off)", off.out);
  const line = R.sweepPassLine({ workspaces: 2, threads: 4, outstanding: 3, frozen: 1, undelivered: 1, unreported: 0, surfaced: 2 }, 812.4);
  check("the counts: acted on = frozen + undelivered + unreported; surfaced shown beside, not counted as acted", line === "[specialist-sweep] pass: 4 thread(s) checked in 2 workspace(s), 3 delegation(s) outstanding, acted on 2 (frozen 1, undelivered 1, unreported 0, surfaced 2) in 812 ms", line);
  const outstanding = { outstanding: 0 };
  const w2 = world({ parent: mainThread([["alpha", "c_a"], ["beta", "c_b"]], { standIns: ["alpha", "beta"] }), children: { c_a: working(MIN), c_b: finished(10 * MIN) } });
  await S.sweepMainThread(w2, "P", outstanding);
  check("the outstanding count is every delegation the main thread still waits on (2), not only those acted on (1)", outstanding.outstanding === 2, outstanding);
}

/* ---- what a read sees settled for good (mold_v1-199) ----------------------------------------------------------------- */

console.log("\nthe delegations a read sees settled for good (the schedule does not read the thread for them again):");
{
  const result = (name, output = "x") => ({ type: "action.result", data: { result: { callId: `call_${name}`, kind: "subagent-result", subagentName: name, output } }, meta: at(0) });
  const p = mainThread([["alpha", "c_a"], ["beta", "c_b"], ["gamma", "c_g"]], { standIns: ["alpha", "beta"], extra: [result("alpha")] });
  check("a delivered one is settled; one still 'reports later' is not; one in a batch still waiting is not", JSON.stringify(S.settledChildren(p)) === '["c_a"]', S.settledChildren(p));
  const moved = mainThread([["alpha", "c_a"]], { extra: [{ type: "turn.started", data: { turnId: "turn_1" }, meta: at(0) }] });
  check("a batch eve settled itself (a later turn started) is settled", JSON.stringify(S.settledChildren(moved)) === '["c_a"]');
  const cancelled = mainThread([["alpha", "c_a"]], { extra: [{ type: "turn.cancelled", data: { turnId: "turn_0" }, meta: at(0) }] });
  check("…as is one whose turn was cancelled", JSON.stringify(S.settledChildren(cancelled)) === '["c_a"]');
  check("one eve does not report home itself (never swept) is settled", JSON.stringify(S.settledChildren(mainThread([["alpha", "c_a"]], { detachable: false }))) === '["c_a"]');
  check("a thread with no delegation has nothing to settle", S.settledChildren([{ type: "turn.started", data: { turnId: "turn_0" } }]).length === 0);

  // Through the sweep: what it reports as settled is what the main thread's stream said when it was read.
  const w = world({ parent: mainThread([["alpha", "c_a"], ["beta", "c_b"]], { standIns: ["alpha", "beta"], extra: [result("beta", "B")] }), children: { c_a: finished(10 * MIN, "A"), c_b: finished(20 * MIN, "B") } });
  const counts = { outstanding: 0, settled: [] };
  const out = await S.sweepMainThread(w, "P", counts);
  check("the sweep reports the settled ones of the read it acted on (beta), not the one it is delivering now (alpha)", JSON.stringify(counts.settled) === '["c_b"]' && out.length === 1 && out[0].action === "delivered" && counts.outstanding === 1, { counts, out });
  const again = { outstanding: 0, settled: [] };
  await S.sweepMainThread(w, "P", again);
  check("…and the next read sees alpha settled too, and nothing outstanding", JSON.stringify(again.settled.sort()) === '["c_a","c_b"]' && again.outstanding === 0, again);
  const unread = { outstanding: 0, settled: [] };
  await S.sweepMainThread(world({ parent: mainThread([["alpha", "c_a"]], { extra: [result("alpha")] }), children: {}, unreadable: ["P"] }), "P", unread);
  check("a main thread whose stream cannot be read settles nothing", unread.settled.length === 0, unread);
}

console.log("\nan agent deployed before drizzle/0035 (no settled marks table): the old list, never no list:");
{
  const L = await import("../agent/lib/sweep-ledger.ts");
  const missing = Object.assign(new Error('relation "specialist_sweep_settled" does not exist'), { code: "42P01" });
  const calls = [];
  const db = { inOrg: async (_org, fn) => fn({ execute: async (q) => { calls.push(q); if (calls.length === 1) throw missing; return [{ id: "P" }, { id: "Q" }]; } }) };
  const errors = [];
  const keep = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  let ids;
  let marked = "threw";
  try {
    ids = await L.sweepCandidates(db, "w", 3_600_000);
    await L.markSettled({ inOrg: async () => { throw missing; } }, "w", "P", ["c_a"]);
    marked = "ok";
  } finally {
    console.error = keep;
  }
  check("the candidates fall back to every thread that delegated in the window (as before), said once", JSON.stringify(ids) === '["P","Q"]' && calls.length === 2 && errors.length === 1 && /apply drizzle\/0035/.test(errors[0]), { ids, calls: calls.length, errors });
  check("…and marking is skipped without an error", marked === "ok");
  const down = { inOrg: async () => { throw Object.assign(new Error("connection terminated"), { code: "57P01" }); } };
  check("any other database error is still an error (the pass says it stopped early)", await L.sweepCandidates(down, "w", 3_600_000).then(() => false, (e) => /connection terminated/.test(e.message)));
}

/* ---- reading a long history once per process, not once per pass (mold_v1-199) --------------------------------------- */

console.log("\nreading a long history: once per process, then only what is new (mold_v1-199):");
{
  const Wd = await import("../agent/lib/specialist-sweep-world.ts");
  /** A runtime whose streams cost something per event served (the local world reads one file per event). */
  const runtime = (streams, { everyMs = 0, per = 50 } = {}) => {
    const rt = {
      served: 0,
      async events(id, startIndex = 0) {
        const all = streams[id] ?? [];
        let i = startIndex < 0 ? Math.max(0, all.length + startIndex) : startIndex;
        return new ReadableStream({
          async pull(c) {
            if (i >= all.length) return; // a live session's stream stays open
            if (everyMs && i % per === 0) await new Promise((r) => setTimeout(r, everyMs));
            rt.served++;
            c.enqueue(JSON.parse(JSON.stringify(all[i++])));
          },
        });
      },
    };
    return rt;
  };
  const N = 3000;
  const long = () => {
    const ev = [{ type: "turn.started", data: { turnId: "turn_0" }, meta: at(60 * MIN) }];
    for (let i = 0; i < N; i++) ev.push(i % 50 === 0 ? { type: "step.started", data: { i }, meta: at(50 * MIN) } : { type: "message.delta", data: { delta: `piece ${i}` }, meta: at(50 * MIN) });
    ev.push({ type: "input.requested", data: { requests: [{ requestId: "r1" }] }, meta: at(5 * 60 * MIN) }, { type: "turn.completed", data: {}, meta: at(5 * 60 * MIN) }, { type: "session.waiting", data: {}, meta: at(5 * 60 * MIN) });
    return ev;
  };
  const streams = { L: long() };
  const rt = runtime(streams);
  const first = await Wd.wholeHistory(rt)("L");
  const servedFirst = rt.served;
  const second = await Wd.wholeHistory(rt)("L"); // the next pass: a new world, as runtimeWorld makes one per main thread
  const servedSecond = rt.served - servedFirst;
  check(`the next pass reads only the tail (${servedSecond} event(s) served), not the ${streams.L.length} again`, servedSecond <= 2 && Array.isArray(second) && second.length === first?.length, { servedFirst, servedSecond });
  check("…and what it returns is the whole history the sweep needs: every event but the streaming noise", first.length === streams.L.filter((e) => !e.type.endsWith(".delta")).length && first.at(-1).type === "session.waiting" && S.childFacts(first, NaN).kind === "asking", { n: first.length });
  streams.L.push({ type: "message.delta", data: { delta: "more" }, meta: at(0) });
  const grown = await Wd.wholeHistory(rt)("L");
  check("a session that wrote something since: only that is read; its last event is kept even when it is noise (the time of the last progress)", grown.at(-1).type === "message.delta" && grown.at(-1).data.delta === "more" && grown.length === first.length + 1, grown.slice(-2).map((e) => e.type));
  streams.L.push({ type: "message.delta", data: { delta: "and more" }, meta: at(0) }, { type: "step.completed", data: {}, meta: at(0) });
  const again = await Wd.wholeHistory(rt)("L");
  check("…a noise event that is no longer the last is not kept", again.length === first.length + 1 && again.at(-1).type === "step.completed" && !again.some((e) => e.data?.delta === "more"), again.slice(-3).map((e) => e.type));

  // Too long to read in one go: what was read is kept, and the next pass goes on from there.
  const slowStreams = { M: long() };
  const slow = runtime(slowStreams, { everyMs: 15, per: 50 });
  const errors = [];
  const keep = console.error;
  console.error = (...a) => errors.push(a.map(String).join(" "));
  const attempts = [];
  try {
    for (let pass = 0; pass < 12 && !(attempts.at(-1)?.ok); pass++) {
      const got = await Wd.wholeHistory(slow, 300)("M");
      attempts.push({ ok: Array.isArray(got), n: got?.length, served: slow.served });
    }
  } finally {
    console.error = keep;
  }
  const whole = attempts.at(-1);
  check(`a history longer than one read's time is read whole after ${attempts.length} passes, each going on where the last stopped`, whole?.ok === true && attempts.length > 1 && whole.n === slowStreams.M.filter((e) => !e.type.endsWith(".delta")).length, attempts);
  check(`…serving each event about once (${slow.served} served for ${slowStreams.M.length})`, slow.served <= slowStreams.M.length + 3 * attempts.length, { served: slow.served });
  check("…and each pass that ran out of time says so in one log line", errors.length === attempts.length - 1 && errors.every((e) => /not read whole in time/.test(e)), errors.slice(0, 2));

  // Two reads of one session at once (a turn start's sweep and the schedule) share it: nothing is read twice.
  const both = runtime({ B: long() });
  const [x, y] = await Promise.all([Wd.wholeHistory(both)("B"), Wd.wholeHistory(both)("B")]);
  check("two reads at once return the same history, with no event twice", x.length === y.length && x.length === first.length && new Set(x.map((e) => JSON.stringify(e))).size === x.length && both.served <= N + 4 + 4, { x: x.length, y: y.length, served: both.served });
  const fresh = runtime({ C: long() });
  Wd.clearHistoryCache(fresh);
  check("a runtime's cache is its own (another runtime reads from the start)", (await Wd.wholeHistory(fresh)("C")).length === first.length && fresh.served > N);
}

console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED:\n  - ${failures.join("\n  - ")}` : ""}`);
process.exit(failures.length ? 1 : 0);

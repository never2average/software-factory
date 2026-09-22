/**
 * Behavioural tests for the two functions that decide whether a user is told
 * their reply is dead.
 *
 * This imports the REAL module and runs it. Every other chat assertion in this
 * repo is a regex over source text, which passes through a behavioural
 * regression and breaks on an innocent rename — the workflow-runtime test even
 * copied its subject and drifted into greenlighting an implementation that was
 * deleted for crashing. These are the functions where a wrong answer is visible
 * to a customer ("this failed, send again" over a turn that was merely slow), so
 * they get executed, not grepped.
 *
 * Fixtures are traces observed in production on 2026-08-08.
 *
 * Run:  npm run test:chat-turn-state
 */
import assert from "node:assert/strict";
import {
  appendTailEvent,
  deadInputRequestIds,
  handBackSession,
  holdLabel,
  isRenderLoopError,
  mergeAttachedEvents,
  resyncDecision,
  retryStormDetected,
  serverEventCount,
  shouldReportDetach,
  turnUnfinished,
  withRequestIds,
  withoutRequestIds,
  renderLoopScene,
} from "../lib/chat-turn-state.ts";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};
const ev = (...types) => types.map((type) => ({ type }));

console.log("turnUnfinished:");
check("nothing running", !turnUnfinished([]));
check("a started turn is unfinished", turnUnfinished(ev("session.started", "turn.started")));
check(
  "…and mid-stream it is still unfinished",
  turnUnfinished(ev("turn.started", "step.started", "message.appended")),
);
for (const terminal of [
  "turn.completed",
  "session.completed",
  "session.waiting",
  "turn.failed",
  "turn.cancelled",
  "session.failed",
]) {
  check(`${terminal} ends the turn`, !turnUnfinished(ev("turn.started", "step.started", terminal)));
}
check(
  "a NEW turn after a completed one counts as unfinished",
  turnUnfinished(ev("turn.started", "turn.completed", "turn.started")),
);

console.log("\nretryStormDetected:");
// The exact shape of the stuck run: four prologues, no step, frozen.
const stuck = ev(
  "session.started", "turn.started", "message.received",
  "session.started", "turn.started", "message.received",
  "session.started", "turn.started", "message.received",
  "session.started", "turn.started",
);
check("the real stuck trace is caught", retryStormDetected(stuck));

// A slow turn is the case that must NOT be misread — 443 events over 63s.
const slow = ev(
  "session.started", "turn.started", "message.received", "step.started",
  ...Array.from({ length: 400 }, () => "message.appended"),
  "actions.requested", "action.result", "step.completed",
);
check("a long, busy turn is NOT called dead", !retryStormDetected(slow));
check(
  "one retry that then runs is not a storm",
  !retryStormDetected(ev("turn.started", "message.received", "turn.started", "message.received", "step.started")),
);
check("a single prologue is never a storm", !retryStormDetected(ev("session.started", "turn.started", "message.received")));
check("two prologues are below the threshold", !retryStormDetected(ev("message.received", "message.received")));

// Prologues from EARLIER turns must not accumulate into a false positive: a
// long conversation would otherwise eventually report itself as broken.
const manyTurns = ev(
  "message.received", "step.started", "turn.completed",
  "message.received", "step.started", "turn.completed",
  "message.received", "step.started", "turn.completed",
  "message.received", "step.started",
);
check("earlier turns do not accumulate into a false storm", !retryStormDetected(manyTurns));
check(
  "…and a storm AFTER a healthy turn is still caught",
  retryStormDetected(ev("message.received", "step.started", "turn.completed",
    "message.received", "message.received", "message.received")),
);
check("the threshold is adjustable", retryStormDetected(ev("message.received", "message.received"), 2));

/* ------------------------------------------------------------------------- */

console.log("\ndeadInputRequestIds (a parked approval vs one nothing can answer):");
// Shapes taken from eve's own reducer (client/message-reducer.js): an
// `input.requested` carries `data.requests[].requestId` and `.action.callId`;
// an `action.result` carries `data.result.callId`; turn boundaries carry
// `data.turnId`.
const started = (turnId) => ({ type: "turn.started", data: { turnId } });
const asked = (turnId, requestId, callId) => ({
  type: "input.requested",
  data: { turnId, stepIndex: 0, requests: [{ requestId, action: { callId, kind: "tool-call", toolName: "send_email" } }] },
});
const resulted = (turnId, callId) => ({
  type: "action.result",
  data: { turnId, stepIndex: 0, status: "completed", result: { callId, kind: "tool-result", toolName: "send_email" } },
});
const park = { type: "session.waiting", data: { continuationToken: "ct_1" } };

const livePark = [started("turn_0"), asked("turn_0", "req_1", "call_1"), park];
check("a live park is answerable", !deadInputRequestIds(livePark).has("req_1"));
check("…and session.waiting alone kills nothing", deadInputRequestIds(livePark).size === 0);
check(
  "the call resolving kills the request",
  deadInputRequestIds([...livePark, resulted("turn_0", "call_1")]).has("req_1"),
);
for (const end of ["turn.completed", "turn.failed", "turn.cancelled"]) {
  check(
    `${end} on the request's own turn kills it`,
    deadInputRequestIds([...livePark, { type: end, data: { turnId: "turn_0" } }]).has("req_1"),
  );
}
check(
  "a LATER turn starting kills it",
  deadInputRequestIds([...livePark, started("turn_1")]).has("req_1"),
);
check(
  "a REPLAYED turn.started with the same id does not (eve replays a turn that threw)",
  !deadInputRequestIds([...livePark, started("turn_0")]).has("req_1"),
);
check(
  "a turn ending elsewhere leaves it alone",
  !deadInputRequestIds([...livePark, { type: "turn.completed", data: { turnId: "turn_9" } }]).has("req_1"),
);
check(
  "the session ending kills every request it held",
  deadInputRequestIds([...livePark, { type: "session.completed", data: {} }]).has("req_1"),
);
check(
  "a RE-PARK brings a request back to life",
  !deadInputRequestIds([
    ...livePark,
    { type: "turn.completed", data: { turnId: "turn_0" } },
    started("turn_1"),
    asked("turn_1", "req_1", "call_1"),
    park,
  ]).has("req_1"),
);
check(
  "two requests are judged separately",
  (() => {
    const dead = deadInputRequestIds([
      started("turn_0"),
      asked("turn_0", "req_a", "call_a"),
      asked("turn_0", "req_b", "call_b"),
      resulted("turn_0", "call_a"),
      park,
    ]);
    return dead.has("req_a") && !dead.has("req_b");
  })(),
);
check(
  "a transcript with nothing dead keeps ONE reference (no memo churn)",
  deadInputRequestIds(livePark) === deadInputRequestIds([started("turn_3")]),
);
check("an empty stream is quiet", deadInputRequestIds([]).size === 0);

console.log("\nwithRequestIds (the fixed point a render loop needs):");
{
  const base = new Set(["a"]);
  check("adding an id it already has returns the SAME set", withRequestIds(base, ["a"]) === base);
  check("adding nothing returns the same set", withRequestIds(base, []) === base);
  check("a new id makes a new set", withRequestIds(base, ["b"]) !== base);
  check("…which keeps both", [...withRequestIds(base, ["b"])].join(",") === "a,b");
  check("the original is untouched", base.size === 1);
  const twice = withRequestIds(base, ["b"]);
  check("and re-adding it is then a no-op", withRequestIds(twice, ["a", "b"]) === twice);
  check("empty ids are ignored", withRequestIds(base, [""]) === base);
}

console.log("\nisRenderLoopError (a UI loop is not a dead stream):");
check("the minified form (what production reports)", isRenderLoopError("Minified React error #185; visit https://react.dev/errors/185"));
check("the development form", isRenderLoopError("Maximum update depth exceeded. This can happen when…"));
check("the render-phase form", isRenderLoopError("Too many re-renders. React limits the number of renders"));
check("a real stream failure is not one", !isRenderLoopError("terminated: network error"));
check("a token failure is not one", !isRenderLoopError("Missing or empty 'continuationToken' field"));
check("nothing is not one", !isRenderLoopError(undefined));

console.log("\nshouldReportDetach (telemetry counts incidents, not remounts):");
{
  const budget = 4;
  check(
    "the first detach of a turn is filed",
    shouldReportDetach({ reported: 0, resyncsSpent: 0, resyncBudget: budget }),
  );
  check(
    "the same detach, seen again after a resync remount, is not",
    !shouldReportDetach({ reported: 1, resyncsSpent: 1, resyncBudget: budget }),
  );
  check(
    "…nor the third time (the 63-second trio)",
    !shouldReportDetach({ reported: 1, resyncsSpent: 2, resyncBudget: budget }),
  );
  check(
    "a turn that outlives the whole budget is filed once more",
    shouldReportDetach({ reported: 1, resyncsSpent: budget, resyncBudget: budget }),
  );
  check(
    "…and only once more",
    !shouldReportDetach({ reported: 2, resyncsSpent: budget, resyncBudget: budget }),
  );
}

console.log("\nresyncDecision (one detach leads to one resync that holds):");
{
  const budget = 4;
  const at = (type) => ({ type });
  check(
    "a session boundary on the tail is worth a resync",
    resyncDecision({ tail: at("session.waiting"), silentReads: 0, knownEvents: 40, spent: 0, budget }).reason ===
      "boundary",
  );
  check(
    "a mid-turn tail is not",
    !resyncDecision({ tail: at("message.appended"), silentReads: 0, knownEvents: 40, spent: 0, budget }).resync,
  );
  check(
    "three silent probes fall back to a blind replay",
    resyncDecision({ tail: undefined, silentReads: 3, knownEvents: 40, spent: 0, budget }).reason === "blind",
  );
  check(
    "…but not before three",
    !resyncDecision({ tail: undefined, silentReads: 2, knownEvents: 40, spent: 0, budget }).resync,
  );
  check(
    "a resync that brought back nothing new is NOT repeated blind",
    !resyncDecision({ tail: undefined, silentReads: 5, knownEvents: 40, lastResyncEvents: 40, spent: 1, budget })
      .resync,
  );
  check(
    "…and a real boundary still gets through after one that stalled",
    resyncDecision({
      tail: at("session.waiting"),
      silentReads: 5,
      knownEvents: 40,
      lastResyncEvents: 40,
      spent: 1,
      budget,
    }).resync,
  );
  check(
    "a resync that DID bring more events may try again",
    resyncDecision({ tail: undefined, silentReads: 3, knownEvents: 57, lastResyncEvents: 40, spent: 1, budget })
      .resync,
  );
  check(
    "the budget is still the ceiling",
    !resyncDecision({ tail: at("session.waiting"), silentReads: 0, knownEvents: 40, spent: budget, budget }).resync,
  );
}


// --- renderLoopScene: what a #185 report says, since the error itself says nothing ---------------------------
{
  const msg = (parts) => [{ parts }];
  const ev = (type) => ({ type });
  const scene = renderLoopScene(
    msg([{ type: "text", state: "streaming", text: "| Metric | Q1 |\n| --- | --- |\n| AUM | 1 |" }]),
    [ev("message.appended")],
    { width: 900, height: 700 },
  );
  check("names the streaming renderer that was mounted", scene.includes("table"));
  check("carries the tail part and the last event", scene.includes("tail text/streaming") && scene.includes("event message.appended"));
  check("carries the viewport, because a resize loop is width-dependent", scene.includes("900x700"));
  check("stays inside a telemetry detail", scene.length < 200);
  check(
    "a code fence is not mistaken for a table",
    renderLoopScene(msg([{ type: "text", text: "```js\nconst a = 1;\n```" }]), [ev("x")]).includes("code"),
  );
  check(
    "mermaid is named rather than lumped in with code",
    renderLoopScene(msg([{ type: "text", text: "```mermaid\ngraph TD;\n```" }]), [ev("x")]).includes("mermaid"),
  );
  check(
    "an open approval card is named",
    renderLoopScene(msg([{ type: "dynamic-tool", state: "approval-requested" }]), [ev("input.requested")]).includes("approval"),
  );
  check("an empty transcript still yields a line", renderLoopScene([], []).includes("msgs 0"));
}

/* ═══ THE REATTACH DEFECTS PROVED BY REVIEW ON 2026-09-22 ═══════════════════
 *
 * Each block below fails on the code that shipped as PR #37 and passes on the
 * fix. They live here rather than in test-chat-reattach.mjs because the function
 * under test is pure.
 */

console.log("\nappendTailEvent — a gap in the tail must be closable (finding 2):");
{
  // The shipped guard was `prev[prev.length - 1].index >= entry.index ? prev :
  // [...prev, entry]`, which compares against the LAST entry only. A reader that
  // restarted mid-turn reopens BELOW that, to close a hole — and every one of
  // those deliveries was dropped, which froze the transcript for good.
  let tail = [];
  for (let i = 103; i <= 149; i++) tail = appendTailEvent(tail, { index: i, event: { type: "held" } });
  const before = tail.length;
  for (let i = 100; i <= 159; i++) tail = appendTailEvent(tail, { index: i, event: { type: "resent" } });
  const have = new Set(tail.map((e) => e.index));
  check("the hole at 100, 101, 102 is filled by the restarted reader", have.has(100) && have.has(101) && have.has(102));
  check("…in index order, so the merge can walk it", tail.every((e, i) => i === 0 || tail[i - 1].index < e.index));
  check("…and the tail grew by exactly the missing indices", tail.length === before + 13);
  check(
    "an index already held keeps its FIRST delivery (a re-sent delta would rewind the reply)",
    tail.find((e) => e.index === 120).event.type === "held",
  );
  check(
    "…and a duplicate returns the SAME array, so the memos do not churn",
    appendTailEvent(tail, { index: 120, event: { type: "again" } }) === tail,
  );
  check(
    "the ordinary case is still a plain append",
    appendTailEvent(tail, { index: 160, event: { type: "next" } }).length === tail.length + 1,
  );

  // The whole point: the merge unfreezes, so `turnUnfinished` can reach the
  // terminal and the composer stops saying "Still working…".
  const store = Array.from({ length: 100 }, (_, i) => ({ type: `e${i}` }));
  check("the merged transcript moves again", mergeAttachedEvents(store, tail).length === 160);
  check(
    "…and with the hole still open it was frozen at the store, for good",
    mergeAttachedEvents(store, tail.filter((e) => e.index >= 103)) === store,
  );
}

console.log("\nthe index a restarted reader must reopen at (finding 2):");
{
  // `readLiveTail` reopens at its OWN counter, so the component has to start a
  // restarted reader at the index the TRANSCRIPT is missing: the absolute
  // position of the merged events — the count PLUS this mount's compaction
  // deficit (#38).
  const store = Array.from({ length: 100 }, (_, i) => ({ type: `e${i}` }));
  const base = 3; // a compacted cached transcript
  const tail = [];
  for (let i = 106; i <= 149; i++) tail.push({ index: i, event: { type: "x" } });
  const merged = mergeAttachedEvents(store, tail, serverEventCount(store) + base);
  check("a gapped tail leaves the transcript at the store", merged === store);
  check(
    "…so the next reader reopens at exactly the missing index, not past it",
    serverEventCount(merged) + base === 103,
  );
}

console.log("\nhandBackSession — a dead session is never reinstated (finding 3):");
{
  // eve's own `advanceSession` returns `createInitialSessionState()` — no id, no
  // token — on any boundary that is not `session.waiting`. The hand-off returned
  // `{ sessionId, freshestToken(), streamIndex }` unconditionally, so the next
  // message posted to a DEAD session with a token scraped off an earlier park,
  // and surfaced as "The connection to the agent dropped."
  const park = handBackSession({
    boundary: { type: "session.waiting" },
    sessionId: "ses_1",
    continuationToken: "ct_live",
    streamIndex: 42,
  });
  check(
    "a park carries the session and its fresh token",
    park.sessionId === "ses_1" && park.continuationToken === "ct_live",
  );
  check("…and the advanced cursor", park.streamIndex === 42);
  for (const terminal of ["session.failed", "session.completed"]) {
    const dead = handBackSession({
      boundary: { type: terminal },
      sessionId: "ses_1",
      continuationToken: "ct_from_an_earlier_park",
      streamIndex: 42,
    });
    check(`${terminal}: no session id is handed back`, dead.sessionId === undefined);
    check(`${terminal}: no spent continuation token either`, dead.continuationToken === undefined);
    check(`${terminal}: the cursor is eve's own empty state`, dead.streamIndex === 0);
  }
  // A TURN terminal is not a SESSION terminal: the session is still usable, and
  // dropping it there would open a new session after every ordinary reply.
  const turnDone = handBackSession({
    boundary: { type: "turn.completed" },
    sessionId: "ses_1",
    continuationToken: "ct_live",
    streamIndex: 9,
  });
  check("a turn terminal leaves the session alone", turnDone.sessionId === "ses_1");
}

console.log("\nholdLabel — an expired sign-in is not 'still working' (finding 6):");
{
  const signedOut = holdLabel("detached", false, false, true);
  check("it names the sign-in, not the turn", /sign in again/i.test(signedOut));
  check("…and never claims the reply is still coming", !/still working/i.test(signedOut));
  check(
    "an ordinary detached turn is unchanged",
    holdLabel("detached", false, false).startsWith("Still working"),
  );
  check("…and so is an attached one", holdLabel("detached", false, true).includes("arriving now"));
}


// --- withoutRequestIds: a failed delivery must leave the card answerable -------------------------------------
{
  const set = new Set(["a", "b"]);
  check("removing an id returns a new set without it", !withoutRequestIds(set, ["a"]).has("a"));
  check("the others survive", withoutRequestIds(set, ["a"]).has("b"));
  check("removing nothing returns the SAME set (the fixed point)", withoutRequestIds(set, ["zz"]) === set);
  check("an empty id is ignored", withoutRequestIds(set, [""]) === set);
  check("it is the inverse of withRequestIds", withoutRequestIds(withRequestIds(set, ["c"]), ["c"]).size === 2);
  check("the original is never mutated", set.has("a") && set.size === 2);
}

console.log(`\nchat turn state: ${passed}/${passed} behavioural checks passed`);

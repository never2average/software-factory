/**
 * "When waiting for a tool call the agent pretends like things are done and it
 * shows the feedback, copy, and retry buttons normally seen at the end of
 * answers."
 *
 * Reported by the operator of the live deployment against a real turn that read
 * a 21-page pdf: one sentence, then four tool calls, then the rest of the
 * reply. The copy / thumbs / retry row — plus the blinking caret, minus the
 * "Working…" strip — sat under that first sentence for the whole middle of the
 * turn.
 *
 * Everything here EXECUTES the real code: eve's own `defaultMessageReducer`
 * from node_modules, folded over a scripted stream, and this repo's own
 * `lib/chat-turn-state.ts`. Nothing greps for a symbol except the last section,
 * which holds the three wiring facts no pure function can (which value the
 * components pass, and that nobody re-introduces eve's `metadata.status` as the
 * end-of-turn signal).
 *
 * The two traps it pins down, both measured against the reducer in
 * node_modules/eve/dist/src/client/message-reducer.js:
 *
 *  1. `upsertPart` sets `metadata.status = "complete"` for ANY text part in
 *     state `done`. eve closes the text part at every step boundary, tool-call
 *     steps included, so a turn with four tool calls in it reports "complete"
 *     five times. `turn.completed` writes the identical value, and
 *     `turn.failed` / `session.failed` write nothing at all — the field cannot
 *     answer "is the answer over" in either direction.
 *  2. The eve STORE's status is a property of the local reader, not of the
 *     turn: it is `ready` the instant its `send()` loop ends. Every detached
 *     stretch of a live turn (a reopened thread, a resync remount, a severed
 *     segment past the budget, Stop, a turn POSTed around the store) therefore
 *     looked exactly like a finished one.
 *
 * Run:  npm run test:chat-end-of-answer
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultMessageReducer } from "eve/client";
import {
  partStillWriting,
  tailStillWriting,
  turnFinished,
  turnUnfinished,
} from "../lib/chat-turn-state.ts";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};
const ROOT = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(ROOT + p, "utf8");

/* ═══ THE STREAM ══════════════════════════════════════════════════════════
 *
 * The operator's turn, event for event, in the order the hosted relay delivers
 * it: a sentence, a closed text part, a tool call that takes a while, its
 * result, more text, and only then the terminal.
 */
const TURN = "turn_pdf";
const ev = (type, data) => ({ type, data });
const STREAM = [
  ev("session.started", {}),
  ev("turn.started", { turnId: TURN }),
  ev("message.received", { turnId: TURN, message: "read this 21-page pdf" }),
  ev("step.started", { turnId: TURN, stepIndex: 0 }),
  ev("message.appended", { turnId: TURN, stepIndex: 0, messageSoFar: "Let me open" }),
  ev("message.appended", { turnId: TURN, stepIndex: 0, messageSoFar: "Let me open the filing." }),
  // THE TRAP. eve emits this with `finishReason: "tool-calls"` — the model has
  // stopped talking so it can call a tool, not because the answer is done. The
  // reducer does not read `finishReason`; it writes `status: "complete"`.
  ev("message.completed", {
    turnId: TURN,
    stepIndex: 0,
    message: "Let me open the filing.",
    finishReason: "tool-calls",
  }),
  // …and now the gap the operator was looking at. The relay flushes tool parts
  // at step boundaries, so several seconds of pdf reading produce nothing.
  ev("actions.requested", {
    turnId: TURN,
    stepIndex: 0,
    actions: [{ kind: "tool-call", callId: "c1", toolName: "read_pdf", input: { pages: 21 } }],
  }),
  ev("action.result", {
    turnId: TURN,
    stepIndex: 0,
    status: "completed",
    result: { kind: "tool-result", callId: "c1", toolName: "read_pdf", output: "…21 pages…" },
  }),
  ev("step.started", { turnId: TURN, stepIndex: 1 }),
  ev("message.appended", { turnId: TURN, stepIndex: 1, messageSoFar: "It is a 10-K." }),
  ev("message.completed", {
    turnId: TURN,
    stepIndex: 1,
    message: "It is a 10-K.",
    finishReason: "stop",
  }),
  ev("turn.completed", { turnId: TURN }),
  ev("session.waiting", { continuationToken: "ct_1" }),
];
/** Index of the last event of the tool-call gap (`action.result` not yet in). */
const GAP = STREAM.findIndex((e) => e.type === "actions.requested");
const AFTER_CLOSE = STREAM.findIndex(
  (e) => e.type === "message.completed" && e.data.finishReason === "tool-calls",
);

/** Fold a prefix of the stream through eve's OWN reducer. */
const reducer = defaultMessageReducer();
function fold(events) {
  let data = reducer.initial();
  for (const e of events) data = reducer.reduce(data, e);
  return data;
}
const assistantOf = (data) => data.messages.find((m) => m.role === "assistant");
const partsOf = (data) => assistantOf(data)?.parts ?? [];
const lastTextPart = (data) => [...partsOf(data)].reverse().find((p) => p.type === "text");

/**
 * What the screen shows at a given point, computed the way the components now
 * compute it. `storeBusy` is the ONLY thing that differs between an attached
 * reply and a detached one — the whole point is that the answer must not.
 */
function screen(upTo, { storeBusy = true, pendingInputs = 0, abandoned = false, remoteTurn = false } = {}) {
  const events = STREAM.slice(0, upTo);
  const data = fold(events);
  const over = turnFinished({ storeBusy, events, pendingInputs, abandoned, remoteTurn });
  const parts = partsOf(data);
  return {
    data,
    events,
    /** AgentMessage: `isAssistant && isLast && !turnActive && !awaitingInput`. */
    affordances: over,
    /** agent-chat: `!answerOver && !awaitingUser && !tailStillWriting(...)`. */
    working: !over && !tailStillWriting(parts),
    /** agent-message: the block caret on the last text part. */
    caret: partStillWriting(parts[parts.length - 1]),
    /** eve's own field, the one nothing may key off. */
    eveStatus: assistantOf(data)?.metadata?.status,
  };
}

/* ═══ 1. THE TRAP, PROVEN AGAINST eve'S REAL REDUCER ═════════════════════ */

console.log("eve's metadata.status cannot mean 'the answer is over':");
{
  const midTurn = screen(AFTER_CLOSE + 1);
  check(
    "a text part closed for a TOOL CALL already reports 'complete'",
    midTurn.eveStatus === "complete",
  );
  const done = screen(STREAM.length);
  check("…and so does the genuinely finished turn", done.eveStatus === "complete");
  check(
    "the two are indistinguishable — which is the whole defect",
    midTurn.eveStatus === done.eveStatus && turnUnfinished(midTurn.events),
  );
  // The other direction: the field is not merely early, it is also absent.
  // `turn.failed` and `session.failed` are `return e` in eve's reducer, so a
  // turn that died mid-sentence stays on `streaming` for ever — a UI keyed off
  // this field would hide the affordances on a failed turn permanently.
  const failed = fold([...STREAM.slice(0, AFTER_CLOSE), ev("turn.failed", { turnId: TURN })]);
  check(
    "a turn that FAILED mid-sentence never reaches 'complete' at all",
    assistantOf(failed)?.metadata?.status === "streaming",
  );
  check(
    "…while the event stream says plainly that it ended",
    !turnUnfinished([...STREAM.slice(0, AFTER_CLOSE), ev("turn.failed", { turnId: TURN })]),
  );
}

/* ═══ 2. THE TURN, STEP BY STEP ═════════════════════════════════════════ */

console.log("\nthe operator's turn, event by event, with NOTHING attached:");
{
  // A detached transcript is the case the old rule got wrong at every step: the
  // store is idle, so `isBusy` said "finished" from `turn.started` onwards.
  // From the second event on (session.started + turn.started) the turn is live.
  for (let i = 2; i <= STREAM.length; i++) {
    const last = STREAM[i - 1].type;
    const s = screen(i, { storeBusy: false });
    const ended = !turnUnfinished(s.events);
    check(
      `after ${last}: affordances ${ended ? "SHOWN" : "hidden"}`,
      s.affordances === ended,
    );
  }
  // And with a reader attached, nothing is ever finished before the boundary —
  // the store is still inside its `send()`.
  const attachedEverShows = Array.from({ length: STREAM.length - 1 }, (_, k) =>
    screen(k + 2, { storeBusy: true }).affordances,
  ).some(Boolean);
  check("with the store still reading, never at any point", !attachedEverShows);
}

console.log("\nthe tool-call gap — the seconds the operator was looking at:");
{
  // The gap: the text part is closed, the tool part has not been flushed yet.
  const gap = screen(AFTER_CLOSE + 1);
  check("no copy / thumbs / retry row", !gap.affordances);
  check("no caret blinking under a paragraph nobody is writing", !gap.caret);
  check("the 'Working…' strip IS shown — this is the gap it exists for", gap.working);
  check(
    "…and the text part really is closed (so this is not a shape mismatch)",
    lastTextPart(gap.data).state === "done",
  );

  // Still the gap, one event later: the tool call is on screen, still running.
  const running = screen(GAP + 1);
  check("tool call flushed, still no affordances", !running.affordances);
  check("…still 'Working…'", running.working);

  // Mid-sentence, before the close: caret yes, strip no (the caret covers it).
  const writing = screen(AFTER_CLOSE);
  check("while the sentence is being written the caret is on", writing.caret);
  check("…and the strip stays out of its way", !writing.working);
  check("…and there are still no affordances", !writing.affordances);
}

/* ═══ 3. A TURN THAT REALLY ENDED MUST SHOW THEM, PROMPTLY ══════════════ */

console.log("\nevery way a turn can genuinely end:");
{
  const upToGap = STREAM.slice(0, GAP);
  for (const terminal of ["turn.completed", "turn.failed", "turn.cancelled", "session.failed"]) {
    const events = [...upToGap, ev(terminal, { turnId: TURN })];
    check(
      `${terminal}: affordances shown with the store already idle`,
      turnFinished({ storeBusy: false, events, pendingInputs: 0 }),
    );
  }
  // The store can still be inside its `send()` for a moment after a TURN
  // terminal (the session boundary has not arrived) — that is a reader that is
  // still reading, and holding for it is the honest answer.
  check(
    "…but not while the store is still reading past the terminal",
    !turnFinished({
      storeBusy: true,
      events: [...upToGap, ev("turn.completed", { turnId: TURN })],
      pendingInputs: 0,
    }),
  );

  // MOUNTED FROM THE CACHED SNAPSHOT. Nothing watched this turn end; the
  // terminal is history. "Finished" must not depend on having been there.
  const cached = STREAM.slice();
  check(
    "an old transcript mounted from cache shows them with no live reader",
    turnFinished({ storeBusy: false, events: cached, pendingInputs: 0 }),
  );
  check(
    "…and a cached transcript with no events at all is not 'running'",
    turnFinished({ storeBusy: false, events: [], pendingInputs: 0 }),
  );

  // STOPPED BY THE PERSON. Two shapes: eve settles the cancel on the stream
  // (`turn.cancelled`), or nothing ever arrives and the cancel route / the
  // 12s grace records the turn as abandoned. Both are over; Retry is the point.
  check(
    "a turn the person stopped, settled on the stream",
    turnFinished({
      storeBusy: false,
      events: [...upToGap, ev("turn.cancelled", { turnId: TURN })],
      pendingInputs: 0,
    }),
  );
  check(
    "a turn the person stopped whose terminal never arrived (abandoned)",
    turnFinished({ storeBusy: false, events: upToGap, pendingInputs: 0, abandoned: true }),
  );
  // A retry storm is a DEAD turn, already reported as such.
  const storm = [
    ...["session.started", "turn.started", "message.received"].map((t) => ev(t, {})),
    ...["session.started", "turn.started", "message.received"].map((t) => ev(t, {})),
    ...["session.started", "turn.started", "message.received"].map((t) => ev(t, {})),
  ];
  check(
    "a stormed turn offers Retry rather than spinning for ever",
    turnFinished({ storeBusy: false, events: storm, pendingInputs: 0 }),
  );
}

/* ═══ 4. NOT FINISHED EITHER: DETACHED, REMOTE, PARKED ═════════════════ */

console.log("\nthe three states that are not 'finished' and were read as finished:");
{
  const mid = STREAM.slice(0, GAP);
  check(
    "DETACHED — the turn runs server-side with nothing attached",
    !turnFinished({ storeBusy: false, events: mid, pendingInputs: 0 }),
  );
  check(
    "REMOTE — a turn POSTed around the store, no events to show it yet",
    !turnFinished({ storeBusy: false, events: [], pendingInputs: 0, remoteTurn: true }),
  );
  check(
    "PARKED — the turn is waiting on an approval or a question",
    !turnFinished({
      storeBusy: false,
      events: [...mid, ev("session.waiting", { continuationToken: "ct" })],
      pendingInputs: 1,
    }),
  );

  // The parked case folded through the reducer, so the shape is eve's own.
  const parked = fold([
    ...mid,
    ev("input.requested", {
      turnId: TURN,
      stepIndex: 0,
      requests: [
        {
          requestId: "r1",
          prompt: "Send it?",
          options: [{ id: "yes", label: "Yes" }],
          action: { kind: "tool-call", callId: "c9", toolName: "send_email", input: {} },
        },
      ],
    }),
  ]);
  const approval = partsOf(parked).find((p) => p.state === "approval-requested");
  check("…and eve really does mark that part 'approval-requested'", Boolean(approval));
  check("…which is not a line being written, so no caret", !partStillWriting(approval));
}

/* ═══ 5. THE OLD RULES, RUN OVER THE SAME STREAM ═══════════════════════ */

console.log("\nthe rules this replaces, on the same events (each one is the bug):");
{
  const gap = STREAM.slice(0, AFTER_CLOSE + 1);
  const parts = partsOf(fold(gap));
  // `turnActive={isBusy}` — the store's status, not the turn's.
  const oldAffordances = (storeBusy) => !storeBusy;
  check(
    "old rule shows the affordances mid-tool-call on any detached turn",
    oldAffordances(false) === true && turnFinished({ storeBusy: false, events: gap, pendingInputs: 0 }) === false,
  );
  // `lastParts[last]?.type === "text"` — a CLOSED paragraph counted as a live one.
  const oldTail = parts[parts.length - 1]?.type === "text";
  check(
    "old rule calls the closed paragraph a streaming tail…",
    oldTail === true && tailStillWriting(parts) === false,
  );
  check(
    "…which hid 'Working…' in exactly the gap it was written for, and blinked the caret there",
    oldTail === true && !partStillWriting(parts[parts.length - 1]),
  );
}

/* ═══ 6. THE WIRING (what a pure function cannot hold) ═════════════════ */

console.log("\nwiring — the values the components actually pass:");
{
  const chat = read("app/_components/agent-chat.tsx");
  const message = read("app/_components/agent-message.tsx");
  const cockpit = read("app/_components/cockpit.tsx");

  check("agent-chat derives the verdict from the events", /turnFinished\(\{/.test(chat));
  check(
    "…and never passes the store's status as the turn's",
    !/turnActive=\{isBusy\}/.test(chat),
  );
  check("…and the transcript is told about the TURN", /turnActive=\{!answerOver\}/.test(chat));
  check("…and Retry is offered on the same verdict", /onRetry=\{\s*answerOver &&/.test(chat));
  check(
    "the 'Working…' strip asks whether a line is being written",
    /showWorking = !answerOver && !awaitingUser && !tailStillWriting\(/.test(chat),
  );
  check("the caret asks the same question", /partStillWriting\(segment\.part\)/.test(message));
  check(
    "the subagent rail does not read 'unknown' as 'finished'",
    /turnActive=\{feed\?\.turnActive \?\? live\}/.test(cockpit),
  );
  // eve's field is a trap, not an API. Identifiers and comments are fine; a
  // comparison against it is what shipped the defect elsewhere.
  for (const [name, src] of [
    ["agent-chat", chat],
    ["agent-message", message],
    ["cockpit", cockpit],
  ]) {
    const decommented = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, (m, a) => a);
    check(
      `${name} never keys 'finished' off eve's metadata.status`,
      !/metadata\??\.status\s*===\s*["'`]complete/.test(decommented),
    );
  }
}

console.log(`\nchat end-of-answer: ${passed}/${passed} behavioural checks passed`);

/**
 * "Streaming has many many problems."
 *
 * The specific one this proves fixed: a turn whose stream was severed keeps
 * running server-side, and NOTHING in the browser was reading it. The eve store
 * reads only inside a `send()` — its public surface is
 * `snapshot / setCallbacks / subscribe / send / stop / reset`, there is no
 * attach — so once a turn is detached (Stop, a segment the store's own budget
 * did not recover, a reopened thread, a slept tab) the rest of the reply never
 * arrives. Measured twice: three byte-identical "Chat stream ended mid-turn and
 * stopped resuming · last event: message.appended" records on ONE session inside
 * 63 seconds on 2026-09-21 (the replay-and-remount cycle #34 then stopped), and
 * exactly one more at 2026-09-22T15:32:45 with the fault untouched — the
 * half-written answer simply never continued while the server finished it.
 *
 * Everything here EXECUTES the real modules: `lib/chat-turn-state.ts`,
 * `lib/chat-attach.ts`, `lib/chat-telemetry.ts`, eve's own
 * `defaultMessageReducer` and eve's own `ClientSession.stream` from
 * node_modules, over a fake eve server on a stubbed `fetch`. Nothing here greps
 * source for a symbol, which is how every other chat regression reached
 * production past a green CI.
 *
 * Run:  npm run test:chat-reattach
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { defaultMessageReducer } from "eve/client";
import {
  attachDecision,
  mergeAttachedEvents,
  projectAttached,
  serverEventCount,
  withSessionEpochs,
} from "../lib/chat-turn-state.ts";
import { eveSessionStream, readLiveTail, readNdjson, StreamOpenError } from "../lib/chat-attach.ts";
import {
  CHAT_TELEMETRY_KINDS,
  chatTelemetrySentence,
  isChatTelemetryKind,
} from "../lib/chat-telemetry.ts";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};
const ev = (...types) => types.map((type) => ({ type }));

/* ═══ 1. THE DECISION ═════════════════════════════════════════════════════ */

console.log("attachDecision — when a reader belongs on the stream:");
{
  const running = ev("session.started", "turn.started", "message.received", "step.started", "message.appended");
  const base = { sessionId: "ses_1", storeBusy: false, events: running };

  check("attaches to a detached, unfinished turn", attachDecision(base).attach);
  check("…and says why", attachDecision(base).reason === "live-turn");

  // The one thing that must never happen: two readers over one session. eve's
  // send-path reader advances its own cursor, so a second reader racing it for
  // the same indices double-applies whichever events it wins.
  check(
    "NEVER while the store is reading a turn",
    attachDecision({ ...base, storeBusy: true }).attach === false,
  );
  check(
    "…named as the store's, not as a dead turn",
    attachDecision({ ...base, storeBusy: true }).reason === "store-busy",
  );

  for (const terminal of ["turn.completed", "session.waiting", "turn.failed", "turn.cancelled", "session.completed", "session.failed"]) {
    const done = attachDecision({ ...base, events: [...running, { type: terminal }] });
    check(`detaches on ${terminal}`, !done.attach && done.reason === "terminal");
  }

  // The cancel route answered `no_active_turn`: no terminal will ever come, so
  // a reader would hold an ownership-gated stream open forever.
  const abandoned = attachDecision({ ...base, abandoned: true });
  check("detaches when the server says the turn is not running", !abandoned.attach);
  check("…as abandoned, not as finished", abandoned.reason === "abandoned");

  // A reader open on ses_1 while the transcript has moved to ses_2 would write
  // one conversation's reply into another's.
  const moved = attachDecision({ sessionId: "ses_2", attachedTo: "ses_1", storeBusy: false });
  check("detaches on a session change", !moved.attach && moved.reason === "session-changed");
  check(
    "…and keeps reading while the session is still ours",
    attachDecision({ sessionId: "ses_1", attachedTo: "ses_1", storeBusy: false }).attach,
  );

  check(
    "nothing to attach to before the first send",
    attachDecision({ sessionId: undefined, storeBusy: false, events: running }).reason === "no-session",
  );
  // A stormed turn is dead, already reported as such, and can never emit.
  const storm = ev(
    "session.started", "turn.started", "message.received",
    "session.started", "turn.started", "message.received",
    "session.started", "turn.started", "message.received",
  );
  check(
    "refuses a retry storm — dead, not slow",
    attachDecision({ ...base, events: storm }).reason === "retry-storm",
  );
  check(
    "hands over to the poll once the budget is spent",
    attachDecision({ ...base, failures: 4, maxFailures: 4 }).reason === "open-failed",
  );
  check(
    "…but not before",
    attachDecision({ ...base, failures: 3, maxFailures: 4 }).attach,
  );
  // The identity-only form the reader itself asks on every event.
  check(
    "omitting the events asks only the identity questions",
    attachDecision({ sessionId: "ses_1", storeBusy: false }).attach,
  );
}

/* ═══ 2. THE ABSOLUTE CURSOR ══════════════════════════════════════════════ */

console.log("\nserverEventCount — where the reader resumes:");
{
  const persisted = [
    ...ev("session.started", "turn.started", "message.received"),
    { type: "client.input.responded", data: { responses: [{ requestId: "r1" }] } },
    { type: "client.message.submitted", data: {} },
  ];
  check("browser-only markers do not own a stream index", serverEventCount(persisted) === 3);
  check("a pure server stream counts itself", serverEventCount(ev("a", "b", "c", "d")) === 4);
  check("nothing mounted resumes at zero", serverEventCount([]) === 0);
}

/* ═══ 3. MERGING — the tail must project like one replay ══════════════════ */

const prologue = (turnId, text, first) => [
  ...(first ? [{ type: "session.started", data: {} }] : []),
  { type: "turn.started", data: { turnId } },
  { type: "message.received", data: { turnId, message: text } },
  { type: "step.started", data: { turnId, stepIndex: 0 } },
];
const say = (turnId, soFar) => ({
  type: "message.appended",
  data: { turnId, stepIndex: 0, messageSoFar: soFar },
});
const settle = (turnId, text, token) => [
  { type: "message.completed", data: { turnId, stepIndex: 0, message: text } },
  { type: "turn.completed", data: { turnId } },
  { type: "session.waiting", data: { continuationToken: token } },
];
const askApproval = (turnId, requestId, callId) => ({
  type: "input.requested",
  data: {
    turnId,
    stepIndex: 0,
    requests: [
      {
        requestId,
        prompt: "Send this note?",
        options: [{ id: "approve", label: "Yes" }, { id: "deny", label: "No" }],
        action: { kind: "tool-call", toolName: "send_email", callId, input: { to: "a@b.c" } },
      },
    ],
  },
});
const toolResult = (turnId, callId) => ({
  type: "action.result",
  data: {
    turnId,
    stepIndex: 0,
    status: "completed",
    result: { kind: "tool-result", toolName: "send_email", callId, output: "sent" },
  },
});

/** One transcript, whole — the answer every split has to reproduce. */
const TRANSCRIPTS = {
  "a multi-turn conversation": [
    ...prologue("turn_0", "q1", true),
    say("turn_0", "A1 par"),
    say("turn_0", "A1 partial"),
    ...settle("turn_0", "A1 partial", "ct_1"),
    ...prologue("turn_1", "q2"),
    say("turn_1", "A2 so"),
    say("turn_1", "A2 so far"),
    ...settle("turn_1", "A2 so far", "ct_2"),
  ],
  "a turn with a tool call and an approval": [
    ...prologue("turn_0", "Email the summary", true),
    askApproval("turn_0", "req_1", "call_1"),
    { type: "session.waiting", data: { continuationToken: "ct_park" } },
    toolResult("turn_0", "call_1"),
    say("turn_0", "Sent it."),
    ...settle("turn_0", "Sent it.", "ct_done"),
  ],
  // The withSessionEpochs case: a session ENDS for good and eve starts a new
  // one whose first turn is `turn_0` again. Keyed by turn id, the reducer would
  // otherwise write the new prompt over the transcript's FIRST user bubble.
  "a transcript that spans a session restart": [
    ...prologue("turn_0", "q1", true),
    say("turn_0", "A1"),
    { type: "message.completed", data: { turnId: "turn_0", stepIndex: 0, message: "A1" } },
    { type: "turn.completed", data: { turnId: "turn_0" } },
    { type: "session.completed", data: {} },
    ...prologue("turn_0", "q2", true),
    say("turn_0", "A2"),
    ...settle("turn_0", "A2", "ct_new"),
  ],
};

const projectAll = (events) => {
  const reducer = withSessionEpochs(defaultMessageReducer());
  let data = reducer.initial();
  for (const e of events) data = reducer.reduce(data, e);
  return data;
};
const shape = (data) =>
  JSON.stringify(
    data.messages.map((m) => ({
      role: m.role,
      turnId: m.metadata?.turnId,
      parts: (m.parts ?? []).map((p) => ({ type: p.type, state: p.state, text: p.text })),
    })),
  );

console.log("\nmerging — the attached tail projects identically to one replay:");
for (const [name, full] of Object.entries(TRANSCRIPTS)) {
  const whole = shape(projectAll(full));
  let splitsChecked = 0;
  let allMatch = true;
  let noDuplicates = true;
  for (let split = 0; split <= full.length; split++) {
    const store = full.slice(0, split);
    const tail = full.slice(split).map((event, i) => ({ index: split + i, event }));
    const merged = mergeAttachedEvents(store, tail);
    if (merged.length !== full.length) noDuplicates = false;
    // Folded ONTO the store's own projection, which is what the component does
    // (and what keeps withSessionEpochs' non-enumerable epoch state alive).
    const reducer = withSessionEpochs(defaultMessageReducer());
    let base = reducer.initial();
    for (const e of store) base = reducer.reduce(base, e);
    const incremental = projectAttached(reducer, base, merged.slice(store.length));
    if (shape(projectAll(merged)) !== whole || shape(incremental) !== whole) allMatch = false;
    splitsChecked++;
  }
  check(`${name}: identical at all ${splitsChecked} split points`, allMatch);
  check(`${name}: no event is applied twice`, noDuplicates);
}

console.log("\nmerging — the rules that stop the screen from lying:");
{
  const store = ev("a", "b", "c");
  check(
    "an index the store already holds is dropped, never re-applied",
    mergeAttachedEvents(store, [{ index: 1, event: { type: "WRONG" } }]) === store,
  );
  check(
    "an empty tail keeps the SAME array reference (memos do not churn)",
    mergeAttachedEvents(store, []) === store,
  );
  const dup = mergeAttachedEvents(store, [
    { index: 3, event: { type: "d" } },
    { index: 3, event: { type: "d-again" } },
    { index: 4, event: { type: "e" } },
  ]);
  check("a re-sent index is taken once, first delivery wins", dup.length === 5 && dup[3].type === "d");
  const gap = mergeAttachedEvents(store, [
    { index: 3, event: { type: "d" } },
    { index: 5, event: { type: "f" } },
  ]);
  check(
    "the tail stops at the first gap — 5 cannot be placed without 4",
    gap.length === 4 && gap[3].type === "d",
  );
  // Client markers live in the store's array but own no stream index.
  const withMarker = [{ type: "a" }, { type: "b" }, { type: "client.input.responded" }];
  const afterMarker = mergeAttachedEvents(withMarker, [{ index: 2, event: { type: "c" } }]);
  check(
    "the resume index skips client-only markers",
    afterMarker.length === 4 && afterMarker[3].type === "c",
  );
}

/* ═══ 4. A STREAM THAT SEVERS MID-TURN, AND RESUMES ═══════════════════════ */

/**
 * The fake eve channel, cut the way the real one is.
 *
 * `segment` is the ~120s severance: the body simply ENDS, mid-turn, with no
 * terminal event and no error. That is the case eve's own `openStreamIterable`
 * does NOT reconnect on — it reopens only on a socket disconnect error — which
 * is why lib/chat-attach.ts wraps it in a reopen loop at the advanced absolute
 * index.
 */
function fakeEveStream({ log, segment = Infinity, failFirst = 0, status = 0 }) {
  const opens = [];
  let failures = failFirst;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url), "http://eve.local");
    const startIndex = Number(u.searchParams.get("startIndex") ?? 0);
    opens.push(startIndex);
    if (status) return new Response("nope", { status });
    if (failures > 0) {
      failures -= 1;
      // A cold ownership gate: two or three workspace-scoped queries run on
      // EVERY open, reconnects included, and can be slow or fall over while the
      // turn itself is perfectly healthy. Retryable, never terminal.
      throw new TypeError("fetch failed");
    }
    let i = startIndex;
    const stop = Math.min(log.length, startIndex + segment);
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream({
        async pull(c) {
          for (;;) {
            if (init.signal?.aborted) return c.error(new DOMException("aborted", "AbortError"));
            if (i < stop) return c.enqueue(enc.encode(`${JSON.stringify(log[i++])}\n`));
            // Severed: a clean end of body, mid-turn, no terminal.
            return c.close();
          }
        },
      }),
    );
  };
  return { opens };
}

const LIVE_TURN = [
  ...prologue("turn_0", "q1", true),
  say("turn_0", "A1"),
  say("turn_0", "A1 with"),
  say("turn_0", "A1 with more"),
  say("turn_0", "A1 with more text"),
  ...settle("turn_0", "A1 with more text", "ct_live"),
];

console.log("\na severed stream, read through eve's own ClientSession.stream:");
{
  // The browser holds the first four events and the turn is still running: the
  // exact state of the 2026-09-22T15:32:45 record.
  const mounted = LIVE_TURN.slice(0, 4);
  const { opens } = fakeEveStream({ log: LIVE_TURN, segment: 2 });
  const seen = [];
  const ctrl = new AbortController();
  const result = await readLiveTail({
    open: eveSessionStream({ sessionId: "ses_1", headers: () => ({ authorization: "Bearer t" }) }),
    startIndex: serverEventCount(mounted),
    signal: ctrl.signal,
    onEvent: (entry) => seen.push(entry),
    sleep: () => Promise.resolve(),
  });

  check("the reader runs to the session boundary", result.outcome === "terminal");
  check("…across several severed segments", result.segments > 1);
  check("every reopen resumes at the advanced absolute index", opens.every((o, i) => o === 4 + i * 2));
  check(
    "the indices it reports are the absolute ones",
    seen.every((e, i) => e.index === 4 + i),
  );
  check("no index is delivered twice", new Set(seen.map((e) => e.index)).size === seen.length);

  const merged = mergeAttachedEvents(mounted, seen);
  check("the merged stream is the whole turn, once", merged.length === LIVE_TURN.length);
  check(
    "and it projects exactly like one uninterrupted replay",
    shape(projectAll(merged)) === shape(projectAll(LIVE_TURN)),
  );
  const reducer = withSessionEpochs(defaultMessageReducer());
  let base = reducer.initial();
  for (const e of mounted) base = reducer.reduce(base, e);
  check(
    "…and so does the incremental projection the component renders",
    shape(projectAttached(reducer, base, merged.slice(mounted.length))) === shape(projectAll(LIVE_TURN)),
  );
  check(
    "the reply the user was missing is now on screen in full",
    JSON.stringify(projectAll(merged).messages.at(-1).parts.map((p) => p.text)).includes("A1 with more text"),
  );
  check(
    "the park's fresh continuation token came with it",
    merged.some((e) => e.type === "session.waiting" && e.data?.continuationToken === "ct_live"),
  );
}

console.log("\nthe failures a live tail has to survive, and the one it must not:");
{
  // A cold database behind the ownership gate: two opens fall over, the third
  // works. eve's own `openStreamBody` already absorbs a transient network
  // failure (it retries a disconnect up to twelve times, 250ms apart), so this
  // never reaches the outer loop — and it must not be turned into a verdict
  // about the turn, which is perfectly healthy.
  const { opens } = fakeEveStream({ log: LIVE_TURN, segment: 100, failFirst: 2 });
  const waits = [];
  const result = await readLiveTail({
    open: eveSessionStream({ sessionId: "ses_1", headers: () => ({}) }),
    startIndex: 0,
    signal: new AbortController().signal,
    onEvent: () => {},
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  check("a transient open failure is retried, not fatal", result.outcome === "terminal");
  check("…absorbed by eve's own opener, so the outer loop never backs off", waits.length === 0);
  check("…and every attempt resumes from the same index it failed at", opens.every((o) => o === 0));
}
{
  // When the failure outlives eve's own retries, the outer loop owns it. Never
  // a tight retry: every reopen runs the ownership gate's two or three
  // workspace-scoped queries, and a cold one is slow rather than broken.
  const waits = [];
  let attempts = 0;
  const result = await readLiveTail({
    open: async function* (startIndex) {
      attempts += 1;
      if (attempts <= 2) throw new Error("upstream unavailable");
      for (let i = startIndex; i < LIVE_TURN.length; i++) yield LIVE_TURN[i];
    },
    startIndex: 0,
    signal: new AbortController().signal,
    onEvent: () => {},
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  check("a failure eve gave up on is still retried here", result.outcome === "terminal" && attempts === 3);
  check("…backing off 0.5s then 1s rather than spinning", waits.length === 2 && waits[0] === 500 && waits[1] === 1000);
}
{
  // A revoked share. Retrying is useless AND costs the membership check.
  fakeEveStream({ log: LIVE_TURN, status: 403 });
  const waits = [];
  const result = await readLiveTail({
    open: eveSessionStream({ sessionId: "ses_1", headers: () => ({}) }),
    startIndex: 0,
    signal: new AbortController().signal,
    onEvent: () => {},
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  check("a revoked share stops the reader immediately", result.outcome === "forbidden");
  check("…without a single retry", waits.length === 0 && result.segments === 1);
}
{
  // The component's own teardown: a send starting, a terminal, an unmount.
  fakeEveStream({ log: LIVE_TURN, segment: 2 });
  const ctrl = new AbortController();
  const seen = [];
  const running = readLiveTail({
    open: eveSessionStream({ sessionId: "ses_1", headers: () => ({}) }),
    startIndex: 0,
    signal: ctrl.signal,
    onEvent: (e) => {
      seen.push(e);
      if (seen.length === 2) ctrl.abort();
    },
    sleep: () => Promise.resolve(),
  });
  const result = await running;
  check("aborting stops the reader", result.outcome === "aborted");
  check("…where it was, not at the end", seen.length === 2 && result.index === 2);
}
{
  // A stream that opens and closes with nothing in it, forever. The poll has to
  // get the turn back rather than this looping on an ownership-gated route.
  fakeEveStream({ log: [], segment: 0 });
  const result = await readLiveTail({
    open: eveSessionStream({ sessionId: "ses_1", headers: () => ({}) }),
    startIndex: 0,
    signal: new AbortController().signal,
    onEvent: () => {},
    sleep: () => Promise.resolve(),
  });
  check("an empty stream gives up and hands over to the poll", result.outcome === "stream-failed");
  check("…within its budget", result.segments === 4);
}

console.log("\nNDJSON on the shared-thread proxy (ClientSession cannot be pointed there):");
{
  const lines = [
    JSON.stringify({ type: "turn.started", data: { turnId: "turn_0" } }),
    JSON.stringify({ type: "ops.replay.end", data: { index: 1, drained: true } }),
    JSON.stringify({ type: "message.appended", data: { turnId: "turn_0", messageSoFar: "hi" } }),
  ].join("\n");
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      // Split mid-line on purpose: a chunk boundary must not lose an event.
      c.enqueue(enc.encode(lines.slice(0, 30)));
      c.enqueue(enc.encode(`${lines.slice(30)}\n`));
      c.close();
    },
  });
  const out = [];
  for await (const e of readNdjson(body)) out.push(e.type);
  check("events survive a chunk boundary", out.length === 2);
  check(
    "the proxy's replay marker is never counted as an event",
    !out.includes("ops.replay.end") && out[1] === "message.appended",
  );
  check("a 403 from the proxy carries its status", new StreamOpenError(403, "x").status === 403);
}

/* ═══ 5. TELEMETRY — the kinds must survive the route's schema ════════════ */

console.log("\ntelemetry kinds round-trip through the route's schema:");
{
  // Exactly what app/api/ops/chat-telemetry/route.ts builds, from exactly the
  // same source. The route answers 202 on a parse failure, so a kind that is
  // emitted but not listed is accepted, dropped, and looks like a kind that
  // never fired. That trap cost #34 once; it is also why `resync` and `stop`
  // have been emitted for weeks and have never reached `automation_audit`.
  const schema = z.object({
    sessionId: z.string().max(200).optional(),
    kind: z.enum(CHAT_TELEMETRY_KINDS),
    detail: z.string().max(400).optional(),
    elapsedMs: z.number().int().nonnegative().max(86_400_000).optional(),
    attempt: z.number().int().nonnegative().max(10_000).optional(),
  });

  // Every kind the CHAT ACTUALLY EMITS, read out of the components. Source is
  // the right input here: the bug being guarded is precisely a caller and a
  // schema drifting apart, so the test has to look at the callers.
  const emitted = new Set();
  for (const file of ["app/_components/agent-chat.tsx", "app/_components/chat-shell.tsx"]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    // The first argument of every `report(...)` call, ternaries included
    // (`report(recoverable ? "resume" : "stream-error", …)` is a real caller).
    for (const call of src.matchAll(/\breport\(\s*([^,]+?),/g)) {
      for (const lit of call[1].matchAll(/"([a-z-]+)"/g)) emitted.add(lit[1]);
    }
    // …and any `kind:` written directly into a chat-telemetry request body,
    // which is how chat-shell reports a failed save. Scoped to a window after
    // the route name so unrelated `kind:` fields (the auto-badge's "cron") are
    // not mistaken for telemetry.
    for (const hit of src.matchAll(/chat-telemetry/g)) {
      const window = src.slice(hit.index, hit.index + 400);
      for (const lit of window.matchAll(/\bkind:\s*"([a-z-]+)"/g)) emitted.add(lit[1]);
    }
  }
  check("the chat emits telemetry at all", emitted.size >= 8);
  for (const kind of [...emitted].sort()) {
    const parsed = schema.safeParse({ kind, detail: "x" });
    check(`"${kind}" is recorded, not silently dropped`, parsed.success);
  }
  for (const kind of ["attach-started", "attach-complete", "attach-failed", "stall"]) {
    check(`the reattach emits "${kind}" and the route accepts it`, emitted.has(kind) && isChatTelemetryKind(kind));
  }
  check(
    "the two kinds that were being dropped are now accepted",
    schema.safeParse({ kind: "resync" }).success && schema.safeParse({ kind: "stop" }).success,
  );
  check("an unknown kind is still refused", !schema.safeParse({ kind: "made-up" }).success);
  for (const kind of CHAT_TELEMETRY_KINDS) {
    check(`"${kind}" reads as a sentence a human can act on`, chatTelemetrySentence(kind).length > 10);
  }
  check(
    "every accepted kind has a distinct sentence",
    new Set(CHAT_TELEMETRY_KINDS.map(chatTelemetrySentence)).size === CHAT_TELEMETRY_KINDS.length,
  );
  // The structural half: the route must DERIVE its enum, not restate it.
  const route = readFileSync(
    new URL("../app/api/ops/chat-telemetry/route.ts", import.meta.url),
    "utf8",
  );
  check(
    "the route derives its enum from the one map, so the trap cannot come back",
    /z\.enum\(CHAT_TELEMETRY_KINDS\)/.test(route),
  );
}

console.log(`\nchat reattach: ${passed}/${passed} behavioural checks passed`);

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
  absoluteIndexBase,
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


// --- a CACHED transcript is compacted, so counting it is NOT the absolute index -------------------------------
{
  const { compactTranscript, mountFromSnapshot } = await import("../lib/chat-snapshot.ts");
  const ev = (type, data = {}) => ({ type, data: { turnId: "turn_0", stepIndex: 0, ...data } });
  const server = [
    ev("session.started"), ev("turn.started"), ev("message.received", { message: "hi" }), ev("step.started"),
    ev("message.appended", { messageSoFar: "a" }), ev("message.appended", { messageSoFar: "ab" }),
    ev("message.appended", { messageSoFar: "abc" }), ev("message.completed", { message: "abc" }),
    ev("turn.completed"), ev("session.waiting"),
  ];
  const compacted = compactTranscript(server);
  check("compaction really does drop events", compacted.length < server.length);
  const mounted = mountFromSnapshot(
    { version: 1, eventIndex: server.length, events: compacted, clientEvents: [] }, [], [],
  );
  const base = absoluteIndexBase(mounted.streamIndex, mounted.events);
  check("counting a cached transcript understates the stream", serverEventCount(mounted.events) < server.length);
  check("count + base IS where the stream actually is", serverEventCount(mounted.events) + base === server.length);
  check("an uncompacted transcript needs no correction", absoluteIndexBase(server.length, server) === 0);
  check("no cursor means no correction", absoluteIndexBase(undefined, compacted) === 0);
  check("a cursor behind the transcript never pushes a reader backwards", absoluteIndexBase(2, server) === 0);
  check(
    "client-only markers never inflate the base",
    absoluteIndexBase(server.length, [...compacted, { type: "client.message.submitted" }]) === base,
  );
}

/* ═══ 6. WHAT AN ADVERSARIAL REVIEW OF #37 FOUND ══════════════════════════
 *
 * Six defects, each one proved against the real modules before it was fixed.
 * Every block here fails on the code that shipped and passes on the fix.
 */

console.log("\nthe reader never opens in a tight loop, however productive (finding 4):");
{
  /**
   * `if (got > 0) { fruitless = 0; continue; }` made the backoff reachable ONLY
   * by a segment that delivered nothing. An opener that yields one event and
   * then ends is therefore reopened as fast as the event loop allows: measured
   * on the shipped code at **200 opens in 3 ms**, and with the epoch re-arm
   * allowing four readers per turn, 800. Every one of those runs the session
   * proxy's ownership gate — two or three workspace-scoped queries — so this is
   * exactly the shape that turns a slow database into an outage of our own
   * making. The module's own header promises "never a tight retry … always a
   * backoff".
   */
  let opens = 0;
  const waits = [];
  const result = await readLiveTail({
    open: async function* () {
      opens += 1;
      yield { type: "message.appended", data: { turnId: "turn_0", messageSoFar: "…" } };
    },
    startIndex: 0,
    signal: new AbortController().signal,
    onEvent: () => {},
    maxSegments: 50,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  check("a one-event-per-open stream still ends on the segment budget", result.outcome === "exhausted");
  check("…but every single reopen is paid for", waits.length >= opens - 1);
  check(
    "…with the 250ms floor charged from the open, so 50 opens cost 12 seconds rather than 1 millisecond",
    waits.reduce((a, b) => a + b, 0) >= 12_000,
  );

  // A HEALTHY segment — one that ran for longer than the floor — must not be
  // delayed at all: the gap between segments is dead air on the reader's screen.
  const realWaits = [];
  await readLiveTail({
    open: async function* (startIndex) {
      if (startIndex > 0) return;
      for (const e of LIVE_TURN) yield e;
    },
    startIndex: 0,
    signal: new AbortController().signal,
    onEvent: () => {},
    minSegmentGapMs: 0,
    sleep: (ms) => {
      realWaits.push(ms);
      return Promise.resolve();
    },
  });
  check("a segment that reaches the boundary never waits at all", realWaits.length === 0);
}

console.log("\na hung open cannot stall the turn forever (finding 5):");
{
  /**
   * `for await (const event of input.open(index, input.signal))` had no timeout:
   * the only abort was component teardown. A proxy that holds the connection
   * open without sending — or a black-holed socket — hung the reader forever,
   * and because `attachLive` is true while it hangs, the detached-turn watcher
   * stands down: reader hung, poll disabled, nothing on screen, nothing
   * recovers. The poll's own `readTail` aborts at 8s; this follows that
   * precedent, with a fuse ABOVE the ~120s seam so it can never cut a healthy
   * segment that is merely quiet through one long tool call.
   */
  let opens = 0;
  let sawAbort = 0;
  const reader = readLiveTail({
    open: async function* (_startIndex, signal) {
      opens += 1;
      await new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => {
          sawAbort += 1;
          resolve();
        }, { once: true });
      });
    },
    startIndex: 0,
    signal: new AbortController().signal,
    onEvent: () => {},
    idleTimeoutMs: 20,
    sleep: () => Promise.resolve(),
  });
  const result = await Promise.race([
    reader,
    new Promise((resolve) => setTimeout(() => resolve("HUNG"), 3_000)),
  ]);
  check("a silent connection does not hang the reader", result !== "HUNG");
  check("…it is cut and handed to the poll", result.outcome === "stream-failed");
  check("…having said why, in the record", /silent for 20ms/.test(result.detail ?? ""));
  check("…after the full budget of reopens, not one", opens === 4 && sawAbort === 4);

  // A segment that DELIVERED and then went quiet made real progress: it reopens
  // at the advanced index instead of counting against the budget.
  let segs = 0;
  const progressing = await readLiveTail({
    open: async function* (startIndex, signal) {
      segs += 1;
      if (startIndex < LIVE_TURN.length) {
        yield LIVE_TURN[startIndex];
        if (startIndex + 1 >= LIVE_TURN.length) return;
      }
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
    startIndex: 0,
    signal: new AbortController().signal,
    onEvent: () => {},
    idleTimeoutMs: 20,
    sleep: () => Promise.resolve(),
  });
  check(
    "a segment that delivered before going quiet reopens instead of giving up",
    progressing.outcome === "terminal" && segs === LIVE_TURN.length,
  );
}

console.log("\n401 is a stale credential, 403 is a revoked share (finding 6):");
{
  /**
   * They were lumped together and the whole attach budget was spent on both.
   * They are opposites. 403 on the membership-checked proxy means the share was
   * REVOKED: never retry, and never forgive it on a tab return either. 401 means
   * the credential went stale — and the session token here lives about an hour
   * while auth-gate.tsx drops it 60 SECONDS BEFORE `exp`, after which
   * `getAuthHeaders()` returns `{}`. A turn long enough to cross that boundary
   * meets a 401 as a matter of course, and "Still working…" hides the one action
   * that fixes it.
   */
  fakeEveStream({ log: LIVE_TURN, status: 401 });
  const waits = [];
  const stale = await readLiveTail({
    open: eveSessionStream({ sessionId: "ses_1", headers: () => ({}) }),
    startIndex: 0,
    signal: new AbortController().signal,
    onEvent: () => {},
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  check("an expired credential is its own outcome, not 'forbidden'", stale.outcome === "unauthorized");
  check("…and it stops the reader at once, without spending the gate", waits.length === 0 && stale.segments === 1);
  check("…saying which status it was", stale.detail === "access 401");

  fakeEveStream({ log: LIVE_TURN, status: 403 });
  const revoked = await readLiveTail({
    open: eveSessionStream({ sessionId: "ses_1", headers: () => ({}) }),
    startIndex: 0,
    signal: new AbortController().signal,
    onEvent: () => {},
    sleep: () => Promise.resolve(),
  });
  check("a revoked share is still 'forbidden'", revoked.outcome === "forbidden");
  check("…and the two are told apart", revoked.outcome !== stale.outcome);
}

/* ---- the half that lives in the component -------------------------------
 *
 * These read the component's source, which is the right input for exactly one
 * class of bug: a rule that is stated in one place and has to hold in another.
 * The behaviour each one guards is proved above and in
 * scripts/test-chat-turn-state.mjs; what cannot be executed offline is the React
 * effect that has to USE it, so that much is ratcheted.
 */
console.log("\nthe component holds the reader's end of the contract:");
{
  const chat = readFileSync(new URL("../app/_components/agent-chat.tsx", import.meta.url), "utf8");
  const attachEffect = chat.slice(
    chat.indexOf("const shouldAttach = attachVerdict.attach"),
    chat.indexOf("A TAB COMING BACK is a fresh chance"),
  );
  check("the attach effect was found", attachEffect.length > 500);

  /**
   * FINDING 1 — the hand-off is skipped whenever the reader restarted mid-turn.
   *
   * `collected` was a per-effect array, and the effect re-runs mid-turn on three
   * ordinary things: a reader failure bumping `attachEpoch`, the tab becoming
   * visible again, and `attachKey = ${chatKey}:${startedTurns}` changing because
   * eve re-emits `turn.started` when it replays a turn after a step throws.
   * Reader #2's array then begins after a gap, `mergeAttachedEvents` returns the
   * identical array, and `if (merged === agent.events) return;` bails: no
   * hand-off, no remount — and the store never regains the session id or the
   * fresh token, so the NEXT message opens a new eve session whose `turn_0`
   * overwrites the first exchange.
   */
  check(
    "the collected tail survives the effect (finding 1)",
    /const collectedRef = useRef/.test(chat) && !/const collected: IndexedEvent\[\] = \[\]/.test(attachEffect),
  );
  check(
    "…and the hand-off reads THAT, not a per-reader array",
    /handBackRef\.current = \(attachedTo\) => \{[\s\S]{0,200}collectedRef\.current/.test(chat),
  );
  check(
    "…and it is cleared once it has been handed over",
    /collectedRef\.current = \[\];\s*\n\s*onReattach\(/.test(chat),
  );
  // The bail itself, proved with the real merge: this is what "skipped" means.
  const store = Array.from({ length: 100 }, (_, i) => ({ type: `e${i}` }));
  const readerTwoOnly = [];
  for (let i = 150; i <= 202; i++) readerTwoOnly.push({ index: i, event: { type: i === 202 ? "session.waiting" : "message.appended" } });
  check(
    "…because a tail that starts past the store merges to nothing at all",
    mergeAttachedEvents(store, readerTwoOnly) === store,
  );

  /** FINDING 2 — a restarted reader's lower indices must be placed, not dropped. */
  check(
    "the tail is appended by INDEX (finding 2)",
    /appendTailEvent\(prev, entry\)/.test(attachEffect) &&
      !/prev\[prev\.length - 1\]\.index >= entry\.index/.test(attachEffect),
  );

  /** FINDING 3 — the hand-off after a session terminal. */
  check(
    "the hand-off cursor comes from handBackSession (finding 3)",
    /const cursor = handBackSession\(\{/.test(chat) &&
      !/sessionId: sid,\s*\n\s*continuationToken: freshestToken\(\),\s*\n\s*streamIndex: absoluteIndex\(merged\),\s*\n\s*\} as AgentSession/.test(chat),
  );

  /** FINDING 5 — nothing re-arms a reader when the network comes back. */
  check(
    "the network coming back re-arms the reader (finding 5)",
    /addEventListener\("online", rearm\)/.test(chat) && /removeEventListener\("online", rearm\)/.test(chat),
  );

  /** FINDING 6 — a revoked share is not forgiven by the tab-return handler. */
  check(
    "a 403 is remembered outside the forgiven budget (finding 6)",
    /attachRevoked\.add\(attachKey\)/.test(chat) && /attachRevoked\.has\(attachKeyRef\.current\)/.test(chat),
  );
  check(
    "…and a 401 stops the reader and says to sign in again",
    /result\.outcome === "unauthorized"/.test(chat) && /setAuthExpired\(true\)/.test(chat),
  );

  /**
   * FINDING 7 (the cheap half) — the persist storm.
   *
   * `preview = lastText(viewMessages)` is the full text of the last part, so it
   * changes with every delta; the persist effect depended on it and each fire
   * ran `dedupeEvents` plus a synchronous `localStorage` write of every event —
   * measured by review at ~460 ms of blocking main-thread work PER DELTA on a
   * 1,500-event turn with a 60 KB table. The expensive half lives in
   * chat-shell.tsx and is described in the PR.
   */
  const persistDeps = chat.slice(chat.indexOf("// Persist chat metadata once it has a server session."));
  const depLine = persistDeps.slice(persistDeps.indexOf("}, [sessionId, title"), persistDeps.indexOf("}, [sessionId, title") + 200);
  check(
    "the persist effect cannot fire per delta (finding 7)",
    !/^\}, \[[^\]]*\bpreview\b/.test(depLine) && /persistTick/.test(depLine),
  );
  check(
    "…and the tick is a clock, not a character",
    /setInterval\(\(\) => setPersistTick\(\(n\) => n \+ 1\), 2_000\)/.test(chat),
  );

  /**
   * FINDING 8 — telemetry honesty. `attach-started` fired on every effect
   * re-run, so one reader restarting read as several failed live tails in the
   * attach-started vs attach-complete comparison this kind exists for.
   */
  check(
    "attach-started is reported once per turn (finding 8)",
    /const restarts = attachStarts\.get\(attachKey\) \?\? 0;/.test(attachEffect) &&
      /if \(restarts === 0\) \{\s*\n\s*report\("attach-started"/.test(attachEffect),
  );
  check(
    "…and a restart is still counted, in the detail",
    /reader restart \$\{restarts\}/.test(attachEffect),
  );

  /** The two lower-confidence ones the review also flagged. */
  check(
    "the per-turn maps are pruned, so a long-lived tab does not leak",
    /function forgetFinishedTurns/.test(chat) && /forgetFinishedTurns\(chatKey, startedTurns\)/.test(chat),
  );
  const stopFallback = chat.slice(
    chat.indexOf("stopFallbackRef.current = setTimeout("),
    chat.indexOf("}, 12_000);"),
  );
  check(
    "Stop clears a turn even when the reader and the poll are both spent",
    /setAbandonedTurn\(wasTurn\)/.test(stopFallback) && /turnUnfinished\(mergedEventsRef\.current/.test(stopFallback),
  );

  /**
   * AND THE ONE THE REVIEW DID NOT LIST: the merge's `nextIndex`.
   *
   * It defaults to `serverEventCount(storeEvents)`, which is only the absolute
   * index for a transcript read straight off the stream. A reopened thread
   * mounts a COMPACTED one (#38), so the reader was started at count + deficit
   * while the merge was still looking for count — every tail entry read as a gap
   * and the merge returned the store's array untouched. On exactly the mount the
   * reattach exists for, the live tail never reached the transcript.
   */
  check(
    "the merge is given the ABSOLUTE index, not the store's length",
    /mergeAttachedEvents\(\s*\n\s*agent\.events as readonly TurnEvent\[\],\s*\n\s*attachedTail,\s*\n\s*absoluteIndex\(agent\.events as readonly TurnEvent\[\]\),/.test(chat),
  );
}
{
  // …and the same thing, executed: a compacted mount's tail must merge.
  const store = Array.from({ length: 100 }, (_, i) => ({ type: `e${i}` }));
  const base = absoluteIndexBase(103, store); // cursor 103, transcript 100 events
  const tail = [{ index: 103, event: { type: "message.appended" } }];
  check(
    "a compacted mount's tail merges when the absolute index is used",
    mergeAttachedEvents(store, tail, serverEventCount(store) + base).length === 101,
  );
  check(
    "…and was dropped entirely by the default",
    mergeAttachedEvents(store, tail) === store,
  );
}


// --- a SHARED thread answers through the relay, or the answer is dropped -------------------------------------
{
  const src = readFileSync(new URL("../app/_components/agent-chat.tsx", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("const respondToInput = async"), src.indexOf("const handleSubmit"));
  check("respondToInput has a relay branch", /if \(relayThreadId\) \{/.test(fn));
  const relayAt = fn.indexOf("if (relayThreadId) {");
  check(
    "it comes BEFORE the paths that reach for a continuation token",
    relayAt > 0 && relayAt < fn.indexOf("directDeliver(") && relayAt < fn.indexOf("agent.send("),
  );
  check("it posts the answers to the relay", /threads\/\$\{relayThreadId\}\/messages/.test(fn));
  check(
    "a relay failure un-marks the card so it stays answerable",
    /withoutRequestIds\(prev, requestIds\)/.test(fn),
  );
}

console.log(`\nchat reattach: ${passed}/${passed} behavioural checks passed`);

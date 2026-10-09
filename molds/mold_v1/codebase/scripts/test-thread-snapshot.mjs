/**
 * A reopened thread must show EXACTLY what a full replay shows.
 *
 * Opening a chat used to re-read the session's whole event stream and re-reduce
 * it, so the cost grew with everything that had ever been said in it. The fix is
 * a cached transcript plus a tail read (lib/chat-snapshot.ts) — which is a
 * correctness risk, not just a performance change: the moment a conversation can
 * be assembled from two sources, it can be assembled WRONG, and the person
 * reading it has no way to tell.
 *
 * So the central claim is executed here, not asserted: for several transcripts,
 * and at EVERY point one could be split, the messages projected from
 * `snapshot + tail` are byte-identical to the messages projected from replaying
 * the whole stream. It runs the real reducer — eve's `defaultMessageReducer`
 * wrapped in `withSessionEpochs`, exactly as app/_components/agent-chat.tsx
 * mounts it — because a regex over source cannot tell you what a transcript
 * looks like.
 *
 * The rest are the ways a cache goes wrong: a snapshot for another session, one
 * written by a build that projects differently, one whose index the stream
 * cannot reach, one whose seam the stream disagrees with, and one belonging to a
 * thread the caller was never given.
 *
 * Run:  npm run test:thread-snapshot
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultMessageReducer } from "eve/client";
import { withSessionEpochs } from "../lib/chat-turn-state.ts";
import { withFreshestToken } from "../lib/chat-session-cursor.ts";
import {
  SNAPSHOT_VERSION,
  buildSnapshot,
  canonicalJson,
  checkSeam,
  compactTranscript,
  mountFromSnapshot,
  snapshotAccess,
  snapshotUsable,
  splitClientEvents,
  createEventDeduper,
  dedupeEvents,
} from "../lib/chat-snapshot.ts";

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed++;
  console.log(`  ok   ${label}`);
};

/* ---- the real projection ------------------------------------------------- */

/** Reduce a stream the way the mounted chat does. */
function project(events) {
  const reducer = withSessionEpochs(defaultMessageReducer());
  let data = reducer.initial();
  for (const e of events) data = reducer.reduce(data, e);
  return data;
}
const projectionOf = (events) => canonicalJson(project(events));

/* ---- transcript fixtures -------------------------------------------------- */
/* Shapes taken from eve's own protocol (node_modules/eve/dist/src/protocol/
 * message.d.ts): `message.appended` carries `messageSoFar`, the WHOLE text so
 * far, on every delta — which is the reason a long answer's stream is quadratic
 * in its own length, and the reason compaction is worth doing at all. */

let seq = 0;
const ev = (type, data) => ({ type, data: { ...data, sequence: seq++ }, meta: { at: "2026-09-20T10:00:00.000Z" } });

/** One assistant turn: optional reasoning, streamed text, optional tool call. */
function turn({ id, text = "Answer.", deltas = 6, reasoning, tool, approval, step = 0 }) {
  const out = [ev("turn.started", { turnId: id }), ev("message.received", { turnId: id, message: `ask ${id}` })];
  out.push(ev("step.started", { turnId: id, stepIndex: step }));
  if (reasoning) {
    let soFar = "";
    for (const piece of reasoning.match(/.{1,4}/g) ?? []) {
      soFar += piece;
      out.push(ev("reasoning.appended", { turnId: id, stepIndex: step, reasoningDelta: piece, reasoningSoFar: soFar }));
    }
    out.push(ev("reasoning.completed", { turnId: id, stepIndex: step, reasoning }));
  }
  if (tool) {
    if (approval) {
      out.push(
        ev("input.requested", {
          turnId: id,
          stepIndex: step,
          requests: [
            {
              requestId: `${id}-req`,
              prompt: `Run ${tool}?`,
              display: "confirmation",
              action: { kind: "tool-call", callId: `${id}-call`, toolName: tool, input: { a: 1 } },
            },
          ],
        }),
      );
    } else {
      out.push(
        ev("actions.requested", {
          turnId: id,
          stepIndex: step,
          actions: [{ kind: "tool-call", callId: `${id}-call`, toolName: tool, input: { a: 1 } }],
        }),
      );
    }
    out.push(
      ev("action.result", {
        turnId: id,
        stepIndex: step,
        status: "completed",
        result: { kind: "tool-result", callId: `${id}-call`, toolName: tool, output: { rows: 3 } },
      }),
    );
  }
  // The quadratic part: each delta repeats everything written so far.
  const chunkSize = Math.max(1, Math.ceil(text.length / deltas));
  let soFar = "";
  for (const piece of text.match(new RegExp(`.{1,${chunkSize}}`, "gs")) ?? []) {
    soFar += piece;
    out.push(ev("message.appended", { turnId: id, stepIndex: step, messageDelta: piece, messageSoFar: soFar }));
  }
  out.push(ev("message.completed", { turnId: id, stepIndex: step, message: text, finishReason: "stop" }));
  out.push(ev("step.completed", { turnId: id, stepIndex: step }));
  out.push(ev("turn.completed", { turnId: id }));
  return out;
}

const park = (token) => ev("session.waiting", { continuationToken: token });

/** Multi-turn: three ordinary questions and answers, parked between each. */
const MULTI_TURN = [
  ev("session.started", {}),
  ...turn({ id: "t1", text: "The first answer, which is fairly long so the deltas pile up." }),
  park("tok-1"),
  ...turn({ id: "t2", text: "Second answer." , reasoning: "Thinking about it carefully." }),
  park("tok-2"),
  ...turn({ id: "t3", text: "Third answer." }),
  park("tok-3"),
];

/** Tool calls and an approval the user answered in the browser. */
const WITH_TOOLS = [
  ev("session.started", {}),
  ...turn({ id: "a1", text: "Looking that up.", tool: "publish_artifact", approval: true }),
  park("tok-a"),
  ...turn({ id: "a2", text: "And again, without asking.", tool: "email_create_draft" }),
  park("tok-b"),
];
/** The browser-only marker that answers a1's approval. It exists nowhere in the
 *  server stream, which is why the snapshot carries it separately. */
const WITH_TOOLS_MARKERS = [
  { type: "client.input.responded", data: { responses: [{ requestId: "a1-req", text: "yes" }] } },
];

/**
 * A session that ENDED and a new one that began — reusing the same turn id.
 *
 * This is the fixture that decides the whole design. `withSessionEpochs` keeps
 * turn ids unique across sessions by counting session ends in NON-ENUMERABLE
 * state on the projection, so a snapshot of the projected MESSAGES would restore
 * a transcript whose epoch had silently reset to zero and the second session's
 * "t1" would merge into the first session's assistant message. Storing events
 * and re-reducing them rebuilds that state exactly.
 */
const RESTARTED_SESSION = [
  ev("session.started", {}),
  ...turn({ id: "t1", text: "Before the restart." }),
  ev("session.completed", {}),
  ev("session.started", {}),
  ...turn({ id: "t1", text: "After the restart — same turn id, different session." }),
  park("tok-new"),
];

/* ---- a seeded fuzz -------------------------------------------------------- */

/** Deterministic PRNG: a failing case must be reproducible from the output. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function randomTranscript(seed) {
  const r = rng(seed);
  const out = [ev("session.started", {})];
  const turns = 1 + Math.floor(r() * 4);
  for (let i = 0; i < turns; i++) {
    out.push(
      ...turn({
        id: `f${seed}-${i}`,
        text: "x".repeat(1 + Math.floor(r() * 40)),
        deltas: 1 + Math.floor(r() * 9),
        reasoning: r() < 0.4 ? "why".repeat(1 + Math.floor(r() * 5)) : undefined,
        tool: r() < 0.5 ? "publish_artifact" : undefined,
        approval: r() < 0.3,
        step: r() < 0.2 ? 1 : 0,
      }),
    );
    if (r() < 0.3) out.push(ev("session.completed", {}), ev("session.started", {}));
    else out.push(park(`tok-${seed}-${i}`));
  }
  return out;
}

/* ---- 1. compaction is invisible to the reducer ---------------------------- */

console.log("Compaction preserves the projection:");

for (const [name, events] of [
  ["multi-turn", MULTI_TURN],
  ["tool calls + approval", WITH_TOOLS],
  ["session restart (reused turn id)", RESTARTED_SESSION],
]) {
  check(
    `${name}: compacted events project identically`,
    projectionOf(compactTranscript(events)) === projectionOf(events),
  );
}
check(
  "tool calls + approval: identical with the client markers folded in too",
  projectionOf([...compactTranscript(WITH_TOOLS), ...WITH_TOOLS_MARKERS]) ===
    projectionOf([...WITH_TOOLS, ...WITH_TOOLS_MARKERS]),
);

/* The size claim, on the fixture that has the longest answer. A cache that does
 * not shrink the stream is only moving the cost around. */
{
  const before = Buffer.byteLength(JSON.stringify(MULTI_TURN));
  const after = Buffer.byteLength(JSON.stringify(compactTranscript(MULTI_TURN)));
  check(`compaction shrinks the stream (${before}B → ${after}B)`, after < before * 0.75);
}

/* `message.completed` with a NULL message REMOVES the text part, so the delta
 * before it is load-bearing and must survive. */
{
  const nulled = [
    ev("session.started", {}),
    ev("turn.started", { turnId: "n1" }),
    ev("step.started", { turnId: "n1", stepIndex: 0 }),
    ev("message.appended", { turnId: "n1", stepIndex: 0, messageDelta: "draft", messageSoFar: "draft" }),
    ev("message.completed", { turnId: "n1", stepIndex: 0, message: null, finishReason: "tool-calls" }),
    ev("turn.completed", { turnId: "n1" }),
  ];
  check(
    "a delta before a null message.completed is kept (removeTextPart needs it)",
    projectionOf(compactTranscript(nulled)) === projectionOf(nulled),
  );
}

/* ---- 2. snapshot + tail === full replay ----------------------------------- */

console.log("\nMounting from a snapshot plus a tail equals a full replay:");

/**
 * Split a transcript at `index` and assemble it the way an open does:
 * the cached (compacted) prefix, a tail read from one event EARLIER (the seam),
 * and the browser's markers last.
 */
function openFromSnapshot(events, index, markers = []) {
  const prefix = events.slice(0, index);
  const snapshot = buildSnapshot({
    eveSessionId: "sess-1",
    streamIndex: index,
    events: [...prefix, ...markers],
  });
  assert.ok(snapshot, `buildSnapshot returned nothing at index ${index}`);
  assert.ok(snapshotUsable(snapshot, { eveSessionId: "sess-1" }), `snapshot unusable at index ${index}`);
  // What the server hands back for `startIndex = index - 1`.
  const replayed = events.slice(index - 1);
  const seam = checkSeam(snapshot, replayed);
  assert.equal(seam.status, "match", `seam did not match at index ${index}`);
  return mountFromSnapshot(snapshot, seam.tail, markers);
}

for (const [name, events, markers] of [
  ["multi-turn", MULTI_TURN, []],
  ["tool calls + approval", WITH_TOOLS, WITH_TOOLS_MARKERS],
  ["session restart (reused turn id)", RESTARTED_SESSION, []],
]) {
  const full = projectionOf([...events, ...markers]);
  let worst = null;
  for (let i = 1; i <= events.length; i++) {
    const mounted = openFromSnapshot(events, i, markers);
    if (projectionOf(mounted.events) !== full) worst = i;
    if (mounted.streamIndex !== events.length) worst ??= i;
  }
  check(`${name}: identical at all ${events.length} split points`, worst === null);
}

/* The stream cursor has to mean the STREAM, not the transcript — compaction
 * makes them different numbers, and eve passes streamIndex straight through as
 * the next startIndex. */
{
  const mounted = openFromSnapshot(MULTI_TURN, 40);
  check(
    `the mounted cursor is the absolute stream position (${mounted.streamIndex}), not the transcript length (${mounted.events.length})`,
    mounted.streamIndex === MULTI_TURN.length && mounted.events.length < MULTI_TURN.length,
  );
}

/* A jsonb column REORDERS object keys, so a stored event comes back rearranged.
 * Mount it that way, and check the seam against it. */
{
  const shuffleKeys = (v) =>
    Array.isArray(v)
      ? v.map(shuffleKeys)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, shuffleKeys(x)]))
        : v;
  const index = 30;
  const snapshot = buildSnapshot({ eveSessionId: "sess-1", streamIndex: index, events: MULTI_TURN.slice(0, index) });
  const roundTripped = { ...snapshot, events: shuffleKeys(JSON.parse(JSON.stringify(snapshot.events))) };
  const seam = checkSeam(roundTripped, MULTI_TURN.slice(index - 1));
  check("a jsonb round trip (keys reordered) still matches at the seam", seam.status === "match");
  check(
    "…and still projects identically",
    projectionOf(mountFromSnapshot(roundTripped, seam.tail).events) === projectionOf(MULTI_TURN),
  );
}

/* And the fuzz, so the claim is not just about the shapes someone thought of. */
{
  let failures = 0;
  const seeds = 40;
  for (let seed = 1; seed <= seeds; seed++) {
    const events = randomTranscript(seed);
    const full = projectionOf(events);
    for (let i = 1; i <= events.length; i++) {
      if (projectionOf(openFromSnapshot(events, i).events) !== full) {
        console.log(`     FAILED seed ${seed} at split ${i}`);
        failures++;
        break;
      }
    }
  }
  check(`${seeds} generated transcripts, every split point, all identical`, failures === 0);
}

/* The reason the snapshot stores events rather than projected messages: the
 * epoch state that keeps two sessions' identical turn ids apart is invisible to
 * JSON, so it can only survive by being recomputed. */
{
  const ids = project(RESTARTED_SESSION).messages.filter((m) => m.role === "assistant").map((m) => m.id);
  check(
    `a reused turn id across a session restart projects two distinct messages (${ids.join(", ")})`,
    ids.length === 2 && ids[0] !== ids[1],
  );
}

/* ---- 3. a snapshot that is wrong is discarded, never trusted -------------- */

console.log("\nA snapshot the stream disagrees with is discarded:");

const good = buildSnapshot({ eveSessionId: "sess-1", streamIndex: 20, events: MULTI_TURN.slice(0, 20) });

check("a good one is usable", snapshotUsable(good, { eveSessionId: "sess-1" }));
check("another session's snapshot is refused", !snapshotUsable(good, { eveSessionId: "sess-2" }));
check(
  "a snapshot from a different projection version is refused",
  !snapshotUsable({ ...good, version: SNAPSHOT_VERSION + 1 }, { eveSessionId: "sess-1" }),
);
check("an empty transcript is refused", !snapshotUsable({ ...good, events: [] }, { eveSessionId: "sess-1" }));
check(
  "a transcript longer than the stream it claims is refused",
  !snapshotUsable({ ...good, eventIndex: 2 }, { eveSessionId: "sess-1" }),
);
check("a zero index is refused", !snapshotUsable({ ...good, eventIndex: 0 }, { eveSessionId: "sess-1" }));
check("null is refused", !snapshotUsable(null, { eveSessionId: "sess-1" }));

check(
  "an index the stream cannot reach reads as BEHIND (nothing came back at the seam)",
  checkSeam(good, []).status === "behind",
);
check(
  "…and so does a tail that failed entirely",
  checkSeam(good, null).status === "behind",
);
check(
  "a seam event the stream does not agree with reads as MISMATCH",
  checkSeam(good, [ev("session.started", {}), ...MULTI_TURN.slice(20)]).status === "mismatch",
);
check(
  "a snapshot of ANOTHER conversation at the same index is a mismatch, not a merge",
  checkSeam(good, WITH_TOOLS.slice(19)).status === "mismatch",
);

/* buildSnapshot is the writer's own guard: nothing worth storing, nothing
 * stored. A mid-turn cursor is zero (advanceSession resets it away from a
 * park), and a zero cursor cannot be resumed from. */
check("no session id → nothing is stored", buildSnapshot({ eveSessionId: undefined, streamIndex: 5, events: MULTI_TURN }) === null);
check("no events → nothing is stored", buildSnapshot({ eveSessionId: "s", streamIndex: 5, events: [] }) === null);
check(
  "a mid-turn cursor (0) → nothing is stored",
  buildSnapshot({ eveSessionId: "s", streamIndex: 0, events: MULTI_TURN }) === null,
);
check(
  "browser-only markers are stored apart from the stream, never counted in it",
  (() => {
    const snap = buildSnapshot({
      eveSessionId: "sess-1",
      streamIndex: WITH_TOOLS.length,
      events: [...WITH_TOOLS, ...WITH_TOOLS_MARKERS],
    });
    const { server } = splitClientEvents(snap.events);
    return (
      snap.clientEvents.length === 1 &&
      server.length === snap.events.length &&
      snap.eventIndex === WITH_TOOLS.length
    );
  })(),
);
check(
  "a marker answered on another device is unioned, not duplicated",
  mountFromSnapshot(
    { ...good, clientEvents: WITH_TOOLS_MARKERS },
    [],
    [structuredClone(WITH_TOOLS_MARKERS[0])],
  ).events.filter((e) => e.type === "client.input.responded").length === 1,
);

/* ---- 3b. the cursor the transcript is mounted on -------------------------- */

/**
 * A DEAD SESSION'S TOKEN MUST NOT COME BACK.
 *
 * The mount is two things — a transcript and a cursor — and the cursor is the
 * half that decides where the next message goes. When a turn ends on
 * `session.failed` or `session.completed`, eve's `advanceSession` hands back
 * `createInitialSessionState()`: no id, no token, because that session cannot be
 * continued. `withFreshestToken` repairs a MISSING token from the stream, and it
 * used to do that by scanning backwards for the newest `session.waiting` — which
 * walks straight past the failure and restores the token from an earlier park of
 * the session that has just died. The next message posted to a finished session
 * with a spent token and the reader was told the connection dropped.
 *
 * So it stops at the LAST boundary now, exactly as eve does, and the rule is run
 * here rather than described: the same stream, ended three different ways.
 */
console.log("\nThe cursor a reopened chat is mounted on:");

// `park` is the fixture helper above — eve's own `session.waiting` shape.
const say = (text) => ev("message.completed", { turnId: "t", stepIndex: 0, message: text });
// What eve's advanceSession hands back for a session that cannot continue.
const EMPTY_CURSOR = { streamIndex: 0 };

check(
  "a parked session's token is still repaired onto a cursor that lost it",
  withFreshestToken(EMPTY_CURSOR, [say("hi"), park("ct_live")]).continuationToken === "ct_live",
);
check(
  "…across the deltas and markers that follow the park",
  withFreshestToken(EMPTY_CURSOR, [park("ct_live"), { type: "client.input.responded", data: {} }])
    .continuationToken === "ct_live",
);
check(
  "a session that FAILED gets no token back, however many parks precede it",
  withFreshestToken(EMPTY_CURSOR, [park("ct_dead"), say("working"), { type: "session.failed", data: { message: "boom" } }])
    .continuationToken === undefined,
);
check(
  "…and neither does one that COMPLETED",
  withFreshestToken(EMPTY_CURSOR, [park("ct_dead"), { type: "session.completed" }]).continuationToken === undefined,
);
check(
  "a turn still running supplies nothing — there is no boundary to read",
  withFreshestToken(EMPTY_CURSOR, [say("thinking")]).continuationToken === undefined,
);
check(
  "an empty token on the park is not a token (eve rejects a send carrying one)",
  withFreshestToken(EMPTY_CURSOR, [park("")]).continuationToken === undefined,
);
check(
  "a cursor that already holds a token is returned untouched",
  withFreshestToken({ streamIndex: 4, continuationToken: "ct_held" }, [{ type: "session.failed", data: {} }])
    .continuationToken === "ct_held",
);
check(
  "the boundary set is eve's own, not a second copy of it",
  (() => {
    // Every type eve's isCurrentTurnBoundaryEvent accepts, and nothing else.
    const src = readFileSync("lib/chat-session-cursor.ts", "utf8");
    return (
      /"session\.waiting", "session\.completed", "session\.failed"/.test(src) &&
      /advanceSession/.test(src)
    );
  })(),
);

/* ---- 3c. the live persist path's dedupe ---------------------------------- */

/**
 * THE INCREMENTAL DEDUPE MUST BE THE SAME ANSWER.
 *
 * `handlePersist` runs once per text delta, and it ran `dedupeEvents` — a
 * JSON.stringify per event — over the whole stream each time. eve's deltas each
 * carry `messageSoFar`, so that is a stringify of a quadratically-growing list
 * on the main thread, between a chunk of output and the paint that shows it.
 * `createEventDeduper` pays only for what arrived since the previous call.
 *
 * That is a performance change hiding a correctness claim, so the claim is
 * executed: fed a transcript one event at a time, the incremental answer is
 * byte-identical to a full `dedupeEvents` at EVERY prefix — including when the
 * array is replaced rather than appended to (a remount or a resync), and when
 * the duplicates it exists to collapse are present.
 */
console.log("\nDeduping a live stream incrementally:");

const DUPED = [
  ...WITH_TOOLS,
  ...WITH_TOOLS_MARKERS,
  structuredClone(WITH_TOOLS_MARKERS[0]), // the marker re-appended on the next persist
  ...WITH_TOOLS.slice(-4).map((e) => structuredClone(e)), // a reattach's byte-identical re-emission
];

check(
  "it collapses the duplicates a live turn accumulates",
  createEventDeduper()(DUPED).length === dedupeEvents(DUPED).length &&
    dedupeEvents(DUPED).length < DUPED.length,
);
check(
  "…and matches a full pass at EVERY prefix, growing one event at a time",
  (() => {
    const step = createEventDeduper();
    for (let n = 0; n <= DUPED.length; n++) {
      const grown = DUPED.slice(0, n);
      if (canonicalJson(step(grown)) !== canonicalJson(dedupeEvents(grown))) return false;
    }
    return true;
  })(),
);
check(
  "…when the array is REPLACED rather than appended to (a remount or a resync)",
  (() => {
    const step = createEventDeduper();
    step(DUPED);
    // A shorter, differently-identified stream: the prefix check must fail and
    // the full pass take over, or the previous turn's events leak into this one.
    const replaced = structuredClone(MULTI_TURN);
    return canonicalJson(step(replaced)) === canonicalJson(dedupeEvents(replaced));
  })(),
);
check(
  "…and when the stream goes empty and starts again",
  (() => {
    const step = createEventDeduper();
    step(DUPED);
    step([]);
    return canonicalJson(step(WITH_TOOLS)) === canonicalJson(dedupeEvents(WITH_TOOLS));
  })(),
);
check(
  "what it returns is a copy — the caller stores it, and the next call appends",
  (() => {
    const step = createEventDeduper();
    const first = step(WITH_TOOLS.slice(0, 5));
    const held = first.length;
    step(WITH_TOOLS);
    return first.length === held;
  })(),
);
check(
  "the live persist path is the one that uses it",
  /deduperRef\.current\(rawEvents\)/.test(readFileSync("app/_components/chat-shell.tsx", "utf8")),
);

/* ---- 4. tenancy and membership ------------------------------------------- */

console.log("\nWho may read a cached transcript:");

const OWNER = { ownerEmail: "owner@example.com" };
const accessFor = (email, thread, membership, ownsMirrorRow = false) =>
  snapshotAccess({ callerEmail: email, thread, membership, ownsMirrorRow });

check(
  "an unshared chat is readable by its owner",
  accessFor("me@example.com", null, null, true).read,
);
check(
  "another workspace's member cannot read a transcript they have no row for",
  !accessFor("stranger@other.example", null, null, false).read,
);
check(
  "…and cannot write one either",
  !accessFor("stranger@other.example", null, null, false).write,
);
check("a thread's owner reads and writes", accessFor("owner@example.com", OWNER, null).write);
check(
  /**
   * Was "a participant reads and writes".
   *
   * `POST /api/ops/chat-snapshots` takes the transcript as arbitrary client
   * JSON and `checkSeam` verifies exactly ONE event, so a participant could
   * hand every other member a fabricated prefix with a true tail on it — and
   * compaction means the length proves nothing either. Verifying the whole
   * thing is the full replay this cache exists to avoid, so the WRITER is
   * narrowed to the owner instead and a participant falls back to the replay.
   * The reasoning lives on `snapshotAccess`.
   */
  "a participant reads but never replaces what everyone else mounts",
  (() => {
    const a = accessFor("mate@example.com", OWNER, { role: "participant", status: "accepted" });
    return a.read && !a.write;
  })(),
);
check(
  "a viewer reads but never replaces what everyone else mounts",
  (() => {
    const a = accessFor("mate@example.com", OWNER, { role: "viewer", status: "accepted" });
    return a.read && !a.write;
  })(),
);
check(
  "a REVOKED member is cut off from the cache as well as the stream",
  !accessFor("ex@example.com", OWNER, { role: "participant", status: "revoked" }).read,
);
check(
  "someone the thread was never shared with is refused",
  !accessFor("nosy@example.com", OWNER, null).read,
);
check(
  "…even when they hold a mirror row for the same session (a shared thread's row decides)",
  !accessFor("nosy@example.com", OWNER, null, /* ownsMirrorRow */ true).read,
);
check("an empty caller is refused", !accessFor("", null, null, true).read);

/* The WORKSPACE boundary is enforced one layer down, by RLS, and the rows this
 * decision is made from are read inside it. Source-checked because the
 * behavioural proof needs a database: CI's `isolation` job pushes schema.ts into
 * a real Postgres and proves every org_id table has a policy that refuses a
 * cross-tenant read and write — the new table included, with no list to
 * maintain. */
const accessSrc = readFileSync("lib/chat-session-access.ts", "utf8");
const snapshotRoute = readFileSync("app/api/ops/chat-snapshots/route.ts", "utf8");
const replayRoute = readFileSync("app/api/ops/chat-replay/route.ts", "utf8");
const schema = readFileSync("agent/lib/db/schema.ts", "utf8");
const migration = readFileSync("drizzle/0018_chat_transcript_snapshots.sql", "utf8");

console.log("\nThe workspace boundary:");
check("every access read is workspace-scoped", !/\bdb\s*\.(select|insert|update|delete)\b/.test(accessSrc) && /withOrgRls\(orgId,/.test(accessSrc));
check(
  "the snapshot route never queries an unscoped handle",
  !/\bdb\s*\.(select|insert|update|delete)\b/.test(snapshotRoute) && /withOrgRls\(ctx\.orgId,/.test(snapshotRoute),
);
check("the table carries an org_id", /chatTranscriptSnapshots[\s\S]*?orgId: text\("org_id"\)\.notNull\(\)/.test(schema));
check("the migration enables RLS on it", /ALTER TABLE "chat_transcript_snapshots" ENABLE ROW LEVEL SECURITY/.test(migration));
check("…and forces it for the table owner", /FORCE ROW LEVEL SECURITY/.test(migration));
check("…with the same org_isolation policy every other scoped table has", /CREATE POLICY "org_isolation" ON "chat_transcript_snapshots"/.test(migration));
check("…and grants the app role no more than the others have", /GRANT SELECT, INSERT, UPDATE, DELETE ON "chat_transcript_snapshots" TO app_rw/.test(migration));
check("one transcript per session per workspace", /chat_transcript_snapshots_session_uidx/.test(migration) && /"org_id","eve_session_id"/.test(migration));
check("the migration does not touch an existing policy", !/DROP POLICY[^\n]*chat_threads|ALTER TABLE "chat_threads" (ENABLE|DISABLE|FORCE)/.test(migration));

console.log("\nBoth fast-open routes decide access before they proxy or answer:");
check("the replay proxy checks access first", /accessForSession\(/.test(replayRoute) && replayRoute.indexOf("accessForSession(") < replayRoute.indexOf("const upstream = await fetch"));
check("…and refuses without it", /status: 403/.test(replayRoute));
check("the snapshot route refuses a read it cannot authorize", /if \(!access\.read\)/.test(snapshotRoute));
check("…and a write it cannot authorize", /if \(!access\.write\)/.test(snapshotRoute));
check(
  "a transcript is never moved backwards by a truncated read",
  /setWhere: sql`\$\{chatTranscriptSnapshots\.eventIndex\} <= excluded\.event_index`/.test(snapshotRoute),
);

/* ---- 5. the client falls back, always ------------------------------------ */

console.log("\nThe client treats it as a cache, not as the truth:");
const shell = readFileSync("app/_components/chat-shell.tsx", "utf8");
check("the open verifies the seam before keeping the mount", /checkSeam\(cached, tail\?\.events\)/.test(shell));
check(
  "a seam that does not match falls through to the full replay",
  /snapshot discarded \(\$\{seam\.status\}\) — replaying in full/.test(shell),
);
check("…and forgets the row so the next open is not wrong twice", /method: "DELETE"[\s\S]{0,120}chat-snapshots|chat-snapshots[\s\S]{0,160}method: "DELETE"/.test(shell));
check("the tail is read one event BEFORE the snapshot ends, so there is a seam to check", /startIndex: cached\.eventIndex - 1/.test(shell));
check("a snapshot is only mounted after the cheap checks pass", /snapshotUsable\(snapshot, \{ eveSessionId: sessionId \}\)/.test(shell));
check("deleting a chat deletes its cached transcript", /chat-snapshots\?session=\$\{encodeURIComponent\(sid\)\}/.test(shell));
check(
  "the owned path asks the server where replay ends instead of waiting for silence",
  /\/api\/ops\/chat-replay\?session=/.test(shell),
);
check(
  "…and falls back to reading eve directly if that route is not there",
  /markerRouteOk = false/.test(shell),
);
check(
  "a marker that means 'the stream was CUT' does not end the replay",
  /ev\.data\?\.drained !== false/.test(shell),
);
check(
  "the transcript is only stored at a boundary the stream can be resumed from",
  /const atRest =/.test(shell) && /streamIndex: session\.streamIndex/.test(shell),
);

/* The harness has to keep measuring the thing that was fixed. */
const harness = readFileSync("scripts/operator/thread-open-perf.mjs", "utf8");
console.log("\nThe harness measures both terms:");
check("time spent waiting on quiet windows is its own number", /quietMs \+= performance\.now\(\) - waitedFrom/.test(harness));
check("…and its own column", /"quiet",/.test(harness));
check("the old full replay is still measured, in segments", /OLD owned full replay/.test(harness) && /async function replayProbe/.test(harness));
check("the new open is measured beside it", /NEW owned open TOTAL/.test(harness));
check("…and the comparison is printed, not claimed", /open cost for \$\{c\.thread\}/.test(harness));

console.log(`\nthread snapshot: ${passed}/${passed} checks passed`);

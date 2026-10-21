/**
 * THE CONTROL PANEL'S SPECIALIST FEEDS (lib/child-feed.ts): the fold, and the store that reads them.
 *
 * Measured before this module (onfinance_hfc, 2026-10-13): every chat open re-read every specialist's stream from
 * event 0 (9.4 MB to over 147 MB each), folded it with one state update per event, waited for ever on the 6 of 12
 * streams that never answered, and started all of it at mount. What is held here, each on the real reducer
 * (`withSessionEpochs(defaultMessageReducer())`, the one the panel and the chat mount):
 *
 *   1. Fold parity. Skipping superseded cumulative deltas changes nothing: messages, rows, nested sessions,
 *      completed, the resume token, turn state are identical to folding every line, on every recorded stream in
 *      scripts/fixtures and on a generated long-reasoning specialist.
 *   2. Resume parity. A fold stopped at ANY line and continued from its cursor equals the fold from 0, with no tool
 *      row twice. (Folding the history again onto a kept fold, which a resume at 0 did, does duplicate them: the
 *      control below proves the check can see the fault.)
 *   3. Batched updates: 4,000 events over 2 s reach the panel in a bounded number of updates, not one per event.
 *   4. Deferral and the pool: nothing finished is read before the chat is ready; then at most 3 at once; a stream
 *      with no boundary (ending on `input.requested`, or mid-reasoning) frees its slot when it goes quiet.
 *   5. The deadline: a stream with no headers in 10 s is retried once, then "unavailable", and Retry reads again.
 *   6. A running specialist is never marked ended or unavailable by a timer; a failed live read is retried.
 *   7. A parked specialist is read at once, before the chat is ready, and its resume token is there.
 *   8. A remount, and a chat switch and back, read nothing again for a finished specialist; an interrupted harvest
 *      resumes at its cursor, never at 0; a feed re-wanted within the grace period keeps its connection.
 *   9. The cache is bounded: the least recently used fold goes first.
 *  11. Wired to the chat-open record (lib/chat-open-timing.ts) the way the panel wires it: an open's record carries
 *      each specialist's reads (requests, bytes, headers, settle, when it started, live or not).
 *  12. Finished specialists are harvested when the open SETTLES (`afterChatOpenSettled`), not on a fixed delay; a
 *      safety timeout lets them go if settle never comes; an unmounted panel is never woken.
 *  13. A saved copy per specialist (lib/child-copy.ts): a copy taken at any session boundary, folded again and
 *      continued from its cursor, equals the fold of the whole stream (messages, rows, nested specialists, completed,
 *      the resume token, turn state), on every recorded and generated stream; the token is never in the copy. On a
 *      second page the details are there from the copy before any stream is read, finished specialists make ZERO
 *      reads from event 0 (only the one-event seam read), parked and running ones read from the stored index; a copy
 *      the stream disagrees with is replaced with no intermediate state shown; the parent's seam rules (retry once,
 *      then replace on "behind", keep on silence or error); never a copy at or below the stored cursor, never one
 *      over the size cap; a copy that never answers is not waited for.
 *
 * Run: npm run test:child-feed
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { ChildFeedStore, ChildFold, foldLines, peekDelta, takeLines } from "../lib/child-feed.ts";
import { CHILD_COPY_VERSION, childCopyUsable, childSeamVerdict } from "../lib/child-copy.ts";
import { specialistStream } from "./fixtures/child-feed/make-stream.mjs";
import * as timing from "../lib/chat-open-timing.ts";

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail === undefined ? "" : `\n         got: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}`}`);
  }
};

const summarize = (name, input) => (input && typeof input === "object" ? `${name}:${JSON.stringify(input).slice(0, 40)}` : null);

/** Everything a panel reads from a fold, as plain data. */
const visible = (fold) => {
  const v = fold.view();
  return JSON.stringify({
    messages: v.messages,
    rows: v.rows,
    childSessions: v.childSessions,
    completed: v.completed,
    continuationToken: v.continuationToken,
    turnActive: v.turnActive,
    stopped: v.stopped,
  });
};
const toolRowIds = (fold) => fold.view().rows.filter((r) => r.kind === "tool").map((r) => r.id);
const dupes = (ids) => ids.filter((id, i) => ids.indexOf(id) !== i);

/* ---------------------------------------------------------------------------------------------------------------- */
console.log("\n1. Fold parity: superseded deltas skipped unparsed, nothing visible changes");

const recorded = [];
for (const dir of ["event-order", "handback", "subagent-delivery", "specialist-question", "approval-park", "buffered-turns"]) {
  let names = [];
  try {
    names = readdirSync(`scripts/fixtures/${dir}`).filter((n) => n.endsWith(".ndjson"));
  } catch {
    continue;
  }
  for (const n of names) {
    recorded.push({ name: `${dir}/${n}`, lines: readFileSync(`scripts/fixtures/${dir}/${n}`, "utf8").split("\n").filter((l) => l.trim()) });
  }
}
check(`recorded streams found (${recorded.length})`, recorded.length >= 10, recorded.length);

const generated = [
  { name: "long reasoning, parks with a token", lines: specialistStream({ seed: 3, steps: 4, reasoningChars: 20_000, nested: "wrun_NESTED" }) },
  { name: "ends on input.requested (no boundary)", lines: specialistStream({ seed: 4, steps: 2, end: "input" }) },
  { name: "cut off mid-reasoning (no boundary)", lines: specialistStream({ seed: 5, steps: 2, end: "reasoning" }) },
  { name: "session.completed", lines: specialistStream({ seed: 6, steps: 2, end: "completed" }) },
  { name: "failure cascade", lines: specialistStream({ seed: 7, steps: 1, end: "failed" }) },
];

for (const { name, lines } of [...recorded, ...generated]) {
  const reference = foldLines(lines, { summarize, skipSuperseded: false });
  const skipping = foldLines(lines, { summarize });
  check(`${name}: identical to folding every line (${skipping.skipped} of ${lines.length} skipped)`, visible(skipping) === visible(reference));
  check(`${name}: cursor counts every line`, skipping.cursor === lines.length && reference.cursor === lines.length, { a: skipping.cursor, b: lines.length });
}
{
  const lines = generated[0].lines;
  const fold = foldLines(lines, { summarize });
  const deltas = lines.filter((l) => l.includes('"type":"reasoning.appended"')).length;
  check(
    `long reasoning: every superseded delta skipped unparsed (${fold.skipped} lines; ${deltas} reasoning deltas in the stream)`,
    fold.skipped >= deltas - 4,
    { skipped: fold.skipped, deltas },
  );
  check("long reasoning: the resume token and the nested specialist are there", fold.view().continuationToken === "eve:token-1" && fold.view().childSessions.includes("wrun_NESTED"));
}

// The peek: a delta is recognised from its tail, anything uncertain is parsed.
check("peek: eve's layout", JSON.stringify(peekDelta(generated[0].lines[5])) === JSON.stringify({ kind: "reasoning.appended", turnId: "turn_0", stepIndex: 0 }), peekDelta(generated[0].lines[5]));
check("peek: type first", peekDelta('{"type":"message.appended","data":{"messageSoFar":"x","stepIndex":2,"turnId":"t"}}')?.stepIndex === 2);
check("peek: no slot, no peek", peekDelta('{"data":{"reasoningSoFar":"x"},"type":"reasoning.appended"}') === null);
check("peek: a string that SAYS it is a delta is not one", peekDelta(JSON.stringify({ data: { text: '"type":"reasoning.appended"' }, type: "message.received" })) === null);
check("peek: other events", peekDelta(generated[0].lines[0]) === null);
// A delta followed by `message.completed` with `message: null` is load-bearing (removeTextPart).
{
  const lines = [
    JSON.stringify({ data: { sequence: 0, turnId: "turn_0" }, type: "turn.started" }),
    JSON.stringify({ data: { sequence: 0, stepIndex: 0, turnId: "turn_0" }, type: "step.started" }),
    JSON.stringify({ data: { messageDelta: "x", messageSoFar: "x", sequence: 0, stepIndex: 0, turnId: "turn_0" }, type: "message.appended" }),
    JSON.stringify({ data: { message: null, sequence: 0, stepIndex: 0, turnId: "turn_0" }, type: "message.completed" }),
  ];
  const a = foldLines(lines, { summarize });
  const b = foldLines(lines, { summarize, skipSuperseded: false });
  check("a delta before message.completed {message: null} is kept", visible(a) === visible(b) && a.skipped === 0, a.skipped);
}
check("takeLines keeps the unfinished remainder", JSON.stringify(takeLines("a\nb\nc")) === JSON.stringify({ lines: ["a", "b"], rest: "c" }));

/* ---------------------------------------------------------------------------------------------------------------- */
console.log("\n2. Resume parity: a fold continued from its cursor equals the fold from 0, no tool row twice");

for (const { name, lines } of [generated[0], generated[1], ...recorded.filter((r) => r.name.startsWith("handback/")).slice(0, 3)]) {
  const whole = visible(foldLines(lines, { summarize }));
  let mismatches = 0;
  let dup = 0;
  const step = Math.max(1, Math.floor(lines.length / 60));
  for (let k = 0; k <= lines.length; k += step) {
    const fold = new ChildFold({ summarize });
    for (const l of lines.slice(0, k)) fold.push(l);
    fold.view(); // a flush in between, as the panel does
    const resumeAt = fold.cursor;
    for (const l of lines.slice(resumeAt)) fold.push(l);
    if (visible(fold) !== whole) mismatches++;
    dup += dupes(toolRowIds(fold)).length;
  }
  check(`${name}: identical at every resume point`, mismatches === 0, mismatches);
  check(`${name}: no duplicated tool rows`, dup === 0, dup);
}
{
  // The control: what a resume at 0 did (fold the history again onto the kept fold) duplicates tool rows.
  const lines = generated[0].lines;
  const fold = foldLines(lines, { summarize });
  for (const l of lines) fold.push(l);
  check("control: folding the history again onto a kept fold duplicates tool rows (the fault the cursor prevents)", dupes(toolRowIds(fold)).length > 0);
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* A clock and a network the store can be driven by.                                                               */

function harness(extra = {}) {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  const requests = [];
  const streams = new Map(); // sid -> behaviour
  const clock = {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  };
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  const advance = async (ms) => {
    const until = t + ms;
    for (;;) {
      await settle();
      let next = null;
      for (const [id, x] of timers) if (x.at <= until && (next === null || x.at < timers.get(next).at)) next = id;
      if (next === null) break;
      const x = timers.get(next);
      timers.delete(next);
      t = Math.max(t, x.at);
      x.fn();
    }
    t = until;
    await settle();
  };
  /**
   * A stream behaviour: { lines, headersAfter (ms or Infinity), chunk (lines per chunk), every (ms between chunks),
   * hold (keep open after the lines), status, fail (reject the fetch) }.
   */
  const fetch = (url, init) => {
    const u = new URL(url, "http://x");
    const sid = decodeURIComponent(u.pathname.split("/")[4]);
    const startIndex = Number(u.searchParams.get("startIndex"));
    const req = { sid, startIndex, url, at: t, aborted: false, closed: false };
    requests.push(req);
    const b = streams.get(sid) ?? { lines: [], hold: true };
    return new Promise((resolve, reject) => {
      const signal = init.signal;
      let controller;
      const onAbort = () => {
        req.aborted = true;
        reject(new DOMException("aborted", "AbortError"));
        try {
          controller?.error(new DOMException("aborted", "AbortError"));
        } catch {}
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      if (b.fail) {
        clock.setTimer(() => reject(new TypeError("network")), b.failAfter ?? 0);
        return;
      }
      if (b.headersAfter === Infinity) return;
      clock.setTimer(() => {
        if (signal.aborted) return;
        const lines = b.lines.slice(startIndex);
        const per = b.chunk ?? lines.length;
        let i = 0;
        const body = new ReadableStream({
          start(c) {
            controller = c;
            const pushSome = () => {
              if (signal.aborted) return;
              if (i < lines.length) {
                const part = lines.slice(i, i + per);
                i += per;
                try {
                  c.enqueue(new TextEncoder().encode(part.map((l) => `${l}\n`).join("")));
                } catch {
                  return;
                }
                if (i < lines.length) clock.setTimer(pushSome, b.every ?? 0);
                else if (!b.hold) {
                  req.closed = true;
                  c.close();
                }
              } else if (!b.hold) {
                req.closed = true;
                c.close();
              }
            };
            pushSome();
          },
        });
        resolve(
          new Response(body, {
            status: b.status ?? 200,
            headers: { "content-type": "application/x-ndjson", ...(b.delegated ? { "x-eve-session-delegation": b.delegated } : {}) },
          }),
        );
      }, b.headersAfter ?? 10);
    });
  };
  const store = new ChildFeedStore({ fetch, summarize, ...clock, ...extra });
  const updates = [];
  store.subscribe((changed) => updates.push({ at: t, sids: Object.keys(changed) }));
  return { store, streams, requests, advance, updates, now: () => t, clock };
}

const finished = (seed, extra = {}) => ({ lines: specialistStream({ seed, steps: 2, reasoningChars: 2_000 }), hold: true, ...extra });
const wants = (entries) => new Map(entries);

/* ---------------------------------------------------------------------------------------------------------------- */
console.log("\n3. Batched updates: the panel hears a bounded number of times, not once per event");
{
  const h = harness();
  const lines = specialistStream({ seed: 9, steps: 6, reasoningChars: 6_000, deltaWords: 3 });
  // ~4,000 events in chunks of 4, one chunk every 2 ms: about 2 s of stream.
  h.streams.set("wrun_BIG", { lines, chunk: 4, every: 2, hold: true });
  h.store.sync("panel", wants([["wrun_BIG", "live"]]), true);
  await h.advance(4_000);
  const forBig = h.updates.filter((u) => u.sids.includes("wrun_BIG")).length;
  const seconds = h.now() / 1000;
  check(`${lines.length} events reached the panel in ${forBig} updates (bound: 4 per second plus boundaries)`, forBig <= Math.ceil(seconds * 4) + 4, { forBig, events: lines.length });
  const feed = h.store.peek("wrun_BIG");
  check("…and the feed holds the whole stream, folded", feed.continuationToken === "eve:token-1" && feed.rows.filter((r) => r.kind === "tool").length === 6, feed.rows.length);
}

/* ---------------------------------------------------------------------------------------------------------------- */
console.log("\n4. Deferral and the pool");
{
  const h = harness();
  const sids = ["wrun_A", "wrun_B", "wrun_C", "wrun_D", "wrun_E"];
  for (const [i, sid] of sids.entries()) h.streams.set(sid, { ...finished(20 + i), chunk: 50, every: 200 });
  h.store.sync("panel", wants(sids.map((s) => [s, "harvest"])), false);
  await h.advance(5_000);
  check("nothing finished is read before the chat is ready", h.requests.length === 0, h.requests.length);
  h.store.sync("panel", wants(sids.map((s) => [s, "harvest"])), true);
  await h.advance(50);
  check("once ready: at most 3 at once", h.store.inFlight().pooled === 3 && h.requests.length === 3, h.store.inFlight());
  let maxPooled = 0;
  for (let i = 0; i < 200; i++) {
    await h.advance(100);
    maxPooled = Math.max(maxPooled, h.store.inFlight().pooled);
  }
  check("never more than 3", maxPooled <= 3, maxPooled);
  check("…and every one is harvested to its boundary", sids.every((s) => h.store.peek(s).status === "ended" && h.store.peek(s).continuationToken), sids.map((s) => h.store.peek(s).status));
  check("each read exactly once", h.requests.length === 5, h.requests.map((r) => r.sid));
}
{
  const h = harness();
  // Three streams with NO boundary hold every slot unless quiet frees them.
  h.streams.set("wrun_Q1", { lines: specialistStream({ seed: 31, steps: 1, end: "input" }), hold: true });
  h.streams.set("wrun_Q2", { lines: specialistStream({ seed: 32, steps: 1, end: "reasoning" }), hold: true });
  h.streams.set("wrun_Q3", { lines: specialistStream({ seed: 33, steps: 1, end: "input" }), hold: true });
  h.streams.set("wrun_Q4", finished(34));
  h.store.sync("panel", wants(["wrun_Q1", "wrun_Q2", "wrun_Q3", "wrun_Q4"].map((s) => [s, "harvest"])), true);
  await h.advance(1_000);
  check("three boundary-less streams fill the pool", h.store.inFlight().pooled === 3 && !h.requests.some((r) => r.sid === "wrun_Q4"));
  await h.advance(1_000);
  check("input.requested then 1.5 s quiet frees the slot (the fourth starts)", h.requests.some((r) => r.sid === "wrun_Q4"), h.requests.map((r) => r.sid));
  await h.advance(6_000);
  check("mid-reasoning then 5 s quiet frees it too", h.store.inFlight().open === 0, h.store.inFlight());
  check("a quiet end is ended, not unavailable", ["wrun_Q1", "wrun_Q2", "wrun_Q3"].every((s) => h.store.peek(s).status === "ended"));
  check("…and the quiet ones were really closed", h.requests.filter((r) => r.sid !== "wrun_Q4").every((r) => r.aborted));
}

/* ---------------------------------------------------------------------------------------------------------------- */
console.log("\n5. The deadline: no headers in 10 s, retried once, then unavailable, and Retry reads again");
{
  const h = harness();
  h.streams.set("wrun_STALL", { headersAfter: Infinity });
  h.streams.set("wrun_OK", finished(41));
  h.store.sync("panel", wants([["wrun_STALL", "harvest"], ["wrun_OK", "harvest"]]), true);
  await h.advance(9_000);
  check("before 10 s: one request, still waiting", h.requests.filter((r) => r.sid === "wrun_STALL").length === 1 && h.store.peek("wrun_STALL").status === "idle");
  await h.advance(2_000);
  const stall = h.requests.filter((r) => r.sid === "wrun_STALL");
  check("at 10 s: the first request is abandoned and retried once, from the same cursor", stall.length === 2 && stall[0].aborted && stall[1].startIndex === 0, stall);
  await h.advance(10_000);
  check("at 20 s: unavailable", h.store.peek("wrun_STALL").status === "unavailable", h.store.peek("wrun_STALL").status);
  check("…its connection cleared (nothing open)", h.store.inFlight().open === 0 && h.requests.filter((r) => r.sid === "wrun_STALL").every((r) => r.aborted));
  check("…and not retried by itself", h.requests.filter((r) => r.sid === "wrun_STALL").length === 2);
  check("the healthy one was not held up", h.store.peek("wrun_OK").status === "ended");
  h.streams.set("wrun_STALL", finished(42));
  h.store.retry("wrun_STALL");
  await h.advance(500);
  check("Retry reads it again, and now it loads", h.requests.filter((r) => r.sid === "wrun_STALL").length === 3 && h.store.peek("wrun_STALL").continuationToken === "eve:token-1", h.store.peek("wrun_STALL").status);
  const stats = h.store.stats().find((s) => s.sessionId === "wrun_STALL");
  check("stats: requests, bytes, time to headers and to settle", stats.requests === 3 && stats.bytes > 0 && stats.timeToHeadersMs !== null && stats.timeToSettleMs !== null, stats);
}
{
  const h = harness();
  h.streams.set("wrun_STALL2", { headersAfter: Infinity });
  h.store.sync("panel", wants([["wrun_STALL2", "harvest"]]), true);
  await h.advance(25_000);
  h.store.sync("panel", wants([["wrun_STALL2", "live"]]), true);
  await h.advance(100);
  check("an unavailable harvest that is then selected is read again (its entry was cleared)", h.requests.filter((r) => r.sid === "wrun_STALL2").length === 3);
}

/* ---------------------------------------------------------------------------------------------------------------- */
console.log("\n6. A running specialist is never marked ended by a timer");
{
  const h = harness();
  h.streams.set("wrun_RUN", { headersAfter: Infinity });
  h.store.sync("panel", wants([["wrun_RUN", "live"]]), false);
  await h.advance(120_000);
  check("live, no headers for 2 minutes: one request, still open, not unavailable, not ended", h.requests.length === 1 && !h.requests[0].aborted && h.store.peek("wrun_RUN").status === "idle", h.store.peek("wrun_RUN").status);
}
{
  const h = harness();
  h.streams.set("wrun_RUN2", { fail: true, failAfter: 100 });
  h.store.sync("panel", wants([["wrun_RUN2", "live"]]), true);
  await h.advance(1_000);
  check("a failed live read is not ended", h.store.peek("wrun_RUN2").status !== "ended");
  h.streams.set("wrun_RUN2", { lines: specialistStream({ seed: 51, steps: 1, end: "running" }), hold: true });
  await h.advance(3_000);
  check("…it is retried, and the retry attaches live", h.requests.length === 2 && h.store.peek("wrun_RUN2").status === "live", { n: h.requests.length, status: h.store.peek("wrun_RUN2").status });
  await h.advance(60_000);
  check("a running stream that goes quiet stays live (no quiet end for live)", h.store.peek("wrun_RUN2").status === "live" && h.store.inFlight().open === 1);
}
{
  const h = harness();
  h.streams.set("wrun_UP", { lines: specialistStream({ seed: 52, steps: 2, reasoningChars: 4_000 }), chunk: 20, every: 200, hold: true });
  h.store.sync("panel", wants([["wrun_UP", "harvest"]]), true);
  await h.advance(300);
  h.store.sync("panel", wants([["wrun_UP", "live"]]), true);
  await h.advance(60_000);
  check("a harvest that becomes live keeps its connection (no second request) and stays connected past its boundary", h.requests.length === 1 && h.store.inFlight().open === 1, { n: h.requests.length, open: h.store.inFlight() });
}

{
  const h = harness({ liveRetryMs: [100, 100] });
  h.streams.set("wrun_DEAD", { fail: true, failAfter: 10 });
  h.streams.set("wrun_OTHER", finished(53));
  h.store.sync("panel", wants([["wrun_DEAD", "live"]]), true);
  await h.advance(2_000);
  check("a live read that keeps failing: tried 3 times, then unavailable", h.requests.length === 3 && h.store.peek("wrun_DEAD").status === "unavailable", { n: h.requests.length, status: h.store.peek("wrun_DEAD").status });
  h.store.sync("panel", wants([["wrun_DEAD", "live"], ["wrun_OTHER", "harvest"]]), true);
  await h.advance(5_000);
  check("…and later scheduling does not reopen it (only Retry does)", h.requests.filter((r) => r.sid === "wrun_DEAD").length === 3);
  h.store.retry("wrun_DEAD");
  await h.advance(50);
  check("Retry reads it again", h.requests.filter((r) => r.sid === "wrun_DEAD").length === 4);
}
{
  const h = harness();
  h.streams.set("wrun_SEL", finished(54));
  h.store.sync("panel", wants([["wrun_SEL", "live"]]), true);
  await h.advance(2_000);
  check("a finished run opened in the rail is read live past its boundary", h.store.inFlight().open === 1 && h.store.peek("wrun_SEL").status === "ended");
  h.store.sync("panel", wants([["wrun_SEL", "harvest"]]), true);
  await h.advance(100);
  check("closed again: its connection is let go, and it is not read again", h.store.inFlight().open === 0 && h.requests.length === 1 && h.requests[0].aborted);
}

/* ---------------------------------------------------------------------------------------------------------------- */
console.log("\n7. A parked specialist is read at once, ahead of the queue, and its token is there");
{
  const h = harness();
  for (const s of ["wrun_F1", "wrun_F2", "wrun_F3", "wrun_F4"]) h.streams.set(s, { headersAfter: Infinity });
  h.streams.set("wrun_PARKED", { lines: specialistStream({ seed: 61, steps: 1, token: "eve:parked-token" }), hold: true });
  h.store.sync("panel", wants([["wrun_F1", "harvest"], ["wrun_F2", "harvest"], ["wrun_F3", "harvest"], ["wrun_F4", "harvest"], ["wrun_PARKED", "priority"]]), false);
  await h.advance(200);
  check("before the chat is ready: only the parked one is read", h.requests.length === 1 && h.requests[0].sid === "wrun_PARKED", h.requests.map((r) => r.sid));
  check("its resume token is there (steering and Resume need it)", h.store.peek("wrun_PARKED").continuationToken === "eve:parked-token");
  h.store.sync("panel", wants([["wrun_F1", "harvest"], ["wrun_F2", "harvest"], ["wrun_F3", "harvest"], ["wrun_F4", "harvest"], ["wrun_PARKED", "priority"]]), true);
  await h.advance(100);
  check("once ready, the finished ones go through the pool (3)", h.store.inFlight().pooled === 3);
}

/* ---------------------------------------------------------------------------------------------------------------- */
console.log("\n8. Remounts and chat switches");
{
  const h = harness();
  h.streams.set("wrun_X", finished(71));
  h.streams.set("wrun_Y", finished(72));
  h.store.sync("mount-1", wants([["wrun_X", "harvest"], ["wrun_Y", "harvest"]]), true);
  await h.advance(2_000);
  const before = h.requests.length;
  h.store.release("mount-1");
  const got = h.store.sync("mount-2", wants([["wrun_X", "harvest"], ["wrun_Y", "harvest"]]), true);
  await h.advance(10_000);
  check("remount: zero new requests for finished specialists", h.requests.length === before, h.requests.length - before);
  check("remount: their folds are there at once", got.wrun_X?.continuationToken === "eve:token-1" && got.wrun_Y?.rows.length > 0);
  h.store.release("mount-2");
  h.store.sync("chat-B", wants([]), true);
  await h.advance(5_000);
  h.store.release("chat-B");
  h.store.sync("chat-A-again", wants([["wrun_X", "harvest"], ["wrun_Y", "harvest"]]), true);
  await h.advance(10_000);
  check("chat A → B → A: zero new requests for finished specialists", h.requests.length === before);
}
{
  const h = harness();
  h.streams.set("wrun_SLOW", { lines: specialistStream({ seed: 81, steps: 3, reasoningChars: 3_000 }), chunk: 25, every: 300, hold: true });
  h.store.sync("mount-1", wants([["wrun_SLOW", "harvest"]]), true);
  await h.advance(1_000);
  h.store.release("mount-1");
  await h.advance(500);
  h.store.sync("mount-2", wants([["wrun_SLOW", "harvest"]]), false);
  await h.advance(60_000);
  check("re-wanted within the grace period: the same connection carries on (one request)", h.requests.length === 1 && h.store.peek("wrun_SLOW").status === "ended", { n: h.requests.length, status: h.store.peek("wrun_SLOW").status });
}
{
  const h = harness();
  const lines = specialistStream({ seed: 82, steps: 3, reasoningChars: 3_000 });
  h.streams.set("wrun_CUT", { lines, chunk: 25, every: 300, hold: true });
  h.store.sync("chat-A", wants([["wrun_CUT", "harvest"]]), true);
  await h.advance(1_500);
  h.store.release("chat-A");
  await h.advance(5_000);
  const first = h.requests[0];
  check("left for another chat: the harvest is let go after the grace period", first.aborted && h.store.inFlight().open === 0);
  h.store.sync("chat-A-again", wants([["wrun_CUT", "harvest"]]), true);
  await h.advance(60_000);
  const second = h.requests[1];
  check("back: it resumes at its cursor, not at 0", second && second.startIndex > 0, second);
  const reference = foldLines(lines, { summarize });
  const feed = h.store.peek("wrun_CUT");
  check("…and the result equals one uninterrupted fold, no tool row twice", JSON.stringify(feed.messages) === JSON.stringify(reference.view().messages) && JSON.stringify(feed.rows) === JSON.stringify(reference.view().rows) && dupes(feed.rows.filter((r) => r.kind === "tool").map((r) => r.id)).length === 0);
}
{
  // Workspaces never share a fold.
  let scope = "ws-1";
  const h = harness({ scope: () => scope });
  h.streams.set("wrun_W", finished(91));
  h.store.sync("p", wants([["wrun_W", "harvest"]]), true);
  await h.advance(2_000);
  h.store.release("p");
  scope = "ws-2";
  h.store.sync("p2", wants([["wrun_W", "harvest"]]), true);
  await h.advance(2_000);
  check("another workspace reads for itself (the cache is per workspace)", h.requests.length === 2);
}

/* ---------------------------------------------------------------------------------------------------------------- */
console.log("\n9. The chat-open record hears every read (lib/chat-open-timing.ts's probe shape)");
{
  const calls = [];
  const probe = (sid, live) => {
    calls.push([sid, "probe", live]);
    return {
      request: () => calls.push([sid, "request"]),
      headers: () => calls.push([sid, "headers"]),
      bytes: (n) => calls.push([sid, "bytes", n]),
      settle: (o) => calls.push([sid, "settle", o]),
    };
  };
  const h = harness({ probe, liveRetryMs: [100] });
  h.streams.set("wrun_P1", finished(111));
  h.streams.set("wrun_P2", { headersAfter: Infinity });
  h.streams.set("wrun_P3", { lines: specialistStream({ seed: 113, steps: 2, reasoningChars: 3_000 }), chunk: 10, every: 300, hold: true });
  h.streams.set("wrun_P4", { fail: true, failAfter: 10 });
  h.store.sync("p", wants([["wrun_P1", "harvest"], ["wrun_P2", "harvest"], ["wrun_P4", "live"]]), true);
  h.store.sync("q", wants([["wrun_P3", "harvest"]]), true);
  await h.advance(1_000);
  h.store.release("q");
  await h.advance(25_000);
  const of = (sid) => calls.filter((c) => c[0] === sid).map((c) => (c[1] === "bytes" ? "bytes" : c[1] === "settle" ? `settle:${c[2]}` : c[1]));
  const squeeze = (xs) => xs.filter((x, i) => x !== "bytes" || xs[i - 1] !== "bytes");
  check("a harvest read to its boundary: request, headers, bytes, caught-up", JSON.stringify(squeeze(of("wrun_P1"))) === JSON.stringify(["probe", "request", "headers", "bytes", "settle:caught-up"]), of("wrun_P1"));
  check("a stalled one: two requests, then unavailable", JSON.stringify(of("wrun_P2")) === JSON.stringify(["probe", "request", "request", "settle:unavailable"]), of("wrun_P2"));
  check("one let go when the panel left: aborted", of("wrun_P3").at(-1) === "settle:aborted", of("wrun_P3"));
  check("a live one that failed through its retry: failed, once, with both requests counted", JSON.stringify(of("wrun_P4").filter((x) => x !== "probe")) === JSON.stringify(["request", "request", "settle:failed"]), of("wrun_P4"));
  check("a throwing reporter never breaks a read", await (async () => {
    const h2 = harness({ probe: () => { throw new Error("boom"); } });
    h2.streams.set("wrun_P5", finished(115));
    h2.store.sync("p", wants([["wrun_P5", "harvest"]]), true);
    await h2.advance(2_000);
    return h2.store.peek("wrun_P5").continuationToken === "eve:token-1";
  })());
}

/* ---------------------------------------------------------------------------------------------------------------- */
console.log("\n10. The cache is bounded, least recently used first");
{
  const h = harness({ budgetChars: 150_000 });
  const sids = ["wrun_L1", "wrun_L2", "wrun_L3", "wrun_L4", "wrun_L5", "wrun_L6"];
  for (const [i, s] of sids.entries()) h.streams.set(s, { lines: specialistStream({ seed: 100 + i, steps: 2, reasoningChars: 20_000 }), hold: true });
  for (const s of sids) {
    h.store.sync(`p-${s}`, wants([[s, "harvest"]]), true);
    await h.advance(2_000);
    h.store.release(`p-${s}`);
    await h.advance(2_000);
  }
  const kept = sids.filter((s) => h.store.peek(s)?.continuationToken);
  check(`over budget, the oldest folds were dropped (kept ${kept.length} of ${sids.length}), the newest kept`, kept.length < sids.length && kept.includes("wrun_L6") && !kept.includes("wrun_L1"), kept);
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* 11 and 12 drive the store and the chat-open record on ONE clock, wired as app/_components/cockpit.tsx and        */
/* app/_components/agent-chat.tsx wire them.                                                                       */

/** The record's module on the harness's clock; returns the rows it posts. */
function wireTiming(h) {
  timing.resetChatOpenTimingForTest();
  const rows = [];
  timing.configureChatOpenTiming({
    clock: { now: h.clock.now, setTimeout: h.clock.setTimer, clearTimeout: h.clock.clearTimer },
    post: (row) => rows.push(row),
    composerReady: null,
    lagSampler: null,
    storageChars: null,
    windowStore: false,
  });
  return rows;
}
/** The panel's probe, exactly as cockpit.tsx `feedStore` passes it. */
const panelProbe = (sid, live) => timing.specialistStream(sid, { live });

console.log("\n11. A chat open's record carries each specialist's reads (the panel's probe, wired)");
{
  const h = harness({ probe: panelProbe });
  const rows = wireTiming(h);
  h.streams.set("wrun_RUN", { lines: specialistStream({ seed: 201, steps: 2, reasoningChars: 2_000 }), chunk: 20, every: 50, hold: true });
  h.streams.set("wrun_DONE1", finished(202));
  h.streams.set("wrun_DONE2", finished(203));
  const open = timing.beginChatOpen({ chatId: "chat-11", sessionId: "sess-11", storedEvents: 0, storedToken: false });
  open.route("full-replay");
  const w = wants([["wrun_RUN", "live"], ["wrun_DONE1", "harvest"], ["wrun_DONE2", "harvest"]]);
  h.store.sync("panel", w, false);
  // A slow full replay: 2.4 s to paint, over SLOW_OPEN_MS, so the open posts its detailed row.
  await h.advance(2_400);
  open.replay(2_400, 900);
  timing.noteChatCommit({ mountKey: "chat-11", reactKey: "chat-11#0", hasMessages: true, shimmer: false });
  open.settled();
  h.store.sync("panel", w, true);
  await h.advance(3_000);
  check("the record is still open while the window runs", !open.record.closed);
  await h.advance(timing.OPEN_WINDOW_MS);
  const sp = open.record.specialists;
  check("the closed record lists one entry per specialist read during the open (3)", open.record.closed && sp.length === 3, sp);
  check("…and no ids in it", sp.every((x) => !Object.values(x).some((v) => typeof v === "string" && v.startsWith("wrun_"))), sp);
  const live = sp.filter((x) => x.live);
  const done = sp.filter((x) => !x.live);
  check("one live specialist, two finished ones", live.length === 1 && done.length === 2, sp.map((x) => x.live));
  check("every entry counted its request, its bytes and its time to headers", sp.every((x) => x.requests >= 1 && x.bytes > 0 && typeof x.headersMs === "number"), sp);
  check("the live one started at the click (attached at once)", live[0]?.startedAfterMs === 0, live[0]);
  check("the finished ones started only after the open settled (2.4 s), and read to their boundary", done.every((x) => x.startedAfterMs >= 2_400 && x.outcome === "caught-up" && typeof x.settleMs === "number"), done);
  check("the byte counts are what the store read (the page-life stats agree)", (() => {
    const life = h.store.stats();
    const sum = (xs) => xs.reduce((a, x) => a + x.bytes, 0);
    return sum(sp) === sum(life.filter((x) => ["wrun_RUN", "wrun_DONE1", "wrun_DONE2"].includes(x.sessionId)));
  })(), { record: sp.map((x) => x.bytes), life: h.store.stats() });
  const detail = timing.formatOpenDetail(open.record);
  check("the open's detail row carries their totals (spec=3, requests, bytes)", /spec=3 req=\d+ rx=/.test(detail) && !/spec=0/.test(detail), detail);
  check("the slow open posted it", rows.some((r) => r.kind === "thread-open" && /spec=3/.test(r.detail ?? "")), rows);
  // A read that starts in the NEXT open reports there, never into this one.
  const next = timing.beginChatOpen({ chatId: "chat-12", sessionId: "sess-12", storedEvents: 0, storedToken: false });
  h.streams.set("wrun_LATER", finished(204));
  h.store.sync("panel-2", wants([["wrun_LATER", "harvest"]]), true);
  await h.advance(timing.OPEN_WINDOW_MS + 1_000);
  check("a read in the next open is that open's, not the closed one's", open.record.specialists.length === 3 && next.record.specialists.length === 1, next.record.specialists);
  timing.resetChatOpenTimingForTest();
}

console.log("\n12. Finished specialists are harvested when the open settles, not on a fixed delay");
{
  /** The panel as agent-chat.tsx drives it: harvests wanted at mount, `ready` flipped by the settle gate. */
  const mountPanel = (h, owner, w) => {
    h.store.sync(owner, w, false);
    return timing.afterChatOpenSettled(() => h.store.sync(owner, w, true));
  };
  {
    const h = harness();
    wireTiming(h);
    h.streams.set("wrun_S1", finished(301));
    h.streams.set("wrun_S2", finished(302));
    const open = timing.beginChatOpen({ chatId: "c-s", sessionId: "s-s", storedEvents: 0, storedToken: true });
    mountPanel(h, "panel", wants([["wrun_S1", "harvest"], ["wrun_S2", "harvest"]]));
    // A slow saved copy and seam read: 4 s, well past the old "paint + 2.5 s" rule, and short of the safety net.
    await h.advance(4_000);
    check("nothing finished is read while the open has not settled (4 s in)", h.requests.length === 0, h.requests);
    open.settled();
    await h.advance(0);
    check("the harvest starts the moment the open settles", h.requests.length === 2 && h.requests.every((r) => r.at === 4_000), h.requests.map((r) => r.at));
    await h.advance(2_000);
    check("…and reads them to their boundary", h.store.peek("wrun_S1")?.status === "ended" && h.store.peek("wrun_S2")?.status === "ended");
  }
  {
    const h = harness();
    wireTiming(h);
    h.streams.set("wrun_E1", finished(303));
    const open = timing.beginChatOpen({ chatId: "c-e", sessionId: "s-e", storedEvents: 10, storedToken: true });
    open.route("local");
    open.settled();
    mountPanel(h, "panel", wants([["wrun_E1", "harvest"]]));
    await h.advance(0);
    check("an open that already settled (a local open) lets the harvest start at once", h.requests.length === 1 && h.requests[0].at === 0, h.requests);
  }
  {
    const h = harness();
    wireTiming(h);
    h.streams.set("wrun_N1", finished(304));
    mountPanel(h, "panel", wants([["wrun_N1", "harvest"]]));
    await h.advance(0);
    check("a mount with no open in progress (a remount after the window) harvests at once", h.requests.length === 1, h.requests);
  }
  {
    const h = harness();
    wireTiming(h);
    h.streams.set("wrun_T1", finished(305));
    timing.beginChatOpen({ chatId: "c-t", sessionId: "s-t", storedEvents: 0, storedToken: false });
    mountPanel(h, "panel", wants([["wrun_T1", "harvest"]]));
    await h.advance(timing.HARVEST_SAFETY_MS - 1);
    check(`settle never comes: nothing read before the safety timeout (${timing.HARVEST_SAFETY_MS} ms)`, h.requests.length === 0, h.requests);
    await h.advance(1);
    check("…and the harvest starts at the safety timeout, not at the 30 s window", h.requests.length === 1 && h.requests[0].at === timing.HARVEST_SAFETY_MS, h.requests.map((r) => r.at));
    check("the safety timeout is a safety net, shorter than the open's window", timing.HARVEST_SAFETY_MS === 5_000 && timing.HARVEST_SAFETY_MS < timing.OPEN_WINDOW_MS);
  }
  {
    const h = harness();
    wireTiming(h);
    let calls = 0;
    const open = timing.beginChatOpen({ chatId: "c-u", sessionId: "s-u", storedEvents: 0, storedToken: false });
    const cancel = timing.afterChatOpenSettled(() => calls++);
    await h.advance(500);
    cancel();
    open.settled();
    await h.advance(10_000);
    check("an unmounted panel is never woken (by settle or by the safety timeout)", calls === 0, calls);
    let once = 0;
    const open2 = timing.beginChatOpen({ chatId: "c-v", sessionId: "s-v", storedEvents: 0, storedToken: false });
    timing.afterChatOpenSettled(() => once++);
    open2.settled();
    await h.advance(10_000);
    check("ready is called once, even when settle and the safety timeout both pass", once === 1, once);
    let woke = 0;
    timing.beginChatOpen({ chatId: "c-w", sessionId: "s-w", storedEvents: 0, storedToken: false });
    timing.afterChatOpenSettled(() => woke++, 60_000);
    timing.beginChatOpen({ chatId: "c-x", sessionId: "s-x", storedEvents: 0, storedToken: false });
    await h.advance(0);
    check("an open cancelled by a later click wakes its waiters (they never wait for ever)", woke === 1, woke);
    check("a ready that throws is contained", (() => {
      try {
        timing.afterChatOpenSettled(() => {
          throw new Error("boom");
        }, 0);
        return true;
      } catch {
        return false;
      }
    })());
    await h.advance(10);
  }
  timing.resetChatOpenTimingForTest();
  // The page wires it this way (the rendered behaviour is tests/control-panel.spec.ts; these hold the wiring).
  const cockpit = readFileSync("app/_components/cockpit.tsx", "utf8");
  const chat = readFileSync("app/_components/agent-chat.tsx", "utf8");
  const storeDecl = cockpit.slice(cockpit.indexOf("const feedStore = () =>"), cockpit.indexOf("function useChildFeeds("));
  check("cockpit.tsx: the page's feed store reports every read to the chat-open record", /probe:\s*\(sid,\s*live\)\s*=>\s*specialistStream\(sid,\s*\{\s*live\s*\}\)/.test(storeDecl), storeDecl.slice(0, 400));
  const hook = chat.slice(chat.indexOf("function useConversationSettled("), chat.indexOf("function usePresence("));
  check("agent-chat.tsx: the harvest gate waits on the open's settle", /afterChatOpenSettled\(/.test(hook), hook.slice(0, 400));
  check("agent-chat.tsx: …not on the old fixed 2.5 s after paint", !/2_500|2500/.test(hook), hook);
  check("agent-chat.tsx: the gate feeds the panel's harvestReady", /const harvestReady = useConversationSettled\(\)/.test(chat) && /harvestReady=\{harvestReady\}/.test(chat));
}

/* ---------------------------------------------------------------------------------------------------------------- */
console.log("\n13. A saved copy per specialist: parity, zero full reads on reopen, the seam, healing, the caps");

const BOUNDARY = /"type":"session\.(waiting|completed|failed)"/;
/** What a round trip through Postgres jsonb does to a value: object keys come back shortest first, then bytewise. */
const jsonb = (x) => {
  const reorder = (v) => {
    if (Array.isArray(v)) return v.map(reorder);
    if (!v || typeof v !== "object") return v;
    const keys = Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(keys.map((k) => [k, reorder(v[k])]));
  };
  return reorder(JSON.parse(JSON.stringify(x)));
};
/** Restore a copy and continue it the way the store does: the seam (the event at cursor - 1), then the tail. */
const restoreAndContinue = (copy, lines) => {
  const fold = ChildFold.fromCopy(copy, { summarize });
  const seamLine = lines[copy.cursor - 1];
  const seamEvent = JSON.parse(seamLine);
  const verdict = childSeamVerdict(copy, { events: [seamEvent] }, 1);
  if (verdict.status !== "match") return { fold, verdict };
  fold.adoptSeam(seamEvent);
  for (const l of lines.slice(copy.cursor)) fold.push(l);
  fold.foldHeld();
  return { fold, verdict };
};
{
  // A stream that parks, is resumed, delegates further and parks again: two boundaries and a nested specialist.
  const first = specialistStream({ seed: 401, steps: 2, reasoningChars: 3_000, token: "eve:first" });
  const second = specialistStream({ seed: 402, steps: 2, reasoningChars: 3_000, nested: "wrun_NEST2", token: "eve:second" }).slice(1);
  const resumed = [...first, ...second];
  const streams = [...recorded, ...generated, { name: "parked, resumed, parked again", lines: resumed }];
  let boundaries = 0;
  let copies = 0;
  let mismatches = 0;
  let tokenLeaks = 0;
  let dup = 0;
  const failures = [];
  for (const { name, lines } of streams) {
    const whole = visible(foldLines(lines, { summarize }));
    for (let k = 0; k < lines.length; k++) {
      if (!BOUNDARY.test(lines[k])) continue;
      boundaries++;
      const fold = new ChildFold({ summarize });
      for (const l of lines.slice(0, k + 1)) fold.push(l);
      const copy = fold.copy("wrun_P");
      if (!copy) {
        failures.push(`${name}@${k}: no copy at a boundary`);
        continue;
      }
      copies++;
      if (/continuationToken/.test(JSON.stringify(copy))) tokenLeaks++;
      if (!childCopyUsable(jsonb(copy), "wrun_P")) failures.push(`${name}@${k}: copy not usable`);
      const { fold: restored, verdict } = restoreAndContinue(jsonb(copy), lines);
      if (verdict.status !== "match") failures.push(`${name}@${k}: seam ${verdict.status}`);
      if (visible(restored) !== whole) mismatches++;
      dup += dupes(toolRowIds(restored)).length;
    }
  }
  check(`boundaries found in the recorded and generated streams (${boundaries})`, boundaries >= 15, boundaries);
  check(`a copy at every boundary (${copies} of ${boundaries})`, copies === boundaries && failures.length === 0, failures.slice(0, 5));
  check("copy + seam + tail equals the whole fold at every boundary of every stream", mismatches === 0, mismatches);
  check("…with no tool row twice", dup === 0, dup);
  check("no copy carries a resume token", tokenLeaks === 0, tokenLeaks);
  {
    const fold = foldLines(resumed, { summarize });
    const copy = fold.copy("wrun_P");
    check("the nested specialist and the latest token come back (token from the seam read)", (() => {
      const r = restoreAndContinue(jsonb(copy), resumed).fold.view();
      return r.childSessions.includes("wrun_NEST2") && r.continuationToken === "eve:second";
    })());
    const compact = JSON.stringify(copy).length;
    const raw = resumed.join("\n").length;
    check(`the copy is a fraction of the raw stream (${compact} of ${raw} characters)`, compact < raw / 5, { compact, raw });
  }
  {
    // Key order is visible (a row's summary can be the first string field of a tool's input), and jsonb reorders keys:
    // the copy keeps each event as text, so it comes back as the stream wrote it.
    const lines = [
      JSON.stringify({ data: { sequence: 0, turnId: "turn_0" }, type: "turn.started" }),
      JSON.stringify({ data: { actions: [{ callId: "c1", input: { zeta: "first field", a: "second" }, kind: "tool-call", toolName: "custom" }], sequence: 0, stepIndex: 0, turnId: "turn_0" }, type: "actions.requested" }),
      JSON.stringify({ data: { sequence: 0, turnId: "turn_0" }, type: "turn.completed" }),
      JSON.stringify({ data: { continuationToken: "eve:k", wait: "next-user-message" }, type: "session.waiting" }),
    ];
    const whole = foldLines(lines, { summarize });
    const restored = restoreAndContinue(jsonb(whole.copy("wrun_K")), lines).fold;
    check("key order survives the store (a summary from the first input field is unchanged)", visible(restored) === visible(whole) && restored.view().rows.some((r) => r.summary?.includes("zeta")), restored.view().rows);
  }
  {
    const lines = generated[0].lines;
    const fold = new ChildFold({ summarize });
    for (const l of lines.slice(0, 40)) fold.push(l);
    check("mid-turn (no boundary): no copy", fold.copy("wrun_P") === null);
    const cut = foldLines(specialistStream({ seed: 403, steps: 2, end: "input" }), { summarize });
    check("a stream that stops on input.requested: no copy", cut.copy("wrun_P") === null);
    const bad = foldLines([...first, "{not json"], { summarize });
    check("a trailing line that does not parse: no copy (the seam would not be the copy's last event)", bad.copy("wrun_P") === null);
  }
  {
    const copy = jsonb(foldLines(first, { summarize }).copy("wrun_P"));
    check("usable: the right copy", childCopyUsable(copy, "wrun_P"));
    check("unusable: another session's", !childCopyUsable(copy, "wrun_Q"));
    check("unusable: another version", !childCopyUsable({ ...copy, version: CHILD_COPY_VERSION + 1 }, "wrun_P"));
    check("unusable: more events than its cursor", !childCopyUsable({ ...copy, cursor: 1 }, "wrun_P"));
    check("unusable: indexes out of order", !childCopyUsable({ ...copy, events: [...copy.events].reverse() }, "wrun_P"));
    check("unusable: not ending at a boundary", !childCopyUsable({ ...copy, events: copy.events.slice(0, -1) }, "wrun_P"));
  }
}

/** Where a page keeps copies: the route's rules (never backwards, a size cap), in memory, on the harness's clock. */
function copyServer({ loadMs = 120, maxBytes = Infinity, never = false } = {}) {
  const rows = new Map();
  const log = [];
  let clock = null;
  const io = {
    load: (sid, signal) =>
      new Promise((resolve) => {
        log.push(["load", sid]);
        if (never) return;
        clock.setTimer(() => resolve(signal.aborted ? null : rows.has(sid) ? jsonb(rows.get(sid)) : null), loadMs);
      }),
    save: async (copy) => {
      log.push(["save", copy.sessionId, copy.cursor]);
      const prev = rows.get(copy.sessionId);
      if (prev && prev.cursor > copy.cursor) return "refused";
      if (JSON.stringify(copy.events).length > maxBytes) return "refused";
      rows.set(copy.sessionId, jsonb(copy));
      return "stored";
    },
    discard: async (sid) => {
      log.push(["discard", sid]);
      rows.delete(sid);
    },
  };
  return { rows, log, io, bind: (h) => (clock = h.clock) };
}
const page = (srv, extra = {}) => {
  const h = harness({ copies: srv.io, ...extra });
  srv.bind(h);
  return h;
};
const feedVisible = (f) =>
  f &&
  JSON.stringify({
    messages: f.messages,
    rows: f.rows,
    childSessions: f.childSessions,
    completed: f.completed,
    continuationToken: f.continuationToken,
    turnActive: f.turnActive,
    stopped: f.stopped,
  });
const noToken = (json) => json?.replace(/,?"continuationToken":"[^"]*"/, "");
{
  const srv = copyServer();
  const sids = ["wrun_C1", "wrun_C2", "wrun_C3", "wrun_C4", "wrun_C5"];
  const streams = Object.fromEntries(sids.map((s, i) => [s, { lines: specialistStream({ seed: 500 + i, steps: 3, reasoningChars: 20_000, nested: i === 0 ? "wrun_N500" : undefined }), hold: true }]));
  // Page 1: today's first harvest, which stores a copy of each.
  const p1 = page(srv);
  for (const s of sids) p1.streams.set(s, streams[s]);
  p1.store.sync("panel", wants(sids.map((s) => [s, "harvest"])), true);
  await p1.advance(20_000);
  check("first page: every finished specialist read from 0 once, as before", p1.requests.length === 5 && p1.requests.every((r) => r.startIndex === 0), p1.requests.map((r) => r.startIndex));
  check("…and a copy of each stored at its boundary", sids.every((s) => srv.rows.get(s)?.cursor === streams[s].lines.length), [...srv.rows.values()].map((c) => c.cursor));
  const reference = Object.fromEntries(sids.map((s) => [s, feedVisible(p1.store.peek(s))]));

  // Page 2: a new page (a reload), before the conversation is up.
  const p2 = page(srv);
  for (const s of sids) p2.streams.set(s, streams[s]);
  p2.store.sync("panel", wants(sids.map((s) => [s, "harvest"])), false);
  await p2.advance(150);
  check("second page, 150 ms in, before the chat is ready: every specialist's details are on screen", sids.every((s) => noToken(feedVisible(p2.store.peek(s))) === noToken(reference[s])), sids.map((s) => p2.store.peek(s)?.rows.length));
  check("…from the copy, with no stream read at all", p2.requests.length === 0, p2.requests.length);
  check("…including the nested specialist", p2.store.peek("wrun_C1").childSessions.includes("wrun_N500"));
  check("…and shown as ended, not idle", sids.every((s) => p2.store.peek(s).status === "ended"));
  p2.store.sync("panel", wants(sids.map((s) => [s, "harvest"])), true);
  await p2.advance(20_000);
  check("after the chat is up: ZERO reads from event 0", p2.requests.every((r) => r.startIndex > 0) && p2.store.stats().every((x) => x.fullReads === 0), p2.requests.map((r) => r.startIndex));
  check("…one seam read each, from cursor - 1", p2.requests.length === 5 && sids.every((s) => p2.requests.some((r) => r.sid === s && r.startIndex === streams[s].lines.length - 1)), p2.requests.map((r) => [r.sid, r.startIndex]));
  check("…and the details equal the full fold, resume token included", sids.every((s) => feedVisible(p2.store.peek(s)) === reference[s]));
  check("…bytes read on reopen: one event each, not the stream", p2.store.stats().reduce((a, x) => a + x.bytes, 0) < p1.store.stats().reduce((a, x) => a + x.bytes, 0) / 50, { p1: p1.store.stats().reduce((a, x) => a + x.bytes, 0), p2: p2.store.stats().reduce((a, x) => a + x.bytes, 0) });
  check("…nothing stored again (the copy is not longer than the stored one)", srv.log.filter((x) => x[0] === "save").length === 5, srv.log.filter((x) => x[0] === "save"));
  check("…and stats say so", p2.store.stats().every((x) => x.fromCopy));
}
{
  // A parked specialist (priority) and a running one (live): read at once, from the stored index.
  const srv = copyServer();
  const first = specialistStream({ seed: 511, steps: 1, reasoningChars: 2_000, token: "eve:park-1" });
  const more = specialistStream({ seed: 512, steps: 2, reasoningChars: 2_000, token: "eve:park-2" }).slice(1);
  const p1 = page(srv);
  p1.streams.set("wrun_PK", { lines: first, hold: true });
  p1.streams.set("wrun_RN", { lines: first, hold: true });
  p1.store.sync("panel", wants([["wrun_PK", "priority"], ["wrun_RN", "harvest"]]), true);
  await p1.advance(5_000);
  check("page 1: both parked, both copied", srv.rows.get("wrun_PK")?.cursor === first.length && srv.rows.get("wrun_RN")?.cursor === first.length);
  const p2 = page(srv);
  p2.streams.set("wrun_PK", { lines: first, hold: true });
  // The running one was resumed since: its stream has a second turn, still going (no boundary yet), then parks.
  p2.streams.set("wrun_RN", { lines: [...first, ...more], chunk: 30, every: 100, hold: true });
  p2.store.sync("panel", wants([["wrun_PK", "priority"], ["wrun_RN", "live"]]), false);
  await p2.advance(400);
  const pk = p2.requests.filter((r) => r.sid === "wrun_PK");
  const rn = p2.requests.filter((r) => r.sid === "wrun_RN");
  check("the parked one is read at once, before the chat is ready, from the stored index", pk.length === 1 && pk[0].startIndex === first.length - 1, pk);
  check("…and its resume token is there (from the seam read; the copy has none)", p2.store.peek("wrun_PK").continuationToken === "eve:park-1");
  check("the running one attaches live at once, from the stored index", rn.length === 1 && rn[0].startIndex === first.length - 1, rn);
  await p2.advance(10_000);
  const whole = visible(foldLines([...first, ...more], { summarize }));
  check("…and folds the new turn onto the copy: equal to the whole fold, no tool row twice", feedVisible(p2.store.peek("wrun_RN")) === whole && dupes(p2.store.peek("wrun_RN").rows.filter((r) => r.kind === "tool").map((r) => r.id)).length === 0);
  check("…still connected (live), never a read from 0", p2.store.inFlight().open >= 1 && p2.store.stats().every((x) => x.fullReads === 0));
  check("…and at its next boundary a LONGER copy is stored", srv.rows.get("wrun_RN")?.cursor === first.length + more.length, srv.rows.get("wrun_RN")?.cursor);
}
{
  // A STALE COPY HEALS: the stored copy is of something else (a re-minted session, a restored database).
  const srv = copyServer();
  const wrong = specialistStream({ seed: 520, steps: 2, reasoningChars: 2_000 });
  const right = specialistStream({ seed: 521, steps: 4, reasoningChars: 4_000 });
  srv.rows.set("wrun_ST", jsonb(foldLines(wrong, { summarize }).copy("wrun_ST")));
  const h = page(srv);
  h.streams.set("wrun_ST", { lines: right, chunk: 40, every: 50, hold: true });
  const seen = [];
  h.store.subscribe((changed) => changed.wrun_ST && seen.push(feedVisible(changed.wrun_ST)));
  h.store.sync("panel", wants([["wrun_ST", "harvest"]]), true);
  await h.advance(30_000);
  const stale = noToken(visible(foldLines(wrong, { summarize })));
  const healed = visible(foldLines(right, { summarize }));
  check("the stale copy was shown at once", seen.length > 0 && noToken(seen[0]) === stale);
  check("the seam disagreed: the stream was read again from 0", h.requests.length === 2 && h.requests[0].startIndex === wrong.length - 1 && h.requests[1].startIndex === 0, h.requests.map((r) => r.startIndex));
  check("no intermediate state was ever shown: every update is the stale copy or the healed fold (no flicker)", seen.every((v) => noToken(v) === stale || v === healed), seen.map((v) => (noToken(v) === stale ? "stale" : v === healed ? "healed" : `OTHER ${Object.entries(JSON.parse(v)).filter(([k, x]) => JSON.stringify(x) !== JSON.stringify(JSON.parse(stale)[k])).map(([k]) => k)}`)));
  check("…and it ends healed", feedVisible(h.store.peek("wrun_ST")) === healed);
  const order = srv.log.filter((x) => x[0] !== "load").map((x) => x[0]);
  check("the stale copy was discarded BEFORE the new one was stored", JSON.stringify(order) === JSON.stringify(["discard", "save"]), srv.log);
  check("…and the stored copy is now the stream's", srv.rows.get("wrun_ST")?.cursor === right.length);
}
{
  // …and for a RUNNING specialist (live): the copy stays until the stream's own fold has read as far, never an empty panel.
  const srv = copyServer();
  const wrong = specialistStream({ seed: 522, steps: 2, reasoningChars: 2_000 });
  const right = specialistStream({ seed: 523, steps: 4, reasoningChars: 4_000, end: "running" });
  srv.rows.set("wrun_SL", jsonb(foldLines(wrong, { summarize }).copy("wrun_SL")));
  const h = page(srv);
  h.streams.set("wrun_SL", { lines: right, chunk: 40, every: 50, hold: true });
  const seen = [];
  h.store.subscribe((changed) => changed.wrun_SL && seen.push(changed.wrun_SL));
  h.store.sync("panel", wants([["wrun_SL", "live"]]), true);
  await h.advance(30_000);
  check("live: the stale copy is replaced from 0 and the panel is never empty meanwhile", h.requests.map((r) => r.startIndex).join() === `${wrong.length - 1},0` && seen.every((f) => f.rows.length > 0), { starts: h.requests.map((r) => r.startIndex), rows: seen.map((f) => f.rows.length) });
  check("…and it ends on the stream's own fold, still attached", feedVisible(h.store.peek("wrun_SL")) === visible(foldLines(right, { summarize })) && h.store.inFlight().open === 1);
  check("…no copy stored mid-turn (no boundary yet), the stale one gone", !srv.rows.has("wrun_SL") && !srv.log.some((x) => x[0] === "save"), srv.log);
}
{
  // The parent's seam rules: the stream closed with nothing at the seam ("behind") → retry once, then replace.
  const srv = copyServer();
  const long = specialistStream({ seed: 530, steps: 3, reasoningChars: 2_000 });
  const short = specialistStream({ seed: 531, steps: 1, reasoningChars: 500 });
  srv.rows.set("wrun_BH", jsonb(foldLines(long, { summarize }).copy("wrun_BH")));
  const h = page(srv);
  h.streams.set("wrun_BH", { lines: short, hold: false });
  h.store.sync("panel", wants([["wrun_BH", "harvest"]]), true);
  await h.advance(20_000);
  const starts = h.requests.map((r) => r.startIndex);
  check("behind: retried once, then read from 0", JSON.stringify(starts) === JSON.stringify([long.length - 1, long.length - 1, 0]), starts);
  check("…and the copy replaced by the stream's", feedVisible(h.store.peek("wrun_BH")) === visible(foldLines(short, { summarize })) && srv.rows.get("wrun_BH")?.cursor === short.length);
}
{
  // Silence at the seam ("empty": eve's first byte is slower than the quiet window) → retry once, then KEEP.
  const srv = copyServer();
  const lines = specialistStream({ seed: 540, steps: 2, reasoningChars: 2_000 });
  srv.rows.set("wrun_SI", jsonb(foldLines(lines, { summarize }).copy("wrun_SI")));
  const h = page(srv);
  h.streams.set("wrun_SI", { lines: [], hold: true });
  h.store.sync("panel", wants([["wrun_SI", "harvest"]]), true);
  await h.advance(30_000);
  check("empty: retried once, never read from 0", h.requests.length === 2 && h.requests.every((r) => r.startIndex === lines.length - 1), h.requests.map((r) => r.startIndex));
  check("…and the copy KEPT (not discarded), shown as ended", !srv.log.some((x) => x[0] === "discard") && h.store.peek("wrun_SI").status === "ended" && h.store.peek("wrun_SI").rows.length > 0);
}
{
  // An error at the seam (no answer at all) keeps the copy on screen, never "details unavailable".
  const srv = copyServer();
  const lines = specialistStream({ seed: 541, steps: 2, reasoningChars: 2_000 });
  srv.rows.set("wrun_ER", jsonb(foldLines(lines, { summarize }).copy("wrun_ER")));
  const h = page(srv);
  h.streams.set("wrun_ER", { headersAfter: Infinity });
  h.store.sync("panel", wants([["wrun_ER", "harvest"]]), true);
  await h.advance(30_000);
  check("no headers twice: the copy stays, ended, not unavailable", h.requests.length === 2 && h.store.peek("wrun_ER").status === "ended" && h.store.peek("wrun_ER").rows.length > 0, h.store.peek("wrun_ER").status);
  check("…and nothing discarded", !srv.log.some((x) => x[0] === "discard"));
}
{
  // The caps: a copy over the size cap is never sent; one at or below the stored cursor is never sent again.
  const srv = copyServer();
  const h = page(srv, { maxCopyBytes: 2_000 });
  h.streams.set("wrun_BIG2", { lines: specialistStream({ seed: 550, steps: 3, reasoningChars: 8_000 }), hold: true });
  h.store.sync("panel", wants([["wrun_BIG2", "harvest"]]), true);
  await h.advance(10_000);
  check("over the size cap: not sent, and the specialist is still shown", !srv.log.some((x) => x[0] === "save") && h.store.peek("wrun_BIG2").status === "ended");
  const srv2 = copyServer();
  const lines = specialistStream({ seed: 551, steps: 2, reasoningChars: 2_000 });
  const longer = [...lines, ...specialistStream({ seed: 552, steps: 1, reasoningChars: 500, token: "eve:later" }).slice(1)];
  srv2.rows.set("wrun_OLD", jsonb(foldLines(longer, { summarize }).copy("wrun_OLD")));
  // A second tab that still sees only the shorter stream (its copy load lost the race): it may not shrink the copy.
  const h2 = page(srv2, { copyDeadlineMs: 50 });
  srv2.io.load = () => new Promise(() => {});
  h2.streams.set("wrun_OLD", { lines, hold: true });
  h2.store.sync("panel", wants([["wrun_OLD", "harvest"]]), true);
  await h2.advance(10_000);
  check("a copy that never answers is not waited for (read from 0 after the deadline)", h2.requests.length === 1 && h2.requests[0].startIndex === 0 && h2.requests[0].at >= 50, h2.requests);
  check("a shorter copy is refused over a longer one (the stored copy is unchanged)", srv2.rows.get("wrun_OLD").cursor === longer.length);
  check("…and this page does not offer it again", (h2.store.retry("wrun_OLD"), await h2.advance(5_000), srv2.log.filter((x) => x[0] === "save").length === 1), srv2.log);
}
{
  // A copy that is not this session's (or not this version) is never folded.
  const srv = copyServer();
  const lines = specialistStream({ seed: 560, steps: 2, reasoningChars: 2_000 });
  srv.rows.set("wrun_X1", { ...jsonb(foldLines(lines, { summarize }).copy("wrun_OTHER")) });
  srv.rows.set("wrun_X2", { ...jsonb(foldLines(lines, { summarize }).copy("wrun_X2")), version: CHILD_COPY_VERSION + 1 });
  const h = page(srv);
  h.streams.set("wrun_X1", { lines, hold: true });
  h.streams.set("wrun_X2", { lines, hold: true });
  h.store.sync("panel", wants([["wrun_X1", "harvest"], ["wrun_X2", "harvest"]]), true);
  await h.advance(10_000);
  check("another session's copy, or another version's, is ignored: read from 0", h.requests.length === 2 && h.requests.every((r) => r.startIndex === 0), h.requests.map((r) => r.startIndex));
}
{
  // Wired the way the page wires it.
  const cockpit = readFileSync("app/_components/cockpit.tsx", "utf8");
  const storeDecl = cockpit.slice(cockpit.indexOf("const feedStore = () =>"), cockpit.indexOf("function useChildFeeds("));
  check("cockpit.tsx: the page's feed store keeps saved copies through /api/ops/chat-snapshots (kind=child)", /copies:\s*childCopyIO/.test(storeDecl) && /kind=child/.test(cockpit), storeDecl.slice(0, 600));
}

{
  // mold_v1-297: when a specialist's own stream last carried anything — what "stuck" is measured from. The last line's
  // `meta.at`, a superseded delta's included (it is never parsed), the same with or without skipping, and the same
  // folded from a saved copy.
  const lines = specialistStream({ seed: 21, steps: 2, reasoningChars: 2_000, end: "running" });
  const last = Date.parse(JSON.parse(lines[lines.length - 1]).meta.at);
  const skipping = foldLines(lines, { summarize }).view();
  const reference = foldLines(lines, { summarize, skipSuperseded: false }).view();
  check("lastAt is the last line's own time", skipping.lastAt === last && reference.lastAt === last, { skipping: skipping.lastAt, reference: reference.lastAt, last });
  const head = foldLines(lines.slice(0, 3), { summarize }).view();
  check("…and moves only forward as lines arrive", head.lastAt <= last && head.lastAt === Date.parse(JSON.parse(lines[2]).meta.at), head.lastAt);
  check("a stream with no lines has none", foldLines([], { summarize }).view().lastAt === undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

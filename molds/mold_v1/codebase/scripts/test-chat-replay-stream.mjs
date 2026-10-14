/**
 * The replay marker must not fire before the first byte on a parked seam read.
 *
 * A reopened chat paints its saved copy and then reads ONE event, the seam, from `eventIndex - 1` through
 * `/api/ops/chat-replay?parked=1`, which wraps eve's stream in `boundedReplay` (lib/chat-replay-stream.ts). With
 * `assumeParked` the 400 ms parked window used to be armed on the very first read, so whenever eve took longer than
 * that to hand over its first chunk the response was the end marker alone, with no event: measured live at 7 of 24
 * and 2 of 18 seam reads. The reader took that as "the saved copy is ahead of the stream", deleted a healthy copy and
 * replayed the whole conversation from event zero, under the loading shimmer.
 *
 * This drives the REAL `boundedReplay` with a fake upstream whose first chunk is slow, and reads the bytes the browser
 * would get, with their timing:
 *
 *   1. first chunk at 600 ms, assumeParked: the seam event arrives, then the marker with index N (today: the marker
 *      alone at about 400 ms, index N-1, no event);
 *   2. an upstream that never sends: the marker still comes, within the in-flight window (2.5 s), drained;
 *   3. after the first chunk the short parked window still applies: the marker follows the seam event by about
 *      400 ms, not 2.5 s (PARKED_IDLE_MS keeps its job as the drain window);
 *   4. a full replay whose last event is a park drains 400 ms after it, as before;
 *   5. without assumeParked nothing changes: the in-flight window before and after the first chunk.
 *
 * Run:  npm run test:chat-replay-stream
 */
import assert from "node:assert/strict";
import * as stream from "../lib/chat-replay-stream.ts";

const { boundedReplay, PARKED_IDLE_MS, IN_FLIGHT_IDLE_MS } = stream;

let passed = 0;
const check = (label, condition, detail = "") => {
  assert.ok(condition, `${label}${detail ? ` (${detail})` : ""}`);
  passed++;
  console.log(`  ok   ${label}${detail ? `  [${detail}]` : ""}`);
};

const enc = new TextEncoder();
const line = (e) => enc.encode(`${JSON.stringify(e)}\n`);
const park = (token = "tok") => ({ type: "session.waiting", data: { continuationToken: token } });
const text = (n) => ({ type: "message.completed", data: { turnId: "t", stepIndex: 0, message: `m${n}` } });

/**
 * An upstream like eve's for a parked session: it sends the given chunks at the given times (ms after the read
 * opened) and then stays open for ever, as a suspended run's stream does.
 */
function fakeUpstream(plan) {
  const timers = [];
  return new ReadableStream({
    start(controller) {
      for (const { at, event } of plan) {
        timers.push(setTimeout(() => controller.enqueue(line(event)), at));
      }
    },
    cancel() {
      for (const t of timers) clearTimeout(t);
    },
  });
}

/** Read a bounded replay to its end (replayOnly closes after the marker), with each line's arrival time. */
async function readAll(body, budgetMs = 6_000) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const started = performance.now();
  const lines = [];
  let buf = "";
  const deadline = setTimeout(() => reader.cancel().catch(() => {}), budgetMs);
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const p of parts) if (p.trim()) lines.push({ at: performance.now() - started, event: JSON.parse(p) });
    }
  } finally {
    clearTimeout(deadline);
  }
  return lines;
}

const markerOf = (lines) => lines.find((l) => l.event.type === "ops.replay.end");
const eventsOf = (lines) => lines.filter((l) => l.event.type !== "ops.replay.end");

console.log(`windows: parked ${PARKED_IDLE_MS} ms, in flight ${IN_FLIGHT_IDLE_MS} ms`);
check("the parked window itself is unchanged (it is also the full replay's drain window)", PARKED_IDLE_MS === 400);
check("the in-flight window is unchanged", IN_FLIGHT_IDLE_MS === 2500);

/* ---- 1. the race the live reads lost ----------------------------------------------------------------------- */
console.log("\nA seam read whose first chunk takes 600 ms (assumeParked, startIndex N-1):");
{
  const N = 3450;
  const lines = await readAll(
    boundedReplay(fakeUpstream([{ at: 600, event: park("tok-seam") }]), {
      startIndex: N - 1,
      replayOnly: true,
      assumeParked: true,
    }),
  );
  const marker = markerOf(lines);
  const events = eventsOf(lines);
  check("the seam event is delivered", events.length === 1 && events[0].event.type === "session.waiting", `${events.length} event(s)`);
  check("…carrying the resume token the reader needs", events[0]?.event.data?.continuationToken === "tok-seam");
  check("the marker follows it, with index N (not N-1)", marker?.event.data.index === N, `index ${marker?.event.data.index}`);
  check("…drained", marker?.event.data.drained === true);
  check(
    "…and it was NOT emitted before the first byte",
    marker !== undefined && events[0] !== undefined && marker.at >= events[0].at,
    `marker at ${Math.round(marker?.at ?? -1)} ms`,
  );
}

/* ---- 2. an upstream that never answers ---------------------------------------------------------------------- */
console.log("\nAn upstream that never sends (assumeParked):");
{
  const lines = await readAll(boundedReplay(fakeUpstream([]), { startIndex: 10, replayOnly: true, assumeParked: true }));
  const marker = markerOf(lines);
  check("the marker still comes", marker !== undefined);
  check(
    "…within the in-flight window, not after it",
    marker !== undefined && marker.at < IN_FLIGHT_IDLE_MS + 400,
    `at ${Math.round(marker?.at ?? -1)} ms`,
  );
  check(
    "…and only after the in-flight window, not the parked one",
    marker !== undefined && marker.at >= IN_FLIGHT_IDLE_MS - 50,
    `at ${Math.round(marker?.at ?? -1)} ms`,
  );
  check("…with nothing before it and the index unmoved", eventsOf(lines).length === 0 && marker?.event.data.index === 10);
}

/* ---- 3. after the first chunk, the parked window is the short one ----------------------------------------- */
console.log("\nAfter the first chunk the short window applies (assumeParked):");
{
  const lines = await readAll(
    boundedReplay(fakeUpstream([{ at: 100, event: park() }]), { startIndex: 5, replayOnly: true, assumeParked: true }),
  );
  const marker = markerOf(lines);
  const seam = eventsOf(lines)[0];
  const gap = marker && seam ? marker.at - seam.at : -1;
  check("the marker follows the seam event by about the parked window", gap >= PARKED_IDLE_MS - 50 && gap < PARKED_IDLE_MS + 600, `${Math.round(gap)} ms after it`);
  check("…index advanced past the one event", marker?.event.data.index === 6);
}

/* ---- 4. the full replay's drain is untouched ----------------------------------------------------------------- */
console.log("\nA full replay ending on a park drains as before (no assumeParked):");
{
  const plan = [
    { at: 50, event: text(1) },
    { at: 60, event: park("t1") },
    { at: 70, event: text(2) },
    { at: 80, event: park("t2") },
  ];
  const lines = await readAll(boundedReplay(fakeUpstream(plan), { startIndex: 0, replayOnly: true }));
  const marker = markerOf(lines);
  const last = eventsOf(lines).at(-1);
  const gap = marker && last ? marker.at - last.at : -1;
  check("every event arrives, in order", eventsOf(lines).length === 4 && last?.event.data.continuationToken === "t2");
  check("the marker follows the last park by about the parked window", gap >= PARKED_IDLE_MS - 50 && gap < PARKED_IDLE_MS + 600, `${Math.round(gap)} ms`);
  check("…with index 4", marker?.event.data.index === 4);
}

/* ---- 5. without the assumption, nothing changes -------------------------------------------------------------- */
console.log("\nWithout assumeParked:");
{
  const lines = await readAll(
    boundedReplay(fakeUpstream([{ at: 600, event: text(1) }]), { startIndex: 0, replayOnly: true }),
  );
  const marker = markerOf(lines);
  const gap = marker && eventsOf(lines)[0] ? marker.at - eventsOf(lines)[0].at : -1;
  check("a non-boundary event is followed by the in-flight window", gap >= IN_FLIGHT_IDLE_MS - 50, `${Math.round(gap)} ms`);
}

/* ---- the window rule, as a function ------------------------------------------------------------------------- */
if (typeof stream.idleWindowMs === "function") {
  console.log("\nThe window rule:");
  check("parked, before the first chunk: in flight", stream.idleWindowMs({ parked: true, firstChunk: false }) === IN_FLIGHT_IDLE_MS);
  check("parked, after it: parked", stream.idleWindowMs({ parked: true, firstChunk: true }) === PARKED_IDLE_MS);
  check("not parked: in flight", stream.idleWindowMs({ parked: false, firstChunk: true }) === IN_FLIGHT_IDLE_MS);
}

console.log(`\nchat replay stream: ${passed}/${passed} checks passed`);

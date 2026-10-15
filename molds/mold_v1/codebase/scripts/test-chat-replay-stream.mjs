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

/* ---- 6. a stall in the middle of a full replay (the sticky parked flag) ---------------------------------------- */
/**
 * One full replay measured live ended at event 603 of 3,963: the marker said "drained" after a 412 ms gap, because the
 * first `session.waiting` in the history had set `parked` for the rest of the read, and every later gap was then
 * judged by the 400 ms parked window. The flag now follows the LAST complete line: a stall after an ordinary event,
 * however late in the history, gets the in-flight window.
 */
console.log("\nA full replay with a 600 ms stall after the first park (no assumeParked):");
{
  const plan = [
    { at: 20, event: text(1) },
    { at: 30, event: park("t1") },
    { at: 40, event: text(2) },
    // the stall: 600 ms of nothing after an ordinary event, deep in the history
    { at: 640, event: text(3) },
    { at: 650, event: text(4) },
    { at: 660, event: park("t2") },
  ];
  const lines = await readAll(boundedReplay(fakeUpstream(plan), { startIndex: 0, replayOnly: true }));
  const marker = markerOf(lines);
  check("every event passes, the ones after the stall included", eventsOf(lines).length === plan.length, `${eventsOf(lines).length} of ${plan.length}`);
  check("the replay reaches the end marker with index = the total", marker?.event.data.index === plan.length, `index ${marker?.event.data.index}`);
  check("…drained, after the last park", marker?.event.data.drained === true && eventsOf(lines).at(-1)?.event.data.continuationToken === "t2");
}

console.log("\nThe measured shape: 3,963 events, parks along the way, a 450 ms stall after event 603:");
{
  const TOTAL = 3963;
  const STALL_AFTER = 603;
  const enc2 = new TextEncoder();
  // Chunks of 50 lines, every 2 ms, like a store read; a park every 120 events; one stall mid-history.
  const events = Array.from({ length: TOTAL }, (_, i) => (i % 120 === 119 ? park(`t${i}`) : text(i)));
  events[TOTAL - 1] = park("last");
  const upstream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < TOTAL; i += 50) {
        const slice = events.slice(i, Math.min(TOTAL, i + 50));
        // the stall falls after event STALL_AFTER (index 602, an ordinary event), as it did live
        if (i <= STALL_AFTER && STALL_AFTER < i + 50) {
          const head = slice.slice(0, STALL_AFTER - i);
          const rest = slice.slice(STALL_AFTER - i);
          controller.enqueue(enc2.encode(head.map((e) => JSON.stringify(e) + "\n").join("")));
          await new Promise((r) => setTimeout(r, 450));
          controller.enqueue(enc2.encode(rest.map((e) => JSON.stringify(e) + "\n").join("")));
        } else {
          controller.enqueue(enc2.encode(slice.map((e) => JSON.stringify(e) + "\n").join("")));
        }
        await new Promise((r) => setTimeout(r, 2));
      }
    },
  });
  const lines = await readAll(boundedReplay(upstream, { startIndex: 0, replayOnly: true }), 10_000);
  const marker = markerOf(lines);
  check("all 3,963 events are relayed", eventsOf(lines).length === TOTAL, `${eventsOf(lines).length}`);
  check("the marker's index is 3,963, not 603", marker?.event.data.index === TOTAL, `index ${marker?.event.data.index}`);
}

console.log("\nA park, then the NEXT line half-arrived, then a 600 ms stall:");
{
  const enc2 = new TextEncoder();
  const nextLine = JSON.stringify(text(9)) + "\n";
  const upstream = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc2.encode(JSON.stringify(text(1)) + "\n" + JSON.stringify(park("t1")) + "\n" + nextLine.slice(0, 10)));
      await new Promise((r) => setTimeout(r, 600));
      controller.enqueue(enc2.encode(nextLine.slice(10) + JSON.stringify(park("t2")) + "\n"));
    },
  });
  const lines = await readAll(boundedReplay(upstream, { startIndex: 0, replayOnly: true }));
  check("bytes of a next event mean the history is not over: nothing is cut", eventsOf(lines).length === 4 && markerOf(lines)?.event.data.index === 4, `${eventsOf(lines).length} events, index ${markerOf(lines)?.event.data.index}`);
}

console.log("\nThe upstream ends mid-history after a park (the ~120 s severance):");
{
  const enc2 = new TextEncoder();
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc2.encode([park("t1"), text(2)].map((e) => JSON.stringify(e) + "\n").join("")));
      controller.close();
    },
  });
  const marker = markerOf(await readAll(boundedReplay(upstream, { startIndex: 7, replayOnly: true })));
  check("…still says drained: false, with the index to reopen at", marker?.event.data.drained === false && marker?.event.data.index === 9);
}

console.log("\nA seam read still ends 400 ms after its park (assumeParked):");
{
  const lines = await readAll(
    boundedReplay(fakeUpstream([{ at: 50, event: park("seam") }]), { startIndex: 41, replayOnly: true, assumeParked: true }),
  );
  const gap = markerOf(lines).at - eventsOf(lines)[0].at;
  check("…the short window after the seam's park", gap >= PARKED_IDLE_MS - 50 && gap < PARKED_IDLE_MS + 600, `${Math.round(gap)} ms`);
}

/* ---- the window rule, as a function ------------------------------------------------------------------------- */
if (typeof stream.idleWindowMs === "function") {
  console.log("\nThe window rule:");
  check("parked, before the first chunk: in flight", stream.idleWindowMs({ parked: true, firstChunk: false }) === IN_FLIGHT_IDLE_MS);
  check("parked, after it: parked", stream.idleWindowMs({ parked: true, firstChunk: true }) === PARKED_IDLE_MS);
  check("not parked: in flight", stream.idleWindowMs({ parked: false, firstChunk: true }) === IN_FLIGHT_IDLE_MS);
}

console.log(`\nchat replay stream: ${passed}/${passed} checks passed`);

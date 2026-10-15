/**
 * Opening a chat whose reply is still being written: the replay loop hands over to the live reader.
 *
 * `readReplay` (lib/chat-replay-read.ts, the loop that was `replaySession` in the chat shell) read a running turn
 * until it fell silent: every segment that brought events and ended on the quiet window or its 15 s cap, with no end
 * marker, was reopened, to the 60 s deadline and past it (about 75 s), behind the loading shimmer. It now stops at the
 * live edge of the running turn ("live") with the exact absolute index, and the chat's own live reader carries on.
 *
 * Everything here EXECUTES the real modules over a fake eve that streams on a real clock:
 *   - eve's stream (a backlog, then events on a timeline, never closing while the session is running or parked);
 *   - the real `/api/ops/chat-replay` wrapper, `boundedReplay` (lib/chat-replay-stream.ts), around it;
 *   - the real reader, `readReplay`, over a stubbed `fetch`;
 *   - the real live reader, `readLiveTail` (lib/chat-attach.ts), from the index the replay returned.
 *
 *   1. A first turn still running: a 500-event backlog, then a delta every 500 ms, then a 4 s pause. The read
 *      stops within ~2 s of the pause with stop "live" (before: still reading at 6.5 s, to the turn's end or the
 *      deadline), at exactly the index of the last event it holds; the live reader started there gets every later
 *      event exactly once, so replay + live = the whole stream, no gap and no duplicate.
 *   2. A 2 s stall in the middle of an OLD history (parked, written yesterday): not "live"; the read goes on and the
 *      transcript equals a full replay.
 *   3. A saved copy ending at a park, then a new turn running: the seam read stops "live" within ~2 s of the turn's
 *      pause, with the seam event plus the new turn's events and the absolute index after them.
 *   4. A seam read with nothing after the park still ends at rest with zero new events, not "live".
 *   5. The rule itself (`liveTurnEdge`): unfinished turn + fresh stamp only.
 *
 * Run:  npm run test:chat-replay-read
 */
import assert from "node:assert/strict";
import { boundedReplay } from "../lib/chat-replay-stream.ts";
import * as read from "../lib/chat-replay-read.ts";
import { readLiveTail } from "../lib/chat-attach.ts";

const { readReplay } = read;

let passed = 0;
const check = (label, condition, detail = "") => {
  assert.ok(condition, `${label}${detail ? ` (${detail})` : ""}`);
  passed++;
  console.log(`  ok   ${label}${detail ? `  [${detail}]` : ""}`);
};

const enc = new TextEncoder();
const NOW = "now";

/**
 * A fake eve session. `timeline` is `[{ at, event }]`: the event exists from `at` ms after the session was created;
 * an event whose `meta.at` is NOW is stamped with the wall clock when it is written. A stream opened at `startIndex`
 * sends every event that already exists at once (the backlog) and the rest when they happen, and never closes (a
 * running or parked run's stream stays open).
 */
function fakeEve(timeline) {
  const t0 = performance.now();
  const written = timeline.map(() => null);
  const stamp = (i) => {
    if (!written[i]) {
      const e = timeline[i].event;
      written[i] = e.meta?.at === NOW ? { ...e, meta: { at: new Date().toISOString() } } : e;
    }
    return written[i];
  };
  for (let i = 0; i < timeline.length; i++) {
    const delay = timeline[i].at;
    if (delay <= 0) stamp(i);
    else setTimeout(() => stamp(i), delay).unref?.();
  }
  const upstream = (startIndex, signal) => {
    const timers = [];
    let closed = false;
    return new ReadableStream({
      start(controller) {
        const now = performance.now() - t0;
        const due = [];
        for (let i = startIndex; i < timeline.length; i++) {
          if (timeline[i].at <= now) due.push(i);
          else {
            timers.push(
              setTimeout(() => {
                if (!closed) controller.enqueue(enc.encode(JSON.stringify(stamp(i)) + "\n"));
              }, timeline[i].at - now),
            );
          }
        }
        if (due.length) controller.enqueue(enc.encode(due.map((i) => JSON.stringify(stamp(i)) + "\n").join("")));
        signal?.addEventListener("abort", () => {
          closed = true;
          for (const t of timers) clearTimeout(t);
        });
      },
      cancel() {
        closed = true;
        for (const t of timers) clearTimeout(t);
      },
    });
  };
  const requests = [];
  /** The browser's `fetch`: `/api/ops/chat-replay` wraps eve's stream in the real boundedReplay. */
  const fetch = async (url, init) => {
    const u = new URL(url, "http://app.test");
    requests.push({ path: u.pathname, startIndex: Number(u.searchParams.get("startIndex") ?? 0), at: performance.now() - t0 });
    if (u.pathname !== "/api/ops/chat-replay") return new Response("not here", { status: 404 });
    const startIndex = Number(u.searchParams.get("startIndex") ?? 0);
    const body = boundedReplay(upstream(startIndex, init?.signal), {
      startIndex,
      replayOnly: true,
      assumeParked: u.searchParams.get("parked") === "1",
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  };
  /** The live reader's opener (eve's own stream, no marker): events from `startIndex`, parsed. */
  const opener = (startIndex, signal) =>
    (async function* () {
      const reader = upstream(startIndex, signal).getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) return;
          buf += dec.decode(r.value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const l of lines) if (l.trim()) yield JSON.parse(l);
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    })();
  return { fetch, opener, requests, elapsed: () => performance.now() - t0, events: () => written.filter(Boolean) };
}

let seq = 0;
const ev = (type, data = {}, at = NOW) => ({ type, data: { ...data, seq: seq++ }, meta: { at } });
const delta = (turnId, n, at = NOW) => ev("reasoning.appended", { turnId, stepIndex: 0, reasoningDelta: "x", reasoningSoFar: "x".repeat(n) }, at);
const seqOf = (e) => e?.data?.seq;

/** Resolve with the read, or with "still reading" once `ms` has passed since the session started. */
async function readWithin(eve, input, ms) {
  const ctrl = new AbortController();
  const result = readReplay({ headers: () => ({}), fetch: eve.fetch, signal: ctrl.signal, ...input });
  const left = Math.max(0, ms - eve.elapsed());
  let timer;
  const verdict = await Promise.race([
    result.then((r) => ({ ...r, resolvedAt: eve.elapsed() })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("still reading"), left);
    }),
  ]);
  clearTimeout(timer);
  if (verdict === "still reading") {
    ctrl.abort();
    await result.catch(() => {});
  }
  return verdict;
}

/* ---- 1. a first turn, still running -------------------------------------------------------------------------- */
console.log("A first turn still running: 500-event backlog, a delta every 500 ms, then a 4 s pause:");
{
  const T = "turn_0";
  const timeline = [
    { at: 0, event: ev("session.started") },
    { at: 0, event: ev("turn.started", { turnId: T }) },
    { at: 0, event: ev("message.received", { turnId: T, message: "q" }) },
    { at: 0, event: ev("step.started", { turnId: T, stepIndex: 0 }) },
  ];
  for (let i = 0; i < 496; i++) timeline.push({ at: 0, event: delta(T, i) });
  const BACKLOG = timeline.length; // 500
  for (let k = 1; k <= 6; k++) timeline.push({ at: 500 * k, event: delta(T, 1000 + k) }); // to 3,000 ms
  const PAUSE_FROM = 3_000;
  const BEFORE_PAUSE = timeline.length; // 506
  for (let k = 0; k < 5; k++) timeline.push({ at: 7_000 + 500 * k, event: delta(T, 2000 + k) });
  timeline.push({ at: 9_500, event: ev("message.completed", { turnId: T, stepIndex: 0, message: "answer", finishReason: "stop" }) });
  timeline.push({ at: 9_510, event: ev("turn.completed", { turnId: T }) });
  timeline.push({ at: 9_520, event: ev("session.waiting", { continuationToken: "tok-1" }) });

  const eve = fakeEve(timeline);
  const got = await readWithin(eve, { sessionId: "s1" }, PAUSE_FROM + 3_500);
  check("the read resolves within ~2 s of the pause, not at the turn's end or the 60 s deadline", got !== "still reading", got === "still reading" ? "still reading at 6.5 s" : `resolved at ${Math.round(got.resolvedAt)} ms`);
  check("…within 2.5 s of the pause", got.resolvedAt < PAUSE_FROM + 2_500, `${Math.round(got.resolvedAt - PAUSE_FROM)} ms after it`);
  const r = got.result;
  check("…with stop \"live\"", r?.stop === "live", `stop ${r?.stop}`);
  check("…holding the backlog and every delta before the pause", r?.events.length === BEFORE_PAUSE, `${r?.events.length} of ${BEFORE_PAUSE}`);
  check("…and the absolute index of the next event", r?.index === BEFORE_PAUSE, `index ${r?.index}`);
  check("…read in ONE segment (no reopen loop)", got.record.segments === 1 && eve.requests.length === 1, `${got.record.segments} segment(s), ${eve.requests.length} request(s)`);
  check("backlog first, in order", r?.events.slice(0, BACKLOG).every((e, i) => seqOf(e) === seqOf(timeline[i].event)));

  // The live reader takes over from that index (what agent-chat's attach does), on eve's own stream.
  const live = [];
  const ctrl = new AbortController();
  const outcome = await readLiveTail({
    open: eve.opener,
    startIndex: r.index,
    signal: ctrl.signal,
    onEvent: (entry) => live.push(entry),
    sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 20))),
  });
  check("the live reader reads the rest of the turn to its park", outcome.outcome === "terminal" && live.at(-1)?.event.type === "session.waiting", outcome.outcome);
  check("…starting at exactly that index", live[0]?.index === r.index, `first ${live[0]?.index}`);
  const all = [...r.events, ...live.map((x) => x.event)].map(seqOf);
  const want = timeline.map((x) => seqOf(x.event));
  check("replay + live = the whole stream: every event exactly once, in order", JSON.stringify(all) === JSON.stringify(want), `${all.length} of ${want.length}`);
  check("…the live reader's indexes run on without a gap", live.every((x, i) => x.index === r.index + i));
}

/* ---- 2. a stall in OLD history ------------------------------------------------------------------------------- */
console.log("\nA 2 s stall in the middle of an old, parked history:");
{
  const OLD = "2026-10-13T09:00:00.000Z";
  const timeline = [{ at: 0, event: ev("session.started", {}, OLD) }];
  for (let t = 0; t < 3; t++) {
    const T = `turn_${t}`;
    timeline.push({ at: 0, event: ev("turn.started", { turnId: T }, OLD) });
    for (let i = 0; i < 40; i++) timeline.push({ at: 0, event: delta(T, i, OLD) });
    timeline.push({ at: 0, event: ev("turn.completed", { turnId: T }, OLD) });
    timeline.push({ at: 0, event: ev("session.waiting", { continuationToken: `tok-${t}` }, OLD) });
  }
  // The stall: events from the middle of turn 1 on arrive 2 s later (a slow store read).
  const stallAt = 60;
  for (let i = stallAt; i < timeline.length; i++) timeline[i] = { ...timeline[i], at: 2_000 };
  const eve = fakeEve(timeline);
  const got = await readWithin(eve, { sessionId: "s2" }, 10_000);
  const r = got.result;
  check("not \"live\": old stamps are history, not a running turn", r?.stop !== "live", `stop ${r?.stop}`);
  check("the transcript equals a full replay", r?.events.length === timeline.length && r.events.every((e, i) => seqOf(e) === seqOf(timeline[i].event)), `${r?.events.length} of ${timeline.length}`);
  check("…ending on the last park with its token", r?.continuationToken === "tok-2" && r?.index === timeline.length);
}

/* ---- 3. a saved copy ending at a park, then a new running turn ---------------------------------------------- */
console.log("\nA saved copy ending at a park; a new turn is running (seam read, parked=1):");
{
  const OLD = "2026-10-14T08:00:00.000Z";
  const timeline = [
    { at: 0, event: ev("session.started", {}, OLD) },
    { at: 0, event: ev("turn.started", { turnId: "turn_0" }, OLD) },
    { at: 0, event: ev("turn.completed", { turnId: "turn_0" }, OLD) },
    { at: 0, event: ev("session.waiting", { continuationToken: "tok-a" }, OLD) },
  ];
  const N = timeline.length; // the saved copy covers 0..N-1
  timeline.push({ at: 0, event: ev("turn.started", { turnId: "turn_1" }) });
  timeline.push({ at: 0, event: ev("message.received", { turnId: "turn_1", message: "next" }) });
  for (let k = 0; k < 6; k++) timeline.push({ at: 300 * k, event: delta("turn_1", k) }); // to 1,500 ms
  const PAUSE_FROM = 1_500;
  const BEFORE_PAUSE = timeline.length;
  timeline.push({ at: 6_000, event: delta("turn_1", 99) });
  const eve = fakeEve(timeline);
  const got = await readWithin(eve, { sessionId: "s3", tail: { startIndex: N - 1, parked: true } }, PAUSE_FROM + 3_500);
  check("the seam read resolves within ~2 s of the pause", got !== "still reading" && got.resolvedAt < PAUSE_FROM + 2_500, got === "still reading" ? "still reading" : `${Math.round(got.resolvedAt - PAUSE_FROM)} ms after it`);
  const r = got.result;
  check("…\"live\", with the seam event and the new turn's events", r?.stop === "live" && r.events.length === BEFORE_PAUSE - (N - 1) && r.events[0].type === "session.waiting", `stop ${r?.stop}, ${r?.events.length} events`);
  check("…and the absolute index after them", r?.index === BEFORE_PAUSE, `index ${r?.index}`);
}

/* ---- 4. nothing after the park ------------------------------------------------------------------------------ */
console.log("\nA seam read of a parked chat with nothing after it:");
{
  const timeline = [
    { at: 0, event: ev("turn.started", { turnId: "turn_0" }) },
    { at: 0, event: ev("turn.completed", { turnId: "turn_0" }) },
    { at: 0, event: ev("session.waiting", { continuationToken: "tok-z" }) },
  ];
  const eve = fakeEve(timeline);
  const got = await readWithin(eve, { sessionId: "s4", tail: { startIndex: 2, parked: true } }, 5_000);
  check(
    "ends at rest (the park's quiet window or the server's marker), not \"live\", with only the seam event",
    (got.result?.stop === "marker" || got.result?.stop === "park-quiet") && got.result.events.length === 1 && got.result.index === 3,
    `stop ${got.result?.stop}`,
  );
}

/* ---- 5. the rule ---------------------------------------------------------------------------------------------- */
console.log("\nThe live-edge rule:");
{
  const { liveTurnEdge, LIVE_EDGE_MS } = read;
  const now = Date.parse("2026-10-14T12:00:00.000Z");
  const at = (msAgo) => new Date(now - msAgo).toISOString();
  const running = (msAgo) => [ev("turn.started", { turnId: "t" }, at(msAgo + 10)), delta("t", 1, at(msAgo))];
  check("an unfinished turn with a fresh last event is live", liveTurnEdge(running(1_000), now));
  check("…not when the last event is older than the edge", !liveTurnEdge(running(LIVE_EDGE_MS + 1_000), now));
  check("a finished turn is never live", !liveTurnEdge([...running(10), ev("turn.completed", { turnId: "t" }, at(5))], now));
  check("an event with no stamp is never live", !liveTurnEdge([ev("turn.started", { turnId: "t" }, undefined), { type: "reasoning.appended", data: {} }], now));
  check("an empty read is never live", !liveTurnEdge([], now));
}

console.log(`\nchat replay read: ${passed}/${passed} checks passed`);

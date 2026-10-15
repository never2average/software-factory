/**
 * Server-Timing on the two routes a chat open reads, carried into the open's record.
 *
 * Nobody could say which hop a slow open spent its time in: replay time did not follow bytes (4.5 MB in 7.0 s, 29 MB in
 * 4.7 s, 187 KB in 17.3 s), and neither route said anything about its own time. Now:
 *
 *   - `/api/ops/chat-snapshots` (GET) answers with `Server-Timing: auth, access, snapshot (the database read), total`;
 *   - `/api/ops/chat-replay` answers with `Server-Timing: auth, access, eve (eve's response headers), total`, and its
 *     end marker carries what a header cannot (both happen after the headers are sent): eve's first body chunk and the
 *     marker itself, in ms from the request's start;
 *   - the browser parses both into the open's record (`record.server`) and the detailed telemetry row (`srv=`).
 *
 * Executed: lib/server-timing.ts, the real `boundedReplay`, the real reader `readReplay` over a stubbed fetch, and the
 * real record in lib/chat-open-timing.ts. The routes themselves need a database and a sign-in, so their wiring is
 * checked in their source.
 *
 * Run:  npm run test:chat-server-timing
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as st from "../lib/server-timing.ts";
import { boundedReplay } from "../lib/chat-replay-stream.ts";
import { readReplay } from "../lib/chat-replay-read.ts";
import * as timing from "../lib/chat-open-timing.ts";

let passed = 0;
const check = (label, condition, detail = "") => {
  assert.ok(condition, `${label}${detail ? ` (${detail})` : ""}`);
  passed++;
  console.log(`  ok   ${label}${detail ? `  [${detail}]` : ""}`);
};

/* ---- 1. the header -------------------------------------------------------------------------------------------- */
console.log("The header:");
{
  const header = st.formatServerTiming([["auth", 12.34], ["access", 5], ["snapshot", 80.06], ["total", 100]]);
  check("formatted as name;dur=ms", header === "auth;dur=12.3, access;dur=5, snapshot;dur=80.1, total;dur=100", header);
  const parsed = st.parseServerTiming(header);
  check("parsed back into { name: ms }", JSON.stringify(parsed) === JSON.stringify({ auth: 12.3, access: 5, snapshot: 80.1, total: 100 }));
  check("a name that is not a plain token, or a value that is not a number, is dropped", st.formatServerTiming([["Bad Name", 1], ["ok", NaN], ["fine", 2]]) === "fine;dur=2");
  check("entries without a duration and other noise are skipped", JSON.stringify(st.parseServerTiming('cdn-cache;desc="HIT", eve;dur=40;desc="eve headers", x;dur=abc')) === JSON.stringify({ eve: 40 }));
  check("no header, or a malformed one, is {}", Object.keys(st.parseServerTiming(null)).length === 0 && Object.keys(st.parseServerTiming(";;,,dur=")).length === 0);
  let t = 0;
  const watch = st.serverStopwatch(() => t);
  t = 10;
  watch.mark("auth");
  t = 25;
  watch.mark("access");
  t = 325;
  watch.mark("eve");
  t = 330;
  check("the stopwatch: each mark closes its phase, total is start to now", watch.header() === "auth;dur=10, access;dur=15, eve;dur=300, total;dur=330", watch.header());
}

/* ---- 2. the marker carries what a header cannot ---------------------------------------------------------------- */
console.log("\nThe replay marker:");
const enc = new TextEncoder();
const line = (e) => enc.encode(`${JSON.stringify(e)}\n`);
const park = { type: "session.waiting", data: { continuationToken: "tok" }, meta: { at: new Date().toISOString() } };
async function bodyLines(body) {
  const text = await new Response(body).text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
{
  const startedAt = performance.now();
  const upstream = new ReadableStream({
    start(c) {
      setTimeout(() => c.enqueue(line(park)), 300);
    },
  });
  const lines = await bodyLines(boundedReplay(upstream, { startIndex: 4, replayOnly: true, assumeParked: true, timing: { startedAt } }));
  const marker = lines.find((l) => l.type === "ops.replay.end");
  check("the marker says when eve's first chunk came", marker?.data.timing?.firstByte >= 280 && marker.data.timing.firstByte < 700, `firstByte ${marker?.data.timing?.firstByte}`);
  check("…and when the marker itself was sent", marker?.data.timing?.ms >= marker?.data.timing?.firstByte + 350, `ms ${marker?.data.timing?.ms}`);
  check("…and nothing else about it changed", marker?.data.index === 5 && marker.data.drained === true);
  const plain = await bodyLines(boundedReplay(new ReadableStream({ start(c) { c.enqueue(line(park)); } }), { startIndex: 0, replayOnly: true }));
  check("without the request's clock, no timing field (the shared-thread proxy is unchanged)", !("timing" in plain.find((l) => l.type === "ops.replay.end").data));
}

/* ---- 3. the reader hands both to the open's record ----------------------------------------------------------- */
console.log("\nInto the open's record:");
{
  timing.resetChatOpenTimingForTest();
  timing.configureChatOpenTiming({ windowStore: false });
  const open = timing.beginChatOpen({ chatId: "c", sessionId: "s", storedEvents: 0, storedToken: false });

  // The saved copy's answer (what fetchSnapshot reads off the response).
  const snapHeader = new Response("{}", { headers: { "server-timing": "auth;dur=20, access;dur=15, snapshot;dur=95, total;dur=131" } });
  open.serverTiming("snapshot", st.parseServerTiming(snapHeader.headers.get("server-timing")));

  // A seam read through the real route wrapper: the header the route writes, the marker boundedReplay writes.
  const fetch = async (url, init) => {
    const startedAt = performance.now();
    const watch = st.serverStopwatch();
    watch.mark("auth");
    watch.mark("access");
    await new Promise((r) => setTimeout(r, 120)); // eve's response headers
    watch.mark("eve");
    const upstream = new ReadableStream({
      start(c) {
        setTimeout(() => c.enqueue(line(park)), 200);
      },
    });
    const u = new URL(url, "http://app.test");
    return new Response(
      boundedReplay(upstream, { startIndex: Number(u.searchParams.get("startIndex")), replayOnly: true, assumeParked: true, timing: { startedAt } }),
      { headers: { "content-type": "application/x-ndjson", "server-timing": watch.header() } },
    );
  };
  const { result } = await readReplay({
    sessionId: "s",
    tail: { startIndex: 9, parked: true },
    headers: () => ({}),
    fetch,
    onServerTiming: (t) => open.serverTiming("replay", t.phases, { firstByte: t.firstByte, marker: t.marker }),
  });
  check("the read itself is unchanged", result?.events.length === 1 && result.index === 10);
  const rec = open.record;
  check("the saved copy's phases are in the record", rec.server.snapshot?.snapshot === 95 && rec.server.snapshot?.total === 131);
  const rep = rec.server.replay[0];
  check("the replay read's header phases are in the record", rep && ["auth", "access", "eve", "total"].every((k) => typeof rep.phases[k] === "number") && rep.phases.eve >= 100, JSON.stringify(rep?.phases));
  check("…with eve's first byte and the marker from the stream", rep?.firstByte >= rep?.phases.eve && rep?.marker > rep?.firstByte, `firstByte ${rep?.firstByte}, marker ${rep?.marker}`);
  const detail = timing.formatOpenDetail(rec);
  check("the detailed row carries them (srv=snap:<db>/<total>,eve:<headers>/<first byte>/<marker>)", /srv=snap:95\/131,eve:\d+\/\d+\/\d+/.test(detail), detail);
  check("…within the row's 300 characters", detail.length <= timing.DETAIL_MAX);
  for (let i = 0; i < 10; i++) open.serverTiming("replay", { eve: 1 });
  check("replay reads kept per record are capped", rec.server.replay.length === timing.SERVER_TIMING_MAX_READS);
  open.serverTiming("snapshot", { "Bad Name": 3, auth: -1, total: Number.NaN, ok: 4 });
  check("only plain names with real durations reach the record", JSON.stringify(rec.server.snapshot) === JSON.stringify({ ok: 4 }));
  timing.resetChatOpenTimingForTest();
}

/* ---- 4. the routes and the shell ----------------------------------------------------------------------------- */
console.log("\nThe routes and the shell:");
{
  const replayRoute = readFileSync("app/api/ops/chat-replay/route.ts", "utf8");
  check("/api/ops/chat-replay times sign-in, access and eve", /watch\.mark\("auth"\)/.test(replayRoute) && /watch\.mark\("access"\)/.test(replayRoute) && /watch\.mark\("eve"\)/.test(replayRoute));
  check("…sends them as Server-Timing", /"server-timing": watch\.header\(\)/.test(replayRoute));
  check("…and gives the marker the request's clock", /timing: \{ startedAt \}/.test(replayRoute));
  const snapRoute = readFileSync("app/api/ops/chat-snapshots/route.ts", "utf8");
  const get = snapRoute.slice(snapRoute.indexOf("export async function GET"), snapRoute.indexOf("const bodySchema"));
  check("/api/ops/chat-snapshots GET times sign-in, access and the database read", /watch\.mark\("auth"\)/.test(get) && /watch\.mark\("access"\)/.test(get) && /watch\.mark\("snapshot"\)/.test(get));
  check("…on both of its answers (a row, and no row)", /return timed\(NextResponse\.json\(\{ snapshot: null \}\)\)/.test(get) && /return timed\(NextResponse\.json\(\{ snapshot \}\)\)/.test(get));
  check("…by setting the header", /res\.headers\.set\("server-timing", watch\.header\(\)\)/.test(get));
  const shell = readFileSync("app/_components/chat-shell.tsx", "utf8");
  check("the shell reads the saved copy's header into the open", /parseServerTiming\(res\.headers\.get\("server-timing"\)\)/.test(shell) && /timing\.serverTiming\("snapshot", phases\)/.test(shell));
  check("…and every replay read's", /opts\.timing\?\.serverTiming\("replay", t\.phases, \{ firstByte: t\.firstByte, marker: t\.marker \}\)/.test(shell) && (shell.match(/\{ signal: ticket\.signal, timing \}/g) ?? []).length >= 3);
}

console.log(`\nchat server timing: ${passed}/${passed} checks passed`);

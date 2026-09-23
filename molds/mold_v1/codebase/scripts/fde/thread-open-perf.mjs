// fde:thread-open-perf — measure what "opening a thread" actually costs in the
// deployed app, phase by phase, from a laptop.
//
// Opening a chat is not one request. The browser lists threads through the Ops
// API (JWKS-gated), then REPLAYS the eve session's ndjson stream — and for a
// SHARED thread it does that through a membership-checked proxy that adds a
// second hop. "The app feels slow to open a chat" can therefore be the gate,
// the Next rewrite hop, the eve stream itself, or the client's own quiet-window
// heuristics deciding when to stop reading. Averaging them into one number
// hides the culprit, so this measures each boundary separately:
//
//   /api/ops/threads                       the JWKS gate + a DB read
//   /eve/v1/session/:id/stream (rewrite)   the OLD open: the whole stream
//   same session, DIRECT to fde-agent-api  delta = the Next rewrite hop
//   /api/ops/chat-snapshots (cache)        the NEW open, phase 1: the transcript
//   /api/ops/chat-replay (tail)            the NEW open, phase 2: what is new
//   /api/ops/threads/:id/stream (shared)   delta = membership check + 2nd hop
//
//   npm run fde:thread-open-perf                    # unauthenticated baseline
//   npm run fde:thread-open-perf -- --token "$T"    # + the thread-open phases
//   npm run fde:thread-open-perf -- --token-file ~/.fde-token --runs 3 --json
//   npm run fde:thread-open-perf -- --owned <threadId> --shared <threadId>
//
// TWO TERMS, REPORTED SEPARATELY, because they have different fixes.
//
//   bytes/events  what the open re-downloads and re-reduces. Grows with the
//                 conversation; the transcript cache is what removes it.
//   quiet         what the open spends waiting for SILENCE to decide the
//                 backlog has drained. Fixed per segment (1,500ms mid-replay,
//                 300ms at a park) and nothing to do with size at all; the
//                 server-side `ops.replay.end` marker is what removes it.
//
// A thread can be slow for either reason, and the totals alone cannot tell you
// which — so a fix aimed at the wrong term reads as no improvement.
//
// The stream numbers only mean something if they describe the SAME read the
// browser performs, so the loop below is a transcription of `replaySession` in
// app/_components/chat-shell.tsx — including its SEGMENTS and its quiet windows.
// Keep the two in step.
import { readFileSync } from "node:fs";
import { glyph, flag, hasFlag } from "./lib/fde.mjs";

const FRONT = (process.env.FDE_OPS_URL ?? "https://fde-agent.vercel.app").replace(/\/$/, "");
const AGENT = (process.env.NEXT_PUBLIC_EVE_API_URL ?? "https://fde-agent-api.vercel.app").replace(/\/$/, "");

// chat-shell's own bounds. Named here so a drift between the two is visible.
const HARD_TIMEOUT_MS = 15_000;
const QUIET_AT_BOUNDARY_MS = 300;
const QUIET_MID_REPLAY_MS = 1_500;

const ms = (n) => (n == null ? "—" : `${Math.round(n)}ms`);
const bytes = (n) => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`);

/** Fixed-width table so a slow phase is obvious by eye, not by arithmetic. */
function table(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? "").length)),
  );
  const line = (cells) => cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ");
  console.log(`  ${line(headers)}`);
  console.log(`  ${widths.map((w) => "-".repeat(w)).join("  ")}`);
  for (const r of rows) console.log(`  ${line(r)}`);
}

/** A plain request: time to response headers, time to a fully drained body. */
async function probe(url, { headers = {}, timeoutMs = 30_000 } = {}) {
  const started = performance.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const headersAt = performance.now() - started;
    const body = await res.text();
    return {
      ok: true,
      status: res.status,
      headersMs: headersAt,
      totalMs: performance.now() - started,
      bytes: Buffer.byteLength(body),
      body,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      headersMs: null,
      totalMs: performance.now() - started,
      bytes: 0,
      body: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Replay ONE segment of an ndjson session stream exactly as the browser does,
 * and report where the time went and WHY the read stopped.
 *
 * The stop reason is the whole point: a `park-quiet` stop means the client's
 * heuristic ended the open (tune the window), an `eof` means the server closed
 * (server-side cost), a `marker` means the server SAID where replay ends — the
 * only stop that costs nothing — and `HARD-TIMEOUT` means none of those
 * happened and the user waited the full 15s.
 *
 * `quietMs` is the other number that matters. It is the part of `totalMs` spent
 * waiting for silence rather than reading bytes: latency this client chose, not
 * latency the server imposed. Reported separately because it is fixed per
 * segment and has nothing to do with the size of the conversation, so the fix
 * for it is a different fix.
 */
async function streamProbe(url, headers) {
  const started = performance.now();
  const ctrl = new AbortController();
  const hardTimer = setTimeout(() => ctrl.abort(), HARD_TIMEOUT_MS);
  const out = {
    url,
    status: 0,
    headersMs: null,
    firstByteMs: null,
    lastByteMs: null,
    totalMs: 0,
    quietMs: 0,
    bytes: 0,
    lines: 0,
    boundary: "none",
    continuationToken: false,
    markerIndex: null,
    drained: null,
    stop: "eof",
    error: null,
  };
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    out.headersMs = performance.now() - started;
    out.status = res.status;
    if (!res.ok || !res.body) {
      out.stop = "eof";
      out.error = `HTTP ${res.status}`;
      return out;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let atBoundary = false;
    let sawAnyEvent = false;
    let finished = false;
    for (;;) {
      if (finished) {
        out.stop = out.markerIndex == null ? "terminal" : "marker";
        break;
      }
      // Tagged so the loser of the race is identifiable — chat-shell only needs
      // "stop", but attributing the stop is this script's reason to exist.
      const read = reader
        .read()
        .then((r) => ({ kind: "read", ...r }))
        .catch(() => ({ kind: "read", done: true, value: undefined }));
      const quietMs = atBoundary ? QUIET_AT_BOUNDARY_MS : sawAnyEvent ? QUIET_MID_REPLAY_MS : 0;
      const waitedFrom = performance.now();
      const r = quietMs
        ? await Promise.race([
            read,
            new Promise((resolve) =>
              setTimeout(() => resolve({ kind: "quiet", done: true }), quietMs),
            ),
          ])
        : await read;
      // Only a window that WON the race cost anything; when the read came back
      // first the timer was free.
      if (r.kind === "quiet") out.quietMs += performance.now() - waitedFrom;
      /**
       * An abort does NOT reject out of this race in a way you can see from
       * `r` alone: the hard timer aborts the signal, `reader.read()` rejects,
       * the `.catch` above turns it into a resolved `{done:true}` — identical
       * to a clean end of stream. The first version of this script reported
       * 15s hard timeouts as `eof`, i.e. as the server closing promptly, which
       * is the exact opposite of the truth. Ask the signal.
       */
      if (ctrl.signal.aborted) {
        out.stop = "HARD-TIMEOUT";
        break;
      }
      if (r.done) {
        out.stop = r.kind === "quiet" ? "park-quiet" : "eof";
        break;
      }
      const now = performance.now() - started;
      if (out.firstByteMs == null) out.firstByteMs = now;
      out.lastByteMs = now;
      out.bytes += r.value.byteLength;
      buf += dec.decode(r.value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          const ev = JSON.parse(l);
          // The replay-end marker is bookkeeping, not conversation: it is not
          // an event, and the reader stops on it without paying a quiet window.
          if (ev.type === "ops.replay.end") {
            out.markerIndex = typeof ev.data?.index === "number" ? ev.data.index : null;
            out.drained = ev.data?.drained !== false;
            if (out.drained) finished = true;
            continue;
          }
          out.lines += 1;
          sawAnyEvent = true;
          if (ev.type === "session.waiting" && ev.data?.continuationToken) {
            out.continuationToken = true;
          }
          if (ev.type === "session.waiting" || ev.type === "session.completed" || ev.type === "session.failed") {
            out.boundary = ev.type;
          }
          if (ev.type === "session.completed" || ev.type === "session.failed") {
            finished = true;
          } else {
            atBoundary =
              ev.type === "session.waiting" ||
              ev.type === "turn.completed" ||
              ev.type === "turn.failed";
          }
        } catch {
          /* skip malformed line */
        }
      }
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    if (ctrl.signal.aborted) out.stop = "HARD-TIMEOUT";
  } finally {
    clearTimeout(hardTimer);
    ctrl.abort();
    out.totalMs = performance.now() - started;
  }
  return out;
}

/**
 * A WHOLE open, not one segment.
 *
 * `replaySession` keeps reopening the stream at the advanced index until the
 * session is at rest, because eve severs a stream on a ~120s boundary with a
 * clean EOF mid-history. A harness that measured one segment measured the first
 * two minutes of a long thread's open and called it the open. Same bounds as
 * the client: 12 segments, a 60s budget (12s for a shared read).
 */
async function replayProbe(urlFor, headers, { bounded = false, startIndex = 0 } = {}) {
  const started = performance.now();
  const deadline = started + (bounded ? 12_000 : 60_000);
  const agg = {
    segments: 0,
    status: 0,
    headersMs: null,
    firstByteMs: null,
    lastByteMs: null,
    totalMs: 0,
    quietMs: 0,
    bytes: 0,
    lines: 0,
    boundary: "none",
    continuationToken: false,
    index: startIndex,
    stop: "eof",
    error: null,
  };
  let cursor = startIndex;
  for (;;) {
    const seg = await streamProbe(urlFor(cursor), headers);
    agg.segments += 1;
    if (agg.headersMs == null) agg.headersMs = seg.headersMs;
    if (agg.firstByteMs == null) agg.firstByteMs = seg.firstByteMs;
    if (seg.lastByteMs != null) agg.lastByteMs = performance.now() - started;
    agg.status = seg.status;
    agg.quietMs += seg.quietMs;
    agg.bytes += seg.bytes;
    agg.lines += seg.lines;
    agg.stop = seg.stop;
    agg.error ??= seg.error;
    if (seg.boundary !== "none") agg.boundary = seg.boundary;
    if (seg.continuationToken) agg.continuationToken = true;
    cursor = seg.markerIndex ?? cursor + seg.lines;
    agg.index = cursor;
    const atRest =
      seg.stop === "marker" ||
      seg.stop === "terminal" ||
      seg.stop === "park-quiet" ||
      seg.lines === 0;
    if (atRest || bounded || performance.now() > deadline || agg.segments >= 12) break;
  }
  agg.totalMs = performance.now() - started;
  return agg;
}

function readToken() {
  const inline = flag("token").trim();
  if (inline) return inline;
  const file = flag("token-file").trim();
  if (file) {
    try {
      return readFileSync(file, "utf8").trim();
    } catch (e) {
      console.error(`${glyph.bad} Could not read --token-file ${file}: ${e.message}`);
      process.exit(1);
    }
  }
  return (process.env.FDE_GOOGLE_TOKEN ?? "").trim();
}

const HOW_TO_GET_A_TOKEN =
  `  Sign in at ${FRONT}, open the browser console and run:\n` +
  `    copy(localStorage.getItem("workspace-google-token") || localStorage.getItem("fde-google-token"))\n` +
  `  then pass it (Google ID tokens live ~1h, so re-copy when it expires):\n` +
  `    npm run fde:thread-open-perf -- --token "<paste>"\n` +
  `  or:  FDE_GOOGLE_TOKEN=<paste> npm run fde:thread-open-perf\n` +
  `  or:  npm run fde:thread-open-perf -- --token-file ~/.fde-token`;

/** Unauthenticated, always runs: is the platform itself slow today? */
async function baseline(json) {
  const targets = [
    ["front /api/ops/health", `${FRONT}/api/ops/health`],
    ["agent /eve/v1/health", `${AGENT}/eve/v1/health`],
    // Unauthenticated on purpose: a 401 here is the JWKS gate's OWN cost with
    // no database work behind it, which is the floor every authed Ops call pays.
    ["front /api/ops/threads (401 expected)", `${FRONT}/api/ops/threads`],
  ];
  const rows = [];
  const results = [];
  for (const [label, url] of targets) {
    // Two passes: the first pays cold-start/TLS, the second is what a warm user
    // sees. Reporting only one of them makes every number arguable.
    for (const phase of ["cold", "warm"]) {
      const r = await probe(url);
      results.push({ label, phase, ...r, body: undefined });
      rows.push([
        label,
        phase,
        r.ok ? String(r.status) : "ERR",
        ms(r.headersMs),
        ms(r.totalMs),
        r.ok ? bytes(r.bytes) : (r.error ?? ""),
      ]);
      if (label.startsWith("front /api/ops/health") && phase === "warm" && r.ok) {
        // The health route times its own dependencies; those numbers explain a
        // slow total far better than the round trip does.
        try {
          const h = JSON.parse(r.body);
          for (const k of ["db", "blob", "inference"]) {
            if (h?.[k]) {
              rows.push([`  ↳ ${k}`, "", h[k].ok ? "ok" : "BAD", "", ms(h[k].ms), h[k].detail ?? ""]);
            }
          }
        } catch {
          /* health shape changed — the round-trip numbers still stand */
        }
      }
    }
  }
  if (!json) {
    console.log(`\nUnauthenticated baseline\n`);
    table(["target", "run", "status", "headers", "total", "bytes / detail"], rows);
  }
  return results;
}

function streamRow(label, r) {
  return [
    label,
    r.status ? String(r.status) : "ERR",
    ms(r.headersMs),
    ms(r.firstByteMs),
    ms(r.totalMs),
    // The part of `total` that was spent waiting for silence rather than
    // reading. A big number here is client-side latency by construction.
    ms(r.quietMs ?? 0),
    String(r.segments ?? 1),
    bytes(r.bytes),
    String(r.lines),
    r.boundary,
    r.continuationToken ? "yes" : "no",
    r.stop,
  ];
}

const STREAM_HEADERS = [
  "phase",
  "status",
  "headers",
  "first",
  "total",
  "quiet",
  "segs",
  "bytes",
  "events",
  "boundary",
  "token",
  "stop",
];

/**
 * THE NEW OPEN, measured end to end: the cached transcript, then only the tail.
 *
 * Phase 1 is one indexed row (`/api/ops/chat-snapshots`) and is what the user
 * actually waits for — the thread paints from it. Phase 2 reads the stream from
 * one event BEFORE the snapshot ends (the seam the client verifies) and is
 * normally empty, because a parked thread is the normal resting state.
 *
 * Returns null when there is no snapshot for this session yet, which is a
 * legitimate answer: the first open after a deploy still pays the old price and
 * writes the row that makes every later one cheap.
 */
async function newOpenProbe(sessionId, headers) {
  const snap = await probe(
    `${FRONT}/api/ops/chat-snapshots?session=${encodeURIComponent(sessionId)}`,
    { headers },
  );
  if (!snap.ok || snap.status !== 200) return { snapshot: snap, tail: null, missing: true };
  let parsed = null;
  try {
    parsed = JSON.parse(snap.body).snapshot ?? null;
  } catch {
    /* treated as a miss below */
  }
  if (!parsed) return { snapshot: snap, tail: null, missing: true };
  const tail = await replayProbe(
    (cursor) =>
      `${FRONT}/api/ops/chat-replay?session=${encodeURIComponent(sessionId)}&startIndex=${cursor}&parked=1`,
    headers,
    { startIndex: Math.max(0, parsed.eventIndex - 1) },
  );
  return {
    snapshot: snap,
    tail,
    missing: false,
    eventIndex: parsed.eventIndex,
    storedEvents: Array.isArray(parsed.events) ? parsed.events.length : 0,
  };
}

async function main() {
  const json = hasFlag("json");
  const runs = Math.max(1, Number(flag("runs")) || 1);
  const token = readToken();
  const report = { front: FRONT, agent: AGENT, at: new Date().toISOString(), baseline: null, phases: [] };

  report.baseline = await baseline(json);

  if (!token) {
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(
        `\n${glyph.info} No token — baseline only. The thread-open phases need a signed-in\n` +
          `  @onfinance.in identity.\n${HOW_TO_GET_A_TOKEN}`,
      );
    }
    // Not an error: the baseline is a legitimate, complete result on its own.
    process.exit(0);
  }

  const headers = { authorization: `Bearer ${token}` };

  // Phase 1: the thread list. Also the token check — fail here, loudly, rather
  // than letting every later phase 401 into meaningless numbers.
  const listRuns = [];
  for (let i = 0; i < runs; i++) listRuns.push(await probe(`${FRONT}/api/ops/threads`, { headers }));
  const list = listRuns[listRuns.length - 1];
  if (list.status === 401) {
    console.error(
      `\n${glyph.bad} /api/ops/threads returned 401 with your token.\n` +
        `  Either it has expired (Google ID tokens last ~1h) or it is not an\n` +
        `  @onfinance.in account — only that domain is admitted.\n${HOW_TO_GET_A_TOKEN}`,
    );
    process.exit(1);
  }
  if (!list.ok || list.status !== 200) {
    console.error(
      `\n${glyph.bad} /api/ops/threads failed: ${list.error ?? `HTTP ${list.status}`}\n` +
        `  ${list.body.slice(0, 300)}`,
    );
    process.exit(1);
  }

  let items = [];
  try {
    items = JSON.parse(list.body).items ?? [];
  } catch {
    console.error(`${glyph.bad} /api/ops/threads did not return JSON items.`);
    process.exit(1);
  }

  if (!json) {
    console.log(`\nAuthenticated — thread list (${items.length} threads)\n`);
    table(
      ["phase", "run", "status", "headers (TTFB)", "total", "bytes"],
      listRuns.map((r, i) => [
        "GET /api/ops/threads",
        i === 0 ? "cold" : `run ${i + 1}`,
        String(r.status),
        ms(r.headersMs),
        ms(r.totalMs),
        bytes(r.bytes),
      ]),
    );
  }
  report.phases.push({ phase: "threads-list", runs: listRuns.map((r) => ({ ...r, body: undefined })) });

  const pinnedOwned = flag("owned").trim();
  const pinnedShared = flag("shared").trim();
  const owned = pinnedOwned
    ? items.find((t) => t.id === pinnedOwned)
    : items.find((t) => t.role === "owner" && t.eveSessionId);
  const shared = pinnedShared
    ? items.find((t) => t.id === pinnedShared)
    : items.find((t) => t.role !== "owner" && t.eveSessionId);

  if (pinnedOwned && !owned) console.log(`${glyph.warn} --owned ${pinnedOwned} is not in your thread list.`);
  if (pinnedShared && !shared) console.log(`${glyph.warn} --shared ${pinnedShared} is not in your thread list.`);

  const rows = [];
  /** old vs new, per thread, so the summary is measured and not asserted. */
  const comparisons = [];
  if (owned) {
    const sid = encodeURIComponent(owned.eveSessionId);
    for (let i = 0; i < runs; i++) {
      const suffix = runs > 1 ? ` #${i + 1}` : "";
      // THE OLD OPEN: the whole stream, from event zero, in segments, stopping
      // on a quiet window. This is what every reopen used to cost.
      const viaRewrite = await replayProbe(
        (cursor) => `${FRONT}/eve/v1/session/${sid}/stream?startIndex=${cursor}`,
        headers,
      );
      // Same session, no Next in the path: the difference is the rewrite hop and
      // nothing else, so it is only meaningful measured back to back.
      const direct = await streamProbe(`${AGENT}/eve/v1/session/${sid}/stream`, headers);
      rows.push(streamRow(`OLD owned full replay${suffix}`, viaRewrite));
      rows.push(streamRow(`  ↳ same, DIRECT to agent (1 seg)${suffix}`, direct));

      // THE NEW OPEN: one cached row, then only what is new.
      const fresh = await newOpenProbe(owned.eveSessionId, headers);
      if (fresh.missing) {
        rows.push([
          `NEW owned snapshot+tail${suffix}`,
          String(fresh.snapshot.status || "ERR"),
          ms(fresh.snapshot.headersMs),
          "",
          ms(fresh.snapshot.totalMs),
          "",
          "",
          bytes(fresh.snapshot.bytes),
          "",
          "",
          "",
          "no-snapshot-yet",
        ]);
      } else {
        rows.push([
          `NEW ↳ snapshot fetch${suffix}`,
          String(fresh.snapshot.status),
          ms(fresh.snapshot.headersMs),
          ms(fresh.snapshot.headersMs),
          ms(fresh.snapshot.totalMs),
          "0ms",
          "1",
          bytes(fresh.snapshot.bytes),
          String(fresh.storedEvents),
          `index ${fresh.eventIndex}`,
          "n/a",
          "row",
        ]);
        rows.push(streamRow(`NEW ↳ tail replay${suffix}`, fresh.tail));
        const newTotal = fresh.snapshot.totalMs + fresh.tail.totalMs;
        const newQuiet = fresh.tail.quietMs;
        const newBytes = fresh.snapshot.bytes + fresh.tail.bytes;
        rows.push([
          `NEW owned open TOTAL${suffix}`,
          "",
          "",
          // What the user waits for before the thread PAINTS: the snapshot
          // alone. The tail lands behind an already-drawn conversation.
          ms(fresh.snapshot.totalMs),
          ms(newTotal),
          ms(newQuiet),
          String(1 + fresh.tail.segments),
          bytes(newBytes),
          String(fresh.storedEvents + fresh.tail.lines),
          "",
          "",
          fresh.tail.stop,
        ]);
        comparisons.push({
          thread: owned.id,
          oldMs: viaRewrite.totalMs,
          oldQuietMs: viaRewrite.quietMs,
          oldBytes: viaRewrite.bytes,
          oldEvents: viaRewrite.lines,
          newMs: newTotal,
          newPaintMs: fresh.snapshot.totalMs,
          newQuietMs: newQuiet,
          newBytes,
          newEvents: fresh.tail.lines,
        });
        report.phases.push({ phase: "owned-snapshot", thread: owned.id, ...fresh.snapshot, body: undefined });
        report.phases.push({ phase: "owned-tail", thread: owned.id, ...fresh.tail });
      }
      report.phases.push({ phase: "owned-rewrite", thread: owned.id, ...viaRewrite });
      report.phases.push({ phase: "owned-direct", thread: owned.id, ...direct });
    }
  }
  if (shared) {
    for (let i = 0; i < runs; i++) {
      const r = await replayProbe(
        () => `${FRONT}/api/ops/threads/${encodeURIComponent(shared.id)}/stream?replay=1&replayOnly=1`,
        headers,
        { bounded: true },
      );
      rows.push(streamRow(`shared via proxy${runs > 1 ? ` #${i + 1}` : ""}`, r));
      report.phases.push({ phase: "shared-proxy", thread: shared.id, ...r });
    }
  }
  report.comparisons = comparisons;

  if (!json) {
    console.log(`\nThread open — stream phases (replaySession semantics)\n`);
    if (rows.length) table(STREAM_HEADERS, rows);
    else console.log(`  ${glyph.warn} No thread with an eve session id to measure.`);
    if (owned) console.log(`\n  owned:  ${owned.id}  session ${owned.eveSessionId}  "${owned.title}"`);
    if (shared) console.log(`  shared: ${shared.id}  session ${shared.eveSessionId}  "${shared.title}"`);
    if (!shared) {
      console.log(
        `  ${glyph.info} No shared thread found — the membership-check + second-hop delta is\n` +
          `    unmeasured. Pin one with --shared <threadId>.`,
      );
    }
    console.log(
      `\n  stop: terminal = session.completed/failed · marker = the server said where\n` +
        `        replay ends (costs no wait) · park-quiet = client quiet window\n` +
        `        (${QUIET_AT_BOUNDARY_MS}ms at a park, ${QUIET_MID_REPLAY_MS}ms mid-replay) · eof = server closed ·\n` +
        `        HARD-TIMEOUT = the full ${HARD_TIMEOUT_MS / 1000}s, what the user actually waits\n`,
    );
    /**
     * The one line the change is answerable for. Both terms, separately: a fix
     * that removed bytes but not quiet windows (or the reverse) would otherwise
     * read as a modest overall win and hide which half actually moved.
     */
    for (const c of comparisons) {
      const pct = (a, b) => (a > 0 ? `${Math.round((1 - b / a) * 100)}% less` : "—");
      console.log(
        `  ${glyph.ok} open cost for ${c.thread}:\n` +
          `      total   ${ms(c.oldMs)} → ${ms(c.newMs)} (${pct(c.oldMs, c.newMs)}), painted at ${ms(c.newPaintMs)}\n` +
          `      quiet   ${ms(c.oldQuietMs)} → ${ms(c.newQuietMs)} (${pct(c.oldQuietMs, c.newQuietMs)})\n` +
          `      bytes   ${bytes(c.oldBytes)} → ${bytes(c.newBytes)} (${pct(c.oldBytes, c.newBytes)})\n` +
          `      events  ${c.oldEvents} replayed → ${c.newEvents} replayed\n`,
      );
    }
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

try {
  await main();
} catch (error) {
  // Never a stack trace: every failure here is operational (network, token,
  // shape), and a trace buries the one line that says what to do.
  console.error(`${glyph.bad} ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// fde:thread-open-perf — measure what "opening a thread" actually costs in the
// deployed Delivered app, phase by phase, from a laptop.
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
//   /eve/v1/session/:id/stream (rewrite)   what the browser really fetches
//   same session, DIRECT to fde-agent-api  delta = the Next rewrite hop
//   /api/ops/threads/:id/stream (shared)   delta = membership check + 2nd hop
//
//   npm run fde:thread-open-perf                    # unauthenticated baseline
//   npm run fde:thread-open-perf -- --token "$T"    # + the thread-open phases
//   npm run fde:thread-open-perf -- --token-file ~/.fde-token --runs 3 --json
//   npm run fde:thread-open-perf -- --owned <threadId> --shared <threadId>
//
// The stream numbers only mean something if they describe the SAME read the
// browser performs, so the loop below is a transcription of `replaySession` in
// app/_components/chat-shell.tsx — including its quiet windows, which are
// usually the dominant term. Keep the two in step.
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
 * Replay an ndjson session stream exactly as the browser does, and report where
 * the time went and WHY the read stopped.
 *
 * The stop reason is the whole point: a `park-quiet` stop means the client's
 * heuristic ended the open (tune the window), an `eof` means the server closed
 * (server-side cost), and `HARD-TIMEOUT` means neither happened and the user
 * waited the full 15s.
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
    bytes: 0,
    lines: 0,
    boundary: "none",
    continuationToken: false,
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
        out.stop = "terminal";
        break;
      }
      // Tagged so the loser of the race is identifiable — chat-shell only needs
      // "stop", but attributing the stop is this script's reason to exist.
      const read = reader
        .read()
        .then((r) => ({ kind: "read", ...r }))
        .catch(() => ({ kind: "read", done: true, value: undefined }));
      const quietMs = atBoundary ? QUIET_AT_BOUNDARY_MS : sawAnyEvent ? QUIET_MID_REPLAY_MS : 0;
      const r = quietMs
        ? await Promise.race([
            read,
            new Promise((resolve) =>
              setTimeout(() => resolve({ kind: "quiet", done: true }), quietMs),
            ),
          ])
        : await read;
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
  `    copy(localStorage.getItem("fde-google-token"))\n` +
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
    ms(r.lastByteMs),
    ms(r.totalMs),
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
  "last",
  "total",
  "bytes",
  "lines",
  "boundary",
  "token",
  "stop",
];

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
  if (owned) {
    const sid = encodeURIComponent(owned.eveSessionId);
    for (let i = 0; i < runs; i++) {
      const viaRewrite = await streamProbe(`${FRONT}/eve/v1/session/${sid}/stream`, headers);
      // Same session, no Next in the path: the difference is the rewrite hop and
      // nothing else, so it is only meaningful measured back to back.
      const direct = await streamProbe(`${AGENT}/eve/v1/session/${sid}/stream`, headers);
      const suffix = runs > 1 ? ` #${i + 1}` : "";
      rows.push(streamRow(`owned via rewrite${suffix}`, viaRewrite));
      rows.push(streamRow(`owned DIRECT to agent${suffix}`, direct));
      rows.push([
        `  ↳ rewrite hop cost${suffix}`,
        "",
        ms((viaRewrite.headersMs ?? 0) - (direct.headersMs ?? 0)),
        "",
        "",
        ms(viaRewrite.totalMs - direct.totalMs),
        "",
        "",
        "",
        "",
        "",
      ]);
      report.phases.push({ phase: "owned-rewrite", thread: owned.id, ...viaRewrite });
      report.phases.push({ phase: "owned-direct", thread: owned.id, ...direct });
    }
  }
  if (shared) {
    for (let i = 0; i < runs; i++) {
      const r = await streamProbe(
        `${FRONT}/api/ops/threads/${encodeURIComponent(shared.id)}/stream`,
        headers,
      );
      rows.push(streamRow(`shared via proxy${runs > 1 ? ` #${i + 1}` : ""}`, r));
      report.phases.push({ phase: "shared-proxy", thread: shared.id, ...r });
    }
  }

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
      `\n  stop: terminal = session.completed/failed · park-quiet = client quiet window\n` +
        `        (${QUIET_AT_BOUNDARY_MS}ms at a park, ${QUIET_MID_REPLAY_MS}ms mid-replay) · eof = server closed ·\n` +
        `        HARD-TIMEOUT = the full ${HARD_TIMEOUT_MS / 1000}s, what the user actually waits\n`,
    );
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

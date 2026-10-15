/**
 * THE BROWSER'S REPLAY READER: re-read a session's stream from the server, in segments, until it is at rest.
 *
 * This was `replaySession` inside app/_components/chat-shell.tsx. It moved here, unchanged in what it does, so the
 * loop that decides when an open has read enough can be EXECUTED by a test over a fake stream with real timing
 * (scripts/test-chat-replay-read.mjs) instead of matched by a regex. The shell keeps a thin wrapper that supplies
 * `fetch`, the sign-in headers and the `window.__threadOpens` record.
 *
 * Why it reads the way it does:
 *
 * A thread that was persisted MID-STREAM (its turn still generating, so no boundary event and no continuation token
 * yet) is resumed at the server's authoritative state: the full event list plus the freshest resume token.
 * `advanceSession` in the eve client only mints a token at a turn boundary (`session.waiting`).
 *
 * It reads until the live turn PARKS: a boundary event (waiting/completed/failed) followed by a quiet gap. A boundary
 * that is immediately followed by more events is a PRIOR turn's park inside the replayed history, so it must not stop
 * on the first boundary (that would truncate a multi-turn thread); only silence after a boundary means the live turn
 * parked.
 *
 * SILENCE IS THE ONLY END-OF-REPLAY SIGNAL on the direct path. eve's session stream is a live tail over the durable
 * workflow run: it replays the stored events and then, for any run that has not TERMINATED, holds the connection open
 * forever with no heartbeat. Only `session.completed` / `session.failed` end the body. The marker routes
 * (`/api/ops/chat-replay`, the shared-thread proxy) answer the question server-side instead
 * (lib/chat-replay-stream.ts); the quiet windows here remain for the fallback, and for a marker that says the stream
 * was cut rather than drained.
 *
 * Stopping early can only ever drop a SUFFIX, never reorder: the reducer projects a prefix, which is a consistent
 * earlier state of the same thread.
 *
 * No React, no DOM at module scope: node runs it in the tests with a stubbed `fetch`.
 */
import { turnUnfinished, type TurnEvent } from "./chat-turn-state.ts";
import { parseServerTiming } from "./server-timing.ts";

/**
 * What a replay hands back.
 *
 * `events` are only the events AFTER the requested start index when one was
 * given — a TAIL, not the whole transcript — and `index` is where the stream now
 * is, absolutely. The two are deliberately independent: a cached transcript is
 * compacted, so it holds fewer lines than the stream position it represents.
 */
export interface ReplayResult {
  events: unknown[];
  continuationToken?: string;
  index?: number;
  /**
   * WHY the read stopped — because a tail that read nothing is ambiguous
   * without it. The stream saying "there is nothing after that index" is a fact
   * about the conversation; a read that timed out is a fact about the network.
   * They lead to opposite decisions about a cached transcript.
   */
  stop?: string;
  /**
   * The UPSTREAM closed the response (the server's marker said so, or a direct
   * read reached a real end of body), as opposed to a read that stopped on
   * silence. A tail read that ended with nothing in it is the one empty read
   * that is evidence about a cached transcript (lib/chat-snapshot.ts
   * `seamVerdict`).
   */
  ended?: boolean;
}

export type ReplayStop =
  | "marker"
  | "terminal"
  | "park-quiet"
  | "quiet"
  | "eof"
  | "timeout"
  | "segment-cap"
  // The request was refused or failed: the read learned nothing.
  | "error"
  // A later open took over (lib/chat-open-guard.ts).
  | "cancelled"
  /**
   * The read is at the live edge of a RUNNING turn (see {@link liveTurnEdge}): it stopped there on purpose and hands
   * over to the chat's own live reader, which continues from `index`. Never a saved copy: the index is mid-turn.
   */
  | "live";

/**
 * How fresh the newest event must be for a read that ended inside an unfinished turn to be AT THE LIVE EDGE of that
 * turn, rather than stalled somewhere in old history.
 *
 * eve stamps every event with `meta.at` when it writes it. An event written in the last half-minute, in a turn that
 * has not finished, is the running turn itself: nothing newer than it can be a finished turn followed by another, so
 * the live reader that takes over from here reads that same turn to its end. A stall in a history written hours ago
 * has old stamps, and the read keeps going as before.
 */
export const LIVE_EDGE_MS = 30_000;

/**
 * Is a read that just stopped, with these events, at the live edge of a running turn?
 *
 * All of: the transcript ends inside a turn (`turnUnfinished`: a `turn.started` with no terminal after it), and the
 * newest event's `meta.at` is within {@link LIVE_EDGE_MS} of `nowMs` (the server's clock, as the response's `Date`
 * header gives it, so the browser's own clock does not decide). An event with no readable stamp is never live.
 */
export function liveTurnEdge(events: readonly unknown[], nowMs: number): boolean {
  if (!events.length || !Number.isFinite(nowMs)) return false;
  if (!turnUnfinished(events as readonly TurnEvent[])) return false;
  const last = events[events.length - 1] as { meta?: { at?: unknown } } | undefined;
  const at = typeof last?.meta?.at === "string" ? Date.parse(last.meta.at) : NaN;
  if (!Number.isFinite(at)) return false;
  return Math.abs(nowMs - at) <= LIVE_EDGE_MS;
}

/**
 * What one segment's response said about the server's time (lib/server-timing.ts): the `Server-Timing` phases
 * (sign-in, access, eve's headers, total to the response's headers) and, from the end marker, eve's first body chunk
 * and the marker itself, all in ms from the start of the request on the server.
 */
export interface ReplayServerTiming {
  readonly startIndex: number;
  readonly phases: Readonly<Record<string, number>>;
  readonly firstByte: number | null;
  readonly marker: number | null;
}

/** One read's own record, kept on the window by the shell (`window.__threadOpens`). */
export interface ReplayReadRecord {
  ms: number;
  /** What the open spent waiting for silence rather than reading. */
  quietMs: number;
  stopReason: ReplayStop;
  segments: number;
  events: number;
  startIndex: number;
  shared: boolean;
  sessionId: string;
  ended: boolean;
  at: string;
}

export interface ReplayReadInput {
  readonly sessionId: string;
  /**
   * For a SHARED thread, read through the membership-checked proxy so revoke
   * actually cuts access (the eve stream only domain-gates reads).
   */
  readonly viaThreadId?: string;
  /**
   * A TAIL read: start at this ABSOLUTE event index instead of at zero, and
   * return only what comes after it.
   *
   * This is what makes a reopen cost the size of what is NEW. The transcript
   * up to `startIndex` came from the cache (lib/chat-snapshot.ts) and is
   * already on screen; everything here is the part the cache cannot know
   * about. `parked` says the caller holds a live resume token, which lets
   * the server use its SHORT drain window — a tail read of a parked session
   * replays nothing, so the marker logic would otherwise wait out the long
   * "the turn may still be thinking" window for a session that is by
   * definition silent.
   */
  readonly tail?: { readonly startIndex: number; readonly parked?: boolean };
  /**
   * The open this read belongs to. When a later click takes over
   * (lib/chat-open-guard.ts) the read is cancelled, so an abandoned open
   * stops costing bandwidth and its stop reads "cancelled", never "timeout".
   */
  readonly signal?: AbortSignal;
  readonly headers: () => Record<string, string>;
  /** `fetch`, injected so a test can serve the stream. Defaults to the global one. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Called once per segment that got a response, with what the server said about its own time. Never throws out. */
  readonly onServerTiming?: (timing: ReplayServerTiming) => void;
}

/** Read a session's history. Returns the result (null when a full replay learned nothing) and the read's record. */
export async function readReplay(input: ReplayReadInput): Promise<{ result: ReplayResult | null; record: ReplayReadRecord }> {
  const { sessionId, viaThreadId, tail } = input;
  const doFetch = input.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const base = Math.max(0, Math.floor(tail?.startIndex ?? 0));
  const events: unknown[] = [];
  let continuationToken: string | undefined;
  /**
   * `stopReason` is the value that matters. It separates "the stream was
   * slow" from "the stream never ended and we sat through our own
   * deadline", which cannot be read off the source because it depends on
   * the thread's runtime state.
   *
   * `quietMs` is the second number that matters: it is the time spent waiting
   * out a quiet window rather than reading bytes — latency this client CHOSE,
   * not latency the server imposed.
   */
  const startedAt = performance.now();
  let quietMs = 0;
  let stopReason: ReplayStop = "eof";
  /** The upstream itself closed (see ReplayResult.ended). */
  let upstreamEnded = false;

  const bounded = Boolean(viaThreadId);
  /**
   * REPLAY IS SEGMENTED, because the stream is.
   *
   * This used to be a single open with a 15s cap. But a stream is severed
   * on a hard ~120s boundary and simply ends — no terminal event, a clean
   * EOF mid-turn. Live streaming survives that because eve's reader reopens
   * at the advanced index; replay did not, so re-opening a long thread
   * mounted a transcript that stopped in the middle of a turn.
   *
   * So: keep reopening at the absolute index until the session is genuinely
   * at rest (a terminal, a DRAINED end marker, or a park with nothing
   * following), a segment yields nothing new, or the whole open runs out of
   * budget. `cursor` is an absolute event count and `events` holds only real
   * events — the `ops.replay.end` marker is never pushed — so `base +
   * events.length` is exactly where to resume from when the server does not
   * say.
   */
  const deadline = startedAt + (bounded ? 12_000 : 60_000);
  const MAX_SEGMENTS = 12;
  let finished = false; // a terminal session.completed/failed — mount NOW
  // Tracked separately from stopReason: it is set inside a closure, and
  // narrowing cannot see across one.
  let sawMarker = false;
  // True when the LAST event read was a turn/session park — not sticky, so a
  // park buried in replayed history goes back to the long window as soon as
  // the next event arrives, instead of leaving the rest of a multi-turn
  // replay exposed to a 300ms cut.
  let atBoundary = false;
  /**
   * Has the OWNED path's marker route answered at least once?
   *
   * `/api/ops/chat-replay` is newer than the deployments that read from it,
   * and a browser tab lives for days. If it is not there (or the workspace
   * lookup behind it is down) this falls back to reading eve directly — the
   * exact code path that shipped before, quiet windows and all. A thread
   * that opens slowly is a bad day; a thread that will not open is an
   * outage.
   */
  let markerRouteOk = true;

  /**
   * The server's clock, from the last response's `Date` header plus the time since it arrived (a second's resolution
   * is plenty against {@link LIVE_EDGE_MS}); this browser's clock when no response carried one.
   */
  let dateAt: { readonly ms: number; readonly perf: number } | null = null;
  const serverNow = () => (dateAt ? dateAt.ms + (performance.now() - dateAt.perf) : Date.now());

  /**
   * What one open did. `lines` counts every line it read but the marker, the ones this client could not parse
   * included, because the server's index counts them too; `markerIndex` is the index the server's marker gave, for
   * THIS segment only (a marker from an earlier segment must never stand in for where a later one ended).
   */
  interface Segment {
    got: number;
    lines: number;
    markerIndex: number | undefined;
    endedBy: "quiet" | "timeout" | "upstream" | "marker" | "terminal" | "error" | "cancelled";
  }

  /** One open. */
  const readSegment = async (startIndex: number): Promise<Segment> => {
    const outer = input.signal;
    const seg: Segment = { got: 0, lines: 0, markerIndex: undefined, endedBy: "upstream" };
    if (outer?.aborted) {
      stopReason = "cancelled";
      seg.endedBy = "cancelled";
      return seg;
    }
    const ctrl = new AbortController();
    const hardTimer = setTimeout(() => ctrl.abort(), bounded ? 8_000 : 15_000);
    const cancel = () => ctrl.abort();
    outer?.addEventListener("abort", cancel);
    let sawAnyEvent = false;
    let headers: Headers | null = null;
    let markerTiming: { firstByte: number | null; ms: number | null } = { firstByte: null, ms: null };
    const url = viaThreadId
      ? `/api/ops/threads/${encodeURIComponent(viaThreadId)}/stream?replay=1&replayOnly=1${
          // The proxy has always accepted and forwarded a startIndex; with the
          // transcript cached, a shared open can read its tail too.
          startIndex > 0 ? `&startIndex=${startIndex}` : ""
        }`
      : markerRouteOk
        ? `/api/ops/chat-replay?session=${encodeURIComponent(sessionId)}&startIndex=${startIndex}${
            tail?.parked ? "&parked=1" : ""
          }`
        : `/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=${startIndex}`;
    try {
      let res = await doFetch(url, { headers: input.headers(), signal: ctrl.signal });
      if (!res.ok && !viaThreadId && markerRouteOk) {
        // Not there, or not answering. Take the old road for the rest of
        // this open rather than failing it.
        markerRouteOk = false;
        res = await doFetch(`/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=${startIndex}`, {
          headers: input.headers(),
          signal: ctrl.signal,
        });
      }
      if (!res.ok || !res.body) {
        stopReason = "error";
        seg.endedBy = "error";
        return seg;
      }
      headers = res.headers;
      const date = Date.parse(res.headers.get("date") ?? "");
      if (Number.isFinite(date)) dateAt = { ms: date, perf: performance.now() };
      /**
       * Is this answer from a route that injects the end marker? Then the
       * server decides when the backlog is drained, including how long to
       * wait for the first byte (lib/chat-replay-stream.ts), and this
       * client must not race it with a shorter window of its own: its
       * 1,200 ms pre-first-byte window fired first on every seam read the
       * server was still waiting on, and an empty seam read was what got
       * a healthy saved copy deleted. The direct /eve fallback has no
       * marker, so it keeps the window.
       */
      const markerRoute = Boolean(viaThreadId) || markerRouteOk;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        if (finished) break; // finished sessions never emit more — no wait
        const read = reader.read();
        // At a park, a gap means the live turn has parked: stop soon (a
        // lagging token may still arrive, but the open must not block on
        // it). Mid-replay, a gap is more likely a slow server than the end,
        // so wait much longer. Before the first byte, don't race at all:
        // that is time-to-first-byte, and only the hard timeout bounds it.
        // A TAIL read is EXPECTED to be empty — a parked thread that nobody
        // has touched has nothing after its last event, and eve holds the
        // connection open anyway. Here, silence IS the answer, so it only has
        // to be long enough to outlast a slow first flush.
        //
        // On a marker route the park's own window is the SERVER's too (400 ms, lib/chat-replay-stream.ts), for the
        // reason the pre-first-byte window is: a shorter window here raced the server's answer and won, so the read
        // ended without the marker (its index and its timing) and, after a park deep in a history followed by a 300 ms
        // pause in eve's store read, ended the history early. The server now judges that pause by the line that came
        // last; this client waits for its marker, keeping 1,500 ms only as the fallback if the marker never comes.
        const quietWindow = atBoundary && !markerRoute ? 300 : sawAnyEvent ? 1_500 : tail && !markerRoute ? 1_200 : 0;
        const waitedFrom = performance.now();
        // A read that REJECTS (the connection dropped) is marked, so it is never mistaken for the upstream
        // closing the stream, which is evidence about a saved copy; a dropped connection is not.
        const failedRead = { done: true as const, value: undefined, failed: true as const };
        const r = quietWindow
          ? await Promise.race([
              read.catch(() => failedRead),
              new Promise<{ done: true; value: undefined; quiet: true }>((resolve) =>
                setTimeout(() => resolve({ done: true, value: undefined, quiet: true }), quietWindow),
              ),
            ])
          : await read.catch(() => failedRead);
        // Only a window that WON the race cost anything; the rest of the
        // time the read came back first and the timer was free.
        if ((r as { quiet?: true }).quiet) quietMs += performance.now() - waitedFrom;
        if (r.done) {
          // A real end of body (not our own quiet window, not an abort): the upstream closed.
          if ((r as { failed?: true }).failed) {
            if (!ctrl.signal.aborted) {
              stopReason = "error";
              seg.endedBy = "error";
            }
          } else if ((r as { quiet?: true }).quiet) {
            seg.endedBy = "quiet";
          } else if (!ctrl.signal.aborted) {
            upstreamEnded = true;
            seg.endedBy = "upstream";
          }
          break;
        }
        buf += dec.decode(r.value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) {
          if (!l.trim()) continue;
          try {
            const ev = JSON.parse(l) as {
              type?: string;
              data?: {
                continuationToken?: string;
                index?: number;
                drained?: boolean;
                timing?: { firstByte?: unknown; ms?: unknown };
              };
            };
            // The marker is bookkeeping, not conversation — it must never
            // reach the reducer. `drained: false` means the marker was
            // emitted because the UPSTREAM ENDED, not because the backlog
            // ran dry: that is the ~120s severance, and treating it as the
            // end of history is exactly how a long thread used to mount
            // stopping mid-turn. Take the index and reopen there.
            if (ev.type === "ops.replay.end") {
              seg.markerIndex = typeof ev.data?.index === "number" ? ev.data.index : undefined;
              sawMarker = true;
              const t = ev.data?.timing;
              if (t) {
                markerTiming = {
                  firstByte: typeof t.firstByte === "number" ? t.firstByte : null,
                  ms: typeof t.ms === "number" ? t.ms : null,
                };
              }
              if (ev.data?.drained !== false) {
                stopReason = "marker";
                seg.endedBy = "marker";
                finished = true;
              } else {
                upstreamEnded = true;
                seg.endedBy = "upstream";
              }
              continue;
            }
            seg.lines++;
            events.push(ev);
            seg.got++;
            sawAnyEvent = true;
            if (ev.type === "session.waiting" && typeof ev.data?.continuationToken === "string" && ev.data.continuationToken) {
              continuationToken = ev.data.continuationToken;
            }
            if (ev.type === "session.completed" || ev.type === "session.failed") {
              finished = true; // no stragglers — break right after this chunk
              seg.endedBy = "terminal";
            } else {
              // `turn.completed`/`turn.failed` count as a park too: eve
              // writes them as a SEPARATE event just before
              // `session.waiting`, so a run that died between the two still
              // reads as at-rest here rather than falling through to the
              // long window.
              atBoundary = ev.type === "session.waiting" || ev.type === "turn.completed" || ev.type === "turn.failed";
            }
          } catch {
            /* skip malformed line, but count it: the server's index does */
            seg.lines++;
          }
        }
      }
    } catch {
      /* fall back to whatever we collected */
      if (!ctrl.signal.aborted) {
        stopReason = "error";
        seg.endedBy = "error";
      }
    } finally {
      clearTimeout(hardTimer);
      outer?.removeEventListener("abort", cancel);
      if (ctrl.signal.aborted) {
        stopReason = outer?.aborted ? "cancelled" : "timeout";
        seg.endedBy = outer?.aborted ? "cancelled" : "timeout";
      }
      ctrl.abort();
      if (headers && input.onServerTiming) {
        try {
          input.onServerTiming({
            startIndex,
            phases: parseServerTiming(headers.get("server-timing")),
            firstByte: markerTiming.firstByte,
            marker: markerTiming.ms,
          });
        } catch {
          /* a recorder never breaks a read */
        }
      }
    }
    return seg;
  };

  let segments = 0;
  let cursor = base;
  for (;;) {
    segments += 1;
    const segStart = cursor;
    const seg = await readSegment(segStart);
    if (input.signal?.aborted) {
      stopReason = "cancelled";
      break;
    }
    // Prefer the server's own count for THIS segment: it saw every line. Without a marker, every line this segment
    // read (parsed or not) is one index on from where it started.
    cursor = seg.markerIndex ?? segStart + seg.lines;
    // At rest: a terminal, a drained marker, or a park with nothing after
    // it. Done.
    if (finished || atBoundary) {
      // The marker is the strongest signal we have; never downgrade it.
      stopReason = finished ? (sawMarker ? "marker" : "terminal") : "park-quiet";
      break;
    }
    /**
     * AT THE LIVE EDGE OF A RUNNING TURN: stop, and let the chat's live reader carry on from `cursor`.
     *
     * A chat opened while its reply is still being written used to be read by this loop until the reply fell
     * silent: every segment that brought events and ended on the quiet window (or the 15 s cap) without a marker
     * was reopened, to the 60 s deadline and past it, about 75 s, behind the loading shimmer. Waiting buys nothing:
     * the transcript is a prefix the moment the read stops either way, and the mounted chat's own reader (agent-chat
     * `attachDecision`: "live-turn") reads the turn from the absolute index the mount carries.
     *
     * So when a segment brought events, ended on silence or its cap with no marker and no end of body, and the
     * transcript ends inside a turn whose newest event is fresh ({@link liveTurnEdge}), the read stops here with
     * "live". The fetch is already aborted (the segment's `finally`), so the two readers never overlap. A stall in
     * OLD history is not live (its stamps are old) and the loop goes on as before; the ~120 s severance (marker
     * `drained: false`, or the body ending) still reopens. Never stored as a saved copy: the index is mid-turn.
     */
    if (
      seg.got > 0 &&
      seg.markerIndex === undefined &&
      (seg.endedBy === "quiet" || seg.endedBy === "timeout") &&
      liveTurnEdge(events, serverNow())
    ) {
      stopReason = "live";
      break;
    }
    // Nothing new — there is no more history to read, so reopening again
    // would just spin.
    if (seg.got === 0) break;
    // The shared-thread proxy replays the whole backlog and injects its own
    // end marker; it has no startIndex to resume from.
    if (bounded) break;
    if (performance.now() > deadline) {
      stopReason = "timeout";
      break;
    }
    if (segments >= MAX_SEGMENTS) {
      stopReason = "segment-cap";
      break;
    }
    // Fell out mid-turn — the 120s severance. Reopen where we stopped.
  }

  const record: ReplayReadRecord = {
    ms: Math.round(performance.now() - startedAt),
    quietMs: Math.round(quietMs),
    stopReason,
    segments,
    events: events.length,
    startIndex: base,
    shared: bounded,
    sessionId,
    ended: upstreamEnded,
    at: new Date().toISOString(),
  };

  /**
   * A TAIL that read nothing is a RESULT, not a failure.
   *
   * The full-replay contract is "null means we learned nothing", because an
   * empty replay of a whole session means the read failed. A tail of a
   * parked session legitimately returns zero events — that is the normal,
   * happy answer — so it must be distinguishable from a read that fell over.
   * `index` carries the answer either way.
   */
  if (!events.length && !tail) return { result: null, record };
  return {
    result: {
      events,
      continuationToken,
      index: cursor,
      stop: stopReason,
      ended: upstreamEnded,
    },
    record,
  };
}

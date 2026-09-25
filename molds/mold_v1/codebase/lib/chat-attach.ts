/**
 * READING A LIVE eve STREAM THE APP IS NOT SENDING ON.
 *
 * The mechanism half of the reattach; `attachDecision` in lib/chat-turn-state.ts
 * is the decision half. Kept out of the component and free of React so a test
 * can drive the real loop over a fake severing stream
 * (scripts/test-chat-reattach.mjs) rather than grepping the source for it.
 *
 * THE SEAM IS NOT REMOVABLE, SO IT HAS TO BE SURVIVED. Every stream segment ends
 * on a hard ~120s boundary regardless of health (measured at 121/241/362/482/
 * 602/723s). eve builds its own functions at `maxDuration: "max"` and the web
 * proxy in app/eve/v1/session/[...segments]/route.ts is already at 800, so no
 * configuration change deletes the seam. Reopening at the advanced absolute
 * index is the whole mechanism — it is what eve's send-path reader does, and the
 * only reason live streaming ever survived 120 seconds.
 *
 * AND `ClientSession.stream()` DOES NOT DO IT ON ITS OWN. Read
 * node_modules/eve/dist/src/client/open-stream.js: `openStreamIterable` reopens
 * only when the body throws a DISCONNECT error. A segment that ends CLEANLY —
 * which is exactly how the 120s severance presents, and why eve's own send-path
 * reader loops `for(;;)` on a clean EOF — returns from the iterable and the
 * stream is over. So the reopen loop lives here, around `ClientSession.stream`,
 * and eve's `maxReconnectAttempts` handles the socket-level case underneath it.
 *
 * EVERY REOPEN COSTS A DATABASE READ. The ownership gate in front of the agent's
 * session routes runs `permitted()` — two to three workspace-scoped queries — on
 * every single request, reconnects included, and it FAILS OPEN on a database
 * error. So: never a tight retry (a cold database makes one reopen slow while
 * the turn is perfectly healthy), always a backoff, and a transient failure is
 * retried rather than treated as the end of the reply.
 *
 * 403 IS THE ONE EXCEPTION. On the membership-checked proxy a 403 means the
 * share was REVOKED, which is the thing that makes revoke real. Retrying that
 * would be both useless and a small denial-of-service against our own gate, so
 * it stops immediately and says so.
 *
 * 401 IS NOT THE SAME THING, and treating it as one was wrong. 403 is
 * "revoked — never retry"; 401 is "your credential is stale". The session token
 * this app holds lives about an hour and auth-gate.tsx drops it 60 SECONDS
 * BEFORE `exp`, after which `getAuthHeaders()` returns `{}` and every request
 * 401s — so a turn long enough to cross that boundary meets a 401 as a matter of
 * course. Spending the whole attach budget on it, and then telling the person
 * "still working", hides the one thing that would fix it: sign in again. It gets
 * its own outcome, and the caller says so in words.
 */
import { Client } from "eve/client";
// The `.ts` extension is deliberate (`allowImportingTsExtensions`, as
// lib/mcp-server.ts already does): scripts/test-chat-reattach.mjs loads this
// module through `node --experimental-strip-types`, which resolves relative
// specifiers the way ESM does and will not guess an extension.
import { isSessionBoundary, type IndexedEvent, type TurnEvent } from "./chat-turn-state.ts";

/** How a reader ended. Only `terminal` means the reply is on screen in full. */
export type AttachOutcome =
  /** A session boundary arrived: the turn is over and its resume token is in hand. */
  | "terminal"
  /** The component, the session or the store took the stream away. Normal. */
  | "aborted"
  /** Access is GONE (403): the share was revoked. Never retried, never forgiven. */
  | "forbidden"
  /**
   * The credential is STALE (401): the hour-long session token expired under a
   * long turn (auth-gate drops it 60s before `exp`). Not a verdict about the
   * turn and not a revoked share — the reader stops, and the person is told to
   * sign in again rather than left reading "still working".
   */
  | "unauthorized"
  /** Repeated failures to open or read. The resync/replay watcher takes over. */
  | "stream-failed"
  /** The segment budget ran out. A turn this long is a bug worth a record. */
  | "exhausted";

export interface AttachResult {
  readonly outcome: AttachOutcome;
  /** The absolute index the next reader should start from. */
  readonly index: number;
  /** How many events this reader delivered. */
  readonly events: number;
  /** How many segments it opened — one per ~120s seam, plus any retries. */
  readonly segments: number;
  /** Why it stopped, when that was a failure. */
  readonly detail?: string;
}

/** Opens one segment of a session's event stream from an absolute index. */
export type StreamOpener = (startIndex: number, signal: AbortSignal) => AsyncIterable<TurnEvent>;

/** An HTTP status carried out of a failed open, so 403 can stop the loop. */
export class StreamOpenError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StreamOpenError";
    this.status = status;
  }
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ReadLiveTailInput {
  readonly open: StreamOpener;
  /** Absolute index to resume from — see `serverEventCount`. */
  readonly startIndex: number;
  readonly signal: AbortSignal;
  /** Called once per event, in index order, strictly increasing. */
  readonly onEvent: (entry: IndexedEvent) => void;
  /**
   * Segments before giving up. 200 is the same ceiling the store's
   * `maxReconnectAttempts` was raised to: at ~120s each that is six hours, a
   * length no real turn reaches, and low enough to bound a wedged loop.
   */
  readonly maxSegments?: number;
  /** Consecutive fruitless segments before handing back to the poll. */
  readonly maxFailures?: number;
  /**
   * The FLOOR between two opens, however productive the last one was.
   *
   * Measured on today's code: an opener that yields one event and then ends
   * produced **200 opens in 3 ms**, because `got > 0` skipped the backoff
   * entirely — and with the epoch re-arm allowing four readers per turn, 800.
   * Every one of those opens runs the session proxy's ownership gate, which is
   * two to three workspace-scoped queries; this is precisely the shape that
   * turns a slow database into a storm against ourselves. 250 ms is invisible
   * beside the ~120s seam this loop actually exists for, and it turns those 200
   * opens into at least 50 seconds.
   */
  readonly minSegmentGapMs?: number;
  /**
   * How long a segment may produce NOTHING before it is abandoned and reopened.
   *
   * `for await (const event of input.open(...))` has no timeout of its own: a
   * proxy that holds the connection open without sending, or a black-holed
   * socket, hangs the reader forever — and while it hangs, `attachLive` is true,
   * so the detached-turn watcher stands down and NOTHING recovers the turn:
   * reader hung, poll disabled, nothing on screen. The poll's own `readTail`
   * already aborts at 8s; this is the same precedent with a much longer fuse.
   *
   * 150s, ABOVE the seam and not below it. Every segment ends on a hard ~120s
   * boundary regardless of health (measured at 121/241/362/482/602/723s), so a
   * segment still open and silent at 150s is not a live segment, it is a hang —
   * which is what lets this cut one without ever cutting a healthy turn that is
   * legitimately quiet through one long tool call. A segment cut here reopens at
   * the index it had; one that was silent from the start also counts as
   * fruitless, so a dead connection still reaches the poll via `maxFailures`.
   */
  readonly idleTimeoutMs?: number;
  /** Injected in tests so a backoff does not make the suite wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Read a session's live tail from `startIndex` until the turn ends.
 *
 * The index is counted here, one per event, exactly as `openStreamIterable`
 * counts it internally — eve does not put the absolute index on the event, and
 * the dedupe in `mergeAttachedEvents` is defined against it, so the two have to
 * agree. Starting a segment at N means the first event it yields IS N.
 */
export async function readLiveTail(input: ReadLiveTailInput): Promise<AttachResult> {
  const maxSegments = input.maxSegments ?? 200;
  const maxFailures = input.maxFailures ?? 4;
  const minGap = input.minSegmentGapMs ?? 250;
  const idleTimeout = input.idleTimeoutMs ?? 150_000;
  const sleep = input.sleep ?? defaultSleep;
  let index = input.startIndex;
  let events = 0;
  let segments = 0;
  /** Consecutive segments that delivered nothing — an open that fails, or ends empty. */
  let fruitless = 0;
  let detail: string | undefined;

  const done = (outcome: AttachOutcome): AttachResult => ({
    outcome,
    index,
    events,
    segments,
    detail,
  });

  while (!input.signal.aborted && segments < maxSegments) {
    segments += 1;
    let got = 0;
    const openedAt = Date.now();
    /**
     * The watchdog's own signal, aborted either by the caller or by silence.
     *
     * A segment gets its own controller so that cutting a hung one does not
     * tear down the whole reader: the loop reopens at the index it had, which
     * is the same motion the ~120s seam already performs.
     */
    const segment = new AbortController();
    const relay = () => segment.abort();
    input.signal.addEventListener("abort", relay, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const arm = () => {
      if (idle) clearTimeout(idle);
      if (!Number.isFinite(idleTimeout) || idleTimeout <= 0) return;
      idle = setTimeout(() => {
        timedOut = true;
        segment.abort();
      }, idleTimeout);
      // Never hold a Node process open for a watchdog (the offline tests run
      // this loop to completion and then exit).
      (idle as unknown as { unref?: () => void }).unref?.();
    };
    try {
      arm();
      for await (const event of input.open(index, segment.signal)) {
        if (input.signal.aborted) break;
        arm();
        input.onEvent({ index, event });
        index += 1;
        got += 1;
        events += 1;
        // Stop at the SESSION boundary rather than the turn's own terminal: the
        // `session.waiting` that follows carries the fresh continuation token,
        // and without it the next message cannot resume this session and opens
        // an empty new one whose turn_0 writes over this transcript's first
        // exchange (see withSessionEpochs).
        if (isSessionBoundary(event)) return done("terminal");
      }
    } catch (err) {
      if (input.signal.aborted) return done("aborted");
      const status = statusOf(err);
      if (status === 403) {
        // The share was REVOKED. Retrying cannot help and the gate is a database
        // read; stop, and never forgive it on a tab return either.
        detail = "access 403";
        return done("forbidden");
      }
      if (status === 401) {
        // The credential went stale mid-turn — auth-gate drops the hour-long
        // token 60s before `exp` and `getAuthHeaders()` then returns `{}`. Not
        // the turn's fault and not a revoked share: stop and say "sign in
        // again", because nothing else the reader can do will fix it.
        detail = "access 401";
        return done("unauthorized");
      }
      // Anything else is transient by assumption: the ownership gate fails open
      // on a database error but can still be SLOW enough to time out, and a
      // severed body mid-read is the normal 120s seam. Reopen at the advanced
      // index — the events already delivered stay delivered.
      detail = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
    } finally {
      if (idle) clearTimeout(idle);
      input.signal.removeEventListener("abort", relay);
    }
    if (input.signal.aborted) return done("aborted");
    if (timedOut) {
      // Silence, not an ending. A segment that delivered nothing at all is
      // counted as fruitless, so a black-holed socket still reaches
      // `stream-failed` and the poll instead of holding `attachLive` true
      // forever with the detached-turn watcher stood down. One that delivered
      // events first made real progress and simply reopens.
      detail = `segment silent for ${idleTimeout}ms`;
    }
    /**
     * THE FLOOR BETWEEN OPENS — the one guard that bounds a self-inflicted
     * storm.
     *
     * `got > 0 → reopen immediately` made the backoff below reachable only by a
     * segment that delivered nothing at all, so a stream that yields one event
     * and ends reopened as fast as the event loop allowed: measured at 200 opens
     * in 3 ms on today's code, and the epoch re-arm turns that into 800. Each
     * open runs the ownership gate's two or three workspace-scoped queries, so
     * the tight loop is exactly what converts a slow database into an outage.
     * 250 ms is nothing against the ~120s seam this loop exists for, and it is
     * charged from the moment the segment OPENED, so an honest 120-second
     * segment never waits at all.
     */
    if (got > 0) {
      // A productive segment, however it ended. This is the 120s seam, and the
      // gap between segments is dead air on the reader's screen — so pay only
      // what is left of the floor, which for a real segment is zero.
      fruitless = 0;
      const left = minGap - (Date.now() - openedAt);
      if (left > 0) await sleep(left);
      continue;
    }
    fruitless += 1;
    if (fruitless >= maxFailures) {
      detail ??= "stream opened but delivered nothing";
      return done("stream-failed");
    }
    // 0.5s, 1s, 2s — bounded, because every reopen is an ownership-gated
    // database read and a cold one is slow, not broken.
    await sleep(Math.max(minGap, Math.min(500 * 2 ** (fruitless - 1), 4_000)));
  }
  return done(input.signal.aborted ? "aborted" : "exhausted");
}

/**
 * The OWNED path: eve's own `ClientSession.stream`, through the Next rewrite.
 *
 * `host: ""` makes the client build a relative `/eve/v1/session/:id/stream`,
 * which is the same origin and the same ownership-gated route the eve store
 * already streams through (app/eve/v1/session/[...segments]/route.ts), with the
 * same `getAuthHeaders()`.
 *
 * A FRESH handle per segment, deliberately. `ClientSession.stream` runs
 * `advanceSession` in its `finally` (client/session.js), which RESETS the whole
 * cursor — session id included — whenever the segment ends without a
 * `session.waiting`. That is the same reset that strands a detached turn in the
 * first place; a reused handle would throw "Session has no session ID" on the
 * second segment. Building a new one from the id and index we track ourselves
 * also means this reader can never disturb the store's cursor.
 */
export function eveSessionStream(input: {
  readonly sessionId: string;
  readonly headers: () => Record<string, string>;
  readonly host?: string;
  readonly maxReconnectAttempts?: number;
}): StreamOpener {
  return (startIndex, signal) =>
    new Client({
      host: input.host ?? "",
      headers: input.headers,
      maxReconnectAttempts: input.maxReconnectAttempts ?? 3,
    })
      .session({ sessionId: input.sessionId, streamIndex: startIndex })
      .stream({ startIndex, signal }) as AsyncIterable<TurnEvent>;
}

/**
 * The SHARED path: the membership-checked proxy, read as raw NDJSON.
 *
 * `ClientSession` cannot be pointed here — it builds `/eve/v1/session/:id/stream`
 * from a SESSION id, while this route is keyed by THREAD id and exists precisely
 * so that the check happens before the session is named. Routing a shared
 * thread's live tail through it is what keeps revoke real: eve's own stream
 * route domain-gates reads but does not check membership, so a revoked member
 * reading the session directly would keep receiving the conversation. Here they
 * get a 403 and the reader stops.
 *
 * The protocol is identical — `?startIndex=N`, one JSON event per line, no
 * `replay=1` so the marker is not injected and the response stays open as a live
 * tail — so the index arithmetic and the dedupe are the same on both paths.
 */
export function threadProxyStream(input: {
  readonly threadId: string;
  readonly headers: () => Record<string, string>;
}): StreamOpener {
  return async function* (startIndex, signal) {
    const res = await fetch(
      `/api/ops/threads/${encodeURIComponent(input.threadId)}/stream?startIndex=${startIndex}`,
      { headers: input.headers(), signal },
    );
    if (!res.ok || !res.body) {
      throw new StreamOpenError(res.status, `thread stream ${res.status}`);
    }
    yield* readNdjson(res.body, signal);
  };
}

/** One JSON event per line, tolerating a chunk boundary anywhere. */
export async function* readNdjson(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<TurnEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: TurnEvent;
        try {
          parsed = JSON.parse(line) as TurnEvent;
        } catch {
          // A malformed line would desynchronise the index for everything after
          // it, so it is not skipped quietly — it ends the segment and the loop
          // reopens at the index we know is good.
          throw new Error("malformed NDJSON line");
        }
        // Bookkeeping the proxy injects for replay callers, never conversation.
        // It has no stream index, so counting it would shift every later one.
        if (parsed?.type === "ops.replay.end") continue;
        yield parsed;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

/**
 * HAS THE STREAM MOVED PAST WHAT THIS TAB SHOWS?
 *
 * Opens the session's stream at the tab's own absolute index and waits a
 * moment: anything at all arriving means another tab (or device) has moved the
 * chat on, and a Stop aimed from this view would be aimed at a turn that is no
 * longer the one on screen. Used to REFUSE and refresh instead.
 */
export async function streamHasMoved(open: StreamOpener, startIndex: number, windowMs = 1200): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), windowMs);
  try {
    for await (const _event of open(startIndex, ctrl.signal)) {
      void _event;
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/**
 * The session's LAST event (`startIndex=-1`, eve's "reconnect and rewind"), or
 * null when it cannot be read in time. A session boundary there means nothing
 * is running server-side.
 */
export async function readTailEvent(input: {
  readonly sessionId: string;
  readonly headers: () => Record<string, string>;
  readonly timeoutMs?: number;
}): Promise<TurnEvent | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? 4_000);
  try {
    const res = await fetch(`/eve/v1/session/${encodeURIComponent(input.sessionId)}/stream?startIndex=-1`, {
      headers: input.headers(),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) return null;
    for await (const event of readNdjson(res.body, ctrl.signal)) return event;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/**
 * ONE RECORD PER CHAT OPEN: where the time went, measured in the browser that waited.
 *
 * Every figure about reopening a chat came from a server (repeated reads from a datacentre, warm functions) or was
 * derived from code; no browser had ever timed one. This module is the instrument: `openChat` (app/_components/
 * chat-shell.tsx) starts a record at the top of every click, and the record collects, without changing what the open
 * does:
 *
 *   - which ROUTE the open took: `local` (this browser's cache, no request), `snapshot` (the saved copy, then a seam
 *     read), `snapshot-discarded` (the stream disagreed with the saved copy), `full-replay` (no saved copy),
 *     `running` (a turn was still in flight);
 *   - the time to read the saved copy and the seam, and what the seam said;
 *   - paint (click to the first commit with messages on screen) and composer-ready (the first moment after paint the
 *     composer exists, is enabled, and the main thread has turned over to run a task, so a keystroke would land);
 *   - every MOUNT of the chat for this open, including the remounts that `resync` and `reattach` cause later;
 *   - whether the loading shimmer came back over a painted chat, and what happened to the saved-copy write;
 *   - main-thread lag for 30 s after the click (long tasks where the browser reports them, a timer-drift sampler
 *     where it does not);
 *   - what the Control Panel's specialist streams cost in the same window (see {@link specialistStream}).
 *
 * The record is kept on the window (`window.__chatOpens`, the last 50) and leaves the browser through the existing
 * fire-and-forget `/api/ops/chat-telemetry` route:
 *
 *   - `thread-open-count`: a counter of EVERY open by route, batched (one row per 20 opens, per 5 minutes, or when
 *     the tab is hidden), so the slow opens have a denominator;
 *   - `thread-open`: one detailed row for an open that took over 2 s, brought the shimmer back, or mounted the chat
 *     more than once.
 *
 * Rows carry numbers only: never message text, titles or tokens. The session id goes in the body's `sessionId`, which
 * the route hashes before it is stored (lib/chat-telemetry.ts `chatSessionTag`).
 *
 * SAFETY. Nothing here may throw into `openChat` or cause a render: every entry point is wrapped, records are plain
 * objects the shell holds in refs, and the only side effects are timers, one observer, and a fire-and-forget POST.
 *
 * No React, no DOM imports at module scope, no `server-only`: scripts/test-chat-open-timing.mjs executes it in node.
 */

/* ---------------------------------------------------------------------------------------------------------------- */
/* The specialist-stream seam (the Control Panel's `useChildFeeds` reports through this; the shell never does).      */
/* ---------------------------------------------------------------------------------------------------------------- */

/** How a specialist's stream read ended, as far as this open saw it. */
export type SpecialistStreamOutcome =
  /** Still reading when the record was closed. */
  | "pending"
  /** Read up to a session boundary (waiting, completed, failed) or caught up and quiet. */
  | "caught-up"
  /** The response body ended. */
  | "ended"
  /** The request failed or answered with an error status. */
  | "failed"
  /** Given up on (no headers in time): the panel shows the specialist as unavailable. */
  | "unavailable"
  /** Cancelled by the reader (the chat unmounted, or another open took over). */
  | "aborted";

/**
 * What one specialist's stream cost during one chat open. The CONTRACT between this module and the Control Panel:
 * `useChildFeeds` (app/_components/cockpit.tsx) fills it through {@link specialistStream}; the open's record carries
 * a list of these (no ids) and their totals.
 */
export interface SpecialistStreamStats {
  /** Requests opened for this specialist's stream since the click (a retry or a resumed segment is one more). */
  readonly requests: number;
  /** Response body bytes read. */
  readonly bytes: number;
  /** Body bytes read in the first 5 s after the click, the window in which the conversation itself is painting. */
  readonly bytesFirst5s: number;
  /** First request to its response headers, ms; null until headers arrive. */
  readonly headersMs: number | null;
  /** First request to the stream settling (any outcome but `pending`), ms; null while it is still reading. */
  readonly settleMs: number | null;
  /** Ms after the CLICK at which the first request started: 0 means at once, a larger number means it was deferred. */
  readonly startedAfterMs: number | null;
  readonly outcome: SpecialistStreamOutcome;
  /** True for a specialist attached because it is running (or selected); false for a finished one read for history. */
  readonly live: boolean;
}

/**
 * The handle `useChildFeeds` holds for one specialist's stream. Every method is safe to call at any time, any number
 * of times, from any code path: it never throws and never renders. Outside an open's 30 s window it does nothing.
 */
export interface SpecialistStreamProbe {
  /** A request for this specialist's stream is about to be sent. */
  request(): void;
  /** Its response headers arrived (call once per request; only the first counts toward `headersMs`). */
  headers(): void;
  /** `n` body bytes were read. */
  bytes(n: number): void;
  /** The read finished, however it finished. The first settle wins; later ones are ignored. */
  settle(outcome: Exclude<SpecialistStreamOutcome, "pending">): void;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* The record                                                                                                        */
/* ---------------------------------------------------------------------------------------------------------------- */

export type ChatOpenRoute = "local" | "snapshot" | "snapshot-discarded" | "full-replay" | "running";

/**
 * What the seam read said, in the words of lib/chat-snapshot.ts `seamVerdict`, plus `none` for an open that read no
 * seam (local, full replay).
 */
export type ChatOpenSeam = "none" | "match" | "ahead" | "mismatch" | "behind" | "empty" | "unknown";

/** Why the chat was mounted (again) during an open. */
export type ChatMountCause = "open" | "seam-tail" | "seam-replace" | "resync" | "reattach" | "other";

/** What happened to the saved-copy write this open asked for. */
export type SavedCopyWrite =
  | "none"
  /** Nothing new to write (the saved copy is already at this position). */
  | "not-needed"
  /** Nothing worth storing (buildSnapshot returned null) or a key that is never stored (shared, automation). */
  | "skipped"
  | "sent"
  | "stored"
  | "refused"
  | "failed";

export interface ChatOpenRecord {
  /** Increments per open in this tab. */
  readonly seq: number;
  readonly at: string;
  /** The stored chat's id (the mount key). Kept on the window only; never posted. */
  readonly chatId: string;
  /** The eve session id, when the chat has one. Posted in the body's `sessionId`, which the route hashes. */
  readonly sessionId?: string;
  /** This open is the page load's own (the chat reopened at boot), so its clock starts at navigation. */
  readonly pageLoad: boolean;
  /** performance.now() at the click: for a page-load open, the time since navigation start. */
  readonly clickAt: number;
  /** What this browser held for the chat at click time. */
  readonly stored: { readonly events: number; readonly token: boolean };
  route: ChatOpenRoute | "pending";
  snapshotMs: number | null;
  snapshotFound: boolean | null;
  tailMs: number | null;
  seam: ChatOpenSeam;
  seamReads: number;
  /** Ms for the full replay this open ran, when it ran one (in the foreground or behind a painted chat). */
  replayMs: number | null;
  replayEvents: number | null;
  /** Click to the first commit with messages on screen and no shimmer over them. */
  paintMs: number | null;
  /** Click to the first turn of the main thread after paint with an enabled composer on screen. */
  composerReadyMs: number | null;
  /**
   * Click to the moment the open SETTLED: what it will show is decided (the local mount, the full replay mounted,
   * the seam verdict acted on, or a replacement handed to the composer to wait for). See {@link whenChatOpenSettled}.
   */
  settledMs: number | null;
  /** Mounts of the chat during this open's window, the first one included. */
  mounts: number;
  mountCauses: ChatMountCause[];
  shimmerReturned: boolean;
  savedCopy: SavedCopyWrite;
  savedCopyStatus: number | null;
  /** Superseded by a later click, or left before it finished. */
  cancelled: boolean;
  /** Main-thread lag over the window. `source` says how it was measured. */
  lag: {
    source: "longtask" | "drift" | "none";
    count: number;
    totalMs: number;
    maxMs: number;
    windowMs: number;
  };
  /** The specialist streams read during the window, in the order they started, without ids. */
  specialists: SpecialistStreamStats[];
  /** Characters this origin holds in localStorage, read once when the record closes (the quota question). */
  storageChars: number | null;
  closed: boolean;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Configuration and module state                                                                                    */
/* ---------------------------------------------------------------------------------------------------------------- */

/** How long after the click the record stays open (lag, remounts, specialist streams). */
export const OPEN_WINDOW_MS = 30_000;
/** An open slower than this (to paint, or to composer-ready) gets its own detailed row. */
export const SLOW_OPEN_MS = 2_000;
/** Counter rows: flush after this many opens, or this long after the first unflushed one. */
export const COUNTER_FLUSH_OPENS = 20;
export const COUNTER_FLUSH_MS = 5 * 60_000;
/** Longest `detail` the rows carry (the route accepts 400). */
export const DETAIL_MAX = 300;

/** A telemetry row, in the route's own shape (app/api/ops/chat-telemetry/route.ts). */
export interface ChatTelemetryRow {
  readonly kind: string;
  readonly sessionId?: string;
  readonly detail?: string;
  readonly elapsedMs?: number;
  readonly attempt?: number;
}

interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface Config {
  post: (row: ChatTelemetryRow, keepalive: boolean) => void;
  clock: Clock;
  /** Read the composer: does an enabled one exist? (The shell passes a DOM query; tests pass a function.) */
  composerReady: (() => boolean) | null;
  /** Start the main-thread lag sampler; returns its stop function, which reports what it saw. */
  lagSampler: (() => () => ChatOpenRecord["lag"]) | null;
  /** Read the localStorage character count. */
  storageChars: (() => number | null) | null;
  /** Keep records on the window. */
  windowStore: boolean;
}

const defaultClock: Clock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const config: Config = {
  post: () => {},
  clock: defaultClock,
  composerReady: null,
  lagSampler: null,
  storageChars: null,
  windowStore: true,
};

/** Wire the module up. The shell calls it on every render with its live functions; tests call it with fakes. */
export function configureChatOpenTiming(next: Partial<Config>): void {
  try {
    Object.assign(config, next);
  } catch {
    /* never */
  }
}

let seqCounter = 0;
let current: OpenState | null = null;
const counter = { opens: 0, byRoute: new Map<string, number>(), slow: 0, since: 0 };
let counterTimer: unknown = null;
/** Every snapshot-skipped reason is posted once per session per page load: a persist runs once per text delta. */
const skippedOnce = new Set<string>();

interface OpenState {
  readonly record: ChatOpenRecord;
  windowTimer: unknown;
  stopLag: (() => ChatOpenRecord["lag"]) | null;
  composerTimer: unknown;
  /** The last mount key counted, so a repeated commit of the same key is not a mount. */
  lastKey: string | null;
  /** Waiting on this open to settle (or close). */
  settleWaiters: (() => void)[];
  streams: Map<string, MutableSpecialist>;
}

interface MutableSpecialist {
  requests: number;
  bytes: number;
  bytesFirst5s: number;
  headersMs: number | null;
  settleMs: number | null;
  startedAfterMs: number | null;
  outcome: SpecialistStreamOutcome;
  live: boolean;
  firstRequestAt: number | null;
}

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

/* ---------------------------------------------------------------------------------------------------------------- */
/* Public API used by the shell                                                                                      */
/* ---------------------------------------------------------------------------------------------------------------- */

/**
 * The handle the shell holds for one open. Every method is a no-op after the record closes or another open begins,
 * so a late callback from an abandoned open can never write into the open that replaced it.
 */
export interface ChatOpenHandle {
  readonly record: ChatOpenRecord;
  route(route: ChatOpenRoute): void;
  snapshot(ms: number, found: boolean): void;
  seam(result: ChatOpenSeam, ms: number): void;
  replay(ms: number, events: number): void;
  shimmerReturned(): void;
  savedCopy(outcome: SavedCopyWrite, status?: number): void;
  /** The open has decided what it shows (see `settledMs`). Wakes {@link whenChatOpenSettled}. */
  settled(): void;
  /** A newer click took over, or the open was abandoned. Closes the record now. */
  cancel(): void;
}

const NOOP_HANDLE: ChatOpenHandle = Object.freeze({
  record: Object.freeze({}) as ChatOpenRecord,
  route() {},
  snapshot() {},
  seam() {},
  replay() {},
  shimmerReturned() {},
  savedCopy() {},
  settled() {},
  cancel() {},
});

/** Start the record for one click. Closes the previous open's record first (one record per click). */
export function beginChatOpen(input: {
  readonly chatId: string;
  readonly sessionId?: string;
  readonly storedEvents: number;
  readonly storedToken: boolean;
  readonly pageLoad?: boolean;
}): ChatOpenHandle {
  return safe(() => {
    if (current) closeOpen(current, true);
    const pageLoad = Boolean(input.pageLoad);
    const record: ChatOpenRecord = {
      seq: ++seqCounter,
      at: new Date().toISOString(),
      chatId: input.chatId,
      sessionId: input.sessionId,
      pageLoad,
      clickAt: config.clock.now(),
      stored: { events: Math.max(0, input.storedEvents | 0), token: Boolean(input.storedToken) },
      route: "pending",
      snapshotMs: null,
      snapshotFound: null,
      tailMs: null,
      seam: "none",
      seamReads: 0,
      replayMs: null,
      replayEvents: null,
      paintMs: null,
      composerReadyMs: null,
      settledMs: null,
      mounts: 0,
      mountCauses: [],
      shimmerReturned: false,
      savedCopy: "none",
      savedCopyStatus: null,
      cancelled: false,
      lag: { source: "none", count: 0, totalMs: 0, maxMs: 0, windowMs: 0 },
      specialists: [],
      storageChars: null,
      closed: false,
    };
    const state: OpenState = {
      record,
      windowTimer: null,
      stopLag: null,
      composerTimer: null,
      lastKey: null,
      settleWaiters: [],
      streams: new Map(),
    };
    current = state;
    state.stopLag = safe(() => config.lagSampler?.() ?? null, null);
    state.windowTimer = config.clock.setTimeout(() => closeOpen(state, false), OPEN_WINDOW_MS);
    if (config.windowStore && typeof window !== "undefined") {
      safe(() => {
        const w = window as unknown as { __chatOpens?: ChatOpenRecord[] };
        w.__chatOpens = [...(w.__chatOpens ?? []).slice(-49), record];
      }, undefined);
    }
    return handleFor(state);
  }, NOOP_HANDLE);
}

/** The open whose window is running, if any (the shell's commit hook and the specialist probes read it). */
export function currentChatOpen(): ChatOpenRecord | null {
  return current && !current.record.closed ? current.record : null;
}

/** Ms since the open's click; for the page load's own open, since navigation start. */
function sinceClick(state: OpenState): number {
  return Math.max(0, Math.round(config.clock.now() - (state.record.pageLoad ? 0 : state.record.clickAt)));
}

function handleFor(state: OpenState): ChatOpenHandle {
  const live = () => current === state && !state.record.closed;
  const r = state.record;
  return {
    record: r,
    route(route) {
      safe(() => {
        if (!live()) return;
        // A discard is the most informative route; never downgrade it to the full replay that follows it.
        if (r.route === "snapshot-discarded" && route === "full-replay") return;
        r.route = route;
      }, undefined);
    },
    snapshot(ms, found) {
      safe(() => {
        if (!live()) return;
        r.snapshotMs = Math.round(ms);
        r.snapshotFound = found;
      }, undefined);
    },
    seam(result, ms) {
      safe(() => {
        if (!live()) return;
        r.seam = result;
        r.seamReads += 1;
        r.tailMs = Math.round((r.tailMs ?? 0) + ms);
      }, undefined);
    },
    replay(ms, events) {
      safe(() => {
        if (!live()) return;
        r.replayMs = Math.round(ms);
        r.replayEvents = events;
      }, undefined);
    },
    shimmerReturned() {
      safe(() => {
        if (!live()) return;
        if (r.paintMs !== null) r.shimmerReturned = true;
      }, undefined);
    },
    savedCopy(outcome, status) {
      safe(() => {
        // A write's answer can arrive after the window closed; it still belongs to this record.
        if (r.savedCopy === "stored" || r.savedCopy === "refused" || r.savedCopy === "failed") return;
        r.savedCopy = outcome;
        if (typeof status === "number") r.savedCopyStatus = status;
      }, undefined);
    },
    settled() {
      safe(() => {
        if (!live() || r.settledMs !== null) return;
        r.settledMs = sinceClick(state);
        wake(state);
      }, undefined);
    },
    cancel() {
      safe(() => {
        if (!live()) return;
        r.cancelled = true;
        closeOpen(state, true);
      }, undefined);
    },
  };
}

function wake(state: OpenState): void {
  const waiters = state.settleWaiters.splice(0);
  for (const w of waiters) safe(w, undefined);
}

/**
 * Resolves when the chat open in progress has SETTLED: what it shows is decided, so the network it needed is done
 * (the saved copy, the seam reads, a full replay). Resolves at once when no open is in progress or it has already
 * settled, and when the open is cancelled by a later click or its 30 s window closes, so a caller never waits for
 * ever. Never rejects.
 *
 * For work that should not compete with opening the conversation: the Control Panel defers reading FINISHED
 * specialists' history until this resolves (and the conversation has painted).
 */
export function whenChatOpenSettled(): Promise<void> {
  return safe(() => {
    const state = current;
    if (!state || state.record.closed || state.record.settledMs !== null) return Promise.resolve();
    return new Promise<void>((resolve) => state.settleWaiters.push(resolve));
  }, Promise.resolve());
}

/**
 * The longest the Control Panel waits for the open to settle before it reads finished specialists anyway: a safety
 * net only. Every open settles or is closed by its 30 s window, but an open whose `settled()` call was lost would
 * otherwise hold the history back for the whole window.
 */
export const HARVEST_SAFETY_MS = 5_000;

/**
 * Calls `ready` ONCE: when the chat open in progress settles ({@link whenChatOpenSettled}: at once when no open is in
 * progress or it already settled), or after `safetyMs` on the module's clock, whichever comes first. Returns a cancel
 * function (an unmount): after it, `ready` is never called. Never throws, and a `ready` that throws is contained.
 *
 * This is the Control Panel's harvest gate (app/_components/agent-chat.tsx `useConversationSettled`): finished
 * specialists' history is read once the open has decided what it shows, not on a fixed delay after paint.
 */
export function afterChatOpenSettled(ready: () => void, safetyMs: number = HARVEST_SAFETY_MS): () => void {
  return safe(() => {
    let done = false;
    let timer: unknown = null;
    const fire = () => {
      if (done) return;
      done = true;
      if (timer !== null) safe(() => config.clock.clearTimeout(timer), undefined);
      safe(ready, undefined);
    };
    timer = config.clock.setTimeout(fire, Math.max(0, safetyMs));
    void whenChatOpenSettled().then(fire, fire);
    return () => {
      if (done) return;
      done = true;
      if (timer !== null) safe(() => config.clock.clearTimeout(timer), undefined);
    };
  }, () => {});
}

/**
 * The shell's commit hook: called from a layout effect after every commit that changed the chat's key or its
 * messages. Counts mounts (a new `mountKey#attachNonce` for the open's chat) and records paint.
 */
export function noteChatCommit(input: {
  readonly mountKey: string;
  readonly reactKey: string;
  readonly hasMessages: boolean;
  readonly shimmer: boolean;
  readonly cause?: ChatMountCause;
}): void {
  safe(() => {
    const state = current;
    if (!state || state.record.closed) return;
    const r = state.record;
    if (input.mountKey !== r.chatId) return;
    if (state.lastKey !== input.reactKey) {
      state.lastKey = input.reactKey;
      r.mounts += 1;
      r.mountCauses.push(r.mounts === 1 ? "open" : (input.cause ?? "other"));
    }
    if (r.paintMs === null && input.hasMessages && !input.shimmer) {
      r.paintMs = sinceClick(state);
      scheduleComposerCheck(state);
    }
  }, undefined);
}

/**
 * Composer-ready: from the paint, look once per frame (or per 50 ms in a hidden tab, where frames pause) for an
 * enabled composer, from a TASK scheduled after the frame, so the time recorded is when an input event could have
 * been handled, not merely when the element existed.
 */
function scheduleComposerCheck(state: OpenState): void {
  const probe = config.composerReady;
  if (!probe) return;
  const tick = () => {
    if (state.record.closed || state.record.composerReadyMs !== null) return;
    if (safe(probe, false)) {
      state.record.composerReadyMs = sinceClick(state);
      return;
    }
    next();
  };
  const next = () => {
    const raf = typeof requestAnimationFrame === "function" && !(typeof document !== "undefined" && document.hidden);
    if (raf) {
      requestAnimationFrame(() => {
        state.composerTimer = config.clock.setTimeout(tick, 0);
      });
    } else {
      state.composerTimer = config.clock.setTimeout(tick, 50);
    }
  };
  next();
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Specialist streams                                                                                                */
/* ---------------------------------------------------------------------------------------------------------------- */

const NOOP_PROBE: SpecialistStreamProbe = Object.freeze({
  request() {},
  headers() {},
  bytes() {},
  settle() {},
});

/**
 * The probe for one specialist's stream, bound to the open whose window is running NOW (or a no-op when none is).
 *
 * `key` identifies the specialist's stream within the open (its child session id is the natural choice); it is used
 * only to group calls and is never stored in the record or posted. Ask for the probe when the read starts and keep it
 * for that read: a probe stays bound to the open it was created in, so a read that outlives its open never reports
 * into the next one.
 */
export function specialistStream(key: string, opts?: { readonly live?: boolean }): SpecialistStreamProbe {
  return safe(() => {
    const state = current;
    if (!state || state.record.closed || !key) return NOOP_PROBE;
    let s = state.streams.get(key);
    if (!s) {
      s = {
        requests: 0,
        bytes: 0,
        bytesFirst5s: 0,
        headersMs: null,
        settleMs: null,
        startedAfterMs: null,
        outcome: "pending",
        live: Boolean(opts?.live),
        firstRequestAt: null,
      };
      state.streams.set(key, s);
    } else if (opts?.live) {
      s.live = true;
    }
    const entry = s;
    const open = () => !state.record.closed;
    return {
      request() {
        safe(() => {
          if (!open()) return;
          entry.requests += 1;
          if (entry.firstRequestAt === null) {
            entry.firstRequestAt = config.clock.now();
            entry.startedAfterMs = sinceClick(state);
          }
        }, undefined);
      },
      headers() {
        safe(() => {
          if (!open() || entry.headersMs !== null || entry.firstRequestAt === null) return;
          entry.headersMs = Math.round(config.clock.now() - entry.firstRequestAt);
        }, undefined);
      },
      bytes(n) {
        safe(() => {
          if (!open() || !(n > 0)) return;
          entry.bytes += n;
          if (sinceClick(state) <= 5_000) entry.bytesFirst5s += n;
        }, undefined);
      },
      settle(outcome) {
        safe(() => {
          if (!open() || entry.outcome !== "pending") return;
          entry.outcome = outcome;
          if (entry.firstRequestAt !== null) entry.settleMs = Math.round(config.clock.now() - entry.firstRequestAt);
        }, undefined);
      },
    };
  }, NOOP_PROBE);
}

/** Totals over an open's specialist streams. */
export function specialistTotals(list: readonly SpecialistStreamStats[]): {
  readonly count: number;
  readonly requests: number;
  readonly bytes: number;
  readonly bytesFirst5s: number;
  readonly maxHeadersMs: number | null;
  readonly maxSettleMs: number | null;
  readonly pending: number;
} {
  let requests = 0;
  let bytes = 0;
  let bytesFirst5s = 0;
  let maxHeadersMs: number | null = null;
  let maxSettleMs: number | null = null;
  let pending = 0;
  for (const s of list) {
    requests += s.requests;
    bytes += s.bytes;
    bytesFirst5s += s.bytesFirst5s;
    if (s.headersMs !== null) maxHeadersMs = Math.max(maxHeadersMs ?? 0, s.headersMs);
    if (s.settleMs !== null) maxSettleMs = Math.max(maxSettleMs ?? 0, s.settleMs);
    if (s.outcome === "pending") pending += 1;
  }
  return { count: list.length, requests, bytes, bytesFirst5s, maxHeadersMs, maxSettleMs, pending };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Closing a record and the rows it posts                                                                            */
/* ---------------------------------------------------------------------------------------------------------------- */

function closeOpen(state: OpenState, early: boolean): void {
  safe(() => {
    const r = state.record;
    if (r.closed) return;
    r.closed = true;
    if (current === state) current = null;
    if (state.windowTimer !== null) config.clock.clearTimeout(state.windowTimer);
    if (state.composerTimer !== null) config.clock.clearTimeout(state.composerTimer);
    wake(state);
    if (state.stopLag) r.lag = safe(state.stopLag, r.lag);
    if (early && r.route === "pending") r.cancelled = true;
    r.specialists = [...state.streams.values()].map((s) => ({
      requests: s.requests,
      bytes: s.bytes,
      bytesFirst5s: s.bytesFirst5s,
      headersMs: s.headersMs,
      settleMs: s.settleMs,
      startedAfterMs: s.startedAfterMs,
      outcome: s.outcome,
      live: s.live,
    }));
    r.storageChars = safe(() => config.storageChars?.() ?? null, null);
    countOpen(r);
    if (shouldPostDetail(r)) {
      post({ kind: "thread-open", sessionId: r.sessionId, detail: formatOpenDetail(r), elapsedMs: openElapsed(r) }, false);
    }
  }, undefined);
}

/** The open's headline time: paint, or composer-ready when that came later; null for an open that never painted. */
export function openElapsed(r: ChatOpenRecord): number | undefined {
  const t = Math.max(r.paintMs ?? -1, r.composerReadyMs ?? -1);
  return t >= 0 ? Math.min(t, 86_400_000) : undefined;
}

/** Does this open get its own detailed row? Over 2 s, the shimmer came back, or more than one mount. */
export function shouldPostDetail(r: ChatOpenRecord): boolean {
  if (r.cancelled && r.paintMs === null) return false; // superseded before it showed anything: nothing to judge
  if (r.shimmerReturned) return true;
  if (r.mounts > 1) return true;
  if ((r.paintMs ?? 0) > SLOW_OPEN_MS || (r.composerReadyMs ?? 0) > SLOW_OPEN_MS) return true;
  // Never painted inside the whole window: the slowest open there is.
  if (r.paintMs === null && !r.cancelled) return true;
  return false;
}

const n = (v: number | null | undefined) => (v === null || v === undefined ? "-" : String(Math.round(v)));
const kb = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)}M` : `${Math.round(bytes / 1024)}K`);

/**
 * The detailed row: numbers and short codes only, at most {@link DETAIL_MAX} characters. Never text, titles, ids or
 * tokens. Read in automation_audit as, for example:
 *   route=snapshot paint=2410 ready=2600 snap=310 tail=900 seam=empty/2 replay=- mounts=2(open,resync) shimmer=0
 *   save=stored stored=0/t lag=lt:4/1350/600 spec=4 req=4 rx=133.0M rx5=12.0M hdr=3600 settle=43000 pend=1
 */
export function formatOpenDetail(r: ChatOpenRecord): string {
  const t = specialistTotals(r.specialists);
  const causes = r.mountCauses.slice(0, 4).join(",") + (r.mountCauses.length > 4 ? ",…" : "");
  const parts = [
    `route=${r.route}${r.cancelled ? "(cancelled)" : ""}${r.pageLoad ? "(load)" : ""}`,
    `paint=${n(r.paintMs)}`,
    `ready=${n(r.composerReadyMs)}`,
    `settled=${n(r.settledMs)}`,
    `snap=${n(r.snapshotMs)}`,
    `tail=${n(r.tailMs)}`,
    `seam=${r.seam}${r.seamReads > 1 ? `/${r.seamReads}` : ""}`,
    `replay=${n(r.replayMs)}${r.replayEvents !== null ? `/${r.replayEvents}ev` : ""}`,
    `mounts=${r.mounts}${causes ? `(${causes})` : ""}`,
    `shimmer=${r.shimmerReturned ? 1 : 0}`,
    `save=${r.savedCopy}${r.savedCopyStatus !== null ? `/${r.savedCopyStatus}` : ""}`,
    `stored=${r.stored.events}/${r.stored.token ? "t" : "-"}`,
    `lag=${r.lag.source === "longtask" ? "lt" : r.lag.source === "drift" ? "dr" : "-"}:${r.lag.count}/${n(r.lag.totalMs)}/${n(r.lag.maxMs)}`,
    t.count
      ? `spec=${t.count} req=${t.requests} rx=${kb(t.bytes)} rx5=${kb(t.bytesFirst5s)} hdr=${n(t.maxHeadersMs)} settle=${n(t.maxSettleMs)} pend=${t.pending}`
      : "spec=0",
    r.storageChars !== null ? `ls=${Math.round(r.storageChars / 1000)}k` : "",
  ].filter(Boolean);
  return parts.join(" ").slice(0, DETAIL_MAX);
}

/* ---- the counter -------------------------------------------------------------------------------------------- */

function countOpen(r: ChatOpenRecord): void {
  const route = r.cancelled && r.route === "pending" ? "cancelled" : r.route;
  counter.opens += 1;
  counter.byRoute.set(route, (counter.byRoute.get(route) ?? 0) + 1);
  if (shouldPostDetail(r)) counter.slow += 1;
  if (!counter.since) counter.since = config.clock.now();
  if (counter.opens >= COUNTER_FLUSH_OPENS) {
    flushOpenCounter(false);
    return;
  }
  if (counterTimer === null) {
    counterTimer = config.clock.setTimeout(() => {
      counterTimer = null;
      flushOpenCounter(false);
    }, COUNTER_FLUSH_MS);
  }
}

/** The counter row's text: opens by route, and how many of them were slow enough for a detailed row. */
export function formatCounterDetail(byRoute: ReadonlyMap<string, number>, opens: number, slow: number): string {
  const routes = [...byRoute.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`);
  return [`opens=${opens}`, ...routes, `slow=${slow}`].join(" ").slice(0, DETAIL_MAX);
}

/**
 * Post the counter now (the tab is going away or hidden: `keepalive`, so the request survives the page).
 * A no-op when nothing was counted since the last flush.
 */
export function flushOpenCounter(keepalive: boolean): void {
  safe(() => {
    if (counterTimer !== null) {
      config.clock.clearTimeout(counterTimer);
      counterTimer = null;
    }
    if (!counter.opens) return;
    const detail = formatCounterDetail(counter.byRoute, counter.opens, counter.slow);
    const opens = counter.opens;
    counter.opens = 0;
    counter.slow = 0;
    counter.byRoute = new Map();
    counter.since = 0;
    post({ kind: "thread-open-count", detail, attempt: Math.min(opens, 10_000) }, keepalive);
  }, undefined);
}

/* ---- the saved-copy kinds that were swallowed ------------------------------------------------------------- */

/**
 * The saved copy was refused by the server (status and reason), discarded by the client (the stream disagreed), or
 * skipped (nothing stored, and why). Each was silent before: a chat with no saved copy looked exactly like a chat
 * whose saves were being refused.
 *
 * `snapshot-skipped` is posted once per (session, reason) per page load, because the persist path that skips runs
 * once per streamed text delta.
 */
export function reportSnapshotEvent(
  kind: "snapshot-refused" | "snapshot-discarded" | "snapshot-skipped",
  input: { readonly sessionId?: string; readonly status?: number; readonly reason: string },
): void {
  safe(() => {
    const reason = String(input.reason ?? "").replace(/[^\w .:/=-]/g, "").slice(0, 120);
    if (kind === "snapshot-skipped") {
      const key = `${input.sessionId ?? "-"}|${reason}`;
      if (skippedOnce.has(key)) return;
      if (skippedOnce.size > 500) skippedOnce.clear();
      skippedOnce.add(key);
    }
    const detail = [typeof input.status === "number" ? `status=${input.status}` : "", `reason=${reason}`]
      .filter(Boolean)
      .join(" ");
    post({ kind, sessionId: input.sessionId, detail: detail.slice(0, DETAIL_MAX) }, false);
  }, undefined);
}

function post(row: ChatTelemetryRow, keepalive: boolean): void {
  safe(() => config.post(row, keepalive), undefined);
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* The browser's samplers (installed by the shell; not used in node)                                                 */
/* ---------------------------------------------------------------------------------------------------------------- */

/**
 * Main-thread lag for the window: long tasks (50 ms or more) where the browser reports them (Chromium), otherwise a
 * 100 ms timer whose lateness is the lag (a late timer is a busy thread; a hidden tab's throttling reads as lag too,
 * so the sampler only counts while the tab is visible).
 */
export function browserLagSampler(): () => ChatOpenRecord["lag"] {
  const started = performance.now();
  const lag = { source: "none" as ChatOpenRecord["lag"]["source"], count: 0, totalMs: 0, maxMs: 0, windowMs: 0 };
  const supported =
    typeof PerformanceObserver !== "undefined" &&
    Array.isArray((PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes) &&
    (PerformanceObserver as unknown as { supportedEntryTypes: string[] }).supportedEntryTypes.includes("longtask");
  if (supported) {
    lag.source = "longtask";
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          lag.count += 1;
          lag.totalMs += e.duration;
          lag.maxMs = Math.max(lag.maxMs, e.duration);
        }
      });
      observer.observe({ type: "longtask", buffered: false });
    } catch {
      observer = null;
      lag.source = "none";
    }
    return () => {
      try {
        if (observer) {
          for (const e of observer.takeRecords()) {
            lag.count += 1;
            lag.totalMs += e.duration;
            lag.maxMs = Math.max(lag.maxMs, e.duration);
          }
          observer.disconnect();
        }
      } catch {
        /* never */
      }
      lag.windowMs = Math.round(performance.now() - started);
      lag.totalMs = Math.round(lag.totalMs);
      lag.maxMs = Math.round(lag.maxMs);
      return lag;
    };
  }
  lag.source = "drift";
  const PERIOD = 100;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const late = now - last - PERIOD;
    last = now;
    if (typeof document !== "undefined" && document.hidden) return;
    if (late >= 50) {
      lag.count += 1;
      lag.totalMs += late;
      lag.maxMs = Math.max(lag.maxMs, late);
    }
  }, PERIOD);
  return () => {
    clearInterval(timer);
    lag.windowMs = Math.round(performance.now() - started);
    lag.totalMs = Math.round(lag.totalMs);
    lag.maxMs = Math.round(lag.maxMs);
    return lag;
  };
}

/** Characters held in this origin's localStorage (keys and values), or null where it cannot be read. */
export function browserStorageChars(): number | null {
  try {
    const ls = window.localStorage;
    let total = 0;
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k === null) continue;
      total += k.length + (ls.getItem(k)?.length ?? 0);
    }
    return total;
  } catch {
    return null;
  }
}

/** For tests: forget every open, counter and once-only key, and restore the default configuration. */
export function resetChatOpenTimingForTest(): void {
  if (current) {
    current.record.closed = true;
    current = null;
  }
  counter.opens = 0;
  counter.slow = 0;
  counter.byRoute = new Map();
  counter.since = 0;
  counterTimer = null;
  skippedOnce.clear();
  seqCounter = 0;
  Object.assign(config, {
    post: () => {},
    clock: defaultClock,
    composerReady: null,
    lagSampler: null,
    storageChars: null,
    windowStore: true,
  } satisfies Config);
}

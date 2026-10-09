/**
 * THE SPECIALIST SWEEP'S WORLD over eve's runtime (mold_v1-196): `delegationSweep` from eve/channels (the eve patch,
 * execution/delegation-sweep.js) and the sandbox line, as the pure sweep (agent/lib/specialist-sweep.ts) wants them.
 * No database here: the ledger is passed in (agent/lib/sweep-ledger.ts in the app; an in-memory one in
 * scripts/test-specialist-detach.mjs, which runs this very world on the real runtime).
 */
import type { SweepEvent, SweepLedger, SweepWorld } from "./specialist-sweep.ts";
import { sandboxWaitLine } from "./sandbox-wait.ts";

/** What eve's patch exports for the sweep (`delegationSweep` from eve/channels). */
export interface SweepRuntime {
  events(sessionId: string, startIndex?: number): Promise<ReadableStream<unknown>>;
  cancel(sessionId: string, turnId?: string): Promise<{ status: string }>;
  terminate(sessionId: string, reason?: string): Promise<boolean>;
  handOver(sessionId: string, callIds: readonly string[]): Promise<boolean>;
  deliverLateResult(input: { sessionId: string; continuationTokens: readonly string[]; result: SweepEventResult }): Promise<boolean>;
}
type SweepEventResult = { callId: string; kind: "subagent-result"; subagentName: string; output: unknown; isError?: boolean };

/** How long one read of a whole history may take. */
const READ_MS = 10_000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** How many sessions' histories one process keeps between passes (the sweep reads only outstanding ones now). */
export const HISTORY_CACHE_SESSIONS = 128;

/** What has been read of one session's stream: its events without the streaming noise, and how far the read got. */
interface ReadSoFar {
  /** The events read, without `.delta` / `.appended` ones, except the very last event read whatever it is. */
  events: SweepEvent[];
  /** How many events of the stream have been read (the index the next read starts at). */
  count: number;
  /** The last event read, as JSON (the "nothing new" check against the stream's tail). */
  last: string | null;
  /** The last element of `events` is a noise event kept only because it was the last one. */
  noiseTail: boolean;
}

const isNoiseType = (type: unknown) => typeof type === "string" && (type.endsWith(".delta") || type.endsWith(".appended"));

/**
 * One cache per runtime, for the life of the process (mold_v1-199). On the self-hosted local world a stream is one
 * file per event and reading one from the start costs about 2 ms an event (measured on eve dev:
 * scripts/test-specialist-detach.mjs `sweeptiming`), so a long research thread or specialist (thousands of events) did
 * not fit the 10 s read at all: every pass read it from the start again, gave up at 10 s, and judged nothing. Now each
 * session's stream is read from the start once per process, a read that runs out of time keeps what it got (the next
 * pass goes on from there), and after that a pass reads only the tail and what is new.
 */
const caches = new WeakMap<object, Map<string, ReadSoFar>>();
const inflight = new WeakMap<object, Map<string, Promise<SweepEvent[] | undefined>>>();

/** For tests: forget what has been read. */
export function clearHistoryCache(rt?: object): void {
  if (rt) {
    caches.delete(rt);
    inflight.delete(rt);
  }
}

/**
 * A session's COMPLETE history as of each ask, read incrementally (the session guard's `historyReader`, over eve's
 * runtime rather than a route's `getSession`): take the latest event, then read forward from where the last read of
 * this session stopped until that very event. `.delta` / `.appended` events are not kept (nothing the sweep decides
 * reads them; the last event read is always kept, whatever it is, for the time of the last progress).
 */
export function wholeHistory(rt: Pick<SweepRuntime, "events">, totalMs = READ_MS): (sessionId: string) => Promise<SweepEvent[] | undefined> {
  let cache = caches.get(rt);
  if (!cache) caches.set(rt, (cache = new Map()));
  let running = inflight.get(rt);
  if (!running) inflight.set(rt, (running = new Map()));
  const read = cache;
  const busy = running;
  /**
   * The latest event: `{ event }`, `{ empty: true }` when the stream opened and holds nothing yet (a session whose start
   * is still queued), or undefined when it could not be read — which is never taken for "empty": a specialist that
   * cannot be read is never judged.
   */
  const firstAt = async (sessionId: string, startIndex: number, waitMs: number): Promise<{ event: unknown } | { empty: true } | undefined> => {
    let reader: ReadableStreamDefaultReader<unknown> | undefined;
    try {
      const stream = await withTimeout(rt.events(sessionId, startIndex), 3_000);
      if (!stream) return undefined;
      reader = stream.getReader();
      const next = await withTimeout(reader.read(), waitMs);
      if (next === undefined) return { empty: true };
      return next.done ? { empty: true } : { event: next.value };
    } catch {
      return undefined;
    } finally {
      void reader?.cancel().catch(() => undefined);
    }
  };
  const latestOf = async (sessionId: string): Promise<{ event: unknown } | { empty: true } | undefined> => {
    const tail = await firstAt(sessionId, -1, 3_000);
    if (tail === undefined || "event" in tail) return tail;
    // Nothing at the tail within 3 s: confirm from the start, waiting longer, before calling the stream empty (a slow
    // read must never pass for a specialist that wrote nothing).
    const head = await firstAt(sessionId, 0, 8_000);
    if (head === undefined) return undefined;
    if (!("event" in head)) return head;
    const again = await firstAt(sessionId, -1, 8_000);
    return again !== undefined && "event" in again ? again : undefined;
  };
  const append = (entry: ReadSoFar, value: SweepEvent, json: string) => {
    if (entry.noiseTail) entry.events.pop();
    entry.events.push(value);
    entry.noiseTail = isNoiseType(value?.type);
    entry.count++;
    entry.last = json;
  };
  const readOnce = async (sessionId: string): Promise<SweepEvent[] | undefined> => {
    let entry = read.get(sessionId);
    if (entry) read.delete(sessionId); // most recently used last
    entry ??= { events: [], count: 0, last: null, noiseTail: false };
    read.set(sessionId, entry);
    while (read.size > HISTORY_CACHE_SESSIONS) read.delete(read.keys().next().value as string);
    const tail = await latestOf(sessionId);
    if (tail === undefined) return undefined;
    if ("empty" in tail) return entry.count ? undefined : [];
    const target = JSON.stringify(tail.event);
    if (entry.count > 0 && entry.last === target) return entry.events.slice();
    const deadline = Date.now() + totalMs;
    const from = entry.count;
    let reader: ReadableStreamDefaultReader<unknown> | undefined;
    try {
      const stream = await withTimeout(rt.events(sessionId, entry.count), totalMs);
      if (!stream) return undefined;
      reader = stream.getReader();
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) return gaveUp(sessionId, entry, from);
        const next = await withTimeout(reader.read(), left);
        if (!next) return gaveUp(sessionId, entry, from);
        if (next.done) break;
        const json = JSON.stringify(next.value);
        append(entry, next.value as SweepEvent, json);
        if (json === target) break;
      }
      return entry.events.slice();
    } catch {
      return undefined;
    } finally {
      void reader?.cancel().catch(() => undefined);
    }
  };
  /** One read of a session at a time (a turn start's sweep and the schedule's share what was read). */
  return (sessionId) => {
    const before = busy.get(sessionId) ?? Promise.resolve(undefined);
    const run = before.catch(() => undefined).then(() => readOnce(sessionId));
    busy.set(sessionId, run);
    void run.finally(() => {
      if (busy.get(sessionId) === run) busy.delete(sessionId);
    }).catch(() => undefined);
    return run;
  };
}

/** A read that ran out of time: nothing is judged on it; what it read is kept and the next read goes on from there. */
function gaveUp(sessionId: string, entry: ReadSoFar, from: number): undefined {
  console.error(
    `[specialist-sweep] a session's history was not read whole in time: ${entry.count - from} event(s) read this time, ${entry.count} so far; the next read goes on from there`,
    { sessionId },
  );
  return undefined;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

/** The world the pure sweep acts on: eve's runtime, a ledger (one workspace's, agent/lib/sweep-ledger.ts), the bounds. */
export function runtimeWorld(rt: SweepRuntime, ledger: SweepLedger, settings: SweepWorld["settings"]): SweepWorld {
  const inLine = new Set(sandboxWaitLine().map((w) => w.sessionId).filter((id): id is string => Boolean(id)));
  return {
    history: wholeHistory(rt),
    handOver: (parent, callIds) => rt.handOver(parent, callIds),
    // The main thread takes deliveries on its token as its channel names it (`eve:<token>`); the runtime uses only a
    // hook that belongs to this very session.
    deliver: (parent, token, result) => rt.deliverLateResult({ sessionId: parent, continuationTokens: [token, `eve:${token}`], result }),
    cancel: async (child) => String((await rt.cancel(child))?.status ?? ""),
    terminate: (child, reason) => rt.terminate(child, reason),
    inSandboxLine: (id) => inLine.has(id),
    ledger,
    settings,
    now: () => Date.now(),
    sleep: delay,
  };
}


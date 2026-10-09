/**
 * WHAT EVE STILL OWES THIS CHAT — and what is left in the browser of the queue.
 *
 * THE QUEUE MOVED TO THE SERVER. Messages typed while a turn is live are held in `chat_queue_items`
 * (lib/chat-queue-server.ts, app/_components/use-chat-queue.ts) and the server sends them when the session comes to
 * rest, exactly once, whether or not a tab is open. #59 had kept one queue PER TAB in sessionStorage, which is why a
 * closed tab's queue was never sent, and it needed an owner id, a "gone" list and "inherited" items so that a
 * duplicated or restored tab could not send a copy. None of that is needed when there is one queue, on the server:
 * every tab shows it, and only the server's atomic claim sends from it. The tests that proved the old bugs
 * (twotab, dup, planmode, stale, reload) now hold the server queue to the same guarantees
 * (scripts/test-chat-queue-db.mjs, scripts/test-chat-buffered-turns.mjs).
 *
 * WHAT IS OWED stays here and stays shared across the person's tabs, because it decides what is ON SCREEN: a
 * message eve accepted but has not started (see `outstandingDeliveries` in chat-turn-state) — including one the
 * server sent from the queue — makes every tab of the chat keep a reader past the next boundary and hold new
 * messages, instead of falling one reply behind. Each tab writes only its OWN record (a write from a stale view can
 * then never erase another tab's), records are small and expire with the deliveries in them, and a Stop releases
 * specific deliveries by identity. A tab's identity across its own reloads (`markGone`) is what lets a reloaded tab
 * treat its earlier page's deliveries as its own.
 *
 * SCOPE. Keyed `${email}:${orgId}` like the chat cache, plus the chat; cleared on sign-out (`clearAllPending`).
 *
 * Pure over injected storages, so scripts/test-chat-buffered-turns.mjs runs it.
 */
import { STORAGE_KEYS } from "./browser-storage.ts";

/** sessionStorage: the prefix of this tab's own keys (its `gone` list; #59's per-tab queues, cleared on sign-out). */
export const QUEUE_KEY_PREFIX = STORAGE_KEYS.chatPending;
/** localStorage: `${OWED_KEY_PREFIX}:${scope}:${chatId}:t:${tab}` — one tab's owed deliveries. */
export const OWED_KEY_PREFIX = STORAGE_KEYS.chatOwed;
/** Shapes #59 wrote before review; cleared on sign-out with the rest. */
const OLD_PREFIXES = ["workspace-chat-queue"];

/** A delivery never seen for this long stops being owed (see `outstandingDeliveries`). */
export const OWED_MAX_AGE_MS = 15 * 60_000;

/** The settings a message is queued and sent under (mode, web search, browser, the companies it is about). */
export interface QueueSettings {
  readonly mode: string;
  readonly webSearch: boolean;
  readonly browserUse: boolean;
  readonly customers: readonly string[];
}

export interface PendingDelivery {
  readonly text: string;
  readonly at: number;
  readonly sentAt: number;
  /** The eve session it was delivered to — an ack can only come from that one. */
  readonly sessionId?: string | null;
  /** A message is acked by its `message.received`; an answer by the stream moving past it. */
  readonly kind?: "message" | "answer";
  /** The tab that sent it (set when records are merged). */
  readonly tab?: string;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type ScannableStorage = StorageLike & { readonly length: number; key(i: number): string | null };

/* ─────────────────────────── this tab across its reloads ─────────────────────────── */

/** sessionStorage key holding the ids of this tab's pages that have unloaded. */
export const GONE_KEY = `${QUEUE_KEY_PREFIX}:gone`;
const GONE_MAX = 20;

/** The ids of this tab's earlier pages — written by them as they unloaded. */
export function readGone(storage: StorageLike | null | undefined): Set<string> {
  if (!storage) return new Set();
  try {
    const ids = JSON.parse(storage.getItem(GONE_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** This page is unloading (`pagehide`): its tab's next page may treat its deliveries as its own. */
export function markGone(storage: StorageLike | null | undefined, tab: string): void {
  if (!storage) return;
  try {
    const ids = [...readGone(storage)].filter((x) => x !== tab);
    storage.setItem(GONE_KEY, JSON.stringify([...ids, tab].slice(-GONE_MAX)));
  } catch {
    /* no storage: the next page treats them as another tab's — the safe side */
  }
}

/** This page came back from the back/forward cache (`pageshow` persisted): it is not gone. */
export function unmarkGone(storage: StorageLike | null | undefined, tab: string): void {
  if (!storage) return;
  try {
    storage.setItem(GONE_KEY, JSON.stringify([...readGone(storage)].filter((x) => x !== tab)));
  } catch {
    /* nothing to undo */
  }
}

/* ──────────────────────────── what is owed ──────────────────────────── */

export interface OwedRecord {
  readonly beat: number;
  readonly deliveries: readonly PendingDelivery[];
  /** Deliveries (of any tab) a Stop in this tab released: `${tab}|${sentAt}`. */
  readonly released: readonly string[];
}

export function owedKey(scope: string, chatId: string): string {
  return `${OWED_KEY_PREFIX}:${scope}:${chatId}`;
}
const recordPrefix = (key: string) => `${key}:t:`;
/** Is this storage key a tab's owed record of this chat? (For the `storage` event.) */
export function isOwedKeyOf(key: string, storageKey: string | null | undefined): boolean {
  return Boolean(storageKey?.startsWith(recordPrefix(key)));
}
export const deliveryId = (d: PendingDelivery): string => `${d.tab ?? ""}|${d.sentAt}`;

const isDelivery = (e: unknown): e is PendingDelivery =>
  typeof (e as PendingDelivery)?.text === "string" &&
  typeof (e as PendingDelivery)?.at === "number" &&
  typeof (e as PendingDelivery)?.sentAt === "number";

function readRecords(storage: ScannableStorage | null | undefined, key: string): Map<string, OwedRecord> {
  const out = new Map<string, OwedRecord>();
  if (!storage) return out;
  try {
    const prefix = recordPrefix(key);
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k?.startsWith(prefix)) continue;
      try {
        const r = JSON.parse(storage.getItem(k) ?? "{}") as Partial<OwedRecord>;
        out.set(k.slice(prefix.length), {
          beat: typeof r.beat === "number" ? r.beat : 0,
          deliveries: Array.isArray(r.deliveries) ? r.deliveries.filter(isDelivery) : [],
          released: Array.isArray(r.released) ? r.released.filter((x): x is string => typeof x === "string") : [],
        });
      } catch {
        /* one unreadable record is skipped */
      }
    }
  } catch {
    /* no storage */
  }
  return out;
}

/** Everything owed to this chat, across the person's tabs. */
export function readOwed(storage: ScannableStorage | null | undefined, key: string | null | undefined): PendingDelivery[] {
  if (!storage || !key) return [];
  const records = readRecords(storage, key);
  const released = new Set([...records.values()].flatMap((r) => r.released));
  return [...records]
    .flatMap(([tab, r]) => r.deliveries.map((d) => ({ ...d, tab })))
    .filter((d) => !released.has(deliveryId(d)));
}

/**
 * Change THIS tab's record — the only one a tab writes — and return what is
 * owed. Deliveries older than `OWED_MAX_AGE_MS` are dropped, so records stay
 * small; a record with nothing left is removed, and so is any tab's record
 * that has gone that long without a write.
 */
export function updateOwed(
  storage: ScannableStorage | null | undefined,
  key: string | null | undefined,
  tab: string,
  change: (own: OwedRecord) => OwedRecord,
  now = Date.now(),
): PendingDelivery[] {
  if (!storage || !key) return [];
  try {
    const records = readRecords(storage, key);
    const own = records.get(tab) ?? { beat: now, deliveries: [], released: [] };
    const next = change(own);
    const deliveries = next.deliveries.filter((d) => now - d.sentAt < OWED_MAX_AGE_MS);
    const live = new Set([...records].flatMap(([t, r]) => r.deliveries.map((d) => deliveryId({ ...d, tab: t }))));
    const released = next.released.filter((id) => live.has(id));
    const k = `${recordPrefix(key)}${tab}`;
    if (deliveries.length === 0 && released.length === 0) storage.removeItem(k);
    else storage.setItem(k, JSON.stringify({ beat: now, deliveries, released }));
    for (const [t, r] of records) {
      if (t !== tab && now - r.beat >= OWED_MAX_AGE_MS) storage.removeItem(`${recordPrefix(key)}${t}`);
    }
  } catch {
    /* quota or private mode */
  }
  return readOwed(storage, key);
}

/**
 * WHAT A STOP MAY RELEASE: this tab's own deliveries, and another tab's only if
 * it was sent before this tab last saw the stream move (`viewAt`). A newer one
 * belongs to what that tab is showing; releasing it would put that tab one
 * reply behind again.
 */
export function releasable<D extends PendingDelivery>(
  list: readonly D[],
  self: ReadonlySet<string> | string,
  viewAt: number,
  now = Date.now(),
  opts: { readonly graceMs?: number; readonly sessionAtRest?: boolean } = {},
): D[] {
  const mine = typeof self === "string" ? new Set([self]) : self;
  const grace = opts.graceMs ?? OTHER_TAB_GRACE_MS;
  return list.filter(
    (d) =>
      (d.tab !== undefined && mine.has(d.tab)) ||
      d.sentAt <= viewAt ||
      // Past the grace, another tab's message may be released only when the
      // server says nothing is running: a message queued behind a long
      // specialist run is waiting legitimately.
      (opts.sessionAtRest === true && now - d.sentAt >= grace),
  );
}

/**
 * …and another tab's delivery that has gone unacknowledged this long may be
 * released from ANY tab. Without it an idle second tab sat locked on the other
 * tab's swallowed message for the whole 15-minute escape, and its Stop did
 * nothing (review, `twoswallow`).
 */
export const OTHER_TAB_GRACE_MS = 60_000;

/* ────────────────────────────── sign-out ────────────────────────────── */

/** Sign-out: nothing one person queued or is owed may survive for the next. */
export function clearAllPending(...storages: (ScannableStorage | null | undefined)[]): void {
  for (const storage of storages) {
    if (!storage) continue;
    try {
      const doomed: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k) continue;
        if ([QUEUE_KEY_PREFIX, OWED_KEY_PREFIX, ...OLD_PREFIXES].some((p) => k.startsWith(`${p}:`))) doomed.push(k);
      }
      for (const k of doomed) storage.removeItem(k);
    } catch {
      /* nothing to clear */
    }
  }
}

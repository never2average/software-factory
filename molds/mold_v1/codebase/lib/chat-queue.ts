/**
 * THE QUEUE, AND WHAT EVE STILL OWES THIS CHAT.
 *
 * THE QUEUE IS PER TAB. Messages typed while a turn is live are held here, not
 * delivered — the one place a message can still be removed ("unanswered
 * messages cannot be deleted" was the report). It lives in the tab's
 * sessionStorage, so it survives a RELOAD of that tab and nothing else: a tab
 * never sends another tab's messages, and a closed tab's queue is gone with it.
 * (An earlier version shared one queue across tabs; the review found it sent a
 * Plan-mode message from a Build-mode tab without its directive, and auto-sent a
 * three-day-old message from a long-closed tab on reopen. Both came from the
 * sharing itself, so it was removed.)
 *
 * Each item carries the SETTINGS it was queued under — mode, web search,
 * browser, the companies it is about — and is sent with them, whatever the
 * composer shows by the time it goes out.
 *
 * WHAT IS OWED stays shared across the person's tabs, because it decides what is
 * ON SCREEN: a message eve accepted but has not started (see
 * `outstandingDeliveries` in chat-turn-state) makes every tab of the chat keep a
 * reader past the next boundary and hold new messages, instead of falling one
 * reply behind. Each tab writes only its OWN record (a write from a stale view
 * can then never erase another tab's), records are small and expire with the
 * deliveries in them, and a Stop releases specific deliveries by identity.
 *
 * SCOPE. Keyed `${email}:${orgId}` like the chat cache, plus the chat; cleared
 * on sign-out (`clearAllPending`).
 *
 * Pure over injected storages, so scripts/test-chat-buffered-turns.mjs runs it.
 */
import { STORAGE_KEYS } from "./browser-storage.ts";

/** sessionStorage: `${QUEUE_KEY_PREFIX}:${scope}:${chatId}` — this tab's queue. */
export const QUEUE_KEY_PREFIX = STORAGE_KEYS.chatPending;
/** localStorage: `${OWED_KEY_PREFIX}:${scope}:${chatId}:t:${tab}` — one tab's owed deliveries. */
export const OWED_KEY_PREFIX = STORAGE_KEYS.chatOwed;
/** Shapes #59 wrote before review; cleared on sign-out with the rest. */
const OLD_PREFIXES = ["workspace-chat-queue"];

/** The most messages kept per chat — a queue is minutes of typing, not a log. */
export const QUEUE_MAX = 50;
/** A delivery never seen for this long stops being owed (see `outstandingDeliveries`). */
export const OWED_MAX_AGE_MS = 15 * 60_000;

/** The settings a message is sent under. */
export interface QueueSettings {
  readonly mode: string;
  readonly webSearch: boolean;
  readonly browserUse: boolean;
  readonly customers: readonly string[];
}

export interface QueueItem {
  readonly id: string;
  readonly text: string;
  /** How many files were attached (the files themselves live in this tab's memory). */
  readonly files: number;
  readonly createdAt: number;
  readonly settings: QueueSettings;
  /**
   * Not this tab's to send on its own: copied from another live tab ("Duplicate
   * tab" copies sessionStorage), or restored long after it was queued. Shown
   * with Send / Discard; sent only when the person says so.
   */
  readonly inherited?: boolean;
}

/** A queued item older than this, found on load, is never sent without the person's say-so. */
export const QUEUE_STALE_MS = 30 * 60_000;

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

/* ─────────────────────────────── the queue ─────────────────────────────── */

export function queueKey(scope: string, chatId: string): string {
  return `${QUEUE_KEY_PREFIX}:${scope}:${chatId}`;
}

const isSettings = (s: unknown): s is QueueSettings =>
  typeof (s as QueueSettings)?.mode === "string" &&
  typeof (s as QueueSettings)?.webSearch === "boolean" &&
  typeof (s as QueueSettings)?.browserUse === "boolean" &&
  Array.isArray((s as QueueSettings)?.customers);
const isItem = (e: unknown): e is QueueItem =>
  typeof (e as QueueItem)?.id === "string" &&
  typeof (e as QueueItem)?.text === "string" &&
  typeof (e as QueueItem)?.files === "number" &&
  typeof (e as QueueItem)?.createdAt === "number" &&
  isSettings((e as QueueItem)?.settings);

/** A queue as stored: its items, and the live id of the tab that owns them. */
export interface StoredQueue {
  readonly owner: string | null;
  readonly items: QueueItem[];
}

/** This tab's queue for a chat, as stored. Anything unreadable is empty, never a throw. */
export function loadQueue(storage: StorageLike | null | undefined, key: string | null | undefined): StoredQueue {
  if (!storage || !key) return { owner: null, items: [] };
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "null") as unknown;
    // The first shape was a bare array, with no owner.
    const raw = Array.isArray(parsed) ? { owner: null, items: parsed } : (parsed as { owner?: unknown; items?: unknown });
    const items = Array.isArray(raw?.items) ? raw.items.filter(isItem).slice(0, QUEUE_MAX) : [];
    return { owner: typeof raw?.owner === "string" ? raw.owner : null, items };
  } catch {
    return { owner: null, items: [] };
  }
}

/** Write this tab's queue through, as owned by `owner`. An empty queue removes the key: a removal is final. */
export function saveQueue(
  storage: StorageLike | null | undefined,
  key: string | null | undefined,
  items: readonly QueueItem[],
  owner: string,
): void {
  if (!storage || !key) return;
  try {
    if (items.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ owner, items: items.slice(0, QUEUE_MAX) }));
  } catch {
    /* quota or private mode — the queue still works from memory */
  }
}

/**
 * THE QUEUE A TAB FINDS WHEN IT LOADS — is it this tab's to send?
 *
 * sessionStorage is COPIED by "Duplicate tab", `window.open` and a restored
 * tab, so a new page can find another tab's queue in its own storage. The owner
 * id is a page's IN-MEMORY id, so a copy can never be the owner. The only thing
 * that says the owner is GONE is an explicit flag the owner writes into its own
 * tab's sessionStorage as it unloads (`markGone`, on `pagehide`) — which a copy
 * made while the owner was alive does not have.
 *
 * Never a timeout. A heartbeat was tried and failed: browsers throttle timers
 * in background tabs (Chrome: once a minute after five minutes), so a copy made
 * from the tab strip found the owner's heartbeat stale, adopted the queue, and
 * both tabs sent it (review, `dupstale`). No flag means "not mine: ask".
 *
 *  - the owner is in this tab's gone list (this tab was RELOADED): its items
 *    are this tab's — except those older than `QUEUE_STALE_MS`, inherited;
 *  - otherwise (a copy of a live tab, an unknown owner): every item is
 *    inherited, shown with Send / Discard, and never sent on its own.
 */
export function adoptQueue(input: {
  readonly stored: StoredQueue;
  /** Ids of this tab's earlier pages that have unloaded (see `readGone`). */
  readonly gone: ReadonlySet<string>;
  readonly now: number;
  readonly staleMs?: number;
}): QueueItem[] {
  const stale = input.staleMs ?? QUEUE_STALE_MS;
  const mine = input.stored.owner !== null && input.gone.has(input.stored.owner);
  return input.stored.items.map((q) =>
    q.inherited || !mine || input.now - q.createdAt > stale ? { ...q, inherited: true } : q,
  );
}

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

/** This page is unloading (`pagehide`): its tab's next page may take its queue back. */
export function markGone(storage: StorageLike | null | undefined, tab: string): void {
  if (!storage) return;
  try {
    const ids = [...readGone(storage)].filter((x) => x !== tab);
    storage.setItem(GONE_KEY, JSON.stringify([...ids, tab].slice(-GONE_MAX)));
  } catch {
    /* no storage: the next page will ask (Send / Discard) — the safe side */
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

/** An item whose attachment did not survive a reload of this tab. */
export function filesLost(item: QueueItem, localFiles: ReadonlySet<string>): boolean {
  return item.files > 0 && !localFiles.has(item.id);
}

/**
 * The next item to send: the first one that CAN be sent. An item whose
 * attachment was lost waits for the person (re-attach, or send without it) —
 * and does not hold up the plain messages queued after it.
 */
export function nextSendable(items: readonly QueueItem[], localFiles: ReadonlySet<string>): QueueItem | null {
  return items.find((q) => !q.inherited && !filesLost(q, localFiles)) ?? null;
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

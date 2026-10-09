/**
 * Writing the chat list to localStorage — off the React commit, and without
 * re-serialising the chats that did not change.
 *
 * WHY THIS IS A MODULE AND NOT A FUNCTION IN chat-shell.tsx
 *
 * This is the code whose bugs used to LOSE conversations: the first version
 * evicted old chats on overflow ("the sidebar is pruning chats from the
 * beginning"), the second stripped every stream but the newest four ("switching
 * threads went very very slow"). Both shipped because the only thing that could
 * check them was a regex over a .tsx file. Here the rules can be EXECUTED —
 * scripts/test-chat-persist-coalesce.mjs runs every branch of the quota back-off
 * and of the coalescer against a fake storage that really does throw.
 *
 * WHAT IT COSTS, MEASURED
 *
 * On a mid-range core, on the operator's real thread shape — a 1,500-event turn
 * whose answer contains a 60 KB table — one persist used to be:
 *
 *   dedupeEvents over the whole transcript        195 ms
 *   JSON.stringify of the chat list + setItem     266 ms
 *   ------------------------------------------------------
 *   per persist, blocking the main thread        ~460 ms
 *
 * The first term is gone: `createEventDeduper` (lib/chat-snapshot.ts) computes
 * the same answer from what arrived since. The second is what this file is for,
 * and it has two halves:
 *
 *   1. It ran INSIDE the `setSessions` updater, so a quarter-second of string
 *      building and a synchronous storage write sat between React deciding what
 *      the chat looks like and the browser painting it. {@link createPersistWriter}
 *      moves it behind one animation frame, dropping superseded writes.
 *   2. It re-serialised EVERY chat's full event stream on every write, though a
 *      streaming turn only ever changes one of them. {@link serializeChats}
 *      keeps each chat's JSON beside the chat object and reuses it.
 *
 * WHAT MUST NOT BREAK, AND WHY EACH GUARD IS HERE
 *
 *   - A page being closed gets no async callback. Every departure path calls
 *     {@link ChatPersistWriter.flush} SYNCHRONOUSLY, so a coalesced write can
 *     never be the one that was in flight when the tab went away.
 *   - A background tab does not get animation frames. The default scheduler
 *     therefore races rAF against a timer, because turns now stream while the
 *     tab is hidden (the reattach) and a write that waits for a frame that
 *     never comes is a lost transcript.
 *   - A queued write carries a WHOLE list, never a diff, so a flush can never
 *     store a partially-updated one.
 *   - The quota back-off (strip event streams oldest-first, then cap the chat
 *     count) is unchanged in behaviour and byte-identical in output. People hit
 *     the ~5 MB limit; that is why it exists.
 */


/** A ceiling so a runaway can't wedge storage — far above any real sidebar. */
export const STORAGE_MAX_CHATS = 300;

/**
 * THE MOST ONE CHAT'S CACHED TRANSCRIPT MAY WEIGH, in characters of JSON.
 *
 * localStorage holds ~5 M characters per origin, for the whole chat list. A
 * transcript heavier than this is stored as metadata only — the chat then opens
 * from the server's snapshot (#35), exactly as a stripped older chat does —
 * WHATEVER protects it. Protection used to be absolute, and the operator's real
 * thread (44.6 MB of JSON for a 60 KB answer, mold_v1-104) therefore could
 * never be stored: every step of the back-off below kept it, every step failed,
 * and the LAST RESORT kept it too — so nothing was written at all, not even the
 * other chats' titles, after ~9 failed 45 MB serialisations per persist.
 */
export const CHAT_CACHE_MAX_CHARS = 1_500_000;

/** A delta type → the field that carries its whole text so far, and the event that completes it. */
const DELTAS: Record<string, { soFar: string; completed: string }> = {
  "message.appended": { soFar: "messageSoFar", completed: "message.completed" },
  "reasoning.appended": { soFar: "reasoningSoFar", completed: "reasoning.completed" },
};

type Ev = { type?: string; data?: Record<string, unknown> };

/**
 * What a chat's transcript is CACHED as: every event IN ITS PLACE, with each
 * superseded delta EMPTIED rather than dropped.
 *
 * eve's deltas each carry the whole text so far, so a long answer is quadratic
 * in the stream (the operator's 60 KB answer was 44.6 MB of JSON). A delta the
 * very next event overwrites — the same turn and step, a later delta or its
 * completion — is invisible to the reducer (#35's rule, `compactTranscript`),
 * so its text can go. But the EVENT stays, as a placeholder carrying only what
 * the reducers key on (`turnId`, `stepIndex`, `sequence` — a parked
 * specialist's hand-back is named from it, `continuationTurnId`), an empty
 * text, and its position (`~`, so two placeholders are never byte-identical and
 * `dedupeEvents` cannot fold them together).
 *
 * WHY NOT DROP THEM, as the first version of this did (review of #81). A mount
 * measures its absolute-index deficit ONCE (`absoluteIndexBase` = cursor −
 * events held), so every event kept before a dropped delta was read at an index
 * shifted up by the deltas dropped after it. The chat's decisions compare those
 * indexes with where its deliveries were sent (`outstandingDeliveries`): a
 * reload during a parked specialist's resumed reply saw the park's
 * `session.waiting` at or past the answer's `at`, settled the answer, and
 * `attachDecision` answered "terminal" — the reply froze at two parts. With
 * every event in place the cached transcript has the stream's own numbering,
 * and every decision is the one the full stream gives
 * (scripts/test-chat-persist-coalesce.mjs, parity).
 */
export function cacheTranscript(events: readonly unknown[]): unknown[] {
  const out: unknown[] = new Array(events.length);
  for (let i = 0; i < events.length; i++) {
    const cur = events[i] as Ev;
    const rule = cur?.type ? DELTAS[cur.type] : undefined;
    const next = events[i + 1] as Ev | undefined;
    const sameSlot =
      rule !== undefined &&
      next !== undefined &&
      next.data?.turnId === cur.data?.turnId &&
      next.data?.stepIndex === cur.data?.stepIndex;
    const superseded =
      sameSlot && (next!.type === cur.type || (next!.type === rule!.completed && next!.data?.message !== null));
    if (!superseded) {
      out[i] = cur;
      continue;
    }
    const d = cur.data ?? {};
    out[i] = {
      type: cur.type,
      data: {
        turnId: d.turnId,
        stepIndex: d.stepIndex,
        ...(d.sequence !== undefined ? { sequence: d.sequence } : {}),
        [rule!.soFar]: "",
        "~": i,
      },
    };
  }
  return out;
}

function cachedEvents(events: unknown): unknown {
  return Array.isArray(events) ? cacheTranscript(events) : events;
}

/**
 * The minimum a chat must have for this file to store it. Deliberately
 * structural (not an import of `StoredSession`) so nothing here depends on a
 * React component file, which is what lets a node script execute it.
 */
export interface PersistableChat {
  id: string;
  clientKey?: string;
  updatedAt: number;
  events?: unknown;
}

/** Just the part of `Storage` this needs, so a test can hand it one that throws. */
export interface PersistStorage {
  setItem(key: string, value: string): void;
}

/**
 * Serialisations already paid for, keyed by the chat OBJECT.
 *
 * The saving rests on one invariant: a chat is REPLACED, never mutated. Every
 * update in chat-shell.tsx is a spread (`{ ...s, ...entry }`, `prev.map`), so
 * the chats that did not change during a turn keep their identity and their
 * JSON, and only the active chat is stringified again. `at` is a second, cheap
 * guard: an in-place edit that bumps `updatedAt` — the shape a future careless
 * edit would most likely take — invalidates the entry rather than serving a
 * stale transcript to storage.
 *
 * A WeakMap so a deleted chat's JSON is collectable with the chat.
 */
const serialized = new WeakMap<object, { at: number; full?: string; meta?: string; tooBig?: boolean }>();

/**
 * Test-only visibility, and the reason it is exported: the claim "an unchanged
 * chat is not re-serialised" is worth nothing asserted in a comment. The
 * coalescing test reads these counters to PROVE it.
 */
export const persistStats = { serialized: 0, reused: 0, tooBig: 0 };

function chatJson(chat: PersistableChat, withEvents: boolean): string {
  let slot = serialized.get(chat);
  if (!slot || slot.at !== chat.updatedAt) {
    slot = { at: chat.updatedAt };
    serialized.set(chat, slot);
  }
  // Over the per-chat cap: its metadata form, from now on, without building the
  // full one again (the chat object is replaced, not mutated, when it changes).
  const full = withEvents && !slot.tooBig;
  const cached = full ? slot.full : slot.meta;
  if (cached !== undefined) {
    persistStats.reused++;
    return cached;
  }
  persistStats.serialized++;
  // `{ ...chat, events: undefined }` is what the stripped form has always been:
  // JSON.stringify drops an undefined value, so the key disappears and the read
  // path sees a chat with no cached transcript. Same bytes as before, built the
  // same way.
  if (full) {
    const json = JSON.stringify({ ...chat, events: cachedEvents(chat.events) });
    if (json.length <= CHAT_CACHE_MAX_CHARS) {
      slot.full = json;
      return json;
    }
    slot.tooBig = true;
    persistStats.tooBig++;
    return chatJson(chat, false);
  }
  const json = JSON.stringify({ ...chat, events: undefined });
  slot.meta = json;
  return json;
}

/** Would this chat's transcript be cached at all (not over {@link CHAT_CACHE_MAX_CHARS})? For tests and the warning. */
export function chatCacheable(chat: PersistableChat): boolean {
  chatJson(chat, true);
  return !serialized.get(chat)?.tooBig;
}

/**
 * Forget the FULL serialisation of chats whose events we decided not to store.
 *
 * Without this the cache would retain, for the rest of the session, the very
 * megabytes the quota back-off just refused to write — the over-quota attempt's
 * strings, held alive by the chats they describe. The stripped form is kept: it
 * is small and it is what the next write will ask for.
 */
function forgetStrippedFull(list: readonly PersistableChat[], keep: (chat: PersistableChat, i: number) => boolean) {
  for (let i = 0; i < list.length; i++) {
    if (keep(list[i], i)) continue;
    const slot = serialized.get(list[i]);
    if (slot) slot.full = undefined;
  }
}

/**
 * The exact bytes `JSON.stringify(list)` produces, assembled from per-chat
 * pieces so the unchanged ones cost nothing.
 *
 * `keepEvents` decides, per chat, whether its event stream goes in. An array's
 * JSON is its elements' JSON joined by commas inside brackets — there is no
 * whitespace and no reordering — so this is byte-for-byte what the previous
 * `JSON.stringify(list.map(strip))` wrote. scripts/test-chat-persist-coalesce.mjs
 * asserts that equality directly rather than trusting this paragraph.
 */
export function serializeChats(
  list: readonly PersistableChat[],
  keepEvents: (chat: PersistableChat, i: number) => boolean,
): string {
  let out = "[";
  for (let i = 0; i < list.length; i++) {
    if (i) out += ",";
    out += chatJson(list[i], keepEvents(list[i], i));
  }
  return out + "]";
}

/**
 * Persist the session list to localStorage.
 *
 * The payload embeds each chat's full event stream, which grows without bound
 * and eventually blows the ~5 MB quota. The FIRST version of this fix evicted
 * old chats on overflow — which is why the sidebar started "pruning chats from
 * the beginning". The SECOND version fixed that but always stripped events down
 * to the 4 most-recent chats, so after a reload every older chat had to REPLAY
 * its whole stream from the server on open — which is why switching threads went
 * "very very slow".
 *
 * This version keeps events for as MANY recent chats as actually FIT: it tries
 * to persist everything, and only when that overflows does it strip the oldest
 * chats' event streams (progressively) until it fits. A chat whose events are
 * cached opens instantly; only the oldest, quota-permitting, re-hydrate from the
 * server (`openChat`/`replaySession`). Metadata for EVERY chat is always kept,
 * so the sidebar list never loses an entry. The active/`protect`ed chats always
 * keep their events regardless of position.
 *
 * Unchanged from the version that lived in chat-shell.tsx except that the
 * strings come from {@link serializeChats}, which makes the back-off cheaper
 * too: a step that fails has already paid for the stripped forms the next step
 * needs.
 */
export function writeChats(
  storage: PersistStorage | null,
  key: string,
  sessions: readonly PersistableChat[],
  protect: ReadonlySet<string>,
  onWarn?: (message: string) => void,
): boolean {
  if (!storage) return false;
  const list = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = (s: PersistableChat) => protect.has(s.id) || protect.has(s.clientKey ?? "");
  // Keep full events for the first `n` chats (and any protected one anywhere);
  // strip the rest to metadata only.
  const keepTo = (n: number) => (s: PersistableChat, i: number) => i < n || kept(s);
  const tryWrite = (payload: string): boolean => {
    try {
      storage.setItem(key, payload);
      return true;
    } catch {
      return false;
    }
  };
  // Try to keep ALL events, then back off the kept-count until it fits — so the
  // most-recent chats stay cached (instant open) and only the oldest are stripped
  // when genuinely over quota. Coarse steps keep this to a handful of attempts.
  const steps = [list.length, 64, 32, 16, 8, 4, 2, 0].filter(
    (n, i, a) => n <= list.length && a.indexOf(n) === i,
  );
  for (const n of steps) {
    if (tryWrite(serializeChats(list, keepTo(n)))) {
      forgetStrippedFull(list, keepTo(n));
      return true;
    }
  }
  // Truly pathological single huge chat — cap the count (very high), metadata only.
  onWarn?.("[chat-shell] localStorage still over quota after stripping all event streams — capping chat count.");
  const capped = list.slice(0, STORAGE_MAX_CHATS);
  if (tryWrite(serializeChats(capped, (s) => kept(s)))) {
    forgetStrippedFull(list, (s) => kept(s));
    return true;
  }
  // FAIL GRACEFULLY: the protected chats' transcripts are what does not fit, so
  // store the list without them. The chat list — every title, every session to
  // reopen — is worth more than one cached transcript, which the server's
  // snapshot can rebuild. Keeping it cost the whole write, every time.
  onWarn?.("[chat-shell] the open chat's transcript does not fit in localStorage — storing the chat list without it.");
  const ok = tryWrite(serializeChats(capped, () => false));
  forgetStrippedFull(list, () => false);
  return ok;
}

/** Cancels a scheduled flush. */
type Cancel = () => void;

export interface PersistWriterOptions {
  /** Where to write. Read lazily: `localStorage` may throw on access alone. */
  storage?: () => PersistStorage | null;
  /** Arrange for `run` to happen soon, and hand back a way to call it off. */
  schedule?: (run: () => void) => Cancel;
  onWarn?: (message: string) => void;
}

/**
 * However busy the stream, never hold a write longer than this.
 *
 * A hidden tab gets no animation frames, and since the reattach a turn keeps
 * streaming while the tab is hidden — so rAF alone would park the transcript
 * until the user came back, and a tab the browser discards in the meantime
 * would take it. The timer is the floor under that; rAF is what keeps the write
 * off the frame that is painting.
 */
export const PERSIST_MAX_WAIT_MS = 250;

function defaultStorage(): PersistStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Storage disabled by policy (third-party context, "block all cookies").
    // Losing the cache is survivable; throwing out of a persist is not.
    return null;
  }
}

function defaultSchedule(run: () => void): Cancel {
  let done = false;
  let raf = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    if (timer !== null) clearTimeout(timer);
    raf = 0;
    timer = null;
  };
  const fire = () => {
    if (done) return;
    done = true;
    stop();
    run();
  };
  if (typeof requestAnimationFrame === "function") raf = requestAnimationFrame(fire);
  timer = setTimeout(fire, PERSIST_MAX_WAIT_MS);
  return () => {
    done = true;
    stop();
  };
}

export interface ChatPersistWriter {
  /** Queue a write of the WHOLE list. Cheap: no string is built here. */
  queue(key: string, list: readonly PersistableChat[], protect: ReadonlySet<string>): void;
  /** Write anything queued, right now, on this stack. Returns true if it wrote. */
  flush(): boolean;
  /** Is a write still owed? Only tests and assertions need to ask. */
  hasPending(): boolean;
}

/**
 * One write per frame, and the last state always reaches storage.
 *
 * The previous engineer declined to move this write out of the `setSessions`
 * updater because the updater also calls `syncRef.current(...)` and
 * `storeSnapshotRef.current(...)`, so hoisting `next` out of it meant routing
 * through `sessionsRef` and rethinking the unload flush. That reasoning was
 * right about the risk and wrong about the necessity: nothing has to leave the
 * updater. The updater still computes `next` and still hands it over — it just
 * hands it to a QUEUE instead of to a quarter-second of string building. The
 * expensive half moves; the structure does not.
 *
 * Superseding rather than batching is what makes this safe. A queued write is a
 * complete list, so the newest one is a strict replacement for every earlier
 * one — dropping the superseded writes cannot lose state, only work. The
 * `protect` sets are UNIONED rather than replaced, because protection only ever
 * KEEPS a chat's events: taking the last caller's set would let a frame in which
 * both `persist()` and `handlePersist` ran strip the events of whichever chat
 * the loser was protecting.
 *
 * A key change (a different person, or a workspace switch) flushes first. The
 * key is part of the pending job precisely so a queued write can never land
 * under the wrong tenant's storage key — that bug has already been fixed once
 * in `storageKey`, where it migrated conversations between workspaces.
 */
export function createPersistWriter(options: PersistWriterOptions = {}): ChatPersistWriter {
  const storage = options.storage ?? defaultStorage;
  const schedule = options.schedule ?? defaultSchedule;
  let pending: { key: string; list: readonly PersistableChat[]; protect: Set<string> } | null = null;
  let cancel: Cancel | null = null;

  const flush = (): boolean => {
    if (cancel) {
      cancel();
      cancel = null;
    }
    const job = pending;
    pending = null;
    if (!job) return false;
    return writeChats(storage(), job.key, job.list, job.protect, options.onWarn);
  };

  const queue = (key: string, list: readonly PersistableChat[], protect: ReadonlySet<string>) => {
    if (pending && pending.key !== key) flush();
    if (pending) {
      pending.list = list;
      for (const id of protect) pending.protect.add(id);
    } else {
      pending = { key, list, protect: new Set(protect) };
    }
    if (!cancel) {
      cancel = schedule(() => {
        cancel = null;
        flush();
      });
    }
  };

  return { queue, flush, hasPending: () => pending !== null };
}

/**
 * Opening a chat should cost what is NEW, not what has ever happened in it.
 *
 * Today it costs the whole conversation: `replaySession` (chat-shell) re-reads
 * the eve session's entire NDJSON stream on every open and re-reduces it, and
 * because eve's stream is a live tail that never ends for a parked run, the
 * client also sits out a quiet window per segment to decide the backlog is
 * drained. A two-day thread pays all of that every single time it is clicked.
 *
 * A TRANSCRIPT SNAPSHOT is the cache that removes the re-read: the event prefix
 * the thread has already been shown, plus the ABSOLUTE stream index it covers,
 * stored per (workspace, eve session). A reopen mounts the prefix immediately
 * and replays only from that index forward.
 *
 * THREE DECISIONS THAT ARE NOT OBVIOUS, AND WHY
 *
 * 1. The snapshot stores EVENTS, not the projected messages.
 *
 *    The mount path is `useEveAgent({ initialEvents })` — there is no
 *    `initialMessages` — so projected messages could not be mounted without
 *    changing app/_components/agent-chat.tsx. But even with such a door, events
 *    are the right currency: the projection is produced by
 *    `withSessionEpochs(defaultMessageReducer())`, and the epoch counter lives
 *    in NON-ENUMERABLE state on the projection (lib/chat-turn-state.ts). JSON
 *    drops it. Mounting messages would restore a transcript whose epoch had
 *    silently reset to zero, so the first turn of a NEW session after a
 *    `session.completed` would reuse the old session's turn ids and merge into
 *    the old assistant message. Re-reducing the events rebuilds that state
 *    exactly, for free.
 *
 * 2. The prefix is COMPACTED first, because eve's text deltas are quadratic.
 *
 *    `message.appended` carries `messageSoFar` — the entire text so far — on
 *    every delta, so a 3,000-character answer streamed in 500 deltas is ~750KB
 *    of stream for 3KB of text. {@link compactTranscript} drops a delta only
 *    when the very next event overwrites the same projected part, which is
 *    provably invisible to the reducer (see its comment) and removes the whole
 *    quadratic term.
 *
 * 3. The snapshot is a CACHE. The event stream stays the truth.
 *
 *    Every reopen re-reads one event — the one at `eventIndex - 1` — and
 *    refuses the snapshot unless the stream agrees about it
 *    ({@link checkSeam}). A wrong session, a version bump, an index the stream
 *    cannot reach, or a seam that disagrees all fall back to the old full
 *    replay. The snapshot can make an open fast; it can never make it wrong.
 */

/**
 * Bumped whenever {@link compactTranscript} or the stored shape changes, so
 * snapshots written by an older build are discarded instead of mounted. It is
 * the only thing standing between a projection rule change and a transcript
 * rendered by rules that no longer exist.
 */
export const SNAPSHOT_VERSION = 1;

/** One line of the eve session stream, as much of it as this module reads. */
type StreamEvent = {
  type?: string;
  data?: { turnId?: unknown; stepIndex?: unknown; message?: unknown };
};

/**
 * A `client.*` event is SYNTHESIZED in the browser (`client.input.responded`,
 * `client.message.submitted`, `client.message.failed`) and has never been in the
 * server stream. It must not be counted when computing a stream index — eve
 * passes `streamIndex` straight through as the next `startIndex`, so counting a
 * marker the server never sent starts the next read late and real events go
 * missing (chat-shell says the same thing where it mounts).
 */
export function isClientEvent(event: unknown): boolean {
  const type = (event as StreamEvent)?.type;
  return typeof type === "string" && type.startsWith("client.");
}

/** Split a mounted stream into the server's events and the client's markers. */
export function splitClientEvents(events: readonly unknown[]): {
  server: unknown[];
  client: unknown[];
} {
  const server: unknown[] = [];
  const client: unknown[] = [];
  for (const e of events) (isClientEvent(e) ? client : server).push(e);
  return { server, client };
}

const APPENDED: Record<string, string> = {
  "message.appended": "message.completed",
  "reasoning.appended": "reasoning.completed",
};

const turnOf = (e: StreamEvent) => (typeof e?.data?.turnId === "string" ? e.data.turnId : undefined);
const stepOf = (e: StreamEvent) => (typeof e?.data?.stepIndex === "number" ? e.data.stepIndex : undefined);

/**
 * Drop the streaming deltas that the very next event overwrites.
 *
 * `message.appended` / `reasoning.appended` each carry the FULL text so far, and
 * the reducer projects them with `upsertPart` under a part key of
 * `text:<stepIndex>` / `reasoning:<stepIndex>` on the assistant message for
 * `turnId`. So when event i and event i+1 are two such events with the same
 * (kind, turnId, stepIndex) — or the delta is immediately followed by its own
 * `*.completed` — the second one REPLACES the first one's part in place and the
 * first leaves no trace in the projection:
 *
 *   - both call `ensureStepStartPart(stepIndex)` first, which is idempotent for
 *     the same index;
 *   - both `upsertPart` the same key, and `upsertPart` replaces at the existing
 *     position, so part ORDER is identical too;
 *   - both `updateAssistantMessage(turnId, …)`, so if the assistant message did
 *     not exist yet the later event creates it at the same place;
 *   - they are ADJACENT, so nothing observed the intermediate state.
 *
 * The one case that is NOT safe is `message.completed` with `message: null` —
 * that projects to `removeTextPart`, which only changes anything if a text part
 * exists, so the delta before it is load-bearing. It is excluded.
 *
 * This is where the size win comes from: deltas stream consecutively, so one
 * text block of N deltas collapses to one event, and the stream stops being
 * quadratic in the length of the answer.
 */
export function compactTranscript(events: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < events.length; i++) {
    const cur = events[i] as StreamEvent;
    const completedType = cur?.type ? APPENDED[cur.type] : undefined;
    if (completedType && i + 1 < events.length) {
      const next = events[i + 1] as StreamEvent;
      const sameSlot = turnOf(cur) === turnOf(next) && stepOf(cur) === stepOf(next);
      const supersededByDelta = sameSlot && next?.type === cur.type;
      const supersededByCompletion =
        sameSlot && next?.type === completedType && next?.data?.message !== null;
      if (supersededByDelta || supersededByCompletion) continue;
    }
    out.push(cur);
  }
  return out;
}

/**
 * Collapse exact-duplicate events.
 *
 * A clean stream has none, so this is never a correctness fix in the normal
 * case — but they DO accumulate: every persist re-appends the synthetic
 * `client.input.responded` markers (they never live in the store's own event
 * list), and a mid-stream reattach re-appends byte-identical turn events to it.
 * Left in, a bloated stream renders as duplicated, jumbled or blank messages on
 * reopen. Collapsing exact duplicates cannot change a clean stream's projection
 * — the reducer's `upsertPart` is keyed, so a byte-identical repeat writes the
 * same part to the same slot — and it keeps the persisted payload from
 * ballooning against the storage quota.
 *
 * First occurrence wins and order is preserved, which is what makes
 * {@link createEventDeduper} able to do this incrementally.
 */
export function dedupeEvents<T>(events: readonly T[] | undefined): T[] {
  if (!events?.length) return events ? [...events] : [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of events) {
    let key: string;
    try {
      key = JSON.stringify(e);
    } catch {
      out.push(e);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * The same answer, for the cost of what is NEW.
 *
 * `handlePersist` is the only persistence that runs during a live conversation,
 * and it ran {@link dedupeEvents} over the WHOLE event list on every call —
 * which is once per text delta. eve's deltas each carry `messageSoFar`, the
 * entire answer so far, so that is a `JSON.stringify` of a quadratically-growing
 * stream, on the main thread, between a keystroke of output and the paint that
 * shows it. Measured at 1,500 events it is the largest single blocking cost in
 * the turn.
 *
 * A LIVE turn only ever APPENDS to the store's event array, and the array
 * elements are stable references, so the previous call's answer is still the
 * right answer for the prefix — first-occurrence-wins means an earlier decision
 * can never be revised by a later event. So: check the prefix by REFERENCE
 * (no stringify at all), and stringify only the events that arrived since.
 * Anything that is not an append — a remount, a resync, a replaced array — falls
 * back to the full pass, so the OUTPUT is always identical to calling
 * {@link dedupeEvents} directly. That equivalence is executed in
 * scripts/test-thread-snapshot.mjs rather than asserted here.
 *
 * One deduper per mounted chat; a new mount gets a new one, which is also what
 * makes the fallback safe.
 */
export function createEventDeduper<T>(): (events: readonly T[] | undefined) => T[] {
  let source: readonly T[] | undefined;
  let result: T[] = [];
  let seen = new Set<string>();

  const full = (events: readonly T[]) => {
    seen = new Set<string>();
    result = [];
    for (const e of events) add(e);
  };
  const add = (e: T) => {
    let key: string;
    try {
      key = JSON.stringify(e);
    } catch {
      result.push(e);
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    result.push(e);
  };
  /** Is `prev` the same array, element for element, as the head of `next`? */
  const extendsPrefix = (prev: readonly T[], next: readonly T[]): boolean => {
    if (next.length < prev.length) return false;
    for (let i = 0; i < prev.length; i++) if (prev[i] !== next[i]) return false;
    return true;
  };

  return (events) => {
    if (!events?.length) {
      source = events;
      result = [];
      seen = new Set<string>();
      return events ? [] : [];
    }
    if (source && extendsPrefix(source, events)) {
      for (let i = source.length; i < events.length; i++) add(events[i]);
    } else {
      full(events);
    }
    source = events;
    // A copy, because the caller stores what it is given and the next call
    // appends to `result` in place.
    return [...result];
  };
}

/**
 * JSON with object keys sorted, at every depth.
 *
 * Needed because the snapshot round-trips through a Postgres `jsonb` column,
 * and jsonb NORMALIZES object key order (shortest key first, then bytewise). A
 * stored event therefore comes back with its keys rearranged, so `JSON.stringify`
 * equality against a freshly-streamed copy of the same event is false for two
 * byte-identical events. That equality is exactly what the seam check needs, so
 * it compares canonical forms instead. The projection itself does not care about
 * key order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Are these the same stream event, ignoring key order? */
export function sameEvent(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * What is stored per (workspace, eve session). `eventIndex` is ABSOLUTE — the
 * count of events the server has emitted that this transcript covers — and is
 * deliberately NOT `events.length`: compaction makes the transcript shorter than
 * the stream it represents, and the resume cursor has to mean the stream.
 *
 * The continuation token is NOT here. It already lives on the row that owns
 * custody of it (`chat_sessions` for your own chats, `chat_threads` for a shared
 * one, where it must never reach a reader), and a cache is the last place to
 * make a second copy of a resume capability.
 */
export interface TranscriptSnapshot {
  readonly version: number;
  readonly eveSessionId: string;
  readonly eventIndex: number;
  readonly events: readonly unknown[];
  /** The browser-only markers (answered questions/approvals) — see isClientEvent. */
  readonly clientEvents: readonly unknown[];
  readonly updatedAt?: number;
}

/**
 * Build the snapshot for a mounted chat, or null when there is nothing worth
 * storing.
 *
 * `streamIndex` is the eve store's own cursor (`advanceSession`), which only
 * moves at a turn boundary — which is precisely when this is called, and why the
 * stored index is always a boundary the stream can be resumed from.
 */
export function buildSnapshot(input: {
  readonly eveSessionId: string | undefined;
  readonly streamIndex: number | undefined;
  readonly events: readonly unknown[] | undefined;
}): TranscriptSnapshot | null {
  const { eveSessionId, streamIndex, events } = input;
  if (!eveSessionId || !events?.length) return null;
  if (typeof streamIndex !== "number" || !Number.isFinite(streamIndex) || streamIndex <= 0) return null;
  const { server, client } = splitClientEvents(events);
  if (!server.length) return null;
  return {
    version: SNAPSHOT_VERSION,
    eveSessionId,
    eventIndex: streamIndex,
    events: compactTranscript(server),
    clientEvents: client,
    updatedAt: Date.now(),
  };
}

/**
 * Is this snapshot even a candidate for the session about to be mounted?
 *
 * The cheap half of the decision, made before anything is painted: the right
 * shape, the right projection rules, and the same eve session. The expensive
 * half — does the STREAM agree — is {@link checkSeam}, which costs one event.
 */
export function snapshotUsable(
  snapshot: TranscriptSnapshot | null | undefined,
  expected: { readonly eveSessionId: string | undefined },
): snapshot is TranscriptSnapshot {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (snapshot.version !== SNAPSHOT_VERSION) return false;
  if (!Array.isArray(snapshot.events) || snapshot.events.length === 0) return false;
  if (!Number.isInteger(snapshot.eventIndex) || snapshot.eventIndex < 1) return false;
  // A transcript cannot cover more events than it contains lines for... but it
  // CAN cover more than it stores, because compaction drops superseded deltas.
  // The one thing that is impossible is the other direction.
  if (snapshot.events.length > snapshot.eventIndex) return false;
  if (!snapshot.eveSessionId || snapshot.eveSessionId !== expected.eveSessionId) return false;
  return true;
}

/**
 * Does the stream agree with the snapshot where they meet?
 *
 * The tail is read from `eventIndex - 1`, one event EARLIER than needed, so the
 * first event it returns is the last event the snapshot claims to cover. Three
 * outcomes:
 *
 *   `behind`    the stream returned nothing at all at that index — the snapshot
 *               claims events the session does not have (a re-minted session, a
 *               restored database, a snapshot from a fork). Discard it.
 *   `mismatch`  the stream's event at that index is a different event. Same
 *               conclusion, louder.
 *   `match`     the seam holds; `tail` is the genuinely new events.
 *
 * This verifies the SEAM, not every earlier event — verifying all of them is the
 * full replay this exists to avoid. It is the strongest check available for the
 * price of one event, and it catches every drift mode that has an index in it.
 */
export function checkSeam(
  snapshot: TranscriptSnapshot,
  replayedFromIndexMinusOne: readonly unknown[] | null | undefined,
): { readonly status: "behind" | "match" | "mismatch"; readonly tail: readonly unknown[] } {
  const read = replayedFromIndexMinusOne ?? [];
  if (read.length === 0) return { status: "behind", tail: [] };
  const last = snapshot.events[snapshot.events.length - 1];
  if (!sameEvent(read[0], last)) return { status: "mismatch", tail: [] };
  return { status: "match", tail: read.slice(1) };
}

/**
 * The mount: the snapshot's transcript, the new events after it, and the
 * browser-only markers last.
 *
 * Markers go at the END for the same reason the full-replay path puts them
 * there — they answer questions raised earlier in the stream, and the reducer
 * resolves them by request id rather than by position. The snapshot's own
 * markers are unioned with whatever this browser still has cached, so answering
 * a question on one device does not un-answer it on another.
 */
export function mountFromSnapshot(
  snapshot: TranscriptSnapshot,
  tail: readonly unknown[],
  localClientEvents: readonly unknown[] = [],
): { events: unknown[]; streamIndex: number } {
  const markers: unknown[] = [];
  const seen = new Set<string>();
  for (const m of [...snapshot.clientEvents, ...localClientEvents]) {
    const key = canonicalJson(m);
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push(m);
  }
  return {
    events: [...snapshot.events, ...tail, ...markers],
    streamIndex: snapshot.eventIndex + tail.length,
  };
}

/**
 * May this caller read the snapshot for a session?
 *
 * The decision is pure so it can be tested without a database, and so the two
 * routes that need it cannot drift apart. The inputs are already
 * workspace-scoped reads (`withOrgRls`), so this decides ACCESS, never tenancy:
 * a row from another workspace is invisible to the query that would feed this.
 *
 * - `thread` is the `chat_threads` row for the session, when one exists (a
 *   thread only gets one once it is SHARED).
 * - `membership` is the caller's non-revoked `chat_thread_members` row on it.
 * - `ownsMirrorRow` is true when the caller owns the `chat_sessions` row for
 *   this session AND is the only person claiming it — an ordinary private chat
 *   of their own. The "only person" half is load-bearing: writing such a row
 *   for an arbitrary session id was a POST away, so a claim that is not
 *   exclusive is a claim that proves nothing.
 *
 * The order matters: once a thread row exists it OWNS the access decision, so a
 * revoked member cannot fall back to "well, I have a mirror row for it" and keep
 * reading a transcript they were cut off from.
 */
export function snapshotAccess(input: {
  readonly callerEmail: string;
  readonly thread: { readonly ownerEmail: string } | null | undefined;
  readonly membership: { readonly role?: string; readonly status?: string } | null | undefined;
  readonly ownsMirrorRow: boolean;
}): { readonly read: boolean; readonly write: boolean } {
  const me = input.callerEmail.trim().toLowerCase();
  if (!me) return { read: false, write: false };
  if (input.thread) {
    if (input.thread.ownerEmail.toLowerCase() === me) return { read: true, write: true };
    const m = input.membership;
    if (!m || m.status === "revoked") return { read: false, write: false };
    /**
     * A member may READ the cached transcript — it is the same transcript the
     * stream proxy already hands them — and NOBODY but the owner may replace
     * it. This used to read `write: m.role === "participant"`.
     *
     * The choice was between verifying more of a submitted transcript and
     * narrowing who may submit one, and verification cannot be made to work
     * here. `POST /api/ops/chat-snapshots` takes `events` as arbitrary client
     * JSON, and {@link checkSeam} re-reads exactly ONE event: the one the
     * snapshot claims to end on. Everything before that seam is unverified, and
     * length proves nothing either, because {@link compactTranscript}
     * deliberately makes the stored transcript shorter than the stream it
     * covers. Verifying several seam events moves the line without changing the
     * shape — an author who controls the prefix can always put a true tail on a
     * fabricated body, and the body is what a reader mounts. The only check
     * that would actually hold is replaying the whole stream and comparing it,
     * which is exactly the cost this cache exists to remove.
     *
     * So: one writer, the person whose conversation it is. A participant loses
     * only speed — their open falls back to the bounded replay, which is what
     * every open did before this cache existed — and they still READ the cache
     * the owner writes. Nobody else decides what everyone in a shared thread
     * sees when they open it.
     */
    return { read: true, write: false };
  }
  // No thread row: an unshared chat. It is yours or it is nobody's — and
  // `ownsMirrorRow` now means the caller is the ONLY claimant (see
  // lib/chat-session-access.ts), because minting a claim used to be a POST away.
  return { read: input.ownsMirrorRow, write: input.ownsMirrorRow };
}

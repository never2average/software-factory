/**
 * A SAVED COPY OF ONE SPECIALIST'S FEED: the rules the Control Panel (lib/child-feed.ts) and the route that stores it
 * (app/api/ops/chat-snapshots, `kind=child`) share. Pure, and free of the eve client, so the route can import it.
 *
 * WHY. A finished specialist's details (its rows, the files and apps it made, its nested specialists) exist only on
 * its own stream, and reading that stream from event 0 cost 9.4 MB to over 147 MB and 13.6 s to over 85 s per
 * specialist, once per page load (onfinance_hfc, 2026-10-13). The fold (lib/child-feed.ts `ChildFold`) already keeps
 * only the events that change what is shown (98.6% of the bytes were superseded reasoning deltas). A copy is those
 * kept events with their ABSOLUTE stream index, plus the cursor, taken at a session boundary; folding it again gives
 * the same rows, messages and nested specialists as folding the whole stream (scripts/test-child-feed.mjs, section 13).
 *
 * WHAT IS NOT IN IT. The resume token: `session.waiting` carries `continuationToken`, and a cache is the last place to
 * keep a second copy of a resume capability (lib/chat-snapshot.ts says the same of the parent's copy). It is stripped
 * before the copy is written; the seam read (the one event at `cursor - 1`, which IS that `session.waiting`) hands it
 * back to the fold, so a parked specialist can still be steered.
 *
 * THE SEAM. A copy is a cache; the stream stays the truth. Every open reads the specialist from `cursor - 1` and
 * compares that first event with the copy's last one, with the parent's rules (lib/chat-snapshot.ts `seamVerdict`):
 * match keeps it, a different event replaces it, a closed stream with nothing there retries once and then replaces
 * it, silence or an error retries once and then keeps it.
 */
import { canonicalJson, seamVerdict, SNAPSHOT_VERSION, type SeamRead, type TranscriptSnapshot } from "./chat-snapshot.ts";

/** Bumped whenever the fold's projection or the stored shape changes: an older copy is then discarded, not folded. */
export const CHILD_COPY_VERSION = 1;

/**
 * A ceiling on one copy, the same as the parent's (MAX_SNAPSHOT_BYTES in the route). A copy past it is never sent:
 * that specialist keeps today's read from event 0, slow but exactly as slow as before, which is the right way for a
 * cache to fail.
 */
export const CHILD_COPY_MAX_BYTES = 4_000_000;

/**
 * Where a copy is kept: the parent's table (chat_transcript_snapshots, same workspace scope and row-level security),
 * under its own key. The prefix keeps the two kinds of row from ever being read as each other: the chat's own open
 * reads `eve_session_id = <session>`, and no eve session id starts with this.
 */
export const CHILD_COPY_PREFIX = "child:";
export const childCopyKey = (sessionId: string): string => `${CHILD_COPY_PREFIX}${sessionId}`;

/**
 * One kept event, as JSON TEXT, and its absolute index in the specialist's stream (row ids are derived from it).
 *
 * Text, not an object, because the copy round-trips through a Postgres `jsonb` column and jsonb REORDERS object keys
 * (shortest first). Key order is visible here: a tool row's one-line summary is the first string field of the call's
 * input when the tool has no rule of its own (app/_components/tool-display.ts `toolCallSummary`), so a reordered event
 * would fold into a different row than the stream does. A string comes back byte for byte.
 */
export interface ChildCopyEvent {
  readonly i: number;
  readonly line: string;
}

export interface ChildCopy {
  readonly version: number;
  /** The specialist's own (child) eve session id. */
  readonly sessionId: string;
  /** The absolute index of the next event to read: every event below it is covered. */
  readonly cursor: number;
  readonly events: readonly ChildCopyEvent[];
}

type Loose = { type?: unknown; data?: Record<string, unknown> | null };

/** The event as a copy stores it: a `session.waiting` without its resume token. Anything else, unchanged. */
export function storedForm(event: unknown): unknown {
  const e = event as Loose;
  if (e?.type !== "session.waiting" || !e.data || typeof e.data !== "object" || !("continuationToken" in e.data)) return event;
  const data: Record<string, unknown> = { ...e.data };
  delete data.continuationToken;
  return { ...(event as object), data };
}

/**
 * Is this copy well formed, for this session, by these rules? Used by the panel before folding a copy, and by the
 * route before storing one (a payload that fails it did not come from this system's writer).
 */
export function childCopyUsable(copy: unknown, sessionId: string): copy is ChildCopy {
  const c = copy as ChildCopy | null | undefined;
  if (!c || typeof c !== "object") return false;
  if (c.version !== CHILD_COPY_VERSION) return false;
  if (!sessionId || c.sessionId !== sessionId) return false;
  if (!Number.isInteger(c.cursor) || c.cursor < 1) return false;
  if (!Array.isArray(c.events) || c.events.length === 0 || c.events.length > c.cursor) return false;
  let prev = -1;
  for (const k of c.events) {
    if (!k || typeof k !== "object" || !Number.isInteger(k.i) || k.i <= prev || k.i >= c.cursor) return false;
    if (typeof k.line !== "string" || !k.line) return false;
    prev = k.i;
  }
  // Taken at a session boundary, so the last kept event is the boundary itself: the event the seam read compares.
  const lastType = (parseLine(c.events[c.events.length - 1].line) as Loose | null)?.type;
  return lastType === "session.waiting" || lastType === "session.completed" || lastType === "session.failed";
}

/** A kept line, parsed; null when it is not a JSON object. */
export function parseLine(line: string): unknown {
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Bytes of a copy as the route counts them. */
export function childCopyBytes(copy: Pick<ChildCopy, "events">): number {
  const json = JSON.stringify(copy.events);
  return typeof Buffer !== "undefined" ? Buffer.byteLength(json) : new TextEncoder().encode(json).byteLength;
}

/**
 * What the stream said about a copy, by the parent's rules ({@link seamVerdict}): `read.events` is what the read from
 * `cursor - 1` returned (its first event is the seam). Compared in stored form, so the token the stream carries and
 * the copy does not is not a difference.
 */
export function childSeamVerdict(copy: ChildCopy, read: SeamRead | null | undefined, attempt = 1) {
  const last = copy.events[copy.events.length - 1];
  const asSnapshot: TranscriptSnapshot = {
    version: SNAPSHOT_VERSION,
    eveSessionId: copy.sessionId,
    eventIndex: copy.cursor,
    events: [storedForm(parseLine(last.line))],
    clientEvents: [],
  };
  const stored = read ? { ...read, events: read.events.map((e, k) => (k === 0 ? storedForm(e) : e)) } : read;
  return seamVerdict(asSnapshot, stored, attempt);
}

/** Are these the same event as a copy stores it? */
export function sameStoredEvent(a: unknown, b: unknown): boolean {
  return canonicalJson(storedForm(a)) === canonicalJson(storedForm(b));
}

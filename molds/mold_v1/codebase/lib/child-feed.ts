/**
 * THE CONTROL PANEL'S SPECIALIST FEEDS, OUTSIDE REACT.
 *
 * A chat's Control Panel (app/_components/cockpit.tsx, open by default) reads every delegated specialist's OWN session
 * stream: the parent only says `subagent.called` + `childSessionId`, and everything the specialist did (its tool calls,
 * the files, crons, apps and nested specialists it created, its resume token) exists only on that stream.
 *
 * WHAT THIS REPLACES, MEASURED (onfinance_hfc, 2026-10-13, 12 specialist streams in the operator's 7 chats):
 *
 *   - Every chat open re-read every specialist's stream from event 0: 9.4 MB to over 147 MB each (3,038 to 18,870
 *     events), 13.6 s to over 85 s per specialist, because the read cursor lived in a `useRef` that a remount empties.
 *   - 98.6% of those bytes were `reasoning.appended` deltas, each carrying the WHOLE reasoning text so far.
 *   - Each line was parsed and folded with its own `setFeeds`; about one event arrived per network read, so that was
 *     about 10,000 Control Panel renders per specialist, each re-deriving the specialist's insights.
 *   - 6 of the 12 streams returned no response headers in 60-240 s, and nothing gave up on them.
 *   - All of it started the moment the chat mounted, beside the chat's own reads.
 *
 * WHAT THIS DOES INSTEAD
 *
 *   (a) A finished specialist is harvested only once the chat says the conversation is up (`ready`), through a pool of
 *       {@link DEFAULT_POOL} at a time. A running or selected one ("live") attaches at once, as before, and so does a
 *       PARKED one ("priority": the parent shows its question): its resume token comes only from its own
 *       `session.waiting`, so steering must not wait behind a queue. A harvest frees its slot at a session boundary,
 *       OR when it has gone quiet (a stream that ends on `input.requested` or mid-reasoning has no boundary at all, and
 *       a pool that waited for one would stall behind it).
 *   (b) The fold runs here, not in a state updater, and the panel hears about it at most once per
 *       {@link FLUSH_MS} (a timer, not animation frames: those stop in a background tab). A cumulative delta that the
 *       very next line supersedes (the {@link compactTranscript} rule, lib/chat-snapshot.ts) is never parsed at all, so
 *       the fold no longer builds a 50 KB string per line only to throw it away.
 *   (c) The folded state and its absolute cursor live TOGETHER in one {@link ChildFold}, in a module-level cache keyed
 *       by workspace and session, bounded by size (least recently used goes first). A remount, a resync or a chat
 *       switch picks the fold up where it stopped: a finished specialist costs no request at all, an interrupted one
 *       resumes at its cursor, never at 0. (A cursor stored without its fold dropped history; a fold resumed at 0
 *       appended every tool row a second time: the recorded fault this module exists not to repeat.)
 *   (d) A harvest that gets no response headers in {@link HEADER_DEADLINE_MS} is retried once, then shown as
 *       "unavailable" with a retry control. Never a live one: a running specialist the parent still shows as running
 *       is never given up on by a timer, and "unavailable" is never read as "ended" for it (cockpit.tsx).
 *
 * Nothing here touches what the server stores. A saved copy per specialist (so even the FIRST open of a page does not
 * read the raw stream) is the next step; it needs (1) the specialist's compacted events plus its absolute index from
 * this fold at a boundary, (2) the snapshot route to admit a child session for its root's owner, (3) the parked and
 * running cases still read live from the stored index.
 */
import { defaultMessageReducer } from "eve/client";
import type { EveMessage } from "eve/react";
import { withSessionEpochs, type TurnEvent } from "./chat-turn-state.ts";
import { SESSION_DELEGATION_HEADER, delegationFromHeader } from "./specialist-run-actions.ts";
import type { SpecialistStreamOutcome, SpecialistStreamProbe } from "./chat-open-timing.ts";

/* ================================================================================================================ */
/* The feed a panel renders.                                                                                         */
/* ================================================================================================================ */

/** One row of a child session's live feed. Tool rows COALESCE: the request creates a running row, its result flips
 *  the same row to done, never two lines for one call. */
export type FeedRow =
  | { kind: "step"; id: string; label: string }
  | {
      kind: "tool";
      id: string;
      /** Raw tool name, kept for result-matching; display uses toolDisplayName. */
      raw: string;
      summary: string | null;
      status: "running" | "done";
    }
  | { kind: "reply"; id: string; text: string }
  | {
      kind: "wait";
      id: string;
      text: string;
      request?: { requestId: string; prompt: string; options: { id: string; label: string }[] };
    }
  | { kind: "note"; id: string; text: string };

export type FeedStatus = "idle" | "live" | "ended" | "unavailable";

/** How a panel wants a session read. */
export type FeedMode =
  /** Stay connected: a running specialist (its row counts tool calls as they happen) or the one open in the rail. */
  | "live"
  /** Read now, ahead of the queue and before the chat is ready: a parked specialist, whose token steering needs. */
  | "priority"
  /** Read once the chat is ready, a few at a time, then let go: a finished specialist. */
  | "harvest";

const MODE_RANK: Record<FeedMode, number> = { harvest: 0, priority: 1, live: 2 };

// The SAME reducer the main chat mounts (agent-chat.tsx): eve's message reducer inside `withSessionEpochs`. reduce()
// is pure, so one shared instance is fine, but the wrappers keep their state on the reducer's DATA object
// (non-enumerable), so each feed folds onto its own previous transcript, never onto a rebuilt `{ messages }`.
const childReducer = withSessionEpochs(defaultMessageReducer() as never) as unknown as {
  initial(): ChildTranscript;
  reduce(data: ChildTranscript, event: TurnEvent): ChildTranscript;
};
export type ChildTranscript = { messages: EveMessage[] };

export interface ChildFeed {
  rows: FeedRow[];
  /** Real reduced messages (eve reducer) for the detail transcript, rendered by AgentMessage exactly as the main
   *  chat. `rows` stays for the list's live tool-call counts. */
  messages: EveMessage[];
  /** The reducer's own projection `messages` is read from. Kept whole: it carries the wrappers' step/epoch state. */
  transcript?: ChildTranscript;
  /** Local rail meta-notes (steer sent, cancel/resume, dead-run), not part of the model transcript. */
  notes: { id: string; text: string }[];
  status: FeedStatus;
  /** True while a turn is running (turn.started seen without a later turn.completed/failed). Undefined = unknown. */
  turnActive?: boolean;
  /** The child session emitted session.completed: genuinely done, NOT merely parked (session.waiting). */
  completed?: boolean;
  /** The agent's word on whether this session is a delegation (`x-eve-session-delegation`). */
  delegated?: boolean;
  /** Its last turn was cancelled (`turn.cancelled`, cleared by the next `turn.started`). */
  stopped?: boolean;
  /** The child session's resume handle (from its session.waiting events). Latest one seen wins. */
  continuationToken?: string;
  /** Sessions this child delegated to in turn (from its own `subagent.called` events). */
  childSessions: string[];
}

/**
 * What one specialist's reads have cost over this page's life (requests, bytes, time to headers, time to settle).
 * The per-OPEN figures are the chat-open record's `specialists` (lib/chat-open-timing.ts), fed through the probe.
 */
export interface ChildFeedStats {
  readonly sessionId: string;
  /** Stream requests made for this session in this page's life (0 for a fold served from the cache). */
  readonly requests: number;
  /** Bytes of stream read (after the browser decoded any compression). */
  readonly bytes: number;
  /** First request to its first response headers, ms; null before any headers. */
  readonly timeToHeadersMs: number | null;
  /** First request to the feed settling (a boundary, a quiet end, or "unavailable"), ms; null until then. */
  readonly timeToSettleMs: number | null;
  /** Events the fold skipped unparsed (superseded cumulative deltas). */
  readonly skippedEvents: number;
  readonly status: FeedStatus;
}

/** How one read of a specialist's stream ended: the chat-open record's own outcomes (lib/chat-open-timing.ts). */
export type ChildFeedOutcome = Exclude<SpecialistStreamOutcome, "pending">;

/**
 * A per-read reporter: the chat-open record's `SpecialistStreamProbe` (lib/chat-open-timing.ts). The store asks for
 * one when a read starts and calls it as the read goes; the default does nothing. The Control Panel passes
 * `probe: (sid, live) => specialistStream(sid, { live })` (app/_components/cockpit.tsx `feedStore`), so every open's
 * record carries what each specialist's reads cost during its window.
 */
export type ChildFeedProbe = SpecialistStreamProbe;
const NO_PROBE: ChildFeedProbe = { request() {}, headers() {}, bytes() {}, settle() {} };

/* ================================================================================================================ */
/* Rows.                                                                                                             */
/* ================================================================================================================ */

type LooseEvent = { type?: string; data?: Record<string, unknown> };

/** Fold one child-session stream event into the rows. `nextId` names a row with no id of its own; the fold passes ids
 *  derived from the event's absolute index, so a resumed fold and a fold from 0 name every row alike. */
export function applyFeedEvent(
  rows: FeedRow[],
  e: LooseEvent,
  nextId: () => string,
  summarize: (toolName: string, input: unknown) => string | null,
): FeedRow[] {
  const d = e.data ?? {};
  switch (e.type) {
    case "step.started": {
      const label = `Step ${Number(d.stepIndex ?? 0) + 1}`;
      return [...rows, { kind: "step", id: nextId(), label }];
    }
    case "actions.requested": {
      const actions = Array.isArray(d.actions) ? (d.actions as Array<Record<string, unknown>>) : [];
      const added: FeedRow[] = actions
        .map((a): FeedRow | null => {
          const raw = a.toolName ?? a.name;
          if (typeof raw !== "string") return null;
          const callId = a.toolCallId ?? a.callId ?? a.id;
          return {
            kind: "tool",
            id: typeof callId === "string" ? callId : nextId(),
            raw,
            summary: summarize(raw, a.input ?? a.args ?? null),
            status: "running",
          };
        })
        .filter((r): r is FeedRow => r !== null);
      return added.length ? [...rows, ...added] : rows;
    }
    case "action.result": {
      const r = (d.result ?? {}) as Record<string, unknown>;
      const callId = r.toolCallId ?? r.callId;
      const raw = typeof r.toolName === "string" ? r.toolName : null;
      // Flip the matching running row: by call id first, else the OLDEST running row with the same tool name.
      let idx = -1;
      if (typeof callId === "string") idx = rows.findIndex((row) => row.kind === "tool" && row.id === callId);
      if (idx === -1 && raw) {
        idx = rows.findIndex((row) => row.kind === "tool" && row.status === "running" && row.raw === raw);
      }
      if (idx === -1) {
        return raw ? [...rows, { kind: "tool", id: nextId(), raw, summary: null, status: "done" }] : rows;
      }
      const next = [...rows];
      next[idx] = { ...(next[idx] as Extract<FeedRow, { kind: "tool" }>), status: "done" };
      return next;
    }
    case "message.completed": {
      const msg = typeof d.message === "string" ? d.message.trim() : "";
      if (!msg) return rows;
      return [...rows, { kind: "reply", id: nextId(), text: msg.length > 140 ? `${msg.slice(0, 140)}…` : msg }];
    }
    case "input.requested": {
      const first = (Array.isArray(d.requests) ? d.requests[0] : undefined) as
        | { requestId?: unknown; prompt?: unknown; options?: unknown }
        | undefined;
      const request =
        first && typeof first.requestId === "string"
          ? {
              requestId: first.requestId,
              prompt: typeof first.prompt === "string" ? first.prompt : "Approval requested",
              options: Array.isArray(first.options)
                ? (first.options as { id?: unknown; label?: unknown }[])
                    .filter((o) => typeof o?.id === "string")
                    .map((o) => ({ id: o.id as string, label: typeof o.label === "string" ? o.label : (o.id as string) }))
                : [],
            }
          : undefined;
      return [...rows, { kind: "wait", id: nextId(), text: "Waiting for approval", request }];
    }
    case "subagent.called":
      return [...rows, { kind: "note", id: nextId(), text: "Delegated further" }];
    case "turn.completed":
      return [...rows, { kind: "note", id: nextId(), text: "Turn finished" }];
    case "step.failed":
    case "turn.failed":
    case "session.failed": {
      // Every failure event carries the reason on the wire (`{ code, message, details? }`). Surface it instead of a
      // bare "Failed"; fall back only when the wire is empty.
      const code = typeof d.code === "string" ? d.code : null;
      const msg = typeof d.message === "string" ? d.message.trim() : "";
      const reason = [code, msg].filter(Boolean).join(": ");
      const detail = reason ? (reason.length > 140 ? `${reason.slice(0, 140)}…` : reason) : "no error detail from the stream";
      const text = `⚠ Failed — ${detail}`;
      // A crash emits step.failed → turn.failed → session.failed with the SAME message: one row, not three.
      const last = rows[rows.length - 1];
      if (last?.kind === "note" && last.text === text) return rows;
      return [...rows, { kind: "note", id: nextId(), text }];
    }
    default:
      return rows;
  }
}

/** The rail keeps the newest rows only. */
export const MAX_FEED_ROWS = 150;

/* ================================================================================================================ */
/* The fold: state and cursor, together.                                                                             */
/* ================================================================================================================ */

const APPENDED: Record<string, string> = {
  "message.appended": "message.completed",
  "reasoning.appended": "reasoning.completed",
};

interface DeltaSlot {
  readonly kind: string;
  readonly turnId: string | undefined;
  readonly stepIndex: number | undefined;
}

/** The type at the END of a line, as eve writes it (`…},"type":"reasoning.appended","meta":{"at":"…"}}`). */
const DELTA_TAIL = /"type":"(reasoning\.appended|message\.appended)"(?:,"meta":\{[^{}]*\})?\}\s*$/;
/** …or at its start, should a writer put it first. */
const DELTA_HEAD = /^\s*\{"type":"(reasoning\.appended|message\.appended)"/;
const TAIL_CHARS = 512;

/**
 * Is this line a cumulative delta, and for which slot, WITHOUT parsing it?
 *
 * A `reasoning.appended` line is up to tens of KB, almost all of it `reasoningSoFar`, and the fold only ever needs the
 * LAST of a run of them. The type and the slot are in the last few hundred characters, so they are read from there.
 * A structural `"key":` cannot occur inside a JSON string (its quotes are escaped there), so a match is the line's
 * own field. Anything not certain (a missing turn id or step) answers null and the line is parsed as usual: the peek
 * only ever decides to SKIP, and folding a line is always correct.
 */
export function peekDelta(line: string): DeltaSlot | null {
  const tail = line.length > TAIL_CHARS ? line.slice(-TAIL_CHARS) : line;
  const kind = DELTA_TAIL.exec(tail)?.[1] ?? DELTA_HEAD.exec(line.slice(0, 64))?.[1];
  if (!kind) return null;
  let turnId: string | undefined;
  let stepIndex: number | undefined;
  for (const m of tail.matchAll(/"turnId":"([^"\\]*)"/g)) turnId = m[1];
  for (const m of tail.matchAll(/"stepIndex":(\d+)[,}]/g)) stepIndex = Number(m[1]);
  if (turnId === undefined || stepIndex === undefined) return null;
  return { kind, turnId, stepIndex };
}

const slotOf = (e: LooseEvent): DeltaSlot | null => {
  if (!e?.type || !APPENDED[e.type]) return null;
  const d = e.data ?? {};
  return {
    kind: e.type,
    turnId: typeof d.turnId === "string" ? d.turnId : undefined,
    stepIndex: typeof d.stepIndex === "number" ? d.stepIndex : undefined,
  };
};
const sameSlot = (a: DeltaSlot, b: { turnId: string | undefined; stepIndex: number | undefined }) =>
  a.turnId === b.turnId && a.stepIndex === b.stepIndex;

/** A delta held back until the next line says whether it is superseded. */
interface Held extends DeltaSlot {
  readonly index: number;
  readonly line?: string;
  readonly event?: LooseEvent;
}

/** What one line meant to the reader. */
export interface LineEffect {
  readonly type: string | undefined;
  /** A session boundary: the session parked (`waiting`), finished (`completed`) or failed. */
  readonly boundary: "waiting" | "completed" | "failed" | null;
}

export interface FoldView {
  readonly rows: FeedRow[];
  readonly messages: EveMessage[];
  readonly transcript: ChildTranscript;
  readonly turnActive?: boolean;
  readonly completed?: boolean;
  readonly stopped?: boolean;
  readonly continuationToken?: string;
  readonly childSessions: string[];
}

export interface FoldOptions {
  /** One-line summary of a tool call's input (app/_components/tool-display.ts `toolCallSummary`). */
  readonly summarize?: (toolName: string, input: unknown) => string | null;
  /** Off: fold every delta (the reference the parity test compares against). */
  readonly skipSuperseded?: boolean;
}

/**
 * A specialist's folded stream and the absolute index it has read to, in ONE object, so they can never be stored or
 * restored apart. `cursor` counts every non-empty line, including one that does not parse: `startIndex` is an
 * absolute event count, and undercounting replays events already folded.
 */
export class ChildFold {
  /** The absolute index of the next line to read: the `startIndex` a resumed read asks for. */
  cursor = 0;
  /** Lines read but never parsed: deltas the next line superseded. */
  skipped = 0;
  /** Characters of the lines that were folded: a rough measure of what the fold holds. */
  foldedChars = 0;
  private held: Held | null = null;
  private transcript: ChildTranscript = childReducer.initial();
  private rows: FeedRow[] = [];
  private turnActive: boolean | undefined;
  private completed: boolean | undefined;
  private stopped: boolean | undefined;
  private continuationToken: string | undefined;
  private childSessions: string[] = [];
  private version = 0;
  private viewed = -1;
  private lastView: FoldView | null = null;
  private readonly summarize: (toolName: string, input: unknown) => string | null;
  private readonly skip: boolean;

  constructor(options: FoldOptions = {}) {
    this.summarize = options.summarize ?? (() => null);
    this.skip = options.skipSuperseded !== false;
  }

  /** Read one NDJSON line (without its newline). Empty lines occupy no position. */
  push(line: string): LineEffect {
    if (!line.trim()) return { type: undefined, boundary: null };
    const index = this.cursor++;
    if (this.skip) {
      const peeked = peekDelta(line);
      if (peeked) {
        this.holdDelta({ ...peeked, index, line });
        return { type: peeked.kind, boundary: null };
      }
    }
    let event: LooseEvent;
    try {
      event = JSON.parse(line) as LooseEvent;
    } catch {
      this.foldHeld();
      return { type: undefined, boundary: null };
    }
    this.foldedChars += line.length;
    const slot = this.skip ? slotOf(event) : null;
    if (slot) {
      this.holdDelta({ ...slot, index, event });
      return { type: event.type, boundary: null };
    }
    if (this.held) {
      // Superseded by its own completion (`message.completed` with `message: null` is NOT a completion that covers
      // the delta: it removes the text part, so the delta before it is load-bearing).
      const done = APPENDED[this.held.kind];
      const d = event.data ?? {};
      const covers =
        event.type === done &&
        sameSlot(this.held, {
          turnId: typeof d.turnId === "string" ? d.turnId : undefined,
          stepIndex: typeof d.stepIndex === "number" ? d.stepIndex : undefined,
        }) &&
        d.message !== null;
      if (covers) {
        this.held = null;
        this.skipped++;
      } else {
        this.foldHeld();
      }
    }
    this.apply(event, index);
    const boundary =
      event.type === "session.waiting"
        ? "waiting"
        : event.type === "session.completed"
          ? "completed"
          : event.type === "session.failed"
            ? "failed"
            : null;
    return { type: event.type, boundary };
  }

  /** Fold a held delta now (a flush, the end of a read, an abort): it is no longer known to be superseded. */
  foldHeld(): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    let event = held.event;
    if (!event && held.line !== undefined) {
      try {
        event = JSON.parse(held.line) as LooseEvent;
        this.foldedChars += held.line.length;
      } catch {
        return;
      }
    }
    if (event) this.apply(event, held.index);
  }

  /** The folded state, held delta included. Returns the same object until something changes. */
  view(): FoldView {
    this.foldHeld();
    if (this.lastView && this.viewed === this.version) return this.lastView;
    this.viewed = this.version;
    this.lastView = {
      rows: this.rows,
      messages: this.transcript.messages,
      transcript: this.transcript,
      ...(this.turnActive === undefined ? {} : { turnActive: this.turnActive }),
      ...(this.completed === undefined ? {} : { completed: this.completed }),
      ...(this.stopped === undefined ? {} : { stopped: this.stopped }),
      ...(this.continuationToken === undefined ? {} : { continuationToken: this.continuationToken }),
      childSessions: this.childSessions,
    };
    return this.lastView;
  }

  /** A note from outside the stream that the turn is over (a Stop that found no active turn). */
  markTurnIdle(): void {
    this.turnActive = false;
    this.version++;
  }

  private holdDelta(next: Held): void {
    if (this.held && this.held.kind === next.kind && sameSlot(this.held, next)) {
      this.held = null;
      this.skipped++;
    } else {
      this.foldHeld();
    }
    this.held = next;
  }

  private apply(event: LooseEvent, index: number): void {
    this.version++;
    this.transcript = childReducer.reduce(this.transcript, event as TurnEvent);
    let k = 0;
    const nextId = () => `e${index}${k++ ? `.${k - 1}` : ""}`;
    const rows = applyFeedEvent(this.rows, event, nextId, this.summarize);
    if (rows !== this.rows) this.rows = rows.length > MAX_FEED_ROWS ? rows.slice(-MAX_FEED_ROWS) : rows;
    switch (event.type) {
      case "turn.started":
        this.turnActive = true;
        this.stopped = false;
        break;
      case "turn.completed":
      case "turn.failed":
        this.turnActive = false;
        break;
      case "turn.cancelled":
        // `turnActive` is left as it was: Stop stays on a stopped specialist so pressing it again retries a hand-back
        // that could not be delivered (agent/lib/specialist-handback.ts).
        this.stopped = true;
        break;
      case "subagent.called": {
        const nested = event.data?.childSessionId;
        if (typeof nested === "string" && nested && !this.childSessions.includes(nested)) {
          this.childSessions = [...this.childSessions, nested];
        }
        break;
      }
      case "session.waiting": {
        const token = event.data?.continuationToken;
        if (typeof token === "string") this.continuationToken = token;
        break;
      }
      case "session.completed":
        this.completed = true;
        break;
    }
  }
}

/** Fold a whole stream of lines (tests, and anything that holds a recorded stream). */
export function foldLines(lines: Iterable<string>, options: FoldOptions = {}, into = new ChildFold(options)): ChildFold {
  for (const line of lines) into.push(line);
  into.foldHeld();
  return into;
}

/** Split decoded text into complete lines, keeping the unfinished remainder: an indexOf scan, never a split of the
 *  whole buffer per chunk. */
export function takeLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let from = 0;
  for (let nl = buffer.indexOf("\n", from); nl !== -1; nl = buffer.indexOf("\n", from)) {
    lines.push(buffer.slice(from, nl));
    from = nl + 1;
  }
  return { lines, rest: from === 0 ? buffer : buffer.slice(from) };
}

/* ================================================================================================================ */
/* The store: connections, the pool, the deadline, the cache, the batched flush.                                     */
/* ================================================================================================================ */

/** Harvests in flight at once. Not one: a harvest with no boundary holds its slot until it goes quiet. */
export const DEFAULT_POOL = 3;
/** A harvest's wait for response headers before it is retried, then shown as unavailable. */
export const HEADER_DEADLINE_MS = 10_000;
/** A harvest that has read nothing for this long has read the whole history (the stream is a live tail). */
export const QUIET_MS = 5_000;
/** …and sooner after `input.requested`, which in a finished specialist is where its stream stops. */
export const INPUT_QUIET_MS = 1_500;
/** At most one update of the panel per this long. */
export const FLUSH_MS = 250;
/** A feed no panel wants is kept connected this long, so a remount re-adopts it rather than reading again. */
export const GRACE_MS = 1_500;
/** The cache's bound, in characters of folded state. */
export const CACHE_BUDGET_CHARS = 24_000_000;
/** A live feed whose read fails is tried again after these waits, then shown as unavailable. */
export const LIVE_RETRY_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000];
/** Stream segments one connection will reopen (eve ends a segment about every 120 s). */
export const MAX_SEGMENTS = 60;

type Timer = unknown;

export interface StoreOptions {
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly headers?: () => Record<string, string>;
  /** Which workspace this tab is in: part of every cache key, so one workspace never sees another's folds. */
  readonly scope?: () => string;
  readonly summarize?: (toolName: string, input: unknown) => string | null;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => Timer;
  readonly clearTimer?: (timer: Timer) => void;
  readonly pool?: number;
  readonly headerDeadlineMs?: number;
  readonly quietMs?: number;
  readonly inputQuietMs?: number;
  readonly flushMs?: number;
  readonly graceMs?: number;
  readonly budgetChars?: number;
  readonly liveRetryMs?: readonly number[];
  /** The stream URL for a session at an index. Child feeds ask for a compressed read (the /eve gate's `compressed`). */
  readonly streamUrl?: (sessionId: string, startIndex: number) => string;
  /** A reporter per read, for the chat-open record (see {@link ChildFeedProbe}). */
  readonly probe?: (sessionId: string, live: boolean) => ChildFeedProbe;
}

interface Conn {
  readonly ctrl: AbortController;
  /** This read's reporter; settled once, with how the read ended. */
  readonly probe: ChildFeedProbe;
  reported: boolean;
  /** Live: no deadline, no quiet end, no release at a boundary. Upgraded in place when a harvest becomes live. */
  live: boolean;
  /** Counts toward the pool. */
  pooled: boolean;
  /** Response headers have arrived on the current request. */
  headers: boolean;
  deadline: Timer | null;
}

interface Entry {
  readonly key: string;
  readonly sid: string;
  fold: ChildFold;
  status: FeedStatus;
  delegated?: boolean;
  notes: { id: string; text: string }[];
  /** Read to its end (a boundary or a quiet stretch): a harvest asks for nothing more. */
  settled: boolean;
  conn: Conn | null;
  /** A live read that ended at a terminal event: not reopened until the panel stops wanting it live and asks again. */
  liveSpent: boolean;
  liveFailures: number;
  retryTimer: Timer | null;
  graceTimer: Timer | null;
  lastUsed: number;
  size: number;
  snapshot: ChildFeed | null;
  dirty: boolean;
  requests: number;
  bytes: number;
  firstRequestAt: number | null;
  headersAt: number | null;
  settledAt: number | null;
}

let noteSeq = 0;

export class ChildFeedStore {
  private readonly entries = new Map<string, Entry>();
  private readonly owners = new Map<unknown, { wanted: Map<string, FeedMode>; ready: boolean; scope: string }>();
  private readonly listeners = new Set<(changed: Readonly<Record<string, ChildFeed>>) => void>();
  private flushTimer: Timer | null = null;
  private readonly o: Required<StoreOptions>;

  constructor(options: StoreOptions = {}) {
    this.o = {
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      headers: options.headers ?? (() => ({})),
      scope: options.scope ?? (() => ""),
      summarize: options.summarize ?? (() => null),
      now: options.now ?? (() => Date.now()),
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: options.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)),
      pool: options.pool ?? DEFAULT_POOL,
      headerDeadlineMs: options.headerDeadlineMs ?? HEADER_DEADLINE_MS,
      quietMs: options.quietMs ?? QUIET_MS,
      inputQuietMs: options.inputQuietMs ?? INPUT_QUIET_MS,
      flushMs: options.flushMs ?? FLUSH_MS,
      graceMs: options.graceMs ?? GRACE_MS,
      budgetChars: options.budgetChars ?? CACHE_BUDGET_CHARS,
      liveRetryMs: options.liveRetryMs ?? LIVE_RETRY_MS,
      streamUrl:
        options.streamUrl ??
        ((sid, startIndex) => `/eve/v1/session/${encodeURIComponent(sid)}/stream?startIndex=${startIndex}&compressed=1`),
      probe: options.probe ?? (() => NO_PROBE),
    };
  }

  /* ---- what panels call ------------------------------------------------------------------------------------- */

  /**
   * A panel's whole wish, every time it changes: which sessions, how, and whether the chat is ready for harvests.
   * Returns the current feed of every wanted session that has one (a remount renders a cached fold at once).
   */
  sync(owner: unknown, wanted: ReadonlyMap<string, FeedMode>, ready: boolean): Record<string, ChildFeed> {
    const scope = this.o.scope();
    this.owners.set(owner, { wanted: new Map(wanted), ready, scope });
    const out: Record<string, ChildFeed> = {};
    const now = this.o.now();
    for (const sid of wanted.keys()) {
      const e = this.entry(scope, sid);
      e.lastUsed = now;
      if (e.graceTimer !== null) {
        this.o.clearTimer(e.graceTimer);
        e.graceTimer = null;
      }
      out[sid] = this.snapshotOf(e);
    }
    this.pump();
    return out;
  }

  /** The panel is gone. Its feeds stay folded; their connections close after {@link GRACE_MS} unless re-wanted. */
  release(owner: unknown): void {
    this.owners.delete(owner);
    this.pump();
  }

  subscribe(listener: (changed: Readonly<Record<string, ChildFeed>>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A local note under a feed (steer sent, cancel requested). Shown at once. */
  appendLocal(sid: string, text: string): void {
    const e = this.entry(this.o.scope(), sid);
    e.notes = [...e.notes, { id: `n${++noteSeq}`, text }];
    this.touch(e, true);
  }

  /** A Stop that found no active turn: the feed's turn is over. */
  markTurnIdle(sid: string): void {
    const e = this.entries.get(this.keyOf(this.o.scope(), sid));
    if (!e) return;
    e.fold.markTurnIdle();
    this.touch(e, true);
  }

  /** The person pressed Retry on an unavailable feed: read it now, whatever the queue. */
  retry(sid: string): void {
    const e = this.entry(this.o.scope(), sid);
    if (e.conn) return;
    e.settled = false;
    e.liveFailures = 0;
    if (e.retryTimer !== null) this.o.clearTimer(e.retryTimer);
    e.retryTimer = null;
    e.status = e.fold.cursor > 0 ? "ended" : "idle";
    this.touch(e, true);
    this.open(e, this.modeOf(e.key) === "live", false);
  }

  /** What each specialist's reads cost so far, for the chat-open record. */
  stats(): ChildFeedStats[] {
    return [...this.entries.values()].map((e) => ({
      sessionId: e.sid,
      requests: e.requests,
      bytes: e.bytes,
      timeToHeadersMs: e.firstRequestAt !== null && e.headersAt !== null ? e.headersAt - e.firstRequestAt : null,
      timeToSettleMs: e.firstRequestAt !== null && e.settledAt !== null ? e.settledAt - e.firstRequestAt : null,
      skippedEvents: e.fold.skipped,
      status: e.status,
    }));
  }

  /** Tests: the current feed of a session, if any. */
  peek(sid: string): ChildFeed | undefined {
    const e = this.entries.get(this.keyOf(this.o.scope(), sid));
    return e ? this.snapshotOf(e) : undefined;
  }

  /** Tests: how many reads are open, and how many count toward the pool. */
  inFlight(): { open: number; pooled: number } {
    let open = 0;
    let pooled = 0;
    for (const e of this.entries.values()) {
      if (!e.conn) continue;
      open++;
      if (e.conn.pooled) pooled++;
    }
    return { open, pooled };
  }

  /* ---- scheduling ------------------------------------------------------------------------------------------- */

  private keyOf(scope: string, sid: string): string {
    return `${scope}\u0000${sid}`;
  }

  private entry(scope: string, sid: string): Entry {
    const key = this.keyOf(scope, sid);
    let e = this.entries.get(key);
    if (!e) {
      e = {
        key,
        sid,
        fold: new ChildFold({ summarize: this.o.summarize }),
        status: "idle",
        notes: [],
        settled: false,
        conn: null,
        liveSpent: false,
        liveFailures: 0,
        retryTimer: null,
        graceTimer: null,
        lastUsed: this.o.now(),
        size: 0,
        snapshot: null,
        dirty: false,
        requests: 0,
        bytes: 0,
        firstRequestAt: null,
        headersAt: null,
        settledAt: null,
      };
      this.entries.set(key, e);
    }
    return e;
  }

  /** The strongest mode any panel wants for this entry, and whether a panel that wants it is ready. */
  private wish(key: string): { mode: FeedMode | null; ready: boolean } {
    let mode: FeedMode | null = null;
    let ready = false;
    for (const o of this.owners.values()) {
      for (const [sid, m] of o.wanted) {
        if (this.keyOf(o.scope, sid) !== key) continue;
        if (mode === null || MODE_RANK[m] > MODE_RANK[mode]) mode = m;
        if (o.ready) ready = true;
      }
    }
    return { mode, ready };
  }

  private modeOf(key: string): FeedMode | null {
    return this.wish(key).mode;
  }

  private pump(): void {
    const queue: Entry[] = [];
    let pooled = 0;
    for (const e of this.entries.values()) if (e.conn?.pooled) pooled++;
    for (const e of this.entries.values()) {
      const { mode, ready } = this.wish(e.key);
      if (mode !== "live") {
        e.liveSpent = false;
        e.liveFailures = 0;
      }
      if ((mode === "harvest" || mode === "priority") && e.conn?.live && e.status === "ended") {
        // A finished run that was open in the rail, now closed: it has been read to a boundary, so let it go rather
        // than hold a live connection to it for the rest of the panel's life.
        this.close(e);
        e.settled = true;
        if (e.conn === null) this.touch(e, false);
        continue;
      }
      if (mode === null) {
        // Nobody wants it: let go of its connection after the grace period. The fold stays.
        if (e.conn && e.graceTimer === null) {
          e.graceTimer = this.o.setTimer(() => {
            e.graceTimer = null;
            if (this.modeOf(e.key) === null && e.conn) {
              this.close(e);
              if (e.status === "live" || e.status === "idle") e.status = e.fold.cursor > 0 ? "ended" : "idle";
              this.touch(e, false);
            }
          }, this.o.graceMs);
        }
        continue;
      }
      if (mode === "live") {
        if (e.conn) {
          if (!e.conn.live) {
            // A harvest that became live (selected, or running again) keeps its connection: no new request, and
            // no deadline or quiet end any more.
            e.conn.live = true;
            if (e.conn.pooled) {
              e.conn.pooled = false;
              pooled--;
            }
            if (e.conn.deadline !== null) {
              this.o.clearTimer(e.conn.deadline);
              e.conn.deadline = null;
            }
          }
        } else if (e.retryTimer === null && !e.liveSpent && !(e.status === "unavailable" && e.liveFailures >= this.o.liveRetryMs.length)) {
          // (A live read whose retries are all spent waits for the person's Retry, not for the next pass of this loop.)
          this.open(e, true, false);
        }
        continue;
      }
      if (e.settled || e.conn || e.status === "unavailable") continue;
      if (mode === "priority") {
        this.open(e, false, false);
        continue;
      }
      if (ready) queue.push(e);
    }
    for (const e of queue) {
      if (pooled >= this.o.pool) break;
      pooled++;
      this.open(e, false, true);
    }
  }

  private close(e: Entry, outcome: ChildFeedOutcome = "aborted"): void {
    const conn = e.conn;
    if (!conn) return;
    e.conn = null;
    if (conn.deadline !== null) this.o.clearTimer(conn.deadline);
    this.report(conn, outcome);
    conn.ctrl.abort();
  }

  private report(conn: Conn, outcome: ChildFeedOutcome): void {
    if (conn.reported) return;
    conn.reported = true;
    try {
      conn.probe.settle(outcome);
    } catch {
      // A reporter never breaks a read.
    }
  }

  private settle(e: Entry, status: FeedStatus): void {
    e.settled = status !== "unavailable";
    e.status = status;
    e.settledAt ??= this.o.now();
    e.fold.foldHeld();
    this.close(e, "caught-up");
    this.measure(e);
    this.touch(e, true);
    this.pump();
  }

  /* ---- one connection --------------------------------------------------------------------------------------- */

  private open(e: Entry, live: boolean, pooled: boolean): void {
    let probe = NO_PROBE;
    try {
      probe = this.o.probe(e.sid, live);
    } catch {
      // A reporter never breaks a read.
    }
    const conn: Conn = { ctrl: new AbortController(), probe, reported: false, live, pooled, headers: false, deadline: null };
    e.conn = conn;
    void this.run(e, conn);
  }

  private async run(e: Entry, conn: Conn): Promise<void> {
    let segments = 0;
    let timeouts = 0;
    let timedOut = false;
    let inputRequested = false;
    const call = (fn: () => void) => {
      try {
        fn();
      } catch {
        // A reporter never breaks a read.
      }
    };
    let quiet: Timer | null = null;
    const stopQuiet = () => {
      if (quiet !== null) this.o.clearTimer(quiet);
      quiet = null;
    };
    const armQuiet = () => {
      stopQuiet();
      if (conn.live) return;
      quiet = this.o.setTimer(() => {
        quiet = null;
        // A harvest has read all there is: the stream is a live tail, and it has stopped talking.
        if (e.conn === conn && !conn.live) this.settle(e, "ended");
      }, inputRequested ? this.o.inputQuietMs : this.o.quietMs);
    };
    try {
      while (!conn.ctrl.signal.aborted && segments < MAX_SEGMENTS) {
        segments++;
        const req = new AbortController();
        const onAbort = () => req.abort();
        conn.ctrl.signal.addEventListener("abort", onAbort);
        conn.headers = false;
        if (!conn.live) {
          conn.deadline = this.o.setTimer(() => {
            conn.deadline = null;
            if (!conn.headers && !conn.live) {
              timedOut = true;
              req.abort();
            }
          }, this.o.headerDeadlineMs);
        }
        timedOut = false;
        call(() => conn.probe.request());
        e.requests++;
        e.firstRequestAt ??= this.o.now();
        let res: Response;
        try {
          res = await this.o.fetch(this.o.streamUrl(e.sid, e.fold.cursor), {
            headers: this.o.headers(),
            signal: req.signal,
          });
        } catch (error) {
          conn.ctrl.signal.removeEventListener("abort", onAbort);
          if (conn.deadline !== null) this.o.clearTimer(conn.deadline);
          conn.deadline = null;
          if (conn.ctrl.signal.aborted) return;
          if (!conn.live && timeouts < 1) {
            // No headers inside the deadline (or no answer at all): once more, from the same cursor.
            timeouts++;
            segments--;
            continue;
          }
          throw error;
        }
        conn.headers = true;
        if (conn.deadline !== null) this.o.clearTimer(conn.deadline);
        conn.deadline = null;
        e.headersAt ??= this.o.now();
        call(() => conn.probe.headers());
        if (!res.ok || !res.body) {
          conn.ctrl.signal.removeEventListener("abort", onAbort);
          if (!conn.live && res.status >= 500 && timeouts < 1) {
            timeouts++;
            segments--;
            continue;
          }
          throw new Error(`stream answered ${res.status}`);
        }
        // The agent's word on whether this session is a delegation, which decides whether a panel may message it.
        const delegated = delegationFromHeader(res.headers.get(SESSION_DELEGATION_HEADER));
        if (delegated !== undefined) e.delegated = delegated;
        e.liveFailures = 0;
        if (e.status !== "ended" || conn.live) e.status = "live";
        this.touch(e, false);
        armQuiet();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let ended = false;
        let readThisSegment = 0;
        let stop = false;
        while (!stop && !conn.ctrl.signal.aborted) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch (error) {
            if (conn.ctrl.signal.aborted) break;
            throw error;
          }
          if (chunk.done) break;
          e.bytes += chunk.value.byteLength;
          const n = chunk.value.byteLength;
          call(() => conn.probe.bytes(n));
          const taken = takeLines(buf + decoder.decode(chunk.value, { stream: true }));
          buf = taken.rest;
          for (const line of taken.lines) {
            if (!line.trim()) continue;
            readThisSegment++;
            const effect = e.fold.push(line);
            if (effect.type === "input.requested") inputRequested = true;
            if (effect.type === "turn.started" || effect.type === "step.started") inputRequested = false;
            if (
              effect.type === "turn.completed" ||
              effect.type === "turn.failed" ||
              effect.boundary === "completed" ||
              effect.boundary === "waiting"
            ) {
              ended = true;
            }
            if (effect.boundary === "waiting" || effect.boundary === "completed") e.status = "ended";
            if (effect.boundary && !conn.live) {
              // Harvest-only: the replay has reached the end of this session's recorded life. Stop HERE, in the line
              // loop: a line after the boundary is not folded and not counted, so a later live read starts at it.
              // settle() aborts the connection, and with it this request.
              stopQuiet();
              this.settle(e, "ended");
              return;
            }
          }
          if (taken.lines.length) {
            this.touch(e, false);
            armQuiet();
          }
        }
        conn.ctrl.signal.removeEventListener("abort", onAbort);
        stopQuiet();
        if (conn.ctrl.signal.aborted) break;
        e.fold.foldHeld();
        // The segment closed. A terminal event means done; a harvest that read nothing new in it has read it all;
        // anything else is a severed segment, resumed at the cursor.
        if (ended || (!conn.live && readThisSegment === 0)) break;
      }
      if (e.conn !== conn) return;
      e.fold.foldHeld();
      if (conn.live) {
        e.conn = null;
        this.report(conn, "ended");
        e.liveSpent = true;
        if (e.status === "live") {
          e.status = "ended";
          e.fold.markTurnIdle();
        }
        this.touch(e, true);
        return;
      }
      this.settle(e, "ended");
    } catch {
      stopQuiet();
      if (e.conn !== conn || conn.ctrl.signal.aborted) return;
      e.conn = null;
      if (conn.deadline !== null) this.o.clearTimer(conn.deadline);
      e.fold.foldHeld();
      if (conn.live || this.modeOf(e.key) === "live") {
        // A running specialist is never given up on by a timer. Try again, and only after the last wait say it is
        // unavailable (which the panel never reads as "ended" for a run the parent still shows running).
        const wait = this.o.liveRetryMs[e.liveFailures];
        e.liveFailures = Math.min(e.liveFailures + 1, this.o.liveRetryMs.length);
        if (wait !== undefined) {
          // Not reported yet: the retry is the same read, as the record counts it (one more request).
          e.retryTimer = this.o.setTimer(() => {
            e.retryTimer = null;
            this.pump();
          }, wait);
          this.touch(e, false);
          return;
        }
      }
      this.report(conn, timedOut ? "unavailable" : "failed");
      e.status = "unavailable";
      e.settledAt ??= this.o.now();
      this.touch(e, true);
      this.pump();
    }
  }

  /* ---- the cache bound -------------------------------------------------------------------------------------- */

  private measure(e: Entry): void {
    const view = e.fold.view();
    let size = 0;
    try {
      size = JSON.stringify(view.messages).length + JSON.stringify(view.rows).length;
    } catch {
      size = e.fold.foldedChars;
    }
    e.size = size;
    this.evict();
  }

  private evict(): void {
    let total = 0;
    for (const e of this.entries.values()) total += e.size || e.fold.foldedChars;
    if (total <= this.o.budgetChars) return;
    const idle = [...this.entries.values()]
      .filter((e) => !e.conn && this.modeOf(e.key) === null)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of idle) {
      if (total <= this.o.budgetChars) break;
      total -= e.size || e.fold.foldedChars;
      if (e.retryTimer !== null) this.o.clearTimer(e.retryTimer);
      if (e.graceTimer !== null) this.o.clearTimer(e.graceTimer);
      this.entries.delete(e.key);
    }
  }

  /* ---- the batched flush ------------------------------------------------------------------------------------ */

  private snapshotOf(e: Entry): ChildFeed {
    if (e.snapshot && !e.dirty) return e.snapshot;
    const view = e.fold.view();
    const prev = e.snapshot;
    const next: ChildFeed = {
      rows: view.rows,
      messages: view.messages,
      transcript: view.transcript,
      notes: e.notes,
      status: e.status,
      childSessions: view.childSessions,
      ...(view.turnActive === undefined ? {} : { turnActive: view.turnActive }),
      ...(view.completed === undefined ? {} : { completed: view.completed }),
      ...(view.stopped === undefined ? {} : { stopped: view.stopped }),
      ...(view.continuationToken === undefined ? {} : { continuationToken: view.continuationToken }),
      ...(e.delegated === undefined ? {} : { delegated: e.delegated }),
    };
    e.dirty = false;
    const same =
      prev &&
      (Object.keys(next) as (keyof ChildFeed)[]).every((k) => prev[k] === next[k]) &&
      Object.keys(prev).length === Object.keys(next).length;
    e.snapshot = same ? prev : next;
    return e.snapshot;
  }

  /** Something changed: tell the panels at the next flush, or now. */
  private touch(e: Entry, now: boolean): void {
    e.dirty = true;
    if (now) {
      this.flush();
      return;
    }
    if (this.flushTimer === null) {
      this.flushTimer = this.o.setTimer(() => {
        this.flushTimer = null;
        this.flush();
      }, this.o.flushMs);
    }
  }

  private flush(): void {
    if (this.flushTimer !== null) {
      this.o.clearTimer(this.flushTimer);
      this.flushTimer = null;
    }
    const changed: Record<string, ChildFeed> = {};
    let any = false;
    for (const e of this.entries.values()) {
      if (!e.dirty) continue;
      const before = e.snapshot;
      const after = this.snapshotOf(e);
      if (after !== before) {
        changed[e.sid] = after;
        any = true;
      }
    }
    if (!any) return;
    for (const l of this.listeners) l(changed);
  }
}

/* ================================================================================================================ */
/* The page's one store.                                                                                             */
/* ================================================================================================================ */

let shared: ChildFeedStore | null = null;
let sharedOptions: StoreOptions = {};

/** The store every Control Panel on this page shares (so a remount finds what the last mount folded). */
export function childFeedStore(options?: StoreOptions): ChildFeedStore {
  if (options) sharedOptions = options;
  shared ??= new ChildFeedStore(sharedOptions);
  return shared;
}

/** What each specialist's reads have cost on this page (for the chat-open record). */
export function childFeedStats(): ChildFeedStats[] {
  return shared ? shared.stats() : [];
}

/**
 * ASK THE SERVER WHERE REPLAY ENDS instead of inferring it from silence.
 *
 * eve's stream never ends after a replay. `getEventStream` hands back the
 * workflow run's readable, and a PARKED run is suspended rather than finished,
 * so the response stays open forever waiting for live events. A reader replaying
 * history therefore cannot tell "the transcript is complete" from "the next
 * event is still coming", and has to guess with a timeout — which is both slow
 * (the guess is the floor on opening a thread) and lossy (a chunk gap longer
 * than the guess truncates the transcript).
 *
 * A proxy in the middle can watch the NDJSON go past and inject one extra line
 * the moment the backlog drains:
 *
 *   {"type":"ops.replay.end","data":{"index":N,"parked":b,"done":b,"drained":b}}
 *
 * `index` is the ABSOLUTE next event index — the value to hand back as
 * `startIndex` on the next open, and the value to mount as the stream index.
 * `drained` is whether history is actually complete; see the marker's own
 * comment, because the difference is a truncated transcript.
 *
 * This lived inside the shared-thread stream route, which is why only SHARED
 * threads ever got the marker: a thread you own is read straight from eve, so
 * there was nothing in the middle to inject it, and every owned open paid the
 * browser's own quiet window (1,500ms mid-replay) per segment instead. It is a
 * module now so the owned path (app/api/ops/chat-replay) can have the same
 * answer, and so the two cannot drift.
 *
 * No database, no auth, no tenancy: the callers do all three before handing the
 * upstream body over. This file only knows where a replay stops.
 */

/**
 * How long the replay must stay silent before we call it drained.
 *
 * A parked session's run is SUSPENDED — it emits nothing until someone sends —
 * so silence right after `session.waiting` means the history is complete, and a
 * short window is enough. With no boundary yet the turn may still be thinking
 * between tool calls, so we wait considerably longer before declaring the
 * backlog drained and letting the reader paint.
 *
 * Both windows are measured HERE, between two deployments in the same region,
 * not across the reader's network — which is the point of moving the decision to
 * the server.
 */
export const PARKED_IDLE_MS = 400;
export const IN_FLIGHT_IDLE_MS = 2500;

/** Session-level events that mean the run is over — the replay cannot grow. */
const TERMINAL_EVENTS = new Set(["session.completed", "session.failed"]);

/**
 * Take the live resume capability out of a stream on its way to a client.
 *
 * `session.waiting` carries `data.continuationToken`, and that token IS the
 * ability to send the next turn into the session. For a SHARED thread it is
 * supposed to live in one place only — the `chat_threads` row, claimed and
 * returned by the send relay — which is what serializes two people writing into
 * one eve session, and what `app/api/ops/threads/[id]/messages/route.ts` states
 * in its own header: "once shared, the token lives ONLY in the row, never on a
 * client".
 *
 * `app/api/ops/threads/[id]/stream/route.ts` piped eve's NDJSON through
 * untouched, so every reader of a shared thread — VIEWERS included — received
 * the token, and `openSharedThread` mounted it on the session. A read-only
 * member's page held a live send capability for someone else's conversation,
 * with nothing but the composer's own UI between them and using it. Whoever
 * holds the page can read what the page holds; a disabled textarea is not an
 * access control.
 *
 * Applied ONLY by that proxy. The owned path (`app/api/ops/chat-replay`) hands
 * the token to the one person it belongs to, who needs it to continue their own
 * parked chat, so this must never be wrapped around that one.
 *
 * COST: unlike {@link boundedReplay}, which passes the original bytes through
 * and only inspects them, this has to hold an incomplete trailing line until
 * its newline arrives — a line cannot be rewritten before it exists. One chunk
 * of delay on a partial line, on the path that is already the slowest open
 * there is, in exchange for the token never leaving the server.
 */
export function withoutContinuationTokens(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let partial = "";

  /**
   * Remove the key rather than blank it.
   *
   * An EMPTY token is worse than none: the send paths test
   * `typeof … === "string"` before they test truthiness, and eve rejects a POST
   * carrying one ("Missing or empty 'continuationToken' field"), which is a
   * lost message rather than a clean fallback. An absent key is the state every
   * reader already copes with, because it is what a stream mid-turn looks like.
   */
  const strip = (line: string): string => {
    if (!line.includes("continuationToken")) return line;
    try {
      const event = JSON.parse(line) as { data?: Record<string, unknown> };
      if (event?.data && typeof event.data === "object" && "continuationToken" in event.data) {
        delete event.data.continuationToken;
        return JSON.stringify(event);
      }
      return line;
    } catch {
      /**
       * A line we cannot parse but which mentions the token is dropped, not
       * forwarded. It cannot be redacted, it is not an event any reader has a
       * projection for, and forwarding it would be choosing "it is probably
       * harmless" over the one guarantee this function exists to make.
       */
      return "";
    }
  };

  return new ReadableStream<Uint8Array>({
    /**
     * One `pull` produces one chunk or ends the stream — it never returns
     * empty-handed. A chunk can land with no newline in it (and does, at every
     * real chunk boundary), so the loop keeps reading until there is a complete
     * line to hand on. Returning without enqueuing instead deadlocks the
     * reader, which is not obvious from the spec and is very obvious the first
     * time a one-byte chunk goes through.
     */
    async pull(controller) {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          // A stream can end without a trailing newline; that last fragment is
          // still a whole event to the reader, so it is redacted like any other.
          if (partial) controller.enqueue(encoder.encode(strip(partial)));
          partial = "";
          controller.close();
          return;
        }
        partial += decoder.decode(next.value, { stream: true });
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        if (!lines.length) continue;
        // Every complete line keeps its newline: the reader splits on them, and
        // an event glued to the next one is an event neither of them can parse.
        const out = lines.map((line) => (line.trim() ? strip(line) : line)).join("\n");
        controller.enqueue(encoder.encode(`${out}\n`));
        return;
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
    },
  });
}

export interface BoundedReplayOptions {
  /** The absolute index the upstream read was opened at, so the marker can
   *  report an absolute one back. */
  readonly startIndex: number;
  /** Close the response after the marker, for a caller that only wants history. */
  readonly replayOnly: boolean;
  /**
   * The caller already knows the session is parked.
   *
   * A TAIL read (`startIndex` at the end of a parked session's stream) replays
   * NOTHING, so no `session.waiting` goes past and this stream cannot observe
   * that the run is suspended — it would wait out the long in-flight window for
   * a session that is by definition silent. The caller holding a live
   * continuation token is the one piece of evidence available, and it is only
   * ever used to SHORTEN a wait, never to end a read early on content.
   */
  readonly assumeParked?: boolean;
}

/**
 * Pass the upstream NDJSON through byte-for-byte, inserting one
 * `ops.replay.end` line at the point the backlog runs dry. Nothing is rewritten
 * or reordered: the marker is additive, so every real event still reaches the
 * reader in its original form and at its original position.
 */
export function boundedReplay(
  upstream: ReadableStream<Uint8Array>,
  options: BoundedReplayOptions,
): ReadableStream<Uint8Array> {
  const { startIndex, replayOnly } = options;
  const reader = upstream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let partial = "";
  let seen = 0;
  let parked = Boolean(options.assumeParked);
  let terminal = false;
  let markerSent = false;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  /**
   * `drained` separates the two very different reasons this marker is emitted.
   *
   * TRUE: the backlog ran dry (silence past the idle window, or a terminal
   * event). History is complete — stop reading.
   *
   * FALSE: the UPSTREAM ENDED. eve severs a stream on a hard ~120s boundary
   * with a clean EOF and no terminal event, so a long replay simply stops
   * mid-history. A reader that treats that as the end mounts a transcript
   * stopping in the middle of a turn, which is the exact failure the segmented
   * replay in chat-shell exists to prevent — and it would have come straight
   * back the moment the owned path started trusting a marker. The index is
   * still good: reopen there.
   */
  const enqueueMarkerInto = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    drained: boolean,
  ) => {
    markerSent = true;
    controller.enqueue(
      encoder.encode(
        `${JSON.stringify({
          type: "ops.replay.end",
          // Deliberately NOT the continuation token: for a shared thread the
          // token belongs to the relay and the row, never to a reader.
          data: { index: startIndex + seen, parked, done: terminal, drained },
        })}\n`,
      ),
    );
  };

  const inspect = (chunk: Uint8Array) => {
    partial += decoder.decode(chunk, { stream: true });
    const lines = partial.split("\n");
    // The trailing fragment is an incomplete event; hold it for the next chunk.
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      seen += 1;
      try {
        const event = JSON.parse(line) as { type?: string };
        if (event.type === "session.waiting") parked = true;
        else if (event.type && TERMINAL_EVENTS.has(event.type)) terminal = true;
      } catch {
        // A line we cannot parse still counts as an event for indexing — the
        // reader saw it — but it tells us nothing about the replay boundary.
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      pending ??= reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Once the marker is out we are relaying live events, so there is nothing
      // left to time out on — wait for the upstream indefinitely.
      const next: ReadableStreamReadResult<Uint8Array> | "idle" = markerSent
        ? await pending
        : await Promise.race<ReadableStreamReadResult<Uint8Array> | "idle">([
            pending,
            new Promise((resolve) => {
              timer = setTimeout(() => resolve("idle"), parked ? PARKED_IDLE_MS : IN_FLIGHT_IDLE_MS);
            }),
          ]);
      if (timer !== undefined) clearTimeout(timer);

      if (next === "idle") {
        // The read is still outstanding — keep it for the next pull rather than
        // dropping the chunk it will eventually deliver.
        enqueueMarkerInto(controller, true);
        if (replayOnly) {
          void reader.cancel().catch(() => undefined);
          controller.close();
        }
        return;
      }

      pending = null;
      if (next.done) {
        // The upstream closed. That is the severance, not the end of history —
        // unless a terminal event already said the run is over.
        if (!markerSent) enqueueMarkerInto(controller, terminal);
        controller.close();
        return;
      }
      inspect(next.value);
      controller.enqueue(next.value);
      if (terminal && !markerSent) {
        enqueueMarkerInto(controller, true);
        if (replayOnly) {
          void reader.cancel().catch(() => undefined);
          controller.close();
        }
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
    },
  });
}

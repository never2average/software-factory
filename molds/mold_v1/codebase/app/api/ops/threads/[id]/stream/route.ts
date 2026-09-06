import { NextRequest, NextResponse } from "next/server";
import { getOpsDb } from "@/lib/ops-db";
import { accessForThread, callerEmail, loadThread } from "@/lib/chat-threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const AGENT_URL = process.env.NEXT_PUBLIC_EVE_API_URL ?? "";

/**
 * How long the replay must stay silent before we call it drained.
 *
 * A parked session's run is SUSPENDED — it emits nothing until someone sends —
 * so silence right after `session.waiting` means the history is complete, and a
 * short window is enough. With no boundary yet the turn may still be thinking
 * between tool calls, so we wait considerably longer before declaring the
 * backlog drained and letting the reader paint.
 *
 * Both windows are measured HERE, between two Vercel deployments in the same
 * region, not across the reader's network — which is the point of moving the
 * decision to the server.
 *
 * tenancy-ok: the only reads are loadThread() and accessForThread(), which
 * resolve and enforce the caller's access to ONE thread — accessFor refuses a
 * thread whose workspace is not the caller's (lib/chat-threads.ts). Past that
 * point this route is a stream proxy and touches no tenant table.
 */
const PARKED_IDLE_MS = 400;
const IN_FLIGHT_IDLE_MS = 2500;

/**
 * GET /api/ops/threads/:id/stream?startIndex=N&replay=1 — a MEMBERSHIP-CHECKED
 * proxy of the shared thread's eve event stream.
 *
 * The eve channel domain-gates stream reads (`hd: onfinance.in`) but not per
 * thread — so a session id alone would let any teammate read. Routing a shared
 * thread's replay through here enforces MEMBERSHIP first (owner / non-revoked
 * member), which is what makes REVOKE real: a revoked member's access check
 * returns null → 403, and they can no longer read the stream.
 *
 * WHY THIS ROUTE HAS TO DO MORE THAN PIPE
 *
 * eve's stream never ends after a replay. `getEventStream` hands back the
 * workflow run's readable, and a parked run is suspended rather than finished,
 * so the response stays open forever waiting for live events. A reader
 * replaying history therefore cannot tell "the transcript is complete" from
 * "the next event is still coming", and has to guess with a timeout — which is
 * both slow (the guess is the floor on opening a thread) and lossy (a chunk gap
 * longer than the guess truncates the transcript).
 *
 * `replay=1` removes the guess: we watch the NDJSON as it passes, and when the
 * backlog is drained we inject one extra line
 *
 *   {"type":"ops.replay.end","data":{"index":N,"parked":bool,"done":bool}}
 *
 * `index` is the ABSOLUTE next event index — the value to hand back as
 * `startIndex` on the next open, and the value to use as the mounted stream
 * index. `replay=1&replayOnly=1` additionally closes the response after the
 * marker, for a caller that only wants history.
 *
 * Without `replay=1` the bytes are piped through untouched, exactly as before,
 * so an older reader sees no protocol change.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  if (!AGENT_URL) return NextResponse.json({ error: "Agent URL not configured" }, { status: 503 });
  const authHeader = request.headers.get("authorization");
  const { id } = await ctx.params;

  // Verifying the bearer can cost a network fetch of Google's JWKS on a cold
  // container; the thread row does not depend on the answer, so start reading it
  // now rather than after. `catch` keeps an unhandled rejection off the 401 path.
  const threadPromise = loadThread(db, id);
  threadPromise.catch(() => undefined);

  const email = await callerEmail(request);
  if (!email || !authHeader) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  const access = await accessForThread(db, await threadPromise, email);
  if (!access) return NextResponse.json({ error: "You don't have access to this thread." }, { status: 403 });

  const params = new URL(request.url).searchParams;
  const rawStart = params.get("startIndex");
  // eve 400s on a non-integer startIndex, which would surface here as an opaque
  // 502; refuse it in our own words instead.
  if (rawStart !== null && !/^-?\d+$/.test(rawStart)) {
    return NextResponse.json({ error: "startIndex must be an integer." }, { status: 400 });
  }
  const startIndex = rawStart === null ? 0 : Number(rawStart);
  const wantsMarker = params.get("replay") === "1";
  const replayOnly = wantsMarker && params.get("replayOnly") === "1";

  // Only forward a startIndex the caller actually asked for — eve defaults to
  // the whole stream, and an always-present `startIndex=0` is noise.
  const query = rawStart === null ? "" : `?startIndex=${encodeURIComponent(rawStart)}`;
  const upstream = await fetch(
    `${AGENT_URL}/eve/v1/session/${encodeURIComponent(access.thread.eveSessionId)}/stream${query}`,
    { headers: { authorization: authHeader } },
  );
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: `Stream unavailable (${upstream.status}).` }, { status: 502 });
  }

  const body = wantsMarker
    ? boundedReplay(upstream.body, startIndex, replayOnly)
    : upstream.body;

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/x-ndjson",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

/** Session-level events that mean the run is over — the replay cannot grow. */
const TERMINAL_EVENTS = new Set(["session.completed", "session.failed"]);

/**
 * Pass the upstream NDJSON through byte-for-byte, inserting one
 * `ops.replay.end` line at the point the backlog runs dry. Nothing is
 * rewritten or reordered: the marker is additive, so every real event still
 * reaches the reader in its original form and at its original position.
 */
function boundedReplay(
  upstream: ReadableStream<Uint8Array>,
  startIndex: number,
  replayOnly: boolean,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let partial = "";
  let seen = 0;
  let parked = false;
  let terminal = false;
  let markerSent = false;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  const enqueueMarkerInto = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    markerSent = true;
    controller.enqueue(
      encoder.encode(
        `${JSON.stringify({
          type: "ops.replay.end",
          // Deliberately NOT the continuation token: for a shared thread the
          // token belongs to the relay and the row, never to a reader.
          data: { index: startIndex + seen, parked, done: terminal },
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
        enqueueMarkerInto(controller);
        if (replayOnly) {
          void reader.cancel().catch(() => undefined);
          controller.close();
        }
        return;
      }

      pending = null;
      if (next.done) {
        if (!markerSent) enqueueMarkerInto(controller);
        controller.close();
        return;
      }
      inspect(next.value);
      controller.enqueue(next.value);
      if (terminal && !markerSent) {
        enqueueMarkerInto(controller);
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

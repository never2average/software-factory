import { NextRequest, NextResponse } from "next/server";
import { getOpsDb } from "@/lib/ops-db";
import { accessForThread, callerEmail, loadThread } from "@/lib/chat-threads";
import { boundedReplay } from "@/lib/chat-replay-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const AGENT_URL = process.env.NEXT_PUBLIC_EVE_API_URL ?? "";

/**
 * tenancy-ok: the only reads are loadThread() and accessForThread(), which
 * resolve and enforce the caller's access to ONE thread — accessFor refuses a
 * thread whose workspace is not the caller's (lib/chat-threads.ts). Past that
 * point this route is a stream proxy and touches no tenant table.
 *
 * The replay-end marker itself lives in lib/chat-replay-stream.ts: it used to be
 * defined here, which is exactly why only SHARED threads ever got one and every
 * thread you own paid the browser's own quiet window instead.
 */

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
    ? boundedReplay(upstream.body, { startIndex, replayOnly })
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

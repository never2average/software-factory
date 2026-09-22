import { NextRequest, NextResponse } from "next/server";
import { getOpsDb } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { accessForSession } from "@/lib/chat-session-access";
import { boundedReplay } from "@/lib/chat-replay-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * A session stream is a live tail, so this function is held open for the whole
 * segment. The eve gate route next door carries 800 for the same reason; this
 * one only ever serves REPLAYS (it always injects the end marker and is called
 * with `replayOnly`), so the ceiling it needs is a long history, not a long
 * conversation.
 */
export const maxDuration = 300;

const AGENT_URL = process.env.NEXT_PUBLIC_EVE_API_URL ?? "";

/**
 * GET /api/ops/chat-replay?session=<id>&startIndex=N&parked=1 — the OWNED
 * thread's replay, with the same `ops.replay.end` marker a shared thread has
 * had all along.
 *
 * WHY THIS EXISTS AT ALL
 *
 * eve's session stream is a live tail that never ends for a parked run, so a
 * reader replaying history has to guess when the backlog has drained. A shared
 * thread has a proxy in the middle (`/api/ops/threads/:id/stream?replay=1`) that
 * watches the bytes go past and says so; a thread you OWN was read straight from
 * eve, with nothing in the middle, so the browser guessed — 1,500ms of silence
 * mid-replay, per segment, on every open. That wait is pure latency: it is not
 * the server being slow, it is the client deciding the server has stopped. Most
 * threads are owned, so most opens paid it.
 *
 * The marker replaces the guess with an answer, measured between two
 * deployments in the same region instead of across the reader's network. It also
 * carries the ABSOLUTE next event index, which is what the fast-open path mounts
 * as its stream cursor (lib/chat-snapshot.ts).
 *
 * WHY NOT THE EXISTING GATE (`/eve/v1/session/:id/stream`)
 *
 * That route is a byte-for-byte passthrough for LIVE streaming, where inserting
 * anything at all would be wrong: the eve client store reads it and does not
 * know the marker. This one is only ever a replay, and only its own callers read
 * it.
 *
 * ACCESS is the same rule as the transcript cache — owner of the chat, owner of
 * the thread, or a non-revoked member — so sharing and revoking mean here
 * exactly what they mean everywhere else.
 *
 * tenancy-ok: the only tenant reads happen inside `accessForSession`, which runs
 * every statement in `withOrgRls(ctx.orgId, …)`. Past that point this route is a
 * stream proxy and touches no tenant table.
 */
export async function GET(request: NextRequest) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  if (!AGENT_URL) return NextResponse.json({ error: "Agent URL not configured" }, { status: 503 });
  const authHeader = request.headers.get("authorization");
  const identity = await verifyOpsAuth(authHeader);
  if (!identity || !authHeader) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "workspace unavailable" }, { status: 503 });

  const params = new URL(request.url).searchParams;
  const sessionId = params.get("session");
  if (!sessionId) return NextResponse.json({ error: "session required" }, { status: 400 });
  const rawStart = params.get("startIndex");
  // eve 400s on a non-integer startIndex, which would surface here as an opaque
  // 502; refuse it in our own words instead.
  if (rawStart !== null && !/^\d+$/.test(rawStart)) {
    return NextResponse.json({ error: "startIndex must be a whole number." }, { status: 400 });
  }
  const startIndex = rawStart === null ? 0 : Number(rawStart);

  const access = await accessForSession(ctx.orgId, identity.email.toLowerCase(), sessionId);
  if (!access.read) {
    return NextResponse.json({ error: "That conversation isn't yours." }, { status: 403 });
  }

  // Only forward a startIndex the caller actually asked for — eve defaults to
  // the whole stream, and an always-present `startIndex=0` is noise.
  const query = rawStart === null ? "" : `?startIndex=${encodeURIComponent(rawStart)}`;
  const upstream = await fetch(
    `${AGENT_URL}/eve/v1/session/${encodeURIComponent(sessionId)}/stream${query}`,
    { headers: { authorization: authHeader } },
  );
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: `Stream unavailable (${upstream.status}).` }, { status: 502 });
  }

  return new Response(
    boundedReplay(upstream.body, {
      startIndex,
      // Always: this route's whole purpose is to end a replay. A caller that
      // wants the live tail uses the eve gate.
      replayOnly: true,
      /**
       * The caller says it holds a live resume token for this session.
       *
       * A TAIL read starts at the end of a parked session's stream, so it
       * replays nothing and the marker logic never sees the `session.waiting`
       * that would tell it the run is suspended — it would wait out the long
       * in-flight window for a session that is by definition silent. A parked
       * session with a live token is the NORMAL resting state here, so this is
       * the common case, not an edge one. It can only ever shorten a wait: the
       * marker is still emitted on silence, never on content.
       */
      assumeParked: params.get("parked") === "1",
    }),
    {
      status: 200,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/x-ndjson",
        "cache-control": "no-store, no-transform",
        "x-accel-buffering": "no",
      },
    },
  );
}

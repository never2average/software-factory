import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { chatSessions, chatThreadMembers, chatThreads } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";
import { verifyOpsAuth } from "@/lib/ops-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * A session stream is a live tail, so this function is held open for the whole
 * segment — and it is the NARROWEST ceiling on the path. The agent's own stream
 * function is raised to "max" at deploy time, but every browser byte comes
 * through here, so 300 silently capped the benefit at 300. Segments still end
 * (the client reopens at its cursor, which is the real mechanism), but each one
 * being longer means fewer seams for anything to go wrong in.
 */
export const maxDuration = 800;

/**
 * Ownership gate in front of the agent's per-session routes.
 *
 * `next.config.ts` rewrites `/eve/v1/:path*` straight to the agent, and eve's
 * session routes authenticate the CALLER but do not check whether the session
 * belongs to them. Measured, not assumed: a token minted for an address with no
 * membership, no invite and no relationship to this workspace read another
 * user's session in full. Session ids are unguessable, so this is not wide open
 * — but ids appear in URLs, logs and shared links, and "hard to guess" is not an
 * access control.
 *
 * This handler sits at the same path as the rewrite, and ONLY reaches these
 * requests because `next.config.ts` puts that rewrite under `fallback`. A bare
 * array means `afterFiles`, which Next applies BEFORE dynamic routes — the
 * first version of this gate built cleanly and was never reached. If you revert
 * next.config.ts to a bare array, this 403 silently stops existing.
 *
 * THE RULE: deny when the session is known to belong to someone else. Allow when
 * we have no record of it.
 *
 * That asymmetry is deliberate. The mirror write is debounced, so a session that
 * was created a second ago may not be in the database yet — requiring a record
 * would lock people out of the chat they just started, which is a worse and far
 * more frequent failure than the one being fixed. Every session that persists
 * gains a record, so the exposure this closes — someone turning up later with an
 * id they should not have — is closed. A brand-new session is unknown to the
 * attacker for the same reason it is unknown to us.
 */

const AGENT = process.env.NEXT_PUBLIC_EVE_API_URL ?? "https://fde-agent-api.vercel.app";

/** Headers worth forwarding upstream. Hop-by-hop and host headers are dropped. */
function forwardHeaders(request: NextRequest): Headers {
  const out = new Headers();
  for (const name of ["authorization", "content-type", "accept"]) {
    const value = request.headers.get(name);
    if (value) out.set(name, value);
  }
  return out;
}

/**
 * May `email` touch `sessionId`? Owner of the mirrored chat, owner of a shared
 * thread on that session, or an accepted member of one.
 */
async function permitted(sessionId: string, email: string): Promise<boolean> {
  const db = getOpsDb();
  if (!db) return true; // no database to consult — fail OPEN, see the note above
  try {
    const owners = await db
      .select({ owner: chatSessions.ownerEmail })
      .from(chatSessions)
      .where(eq(chatSessions.eveSessionId, sessionId));
    const threads = await db
      .select({ id: chatThreads.id, owner: chatThreads.ownerEmail })
      .from(chatThreads)
      .where(eq(chatThreads.eveSessionId, sessionId));

    // Unknown session: nothing to contradict, so let it through.
    if (owners.length === 0 && threads.length === 0) return true;

    const me = email.toLowerCase();
    if (owners.some((o) => o.owner?.toLowerCase() === me)) return true;
    if (threads.some((t) => t.owner?.toLowerCase() === me)) return true;

    // Shared with them? A thread member (viewer or participant) may read it.
    for (const t of threads) {
      const [member] = await db
        .select({ email: chatThreadMembers.email })
        .from(chatThreadMembers)
        .where(and(eq(chatThreadMembers.threadId, t.id), eq(chatThreadMembers.email, me)))
        .limit(1);
      if (member) return true;
    }
    return false;
  } catch (error) {
    // A database hiccup must not take chat down — the failure we refuse to
    // introduce is locking people out of their own conversations. But an access
    // check that disables ITSELF is a security event, and this used to happen in
    // total silence. Say it, loudly, every time.
    console.error("SESSION GATE FAILED OPEN — ownership not verified", {
      sessionId,
      email,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

async function proxy(request: NextRequest, segments: string[]): Promise<Response> {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!identity) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  const sessionId = segments[0];
  if (sessionId && !(await permitted(sessionId, identity.email))) {
    // Someone reaching for a conversation that is not theirs is worth a record,
    // whether it is an attack or a bug in our own reconcile logic.
    console.warn("session access denied", { sessionId, email: identity.email });
    return NextResponse.json({ error: "That conversation isn't yours." }, { status: 403 });
  }

  const url = `${AGENT}/eve/v1/session/${segments.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  const upstream = await fetch(url, {
    method,
    headers: forwardHeaders(request),
    body: hasBody ? request.body : undefined,
    // Required by undici when streaming a request body through.
    ...(hasBody ? { duplex: "half" } : {}),
    redirect: "manual",
  } as RequestInit & { duplex?: "half" });

  // Stream the body straight through — never buffer. The session stream is a
  // live tail, and reading it into memory here would hold the whole answer back
  // until the turn ended, turning a streaming chat into a long silence.
  const headers = new Headers();
  for (const name of ["content-type", "x-eve-session-id"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  /**
   * Tell every hop not to accumulate.
   *
   * Measured through this proxy, the same turn arrived as 20 text deltas in 2
   * network chunks; straight from the agent it was 40 deltas in 3. Passing
   * `upstream.body` along is necessary but not sufficient — an intermediary is
   * free to coalesce a chunked response unless told otherwise, and to a reader
   * that is the difference between text appearing as it is written and the
   * answer landing in two lumps at the end.
   *
   * `no-transform` forbids a proxy from re-encoding or re-chunking;
   * `X-Accel-Buffering: no` is the widely-honoured opt-out from response
   * buffering. Neither changes what is sent, only when it is allowed to leave.
   */
  headers.set("cache-control", "no-cache, no-store, no-transform");
  headers.set("x-accel-buffering", "no");
  headers.set("content-encoding", "identity");
  return new Response(upstream.body, { status: upstream.status, headers });
}

type Ctx = { params: Promise<{ segments: string[] }> };

export async function GET(request: NextRequest, ctx: Ctx) {
  return proxy(request, (await ctx.params).segments);
}
export async function POST(request: NextRequest, ctx: Ctx) {
  return proxy(request, (await ctx.params).segments);
}
export async function DELETE(request: NextRequest, ctx: Ctx) {
  return proxy(request, (await ctx.params).segments);
}
export async function PATCH(request: NextRequest, ctx: Ctx) {
  return proxy(request, (await ctx.params).segments);
}

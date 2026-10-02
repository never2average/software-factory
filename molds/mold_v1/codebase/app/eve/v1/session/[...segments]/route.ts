import { NextRequest, NextResponse } from "next/server";
import { gateForSession } from "@/lib/chat-session-access";
import { rightFor } from "@/lib/chat-gate";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { ORG_HEADER, isWorkspaceRefusal, resolveOrgForIdentity, workspaceRefusedResponse } from "@/lib/org-context";

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
 * next.config.ts to a bare array, this gate silently stops existing.
 *
 * THIS IS NO LONGER THE ONLY GATE, AND IT IS NOT THE ONE THAT COUNTS.
 *
 * The agent API is its own public deployment. A caller who skipped this proxy
 * and called it directly — any signed-in person, from any workspace — read, sent
 * into, answered approvals on and cancelled other people's sessions, because eve
 * checks who is calling and never whose session it is. So the agent now enforces
 * ownership itself (agent/lib/session-guard.ts) with the same rule and the same
 * reads as this proxy (lib/chat-gate.ts, lib/session-gate.ts). This handler is
 * the early refusal in front of it.
 *
 * Two things the old rule did are gone. It allowed a session nobody had a record
 * of (the mirror write is debounced, so "unknown" was read as "probably just
 * started"): the agent now records a session's owner before it returns the id,
 * so there is no such window, and a session with no owner is refused. And it
 * failed OPEN on a database error: it now answers 503, as the agent does.
 *
 * History worth keeping: the first version of this gate read with an unscoped
 * handle, production RLS fails closed, every read returned zero rows and every
 * session read as "unknown" — allowed. Every read here runs inside a workspace's
 * RLS scope (lib/session-gate.ts).
 */

const AGENT = process.env.NEXT_PUBLIC_EVE_API_URL ?? "https://fde-agent-api.vercel.app";

/** Headers worth forwarding upstream. Hop-by-hop and host headers are dropped. */
function forwardHeaders(request: NextRequest): Headers {
  const out = new Headers();
  // x-ops-org: the workspace THIS TAB is in. The agent takes a person's workspace from it (only one they are a member
  // of — agent/lib/service-scope.ts sessionAuthForRequest, checked by orgForSession), so the gate there reads the same
  // workspace this proxy just did, whichever workspace the person selected last in another tab.
  for (const name of ["authorization", "content-type", "accept", ORG_HEADER]) {
    const value = request.headers.get(name);
    if (value) out.set(name, value);
  }
  return out;
}

/**
 * What the proxy does with the shared gate's answer (lib/chat-gate.ts, read by lib/session-gate.ts — the SAME code
 * the agent runs in front of the same routes, agent/lib/session-guard.ts).
 *
 *   allowed                     → forward.
 *   refused, session KNOWN      → 404, here, without a round trip. Never 403: a stranger must not learn the id exists.
 *   refused, NO RECORD of it    → forward, and let the AGENT answer. The agent is the enforcement point and it is
 *                                 strictly better placed: it can resolve a subagent's child session to its root
 *                                 through eve's own lineage, which no database row here describes yet, and it
 *                                 refuses (404) anything it cannot place. This is not the old fail-open — that
 *                                 forwarded to an agent which checked nothing.
 *   the database cannot answer  → 503. It used to fail OPEN; the agent fails closed on the same error, so doing
 *                                 otherwise here would only have hidden it.
 */
async function permitted(
  sessionId: string,
  email: string,
  workspace: string | null,
  rest: string[],
  method: string,
  named: string | null = null,
): Promise<"forward" | "refuse" | "unavailable"> {
  try {
    const decision = await gateForSession(email, sessionId, rightFor(method, rest), workspace, named);
    if (decision.allow) return "forward";
    if (!decision.ownership && decision.reason === "unknown") return "forward";
    // Someone reaching for a conversation that is not theirs is worth a record, whether it is an attack or a bug.
    console.warn("session access denied", { sessionId, email, reason: decision.reason });
    return "refuse";
  } catch (error) {
    console.error("session gate could not read — refusing (503)", {
      sessionId,
      email,
      error: error instanceof Error ? error.message : String(error),
    });
    return "unavailable";
  }
}

async function proxy(request: NextRequest, segments: string[]): Promise<Response> {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!identity) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  /**
   * The workspace, resolved the way every neighbouring ops route resolves it.
   *
   * A null context means there is no verified identity — `resolveOrgForIdentity`
   * has its own fail-safes and always answers for a caller it can name — so
   * this is the same 401 as above, not a third outcome to reason about. It is
   * emphatically NOT the "unknown session" branch: an unresolvable caller is
   * the one case where allowing the request would be the gate deciding it does
   * not know who is asking and letting them in anyway.
   */
  const sessionId = segments[0];
  if (sessionId) {
    // The ONE workspace this request is in: the one it names (x-ops-org / ?org=) when the caller is a member of it,
    // their default when it names none. The gate reads that workspace and no other: a session recorded anywhere else
    // is "unknown" here. A workspace the request names but the caller is NOT in is never swapped for the caller's own
    // (lib/org-context.ts): there is then no request workspace, only the named one — a guest's link to one shared
    // chat, read-only — and anything else is refused by the agent, which resolves the same way.
    const asked = request.nextUrl.searchParams.get("org") || request.headers.get(ORG_HEADER) || null;
    const resolved = await resolveOrgForIdentity(identity.email, identity.hostedDomain, asked);
    if (isWorkspaceRefusal(resolved) && resolved.reason === "unavailable") return workspaceRefusedResponse(resolved);
    const workspace = isWorkspaceRefusal(resolved) ? null : resolved.orgId;
    const named = isWorkspaceRefusal(resolved) ? asked?.trim() || null : null;
    const verdict = await permitted(sessionId, identity.email, workspace, segments.slice(1), request.method, named);
    if (verdict === "refuse") {
      return NextResponse.json({ error: "Session not found.", ok: false }, { status: 404 });
    }
    if (verdict === "unavailable") {
      return NextResponse.json(
        { error: "Conversation access could not be checked right now. Try again in a moment.", ok: false },
        { status: 503, headers: { "retry-after": "5" } },
      );
    }
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

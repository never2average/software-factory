import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { chatThreads, chatTurnAuthors } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { threadAccess, callerEmail } from "@/lib/chat-threads";
import { isEmptyStore } from "@/lib/pg-error";
import { emailSignInConfigured, mintQueueDeliveryToken } from "@/lib/auth-session";
import { sentUnderClaim } from "@/lib/queue-delivery-token";
import {
  STALE_CLAIM_MS,
  claimForDirectSend,
  enqueueThreadMessage,
  fromLine,
  headOfQueue,
  pumpThreadQueue,
  releaseThread,
  removeThreadMessage,
  type PumpDeps,
  type PumpResult,
  type RunIn,
} from "@/lib/thread-queue-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const AGENT_URL = process.env.NEXT_PUBLIC_EVE_API_URL ?? "";

/**
 * POST /api/ops/threads/:id/messages — the multiplayer SEND RELAY.
 *
 * Two people can send into one eve session, but only SERIALLY: one turn at a time, on the one continuation token the
 * parked session holds. The thread row is the mutex (`turn_holder`, taken in one statement, an abandoned one taken
 * over after a few minutes), and the token is read from the session itself when it is parked — a session that is
 * running a turn, the owner's own included, is busy (lib/thread-queue-server.ts).
 *
 * A MESSAGE IS QUEUED, NEVER REFUSED FOR BEING SECOND (mold_v1-290). The relay used to answer a message that arrived
 * while a turn ran with 409 "A turn is in progress … Try again in a moment", so a participant who was not the chat's
 * author could not add anything while someone else's turn ran. Every message now goes into the chat's shared queue and
 * the queue runs in order, whoever sent each one: this request runs it at once when it is first in line and the thread
 * is free, and otherwise answers 202 `{ queued: true }`; a member's page runs the next one (`{ drain: true }`) when
 * the thread is free.
 *
 * EVERY QUEUED MESSAGE RUNS AS ITS AUTHOR. The request that runs the queue may be anyone's page; the message is sent
 * with a single-use token the server signs for the message's AUTHOR (lib/auth-session.ts `mintQueueDeliveryToken`,
 * queue "thread"), which the agent admits for that one body, once, while the author is the thread's owner or a live
 * participant. The author's standing is checked again right before (removed, or now a viewer: failed, nothing sent).
 * Where this deployment cannot sign, only the author's own page sends the author's messages — and the same on a
 * session the agent holds no owner record for (one from before drizzle/0022, mold_v1-291): no token is minted for it,
 * and each message goes on its author's own sign-in, exactly as before the queue.
 *
 * Who may post is unchanged: the owner and participants, never a viewer or a guest. An ANSWER (`inputResponses`) is
 * not queued: it belongs to the turn that asked, and is sent directly, by the person answering. On a database
 * drizzle/0048 has not reached yet, a message takes that same direct path, as it did before the queue — never a 503.
 *
 *   POST   { message, id? }          queue a message (and run it if it is next)
 *   POST   { drain: true }           run the next message if the thread is free
 *   DELETE ?item=<id>                take back your own message that has not gone yet
 */
const bodySchema = z.object({
  message: z.string().optional(),
  /** The message's id, minted by the page so a retried POST is the same message. */
  id: z.string().regex(/^[A-Za-z0-9_-]{6,80}$/).optional(),
  drain: z.boolean().optional(),
  inputResponses: z
    .array(z.object({ requestId: z.string(), optionId: z.string().optional(), text: z.string().optional() }))
    .optional(),
});

/** Read the session stream from `startIndex` until the turn parks (or a bounded
 *  timeout), returning the freshest continuation token, the newest session id
 *  (eve may re-mint), and how many events were seen. */
async function tailUntilPark(
  sessionId: string,
  authHeader: string,
  startIndex: number,
  budgetMs: number,
): Promise<{ token?: string; sessionId: string; count: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budgetMs);
  let token: string | undefined;
  let count = 0;
  let latestSession = sessionId;
  try {
    const res = await fetch(`${AGENT_URL}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=${startIndex}`, {
      headers: { authorization: authHeader },
      signal: ctrl.signal,
    });
    const sidHeader = res.headers.get("x-eve-session-id");
    if (sidHeader) latestSession = sidHeader;
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let done = false;
      while (!done) {
        const r = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) {
          if (!l.trim()) continue;
          count++;
          try {
            const ev = JSON.parse(l) as { type?: string; data?: { continuationToken?: string } };
            if (ev.type === "session.waiting" && typeof ev.data?.continuationToken === "string" && ev.data.continuationToken) {
              token = ev.data.continuationToken;
              done = true;
            } else if (ev.type === "session.completed" || ev.type === "session.failed") {
              done = true;
            }
          } catch {
            /* skip malformed */
          }
        }
      }
    }
  } catch {
    /* return what we captured */
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  // With a tail-relative startIndex there is no absolute base to add, so this
  // is a count of events SEEN, not a stream position. Nothing may treat it as
  // a cursor.
  return { token, sessionId: latestSession, count: startIndex < 0 ? count : startIndex + count };
}


/**
 * The session's last `count` events (a tail-relative read is a LIVE tail of a waiting session, so it is cut once the
 * backlog has arrived: `count` lines, 600 ms of quiet after the first, or 5 s at worst).
 */
async function recentEvents(sessionId: string, authHeader: string, count: number): Promise<Array<{ type?: string; data?: Record<string, unknown> }>> {
  const ctrl = new AbortController();
  const hard = setTimeout(() => ctrl.abort(), 5_000);
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const out: Array<{ type?: string; data?: Record<string, unknown> }> = [];
  try {
    const res = await fetch(`${AGENT_URL}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=-${count}`, {
      headers: { authorization: authHeader },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok || !res.body) return out;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          out.push(JSON.parse(l));
        } catch {
          /* a malformed line is skipped */
        }
      }
      if (out.length >= count) break;
      if (out.length > 0) {
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(() => ctrl.abort(), 600);
      }
    }
  } catch {
    /* what was read */
  } finally {
    clearTimeout(hard);
    if (quiet) clearTimeout(quiet);
    ctrl.abort();
  }
  return out;
}

/** How far back "was it already delivered?" reads: the last 500 events, then the last 5,000. */
const HISTORY_WINDOWS = [500, 5_000] as const;

/**
 * The session's history for the "already delivered?" check, and whether it is COMPLETE: read without error or timeout,
 * every line well-formed, and reaching back to the session's first event. Anything less proves nothing.
 */
async function readHistory(
  sessionId: string,
  authHeader: string,
  count: number,
): Promise<{ events: Array<{ type?: string; data?: Record<string, unknown> }>; ok: boolean; complete: boolean }> {
  const ctrl = new AbortController();
  let timedOut = false;
  const hard = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, 10_000);
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const events: Array<{ type?: string; data?: Record<string, unknown> }> = [];
  let malformed = false;
  try {
    const res = await fetch(`${AGENT_URL}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?startIndex=-${count}`, {
      headers: { authorization: authHeader },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok || !res.body) return { events, ok: false, complete: false };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          events.push(JSON.parse(l));
        } catch {
          malformed = true;
        }
      }
      if (events.length >= count) break;
      if (events.length > 0) {
        // A parked session's backlog arrives at once; the live tail after it stays quiet.
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(() => ctrl.abort(), 800);
      }
    }
  } catch {
    return { events, ok: false, complete: false };
  } finally {
    clearTimeout(hard);
    if (quiet) clearTimeout(quiet);
    ctrl.abort();
  }
  const ok = !timedOut && !malformed;
  return { events, ok, complete: ok && events[0]?.type === "session.started" };
}

/** The parked session's token: its last event is `session.waiting` with one. Anything else: a turn is running. */
async function parkedToken(sessionId: string, authHeader: string): Promise<{ token?: string; sessionId: string }> {
  const [last] = await recentEvents(sessionId, authHeader, 1);
  const token = last?.type === "session.waiting" ? last.data?.continuationToken : undefined;
  return { token: typeof token === "string" && token ? token : undefined, sessionId };
}

const runIn: RunIn = (orgId, fn) => withOrgRls(orgId, fn as never) as never;

type Access = NonNullable<Awaited<ReturnType<typeof threadAccess>>>;

/** Who wrote a turn, at the current end of the stream (best effort, as the relay always did). */
function recordAuthor(orgId: string, threadId: string, author: string) {
  void withOrgRls(orgId, (tx) =>
    tx.insert(chatTurnAuthors).values({ orgId, threadId, eventOffset: 0, authorEmail: author }).onConflictDoNothing(),
  ).catch(() => {});
}

/**
 * How the queue reaches the agent. Reads (is it parked, what did it receive, has the turn parked) are the caller's —
 * a member of the thread. A SEND is the author's: a single-use token signed for them, or — where this deployment
 * cannot sign — the caller's own sign-in, and then only for the caller's own messages (`canSendAs`).
 */
function pumpDeps(authHeader: string, access: Access, threadId: string, caller: string): PumpDeps {
  const orgId = access.thread.orgId;
  const signs = emailSignInConfigured();
  return {
    runIn,
    singleUse: signs,
    canSendAs: (author) => signs || author.toLowerCase() === caller.toLowerCase(),
    // ownerRecorded: the pump's default, the agent's owner record read in this workspace (lib/thread-queue-server.ts).
    parkedToken: (sessionId) => parkedToken(sessionId, authHeader),
    forward: async (send) => {
      let bearer = authHeader;
      // `signed` only when this deployment signs AND the agent holds an owner record for the session (a session from
      // before that record gets no token: its door would refuse it). Unsigned: the caller's own sign-in, for the
      // caller's own message only — the pump guarantees it, and this refuses anything else.
      if (send.signed) {
        try {
          bearer = `Bearer ${await mintQueueDeliveryToken(send.author, {
            org: orgId,
            sessionId: send.sessionId,
            scope: { act: "post", item: send.item, claim: send.claim, seq: send.seq, queue: "thread", thread: send.thread },
          })}`;
        } catch (e) {
          return { ok: false, status: 503, detail: errorText(e) };
        }
      } else if (send.author.toLowerCase() !== caller.toLowerCase()) {
        return { ok: false, status: 403, detail: "Only its author can send it here." };
      }
      try {
        const res = await fetch(`${AGENT_URL}/eve/v1/session/${encodeURIComponent(send.sessionId)}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: bearer },
          body: JSON.stringify({ message: send.message, continuationToken: send.continuationToken }),
        });
        return {
          ok: res.ok,
          status: res.status,
          sessionId: res.headers.get("x-eve-session-id") ?? send.sessionId,
          detail: res.ok ? undefined : await res.text().catch(() => ""),
        };
      } catch (e) {
        // No answer: whether the agent took it is unknown (the pump checks before any resend).
        return { ok: false, status: 0, detail: errorText(e) };
      }
    },
    // Tail-relative: from 0 the first `session.waiting` of the session is a spent token.
    tail: (sessionId) => tailUntilPark(sessionId, authHeader, -1, 280_000),
    // "no" only on a history read in full (back to the session's first event); a refused, failed, slow or truncated
    // read is "unknown", and the pump then fails the item as unconfirmed rather than send it twice.
    received: async (sessionId, claims) => {
      for (const count of HISTORY_WINDOWS) {
        const h = await readHistory(sessionId, authHeader, count);
        const hit = h.events.some(
          (e) => e.type === "message.received" && typeof e.data?.message === "string" && sentUnderClaim(e.data.message, claims),
        );
        if (hit) return "yes";
        if (h.complete) return "no";
        if (!h.ok) return "unknown";
      }
      return "unknown";
    },
    staleClaimMs: STALE_CLAIM_MS,
    onSent: (item) => recordAuthor(orgId, threadId, item.authorEmail),
  };
}

/** What a page is told about a pump: what ran, or why nothing did. */
function pumpView(r: PumpResult) {
  switch (r.outcome) {
    case "sent":
      return { outcome: r.outcome, id: r.item.id, sessionId: r.sessionId, parked: r.parked };
    case "refused":
      return { outcome: r.outcome, id: r.item.id, failed: r.failed, error: r.detail };
    case "busy":
      return { outcome: r.outcome, heldBy: r.heldBy };
    case "waiting-for-author":
      return { outcome: r.outcome, id: r.item.id };
    default:
      return { outcome: r.outcome };
  }
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  if (!AGENT_URL) return NextResponse.json({ error: "Agent URL not configured" }, { status: 503 });
  const authHeader = request.headers.get("authorization");
  const email = await callerEmail(request);
  if (!email || !authHeader) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || (!parsed.data.message && !parsed.data.inputResponses && !parsed.data.drain)) {
    return NextResponse.json({ error: "Provide a message or inputResponses." }, { status: 400 });
  }

  try {
    const access = await threadAccess(request, db, id, email);
    if (!access) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    if (access.role === "viewer") {
      return NextResponse.json({ error: "View-only members can't send. Ask the owner for participant access." }, { status: 403 });
    }
    if (parsed.data.inputResponses) return await direct(access, id, email, authHeader, { inputResponses: parsed.data.inputResponses });

    const orgId = access.thread.orgId;
    const deps = pumpDeps(authHeader, access, id, email);
    if (!parsed.data.message) {
      // { drain: true } — run the next message if the thread is free (a member's page, when the thread is free).
      return NextResponse.json(pumpView(await pumpThreadQueue(deps, { orgId, threadId: id, pumper: email })));
    }

    const itemId = parsed.data.id ?? crypto.randomUUID();
    const queued = await enqueueThreadMessage(runIn, { orgId, threadId: id, author: email, id: itemId, text: parsed.data.message });
    // The queue's table is not there yet (drizzle/0048 not applied to this database): send it the way the relay
    // always did, so a shared chat never goes down for a migration that has not reached its database.
    if (!queued.ok && queued.reason === "no-queue") {
      return await direct(access, id, email, authHeader, { message: parsed.data.message });
    }
    if (!queued.ok) {
      const status = queued.reason === "full" ? 429 : queued.reason === "foreign" ? 409 : 400;
      const error =
        queued.reason === "full"
          ? "This chat already has as many messages waiting as it can hold. Try again once some have run."
          : queued.reason === "foreign"
            ? "That message id is already used."
            : `The message could not be queued (${queued.detail ?? "invalid"}).`;
      return NextResponse.json({ error }, { status });
    }
    // Behind someone else's message: it waits its turn. The page shows it in the chat's queue.
    if (queued.ahead > 0) return NextResponse.json({ queued: true, id: itemId, ahead: queued.ahead }, { status: 202 });

    const ran = await pumpThreadQueue(deps, { orgId, threadId: id, pumper: email });
    if (ran.outcome === "sent" && ran.item.id === itemId) {
      return NextResponse.json({ ok: true, id: itemId, sessionId: ran.sessionId, parked: ran.parked });
    }
    if (ran.outcome === "refused" && ran.item.id === itemId && ran.failed) {
      return NextResponse.json({ error: ran.detail, id: itemId }, { status: 502 });
    }
    const head = await headOfQueue(runIn, { orgId, threadId: id });
    return NextResponse.json(
      {
        queued: true,
        id: itemId,
        ahead: head && head.id !== itemId ? 1 : 0,
        heldBy: ran.outcome === "busy" ? ran.heldBy : null,
      },
      { status: 202 },
    );
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

/** Take back your own message from the chat's queue, while it has not gone. */
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const email = await callerEmail(request);
  if (!email) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const { id } = await ctx.params;
  const item = request.nextUrl.searchParams.get("item") ?? "";
  try {
    const access = await threadAccess(request, db, id, email);
    if (!access || access.role === "viewer") return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    const r = await removeThreadMessage(runIn, { orgId: access.thread.orgId, threadId: id, author: email, id: item });
    if (r === "removed") return NextResponse.json({ ok: true });
    if (r === "already-sent") return NextResponse.json({ error: "Already sent." }, { status: 409 });
    if (r === "no-queue") {
      return NextResponse.json({ error: "This chat's message queue is not set up here yet." }, { status: 503 });
    }
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (e) {
    if (isEmptyStore(e)) return NextResponse.json({ error: "This chat's message queue is not set up here yet." }, { status: 503 });
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

/**
 * THE DIRECT PATH: one send by the person asking, on their own sign-in — an ANSWER to the turn's open question or
 * approval (not queued: it belongs to the turn that asked, which holds the thread until it is answered), or a message
 * when the queue's table does not exist yet. The same mutex as the queue: the thread taken in one statement, the
 * parked session's own token, the turn tailed until it parks and the thread given back with the fresh token; 409 when
 * a turn is running.
 */
async function direct(
  access: Access,
  id: string,
  email: string,
  authHeader: string,
  send: {
    readonly message?: string;
    readonly inputResponses?: NonNullable<z.infer<typeof bodySchema>["inputResponses"]>;
  },
) {
  const orgId = access.thread.orgId;
  const got = await claimForDirectSend(
    { runIn, parkedToken: (sid) => parkedToken(sid, authHeader), staleClaimMs: STALE_CLAIM_MS },
    { orgId, threadId: id, holder: email },
  );
  if ("busy" in got) {
    return NextResponse.json(
      { error: `A turn is in progress${got.heldBy ? ` (held by ${got.heldBy})` : ""}. Try again in a moment.`, heldBy: got.heldBy ?? undefined },
      { status: 409 },
    );
  }
  const message = send.message ? fromLine(email, send.message) : undefined;
  let forward: Response;
  try {
    forward = await fetch(`${AGENT_URL}/eve/v1/session/${encodeURIComponent(got.sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader },
      body: JSON.stringify({ message, inputResponses: send.inputResponses, continuationToken: got.token }),
    });
  } catch (e) {
    // No answer: the thread stays held until the session is read again (a stale claim is taken over), never handed
    // back with a token that may have been spent.
    return NextResponse.json({ error: `The agent did not answer. ${errorText(e)}` }, { status: 502 });
  }
  if (!forward.ok) {
    // Refused: the token was not spent, and the thread is free again.
    await releaseThread(runIn, { orgId, threadId: id, claim: got.claim });
    const detail = await forward.text().catch(() => "");
    return NextResponse.json({ error: `The agent rejected the send (${forward.status}). ${detail}`.trim() }, { status: 502 });
  }
  recordAuthor(orgId, id, email);
  const parked = await tailUntilPark(forward.headers.get("x-eve-session-id") ?? got.sessionId, authHeader, -1, 280_000);
  await withOrgRls(orgId, (tx) =>
    tx
      .update(chatThreads)
      .set({
        continuationToken: parked.token ?? null,
        eveSessionId: parked.sessionId,
        updatedAt: new Date(),
        /**
         * Keep the claim when nothing was recovered.
         *
         * A tail severed before the turn parked (the 120 s case) proves nothing about the turn: it may still be
         * running. Handing the thread back would let the next send in at once; keeping the holder and its time lets
         * the stale-claim takeover fire (lib/thread-queue-server.ts `claimThread`), by which time the session's own
         * parked token is read again.
         */
        ...(parked.token ? { turnHolder: null } : {}),
        ...(parked.token ? { turnClaimedAt: null } : {}),
      })
      .where(
        and(
          eq(chatThreads.id, id),
          eq(chatThreads.turnHolder, got.claim.holder),
          sql`${chatThreads.turnClaimedAt} = ${got.claim.claimedAt}::timestamptz`,
        ),
      ),
  );
  return NextResponse.json({ ok: true, sessionId: parked.sessionId, parked: Boolean(parked.token) });
}

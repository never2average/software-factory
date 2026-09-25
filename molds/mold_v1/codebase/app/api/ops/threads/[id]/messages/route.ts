import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { chatThreads, chatTurnAuthors } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { accessFor, callerEmail } from "@/lib/chat-threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const AGENT_URL = process.env.NEXT_PUBLIC_EVE_API_URL ?? "";
// A claim older than this is treated as abandoned (crashed sender) and the token
// is recovered from the stream so the thread can't wedge on a lost turn.
const STALE_CLAIM_MS = 3 * 60_000;

/**
 * POST /api/ops/threads/:id/messages — the multiplayer SEND RELAY.
 *
 * Two people can send into one eve session, but only SERIALLY: exactly one valid
 * continuation token exists, minted only when the turn parks. This relay is the
 * single writer:
 *  1. ATOMIC CLAIM — take the token out of the row (set it null + record the
 *     holder) in one UPDATE. A concurrent second sender gets zero rows → 409.
 *  2. Forward `{message|inputResponses, continuationToken}` to eve, prefixing a
 *     text message with `[from: email]` so the agent knows who's speaking.
 *  3. Tail the stream until the turn parks, recover the fresh token, and write it
 *     back (clearing the holder). Record the author at the event offset.
 *
 * Viewers can never send/approve — participant or owner only. Once shared, the
 * token lives ONLY in the row, never on a client: that is the concurrency fix
 * AND the leak fix.
 */
const bodySchema = z.object({
  message: z.string().optional(),
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
  if (!parsed.success || (!parsed.data.message && !parsed.data.inputResponses)) {
    return NextResponse.json({ error: "Provide a message or inputResponses." }, { status: 400 });
  }

  try {
    const access = await accessFor(db, id, email);
    if (!access) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    if (access.role === "viewer") {
      return NextResponse.json({ error: "View-only members can't send. Ask the owner for participant access." }, { status: 403 });
    }

    // 1. ATOMIC CLAIM — take the token out of the row in one statement. The CTE
    // captures the OLD token (plain RETURNING would give the new null value); the
    // guard `continuation_token IS NOT NULL` means a concurrent second claimer
    // gets zero rows.
    const claimed = (await withOrgRls(access.thread.orgId, (tx) =>
      tx.execute(sql`
      WITH prev AS (SELECT continuation_token AS tok, eve_session_id AS sid FROM chat_threads WHERE id = ${id})
      UPDATE chat_threads t
      SET continuation_token = NULL, turn_holder = ${email}, turn_claimed_at = now()
      FROM prev
      WHERE t.id = ${id} AND t.continuation_token IS NOT NULL
      RETURNING prev.tok AS token, prev.sid AS session
    `),
    )) as unknown as Array<{ token: string; session: string }>;

    let token: string | undefined = claimed[0]?.token;
    let sessionId = claimed[0]?.session ?? access.thread.eveSessionId;

    if (!token) {
      // No token was available — either a turn is genuinely in flight, or a
      // previous claim was abandoned (crashed sender). Recover only if stale.
      const [current] = await withOrgRls(access.thread.orgId, (tx) =>
        tx.select().from(chatThreads).where(eq(chatThreads.id, id)).limit(1),
      );
      if (!current) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
      sessionId = current.eveSessionId;
      const stale = current.turnClaimedAt && Date.now() - current.turnClaimedAt.getTime() > STALE_CLAIM_MS;
      if (stale) {
        // Tail-relative for the same reason as the main path: from 0 this
        // recovers the FIRST session.waiting in the session, which on any
        // multi-turn thread is a spent token — so the recovery handed back
        // exactly the stale value it was meant to replace.
        const recovered = await tailUntilPark(sessionId, authHeader, -1, 8000);
        token = recovered.token;
        sessionId = recovered.sessionId;
        // Take over the (now stale) claim.
        await withOrgRls(access.thread.orgId, (tx) =>
          tx
          .update(chatThreads)
          .set({ continuationToken: null, turnHolder: email, turnClaimedAt: new Date() })
          .where(eq(chatThreads.id, id)),
        );
      }
      if (!token) {
        return NextResponse.json(
          { error: `A turn is in progress${current.turnHolder ? ` (held by ${current.turnHolder})` : ""}. Try again in a moment.`, heldBy: current.turnHolder ?? undefined },
          { status: 409 },
        );
      }
    }

    // 2. Forward to eve, prefixing a text message with the sender.
    const message = parsed.data.message ? `[from: ${email}]\n\n${parsed.data.message}` : undefined;
    const forward = await fetch(`${AGENT_URL}/eve/v1/session/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader },
      body: JSON.stringify({ message, inputResponses: parsed.data.inputResponses, continuationToken: token }),
    });
    if (!forward.ok) {
      // The send failed — put the token back so the thread isn't wedged.
      await withOrgRls(access.thread.orgId, (tx) =>
        tx
          .update(chatThreads)
          .set({ continuationToken: token, turnHolder: null, turnClaimedAt: null })
          .where(eq(chatThreads.id, id)),
      );
      const detail = await forward.text().catch(() => "");
      return NextResponse.json({ error: `The agent rejected the send (${forward.status}). ${detail}`.trim() }, { status: 502 });
    }
    const newSession = forward.headers.get("x-eve-session-id") ?? sessionId;

    // Record author attribution at the current end of the stream.
    void withOrgRls(access.thread.orgId, (tx) =>
      tx
        .insert(chatTurnAuthors)
        .values({ orgId: access.thread.orgId, threadId: id, eventOffset: 0, authorEmail: email })
        .onConflictDoNothing(),
    ).catch(() => {});

    /**
     * 3. Tail until the turn parks and recover the CURRENT token.
     *
     * From index 0 this read the first `session.waiting` in the whole session —
     * on any thread past its first turn that is an OLD token. eve accepts one
     * live continuation at a time and rejects a stale one, so the next send
     * 502'd, the handler wrote the same stale token back, and the thread was
     * dead for good.
     *
     * `-1` is tail-relative: the stream starts at the latest event, so the only
     * `session.waiting` it can see is this turn's. eve's docs name exactly this
     * as "a lightweight way to recover the current continuationToken".
     */
    const parked = await tailUntilPark(newSession, authHeader, -1, 280_000);
    await withOrgRls(access.thread.orgId, (tx) =>
      tx
        .update(chatThreads)
        .set({
          continuationToken: parked.token ?? null,
          turnHolder: null,
          /**
           * Keep the claim when nothing was recovered.
           *
           * Clearing it looked like tidy-up and was a trap: the stale-claim
           * recovery requires `turnClaimedAt` to be non-null, so a turn whose tail
           * was severed before it parked (the 120s case — the turn itself finished
           * fine) left a thread that could never be declared stale and 409'd every
           * subsequent send, forever. Leaving the claim lets recovery reclaim it.
           */
          ...(parked.token ? { turnClaimedAt: null } : {}),
          eveSessionId: parked.sessionId,
          updatedAt: new Date(),
        })
        .where(eq(chatThreads.id, id)),
    );

    return NextResponse.json({ ok: true, sessionId: parked.sessionId, parked: Boolean(parked.token) });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

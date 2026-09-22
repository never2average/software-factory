import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import {
  chatSessions,
  chatThreadMembers,
  chatThreads,
  chatTranscriptSnapshots,
} from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { isEmptyStore } from "@/lib/pg-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-user chat threads — the durable mirror of the sidebar list, so a user's
 * chats follow their account across devices (localStorage stays the instant-open
 * cache). Metadata only; message history replays from the eve session on open.
 *
 *  GET    /api/ops/chat-sessions          — this user's non-archived threads.
 *  POST   /api/ops/chat-sessions {sessions}— upsert a batch (owner = caller).
 *  DELETE /api/ops/chat-sessions?id=…      — remove one, AND every copy of it:
 *                                            the transcript cache and the share.
 *
 * Fail-safe: a MISSING TABLE is reported as an empty store, so the front-end
 * DB-sync is harmless before the migration runs. Every other failure is a 503.
 * These are not the same answer and must never be collapsed again: the sidebar
 * replaces its list with whatever this returns, so a query that failed and
 * reported "[]" emptied people's chats in front of them. Read failures have to
 * be distinguishable from emptiness by the caller.
 */

async function callerEmail(request: NextRequest): Promise<string | null> {
  return (await verifyOpsAuth(request.headers.get("authorization")))?.email ?? null;
}

export async function GET(request: NextRequest) {
  const email = (await callerEmail(request))?.toLowerCase();
  if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // No DATABASE_URL is the JSON-fallback deployment: genuinely no store.
  const db = getOpsDb();
  if (!db) return NextResponse.json({ items: [] });
  // Resolving the workspace is itself a query, so it fails when the database
  // does. A signed-in caller always has one — "no workspace" here means we
  // could not read it, not that they have no chats.
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "workspace unavailable" }, { status: 503 });
  try {
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(chatSessions)
        .where(and(eq(chatSessions.ownerEmail, email), eq(chatSessions.orgId, ctx.orgId), eq(chatSessions.archived, false)))
        .orderBy(desc(chatSessions.updatedAt))
        .limit(200),
    );

    /**
     * Hide rows for threads somebody else owns.
     *
     * The write path now refuses to create these, but rows already exist from
     * before that check — and this list is what an incognito window renders
     * from, so filtering here is what actually makes the sidebar correct today.
     * Such a thread is still reachable under "Shared with you", which reads the
     * threads table where the ownership actually lives.
     */
    const sessionIds = rows.map((r) => r.eveSessionId).filter((id): id is string => Boolean(id));
    const foreign = new Set<string>();
    if (sessionIds.length) {
      const owned = await withOrgRls(ctx.orgId, (tx) =>
        tx
          .select({ eveSessionId: chatThreads.eveSessionId, ownerEmail: chatThreads.ownerEmail })
          .from(chatThreads)
          .where(inArray(chatThreads.eveSessionId, sessionIds)),
      );
      for (const o of owned) {
        if (o.ownerEmail.toLowerCase() !== email) foreign.add(o.eveSessionId);
      }
    }
    const visible = rows.filter((r) => !r.eveSessionId || !foreign.has(r.eveSessionId));

    // Invitees per thread: link chat_sessions → chat_threads (shared clientKey)
    // → chat_thread_members (non-owner, non-revoked). Best-effort — a failure
    // here must not blank the thread list, so it's wrapped and defaults to none.
    const inviteesByKey = new Map<string, string[]>();
    try {
      const keys = visible.map((r) => r.clientKey).filter((k): k is string => Boolean(k));
      if (keys.length) {
        const threads = await withOrgRls(ctx.orgId, (tx) =>
          tx
            .select({ clientKey: chatThreads.clientKey, threadId: chatThreads.id })
            .from(chatThreads)
            .where(and(eq(chatThreads.ownerEmail, email), inArray(chatThreads.clientKey, keys))),
        );
        const threadIds = threads.map((t) => t.threadId);
        const members = threadIds.length
          ? await withOrgRls(ctx.orgId, (tx) =>
              tx
              .select({ threadId: chatThreadMembers.threadId, memberEmail: chatThreadMembers.email })
              .from(chatThreadMembers)
              .where(and(inArray(chatThreadMembers.threadId, threadIds), ne(chatThreadMembers.status, "revoked"), ne(chatThreadMembers.role, "owner"))),
            )
          : [];
        const byThread = new Map<string, string[]>();
        for (const m of members) {
          if (m.memberEmail.toLowerCase() === email) continue; // never list yourself
          const a = byThread.get(m.threadId) ?? [];
          a.push(m.memberEmail);
          byThread.set(m.threadId, a);
        }
        for (const t of threads) if (t.clientKey) inviteesByKey.set(t.clientKey, byThread.get(t.threadId) ?? []);
      }
    } catch {
      /* invitees are optional — leave the map empty */
    }

    return NextResponse.json({
      items: visible.map((r) => ({
        id: r.id,
        clientKey: r.clientKey ?? undefined,
        title: r.title ?? "",
        preview: r.preview ?? undefined,
        messageCount: r.messageCount ?? undefined,
        customers: r.customers ?? undefined,
        forkedFrom: r.forkedFrom ?? undefined,
        eveSessionId: r.eveSessionId ?? undefined,
        continuationToken: r.continuationToken ?? undefined,
        derivedCustomers: r.derivedCustomers ?? undefined,
        toolCounts: r.toolCounts ?? undefined,
        invitees: (r.clientKey && inviteesByKey.get(r.clientKey)) || undefined,
        updatedAt: r.updatedAt ? r.updatedAt.getTime() : Date.now(),
      })),
    });
  } catch (e) {
    if (isEmptyStore(e)) return NextResponse.json({ items: [] }); // pre-migration
    console.error("chat-sessions GET failed", e);
    return NextResponse.json({ error: "chat store unavailable" }, { status: 503 });
  }
}

const sessionSchema = z.object({
  id: z.string().min(1),
  clientKey: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  preview: z.string().nullable().optional(),
  messageCount: z.number().int().nullable().optional(),
  customers: z.array(z.string()).nullable().optional(),
  forkedFrom: z.object({ id: z.string(), title: z.string() }).nullable().optional(),
  eveSessionId: z.string().nullable().optional(),
  continuationToken: z.string().nullable().optional(),
  derivedCustomers: z.array(z.string()).nullable().optional(),
  toolCounts: z.object({ artifacts: z.number(), emails: z.number() }).nullable().optional(),
  archived: z.boolean().optional(),
  updatedAt: z.number().optional(),
});
const bodySchema = z.object({ sessions: z.array(sessionSchema).max(200) });

export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ ok: false }, { status: 401 });
  const email = (await callerEmail(request))?.toLowerCase();
  const db = getOpsDb();
  if (!db || !email) return NextResponse.json({ ok: false });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Invalid" }, { status: 400 });
  try {
    /**
     * A thread somebody else owns is never one of your chats.
     *
     * The client has several mount paths and each one had to remember not to
     * persist a shared thread; one of them forgot, and the result was another
     * person's conversation sitting in the viewer's own sidebar — reproduced in
     * incognito, so no amount of local pruning could reach it. Enforcing it
     * here means no client path can get it wrong: if a chat_thread exists for
     * this eve session and it belongs to someone else, the row is refused.
     */
    const sessionIds = parsed.data.sessions
      .map((s) => s.eveSessionId)
      .filter((id): id is string => Boolean(id));
    const foreign = new Set<string>();
    if (sessionIds.length) {
      const owners = await withOrgRls(ctx.orgId, (tx) =>
        tx
          .select({ eveSessionId: chatThreads.eveSessionId, ownerEmail: chatThreads.ownerEmail })
          .from(chatThreads)
          .where(inArray(chatThreads.eveSessionId, sessionIds)),
      );
      for (const o of owners) {
        if (o.ownerEmail.toLowerCase() !== email) foreign.add(o.eveSessionId);
      }

      /**
       * NOR IS A SESSION SOMEBODY ELSE HAS ALREADY MIRRORED.
       *
       * The check above only knows about SHARED conversations, because a
       * `chat_threads` row exists only once a thread has been shared. An
       * ordinary private chat has no such row — so this route would happily
       * write "I own eve session X" for any id a caller named, and
       * `lib/chat-session-access.ts` then derived read AND write access to the
       * cached transcript from exactly that row. A colleague who learned a
       * session id (they appear in the audit feed, in logs, in links) could
       * claim somebody's private conversation and then read, overwrite or
       * delete the most complete copy of it this system stores, through
       * /api/ops/chat-snapshots and /api/ops/chat-replay.
       *
       * One session, one owner: the first mirror row wins. The read rule
       * independently refuses a session with more than one claimant, because
       * rows minted before this check still exist.
       */
      const claimed = await withOrgRls(ctx.orgId, (tx) =>
        tx
          .select({
            id: chatSessions.id,
            eveSessionId: chatSessions.eveSessionId,
            ownerEmail: chatSessions.ownerEmail,
          })
          .from(chatSessions)
          .where(inArray(chatSessions.eveSessionId, sessionIds)),
      );
      for (const c of claimed) {
        if (c.eveSessionId && c.ownerEmail.toLowerCase() !== email) foreign.add(c.eveSessionId);
      }
    }

    let refused = 0;
    for (const s of parsed.data.sessions) {
      if (s.eveSessionId && foreign.has(s.eveSessionId)) {
        refused += 1;
        continue;
      }
      const values = {
        id: s.id,
        orgId: ctx.orgId,
        ownerEmail: email,
        clientKey: s.clientKey ?? null,
        title: s.title ?? null,
        preview: s.preview ?? null,
        messageCount: s.messageCount ?? null,
        customers: s.customers ?? null,
        forkedFrom: s.forkedFrom ?? null,
        eveSessionId: s.eveSessionId ?? null,
        continuationToken: s.continuationToken ?? null,
        derivedCustomers: s.derivedCustomers ?? null,
        toolCounts: s.toolCounts ?? null,
        archived: s.archived ?? false,
        updatedAt: s.updatedAt ? new Date(s.updatedAt) : new Date(),
      };
      /**
       * A thread belongs to the workspace it was STARTED in, permanently.
       *
       * orgId used to be in the update set, and the client mirrors its whole
       * local thread list on every sync — so switching workspace re-stamped
       * every existing conversation into the new one. The sidebar then showed
       * one tenant's chats under another tenant's name, with the workspace
       * header confidently disagreeing with the contents.
       *
       * Omitting orgId from the update is the whole fix: an insert sets it, an
       * update can never move it.
       */
      const { orgId: _immutable, ...mutable } = values;
      await withOrgRls(ctx.orgId, (tx) =>
        tx
          .insert(chatSessions)
          .values(values)
          .onConflictDoUpdate({ target: chatSessions.id, set: { ...mutable, ownerEmail: email } }),
      );
    }
    return NextResponse.json({
      ok: true,
      count: parsed.data.sessions.length - refused,
      ...(refused ? { refused } : {}),
    });
  } catch {
    return NextResponse.json({ ok: false }); // table absent — no-op
  }
}

export async function DELETE(request: NextRequest) {
  const email = (await callerEmail(request))?.toLowerCase();
  const db = getOpsDb();
  if (!db || !email) return NextResponse.json({ ok: false });
  // Deleting was scoped by owner email alone. Adding the workspace matches how
  // the list and the upsert already behave, and keeps a thread's workspace the
  // one it was started in right through to its removal.
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ ok: false }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  try {
    /**
     * DELETING A CHAT DELETES THE COPIES OF IT, HERE, NOT IN THE BROWSER.
     *
     * The client used to fire three independent requests — this one, a snapshot
     * DELETE and nothing at all for the thread — from a `void fetch(…)` with an
     * empty catch. Closing the tab on the click, losing the network for a
     * second, or simply navigating away left the cached transcript (the most
     * complete copy of the conversation this system stores) in the table for
     * good, attached to a chat the person watched disappear. A deletion that
     * depends on the deleter's browser staying alive is not a deletion.
     *
     * So the server does the whole cascade, in the one request that is already
     * authorized: the mirror row, the transcript cache, and the share.
     */
    const [mine] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select({ eveSessionId: chatSessions.eveSessionId })
        .from(chatSessions)
        .where(
          and(
            eq(chatSessions.id, id),
            eq(chatSessions.ownerEmail, email),
            eq(chatSessions.orgId, ctx.orgId),
          ),
        )
        .limit(1),
    );
    const eveSessionId = mine?.eveSessionId ?? null;
    if (eveSessionId) {
      await withOrgRls(ctx.orgId, (tx) =>
        tx
          .delete(chatTranscriptSnapshots)
          .where(
            and(
              eq(chatTranscriptSnapshots.orgId, ctx.orgId),
              eq(chatTranscriptSnapshots.eveSessionId, eveSessionId),
            ),
          ),
      );
      /**
       * A deleted chat cannot stay shared.
       *
       * The `chat_threads` row was never touched by a delete, so members kept
       * the thread in "Shared with you", kept streaming it and kept reading the
       * transcript of a conversation its owner had deleted. Archived rather
       * than dropped — the row is referenced by turn authorship and the audit
       * trail, and "who was in this thread" is a question worth being able to
       * answer afterwards — with the member rows revoked, which is what every
       * access check in the system already reads.
       */
      const threads = await withOrgRls(ctx.orgId, (tx) =>
        tx
          .update(chatThreads)
          .set({ archivedAt: new Date(), continuationToken: null, updatedAt: new Date() })
          .where(and(eq(chatThreads.eveSessionId, eveSessionId), eq(chatThreads.ownerEmail, email)))
          .returning({ id: chatThreads.id }),
      );
      if (threads.length) {
        await withOrgRls(ctx.orgId, (tx) =>
          tx
            .update(chatThreadMembers)
            .set({ status: "revoked", revokedAt: new Date() })
            .where(
              and(
                inArray(
                  chatThreadMembers.threadId,
                  threads.map((t) => t.id),
                ),
                ne(chatThreadMembers.status, "revoked"),
              ),
            ),
        );
      }
    }
    await withOrgRls(ctx.orgId, (tx) =>
      tx
        .delete(chatSessions)
        .where(
          and(
            eq(chatSessions.id, id),
            eq(chatSessions.ownerEmail, email),
            eq(chatSessions.orgId, ctx.orgId),
          ),
        ),
    );
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false });
  }
}

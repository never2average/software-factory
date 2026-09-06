import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { inboxItems } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { isEmptyStore } from "@/lib/pg-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/inbox — off-platform conversations awaiting triage, GROUPED.
 *
 * Grouping happens here rather than in the panel because it decides what a
 * "conversation" is, and that has to match what promotion writes: one
 * interaction per thread, not per message. Doing it client-side would let the
 * two drift.
 *
 * ?status=new|promoted|dismissed  (default: new)
 */
export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ threads: [] });

  const status = new URL(request.url).searchParams.get("status") ?? "new";
  try {
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(inboxItems)
        .where(and(eq(inboxItems.orgId, ctx.orgId), eq(inboxItems.status, status)))
        .orderBy(desc(inboxItems.occurredAt))
        .limit(500),
    );

    // One entry per thread, newest first, with the messages inside it oldest
    // first — a conversation reads forwards even though the list reads backwards.
    const byThread = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = r.threadKey;
      if (!byThread.has(k)) byThread.set(k, []);
      byThread.get(k)!.push(r);
    }

    const threads = [...byThread.entries()].map(([threadKey, msgs]) => {
      const ordered = [...msgs].sort(
        (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
      );
      const latest = ordered[ordered.length - 1];
      // Union of everyone who appears anywhere in the thread — a reply often
      // adds people the first message never mentioned.
      const participants = [...new Set(ordered.flatMap((m) => m.participants ?? []))];
      return {
        threadKey,
        source: latest.source,
        subject: latest.subject ?? ordered[0].subject ?? "(no subject)",
        preview: latest.preview,
        participants,
        // Null customerId is surfaced, not guessed at — an unmatched thread is
        // a thing the operator needs to see and resolve.
        customerId: ordered.find((m) => m.customerId)?.customerId ?? null,
        // A thread counts as read only when every message in it has been —
        // otherwise a reply arriving on a read thread stays invisible.
        unread: ordered.some((m) => !m.readAt),
        messageCount: ordered.length,
        firstAt: ordered[0].occurredAt,
        lastAt: latest.occurredAt,
        messages: ordered.map((m) => ({
          id: m.id,
          from: (m.participants ?? [])[0] ?? null,
          preview: m.preview,
          body: m.body,
          occurredAt: m.occurredAt,
        })),
      };
    });
    threads.sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());

    return NextResponse.json({ threads });
  } catch (e) {
    // Same rule as the chat list: a failed read is a 503, never an empty list.
    // "No conversations" and "I could not look" must not render identically.
    if (isEmptyStore(e)) return NextResponse.json({ threads: [] });
    console.error("inbox GET failed", e);
    return NextResponse.json({ error: "inbox unavailable" }, { status: 503 });
  }
}

/**
 * PATCH /api/ops/inbox — dismiss a thread.
 *
 * Dismissing marks the rows rather than deleting them: ingestion dedupes on
 * (org, source, external_id), so a deleted row would be re-created by the next
 * sync and the operator would triage the same thread forever.
 */
export async function PATCH(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  const body = (await request.json().catch(() => null)) as
    | { threadKey?: string; status?: string; read?: boolean }
    | null;
  const threadKey = body?.threadKey?.trim();
  if (!threadKey) return NextResponse.json({ error: "threadKey is required" }, { status: 400 });
  if (body?.status && !["new", "dismissed"].includes(body.status)) {
    return NextResponse.json({ error: "status must be 'new' or 'dismissed'" }, { status: 400 });
  }

  // One endpoint for both, because they are the same operation from the row's
  // point of view: change how this thread is filed.
  const patch: { status?: string; readAt?: Date | null } = {};
  if (body?.status) patch.status = body.status;
  if (body?.read !== undefined) patch.readAt = body.read ? new Date() : null;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to change — pass status or read." }, { status: 400 });
  }

  try {
    const updated = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .update(inboxItems)
        .set(patch)
        .where(and(eq(inboxItems.orgId, ctx.orgId), eq(inboxItems.threadKey, threadKey)))
        .returning({ id: inboxItems.id }),
    );
    return NextResponse.json({ ok: true, updated: updated.length });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

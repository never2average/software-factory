import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { chatThreadMembers, chatThreads } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { recordActivity } from "@/lib/ops-activity";
import { accessFor, callerEmail, publicThread } from "@/lib/chat-threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/ops/threads/:id — the thread + its member list, for anyone with
 * access. Opening an INVITED thread accepts the invite (opening = accepting).
 * PATCH — metadata (title/preview/customers/session/token) — owner or the
 * turn-relay only; here we allow the owner + participants to update the live
 * session/token bookkeeping. DELETE — archive, owner-only.
 */
export async function GET(request: NextRequest, ctx: Ctx) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const email = await callerEmail(request);
  if (!email) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const access = await accessFor(db, id, email);
    if (!access) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    // Opening an invite accepts it.
    if (access.member?.status === "invited") {
      await withOrgRls(access.thread.orgId, (tx) =>
        tx
          .update(chatThreadMembers)
          .set({ status: "accepted", acceptedAt: new Date() })
          .where(and(eq(chatThreadMembers.threadId, id), eq(chatThreadMembers.email, email))),
      );
    }
    const members = await withOrgRls(access.thread.orgId, (tx) =>
      tx
        .select()
        .from(chatThreadMembers)
        .where(eq(chatThreadMembers.threadId, id))
        .orderBy(asc(chatThreadMembers.invitedAt)),
    );
    return NextResponse.json({ item: publicThread(access.thread, access.role, members) });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  preview: z.string().nullable().optional(),
  customers: z.array(z.string()).nullable().optional(),
  // Session bookkeeping — eve may re-mint the session id mid-stream.
  eveSessionId: z.string().min(1).optional(),
  clientEvents: z.array(z.unknown()).nullable().optional(),
});

export async function PATCH(request: NextRequest, ctx: Ctx) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const email = await callerEmail(request);
  if (!email) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  try {
    const access = await accessFor(db, id, email);
    if (!access) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    // Metadata edits: owner or participant (viewers are read-only).
    if (access.role === "viewer") {
      return NextResponse.json({ error: "View-only members cannot edit the thread." }, { status: 403 });
    }
    const [row] = await withOrgRls(access.thread.orgId, (tx) =>
      tx
        .update(chatThreads)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(chatThreads.id, id))
        .returning(),
    );
    return NextResponse.json({ item: publicThread(row, access.role) });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, ctx: Ctx) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const email = await callerEmail(request);
  if (!email) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const access = await accessFor(db, id, email);
    if (!access) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    if (access.role !== "owner") {
      return NextResponse.json({ error: "Only the owner can delete this thread." }, { status: 403 });
    }
    /**
     * UN-SHARING HAS TO REMOVE ACCESS, not just a row from a list.
     *
     * Archiving alone did nothing. Neither `accessFor` (lib/chat-threads.ts)
     * nor `accessForSession` (lib/chat-session-access.ts) looked at
     * `archived_at`, so every member went on streaming the thread and reading
     * its cached transcript exactly as before — the words "un-shared the
     * thread" appeared in the activity feed and nowhere in the access rules.
     *
     * Three things, because each one is read by a different check: the archive
     * stamp (the stream proxy and the transcript rule refuse it now), the
     * revoked member rows (what `accessFor` has always read, and what the eve
     * session gate now reads), and clearing the relay's token so a claim cannot
     * outlive the share.
     *
     * Archived rather than deleted: turn authorship and the audit trail
     * reference this row, and "who was in this thread" is a question worth
     * still being able to answer.
     */
    await withOrgRls(access.thread.orgId, (tx) =>
      tx
        .update(chatThreads)
        .set({ archivedAt: new Date(), continuationToken: null, updatedAt: new Date() })
        .where(eq(chatThreads.id, id)),
    );
    await withOrgRls(access.thread.orgId, (tx) =>
      tx
        .update(chatThreadMembers)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(and(eq(chatThreadMembers.threadId, id), ne(chatThreadMembers.status, "revoked"))),
    );
    void recordActivity(db, {
      entityType: "thread",
      entityId: id,
      actor: email,
      event: `${email} un-shared the thread`,
      orgId: access.thread.orgId,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

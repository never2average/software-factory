import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { chatThreadMembers } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { recordActivity } from "@/lib/ops-activity";
import { accessFor, callerEmail } from "@/lib/chat-threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string; email: string }>;
}

/**
 * PATCH /api/ops/threads/:id/members/:email — change a member's role (owner
 * only), or a member accepting their own invite.
 * DELETE — revoke a member (owner only). Revoke keeps the row (status='revoked')
 * for audit; the member loses access immediately at the app layer.
 */
const patchSchema = z.object({
  role: z.enum(["participant", "viewer"]).optional(),
  status: z.enum(["accepted"]).optional(),
});

export async function PATCH(request: NextRequest, ctx: Ctx) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const caller = await callerEmail(request);
  if (!caller) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const { id, email: rawEmail } = await ctx.params;
  const target = decodeURIComponent(rawEmail).toLowerCase();
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  try {
    const access = await accessFor(db, id, caller);
    if (!access) return NextResponse.json({ error: "Thread not found" }, { status: 404 });

    // A member accepting their own invite.
    if (parsed.data.status === "accepted" && target === caller) {
      await withOrgRls(access.thread.orgId, (tx) =>
        tx
          .update(chatThreadMembers)
          .set({ status: "accepted", acceptedAt: new Date() })
          .where(and(eq(chatThreadMembers.threadId, id), eq(chatThreadMembers.email, caller))),
      );
      return NextResponse.json({ ok: true });
    }
    // Role change — owner only.
    if (parsed.data.role) {
      if (access.role !== "owner") {
        return NextResponse.json({ error: "Only the owner can change roles." }, { status: 403 });
      }
      await withOrgRls(access.thread.orgId, (tx) =>
        tx
          .update(chatThreadMembers)
          .set({ role: parsed.data.role })
          .where(and(eq(chatThreadMembers.threadId, id), eq(chatThreadMembers.email, target))),
      );
      void recordActivity(db, {
        entityType: "thread",
        entityId: id,
        actor: caller,
        event: `${caller} set ${target}'s role to ${parsed.data.role}`,
        orgId: access.thread.orgId,
});
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, ctx: Ctx) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const caller = await callerEmail(request);
  if (!caller) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const { id, email: rawEmail } = await ctx.params;
  const target = decodeURIComponent(rawEmail).toLowerCase();
  try {
    const access = await accessFor(db, id, caller);
    if (!access) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    // Owner revokes anyone; a member may remove themselves (leave).
    if (access.role !== "owner" && target !== caller) {
      return NextResponse.json({ error: "Only the owner can revoke members." }, { status: 403 });
    }
    await withOrgRls(access.thread.orgId, (tx) =>
      tx
        .update(chatThreadMembers)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(and(eq(chatThreadMembers.threadId, id), eq(chatThreadMembers.email, target))),
    );
    void recordActivity(db, {
      entityType: "thread",
      entityId: id,
      actor: caller,
      event: target === caller ? `${caller} left the thread` : `${caller} revoked ${target}`,
      orgId: access.thread.orgId,
});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

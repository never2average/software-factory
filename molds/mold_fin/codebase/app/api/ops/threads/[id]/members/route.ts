import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { chatThreadMembers } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { recordActivity } from "@/lib/ops-activity";
import { accessFor, callerEmail } from "@/lib/chat-threads";
import { notifyInvite } from "@/lib/platform-notify";
import { CONSUMER_DOMAINS } from "@/lib/ops-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/ops/threads/:id/members — invite a teammate (owner-only in MVP).
 * A member row with status='invited'; the invitee simply sees the thread on
 * next load (domain-locked identity means no magic-link token needed). Adding an
 * already-revoked member re-invites them.
 */
/**
 * Anyone with a work address may be invited — including people outside your
 * company, since sharing a thread with a customer or a contractor is a real
 * thing to want. What is refused is a PERSONAL account: sign-in rejects those,
 * so inviting one would mint a member row for an identity that can never
 * authenticate, and the invite would die without ever saying so.
 *
 * The dialog marks outside-the-company members as external and warns before
 * the first one, so a cross-company share is deliberate rather than a typo.
 */
function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}
const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["participant", "viewer"]).default("viewer"),
});

export async function POST(request: NextRequest, ctx: Ctx) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const caller = await callerEmail(request);
  if (!caller) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const { id } = await ctx.params;
  const parsed = inviteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  const invitee = parsed.data.email.toLowerCase().trim();
  const inviteeDomain = domainOf(invitee);
  if (CONSUMER_DOMAINS.has(inviteeDomain)) {
    return NextResponse.json(
      { error: `${invitee} is a personal account. Invite their work address instead.` },
      { status: 400 },
    );
  }
  const external = inviteeDomain !== domainOf(caller);
  try {
    const access = await accessFor(db, id, caller);
    if (!access) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    if (access.role !== "owner") {
      return NextResponse.json({ error: "Only the owner can invite members." }, { status: 403 });
    }
    if (invitee === access.thread.ownerEmail) {
      return NextResponse.json({ error: "The owner is already on the thread." }, { status: 400 });
    }
    // Upsert: re-inviting a revoked member reactivates them.
    const [row] = await withOrgRls(access.thread.orgId, (tx) =>
      tx
        .insert(chatThreadMembers)
        .values({
          orgId: access.thread.orgId,
          threadId: id,
          email: invitee,
          role: parsed.data.role,
          status: "invited",
          invitedBy: caller,
        })
        .onConflictDoUpdate({
          target: [chatThreadMembers.threadId, chatThreadMembers.email],
          set: { role: parsed.data.role, status: "invited", invitedBy: caller, invitedAt: new Date(), revokedAt: null },
        })
        .returning(),
    );
    void recordActivity(db, {
      entityType: "thread",
      entityId: id,
      actor: caller,
      event:
        `${caller} invited ${invitee} as ${parsed.data.role}` +
        (external ? ` — OUTSIDE ${domainOf(caller)}` : ""),
      orgId: access.thread.orgId,
});
    // DETERMINISTIC platform notification — a coded send through the ORG's own
    // channel (never the user's account, never the agent). No-ops cleanly when
    // the org credential isn't configured; the in-app "Shared with you" is the
    // always-present fallback.
    // Awaited, not fire-and-forget: the dialog should be able to say whether
    // this person was actually told. Still non-fatal — a failed notice leaves a
    // valid member row and the in-app "Shared with you" entry.
    const delivery = await notifyInvite({
      to: invitee,
      inviter: caller,
      role: parsed.data.role,
      title: access.thread.title,
      threadUrl: access.thread.eveSessionId
        ? `${new URL(request.url).origin}/?chatSession=${encodeURIComponent(access.thread.eveSessionId)}`
        : undefined,
    });
    return NextResponse.json(
      { item: { email: row.email, role: row.role, status: row.status, external }, delivery },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function GET(request: NextRequest, ctx: Ctx) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ items: [] });
  const caller = await callerEmail(request);
  if (!caller) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const access = await accessFor(db, id, caller);
    if (!access) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    const rows = await withOrgRls(access.thread.orgId, (tx) =>
      tx.select().from(chatThreadMembers).where(eq(chatThreadMembers.threadId, id)),
    );
    // `external` is relative to whoever is asking — the flag exists to tell a
    // reader "this person is not one of us", so it must be computed per caller
    // rather than stored against the thread.
    const callerDomain = domainOf(caller);
    return NextResponse.json({
      items: rows.map((m) => ({
        email: m.email,
        role: m.role,
        status: m.status,
        external: domainOf(m.email) !== callerDomain,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

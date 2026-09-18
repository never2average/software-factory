import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { chatPresence, chatThreads } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { accessFor, callerEmail } from "@/lib/chat-threads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ops/threads/:id/presence — heartbeat. Called every ~10s while a
 * member has the thread open; `typing` bumps a short typing window. Returns the
 * live roster in the same round-trip so the client needs one call, not two.
 * GET — the roster only.
 *
 * Polled heartbeats are the pragmatic presence channel on Vercel (no WebSockets,
 * no LISTEN/NOTIFY). "Online" = seen within the last ~25s; "typing" = typing
 * window not yet elapsed.
 */
const TYPING_MS = 6000;

const bodySchema = z.object({ typing: z.boolean().optional() });

async function roster(
  db: NonNullable<ReturnType<typeof getOpsDb>>,
  // The workspace arrives as a parameter: this helper runs before and after the
  // access check, so it cannot reach for the thread row itself.
  orgId: string,
  threadId: string,
  me: string,
) {
  const rows = await withOrgRls(orgId, (tx) =>
    tx
      .select()
      .from(chatPresence)
      .where(
        and(
          eq(chatPresence.threadId, threadId),
          gt(chatPresence.lastSeenAt, sql`now() - interval '25 seconds'`),
        ),
      ),
  );
  const now = Date.now();
  return rows
    .filter((r) => r.email !== me)
    .map((r) => ({
      email: r.email,
      typing: Boolean(r.typingUntil && r.typingUntil.getTime() > now),
    }));
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ online: [], turnHolder: null });
  const email = await callerEmail(request);
  if (!email) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  const typing = parsed.success ? Boolean(parsed.data.typing) : false;
  try {
    const access = await accessFor(db, id, email);
    if (!access) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    await withOrgRls(access.thread.orgId, (tx) =>
      tx
        .insert(chatPresence)
        .values({
          orgId: access.thread.orgId,
          threadId: id,
          email,
          lastSeenAt: new Date(),
          typingUntil: typing ? new Date(Date.now() + TYPING_MS) : null,
        })
        .onConflictDoUpdate({
          target: [chatPresence.threadId, chatPresence.email],
          set: { lastSeenAt: new Date(), typingUntil: typing ? new Date(Date.now() + TYPING_MS) : null },
        }),
    );
    return NextResponse.json({ online: await roster(db, access.thread.orgId, id, email), turnHolder: access.thread.turnHolder });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ online: [], turnHolder: null });
  const email = await callerEmail(request);
  if (!email) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const access = await accessFor(db, id, email);
    if (!access) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    const [thread] = await withOrgRls(access.thread.orgId, (tx) =>
      tx.select().from(chatThreads).where(eq(chatThreads.id, id)).limit(1),
    );
    return NextResponse.json({ online: await roster(db, access.thread.orgId, id, email), turnHolder: thread?.turnHolder ?? null });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

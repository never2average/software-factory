import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { roomPresence } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Workspace-scoped presence — "who's here now" for any room.
 *
 *  POST /api/ops/presence  { room, activity? } — heartbeat (call every ~10s);
 *       upserts the caller's presence and returns the live roster.
 *  GET  /api/ops/presence?room=<room>          — the roster only.
 *
 * Org-scoped (a room in one workspace is invisible to another). Polled
 * heartbeats; "online" = seen in the last ~25s. Fail-safe: no DB / table
 * absent → an empty roster so callers never break.
 */

const bodySchema = z.object({ room: z.string().min(1).max(200), activity: z.string().max(120).nullable().optional() });

async function roster(
  db: NonNullable<ReturnType<typeof getOpsDb>>,
  orgId: string,
  room: string,
  me: string,
) {
  const rows = await withOrgRls(orgId, (tx) =>
    tx
      .select()
      .from(roomPresence)
      .where(
        and(
          eq(roomPresence.orgId, orgId),
          eq(roomPresence.room, room),
          ne(roomPresence.email, me),
          gt(roomPresence.lastSeenAt, sql`now() - interval '25 seconds'`),
        ),
      ),
  );
  return rows.map((r) => ({ email: r.email, activity: r.activity ?? null }));
}

export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (ctx instanceof Response) return ctx;
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!ctx || !identity) return NextResponse.json({ online: [] }, { status: 200 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ online: [] });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "room required" }, { status: 400 });
  const email = identity.email.toLowerCase();
  try {
    await withOrgRls(ctx.orgId, (tx) =>
      tx
        .insert(roomPresence)
        .values({ orgId: ctx.orgId, room: parsed.data.room, email, activity: parsed.data.activity ?? null, lastSeenAt: new Date() })
        .onConflictDoUpdate({
          target: [roomPresence.orgId, roomPresence.room, roomPresence.email],
          set: { lastSeenAt: new Date(), activity: parsed.data.activity ?? null },
        }),
    );
    return NextResponse.json({ online: await roster(db, ctx.orgId, parsed.data.room, email) });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (ctx instanceof Response) return ctx;
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!ctx || !identity) return NextResponse.json({ online: [] }, { status: 200 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ online: [] });
  const room = new URL(request.url).searchParams.get("room") ?? "";
  if (!room) return NextResponse.json({ error: "room required" }, { status: 400 });
  try {
    return NextResponse.json({ online: await roster(db, ctx.orgId, room, identity.email.toLowerCase()) });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

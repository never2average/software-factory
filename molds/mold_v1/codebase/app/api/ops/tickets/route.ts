import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, asc, eq } from "drizzle-orm";
import { tickets } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/tickets — id + label pairs for the TODO ticket-link picker.
 *
 * Scoped to the caller's workspace. This route previously had no org filter at
 * all: it returned every ticket in the database to any signed-in user, so two
 * companies on the platform would have read each other's customer tickets. It
 * only looked correct because a single workspace existed.
 */
export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ items: [] });
  try {
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(tickets)
        .where(and(eq(tickets.orgId, ctx.orgId)))
        .orderBy(asc(tickets.customerId), asc(tickets.ticketId))
        .limit(300));
    const items = rows.map((t) => ({
      id: t.ticketId,
      label: [t.ticketId, t.summary].filter(Boolean).join(" · ").slice(0, 90),
      sub: t.customerId ?? undefined,
      // Extras for the "My tickets" TODO view (pickers ignore these).
      owner: t.ticketOwnerEmail ?? null,
      status: t.ticketStatus,
      priority: t.ticketPriority,
      customer: t.customerId ?? null,
    }));
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

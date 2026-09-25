import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, desc, eq } from "drizzle-orm";
import { entityActivity } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENTITIES = new Set(["task", "cycle", "deployment", "implementation"]);

/**
 * GET /api/ops/activity?entity=<type>&id=<id> — the newest-first activity feed
 * for one workspace entity (task / cycle / deployment / implementation).
 */
export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ items: [] });
  const url = new URL(request.url);
  const entity = url.searchParams.get("entity") ?? "";
  const id = url.searchParams.get("id") ?? "";
  if (!ENTITIES.has(entity) || !id) {
    return NextResponse.json({ error: "entity + id required" }, { status: 400 });
  }
  try {
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx
      .select()
      .from(entityActivity)
      .where(and(eq(entityActivity.orgId, ctx.orgId), eq(entityActivity.entityType, entity), eq(entityActivity.entityId, id)))
      .orderBy(desc(entityActivity.createdAt))
      .limit(100),
    );
    return NextResponse.json({
      items: rows.map((r) => ({ id: r.id, actor: r.actor, event: r.event, at: r.createdAt.toISOString() })),
    });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

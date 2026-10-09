import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, desc, eq, isNotNull, or } from "drizzle-orm";
import { z } from "zod";
import { appVersions } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/apps/:id/versions — this app's refresh history, newest first.
 *
 * The document bodies come along so the UI can show a past version instantly
 * without a second round-trip; ?limit caps the page (1..100, default 30).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  // This route read tenant data with NO workspace resolved at all.
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ items: [] });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid app id" }, { status: 400 });

  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .catch(30)
    .parse(request.nextUrl.searchParams.get("limit") ?? 30);

  try {
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(appVersions)
        // A refresh still in progress has a version with neither a document nor an error yet (lib/app-refresh.ts):
        // it is shown as the app's "Refreshing…", not as an empty entry in the history.
        .where(and(eq(appVersions.appId, id), or(isNotNull(appVersions.contentMd), isNotNull(appVersions.error))))
        .orderBy(desc(appVersions.createdAt))
        .limit(limit),
    );
    return NextResponse.json({ items: rows });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

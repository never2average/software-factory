import { NextRequest, NextResponse } from "next/server";
import { scriptForDisplay } from "@/lib/workflow-availability";
import { errorText } from "@/lib/ops-errors";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { workflowInstructionVersions } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Version history for one workflow's operator-instructions override, newest
 * first — the "Restore version" menu in the Ops Center editor reads this.
 *
 * Read-only: restoring is not a rewind, it is a normal PATCH of `instructions`
 * with the old text (which appends a version of its own), so there is no POST
 * here. See app/api/ops/workflows/[id]/route.ts.
 */
const uuidSchema = z.uuid();

const LIMIT = 25;

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  // This route read tenant data with NO workspace resolved at all.
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid workflow id" }, { status: 400 });
  }
  // Which file's history: the workflow script, or the instructions override.
  const kind = request.nextUrl.searchParams.get("kind") === "script" ? "script" : "instructions";
  try {
    const items = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(workflowInstructionVersions)
        .where(
          and(
            eq(workflowInstructionVersions.workflowId, id),
            eq(workflowInstructionVersions.kind, kind),
          ),
        )
        .orderBy(desc(workflowInstructionVersions.createdAt))
        .limit(LIMIT),
    );
    // A script version that is a base library original reads in the profile's words, like the editor shows it.
    return NextResponse.json({ items: kind === "script" ? items.map((v) => ({ ...v, content: scriptForDisplay(v.content) })) : items });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

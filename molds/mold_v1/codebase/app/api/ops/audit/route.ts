import { NextRequest, NextResponse } from "next/server";
import { errorText, zodMessage as opsZodMessage } from "@/lib/ops-errors";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { automationAudit } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/audit?type=<t>&id=<id>&limit=<n> — the change log for one
 * automation, newest first. `type` is a closed set; `id` is the automation
 * row's uuid or the system cron's name.
 */
const querySchema = z.strictObject({
  type: z.enum(["schedule", "system_cron", "connector", "workflow"]),
  id: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// The issue list in the profile's words (lib/ops-errors.ts); "query" names a bad query string.
const zodMessage = (error: z.ZodError): string => opsZodMessage(error, "query");

export async function GET(request: NextRequest) {
  /**
   * An audit trail is tenant data. This route filtered on automation type + id
   * ONLY, so anyone signed in could read another workspace's audit history by
   * naming an automation id — and ids are handed out in URLs.
   */
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ items: [] });
  const params = request.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    type: params.get("type") ?? undefined,
    id: params.get("id") ?? undefined,
    limit: params.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  const { type, id, limit } = parsed.data;
  try {
    const items = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(automationAudit)
        .where(
          and(
            eq(automationAudit.orgId, ctx.orgId),
            eq(automationAudit.automationType, type),
            eq(automationAudit.automationId, id),
          ),
        )
        .orderBy(desc(automationAudit.createdAt))
        .limit(limit),
    );
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

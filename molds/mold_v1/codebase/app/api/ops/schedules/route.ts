import { NextRequest, NextResponse } from "next/server";
import { errorText, zodMessage } from "@/lib/ops-errors";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { scheduleRules } from "@/agent/lib/db/schema";
import { recordOpsAudit } from "@/lib/ops-audit";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createScheduleSchema = z.strictObject({
  name: z.string().min(1),
  prompt: z.string().min(1),
  cron: z.string().nullable().optional(),
  everyMinutes: z.number().int().positive().nullable().optional(),
  kind: z.string().min(1).optional(),
  // WHICH workflow (workflows.name) a fire of this rule runs; null = none.
  workflow: z.string().nullable().optional(),
  channelId: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  // Who to notify when the rule decides to alert — handed to the agent at
  // dispatch time (see agent/schedules/dynamic.ts).
  notifyEmail: z.string().nullable().optional(),
  // The recipient LIST (supersedes the deprecated single notifyEmail above).
  notifyEmails: z.array(z.email()).nullable().optional(),
  enabled: z.boolean().optional(),
  createdBy: z.string().min(1).default("web"),
});


export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!getOpsDb()) return NextResponse.json({ items: [] });
  try {
    const items = await withOrgRls(ctx.orgId, (tx) =>
      tx.select().from(scheduleRules).where(eq(scheduleRules.orgId, ctx.orgId)).orderBy(desc(scheduleRules.createdAt)),
    );
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = createScheduleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  try {
    const [item] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .insert(scheduleRules)
        // First fire = now; the dynamic dispatcher advances next_run_at after.
        .values({ ...parsed.data, orgId: ctx.orgId, nextRunAt: new Date() })
        .returning(),
    );
    // Best-effort audit trail — a failed audit write never fails the create.
    const cadence = item.everyMinutes === null ? "one-time" : `every ${item.everyMinutes}m`;
    await recordOpsAudit(db, {
      automationType: "schedule",
      automationId: item.id,
      actor: parsed.data.createdBy,
      event: `Created schedule "${item.name}" (${cadence})`,
      orgId: ctx.orgId,
    });
    return NextResponse.json({ item }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

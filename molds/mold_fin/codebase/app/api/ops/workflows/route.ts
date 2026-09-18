import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { workflows } from "@/agent/lib/db/schema";
import { recordOpsAudit } from "@/lib/ops-audit";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createWorkflowSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  trigger: z.string().min(1).optional(),
  customerId: z.string().nullable().optional(),
  steps: z.array(z.string()).optional(),
  // Operator instructions override — injected into the matching subagent's
  // context at turn start (see agent/lib/workflow-override.ts).
  instructions: z.string().nullable().optional(),
  notifyEmail: z.string().nullable().optional(),
  // The recipient LIST (supersedes the deprecated single notifyEmail above).
  notifyEmails: z.array(z.email()).nullable().optional(),
  enabled: z.boolean().optional(),
  createdBy: z.string().min(1).default("web"),
});

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
    .join("; ");
}

export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!getOpsDb()) return NextResponse.json({ items: [] });
  try {
    const items = await withOrgRls(ctx.orgId, (tx) =>
      tx.select().from(workflows).where(eq(workflows.orgId, ctx.orgId)).orderBy(desc(workflows.createdAt)),
    );
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
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
  const parsed = createWorkflowSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  try {
    const [item] = await withOrgRls(ctx.orgId, (tx) =>
      tx.insert(workflows).values({ ...parsed.data, orgId: ctx.orgId }).returning(),
    );
    // Best-effort audit trail — a failed audit write never fails the create.
    await recordOpsAudit(db, {
      automationType: "workflow",
      automationId: item.id,
      actor: parsed.data.createdBy,
      event: `Created workflow "${item.name}" (trigger: ${item.trigger})`,
      orgId: ctx.orgId,
    });
    return NextResponse.json({ item }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

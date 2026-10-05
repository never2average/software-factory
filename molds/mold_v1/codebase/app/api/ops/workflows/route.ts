import { NextRequest, NextResponse } from "next/server";
import { errorText, zodMessage } from "@/lib/ops-errors";
import { withheldLibraryNote, workflowForList } from "@/lib/workflow-availability";
import { workflowAppSource } from "@/lib/app-source";
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


export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  if (!getOpsDb()) return NextResponse.json({ items: [] });
  try {
    const items = await withOrgRls(ctx.orgId, (tx) =>
      tx.select().from(workflows).where(eq(workflows.orgId, ctx.orgId)).orderBy(desc(workflows.createdAt)),
    );
    // Each row with what this deployment can do with it (lib/workflow-availability.ts): derived, never stored. A
    // base library row that needs a specialist this deployment excludes is listed as "not in this workspace", in
    // the profile's words and without naming the specialist, so a person can open it and adopt it. `libraryNote`
    // says in one sentence why the library is smaller here; computed on the server, so the client bundle never
    // carries the base library's text.
    // `appSource`: whether the row can generate an APP's document, and as what (a script, or the row of one of this
    // workspace's specialists), or why not (lib/app-source.ts). The apps picker reads it, so it never offers a row
    // an app could only fail on.
    return NextResponse.json({ items: items.map((w) => ({ ...workflowForList(w), appSource: workflowAppSource(w, w.name) })), libraryNote: withheldLibraryNote() });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
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
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

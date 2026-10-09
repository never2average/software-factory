import { NextRequest, NextResponse } from "next/server";
import { errorText, zodMessage } from "@/lib/ops-errors";
import { scriptToStore, workflowForList } from "@/lib/workflow-availability";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { workflowInstructionVersions, workflows } from "@/agent/lib/db/schema";
import { analyzeWorkflowScript } from "@/lib/workflow-validate";
import { describePatch, recordOpsAudit } from "@/lib/ops-audit";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchWorkflowSchema = z.strictObject({
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  trigger: z.string().min(1).optional(),
  customerId: z.string().nullable().optional(),
  steps: z.array(z.string()).nullable().optional(),
  // Operator instructions override — injected into the matching subagent's
  // context at turn start (see agent/lib/workflow-override.ts).
  instructions: z.string().nullable().optional(),
  // The override's own switch: false parks the text on the row without letting
  // it reach the subagent.
  instructionsEnabled: z.boolean().optional(),
  // The workflow SCRIPT (JavaScript, executed in the sandbox). Validated below
  // before it is stored: a script that cannot parse must not reach the DB.
  script: z.string().nullable().optional(),
  notifyEmail: z.string().nullable().optional(),
  // The recipient LIST (supersedes the deprecated single notifyEmail above).
  notifyEmails: z.array(z.email()).nullable().optional(),
  enabled: z.boolean().optional(),
  // Who is making the change (audit-trail only; not a column).
  actor: z.string().min(1).optional(),
});

// DELETE may carry an optional JSON body naming the actor for the audit trail.
const deleteBodySchema = z.strictObject({ actor: z.string().min(1).optional() });


const uuidSchema = z.uuid();

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/ops/workflows/:id — one workflow plus the STATIC GRAPH parsed from
 * its script (`analyzeWorkflowScript`). The analyzer is `server-only` (acorn),
 * so the run visualizer can't parse the script in the browser — this is how the
 * DAG skeleton reaches the client. The script itself rides along for the
 * "view the active workflow script" modal.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid workflow id" }, { status: 400 });
  }
  try {
    const [item] = await withOrgRls(ctx.orgId, (tx) =>
      tx.select().from(workflows).where(and(eq(workflows.id, id), eq(workflows.orgId, ctx.orgId))).limit(1),
    );
    if (!item) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    const analysis = item.script ? analyzeWorkflowScript(item.script) : null;
    // As the list shows it: a base library original's text in the profile's words (lib/workflow-availability.ts).
    return NextResponse.json({ item: workflowForList(item), analysis });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid workflow id" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = patchWorkflowSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  const { actor = "web", ...patch } = parsed.data;
  // Saving a library original's displayed (spoken) script unchanged is not an edit (lib/workflow-availability.ts).
  if (typeof patch.script === "string") patch.script = scriptToStore(patch.script);
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }
  // A script that does not parse — or that reaches for the host — is refused
  // here, so the DB only ever holds scripts that could actually run.
  if (typeof patch.script === "string" && patch.script.trim()) {
    const analysis = analyzeWorkflowScript(patch.script);
    if (!analysis.ok) {
      const first = analysis.issues.find((i) => i.level === "error");
      return NextResponse.json(
        { error: `Line ${first?.line ?? 1}: ${first?.message ?? "The script is invalid."}` },
        { status: 400 },
      );
    }
  }

  try {
    // Read the old row first so the audit entry can describe the actual diff.
    const [before] = await withOrgRls(ctx.orgId, (tx) =>
      tx.select().from(workflows).where(and(eq(workflows.id, id), eq(workflows.orgId, ctx.orgId))).limit(1),
    );
    if (!before) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }
    const [item] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .update(workflows)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(workflows.id, id), eq(workflows.orgId, ctx.orgId)))
        .returning(),
    );
    if (!item) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }
    // Every SAVE of the override is a version, so the editor can restore an
    // earlier one. Only a real change is recorded — re-saving identical text
    // would otherwise flood the history. A restore comes back through this same
    // path and appends a version of its own; history never rewinds.
    for (const [kind, next, prev] of [
      ["instructions", patch.instructions, before.instructions],
      ["script", patch.script, before.script],
    ] as const) {
      if (next === undefined || next === prev) continue;
      try {
        await withOrgRls(ctx.orgId, (tx) =>
          tx
            .insert(workflowInstructionVersions)
            .values({ orgId: ctx.orgId, workflowId: id, kind, content: next, author: actor }),
        );
      } catch (error) {
        // Bookkeeping — a failed version write must not fail the save itself.
        console.error(`[ops] could not record a ${kind} version for ${id}:`, error);
      }
    }
    // Best-effort audit trail — a failed audit write never fails the patch.
    await recordOpsAudit(db, {
      automationType: "workflow",
      automationId: id,
      actor,
      event: describePatch(before, patch),
      orgId: ctx.orgId,
    });
    return NextResponse.json({ item });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid workflow id" }, { status: 400 });
  }
  // Optional body: { actor } for the audit trail; no/invalid body means "web".
  const body = await request.json().catch(() => null);
  const actor = deleteBodySchema.safeParse(body).data?.actor ?? "web";
  try {
    const deleted = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .delete(workflows)
        .where(and(eq(workflows.id, id), eq(workflows.orgId, ctx.orgId)))
        .returning({ id: workflows.id, name: workflows.name }),
    );
    if (deleted.length === 0) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }
    // Best-effort audit trail — a failed audit write never fails the delete.
    await recordOpsAudit(db, {
      automationType: "workflow",
      automationId: id,
      actor,
      event: `Deleted workflow "${deleted[0].name}"`,
      orgId: ctx.orgId,
    });
    return NextResponse.json({ deleted: true });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

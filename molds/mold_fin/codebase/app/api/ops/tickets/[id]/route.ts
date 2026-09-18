import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { customers, tickets, todos } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { customerInOrg, orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/ops/tickets/:id — the full ticket record (keyed by ticketId; first
 * match wins) plus the team TODOs linked to it, for the Control Panel's in-rail
 * task detail.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const octx = await orgContextForRequest(request);
  if (!octx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ found: false, ticket: null, todos: [] });
  const { id } = await context.params;
  try {
    const [row] = await withOrgRls(octx.orgId, (tx) =>
      tx.select().from(tickets).where(eq(tickets.ticketId, id)).limit(1),
    );
    if (!row) return NextResponse.json({ found: false, ticket: null, todos: [] });
    // The ticket's customer must belong to the caller's workspace.
    if (!(await customerInOrg(octx.orgId, row.customerId))) {
      return NextResponse.json({ found: false, ticket: null, todos: [] });
    }
    const [cust] = await withOrgRls(octx.orgId, (tx) =>
      tx
        .select({ name: customers.customerName })
        .from(customers)
        .where(eq(customers.customerId, row.customerId))
        .limit(1),
    );
    const linked = await withOrgRls(octx.orgId, (tx) =>
      tx.select().from(todos).where(and(eq(todos.orgId, octx.orgId), isNull(todos.archivedAt))),
    );
    const related = linked
      .filter((t) => t.linkType === "ticket" && t.linkId === id)
      .map((t) => ({
        id: t.id,
        title: t.title,
        done: t.done,
        priority: t.priority,
        dueAt: t.dueAt?.toISOString() ?? null,
      }));
    return NextResponse.json({
      found: true,
      ticket: {
        id: row.ticketId,
        customer: row.customerId,
        customerLabel: cust?.name ?? row.customerId,
        summary: row.summary,
        description: row.description,
        status: row.ticketStatus,
        priority: row.ticketPriority,
        severity: row.severity,
        type: row.ticketType,
        category: row.ticketCategory,
        owner: row.ticketOwnerEmail,
        contact: row.customerContactEmail,
        opened: row.ticketOpenedDate,
        due: row.ticketDueDate,
        slaStatus: row.slaStatus,
        escalated: row.escalated ?? false,
        productionImpact: row.productionImpact ?? false,
        impactLevel: row.customerImpactLevel,
        impactSummary: row.customerImpactSummary,
        issueDomain: row.issueDomain,
        rootCause: row.rootCauseSummary,
        resolution: row.resolutionSummary,
        sourceLink: row.sourceLink,
        tags: row.tags ?? [],
      },
      todos: related,
    });
  } catch (e) {
    return NextResponse.json({ found: false, ticket: null, todos: [], error: String(e) }, { status: 500 });
  }
}

/**
 * PATCH /api/ops/tickets/:id — edit the editable key fields (owner / status /
 * priority) of a ticket from the TODO workspace's details card. Keyed by
 * (customerId, ticketId), so customerId comes in the body. NOTE: this writes
 * the system-of-record; a re-sync could later overwrite it.
 */
const patchSchema = z.strictObject({
  customerId: z.string().min(1),
  ticketOwnerEmail: z.string().min(1).optional(),
  ticketStatus: z.string().min(1).optional(),
  ticketPriority: z.string().min(1).optional(),
});

function zodMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const octx = await orgContextForRequest(request);
  if (!octx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  const { customerId, ...set } = parsed.data;
  if (Object.keys(set).length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  if (!(await customerInOrg(octx.orgId, customerId))) {
    return NextResponse.json({ error: "Not your workspace's customer." }, { status: 403 });
  }
  try {
    const [item] = await withOrgRls(octx.orgId, (tx) =>
      tx
        .update(tickets)
        .set(set)
        .where(and(eq(tickets.ticketId, id), eq(tickets.customerId, customerId)))
        .returning(),
    );
    if (!item) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

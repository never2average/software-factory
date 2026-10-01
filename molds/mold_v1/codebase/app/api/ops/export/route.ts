import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  comments,
  customers,
  cycles,
  deployments,
  entityActivity,
  implementation,
  todos,
} from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { isSafeDataroomPath, parseJsonlRecords, readDataroomFile } from "@/lib/dataroom-blob";
import { W } from "@/lib/ui-words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/export?type=task|deployment|implementation&id=<id>[&customerId=<c>]
 *
 * The FULL picture of a workspace entity, resolving the thin DB row's pointers
 * into the records they reference and folding in the customer's data-room
 * context. The DB deliberately holds only operational state + pointers (title,
 * ids, dates, assignee/lead) — the narrative/description context lives in the
 * data room. This endpoint reunites them so "Copy as JSON / Markdown" reflects
 * everything about the entity, not just its skinny row.
 *
 * Shape: { type, record, resolved: {...}, dataroom: { customerId, context, files } }
 */
type Bundle = {
  type: string;
  record: Record<string, unknown>;
  resolved: Record<string, unknown>;
  dataroom: { customerId: string | null; context: string | null; files: Record<string, unknown> };
};

/** Read a customer's data-room context: context.md prose + a little structured
 *  context (personas, latest interactions, SLA) when present. Best-effort — a
 *  missing file just yields null. In the CALLER's workspace's data room
 *  (dataroom/orgs/<org>/Customers/<id>/…): it read the default workspace's for
 *  every caller, which with the same company id in two workspaces (mold_v1-118)
 *  handed one workspace's files to the other. */
async function readCustomerContext(
  orgId: string,
  customerId: string | null,
): Promise<{ context: string | null; files: Record<string, unknown> }> {
  if (!customerId) return { context: null, files: {} };
  const base = `Customers/${customerId}`;
  const files: Record<string, unknown> = {};
  const read = async (rel: string) => {
    const path = `${base}/${rel}`;
    if (!isSafeDataroomPath(path)) return null;
    try {
      return await readDataroomFile(path, orgId);
    } catch {
      return null;
    }
  };
  const context = await read("context.md");
  const personas = await read("personas.jsonl");
  if (personas) files["personas"] = parseJsonlRecords(`${base}/personas.jsonl`, personas);
  const interactions = await read("interactions.jsonl");
  if (interactions) {
    const recs = parseJsonlRecords(`${base}/interactions.jsonl`, interactions);
    // Only the most recent handful — the export shouldn't be a full history dump.
    files["recentInteractions"] = recs.slice(-8);
  }
  const sla = await read("agreements/sla.json");
  if (sla) {
    try {
      files["sla"] = JSON.parse(sla);
    } catch {
      files["sla"] = sla;
    }
  }
  return { context, files };
}

async function commentsFor(
  db: NonNullable<ReturnType<typeof getOpsDb>>,
  orgId: string,
  entity: string,
  id: string,
) {
  const rows = await withOrgRls(orgId, (tx) =>
    tx
      .select()
      .from(comments)
      .where(and(eq(comments.orgId, orgId), eq(comments.entityType, entity), eq(comments.entityId, id)))
      .orderBy(asc(comments.createdAt)),
  );
  return rows.map((r) => ({ author: r.author, body: r.body, mentions: r.mentions ?? [], at: r.createdAt.toISOString() }));
}

async function activityFor(
  db: NonNullable<ReturnType<typeof getOpsDb>>,
  orgId: string,
  entity: string,
  id: string,
) {
  const rows = await withOrgRls(orgId, (tx) =>
    tx
      .select()
      .from(entityActivity)
      .where(and(eq(entityActivity.orgId, orgId), eq(entityActivity.entityType, entity), eq(entityActivity.entityId, id)))
      .orderBy(desc(entityActivity.createdAt))
      .limit(20),
  );
  return rows.map((r) => ({ actor: r.actor, event: r.event, at: r.createdAt.toISOString() }));
}

/** The record kinds this route exports: the `type` parameter's accepted values, as the API takes them. */
const EXPORT_TYPES = ["task", "deployment", "implementation"];

export async function GET(request: NextRequest) {
  // This route read tenant data with NO workspace resolved at all.
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const url = new URL(request.url);
  const type = url.searchParams.get("type") ?? "";
  const id = url.searchParams.get("id") ?? "";
  const customerIdParam = url.searchParams.get("customerId");
  if (!EXPORT_TYPES.includes(type) || !id) {
    return NextResponse.json({ error: `type (${EXPORT_TYPES.join("|")}) + id required` }, { status: 400 });
  }

  try {
    const bundle: Bundle = { type, record: {}, resolved: {}, dataroom: { customerId: null, context: null, files: {} } };

    if (type === "task") {
      const [row] = await withOrgRls(ctx.orgId, (tx) =>
        tx.select().from(todos).where(eq(todos.id, id)).limit(1),
      );
      if (!row) return NextResponse.json({ error: "Task not found" }, { status: 404 });
      bundle.record = row as Record<string, unknown>;

      // Parent + subtasks (the parent_id tree).
      if (row.parentId) {
        const parentId = row.parentId;
        const [parent] = await withOrgRls(ctx.orgId, (tx) =>
          tx.select().from(todos).where(eq(todos.id, parentId)).limit(1),
        );
        if (parent) bundle.resolved.parent = { id: parent.id, title: parent.title, status: parent.status };
      }
      const kids = await withOrgRls(ctx.orgId, (tx) =>
        tx.select().from(todos).where(eq(todos.parentId, id)).orderBy(asc(todos.createdAt)),
      );
      if (kids.length) bundle.resolved.subtasks = kids.map((k) => ({ id: k.id, title: k.title, done: k.done, status: k.status }));

      // Cycle (sprint) it's filed into.
      if (row.cycleId) {
        const cycleId = row.cycleId;
        const [cyc] = await withOrgRls(ctx.orgId, (tx) =>
          tx.select().from(cycles).where(eq(cycles.id, cycleId)).limit(1),
        );
        if (cyc) bundle.resolved.cycle = { id: cyc.id, name: cyc.name, state: cyc.state, lead: cyc.lead };
      }

      // Container (the epic-analog): a full deployment / implementation row.
      let customerId = customerIdParam;
      if (row.containerType === "deployment" && row.containerId) {
        const containerId = row.containerId;
        const [dep] = await withOrgRls(ctx.orgId, (tx) =>
          tx.select().from(deployments).where(and(eq(deployments.orgId, ctx.orgId), eq(deployments.deploymentId, containerId))).limit(1),
        );
        if (dep) {
          bundle.resolved.deployment = dep;
          customerId = customerId ?? dep.customerId;
        }
      } else if (row.containerType === "implementation" && row.containerId) {
        const containerId = row.containerId;
        const [impl] = await withOrgRls(ctx.orgId, (tx) =>
          tx.select().from(implementation).where(and(eq(implementation.orgId, ctx.orgId), eq(implementation.customerId, containerId))).limit(1),
        );
        if (impl) {
          bundle.resolved.implementation = impl;
          customerId = customerId ?? impl.customerId;
        }
      }
      // A direct customer link resolves the data room even without a container.
      if (row.linkType === "customer" && row.linkId) customerId = customerId ?? row.linkId;

      bundle.resolved.comments = await commentsFor(db, ctx.orgId, "task", id);
      bundle.resolved.activity = await activityFor(db, ctx.orgId, "task", id);
      bundle.dataroom.customerId = customerId ?? null;
      const dr = await readCustomerContext(ctx.orgId, customerId ?? null);
      bundle.dataroom.context = dr.context;
      bundle.dataroom.files = dr.files;
    } else if (type === "deployment") {
      const [row] = await withOrgRls(ctx.orgId, (tx) =>
        tx
          .select()
          .from(deployments)
          // The named company's row when the caller names one (two companies may each have a Q2FY26 record).
          .where(and(eq(deployments.orgId, ctx.orgId), eq(deployments.deploymentId, id), ...(customerIdParam ? [eq(deployments.customerId, customerIdParam)] : [])))
          .limit(1),
      );
      if (!row) return NextResponse.json({ error: `${W.Deployment} not found` }, { status: 404 });
      bundle.record = row as Record<string, unknown>;
      const customerId = customerIdParam ?? row.customerId;
      const [cust] = await withOrgRls(ctx.orgId, (tx) =>
        tx.select().from(customers).where(and(eq(customers.orgId, ctx.orgId), eq(customers.customerId, customerId))).limit(1),
      );
      if (cust) bundle.resolved.customer = { id: cust.customerId, name: cust.customerName };
      const related = await withOrgRls(ctx.orgId, (tx) =>
        tx
          .select()
          .from(todos)
          .where(and(eq(todos.containerType, "deployment"), eq(todos.containerId, id)))
          .orderBy(asc(todos.createdAt)),
      );
      bundle.resolved.relatedTasks = related.map((t) => ({ id: t.id, title: t.title, done: t.done, status: t.status }));
      bundle.resolved.comments = await commentsFor(db, ctx.orgId, "deployment", id);
      bundle.resolved.activity = await activityFor(db, ctx.orgId, "deployment", id);
      bundle.dataroom.customerId = customerId;
      const dr = await readCustomerContext(ctx.orgId, customerId);
      bundle.dataroom.context = dr.context;
      bundle.dataroom.files = dr.files;
    } else {
      // implementation — keyed by (customerId, workspace) (its PK); `id` is rolloutId ?? customerId.
      const customerId = customerIdParam ?? id;
      const [byCustomer] = await withOrgRls(ctx.orgId, (tx) =>
        tx
          .select()
          .from(implementation)
          .where(and(eq(implementation.orgId, ctx.orgId), eq(implementation.customerId, customerId)))
          .limit(1),
      );
      const [rec] = byCustomer
        ? [byCustomer]
        : await withOrgRls(ctx.orgId, (tx) =>
            tx.select().from(implementation).where(and(eq(implementation.orgId, ctx.orgId), eq(implementation.rolloutId, id))).limit(1),
          );
      if (!rec) return NextResponse.json({ error: `${W.Implementation} not found` }, { status: 404 });
      bundle.record = rec as Record<string, unknown>;
      const cid = rec.customerId;
      const [cust] = await withOrgRls(ctx.orgId, (tx) =>
        tx.select().from(customers).where(and(eq(customers.orgId, ctx.orgId), eq(customers.customerId, cid))).limit(1),
      );
      if (cust) bundle.resolved.customer = { id: cust.customerId, name: cust.customerName };
      const related = await withOrgRls(ctx.orgId, (tx) =>
        tx
          .select()
          .from(todos)
          .where(and(eq(todos.containerType, "implementation"), eq(todos.containerId, cid)))
          .orderBy(asc(todos.createdAt)),
      );
      bundle.resolved.relatedTasks = related.map((t) => ({ id: t.id, title: t.title, done: t.done, status: t.status }));
      bundle.resolved.comments = await commentsFor(db, ctx.orgId, "implementation", cid);
      bundle.resolved.activity = await activityFor(db, ctx.orgId, "implementation", cid);
      bundle.dataroom.customerId = cid;
      const dr = await readCustomerContext(ctx.orgId, cid);
      bundle.dataroom.context = dr.context;
      bundle.dataroom.files = dr.files;
    }

    return NextResponse.json(bundle);
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

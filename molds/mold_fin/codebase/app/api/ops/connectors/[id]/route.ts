import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { connectorSecrets, connectors } from "@/agent/lib/db/schema";
import { describePatch, recordOpsAudit } from "@/lib/ops-audit";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { orgContextForRequest } from "@/lib/org-context";
import { SECRET_NAME_RE } from "@/lib/connector-secrets-manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchConnectorSchema = z.strictObject({
  name: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  access: z.enum(["read", "write", "read_write"]).optional(),
  status: z.string().min(1).optional(),
  detail: z.string().nullable().optional(),
  lands: z.string().nullable().optional(),
  synced: z.array(z.string()).nullable().optional(),
  notifyEmail: z.string().nullable().optional(),
  // The recipient LIST (supersedes the deprecated single notifyEmail above).
  notifyEmails: z.array(z.email()).nullable().optional(),
  // The CONDITION the recipients are notified on, in the operator's own words.
  notifyWhen: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  // Bring-your-own connector: endpoint + self-declared credential contract.
  endpointUrl: z.url().nullable().optional(),
  requiredSecrets: z
    .array(
      z.strictObject({
        name: z.string().regex(SECRET_NAME_RE, "must be UPPER_SNAKE_CASE (A-Z, 0-9, _)"),
        purpose: z.string().min(1).max(200),
        optional: z.boolean().optional(),
      }),
    )
    .max(20)
    .nullable()
    .optional(),
  authSecretName: z.string().regex(SECRET_NAME_RE).nullable().optional(),
  // Who is making the change (audit-trail only; not a column).
  actor: z.string().min(1).optional(),
});

// DELETE may carry an optional JSON body naming the actor for the audit trail.
const deleteBodySchema = z.strictObject({ actor: z.string().min(1).optional() });

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
    .join("; ");
}

const uuidSchema = z.uuid();

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, context: RouteContext) {
  const ctx = await orgContextForRequest(request);
  /**
   * The caller's identity travels with the workspace here, because connector
   * visibility depends on BOTH: the policy compares owner_email against
   * app.principal_email, so without it an owner cannot see their own personal
   * connector.
   */
  const caller = (await verifyOpsAuth(request.headers.get("authorization")))?.email?.toLowerCase();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid connector id" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = patchConnectorSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  const { actor = "web", ...patch } = parsed.data;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }
  try {
    // Read the old row first so the audit entry can describe the actual diff.
    const [before] = await withOrgRls({ orgId: ctx.orgId, principal: caller }, (tx) =>
      tx.select().from(connectors).where(and(eq(connectors.id, id), eq(connectors.orgId, ctx.orgId))).limit(1),
    );
    if (!before) {
      return NextResponse.json({ error: "Connector not found" }, { status: 404 });
    }
    const [item] = await withOrgRls({ orgId: ctx.orgId, principal: caller }, (tx) =>
      tx
        .update(connectors)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(connectors.id, id), eq(connectors.orgId, ctx.orgId)))
        .returning(),
    );
    if (!item) {
      return NextResponse.json({ error: "Connector not found" }, { status: 404 });
    }
    // Best-effort audit trail — a failed audit write never fails the patch.
    await recordOpsAudit(db, {
      automationType: "connector",
      automationId: id,
      actor,
      event: describePatch(before, patch),
      orgId: ctx.orgId,
    });
    return NextResponse.json({ item });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const ctx = await orgContextForRequest(request);
  /**
   * The caller's identity travels with the workspace here, because connector
   * visibility depends on BOTH: the policy compares owner_email against
   * app.principal_email, so without it an owner cannot see their own personal
   * connector.
   */
  const caller = (await verifyOpsAuth(request.headers.get("authorization")))?.email?.toLowerCase();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid connector id" }, { status: 400 });
  }
  // Optional body: { actor } for the audit trail; no/invalid body means "web".
  const body = await request.json().catch(() => null);
  const actor = deleteBodySchema.safeParse(body).data?.actor ?? "web";
  try {
    const deleted = await withOrgRls({ orgId: ctx.orgId, principal: caller }, (tx) =>
      tx
        .delete(connectors)
        .where(and(eq(connectors.id, id), eq(connectors.orgId, ctx.orgId)))
        .returning({ id: connectors.id, name: connectors.name }),
    );
    if (deleted.length === 0) {
      return NextResponse.json({ error: "Connector not found" }, { status: 404 });
    }
    /**
     * The secrets go with it. There is no FK cascade, so they did not — and one
     * of them outlived both its connector AND its workspace: an encrypted
     * GITHUB_TOKEN belonging to a workspace deleted on 2026-08-08 was still
     * sitting in the table today, owned by an org that no longer exists.
     *
     * Two reasons that matters beyond tidiness. A credential nobody can reach
     * is a credential nobody remembers to revoke. And once the isolation policy
     * is fail-closed, a row owned by a non-existent workspace is unreadable by
     * anyone forever — including whoever would have cleaned it up.
     *
     * Scoped by org as well as connector id, like every other write here.
     */
    const secretsRemoved = await withOrgRls({ orgId: ctx.orgId, principal: caller }, (tx) =>
      tx
        .delete(connectorSecrets)
        .where(and(eq(connectorSecrets.connectorId, id), eq(connectorSecrets.orgId, ctx.orgId)))
        .returning({ name: connectorSecrets.name }),
    );
    // Best-effort audit trail — a failed audit write never fails the delete.
    await recordOpsAudit(db, {
      automationType: "connector",
      automationId: id,
      actor,
      event:
        `Deleted connector "${deleted[0].name}"` +
        (secretsRemoved.length
          ? ` and ${secretsRemoved.length} stored secret(s): ${secretsRemoved.map((r) => r.name).join(", ")}`
          : ""),
      orgId: ctx.orgId,
    });
    return NextResponse.json({ deleted: true, secretsRemoved: secretsRemoved.length });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

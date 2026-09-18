import { authenticateServiceRequest, isServiceContext } from "@/lib/auth";
import { archiveDefinition, updateDefinition } from "@/lib/definitions";
import { withOrgTransaction } from "@/lib/db";
import { errorResponse, issueMessage } from "@/lib/http";
import { definitionPatchSchema } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const ctx = authenticateServiceRequest(request);
  if (!isServiceContext(ctx)) return ctx;
  const parsed = definitionPatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: issueMessage(parsed.error) }, { status: 400 });
  try {
    const { id } = await context.params;
    const item = await withOrgTransaction(ctx.orgId, (sql) => updateDefinition(sql, ctx, id, parsed.data));
    return Response.json({ item });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const ctx = authenticateServiceRequest(request);
  if (!isServiceContext(ctx)) return ctx;
  try {
    const { id } = await context.params;
    await withOrgTransaction(ctx.orgId, (sql) => archiveDefinition(sql, ctx, id));
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

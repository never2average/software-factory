import { authenticateServiceRequest, isServiceContext } from "@/lib/auth";
import { createDefinition, listDefinitions } from "@/lib/definitions";
import { withOrgTransaction } from "@/lib/db";
import { errorResponse, issueMessage } from "@/lib/http";
import { definitionCreateSchema } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const ctx = authenticateServiceRequest(request);
  if (!isServiceContext(ctx)) return ctx;
  try {
    const items = await withOrgTransaction(ctx.orgId, (sql) => listDefinitions(sql, ctx.orgId));
    return Response.json({ items, canEdit: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const ctx = authenticateServiceRequest(request);
  if (!isServiceContext(ctx)) return ctx;
  const parsed = definitionCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: issueMessage(parsed.error) }, { status: 400 });
  try {
    const item = await withOrgTransaction(ctx.orgId, (sql) => createDefinition(sql, ctx, parsed.data));
    return Response.json({ item }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

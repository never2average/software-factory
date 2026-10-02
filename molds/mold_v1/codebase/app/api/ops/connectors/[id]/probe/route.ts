import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { connectors } from "@/agent/lib/db/schema";
import { probeMcpEndpoint } from "@/lib/mcp-probe";
import { recordOpsAudit } from "@/lib/ops-audit";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ops/connectors/[id]/probe — does this connector's endpoint answer?
 *
 * A bring-your-own connector is created from a URL nobody checked. Until
 * something dials it, "configured" and "working" are indistinguishable, and the
 * difference only surfaces mid-task inside an agent run.
 *
 * Unauthenticated by design — see lib/mcp-probe.ts. It proves reachability and
 * protocol, never the credential, because no route here decrypts a stored
 * secret and a diagnostic is not a good enough reason to become the first one.
 */
const uuidSchema = z.uuid();

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const octx = await orgContextForRequest(request);
  if (!octx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (octx instanceof Response) return octx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid connector id" }, { status: 400 });
  }

  try {
    return await withOrgRls(octx.orgId, async (tx) => {
      const [connector] = await tx
        .select()
        .from(connectors)
        .where(and(eq(connectors.id, id), eq(connectors.orgId, octx.orgId)))
        .limit(1);
      if (!connector) return NextResponse.json({ error: "Connector not found" }, { status: 404 });
      if (!connector.endpointUrl) {
        return NextResponse.json(
          {
            error:
              "This connector has no endpoint. Only a bring-your-own connector can be probed — a built-in kind's endpoint lives in code.",
          },
          { status: 409 },
        );
      }

      const result = await probeMcpEndpoint(connector.endpointUrl);
      await recordOpsAudit(tx, {
        automationType: "connector",
        automationId: id,
        actor: "web",
        orgId: octx.orgId,
        event: `Probed ${connector.endpointUrl} — ${result.status}`,
      });
      return NextResponse.json({
        connector: connector.name,
        endpoint: connector.endpointUrl,
        ...result,
        credentialVerified: false,
        note: "Reachability and protocol only. To verify the stored credential, have the agent call mcp_tools on this connector — that runs the same path production uses.",
      });
    });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

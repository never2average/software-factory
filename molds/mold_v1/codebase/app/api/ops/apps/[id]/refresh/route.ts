import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { apps } from "@/agent/lib/db/schema";
import { refreshApp } from "@/lib/app-refresh";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/ops/apps/:id/refresh — regenerate this app's document NOW.
 *
 * Runs with the OPERATOR's own bearer (same contract as running a workflow from
 * the Ops Center): the generated document can only ever contain what the person
 * who asked for it is allowed to see.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  // This route read tenant data with NO workspace resolved at all.
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid app id" }, { status: 400 });

  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!bearer) {
    return NextResponse.json(
      { error: "Sign in again — refreshing an app uses your own credentials to reach the agent." },
      { status: 401 },
    );
  }

  const [app] = await withOrgRls(ctx.orgId, (tx) =>
    tx.select().from(apps).where(eq(apps.id, id)).limit(1),
  );
  if (!app) return NextResponse.json({ error: "App not found" }, { status: 404 });

  const actor = request.headers.get("x-ops-actor") ?? "web";
  const outcome = await refreshApp(db, app, bearer, actor);
  const [item] = await withOrgRls(ctx.orgId, (tx) =>
    tx.select().from(apps).where(eq(apps.id, id)).limit(1),
  );
  // A source that cannot run is the request's problem, said in a sentence the person can act on (409); a generation
  // that was attempted and failed is ours (500). Either way the app row now carries the error.
  return NextResponse.json({ item, ...outcome }, { status: outcome.ok ? 200 : outcome.cause === "source" ? 409 : 500 });
}

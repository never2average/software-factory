import { NextRequest, NextResponse } from "next/server";
import { errorMessage } from "@/lib/ops-errors";
import { orgs } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";
import { ne } from "drizzle-orm";
import { ingestEmail } from "@/lib/inbox-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Scheduled inbox sync — pulls recent mail for every active workspace.
 *
 * Runs the same ingestEmail() the manual button does, so a scheduled sync and
 * an on-demand one cannot drift.
 *
 * tenancy-ok: cross-workspace BY CONSTRUCTION, and already scoped where it
 * counts. The only query here reads `orgs` to enumerate workspaces — the
 * tenancy control plane, which cannot be scoped to the answer it is computing.
 * Every row this cron actually touches is written inside ingestEmail(), which
 * runs each workspace's work in withOrgRls(orgId). Routing the enumeration
 * through a scope would return one workspace and silently stop ingesting mail
 * for all the others.
 */
export async function GET(request: NextRequest) {
  // FAIL CLOSED. `if (secret && …)` skips the check when CRON_SECRET is unset,
  // and it is set on Production ONLY — which left every preview deployment
  // exposing this endpoint unauthenticated.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured, so this cron is disabled." },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  const workspaces = await db.select({ orgId: orgs.orgId }).from(orgs).where(ne(orgs.status, "suspended"));
  const results: Record<string, unknown> = {};
  for (const w of workspaces) {
    // One workspace failing must not stop the rest — a single bad mailbox
    // would otherwise silently stop ingestion for everyone.
    try {
      results[w.orgId] = await ingestEmail(w.orgId);
    } catch (e) {
      results[w.orgId] = { error: errorMessage(e) };
    }
  }
  return NextResponse.json({ workspaces: workspaces.length, results });
}

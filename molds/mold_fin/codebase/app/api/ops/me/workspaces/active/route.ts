import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { orgMembers } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";
import { verifyOpsAuth } from "@/lib/ops-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ops/me/workspaces/active  { orgId }
 *
 * Record which workspace this person is working in.
 *
 * The switcher used to be a purely client-side choice: it set a localStorage
 * value that rode along as `X-Ops-Org` on Ops API calls. The AGENT never saw
 * that header — it re-resolves the workspace from the caller's identity on
 * every turn — so for anyone in two workspaces the console could show one
 * tenant while chat answered from the other. That is the worst possible split,
 * because both halves look authoritative.
 *
 * Persisting the choice on the membership row is what makes the two agree:
 * both resolvers order memberships by `lastSelectedAt` first.
 *
 * Membership is re-checked here from the VERIFIED token. The body names a
 * workspace, so trusting it would let anyone stamp themselves into someone
 * else's — the write is scoped by (orgId, email) and a non-member simply
 * matches no row.
 */
export async function POST(request: NextRequest) {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!identity?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = z.object({ orgId: z.string().min(1) }).safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  const email = identity.email.toLowerCase();
  const updated = await db
    .update(orgMembers)
    .set({ lastSelectedAt: new Date() })
    .where(and(eq(orgMembers.orgId, parsed.data.orgId), eq(orgMembers.email, email)))
    .returning({ orgId: orgMembers.orgId });

  // Not a member: say "no such workspace" rather than "forbidden", which would
  // confirm the id exists.
  if (updated.length === 0) {
    return NextResponse.json({ error: "No such workspace for this account." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, orgId: updated[0].orgId });
}

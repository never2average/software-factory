import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { browserSessions } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { recordOpsAudit } from "@/lib/ops-audit";
import { verifyOpsAuth } from "@/lib/ops-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST   /api/ops/browser/{id}/control   — take control of a browser session
 * DELETE /api/ops/browser/{id}/control   — hand it back
 *
 * The live view was already interactive, so clicking into it drove the page.
 * What did not exist was any way to say so: the agent kept acting on the same
 * browser, and two hands on one page is worst exactly when a human intervenes
 * — mid-login, mid-form. This is the arbitration. While the lock is held every
 * agent page operation refuses (agent/lib/browser.ts assertNotHumanControlled).
 *
 * The lock EXPIRES, and that is not a detail. A hold with no deadline turns a
 * closed laptop into a browser no later turn can use, with nothing able to
 * clear it. Taking control again extends it; handing back releases immediately.
 */

/** Long enough for a real login, short enough that forgetting is not fatal. */
const CONTROL_TTL_MS = 15 * 60 * 1000;

const uuid = z.uuid();

async function sessionFor(orgId: string, id: string) {
  const db = getOpsDb();
  if (!db) return { db: null, row: null };
  const [row] = await withOrgRls(orgId, (tx) =>
    tx
      .select()
      .from(browserSessions)
      .where(and(eq(browserSessions.id, id), eq(browserSessions.orgId, orgId)))
      .limit(1),
  );
  return { db, row: row ?? null };
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const org = await orgContextForRequest(request);
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (org instanceof Response) return org;
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const { db, row } = await sessionFor(org.orgId, id);
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  if (!row) return NextResponse.json({ error: "No such browser session." }, { status: 404 });

  // From the VERIFIED token, never a header: whose lock this is decides whether
  // someone else can take it, so a spoofable value would let anyone claim it.
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  const holder = identity?.email ?? "an operator";
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CONTROL_TTL_MS);

  // Someone else holding it is a real conflict — say whose it is rather than
  // silently stealing a session out from under them mid-login.
  const heldByOther =
    row.controlHeldBy &&
    row.controlHeldBy !== holder &&
    row.controlExpiresAt &&
    new Date(row.controlExpiresAt).getTime() > now.getTime();
  if (heldByOther) {
    return NextResponse.json(
      { error: `${row.controlHeldBy} currently has control of this browser.`, heldBy: row.controlHeldBy },
      { status: 409 },
    );
  }

  await withOrgRls(org.orgId, (tx) =>
    tx
      .update(browserSessions)
      .set({ controlHeldBy: holder, controlHeldAt: now, controlExpiresAt: expiresAt })
      .where(and(eq(browserSessions.id, id), eq(browserSessions.orgId, org.orgId))),
  );
  void recordOpsAudit(db, {
    automationType: "browser",
    automationId: id,
    actor: holder,
    event: "Took control of the browser session — agent operations refused until handed back",
    orgId: org.orgId,
  });
  return NextResponse.json({ ok: true, heldBy: holder, expiresAt: expiresAt.toISOString() });
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const org = await orgContextForRequest(request);
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (org instanceof Response) return org;
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const { db, row } = await sessionFor(org.orgId, id);
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  if (!row) return NextResponse.json({ error: "No such browser session." }, { status: 404 });

  await withOrgRls(org.orgId, (tx) =>
    tx
      .update(browserSessions)
      .set({ controlHeldBy: null, controlHeldAt: null, controlExpiresAt: null })
      .where(and(eq(browserSessions.id, id), eq(browserSessions.orgId, org.orgId))),
  );
  void recordOpsAudit(db, {
    automationType: "browser",
    automationId: id,
    actor: row.controlHeldBy ?? "an operator",
    event: "Handed the browser session back to the agent",
    orgId: org.orgId,
  });
  return NextResponse.json({ ok: true });
}

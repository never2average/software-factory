import { NextRequest, NextResponse } from "next/server";
import { errorMessage, errorText } from "@/lib/ops-errors";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { orgInvites, orgMembers, orgs } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";
import { isOrgAdmin, orgContextForRequest, tenancyEnabled, canAccessOrg } from "@/lib/org-context";
import { renderOrgInvite, sendOrgInvite } from "@/lib/platform-notify";
import { recordOpsAudit } from "@/lib/ops-audit";
import { verifyOpsAuth } from "@/lib/ops-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/** dlv_inv_<random> — the plaintext is emailed once; only its hash is stored. */
function mintToken(): { token: string; hash: string } {
  const token = `dlv_inv_${randomBytes(18).toString("base64url")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  return { token, hash };
}

/**
 *  GET  /api/ops/orgs/{id}/invites            — pending invites.
 *  POST /api/ops/orgs/{id}/invites            — create invite(s) + send the
 *       deterministic setup email. Body: { rows: [{email, role}], preview?: true }.
 *       With `preview: true` it renders the email WITHOUT minting a token or
 *       writing rows — the on-screen "this is exactly what everyone gets" view
 *       (the token is masked so a screen-share can't leak it).
 */

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!canAccessOrg(ctx, id)) return NextResponse.json({ error: "Not your workspace." }, { status: 403 });
  const db = getOpsDb();
  if (!db || !(await tenancyEnabled(db))) return NextResponse.json({ items: [] });
  try {
    const [rows, members] = await Promise.all([
      db
        .select({
          id: orgInvites.id,
          email: orgInvites.email,
          role: orgInvites.role,
          invitedBy: orgInvites.invitedBy,
          expiresAt: orgInvites.expiresAt,
          createdAt: orgInvites.createdAt,
        })
        .from(orgInvites)
        .where(and(eq(orgInvites.orgId, id), isNull(orgInvites.acceptedAt)))
        .orderBy(desc(orgInvites.createdAt)),
      db.select({ email: orgMembers.email }).from(orgMembers).where(eq(orgMembers.orgId, id)),
    ]);
    // An invite row alone does not tell you what to DO with it. "Expired" needs
    // a resend, "already a member" needs revoking rather than chasing, and both
    // were previously indistinguishable from "waiting on them".
    const memberEmails = new Set(members.map((m) => m.email.toLowerCase()));
    const now = Date.now();
    const items = rows.map((r) => ({
      ...r,
      status: memberEmails.has(r.email.toLowerCase())
        ? ("accepted" as const)
        : r.expiresAt.getTime() < now
          ? ("expired" as const)
          : ("pending" as const),
    }));
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

const bodySchema = z.object({
  rows: z
    .array(z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(["owner", "admin", "engineer", "member"]).default("member") }))
    .min(1)
    .max(200),
  preview: z.boolean().optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!canAccessOrg(ctx, id)) return NextResponse.json({ error: "Not your workspace." }, { status: 403 });
  if (!isOrgAdmin(ctx.role)) return NextResponse.json({ error: "Admin or owner only." }, { status: 403 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  // Only an owner can invite someone straight to the owner role.
  if (parsed.data.rows.some((r) => r.role === "owner") && ctx.role !== "owner") {
    return NextResponse.json({ error: "Only an owner can invite another owner." }, { status: 403 });
  }

  const [org] = await db.select().from(orgs).where(eq(orgs.orgId, id)).limit(1);
  const workspaceName = org?.name ?? id;

  // PREVIEW: render the deterministic email for the first row's role, no token,
  // no rows written. Deterministic — same (workspace, role) → same bytes.
  if (parsed.data.preview) {
    const sample = parsed.data.rows[0];
    const rendered = renderOrgInvite({
      workspace: id,
      workspaceName,
      role: sample.role,
      to: sample.email,
      origin: new URL(request.url).origin,
    });
    return NextResponse.json({ preview: rendered });
  }

  const inviter = (await verifyOpsAuth(request.headers.get("authorization")))?.email ?? "the workspace owner";
  const origin = new URL(request.url).origin;

  /**
   * Rate limit. This endpoint sends mail to arbitrary addresses from our domain
   * on behalf of any workspace admin, which makes it both a spam vector and a
   * way to burn the platform's sending reputation. Cap what one workspace can
   * emit in an hour; the limit is deliberately well above real onboarding.
   */
  const HOURLY_CAP = 100;
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const [{ recent }] = await db
    .select({ recent: sql<number>`count(*)::int` })
    .from(orgInvites)
    .where(and(eq(orgInvites.orgId, id), gt(orgInvites.createdAt, since)));
  if (recent + parsed.data.rows.length > HOURLY_CAP) {
    return NextResponse.json(
      { error: `Invite limit reached (${HOURLY_CAP}/hour for this workspace). Try again later.` },
      { status: 429 },
    );
  }

  // Who is already in? Inviting an existing member is a no-op worth saying out
  // loud rather than sending them a second setup email.
  const existingMembers = new Set(
    (await db.select({ email: orgMembers.email }).from(orgMembers).where(eq(orgMembers.orgId, id)))
      .map((m) => m.email.toLowerCase()),
  );

  /**
   * PER-ROW results, and the batch never aborts.
   *
   * This was a bare loop inside one try: any failure — a mail provider hiccup
   * on row 3 of 10 — threw out of the whole request and returned a single 500,
   * AFTER rows 1 and 2 had been written and their emails already sent. The
   * caller saw total failure, retried, and re-invited those two. Each row now
   * succeeds or fails on its own and says which.
   */
  const results: {
    email: string;
    role: string;
    status: "sent" | "resent" | "already-member" | "failed";
    url?: string;
    delivered?: boolean;
    via?: string;
    reason?: string;
  }[] = [];

  for (const row of parsed.data.rows) {
    if (existingMembers.has(row.email)) {
      results.push({ email: row.email, role: row.role, status: "already-member" });
      continue;
    }
    try {
      /**
       * Re-inviting supersedes rather than accumulates.
       *
       * org_invites has no unique key on (org_id, email), so a second invite to
       * the same person simply added another row — two live tokens, two emails,
       * and a pending list that grew every time someone clicked Send twice.
       * Superseding also rotates the token, which is the behaviour you want
       * from a "resend" anyway.
       */
      const prior = await db
        .select({ id: orgInvites.id })
        .from(orgInvites)
        .where(and(eq(orgInvites.orgId, id), eq(orgInvites.email, row.email), isNull(orgInvites.acceptedAt)));
      if (prior.length) {
        await db.delete(orgInvites).where(inArray(orgInvites.id, prior.map((p) => p.id)));
      }

      const { token, hash } = mintToken();
      const url = `${origin}/?invite=${encodeURIComponent(token)}`;
      await db.insert(orgInvites).values({
        orgId: id,
        email: row.email,
        role: row.role,
        tokenHash: hash,
        invitedBy: inviter,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      });
      const delivery = await sendOrgInvite({
        workspace: id,
        workspaceName,
        role: row.role,
        to: row.email,
        token,
        acceptUrl: url,
      });
      results.push({
        email: row.email,
        role: row.role,
        status: prior.length ? "resent" : "sent",
        url,
        ...(delivery.delivered
          ? { delivered: true, via: delivery.via }
          : { delivered: false, reason: delivery.reason }),
      });
    } catch (e) {
      console.error("invite failed", { org: id, email: row.email, error: e });
      results.push({
        email: row.email,
        role: row.role,
        status: "failed",
        reason: errorMessage(e),
      });
    }
  }

  const deliveredN = results.filter((r) => r.delivered).length;
  const failedN = results.filter((r) => r.status === "failed").length;
  void recordOpsAudit(db, {
    automationType: "org",
    automationId: id,
    actor: inviter,
    event:
      `Invited ${results.length} — ${deliveredN} delivered, ${failedN} failed, ` +
      `${results.filter((r) => r.status === "already-member").length} already members`,
    orgId: id,
  });
  // `sent` is kept for the existing wizard screen; `results` carries the detail.
  return NextResponse.json(
    { results, sent: results.filter((r) => r.url), delivered: deliveredN, failed: failedN },
    { status: failedN === results.length ? 502 : 201 },
  );
}

/**
 * DELETE /api/ops/orgs/{id}/invites?email=… — revoke a pending invite.
 *
 * Deleting the row invalidates the token: redemption looks up by hash, so there
 * is nothing left to match. Revoking matters when someone is invited by mistake
 * or leaves before accepting — until now a live 14-day token could not be
 * withdrawn at all.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!canAccessOrg(ctx, id)) return NextResponse.json({ error: "Not your workspace." }, { status: 403 });
  if (!isOrgAdmin(ctx.role)) return NextResponse.json({ error: "Admin or owner only." }, { status: 403 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const email = (new URL(request.url).searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "email is required" }, { status: 400 });
  try {
    const removed = await db
      .delete(orgInvites)
      .where(and(eq(orgInvites.orgId, id), eq(orgInvites.email, email), isNull(orgInvites.acceptedAt)))
      .returning({ id: orgInvites.id });
    if (!removed.length) return NextResponse.json({ error: "No pending invite for that address." }, { status: 404 });
    const actor = (await verifyOpsAuth(request.headers.get("authorization")))?.email ?? "an admin";
    void recordOpsAudit(db, {
      automationType: "org",
      automationId: id,
      actor,
      event: `Revoked the invite for ${email}`,
      orgId: id,
    });
    return NextResponse.json({ ok: true, revoked: removed.length });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

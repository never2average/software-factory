import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { browserAllowlist } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The browser navigation allow-list — which origins the agent's browser may
 * visit. Enforcement is DEFAULT-DENY once any entry exists (see
 * agent/lib/browser.ts assertNavigationAllowed): with rows present, only listed
 * origins are reachable; with none, browsing is permissive + audited. Global
 * entries (customerId null) apply to every customer.
 *
 * GET  — list entries. POST — add one (owner-verified email as added_by).
 * DELETE ?id= — remove one.
 */
async function caller(request: NextRequest): Promise<string | null> {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  return identity?.email ?? null;
}

export async function GET(request: NextRequest) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ items: [] });
  if (!(await caller(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  try {
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(browserAllowlist)
        .where(eq(browserAllowlist.orgId, ctx.orgId))
        .orderBy(asc(browserAllowlist.origin)),
    );
    return NextResponse.json({
      items: rows.map((r) => ({
        id: r.id,
        customerId: r.customerId,
        origin: r.origin,
        addedBy: r.addedBy,
        at: r.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

const createSchema = z.object({
  origin: z.string().min(3, "Give a host like acme-bank.com or https://app.acme-bank.com."),
  customerId: z.string().optional().nullable(),
});

export async function POST(request: NextRequest) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const email = await caller(request);
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  // Normalise to a bare host so matching is predictable.
  let origin = parsed.data.origin.trim();
  try {
    origin = new URL(origin.includes("://") ? origin : `https://${origin}`).host.replace(/^www\./, "");
  } catch {
    return NextResponse.json({ error: "Not a valid host or URL." }, { status: 400 });
  }
  try {
    const [row] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .insert(browserAllowlist)
        .values({ orgId: ctx.orgId, origin, customerId: parsed.data.customerId || null, addedBy: email })
        .returning(),
    );
    return NextResponse.json(
      { item: { id: row.id, customerId: row.customerId, origin: row.origin, addedBy: row.addedBy } },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  if (!(await caller(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    await withOrgRls(ctx.orgId, (tx) =>
      tx
        .delete(browserAllowlist)
        .where(and(eq(browserAllowlist.id, id), eq(browserAllowlist.orgId, ctx.orgId))),
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

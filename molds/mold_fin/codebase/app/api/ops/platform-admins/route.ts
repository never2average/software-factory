import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { platformAdmins } from "@/agent/lib/db/schema";
import { getOpsDb } from "@/lib/ops-db";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { tenancyEnabled } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Platform operators — the allowlist of people who may CREATE workspaces
 * (distinct from any single workspace's membership). Managing it is itself a
 * platform-admin action.
 *
 *  GET    /api/ops/platform-admins            — list.
 *  POST   /api/ops/platform-admins {email}    — grant.
 *  DELETE /api/ops/platform-admins?email=…    — revoke (can't remove the last).
 */

async function requireAdmin(db: NonNullable<ReturnType<typeof getOpsDb>>, request: NextRequest) {
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!identity) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const [row] = await db.select().from(platformAdmins).where(eq(platformAdmins.email, identity.email.toLowerCase())).limit(1);
  if (!row) return { error: NextResponse.json({ error: "Platform operators only." }, { status: 403 }) };
  return { email: identity.email.toLowerCase() };
}

export async function GET(request: NextRequest) {
  const db = getOpsDb();
  if (!db || !(await tenancyEnabled(db))) return NextResponse.json({ items: [] });
  const gate = await requireAdmin(db, request);
  if (gate.error) return gate.error;
  const rows = await db.select().from(platformAdmins).orderBy(asc(platformAdmins.email));
  return NextResponse.json({ items: rows });
}

const addSchema = z.object({ email: z.string().trim().toLowerCase().email() });

export async function POST(request: NextRequest) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  if (!(await tenancyEnabled(db))) return NextResponse.json({ error: "Tenancy is not enabled yet." }, { status: 409 });
  const gate = await requireAdmin(db, request);
  if (gate.error) return gate.error;
  const parsed = addSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  const [row] = await db
    .insert(platformAdmins)
    .values({ email: parsed.data.email, addedBy: gate.email })
    .onConflictDoNothing()
    .returning();
  return NextResponse.json({ item: row ?? { email: parsed.data.email } }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const gate = await requireAdmin(db, request);
  if (gate.error) return gate.error;
  const email = new URL(request.url).searchParams.get("email")?.toLowerCase();
  if (!email) return NextResponse.json({ error: "?email= is required." }, { status: 400 });
  const all = await db.select().from(platformAdmins);
  if (all.length <= 1) return NextResponse.json({ error: "Can't remove the last platform operator." }, { status: 409 });
  await db.delete(platformAdmins).where(eq(platformAdmins.email, email));
  return NextResponse.json({ ok: true });
}

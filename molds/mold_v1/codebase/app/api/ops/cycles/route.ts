import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { cycles } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET/POST /api/ops/cycles — the team's cycles (sprints) for grouping todos. */
const createSchema = z.strictObject({
  name: z.string().min(1),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  createdBy: z.string().min(1).default("web"),
});

export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  if (!getOpsDb()) return NextResponse.json({ items: [] });
  try {
    const items = await withOrgRls(ctx.orgId, (tx) =>
      tx.select().from(cycles).where(and(eq(cycles.orgId, ctx.orgId), isNull(cycles.archivedAt))).orderBy(asc(cycles.startsAt)),
    );
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  const { startsAt, endsAt, ...rest } = parsed.data;
  try {
    const [item] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .insert(cycles)
        .values({ ...rest, orgId: ctx.orgId, startsAt: startsAt ? new Date(startsAt) : null, endsAt: endsAt ? new Date(endsAt) : null })
        .returning(),
    );
    return NextResponse.json({ item }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { peopleRoster } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/roster — the org roster (email, name, team, manager,
 * escalation) that the TODOs scope filters and the person dossier resolve
 * against. Live (non-archived) rows only, scoped to the caller's workspace.
 */
export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!getOpsDb()) return NextResponse.json({ items: [] });
  try {
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(peopleRoster)
        .where(and(eq(peopleRoster.orgId, ctx.orgId), isNull(peopleRoster.archivedAt)))
        .orderBy(asc(peopleRoster.email)),
    );
    const items = rows.map((r) => ({
      email: r.email,
      name: r.name,
      team: r.team,
      managerEmail: r.managerEmail,
      escalations: r.escalations ?? [],
    }));
    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

const emailLower = z
  .string()
  .trim()
  .transform((s) => s.toLowerCase());
const upsertSchema = z.strictObject({
  email: emailLower.pipe(z.string().min(1)),
  name: z.string().nullable().optional(),
  team: z.string().nullable().optional(),
  managerEmail: emailLower.nullable().optional(),
  // Full replacement of this person's escalation contacts (multiple managers,
  // each with a trigger reason). Empty array clears them.
  escalations: z
    .array(z.strictObject({ email: emailLower.pipe(z.string().min(1)), reason: z.string().trim().min(1) }))
    .optional(),
});

/**
 * POST /api/ops/roster — upsert one roster member's reporting/escalation links
 * (keyed by email). Used by the person dossier to let an operator set who a
 * person reports to and escalates to. Creates the row if the person isn't in
 * the roster yet. Only the provided fields are written.
 */
export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const parsed = upsertSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  const { email, escalations, ...rest } = parsed.data;
  // Normalize "" → null and keep only the fields actually supplied.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ["name", "team", "managerEmail"] as const) {
    if (rest[k] !== undefined) set[k] = rest[k] || null;
  }
  if (escalations !== undefined) set.escalations = escalations;
  try {
    // Scope the lookup to the caller's workspace (email is unique per org).
    const [existing] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select({ email: peopleRoster.email })
        .from(peopleRoster)
        .where(and(eq(peopleRoster.email, email), eq(peopleRoster.orgId, ctx.orgId))),
    );
    if (existing) {
      const [row] = await withOrgRls(ctx.orgId, (tx) =>
        tx
          .update(peopleRoster)
          .set(set)
          .where(and(eq(peopleRoster.email, email), eq(peopleRoster.orgId, ctx.orgId)))
          .returning(),
      );
      return NextResponse.json({ item: row });
    }
    const [row] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .insert(peopleRoster)
        .values({ email, orgId: ctx.orgId, ...set })
        .returning(),
    );
    return NextResponse.json({ item: row });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

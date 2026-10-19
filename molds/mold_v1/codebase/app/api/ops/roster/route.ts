import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { peopleRoster } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { isOrgAdmin, orgContextForRequest } from "@/lib/org-context";
import {
  PEOPLE,
  canSetPeopleData,
  checkAttributes,
  checkDepartments,
  checkReporting,
  declaredDepartments,
  mergeAttributes,
  RosterWriteConflict,
  writeRosterRow,
  visibleAttributes,
} from "@/agent/lib/people-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/roster — the org roster (email, name, team, manager,
 * escalation) that the TODOs scope filters and the person dossier resolve
 * against. Live (non-archived) rows only, scoped to the caller's workspace.
 *
 * When the deployment profile declares a people catalogue (agent/lib/people-data.ts), each row also carries its
 * `departments` (everyone in the workspace reads them, as the team) and, for the caller's own row or when the caller
 * is the workspace's owner or an admin, its `attributes`. `canEdit` says whether the caller may set departments,
 * attributes and who someone reports to. With no catalogue declared the rows are exactly what they were.
 */
export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  if (!getOpsDb()) return NextResponse.json({ items: [] });
  const reader = { email: (await verifyOpsAuth(request.headers.get("authorization")))?.email ?? null, role: ctx.role };
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
      ...(PEOPLE.hasDepartments ? { departments: declaredDepartments(r.departments) } : {}),
      ...(PEOPLE.hasAttributes ? peopleAttributes(r, reader) : {}),
    }));
    if (!PEOPLE.hasDepartments && !PEOPLE.hasAttributes) return NextResponse.json({ items });
    return NextResponse.json({ items, canEdit: canSetPeopleData(ctx.role) });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

/** `attributes` for one reader: the person's own row, or any row for the workspace's owner and admins. */
function peopleAttributes(r: { email: string; attributes: unknown }, reader: { email: string | null; role: string }) {
  const attributes = visibleAttributes(r, reader);
  return attributes ? { attributes } : {};
}

/**
 * A written row as the caller gets it back: the people columns only when the profile declares a catalogue (so the
 * default answers what it did), and the attributes only to whoever may read them.
 */
function rosterItem<T extends { email: string; departments: unknown; attributes: unknown }>(row: T, reader: { email: string | null; role: string }) {
  const { departments, attributes: _attributes, ...rest } = row;
  return {
    ...rest,
    ...(PEOPLE.hasDepartments ? { departments: declaredDepartments(departments) } : {}),
    ...(PEOPLE.hasAttributes ? peopleAttributes(row, reader) : {}),
  };
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
  // The people catalogue (agent/lib/people-data.ts): checked against the profile below, never here.
  departments: z.array(z.string()).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

/**
 * POST /api/ops/roster — upsert one roster member's reporting/escalation links
 * (keyed by email). Used by the person dossier to let an operator set who a
 * person reports to and escalates to. Creates the row if the person isn't in
 * the roster yet. Only the provided fields are written.
 *
 * Who someone reports to (`managerEmail`), their `departments` and their `attributes` are the workspace owner's to
 * set (or an admin's): anyone else gets 403 and nothing is written. The one they report to must be someone of this
 * workspace, not themselves, and must not close a reporting loop (checked under a per-workspace lock in the same
 * transaction as the write); departments and attributes must be the profile's (agent/lib/people-data.ts). Attributes
 * merge per key onto what is stored (null clears a key). A refusal is a 400 with a sentence, and stores nothing.
 */
export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const parsed = upsertSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  const { email, escalations, departments, attributes, ...rest } = parsed.data;
  const peopleData = rest.managerEmail !== undefined || departments !== undefined || attributes !== undefined;
  if (peopleData && !isOrgAdmin(ctx.role)) {
    return NextResponse.json({ error: `Only the workspace's owner or an admin can set who someone reports to, their ${PEOPLE.department.plural} or their attributes.` }, { status: 403 });
  }
  // Normalize "" → null and keep only the fields actually supplied.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ["name", "team", "managerEmail"] as const) {
    if (rest[k] !== undefined) set[k] = rest[k] || null;
  }
  if (escalations !== undefined) set.escalations = escalations;
  if (departments !== undefined) {
    const checked = checkDepartments(departments);
    if ("error" in checked) return NextResponse.json({ error: checked.error }, { status: 400 });
    set.departments = checked.value;
  }
  const attributePatch = attributes === undefined ? null : checkAttributes(attributes);
  if (attributePatch && "error" in attributePatch) return NextResponse.json({ error: attributePatch.error }, { status: 400 });
  try {
    // One transaction: the reporting line is checked against the workspace's lines under its lock, and the
    // attributes merged onto what is stored, in the same transaction as the write.
    const out = await withOrgRls(ctx.orgId, async (tx) => {
      if (set.managerEmail !== undefined) {
        const problem = await checkReporting(tx, ctx.orgId, new Map([[email, (set.managerEmail as string | null) ?? null]]));
        if (problem) return { refused: problem } as const;
      }
      // The person's row in the caller's workspace only: the roster is keyed by (org_id, email) (drizzle/0049), so
      // another workspace holding the same email has its own row, which this never reads or touches. The attributes
      // are merged onto the row as stored and locked, including one a concurrent write added (agent/lib/people-data.ts).
      const { row } = await writeRosterRow(tx, ctx.orgId, email, (before) =>
        attributePatch ? { ...set, attributes: mergeAttributes(before?.attributes, attributePatch) } : set,
      );
      return { row } as const;
    }).catch((e) => {
      if (e instanceof RosterWriteConflict) return { conflict: e.message } as const;
      throw e;
    });
    if ("conflict" in out) return NextResponse.json({ error: out.conflict }, { status: 409 });
    if ("refused" in out) return NextResponse.json({ error: out.refused }, { status: 400 });
    const reader = { email: (await verifyOpsAuth(request.headers.get("authorization")))?.email ?? null, role: ctx.role };
    return NextResponse.json({ item: rosterItem(out.row, reader) });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

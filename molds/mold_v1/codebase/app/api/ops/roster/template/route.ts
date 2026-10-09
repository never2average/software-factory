import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, eq } from "drizzle-orm";
import { peopleRoster } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { buildRosterWorkbook } from "@/lib/roster-workbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/roster/template — the import workbook, prefilled with this
 * workspace's roster as it stands right now.
 *
 * Built here rather than in the browser: the same module has to read the file
 * back, and reading must be server-side (see lib/roster-workbook.ts). Keeping
 * both on one side of the wire is what stops the written and expected formats
 * drifting apart.
 *
 * Any member may download it; it contains no more than the People tab shows.
 */
export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  try {
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(peopleRoster)
        .where(eq(peopleRoster.orgId, ctx.orgId))
        .orderBy(peopleRoster.email),
    );

    const buf = await buildRosterWorkbook(
      rows.map((r) => ({
        email: r.email,
        name: r.name,
        team: r.team,
        managerEmail: r.managerEmail,
        escalations: r.escalations ?? [],
      })),
      ctx.orgId,
      new Date().toISOString(),
    );

    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="roster-${ctx.orgId}.xlsx"`,
        // The roster changes; a cached copy would be a stale backup.
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

/** Unused verbs answer plainly rather than 405-ing from the framework. */
export async function POST() {
  return NextResponse.json(
    { error: "Upload filled workbooks to /api/ops/roster/import." },
    { status: 405 },
  );
}

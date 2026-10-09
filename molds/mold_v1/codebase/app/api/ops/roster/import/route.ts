import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { peopleRoster } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { isOrgAdmin, orgContextForRequest } from "@/lib/org-context";
import { recordOpsAudit } from "@/lib/ops-audit";
import { diffRoster, parseRosterWorkbook, type RosterPerson } from "@/lib/roster-workbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ops/roster/import — one call that does the whole workbook.
 *
 * multipart/form-data: `file` (the .xlsx) and `apply` ("1" to write).
 *
 * The upload is parsed, validated, and diffed against the live roster in a
 * single request, so the client sends bytes and receives a decision — it does no
 * spreadsheet work and holds no parsed state between steps. Without `apply` the
 * response is a preview and nothing is written; with it, the same parse is
 * applied and the pre-image of every touched row comes back as the undo.
 *
 * Re-uploading for the apply is deliberate: caching a parsed workbook server-side
 * between two requests would mean an apply could act on bytes the reviewer never
 * saw, and the file is small enough that re-reading it costs nothing.
 */

/** Refuse absurd files before ExcelJS allocates for them. */
const MAX_BYTES = 5 * 1024 * 1024;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (ctx instanceof Response) return ctx;
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!ctx || !identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isOrgAdmin(ctx.role)) {
    return NextResponse.json({ error: "Admin or owner only." }, { status: 403 });
  }
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Send the workbook as multipart form data." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file was uploaded." }, { status: 400 });
  }
  if (file.size === 0) return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `That file is ${(file.size / 1048576).toFixed(1)} MB; the limit is 5 MB.` },
      { status: 413 },
    );
  }
  // Extension/type check is a courtesy for the wrong-file case — a .csv or a PDF
  // gets a sentence instead of a parser error. It is not a security control.
  const looksXlsx = file.name.toLowerCase().endsWith(".xlsx") || file.type === XLSX_MIME;
  if (!looksXlsx) {
    return NextResponse.json(
      { error: `Expected the .xlsx template; "${file.name}" is not one.` },
      { status: 400 },
    );
  }
  const apply = form.get("apply") === "1";

  try {
    const parsed = await parseRosterWorkbook(new Uint8Array(await file.arrayBuffer()));

    // Current state, for both the diff and the undo pre-image.
    const live = await withOrgRls(ctx.orgId, (tx) =>
      tx.select().from(peopleRoster).where(eq(peopleRoster.orgId, ctx.orgId)),
    );
    const current: RosterPerson[] = live.map((r) => ({
      email: r.email,
      name: r.name,
      team: r.team,
      managerEmail: r.managerEmail,
      escalations: r.escalations ?? [],
    }));
    const changes = diffRoster(current, parsed.people);

    if (parsed.problems.length > 0) {
      // Problems block the write but the preview is still worth returning: it
      // shows what WOULD happen to the rows that are fine.
      return NextResponse.json({
        applied: false,
        problems: parsed.problems,
        changes,
        rows: parsed.people.length,
      });
    }
    if (!apply || changes.length === 0) {
      return NextResponse.json({
        applied: false,
        problems: [],
        changes,
        rows: parsed.people.length,
      });
    }

    const byEmail = new Map(live.map((r) => [r.email.toLowerCase(), r]));
    const touched = parsed.people.filter((p) => changes.some((c) => c.email === p.email));

    /** Exactly what these rows held beforehand — replay it to undo. */
    const snapshot = touched.map((p) => {
      const b = byEmail.get(p.email);
      return {
        email: p.email,
        name: b?.name ?? null,
        team: b?.team ?? null,
        managerEmail: b?.managerEmail ?? null,
        escalations: b?.escalations ?? [],
        existed: b !== undefined,
      };
    });

    let created = 0;
    let updated = 0;
    for (const p of touched) {
      // Only supplied fields are written: a blank cell means "leave alone", so
      // a sheet that never carried a column must not erase it.
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (p.name !== null) set.name = p.name || null;
      if (p.team !== null) set.team = p.team || null;
      if (p.managerEmail !== null) set.managerEmail = p.managerEmail || null;
      if (p.escalations !== undefined) set.escalations = p.escalations;

      if (byEmail.has(p.email)) {
        await withOrgRls(ctx.orgId, (tx) =>
          tx
            .update(peopleRoster)
            .set(set)
            .where(and(eq(peopleRoster.email, p.email), eq(peopleRoster.orgId, ctx.orgId))),
        );
        updated++;
      } else {
        await withOrgRls(ctx.orgId, (tx) =>
          tx.insert(peopleRoster).values({ email: p.email, orgId: ctx.orgId, ...set }),
        );
        created++;
      }
    }

    void recordOpsAudit(db, {
      automationType: "org",
      automationId: ctx.orgId,
      actor: identity.email.toLowerCase(),
      orgId: ctx.orgId,
      event: `Roster import from "${file.name}" — ${updated} updated, ${created} added`,
    });

    return NextResponse.json({ applied: true, updated, created, changes, snapshot });
  } catch (e) {
    // A corrupt or non-workbook file lands here; say so in a sentence rather
    // than returning a zip-parser stack trace.
    const msg = String(e);
    const unreadable = /zip|central directory|corrupt|end of data|invalid/i.test(msg);
    return NextResponse.json(
      { error: unreadable ? "That file could not be read as an .xlsx workbook." : msg },
      { status: unreadable ? 400 : 500 },
    );
  }
}

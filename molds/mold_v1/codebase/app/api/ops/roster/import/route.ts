import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { peopleRoster } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { isOrgAdmin, orgContextForRequest } from "@/lib/org-context";
import { RosterWriteConflict, checkReporting, writeRosterRow } from "@/agent/lib/people-data";
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

    const touched = parsed.people.filter((p) => changes.some((c) => c.email === p.email));

    let created = 0;
    let updated = 0;
    /** Exactly what these rows held beforehand, read in the write's transaction: replay it to undo. */
    const undo: (RosterPerson & { escalations: { email: string; reason: string }[]; existed: boolean })[] = [];
    // Who each person reports to must be someone of this workspace and close no loop with the lines it already has
    // (agent/lib/people-data.ts): checked under the workspace's reporting lock, and every row written in the same one
    // transaction, so a workbook is applied whole or not at all.
    const lines = new Map(touched.filter((p) => p.managerEmail !== null).map((p) => [p.email, p.managerEmail || null]));
    const problem = await withOrgRls(ctx.orgId, async (tx) => {
      const refused = lines.size ? await checkReporting(tx, ctx.orgId, lines, parsed.people.map((p) => p.email)) : null;
      if (refused) return refused;
      for (const p of touched) {
        // Only supplied fields are written: a blank cell means "leave alone", so
        // a sheet that never carried a column must not erase it.
        const set: Record<string, unknown> = { updatedAt: new Date() };
        if (p.name !== null) set.name = p.name || null;
        if (p.team !== null) set.team = p.team || null;
        if (p.managerEmail !== null) set.managerEmail = p.managerEmail || null;
        if (p.escalations !== undefined) set.escalations = p.escalations;

        const w = await writeRosterRow(tx, ctx.orgId, p.email, set);
        if (w.created) created++;
        else updated++;
        // The exact prior state, read and locked in this transaction: a row another writer added since the preview
        // is "existed" with its values, so replaying the undo never wipes what they wrote.
        undo.push({
          email: p.email,
          name: w.before?.name ?? null,
          team: w.before?.team ?? null,
          managerEmail: w.before?.managerEmail ?? null,
          escalations: w.before?.escalations ?? [],
          existed: !w.created,
        });
      }
      return null;
    }).catch((e) => {
      if (e instanceof RosterWriteConflict) return { conflict: e.message };
      throw e;
    });
    if (problem && typeof problem === "object") return NextResponse.json({ applied: false, error: problem.conflict }, { status: 409 });
    // Reported as the workbook's own problems are: the preview stays, nothing is written.
    if (problem) return NextResponse.json({ applied: false, problems: [problem], changes, rows: parsed.people.length });

    void recordOpsAudit(db, {
      automationType: "org",
      automationId: ctx.orgId,
      actor: identity.email.toLowerCase(),
      orgId: ctx.orgId,
      event: `Roster import from "${file.name}" — ${updated} updated, ${created} added`,
    });

    return NextResponse.json({ applied: true, updated, created, changes, snapshot: undo });
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

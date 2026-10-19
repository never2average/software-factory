import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { peopleRoster } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { isOrgAdmin, orgContextForRequest } from "@/lib/org-context";
import { recordOpsAudit } from "@/lib/ops-audit";
import { RosterWriteConflict, checkReporting, writeRosterRow } from "@/agent/lib/people-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ops/roster/bulk — apply a roster import.
 *
 * The workbook is parsed in the browser (npm's `xlsx` carries unfixed
 * prototype-pollution and ReDoS advisories and must not read untrusted bytes in
 * a server process), so what arrives here is plain JSON from a client that
 * cannot be trusted about it. Everything is re-validated: strict schemas reject
 * unknown keys outright, which also closes the door prototype pollution would
 * otherwise walk through.
 *
 * Writes are admin/owner only, and the response always reports the pre-image of
 * every row it touched so the caller can offer a real undo.
 *
 * Who each person reports to must be someone of this workspace (on its roster,
 * one of its signed-in people, or a person this import adds), and the lines it
 * sets must close no loop with the ones the workspace already has
 * (agent/lib/people-data.ts). Every row is written in ONE transaction, checked
 * under the workspace's reporting lock, so an import is applied whole or not at all.
 */

const emailLower = z
  .string()
  .trim()
  .toLowerCase()
  .refine((s) => /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(s), "Not an email address");

const personSchema = z.strictObject({
  email: emailLower,
  // null means "not supplied — leave whatever is there", matching the template's
  // blank-cell rule. The client turns the CLEAR sentinel into an empty string.
  name: z.string().max(200).nullable().optional(),
  team: z.string().max(120).nullable().optional(),
  managerEmail: z.union([emailLower, z.literal("")]).nullable().optional(),
  escalations: z
    .array(z.strictObject({ email: emailLower, reason: z.string().trim().min(1).max(200) }))
    .max(20)
    .optional(),
});

const bodySchema = z.strictObject({
  people: z.array(personSchema).min(1).max(2000),
  /** Report what would change and write nothing. */
  dryRun: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (ctx instanceof Response) return ctx;
  const identity = await verifyOpsAuth(request.headers.get("authorization"));
  if (!ctx || !identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isOrgAdmin(ctx.role)) return NextResponse.json({ error: "Admin or owner only." }, { status: 403 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: `${issue?.path?.join(".") || "body"}: ${issue?.message ?? "Invalid"}` },
      { status: 400 },
    );
  }
  const { people, dryRun } = parsed.data;

  // Self-reporting and loops are rejected server-side too. The client checks
  // them for a decent error message; this is the check that actually holds,
  // since the client is not the only possible caller.
  const incoming = new Map(people.map((p) => [p.email, p]));
  for (const p of people) {
    const mgr = p.managerEmail || null;
    if (mgr && mgr === p.email) {
      return NextResponse.json({ error: `${p.email} cannot report to themselves.` }, { status: 400 });
    }
  }
  const loop = findLoop(incoming);
  if (loop) {
    return NextResponse.json({ error: `Reporting loop: ${loop.join(" → ")}.` }, { status: 400 });
  }

  try {
    const emails = people.map((p) => p.email);
    const existing = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(peopleRoster)
        .where(and(eq(peopleRoster.orgId, ctx.orgId), inArray(peopleRoster.email, emails))),
    );
    const before = new Map(existing.map((r) => [r.email.toLowerCase(), r]));

    /** The exact prior state of every row this import touches — the undo. */
    const snapshot = people.map((p) => {
      const b = before.get(p.email);
      return {
        email: p.email,
        name: b?.name ?? null,
        team: b?.team ?? null,
        managerEmail: b?.managerEmail ?? null,
        escalations: b?.escalations ?? [],
        existed: b !== undefined,
      };
    });

    // The reporting lines this import sets, against the workspace's own (a dry run is told too).
    const lines = new Map(
      people.filter((p) => p.managerEmail !== undefined && p.managerEmail !== null).map((p) => [p.email, p.managerEmail || null]),
    );
    const linesProblem = async (tx: Parameters<Parameters<typeof withOrgRls>[1]>[0]) =>
      lines.size ? checkReporting(tx, ctx.orgId, lines, emails) : null;

    if (dryRun) {
      const problem = await withOrgRls(ctx.orgId, linesProblem);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
      return NextResponse.json({
        dryRun: true,
        wouldUpdate: people.filter((p) => before.has(p.email)).length,
        wouldCreate: people.filter((p) => !before.has(p.email)).length,
        snapshot,
      });
    }

    let created = 0;
    let updated = 0;
    // The undo is the exact prior state of every row, read and locked in the write's own transaction (a row another
    // writer added since the read above is "existed", with its values): replaying it never wipes what they wrote.
    const undo: typeof snapshot = [];
    const problem = await withOrgRls(ctx.orgId, async (tx) => {
      const refused = await linesProblem(tx);
      if (refused) return refused;
      for (const p of people) {
        // Only fields actually supplied are written — a blank cell in the
        // template must not wipe a value the sheet simply did not carry.
        const set: Record<string, unknown> = { updatedAt: new Date() };
        if (p.name !== undefined && p.name !== null) set.name = p.name || null;
        if (p.team !== undefined && p.team !== null) set.team = p.team || null;
        if (p.managerEmail !== undefined && p.managerEmail !== null) set.managerEmail = p.managerEmail || null;
        if (p.escalations !== undefined) set.escalations = p.escalations;

        const w = await writeRosterRow(tx, ctx.orgId, p.email, set);
        if (w.created) created++;
        else updated++;
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
    if (problem && typeof problem === "object") return NextResponse.json({ error: problem.conflict }, { status: 409 });
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    void recordOpsAudit(db, {
      automationType: "org",
      automationId: ctx.orgId,
      actor: identity.email.toLowerCase(),
      orgId: ctx.orgId,
      event: `Roster import — ${updated} updated, ${created} added`,
    });

    return NextResponse.json({ ok: true, updated, created, snapshot: undo });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

/** First reporting loop in the submitted set, or null. */
function findLoop(people: Map<string, { email: string; managerEmail?: string | null }>): string[] | null {
  for (const start of people.keys()) {
    const path: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = start;
    while (cur && people.has(cur)) {
      if (seen.has(cur)) return [...path.slice(path.indexOf(cur)), cur];
      seen.add(cur);
      path.push(cur);
      const next: string | null = people.get(cur)?.managerEmail || null;
      cur = next ?? undefined;
    }
  }
  return null;
}

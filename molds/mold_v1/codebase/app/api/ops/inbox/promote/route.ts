import { NextRequest, NextResponse } from "next/server";
import { errorMessage } from "@/lib/ops-errors";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { customers, inboxItems, interactions, tickets } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { verifyOpsAuth } from "@/lib/ops-auth";
import { W } from "@/lib/ui-words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which interaction type / source system a staged source maps to. The
 *  interaction schema uses closed enums, so an unmapped source must fail
 *  loudly here rather than produce a row Zod will reject deeper in. */
const SOURCE_MAP: Record<string, { type: "email" | "meeting" | "slack"; system: "gmail" | "granola" | "slack" }> = {
  email: { type: "email", system: "gmail" },
  granola: { type: "meeting", system: "granola" },
  slack: { type: "slack", system: "slack" },
};

const bodySchema = z.object({
  threadKey: z.string().min(1),
  customerId: z.string().min(1),
  summary: z.string().min(1),
  outcome: z.string().optional(),
  /** Optional follow-up work. Staged as "Needs Triage" so it lands in the queue
   *  that already exists rather than becoming a live ticket nobody approved. */
  ticket: z
    .object({
      summary: z.string().min(1),
      // The ticket schema's real enum — not P0/P1 shorthand, which the
      // compiler rejected and Zod would have rejected at runtime.
      priority: z.enum(["P0-Critical", "P1-High", "P2-Medium", "P3-Low"]).default("P2-Medium"),
      ownerEmail: z.string().email(),
      nextStep: z.string().min(1),
    })
    .optional(),
});

/**
 * POST /api/ops/inbox/promote — turn one staged thread into a data-room record.
 *
 * Writes an `interactions` row (the structured record the account report and
 * QBR workflows read) and, when the conversation implies work, a "Needs Triage"
 * ticket — reusing the existing promote/resolve queue instead of inventing a
 * second approval flow.
 *
 * The staged rows are marked `promoted`, never deleted: ingestion dedupes on
 * (org, source, external_id), so deleting them would let the next sync
 * resurrect a thread that has already been dealt with.
 *
 * WRITES GO THROUGH DRIZZLE HERE, not through agent/lib/system-of-record.
 * Importing that module into a Next route pulled `import … with { type: "json" }`
 * into the function bundle, forcing it to ESM — after which Next's CJS launcher
 * could no longer require() co-bundled routes, and /api/ops/health and
 * /api/dataroom (both importing the CJS @vercel/blob) returned 500 in
 * production. It built and tested clean locally; the fault only appears in a
 * serverless build. Ops routes talk to the database directly for this reason.
 */
export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  const { threadKey, customerId, summary, outcome, ticket } = parsed.data;
  const actor = (await verifyOpsAuth(request.headers.get("authorization")))?.email ?? "an operator";

  try {
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select()
        .from(inboxItems)
        .where(and(eq(inboxItems.orgId, ctx.orgId), eq(inboxItems.threadKey, threadKey))),
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "No such thread in this workspace." }, { status: 404 });
    }
    if (rows.every((r) => r.status === "promoted")) {
      // Idempotent rather than an error: a double-click should not create a
      // second interaction for the same conversation.
      return NextResponse.json({ ok: true, alreadyPromoted: true });
    }

    const ordered = [...rows].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const map = SOURCE_MAP[ordered[0].source];
    if (!map) {
      return NextResponse.json(
        { error: `Source '${ordered[0].source}' has no interaction mapping.` },
        { status: 422 },
      );
    }

    // The whole conversation becomes the note, oldest first, so the record
    // reads as the exchange it was rather than as its last message.
    const note = ordered
      .map((m) => `[${m.occurredAt.toISOString()}] ${(m.participants ?? [])[0] ?? "unknown"}\n${m.body ?? m.preview ?? ""}`)
      .join("\n\n---\n\n");
    const participantEmails = [...new Set(ordered.flatMap((m) => m.participants ?? []))].filter((e) =>
      /^[^@\s]+@[^@\s]+$/.test(e),
    );
    const interactionId = `INT-${threadKey.slice(0, 24).replace(/[^A-Za-z0-9-]/g, "")}`;

    const today = new Date().toISOString().slice(0, 10);

    // The customer must exist IN THIS WORKSPACE — never trust the id from the
    // request body alone.
    const [customer] = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select({ id: customers.customerId })
        .from(customers)
        .where(and(eq(customers.customerId, customerId), eq(customers.orgId, ctx.orgId)))
        .limit(1),
    );
    if (!customer) {
      return NextResponse.json({ error: `No ${W.account} '${customerId}' in this workspace.` }, { status: 404 });
    }

    let ticketId: string | undefined;
    if (ticket) {
      // Bound to a const so the closure below sees a `string`, not
      // `string | undefined` — the mutable outer binding defeats narrowing.
      const newTicketId = `TCK-${Date.now().toString(36).toUpperCase()}`;
      ticketId = newTicketId;
      await withOrgRls(ctx.orgId, (tx) =>
        tx.insert(tickets).values({
          orgId: ctx.orgId,
          customerId,
          ticketId: newTicketId,
          summary: ticket.summary,
          description: summary,
          // A conversation implying work is a Question until a human classifies
          // it; guessing "Bug" would file it into the wrong queue.
          ticketType: "Question",
          ticketCategory: "Feature Request",
          // The existing human-approval queue, not a live ticket.
          ticketStatus: "Needs Triage",
          ticketPriority: ticket.priority,
          ticketOpenedDate: today,
          ticketOwnerEmail: ticket.ownerEmail,
          sourceChannel: ordered[0].source,
          lastActivityDate: today,
          ticketNextStep: ticket.nextStep,
        }),
      );
    }

    await withOrgRls(ctx.orgId, (tx) =>
      tx.insert(interactions).values({
        orgId: ctx.orgId,
        customerId,
        interactionId,
        interactionAt: ordered[ordered.length - 1].occurredAt.toISOString(),
        interactionType: map.type,
        sourceSystem: map.system,
        sourceId: threadKey,
        summary,
        note,
        outcome: outcome ?? null,
        participantEmails: participantEmails.length ? participantEmails : null,
        relatedTicketIds: ticketId ? [ticketId] : null,
      }),
    );

    return NextResponse.json({ ok: true, interactionId, ticketId: ticketId ?? null }, { status: 201 });
  } catch (e) {
    console.error("inbox promote failed", e);
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}

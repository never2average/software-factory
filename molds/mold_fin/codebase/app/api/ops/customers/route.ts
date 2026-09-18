import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { desc, eq, inArray, notInArray, asc, sql as dsql } from "drizzle-orm";
import { customers, interactions, tickets } from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { isEmptyStore } from "@/lib/pg-error";
import { recordOpsAudit } from "@/lib/ops-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The customer list backing the per-chat context selector. Reads the system of
 * record (Postgres) at runtime — NOT the bundled `data/customers.json`, which is
 * only a dev fallback and is intentionally empty in this deployment.
 *
 * Returns each customer WITH the summary the selector renders (tier, stage,
 * status, health, owner) plus an open-ticket count and the last interaction, so
 * the dropdown shows a real one-line summary. `[]` when no DB is configured.
 */
const CLOSED_TICKET_STATUSES = ["Resolved", "Closed", "Won't Fix"];

export interface CustomerOption {
  id: string;
  name: string;
  tier: string | null;
  lifecycleStage: string | null;
  status: string | null;
  healthScore: number | null;
  healthReason: string | null;
  fdeOwner: string | null;
  openTickets: number;
  lastTouchDate: string | null;
  lastTouch: string | null;
}

export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ customers: [] as CustomerOption[], items: [] as CustomerOption[] });
  try {
    // RLS-enforced read of the workspace's accounts; the ticket/interaction
    // counts below are then keyed to these org customer ids in memory.
    const rows = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select({
          id: customers.customerId,
          name: customers.customerName,
          tier: customers.tier,
          lifecycleStage: customers.lifecycleStage,
          status: customers.status,
          healthScore: customers.healthScore,
          healthReason: customers.healthReason,
          fdeOwner: customers.fdeOwner,
        })
        .from(customers)
        .where(eq(customers.orgId, ctx.orgId))
        .orderBy(asc(customers.customerName)),
    );

    // Open-ticket counts per customer (one grouped query, not N).
    const ticketCounts = await withOrgRls(ctx.orgId, (tx) =>
      tx
        .select({ customerId: tickets.customerId, open: dsql<number>`count(*)::int` })
        .from(tickets)
        .where(notInArray(tickets.ticketStatus, CLOSED_TICKET_STATUSES))
        .groupBy(tickets.customerId),
    );
    const openByCustomer = new Map(ticketCounts.map((t) => [t.customerId, t.open]));

    // Latest interaction per customer, for the "last touch" line.
    const ids = rows.map((r) => r.id);
    const lastTouchByCustomer = new Map<string, { date: string | null; text: string | null }>();
    if (ids.length > 0) {
      const latest = await withOrgRls(ctx.orgId, (tx) =>
        tx
          .selectDistinctOn([interactions.customerId], {
            customerId: interactions.customerId,
            interactionAt: interactions.interactionAt,
            summary: interactions.summary,
            note: interactions.note,
          })
          .from(interactions)
          .where(inArray(interactions.customerId, ids))
          .orderBy(interactions.customerId, desc(interactions.interactionAt)),
      );
      for (const l of latest) {
        lastTouchByCustomer.set(l.customerId, {
          date: l.interactionAt ? String(l.interactionAt).slice(0, 10) : null,
          text: l.summary ?? l.note ?? null,
        });
      }
    }

    const out: CustomerOption[] = rows.map((r) => {
      const lt = lastTouchByCustomer.get(r.id);
      return {
        ...r,
        openTickets: openByCustomer.get(r.id) ?? 0,
        lastTouchDate: lt?.date ?? null,
        lastTouch: lt?.text ?? null,
      };
    });
    /**
     * Returned under BOTH keys, deliberately.
     *
     * `customers` is what chat-shell and the agent already read. `items` is the
     * shared list contract every other Ops endpoint uses (/apps, /connectors,
     * /cycles, /roster, /schedules, /system-crons, /todos, /workflows) and what
     * useOpsList() reads. This route was the only one that did not, so every
     * CustomerSelect dropdown in the Ops Center — crons, apps, todos, the chat
     * composer — silently rendered an empty list: the hook read `data.items`,
     * got undefined, and an empty dropdown looks identical to a workspace with
     * no customers.
     */
    return NextResponse.json({ customers: out, items: out });
  } catch (e) {
    /**
     * A read that FAILED is not a workspace with no customers.
     *
     * Reporting [] on any error is what makes a database blip look exactly
     * like an empty book: every CustomerSelect in the Ops Center goes blank,
     * the panels show nothing, and no one is told why. chat-sessions learned
     * this the hard way and says so in its own catch — it emptied people's
     * chats in front of them. Only a genuinely absent table (pre-migration)
     * is emptiness; everything else is a 503 the caller can show.
     */
    if (isEmptyStore(e)) {
      return NextResponse.json({ customers: [] as CustomerOption[], items: [] as CustomerOption[] });
    }
    console.error("customers GET failed", e);
    return NextResponse.json({ error: "customer store unavailable" }, { status: 503 });
  }
}

/* -------------------------------------------------------------------------- */
/* POST — create (or update) a customer                                        */
/* -------------------------------------------------------------------------- */

/**
 * There was no way to create a customer over the API at all, only to list them.
 *
 * That is not a cosmetic gap. `implementation.customer_id` and
 * `deployments.customer_id` are FOREIGN KEYS to this table, so an operator
 * onboarding a new account could write their whole data room and then hit a
 * bare Postgres 23503 on the first structured record, with no tool anywhere
 * that could create the row it wanted. Two independent trial runs died in the
 * same place.
 *
 * Upsert rather than insert: onboarding is re-run, corrected and resumed, and a
 * second attempt failing on a duplicate key would be its own trap.
 */
const upsertCustomerSchema = z.object({
  customerId: z
    .string()
    .min(1)
    .max(64)
    // The id shows up in data-room paths (Customers/<id>/…) which have their own
    // safe-segment rule, so keep it to a slug and the two can never disagree.
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Use a lowercase slug, e.g. 'northwind-capital'."),
  customerName: z.string().min(1).max(200),
  tier: z.string().max(40).nullable().optional(),
  lifecycleStage: z.string().max(40).nullable().optional(),
  status: z.string().max(40).nullable().optional(),
  vertical: z.string().max(80).nullable().optional(),
  regulatoryProfile: z.string().max(200).nullable().optional(),
  companyDomain: z.string().max(120).nullable().optional(),
  fdeOwner: z.string().max(200).nullable().optional(),
  businessOwnerEmail: z.string().max(200).nullable().optional(),
  technicalOwnerEmail: z.string().max(200).nullable().optional(),
  actor: z.string().min(1).default("web"),
});

export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const parsed = upsertCustomerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  const { actor, ...fields } = parsed.data;
  try {
    return await withOrgRls(ctx.orgId, async (tx) => {
      const [existing] = await tx
        .select({ id: customers.customerId })
        .from(customers)
        .where(eq(customers.customerId, fields.customerId))
        .limit(1);
      const [row] = await tx
        .insert(customers)
        .values({ ...fields, orgId: ctx.orgId })
        .onConflictDoUpdate({
          target: customers.customerId,
          // Only overwrite what was actually sent; a partial update must not
          // blank the fields it didn't mention.
          set: Object.fromEntries(
            Object.entries(fields).filter(([k, v]) => k !== "customerId" && v !== undefined),
          ),
        })
        .returning();
      await recordOpsAudit(tx, {
        automationType: "connector",
        automationId: row.customerId,
        actor,
        orgId: ctx.orgId,
        event: existing ? `Customer ${row.customerId} updated` : `Customer ${row.customerId} created`,
      });
      return NextResponse.json({ item: row, created: !existing }, { status: existing ? 200 : 201 });
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

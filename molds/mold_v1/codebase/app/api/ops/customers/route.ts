import { NextRequest, NextResponse } from "next/server";
import { errorText } from "@/lib/ops-errors";
import { z } from "zod";
import { and, desc, eq, inArray, notInArray, asc, sql as dsql } from "drizzle-orm";
import { customers, interactions, tickets } from "@/agent/lib/db/schema";
import { accountOwnerSql, pairOwners, withOwnerKeys } from "@/agent/lib/db/owner-columns";
import { getOpsDb, withOrgRls } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { isEmptyStore } from "@/lib/pg-error";
import { recordOpsAudit } from "@/lib/ops-audit";
import { customBodySchema, customForWrite } from "@/lib/ops-domain-fields";
import { asCustomValues, customDelta, customFieldsOf, type CustomValues } from "@/agent/lib/custom-fields";
import { customForNewRow, customMergeSql } from "@/agent/lib/custom-merge-sql";
import { W } from "@/lib/ui-words";
import { speakKey } from "@/lib/ui-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The customer list backing the per-chat context selector. Reads the system of
 * record (Postgres) at runtime. No bundled list exists: the sample records
 * (data/sample/) are a local demo's, read only by the server with DEMO_SAMPLE_DATA=1.
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
  /** The account's owner (an email). Under both names, always equal: `accountOwner` is the neutral one to read. */
  accountOwner: string | null;
  /** The same value as accountOwner, under the original name existing callers read. */
  fdeOwner: string | null;
  openTickets: number;
  lastTouchDate: string | null;
  lastTouch: string | null;
  /** The account's own fields the profile shows in lists (`account_fields.custom_fields`, show_in_list). Absent when none. */
  custom?: CustomValues;
}

/** Only the own fields a profile marks show_in_list: a list is fetched on every picker open, a long note is not for it. */
function listedCustom(stored: unknown): { custom?: CustomValues } {
  const listed = new Set(customFieldsOf("account").filter((f) => f.show_in_list).map((f) => f.key));
  if (!listed.size) return {};
  const values = Object.fromEntries(Object.entries(asCustomValues(stored)).filter(([k]) => listed.has(k)));
  return Object.keys(values).length ? { custom: values } : {};
}

/** One workspace's accounts: never cached by a browser or a proxy (every answer, errors included). */
export async function GET(request: NextRequest) {
  const res = await listCustomers(request);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

async function listCustomers(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
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
          // The neutral column, else the original (agent/lib/db/owner-columns.ts); returned under both names below.
          owner: accountOwnerSql,
          custom: customers.custom,
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
        .where(and(eq(tickets.orgId, ctx.orgId), notInArray(tickets.ticketStatus, CLOSED_TICKET_STATUSES)))
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
          .where(and(eq(interactions.orgId, ctx.orgId), inArray(interactions.customerId, ids)))
          .orderBy(interactions.customerId, desc(interactions.interactionAt)),
      );
      for (const l of latest) {
        lastTouchByCustomer.set(l.customerId, {
          date: l.interactionAt ? String(l.interactionAt).slice(0, 10) : null,
          text: l.summary ?? l.note ?? null,
        });
      }
    }

    const out: CustomerOption[] = rows.map(({ custom, owner, ...r }) => {
      const lt = lastTouchByCustomer.get(r.id);
      return {
        ...r,
        accountOwner: owner,
        fdeOwner: owner,
        ...listedCustom(custom),
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
    console.error("GET /api/ops/customers failed", e);
    return NextResponse.json({ error: `${W.account} store unavailable` }, { status: 503 });
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
    // The id shows up in data-room paths (<the accounts folder>/<id>/…) which have their own
    // safe-segment rule, so keep it to a slug and the two can never disagree.
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Use a lowercase slug, e.g. 'northwind-capital'."),
  customerName: z.string().min(1).max(200),
  tier: z.string().max(40).nullable().optional(),
  lifecycleStage: z.string().max(40).nullable().optional(),
  status: z.string().max(40).nullable().optional(),
  vertical: z.string().max(80).nullable().optional(),
  regulatoryProfile: z.string().max(200).nullable().optional(),
  companyDomain: z.string().max(120).nullable().optional(),
  // The account's owner, under either name (both are accepted; a body naming both must name the same person). Stored
  // in both columns (drizzle/0028_neutral_owner_columns.sql).
  accountOwner: z.string().max(200).nullable().optional(),
  fdeOwner: z.string().max(200).nullable().optional(),
  // The account's second owner, under either name, by the same rule (drizzle/0029_neutral_secondary_owner.sql).
  secondaryOwner: z.string().max(200).nullable().optional(),
  aeOwner: z.string().max(200).nullable().optional(),
  businessOwnerEmail: z.string().max(200).nullable().optional(),
  technicalOwnerEmail: z.string().max(200).nullable().optional(),
  // The profile's own fields on the account (`account_fields.custom_fields`): only shape-checked here; which keys
  // exist and what each accepts is decided by agent/lib/custom-fields.ts in customForWrite below. Partial on an
  // update: the stored keys it does not mention are kept, null clears one.
  custom: customBodySchema,
  actor: z.string().min(1).default("web"),
});

export async function POST(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx instanceof Response) return ctx;
  const db = getOpsDb();
  if (!db) return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  const parsed = upsertCustomerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid" }, { status: 400 });
  }
  const { actor, custom: customInput, ...named } = parsed.data;
  if (named.accountOwner !== undefined && named.fdeOwner !== undefined && named.accountOwner !== named.fdeOwner) {
    // The keys as a person reads them (lib/ui-keys.ts), as every ops API error names a field.
    return NextResponse.json({ error: `${speakKey("accountOwner")} and ${speakKey("fdeOwner")} are the same field (the ${W.owner}); send one, or the same value in both.` }, { status: 400 });
  }
  if (named.secondaryOwner !== undefined && named.aeOwner !== undefined && named.secondaryOwner !== named.aeOwner) {
    return NextResponse.json({ error: `${speakKey("secondaryOwner")} and ${speakKey("aeOwner")} are the same field (the ${W.secondaryOwner}); send one, or the same value in both.` }, { status: 400 });
  }
  const rest = pairOwners(named);
  try {
    return await withOrgRls(ctx.orgId, async (tx) => {
      const [existing] = await tx
        .select({ id: customers.customerId, custom: customers.custom })
        .from(customers)
        .where(and(eq(customers.orgId, ctx.orgId), eq(customers.customerId, rest.customerId)))
        .limit(1);
      // An undeclared key or a wrong type is a 400 with the sentences, and nothing is written.
      const checked = customForWrite("account", customInput, existing ?? null);
      if (checked.error) return NextResponse.json({ error: `Custom fields were not accepted, so nothing was written. ${checked.error}` }, { status: 400 });
      // Only the keys the body names, merged in SQL onto what is stored at write time. The value checked above was
      // read before this statement: writing it back whole would lose a note another writer saved in between.
      // customers.custom is NULLABLE: no own values is NULL, as the agent's write path stores it.
      const delta = checked.custom === undefined ? undefined : customDelta(customInput, checked.custom);
      const [row] = await tx
        .insert(customers)
        .values({ ...rest, ...(delta ? { custom: customForNewRow(delta) } : {}), orgId: ctx.orgId })
        .onConflictDoUpdate({
          // The company's whole key (org_id, customer_id): another workspace holding this id has its own company,
          // which this write neither updates nor collides with (mold_v1-118).
          target: [customers.orgId, customers.customerId],
          // Only overwrite what was actually sent; a partial update must not
          // blank the fields it didn't mention.
          set: {
            ...Object.fromEntries(Object.entries(rest).filter(([k, v]) => k !== "customerId" && v !== undefined)),
            ...(delta ? { custom: customMergeSql(customers.custom, delta) } : {}),
          },
        })
        .returning();
      await recordOpsAudit(tx, {
        automationType: "connector",
        automationId: row.customerId,
        actor,
        orgId: ctx.orgId,
        event: `${W.Account} ${row.customerId} ${existing ? "updated" : "created"}`,
      });
      return NextResponse.json({ item: withOwnerKeys(row), created: !existing }, { status: existing ? 200 : 201 });
    });
  } catch (e) {
    return NextResponse.json({ error: errorText(e) }, { status: 500 });
  }
}

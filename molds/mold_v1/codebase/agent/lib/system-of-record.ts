/**
 * Data access for the centralized customer system of record.
 *
 * POSTGRES IS THE SOURCE OF RECORD. When a `DATABASE_URL` (or `POSTGRES_URL`)
 * is configured, every read/write below goes through Drizzle ORM + the
 * postgres.js driver (see `./db/index.ts` + `./db/schema.ts`, one table per
 * structured entity: customers, platform, deployments, solutions,
 * implementation, tickets, interactions).
 *
 * FALLBACK: when no Postgres URL is set (dev / CI / tests), the store is held
 * in memory for the life of the process. It starts EMPTY, or from the sample
 * records in data/sample/customers.json when the process runs with
 * DEMO_SAMPLE_DATA=1 (a local demo; see ./sample-data.ts). Nothing is ever
 * written to disk. Seed a real database with `npm run seed:postgres`.
 *
 * Document artifacts (context.md, agreements, helm/terraform, eval jsonl,
 * signoffs) are NOT stored here — they live in the data-room store
 * (`./dataroom-store.ts`). `recordInteraction` additionally mirrors each
 * interaction into `Customers/{id}/interactions.jsonl` for the document view,
 * best-effort; Postgres (or the JSON fallback) remains the record.
 */
import { and, eq, getTableColumns, ilike, notInArray, or, sql } from "drizzle-orm";
import type { Table } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { sampleCustomerStore } from "./sample-data.ts";
import {
  customerPatchSchema,
  customerReadSchema,
  deploymentSchema,
  implementationSchema,
  platformSchema,
  solutionSchema,
  customerSchema,
  customerStoreSchema,
  interactionSchema,
  ticketReadSchema,
  ticketSchema,
  type Customer,
  type CustomerPatch,
  type CustomerStore,
  type Interaction,
  type Ticket,
} from "./customer-schema.ts";
import { acrossOrgDbs, getDb, withOrgDb, type Db } from "./db/index.ts";
import {
  customers as customersTable,
  deployments as deploymentsTable,
  implementation as implementationTable,
  interactions as interactionsTable,
  internalStaff as internalStaffTable,
  orgs as orgsTable,
  platform as platformTable,
  solutions as solutionsTable,
  tickets as ticketsTable,
} from "./db/schema.ts";
import { getDataroomStore } from "./dataroom-store.ts";
import { DEFAULT_ORG } from "./org-context.ts";
import { LONG_TEXT_LIMIT, asCustomValues, customDelta, customFieldsOf, replacedKeys, validateAppend, validateCustom, type CustomDelta, type CustomValues } from "./custom-fields.ts";
import { customMergeSql } from "./custom-merge-sql.ts";
import type { CustomFieldArea, CustomFieldSpec } from "./deployment-profile.generated.ts";

export type FollowUp = Ticket;

/**
 * The workspace a by-id call acts in. A caller that knows its workspace (every model tool: orgForSession) names
 * it, and then an id from another workspace is simply not found — row-level security is the check.
 *
 * Only a SYSTEM path with no caller at all (`orgId` undefined: a seed script, a sync with no session) falls back to
 * the workspace that owns the customer, found by asking each workspace in its own scope. It used to ask
 * orgForCustomer, which reads on the bare handle; under the fail-closed policy that sees no row and answers the
 * default workspace for every id, so a system write to any other workspace's account was "Unknown customer".
 * A caller that passes an EMPTY workspace is refused rather than given the owner's: an empty answer from
 * orgForSession must never widen into "whoever owns this id". No model tool reaches the fallback
 * (scripts/test-cross-workspace.mjs holds that every tool passes orgForSession).
 */
async function scopeFor(customerId: string, orgId?: string | null): Promise<string> {
  if (orgId) return orgId;
  if (orgId !== undefined) throw new Error(`No workspace was given for customer ${customerId}, so nothing was read or changed.`);
  const [owner] = await acrossOrgDbs((tx) =>
    tx
      .select({ orgId: customersTable.orgId })
      .from(customersTable)
      .where(eq(customersTable.customerId, customerId))
      .limit(1),
  );
  // Absent everywhere: any scope reads it as absent, so the caller's own "Unknown customer" follows.
  return owner?.orgId ?? DEFAULT_ORG;
}

/**
 * The workspace that owns a customer, for a SYSTEM caller with no session (the scripts/fde backfills): found by
 * asking each workspace in its own scope, never unscoped. DEFAULT_ORG when no workspace has it. A caller that has a
 * session uses orgForSession instead, and never this.
 */
export async function ownerWorkspaceOf(customerId: string): Promise<string> {
  return getDb() ? scopeFor(customerId) : DEFAULT_ORG;
}

/* -------------------------------------------------------------------------- */
/* Fallback store — in memory, empty unless DEMO_SAMPLE_DATA asks for samples */
/* -------------------------------------------------------------------------- */

// Empty by default; the sample accounts only when the process was started with
// DEMO_SAMPLE_DATA=1 (./sample-data.ts). The seed used to be a static import of
// data/customers.json, which put two invented accounts in every build.
let memoryStore: CustomerStore = customerStoreSchema.parse(sampleCustomerStore());

async function readStore(): Promise<CustomerStore> {
  return memoryStore;
}

/**
 * In memory ONLY. This used to also write the store back to
 * `<cwd>/data/customers.json`, which in a local run is the tracked file the
 * client bundle imported: a local run's records ("Surface Probe Co") then
 * shipped to every workspace in the next build. Nothing read the file back, so
 * the write persisted nothing anyone used; the in-memory copy is the fallback's
 * record for the life of the process.
 */
async function writeStore(store: CustomerStore): Promise<void> {
  memoryStore = customerStoreSchema.parse(store);
}

/* -------------------------------------------------------------------------- */
/* Row <-> entity mapping                                                     */
/*                                                                            */
/* The Zod contracts in ./customer-schema.ts stay the column contract: table  */
/* properties in ./db/schema.ts use the same camelCase names, with the        */
/* customer spine renamed (`id` -> customerId, `name` -> customerName) and    */
/* nested rows carrying an extra `customerId`. Postgres represents "absent"   */
/* as NULL while Zod uses undefined, so rows are null-stripped on read and    */
/* null-filled on write.                                                      */
/* -------------------------------------------------------------------------- */

function stripNulls(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/** Nested-domain row -> plain entity candidate (drop the FK, strip NULLs). */
function rowToEntity(row: Record<string, unknown>): Record<string, unknown> {
  const { customerId: _customerId, ...rest } = row;
  // `custom` is NOT NULL DEFAULT '{}': a record with no profile-declared values reads exactly as it did before
  // the column existed.
  if (rest.custom && typeof rest.custom === "object" && Object.keys(rest.custom).length === 0) delete rest.custom;
  return stripNulls(rest);
}

/**
 * Build a full-width row for `table`: every column property present, with
 * `null` standing in for absent optional fields. Insert-or-update with these
 * rows always leaves the row exactly mirroring the entity (drizzle skips
 * `undefined` values in `set`, which would leave stale column values behind).
 */
function fullRow<T extends Table>(table: T, values: Record<string, unknown>): T["$inferInsert"] {
  const row: Record<string, unknown> = {};
  for (const key of Object.keys(getTableColumns(table))) {
    row[key] = values[key] ?? null;
  }
  return row as T["$inferInsert"];
}

/** Split a validated Customer into its Postgres rows (exported for seeding). */
export function customerToDbRows(customer: Customer): {
  customer: typeof customersTable.$inferInsert;
  platform: (typeof platformTable.$inferInsert) | null;
  deployments: Array<typeof deploymentsTable.$inferInsert>;
  solutions: Array<typeof solutionsTable.$inferInsert>;
  implementation: (typeof implementationTable.$inferInsert) | null;
  tickets: Array<typeof ticketsTable.$inferInsert>;
  interactions: Array<typeof interactionsTable.$inferInsert>;
} {
  const {
    id,
    name,
    platform,
    deployments,
    solutions,
    implementation,
    tickets,
    interactions,
    custom,
    ...scalar
  } = customer;
  // customers.custom is NULLABLE (0019): no own values is NULL, never {}, so a record nobody gave one reads back
  // exactly as it did before the column existed.
  const accountCustom = asCustomValues(custom);
  return {
    customer: fullRow(customersTable, { customerId: id, customerName: name, ...scalar, custom: Object.keys(accountCustom).length ? accountCustom : null }),
    platform: platform ? fullRow(platformTable, { customerId: id, ...platform }) : null,
    // `custom` is NOT NULL, so an absent one is {} rather than fullRow's null.
    deployments: (deployments ?? []).map((d) => fullRow(deploymentsTable, { customerId: id, ...d, custom: asCustomValues(d.custom) })),
    solutions: (solutions ?? []).map((s) => fullRow(solutionsTable, { customerId: id, ...s })),
    implementation: implementation
      ? fullRow(implementationTable, { customerId: id, ...implementation, custom: asCustomValues(implementation.custom) })
      : null,
    tickets: (tickets ?? []).map((t) => fullRow(ticketsTable, { customerId: id, ...t })),
    interactions: (interactions ?? []).map((i) =>
      fullRow(interactionsTable, { customerId: id, ...i }),
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Postgres read/write helpers                                                */
/* -------------------------------------------------------------------------- */

const CLOSED_TICKET_STATUSES: Array<Ticket["ticketStatus"]> = ["Resolved", "Closed", "Won't Fix"];

function isOpenTicket(status: Ticket["ticketStatus"]): boolean {
  return !CLOSED_TICKET_STATUSES.includes(status);
}

async function dbGetCustomer(db: Db, id: string, orgId?: string | null): Promise<Customer | null> {
  /**
   * Seven parallel reads, one workspace scope.
   *
   * Scoped when the caller knows the workspace, swept when it does not — the
   * existing contract for a bare lookup is "find it wherever it lives", and a
   * single unscoped read returns nothing once the policy fails closed.
   */
  const run = <T>(fn: (tx: Db) => Promise<T[]>): Promise<T[]> =>
    orgId ? withOrgDb(orgId, fn) : acrossOrgDbs(fn);
  const [customerRows, platformRows, deploymentRows, solutionRows, implementationRows, ticketRows, interactionRows] =
    await Promise.all([
      run((tx) =>
tx.select().from(customersTable).where(eq(customersTable.customerId, id)).limit(1)),
      run((tx) =>
tx.select().from(platformTable).where(eq(platformTable.customerId, id))),
      run((tx) =>
tx.select().from(deploymentsTable).where(eq(deploymentsTable.customerId, id))),
      run((tx) =>
tx.select().from(solutionsTable).where(eq(solutionsTable.customerId, id))),
      run((tx) =>
tx.select().from(implementationTable).where(eq(implementationTable.customerId, id))),
      run((tx) =>
tx.select().from(ticketsTable).where(eq(ticketsTable.customerId, id))),
      run((tx) =>
tx.select().from(interactionsTable).where(eq(interactionsTable.customerId, id))),
    ]);
  const row = customerRows[0];
  if (!row) return null;
  const { customerId, customerName, custom, ...scalar } = row;
  const candidate: Record<string, unknown> = {
    id: customerId,
    name: customerName,
    ...stripNulls(scalar),
  };
  // The account's own fields (account_fields.custom_fields): left off when there are none, as on the nested rows.
  const accountCustom = asCustomValues(custom);
  if (Object.keys(accountCustom).length) candidate.custom = accountCustom;
  if (platformRows[0]) candidate.platform = rowToEntity(platformRows[0]);
  if (implementationRows[0]) candidate.implementation = rowToEntity(implementationRows[0]);
  if (deploymentRows.length > 0) candidate.deployments = deploymentRows.map(rowToEntity);
  if (solutionRows.length > 0) candidate.solutions = solutionRows.map(rowToEntity);
  if (ticketRows.length > 0) candidate.tickets = ticketRows.map(rowToEntity);
  if (interactionRows.length > 0) {
    // Mirror the fallback's newest-first interaction ordering.
    candidate.interactions = interactionRows
      .map(rowToEntity)
      .sort((a, b) => String(b.interactionAt ?? "").localeCompare(String(a.interactionAt ?? "")));
  }
  // READ-tolerant parse: legacy rows may hold out-of-enum values (e.g.
  // status "In Progress"); reads carry them through rather than throwing.
  // Writes still validate against the strict customerSchema.
  return customerReadSchema.parse(candidate);
}

/**
 * UPSERT a full, validated customer into Postgres: the customers row is
 * inserted-or-updated in place, and each nested domain (platform,
 * deployments, solutions, implementation, tickets, interactions) is replaced
 * so the database exactly mirrors the given entity. Also used by
 * `scripts/seed-postgres.ts`.
 */
/**
 * @param orgId  The workspace this customer belongs to. Optional ONLY so the
 * fallback JSON store and older callers still compile — passing nothing writes
 * a row with a null org_id, which is invisible to every reader.
 *
 * That is not hypothetical: the agent created 66 customers this way and none of
 * them appeared in the customer picker, because the UI filters by workspace and
 * the rows belonged to none. The data was there the whole time and unreachable.
 */
export async function writeCustomerToPostgres(
  db: Db,
  customer: Customer,
  orgId?: string | null,
  /**
   * The account's own fields (customers.custom). An existing row's column is changed ONLY through `accountCustom`,
   * a delta merged in SQL onto what is stored at write time (agent/lib/custom-merge-sql.ts); without one the
   * column is left out of the update entirely. Writing back the whole value read before the write lost a note
   * written in between (39 of 40 rounds against a real Postgres). A NEW row is inserted with `customer.custom`.
   */
  opts: { accountCustom?: CustomDelta } = {},
): Promise<void> {
  const valid = customerSchema.parse(customer);
  const rows = customerToDbRows(valid);
  // The workspace goes on EVERY row, not only the customer's. The nested tables carry their own NOT NULL org_id
  // under the same org_isolation policy, so an unstamped deployment / implementation row is refused by the
  // database (42501) and the whole upsert rolls back: upsert_customer could write a customer, never its records.
  if (orgId) {
    const nested = [rows.customer, rows.platform, rows.implementation, ...rows.deployments, ...rows.solutions, ...rows.tickets, ...rows.interactions];
    for (const row of nested) if (row && "orgId" in row) (row as Record<string, unknown>).orgId = orgId;
  }
  await db.transaction(async (tx) => {
    /**
     * The scope is set INSIDE the existing transaction, not by wrapping it.
     *
     * withOrgDb opens its own transaction; nesting one inside this would put
     * the writes on a different connection from the one holding this
     * transaction's locks. One `set_config` here scopes every statement below,
     * which is all withOrgDb does anyway.
     */
    if (orgId) await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    const { customerId: _pk, custom: _custom, ...customerSet } = rows.customer as Record<string, unknown>;
    if (opts.accountCustom) customerSet.custom = customMergeSql(customersTable.custom, opts.accountCustom);
    const [written] = await tx
      .insert(customersTable)
      .values(rows.customer)
      .onConflictDoUpdate({ target: customersTable.customerId, set: customerSet })
      .returning({ custom: customersTable.custom });
    // The length cap, at WRITE time. Each append was checked against the text as it was READ; two appends at once
    // (18,000 stored + 1,500 + 1,500) each pass that check and together exceed it, after which every later append
    // is refused. The row is locked by this statement until commit, so what it returns is what would be stored:
    // over the cap, throw, and the transaction rolls back with nothing written.
    for (const key of Object.keys(opts.accountCustom?.append ?? {})) {
      const after = (written?.custom as Record<string, unknown> | null | undefined)?.[key];
      if (typeof after === "string" && after.length > LONG_TEXT_LIMIT) {
        throw new Error(`Custom fields were not accepted, so nothing was written. ${valid.id}: the own field "${key}" would be ${after.length.toLocaleString("en-US")} characters with this addition, over the ${LONG_TEXT_LIMIT.toLocaleString("en-US")}-character limit (text was added to it since it was read). Replace it with a shorter version (null for it in \`custom\` together with the new text in \`custom_append\`), then add to it again.`);
      }
    }
    // Replace-all for the nested domains: `valid` carries the full state, so
    // delete + insert keeps the tables an exact mirror of the entity.
    await tx.delete(platformTable).where(eq(platformTable.customerId, valid.id));
    await tx.delete(deploymentsTable).where(eq(deploymentsTable.customerId, valid.id));
    await tx.delete(solutionsTable).where(eq(solutionsTable.customerId, valid.id));
    await tx.delete(implementationTable).where(eq(implementationTable.customerId, valid.id));
    await tx.delete(ticketsTable).where(eq(ticketsTable.customerId, valid.id));
    await tx.delete(interactionsTable).where(eq(interactionsTable.customerId, valid.id));
    if (rows.platform) await tx.insert(platformTable).values(rows.platform);
    if (rows.deployments.length > 0) await tx.insert(deploymentsTable).values(rows.deployments);
    if (rows.solutions.length > 0) await tx.insert(solutionsTable).values(rows.solutions);
    if (rows.implementation) await tx.insert(implementationTable).values(rows.implementation);
    if (rows.tickets.length > 0) await tx.insert(ticketsTable).values(rows.tickets);
    if (rows.interactions.length > 0) await tx.insert(interactionsTable).values(rows.interactions);
  });
}

/* -------------------------------------------------------------------------- */
/* Public API — unchanged signatures; Postgres when configured, JSON fallback */
/* -------------------------------------------------------------------------- */

export async function listCustomers(orgId?: string | null): Promise<
  Array<
    Pick<
      Customer,
      | "id"
      | "name"
      | "tier"
      | "lifecycleStage"
      | "status"
      | "fdeOwner"
      | "companyDomain"
      | "businessOwnerEmail"
      | "technicalOwnerEmail"
    > & {
      openTickets: number;
      /** The account's own fields the profile shows in lists (`show_in_list`); absent when it has none. */
      custom?: CustomValues;
    }
  >
> {
  // A list carries only the own fields a profile marks show_in_list: a long note on every account would make one
  // list call cost what reading each of them does. get_customer returns them all.
  const listed = new Set(customFieldsOf("account").filter((f) => f.show_in_list).map((f) => f.key));
  const listCustom = (stored: unknown): { custom?: CustomValues } => {
    if (!listed.size) return {};
    const values = Object.fromEntries(Object.entries(asCustomValues(stored)).filter(([k]) => listed.has(k)));
    return Object.keys(values).length ? { custom: values } : {};
  };
  const db = getDb();
  if (db) {
    // Workspace scope: filter to the caller's org when one is given (fail-safe:
    // no org → all rows, which is the single-org world). org_id backfills to
    // 'onfinance', so passing 'onfinance' matches every legacy row.
    const orgFilter = orgId ? eq(customersTable.orgId, orgId) : undefined;
    /**
     * Scoped when a workspace is named, swept across all of them when not.
     *
     * "No workspace → every row" is the existing contract. Sweeping preserves
     * exactly that while keeping each read inside a scope, so it survives the
     * fail-closed policy — where one unscoped query returns nothing. This is
     * the function whose unscoped read blinded the agent when the flip first
     * went in.
     */
    const run = <T>(fn: (tx: Db) => Promise<T[]>): Promise<T[]> =>
      orgId ? withOrgDb(orgId, fn) : acrossOrgDbs(fn);
    const [rows, openTicketRows] = await Promise.all([
      run((tx) =>
tx
        .select({
          id: customersTable.customerId,
          name: customersTable.customerName,
          tier: customersTable.tier,
          lifecycleStage: customersTable.lifecycleStage,
          status: customersTable.status,
          fdeOwner: customersTable.fdeOwner,
          companyDomain: customersTable.companyDomain,
          businessOwnerEmail: customersTable.businessOwnerEmail,
          technicalOwnerEmail: customersTable.technicalOwnerEmail,
          custom: customersTable.custom,
        })
        .from(customersTable)
        .where(orgFilter)
        .orderBy(customersTable.customerId),
      ),
      run((tx) =>
tx
          .select({ customerId: ticketsTable.customerId })
          .from(ticketsTable)
          .where(notInArray(ticketsTable.ticketStatus, CLOSED_TICKET_STATUSES)),
      ),
    ]);
    const openByCustomer = new Map<string, number>();
    for (const t of openTicketRows) {
      openByCustomer.set(t.customerId, (openByCustomer.get(t.customerId) ?? 0) + 1);
    }
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      tier: row.tier ?? undefined,
      lifecycleStage: (row.lifecycleStage ?? undefined) as Customer["lifecycleStage"],
      status: (row.status ?? undefined) as Customer["status"],
      fdeOwner: row.fdeOwner ?? undefined,
      companyDomain: row.companyDomain ?? undefined,
      businessOwnerEmail: row.businessOwnerEmail ?? undefined,
      technicalOwnerEmail: row.technicalOwnerEmail ?? undefined,
      openTickets: openByCustomer.get(row.id) ?? 0,
      ...listCustom(row.custom),
    }));
  }
  const { customers } = await readStore();
  return customers.map((c) => ({
    id: c.id,
    name: c.name,
    tier: c.tier,
    lifecycleStage: c.lifecycleStage,
    status: c.status,
    fdeOwner: c.fdeOwner,
    companyDomain: c.companyDomain,
    businessOwnerEmail: c.businessOwnerEmail,
    technicalOwnerEmail: c.technicalOwnerEmail,
    openTickets: (c.tickets ?? []).filter((t) => isOpenTicket(t.ticketStatus)).length,
    ...listCustom(c.custom),
  }));
}

export async function getCustomer(id: string, orgId?: string | null): Promise<Customer | null> {
  const db = getDb();
  if (db) {
    // Workspace scope. Reading by id is the way around a filtered list: knowing
    // (or guessing) an id from another tenant would otherwise return the whole
    // record. Absent from your workspace reads as absent, not as forbidden —
    // a 403 confirms the id exists somewhere, which is itself a leak.
    //
    // The read ITSELF runs in the caller's scope, so row-level security is the
    // check. It used to read across every workspace and then ask, in the
    // caller's scope, which workspace owned the row; under the fail-closed
    // policy that second read cannot see another workspace's row, came back
    // empty, and `row?.orgId && …` let the other workspace's record through.
    // No orgId (seed scripts, tests, the JSON fallback) keeps the old
    // "find it wherever it lives" contract.
    return await dbGetCustomer(db, id, orgId);
  }
  const { customers } = await readStore();
  return customers.find((c) => c.id === id) ?? null;
}

/**
 * The profile's custom fields on the records a patch carries (agent/lib/custom-fields.ts), before anything is
 * written: the account's own (`custom`, account_fields.custom_fields) and each area row's. A patch names the
 * `deployments[]` rows and the `implementation` fields it changes (customer-schema.ts: deploymentPatchSchema), and
 * `custom` follows the rule every write path shares: a record that already exists keeps the custom values the
 * patch does not mention, a new one must carry the required ones, an undeclared key is refused. Throws the plain
 * sentences; the model reads them.
 */
export function applyCustomFields(
  patch: CustomerPatch,
  existing: Customer | null,
  /** The declared fields per record; this build's profile unless a test passes another's (a missing one = none). */
  declared?: Partial<Record<CustomFieldArea, CustomFieldSpec[]>>,
): CustomerPatch {
  return applyCustomFieldsWithDelta(patch, existing, declared).patch;
}

/** What a patch changes in each nested row's `custom`, by row (the implementation has one), for the SQL merge. */
export interface RowCustomDeltas {
  deployments: Map<string, CustomDelta>;
  implementation?: CustomDelta;
}

/**
 * applyCustomFields, plus what the patch CHANGES in each `custom` (`accountDelta` for the account, `rowDeltas` for
 * each deployments[] row and the implementation; absent where it names none of it), which the write merges in SQL
 * at write time rather than writing back the whole column read earlier. `custom_append` (long-text additions, the
 * model's way to add to a long note without resending it) is resolved here: into the returned patch's `custom`
 * (what the record reads after the write) and into the delta's `append`, and is never part of the stored record.
 * A model rewriting a long_text value whole may not cut it below half its length (validateCustom's shrinkGuard):
 * it appends, or clears first. A row the patch removes (`remove: true`) is not checked: it is not written.
 */
export function applyCustomFieldsWithDelta(
  patch: CustomerPatch,
  existing: Customer | null,
  declared: Partial<Record<CustomFieldArea, CustomFieldSpec[]>> = { account: customFieldsOf("account"), deployments: customFieldsOf("deployments"), implementations: customFieldsOf("implementations") },
): { patch: CustomerPatch; accountDelta?: CustomDelta; rowDeltas: RowCustomDeltas } {
  const errors: string[] = [];
  let accountDelta: CustomDelta | undefined;
  const rowDeltas: RowCustomDeltas = { deployments: new Map() };
  const check = (area: CustomFieldArea, what: string, custom: unknown, prev: { custom?: unknown } | undefined, append?: unknown, onDelta?: (d: CustomDelta | undefined) => void) => {
    const fields = declared[area] ?? [];
    // Nothing declared and nothing sent: the record is written exactly as it was before custom fields existed.
    if (custom === undefined && append === undefined && !prev?.custom && fields.length === 0) return undefined;
    // A REPLACEMENT (null in `custom` + text in `custom_append` for one long-text key) is one write of the new
    // text: the key is taken out of `custom` (so a required field is not "cleared") and out of the stored values
    // (so the text is not appended to the old one), and the delta SETs it instead of appending.
    const replacing = area === "account" ? replacedKeys(custom, append) : [];
    const checked = replacing.length ? Object.fromEntries(Object.entries(custom as Record<string, unknown>).filter(([k]) => !replacing.includes(k))) : custom;
    const result = validateCustom(area, checked, prev ? { mode: "update", existing: prev.custom, fields, shrinkGuard: { append: area === "account" } } : { mode: "create", fields });
    if (result.ok && area === "account") {
      const base = Object.fromEntries(Object.entries(result.values).filter(([k]) => !replacing.includes(k)));
      const added = validateAppend(append, { fields, values: base, also: checked });
      if (!added.ok) {
        errors.push(...added.errors.map((e) => `${what}: ${e}`));
        return undefined;
      }
      const appendOnly = Object.fromEntries(Object.entries(added.append).filter(([k]) => !replacing.includes(k)));
      accountDelta = customDelta(checked, result.values, appendOnly);
      if (replacing.length) {
        accountDelta ??= { set: {}, clear: [], append: {} };
        for (const k of replacing) accountDelta.set[k] = added.append[k];
      }
      result.values = added.values;
    } else if (result.ok) onDelta?.(customDelta(checked, result.values));
    // No values and none stored before: leave `custom` off, so a record nobody gave an own value to reads back as
    // it was written whether or not the profile declares fields (an explicit clear of stored values still writes {}).
    if (result.ok) return Object.keys(result.values).length === 0 && !prev?.custom ? undefined : result.values;
    errors.push(...result.errors.map((e) => `${what}: ${e}`));
    return undefined;
  };
  const { custom_append: append, ...rest } = patch;
  const out: CustomerPatch = { ...rest };
  // The account record itself. `prev` is the stored account, so its values survive a patch that does not name them.
  const account = check("account", patch.id, patch.custom, existing ?? undefined, append);
  if (account !== undefined) out.custom = account;
  else if (patch.custom !== undefined) delete out.custom;
  if (patch.deployments) {
    out.deployments = patch.deployments.map((d) => {
      if (d.remove) return d;
      const custom = check("deployments", d.deploymentId, d.custom, existing?.deployments?.find((p) => p.deploymentId === d.deploymentId), undefined, (delta) => {
        if (delta) rowDeltas.deployments.set(d.deploymentId, delta);
      });
      return custom === undefined ? d : { ...d, custom };
    });
  }
  if (patch.implementation && !patch.implementation.remove) {
    const custom = check("implementations", patch.implementation.rolloutId ?? existing?.implementation?.rolloutId ?? patch.id, patch.implementation.custom, existing?.implementation, undefined, (delta) => {
      rowDeltas.implementation = delta;
    });
    if (custom !== undefined) out.implementation = { ...patch.implementation, custom };
  }
  if (errors.length) throw new Error(`Custom fields were not accepted, so nothing was written. ${errors.join(" ")}`);
  return { patch: out, accountDelta, rowDeltas };
}

/** An account whose own values were all cleared has no `custom`, as one that never had any (customers.custom is NULL). */
function withoutEmptyCustom(customer: Customer): Customer {
  if (customer.custom && Object.keys(customer.custom).length === 0) {
    const { custom: _empty, ...rest } = customer;
    return rest;
  }
  return customer;
}

/**
 * The nested parts of an account, each written the same way (review of #70: one rule for every list the model
 * writes, not "merged" for two and "replaced" for four). A list is matched row by row on its id, a single record by
 * the account. `custom` is merged by delta on the two areas that carry it.
 */
type NestedKey = "platform" | "deployments" | "solutions" | "implementation" | "tickets" | "interactions";
interface NestedPart {
  key: NestedKey;
  /** The row's id field in the entity (and its column property in the table); null for the one-per-account records. */
  id: string | null;
  table: typeof platformTable | typeof deploymentsTable | typeof solutionsTable | typeof implementationTable | typeof ticketsTable | typeof interactionsTable;
  schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }; parse: (v: unknown) => unknown };
  /** How a sentence names one of its rows. */
  noun: string;
}
const NESTED: NestedPart[] = [
  { key: "platform", id: null, table: platformTable, schema: platformSchema, noun: "platform record" },
  { key: "deployments", id: "deploymentId", table: deploymentsTable, schema: deploymentSchema, noun: "deployments row" },
  { key: "solutions", id: "solutionId", table: solutionsTable, schema: solutionSchema, noun: "solutions row" },
  { key: "implementation", id: null, table: implementationTable, schema: implementationSchema, noun: "implementation record" },
  { key: "tickets", id: "ticketId", table: ticketsTable, schema: ticketSchema, noun: "tickets row" },
  { key: "interactions", id: "interactionId", table: interactionsTable, schema: interactionSchema, noun: "interactions row" },
];
const NESTED_KEYS = new Set<string>([...NESTED.map((p) => p.key), "custom", "custom_append"]);

type Row = Record<string, unknown>;
/** A part's rows in a patch (a single record is a list of one). */
const patchRows = (patch: CustomerPatch, part: NestedPart): Row[] => {
  const v = (patch as Row)[part.key];
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]) as Row[];
};
/** A part's stored rows in a record read earlier. */
const storedRows = (record: Customer | null, part: NestedPart): Row[] => {
  const v = record ? (record as Row)[part.key] : undefined;
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]) as Row[];
};
const sameRow = (part: NestedPart) => (a: Row) => (b: Row) => (part.id ? a[part.id] === b[part.id] : true);
const rowName = (part: NestedPart, row: Row) => (part.id ? `${part.id} ${String(row[part.id])}` : `the ${part.noun}`);

/** A patch row's own fields: what it names to change, `null` for a field it clears. Its key and `remove` are not fields. */
function namedFields(row: Row, key: string | null): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === key || k === "remove" || k === "custom" || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** A stored row with a patch row's named fields applied (null deletes the field), in memory. */
function mergeRow(prev: Row | undefined, row: Row, key: string | null): Row {
  const next: Row = { ...(prev ?? {}) };
  if (key) next[key] = row[key];
  for (const [k, v] of Object.entries(namedFields(row, key))) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  if (row.custom !== undefined) next.custom = row.custom;
  return next;
}

/** "a, b and c" */
const listed = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/**
 * Refuse a patch whose rows cannot be written as named, in sentences, before anything is written: a row named twice,
 * `remove: true` sent with fields (a delete is only ever asked for on its own), `remove` for a row that is not there,
 * and a new row without its required fields.
 */
function checkRowPatch(patch: CustomerPatch, existing: Customer | null): void {
  const errors: string[] = [];
  for (const part of NESTED) {
    const seen = new Set<unknown>();
    const stored = storedRows(existing, part);
    for (const row of patchRows(patch, part)) {
      const name = rowName(part, row);
      if (part.id) {
        if (seen.has(row[part.id])) errors.push(`${name} is in ${part.key}[] more than once; send each row once.`);
        seen.add(row[part.id]);
      }
      const there = stored.some(sameRow(part)(row));
      if (row.remove) {
        const extra = Object.keys(row).filter((k) => k !== part.id && k !== "remove" && row[k] !== undefined);
        if (extra.length) errors.push(`${name}: remove: true deletes the row, so it is sent with nothing else (it also named ${listed(extra)}). To change the row, leave remove out; to delete it, send only ${part.id ? `its ${part.id} and ` : ""}remove: true.`);
        else if (!there) errors.push(`${name}: there is no such ${part.noun} to remove.`);
        continue;
      }
      if (there) continue;
      const created = part.schema.safeParse(mergeRow(undefined, row, part.id));
      if (!created.success) {
        const missing = listed([...new Set((created.error?.issues ?? []).map((i) => String(i.path[0] ?? "")))].filter(Boolean));
        errors.push(part.id ? `${name} is a new row, so it needs ${missing} (a row that already exists needs only the fields that change).` : `${patch.id} has no ${part.noun} yet, so a new one needs ${missing}.`);
      }
    }
  }
  if (errors.length) throw new Error(`Nothing was written. ${errors.join(" ")}`);
}

/**
 * The record a patch leaves, computed in memory from the record read before it: the account merged, and every
 * nested part merged row by row (a named row onto the stored one, a new one appended, a removed one gone, every row
 * the patch does not name kept). This is the fallback store's write; Postgres applies the same patch in SQL
 * (writeCustomerPatchToPostgres).
 */
export function applyPatchToRecord(existing: Customer | null, patch: CustomerPatch): Customer {
  checkRowPatch(patch, existing);
  const base: Row = existing ? { ...existing } : { name: patch.id };
  for (const [k, v] of Object.entries(patch)) if (!NESTED_KEYS.has(k) && v !== undefined) base[k] = v;
  if (patch.custom !== undefined) base.custom = patch.custom;
  for (const part of NESTED) {
    if ((patch as Row)[part.key] === undefined) continue;
    const rows = storedRows(existing, part).map((r) => ({ ...r }));
    for (const row of patchRows(patch, part)) {
      const at = rows.findIndex(sameRow(part)(row));
      if (row.remove) {
        if (at !== -1) rows.splice(at, 1);
      } else if (at === -1) rows.push(mergeRow(undefined, row, part.id));
      else rows[at] = mergeRow(rows[at], row, part.id);
    }
    if (!rows.length) delete base[part.key];
    else base[part.key] = part.id ? rows : rows[0];
  }
  return withoutEmptyCustom(customerSchema.parse(base));
}

/** The sentence for an account that is not the caller's to write, whether it is absent or another workspace's. */
const notYours = (id: string) => `Unknown customer: ${id}`;

/**
 * Write a validated PATCH to Postgres, changing only what it names, each change applied in SQL onto what is stored
 * at write time. `existing` is the record read before (in the caller's scope); it decides only whether a row is new.
 *
 *  - the customers row: the scalar fields the patch names (a new account is inserted whole); `custom` merged by delta;
 *  - every nested part (platform, deployments[], solutions[], implementation, tickets[], interactions[]): each named
 *    row by (customer, its id): its named fields SET (null clears one), `custom` merged by delta where it has one; a
 *    new row inserted whole; `remove: true` deletes it; a row the patch does not name is untouched.
 *
 * THE ACCOUNT MUST BE THE CALLER'S before any nested row is written (review of #70). A nested table's foreign key is
 * checked past row-level security, so a patch from another workspace naming this account's id, which reads no
 * account and so takes the "new account" path, would otherwise plant rows under it stamped with its own workspace.
 * The account row is read back inside this transaction, in the caller's scope; absent, nothing is written.
 */
export async function writeCustomerPatchToPostgres(
  db: Db,
  patch: CustomerPatch,
  existing: Customer | null,
  orgId?: string | null,
  deltas: { accountCustom?: CustomDelta; rows?: RowCustomDeltas } = {},
): Promise<void> {
  const id = patch.id;
  const created = existing ? null : applyPatchToRecord(null, patch);
  if (existing) checkRowPatch(patch, existing);
  const stamp = <T extends Row>(row: T): T => {
    if (orgId && "orgId" in row) (row as Row).orgId = orgId;
    return row;
  };
  await db.transaction(async (tx) => {
    // Scoped inside this transaction, as writeCustomerToPostgres is (withOrgDb would open a second one).
    if (orgId) await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);

    // The account row: the scalar fields the patch names, and `custom` only through its delta.
    const customerSet: Row = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || NESTED_KEYS.has(k) || v === undefined) continue;
      customerSet[k === "name" ? "customerName" : k] = v;
    }
    if (deltas.accountCustom) customerSet.custom = customMergeSql(customersTable.custom, deltas.accountCustom);
    let written: { custom: unknown } | undefined;
    if (created) {
      const row = stamp(customerToDbRows(created).customer as Row) as typeof customersTable.$inferInsert;
      const insert = tx.insert(customersTable).values(row);
      [written] = await (Object.keys(customerSet).length
        ? insert.onConflictDoUpdate({ target: customersTable.customerId, set: customerSet })
        : insert.onConflictDoNothing()
      ).returning({ custom: customersTable.custom });
    } else if (Object.keys(customerSet).length) {
      [written] = await tx.update(customersTable).set(customerSet).where(eq(customersTable.customerId, id)).returning({ custom: customersTable.custom });
      if (!written) throw new Error(notYours(id));
    }
    // The account is the caller's, as this transaction sees it, or nothing below is written (see above).
    const [mine] = await tx.select({ id: customersTable.customerId }).from(customersTable).where(eq(customersTable.customerId, id)).limit(1);
    if (!mine) throw new Error(notYours(id));
    // The length cap, at WRITE time (see writeCustomerToPostgres): the row is locked until commit.
    for (const key of Object.keys(deltas.accountCustom?.append ?? {})) {
      const after = (written?.custom as Row | null | undefined)?.[key];
      if (typeof after === "string" && after.length > LONG_TEXT_LIMIT) {
        throw new Error(`Custom fields were not accepted, so nothing was written. ${id}: the own field "${key}" would be ${after.length.toLocaleString("en-US")} characters with this addition, over the ${LONG_TEXT_LIMIT.toLocaleString("en-US")}-character limit (text was added to it since it was read). Replace it with a shorter version (null for it in \`custom\` together with the new text in \`custom_append\`), then add to it again.`);
      }
    }

    // Every nested part: one statement per named row.
    for (const part of NESTED) {
      const t = part.table as unknown as Record<string, PgColumn> & PgTable;
      const stored = storedRows(existing, part);
      for (const row of patchRows(patch, part)) {
        const where = part.id ? and(eq(t.customerId, id), eq(t[part.id], row[part.id] as string)) : eq(t.customerId, id);
        const name = rowName(part, row);
        if (row.remove) {
          const gone = await tx.delete(t).where(where).returning({ id: t.customerId });
          if (!gone.length) throw new Error(`Nothing was written. ${name}: there is no such ${part.noun} to remove (it was removed after it was read).`);
          continue;
        }
        const set: Row = namedFields(row, part.id);
        const delta = part.key === "deployments" ? deltas.rows?.deployments.get(String(row.deploymentId)) : part.key === "implementation" ? deltas.rows?.implementation : undefined;
        if (delta) set.custom = customMergeSql(t.custom, delta, { empty: "object" });
        if (stored.some(sameRow(part)(row))) {
          if (!Object.keys(set).length) continue;
          const [hit] = await tx.update(t).set(set).where(where).returning({ id: t.customerId });
          if (!hit) throw new Error(`Nothing was written. ${name} of ${id} was removed after it was read; send it again as a new one if it should exist.`);
        } else {
          const full = part.schema.parse(mergeRow(undefined, row, part.id)) as Row;
          const values = "custom" in full || part.key === "deployments" || part.key === "implementation" ? { ...full, custom: asCustomValues(full.custom) } : full;
          const insertRow = stamp(fullRow(part.table, { customerId: id, ...values }) as Row);
          const target = part.id ? [t.customerId, t[part.id]] : t.customerId;
          // Written by someone else since the read: the named fields are applied onto it, as for a stored row.
          const insert = tx.insert(t).values(insertRow as never);
          await (Object.keys(set).length ? insert.onConflictDoUpdate({ target, set }) : insert.onConflictDoNothing());
        }
      }
    }
  });
}

/**
 * The patch, validated. A list row sent without its id (`deployments: [{ notes: "x" }]`) used to surface as zod's
 * raw JSON issue dump; the model reads a sentence instead, naming the row and the id it needs. Every other problem
 * is reported as before.
 */
function parsePatch(patch: CustomerPatch): CustomerPatch {
  const parsed = customerPatchSchema.safeParse(patch);
  if (parsed.success) return parsed.data;
  const noId: string[] = [];
  for (const issue of parsed.error.issues) {
    const [list, index, field] = issue.path;
    const part = NESTED.find((p) => p.key === list && p.id !== null);
    if (part && typeof index === "number" && field === part.id && (patch as Row)[part.key] && ((patch as Row)[part.key] as Row[])[index]?.[part.id] === undefined) {
      noId.push(`${part.key}[${index}] has no ${part.id}: every row names its ${part.id}, a new one too.`);
    }
  }
  if (noId.length) throw new Error(`Nothing was written. ${[...new Set(noId)].join(" ")}`);
  throw parsed.error;
}

export async function upsertCustomer(
  patch: CustomerPatch,
  orgId?: string | null,
  /** Tests only: the declared custom fields, when this build's profile declares none. */
  opts: { declared?: Partial<Record<CustomFieldArea, CustomFieldSpec[]>> } = {},
): Promise<Customer> {
  const parsedPatch = parsePatch(patch);
  const db = getDb();
  if (db) {
    // The record being patched is read in the CALLER's workspace. Read across all of them, another workspace's
    // record was merged into this patch and written under the caller's scope; the database refused the write,
    // and the refusal text carried every merged value back to the model.
    const existing = await dbGetCustomer(db, parsedPatch.id, orgId);
    const { patch: validPatch, accountDelta, rowDeltas } = applyCustomFieldsWithDelta(parsedPatch, existing, opts.declared);
    // Only what the patch names, each change applied in SQL onto what is stored at write time.
    await writeCustomerPatchToPostgres(db, validPatch, existing, orgId, { accountCustom: accountDelta, rows: rowDeltas });
    // The record AS STORED after the write, not the one computed from the read: a change someone else made in
    // between is part of it, and the caller is not told a stale value was kept.
    const after = await dbGetCustomer(db, parsedPatch.id, orgId);
    if (!after) throw new Error(`Unknown customer: ${parsedPatch.id}`);
    return after;
  }
  const store = await readStore();
  const idx = store.customers.findIndex((c) => c.id === parsedPatch.id);
  const existing = idx === -1 ? null : store.customers[idx];
  const validPatch = applyCustomFields(parsedPatch, existing, opts.declared);
  const merged = applyPatchToRecord(existing, validPatch);
  if (idx === -1) store.customers.push(merged);
  else store.customers[idx] = merged;
  await writeStore(store);
  return merged;
}

export async function recordInteraction(
  customerId: string,
  interaction: Interaction,
  /** The caller's workspace; an id outside it is "Unknown customer". Omitted only by system paths. */
  orgId?: string | null,
): Promise<Customer> {
  const db = getDb();
  if (db) {
    const valid = interactionSchema.parse(interaction);
    const scope = await scopeFor(customerId, orgId);
    const exists = await withOrgDb(scope, (tx) =>
      tx
        .select({ customerId: customersTable.customerId })
        .from(customersTable)
        .where(eq(customersTable.customerId, customerId))
        .limit(1),
    );
    if (exists.length === 0) throw new Error(`Unknown customer: ${customerId}`);
    await withOrgDb(scope, (tx) =>
      tx
        .insert(interactionsTable)
        // The workspace is stamped: fullRow writes an explicit NULL for every column it is not given, and a
        // NULL org_id is refused by the policy's WITH CHECK (42501), so no interaction could be logged at all.
        .values(fullRow(interactionsTable, { customerId, ...valid, orgId: scope })),
    );
    await appendInteractionArtifacts(customerId, [valid], scope);
    const customer = await dbGetCustomer(db, customerId, scope);
    if (!customer) throw new Error(`Unknown customer: ${customerId}`);
    return customer;
  }
  const store = await readStore();
  const customer = store.customers.find((c) => c.id === customerId);
  if (!customer) throw new Error(`Unknown customer: ${customerId}`);
  customer.interactions = [interaction, ...(customer.interactions ?? [])];
  await writeStore(store);
  await appendInteractionArtifact(customerId, interaction);
  return customer;
}

/**
 * Batch sibling of {@link recordInteraction}: append MANY interactions to one
 * customer in a single round-trip (one multi-row insert + one jsonl append)
 * instead of N tool calls. Same validation and caller-stamping semantics per
 * record. Returns the updated customer once, not per record.
 */
export async function recordInteractions(
  customerId: string,
  interactions: readonly Interaction[],
  /** The caller's workspace; an id outside it is "Unknown customer". Omitted only by system paths. */
  orgId?: string | null,
): Promise<Customer> {
  if (interactions.length === 0) throw new Error("recordInteractions: no interactions given");
  const valid = interactions.map((i) => interactionSchema.parse(i));
  const db = getDb();
  if (db) {
    const scope = await scopeFor(customerId, orgId);
    const exists = await withOrgDb(scope, (tx) =>
      tx
        .select({ customerId: customersTable.customerId })
        .from(customersTable)
        .where(eq(customersTable.customerId, customerId))
        .limit(1),
    );
    if (exists.length === 0) throw new Error(`Unknown customer: ${customerId}`);
    await withOrgDb(scope, (tx) =>
      tx
        .insert(interactionsTable)
        .values(valid.map((v) => fullRow(interactionsTable, { customerId, ...v, orgId: scope }))),
    );
    await appendInteractionArtifacts(customerId, valid, scope);
    const customer = await dbGetCustomer(db, customerId, scope);
    if (!customer) throw new Error(`Unknown customer: ${customerId}`);
    return customer;
  }
  const store = await readStore();
  const customer = store.customers.find((c) => c.id === customerId);
  if (!customer) throw new Error(`Unknown customer: ${customerId}`);
  // Prepend the batch in the given order (first element = newest).
  customer.interactions = [...valid, ...(customer.interactions ?? [])];
  await writeStore(store);
  await appendInteractionArtifacts(customerId, valid);
  return customer;
}

/** A customer that has gone quiet — no logged interaction within the window. */
export interface StaleCustomer {
  customerId: string;
  customerName: string;
  lifecycleStage: string | null;
  status: string | null;
  healthReason: string | null;
  fdeOwner: string | null;
  lastInteractionAt: string | null;
  daysQuiet: number | null;
}

/**
 * Active customers (in-flight — not Live, not Prospect) with NO interaction in
 * the last `days` days (or none ever) — i.e. accounts going quiet. Sorted
 * most-stale first (never-touched, then oldest last touch). Reads Postgres; []
 * on the JSON fallback. This is the signal the stale-customer sweep files on.
 */
const ACTIVE_STALE_STAGES = ["Onboarding", "Pilot", "Contracting"];

export async function listStaleCustomers(days: number): Promise<StaleCustomer[]> {
  const db = getDb();
  if (!db) return [];
  const now = Date.now();
  const cutoffMs = now - days * 86_400_000;

  const rows = await acrossOrgDbs((tx) =>
    tx
      .select({
        customerId: customersTable.customerId,
        customerName: customersTable.customerName,
        lifecycleStage: customersTable.lifecycleStage,
        status: customersTable.status,
        healthReason: customersTable.healthReason,
        fdeOwner: customersTable.fdeOwner,
      })
      .from(customersTable),
  );

  // Latest interaction per customer (one pass over the interactions table).
  const latest = new Map<string, number>();
  const ints = await acrossOrgDbs((tx) =>
    tx
      .select({ customerId: interactionsTable.customerId, at: interactionsTable.interactionAt })
      .from(interactionsTable),
  );
  for (const i of ints) {
    const t = Date.parse(String(i.at ?? ""));
    if (Number.isNaN(t)) continue;
    const prev = latest.get(i.customerId);
    if (prev === undefined || t > prev) latest.set(i.customerId, t);
  }

  const stale: StaleCustomer[] = [];
  for (const r of rows) {
    if (!ACTIVE_STALE_STAGES.includes(r.lifecycleStage ?? "")) continue;
    const last = latest.get(r.customerId);
    if (last !== undefined && last >= cutoffMs) continue; // touched recently — not stale
    stale.push({
      ...r,
      lastInteractionAt: last !== undefined ? new Date(last).toISOString().slice(0, 10) : null,
      daysQuiet: last !== undefined ? Math.floor((now - last) / 86_400_000) : null,
    });
  }
  // Most stale first: never-touched (null) first, then oldest last touch.
  stale.sort((a, b) => (b.daysQuiet ?? Infinity) - (a.daysQuiet ?? Infinity));
  return stale;
}

/** An open, urgent ticket surfaced for the prioritized sweep. */
export interface UrgentTicket {
  ticketId: string;
  customerId: string;
  customerName: string;
  summary: string;
  /** Full description — carries the reported metric signal (uptime/accuracy/etc.). */
  description: string | null;
  ticketPriority: string;
  slaStatus: string | null;
  ticketNextStep: string;
  openedAt: string | null;
  /** Age in hours since opened — the measured TAT for SLA reconciliation. */
  ageHours: number | null;
  dueAt: string | null;
  overdue: boolean;
  /** Lower = more urgent (P0 breached/overdue first). */
  urgencyRank: number;
}

const URGENT_PRIORITIES = ["P0-Critical", "P1-High"];

/**
 * Open tickets that are URGENT — P0/P1 priority, SLA at-risk/breached, or past
 * their due date (slaDueAt → resolutionDueAt → ticketDueDate) — across all
 * customers, ranked most-urgent first. This is the "urgent tickets from the
 * tickets store" filter the sweep prioritizes on. [] on the JSON fallback.
 */
export async function listUrgentTickets(): Promise<UrgentTicket[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await acrossOrgDbs((tx) =>
    tx
      .select({ ticket: ticketsTable, customerName: customersTable.customerName })
      .from(ticketsTable)
      .innerJoin(customersTable, eq(ticketsTable.customerId, customersTable.customerId))
      .where(notInArray(ticketsTable.ticketStatus, CLOSED_TICKET_STATUSES)),
  );

  const now = Date.now();
  const out: UrgentTicket[] = [];
  for (const { ticket: t, customerName } of rows) {
    const dueRaw = t.slaDueAt || t.resolutionDueAt || t.ticketDueDate || null;
    const dueMs = dueRaw ? Date.parse(dueRaw) : NaN;
    const overdue = !Number.isNaN(dueMs) && dueMs < now;
    const urgentPriority = URGENT_PRIORITIES.includes(t.ticketPriority);
    const slaHot = t.slaStatus === "breached" || t.slaStatus === "at_risk";
    if (!urgentPriority && !slaHot && !overdue) continue; // not urgent — skip

    let rank = t.ticketPriority === "P0-Critical" ? 0 : t.ticketPriority === "P1-High" ? 10 : 30;
    if (t.slaStatus === "breached") rank -= 6;
    else if (t.slaStatus === "at_risk") rank -= 3;
    if (overdue) rank -= 4;
    const openedMs = t.ticketOpenedDate ? Date.parse(t.ticketOpenedDate) : NaN;
    out.push({
      ticketId: t.ticketId,
      customerId: t.customerId,
      customerName,
      summary: t.summary,
      description: t.description ?? null,
      ticketPriority: t.ticketPriority,
      slaStatus: t.slaStatus ?? null,
      ticketNextStep: t.ticketNextStep,
      openedAt: t.ticketOpenedDate ?? null,
      ageHours: Number.isNaN(openedMs) ? null : Math.floor((now - openedMs) / 3_600_000),
      dueAt: dueRaw,
      overdue,
      urgencyRank: rank,
    });
  }
  out.sort((a, b) => a.urgencyRank - b.urgencyRank);
  return out;
}

/**
 * Reassign a customer's durable FDE owner: update `customers.fde_owner` and upsert
 * the `internal_staff` solution_engineer row, in one call. Returns the previous +
 * new owner so the caller can log the change. Requires Postgres.
 */
export async function reassignOwner(
  customerId: string,
  newOwnerEmail: string,
  ownerName?: string,
  /** The caller's workspace; an id outside it is "Unknown customer". Omitted only by system paths. */
  orgId?: string | null,
): Promise<{ customerId: string; previousOwner: string | null; newOwner: string }> {
  const db = getDb();
  if (!db) throw new Error("reassignOwner requires a database");
  const staffOrg = await scopeFor(customerId, orgId);
  const rows = await withOrgDb(staffOrg, (tx) =>
    tx
      .select({ fdeOwner: customersTable.fdeOwner })
      .from(customersTable)
      .where(eq(customersTable.customerId, customerId))
      .limit(1),
  );
  if (rows.length === 0) throw new Error(`Unknown customer: ${customerId}`);
  const previousOwner = rows[0].fdeOwner ?? null;
  await withOrgDb(staffOrg, (tx) =>
    tx
      .update(customersTable)
      .set({ fdeOwner: newOwnerEmail })
      .where(eq(customersTable.customerId, customerId)),
  );
  // The customer owns the workspace answer here — a staff row belongs to the
  // same workspace as the account it staffs. Resolved once above, used for both
  // the scope and the row (an await cannot sit inside the sync callback).
  /**
   * `employer_org` is who the new owner WORKS FOR, and it was hardcoded to one
   * company. Every workspace on the platform therefore stamped that company's
   * name onto its own staff rows — visible in the data room, the People tab and
   * the exported workbook. It is the workspace's own name, read from the orgs
   * row. Read inside the workspace scope like everything else — `orgs` carries
   * no org_isolation policy, so the scope costs nothing and keeps this file
   * clean for the tenancy ratchet rather than needing an exemption.
   */
  const [org] = await withOrgDb(staffOrg, (tx) =>
    tx.select({ name: orgsTable.name }).from(orgsTable).where(eq(orgsTable.orgId, staffOrg)).limit(1),
  );
  await withOrgDb(staffOrg, (tx) =>
    tx
      .insert(internalStaffTable)
      .values({
        orgId: staffOrg,
        customerId,
        staffRole: "solution_engineer",
        email: newOwnerEmail,
        name: ownerName ?? newOwnerEmail,
        // notNull in the schema, so it always needs SOMETHING; the workspace id
        // is a poor label but an honest one when the row is missing a name.
        employerOrg: org?.name ?? staffOrg,
        lastContact: new Date().toISOString(),
      })
      .onConflictDoNothing(),
  );
  return { customerId, previousOwner, newOwner: newOwnerEmail };
}

/** Fields for a new ticket; the caller supplies a ticketId (dedup-safe id). */
export interface NewTicketInput {
  ticketId: string;
  customerId: string;
  summary: string;
  description?: string;
  ticketType: Ticket["ticketType"];
  ticketCategory: Ticket["ticketCategory"];
  ticketPriority: Ticket["ticketPriority"];
  ticketStatus?: Ticket["ticketStatus"];
  ticketOwnerEmail: string;
  ticketNextStep: string;
  sourceChannel?: Ticket["sourceChannel"];
  reportedByEmail?: string;
  customerContactEmail?: string;
  /** External id (e.g. an email Message-ID) — used to dedup re-runs. */
  externalId?: string;
  externalSystem?: string;
}

/**
 * Create a ticket in the system of record. Idempotent on (customerId, externalId):
 * if a ticket already exists for that external id, returns it with created:false
 * (so email intake / sweeps can re-run without duplicating). Requires Postgres.
 */
export async function createTicket(
  input: NewTicketInput,
  /** The caller's workspace; an id outside it is "Unknown customer". Omitted only by system paths. */
  orgId?: string | null,
): Promise<{ ticketId: string; created: boolean }> {
  const db = getDb();
  if (!db) throw new Error("createTicket requires a database");
  const scope = await scopeFor(input.customerId, orgId);
  const exists = await withOrgDb(scope, (tx) =>
    tx
      .select({ id: customersTable.customerId })
      .from(customersTable)
      .where(eq(customersTable.customerId, input.customerId))
      .limit(1),
  );
  if (exists.length === 0) throw new Error(`Unknown customer: ${input.customerId}`);
  if (input.externalId) {
    // Narrowing does not survive into the callback — capture it first.
    const externalId = input.externalId;
    const dup = await withOrgDb(scope, (tx) =>
      tx
        .select({ ticketId: ticketsTable.ticketId })
        .from(ticketsTable)
        .where(
          and(eq(ticketsTable.customerId, input.customerId), eq(ticketsTable.externalId, externalId)),
        )
        .limit(1),
    );
    if (dup.length > 0) return { ticketId: dup[0].ticketId, created: false };
  }
  const now = new Date().toISOString();
  const ticket = ticketSchema.parse({
    ticketId: input.ticketId,
    summary: input.summary,
    description: input.description,
    ticketType: input.ticketType,
    ticketCategory: input.ticketCategory,
    ticketStatus: input.ticketStatus ?? "Needs Triage",
    ticketPriority: input.ticketPriority,
    ticketOpenedDate: now,
    ticketOwnerEmail: input.ticketOwnerEmail,
    sourceChannel: input.sourceChannel ?? "Email",
    lastActivityDate: now,
    ticketNextStep: input.ticketNextStep,
    reportedByEmail: input.reportedByEmail,
    customerContactEmail: input.customerContactEmail,
    externalId: input.externalId,
    externalSystem: input.externalSystem ?? (input.externalId ? "email" : undefined),
  });
  await withOrgDb(scope, (tx) =>
    // Stamped for the same reason as the interaction rows: an explicit NULL org_id is refused (42501).
    tx.insert(ticketsTable).values(fullRow(ticketsTable, { customerId: input.customerId, ...ticket, orgId: scope })),
  );
  return { ticketId: input.ticketId, created: true };
}

/**
 * Mirror an interaction into the data room's document view
 * (`Customers/{id}/interactions.jsonl`). Best-effort: the system of record
 * (Postgres or the JSON fallback) has already been written by the caller.
 */
async function appendInteractionArtifact(
  customerId: string,
  interaction: Interaction,
): Promise<void> {
  await appendInteractionArtifacts(customerId, [interaction]);
}

/** Batch mirror — one jsonl append for many interactions. Best-effort. */
async function appendInteractionArtifacts(
  customerId: string,
  interactions: readonly Interaction[],
  orgId?: string | null,
): Promise<void> {
  if (interactions.length === 0) return;
  try {
    await getDataroomStore(await scopeFor(customerId, orgId)).appendJsonl(
      `Customers/${customerId}/interactions.jsonl`,
      interactions.length === 1 ? interactions[0] : [...interactions],
      interactionSchema,
    );
  } catch {
    // Document mirror only — never fail the record write over it.
  }
}

/** List open follow-ups across all customers, or scoped to one. */
export async function listFollowUps(
  customerId?: string,
  /** The caller's workspace. Omitted, it spans every workspace (the digest crons). */
  orgId?: string | null,
): Promise<Array<Ticket & { customerId: string; customerName: string }>> {
  const db = getDb();
  if (db) {
    const filters = [notInArray(ticketsTable.ticketStatus, CLOSED_TICKET_STATUSES)];
    if (customerId) filters.push(eq(ticketsTable.customerId, customerId));
    const run = <T>(fn: (tx: Db) => Promise<T[]>): Promise<T[]> => (orgId ? withOrgDb(orgId, fn) : acrossOrgDbs(fn));
    const rows = await run((tx) =>
      tx
        .select({ ticket: ticketsTable, customerName: customersTable.customerName })
        .from(ticketsTable)
        .innerJoin(customersTable, eq(ticketsTable.customerId, customersTable.customerId))
        .where(and(...filters))
        .orderBy(ticketsTable.customerId, ticketsTable.ticketId),
    );
    return rows.map((row) => ({
      ...ticketReadSchema.parse(rowToEntity(row.ticket)),
      customerId: row.ticket.customerId,
      customerName: row.customerName,
    }));
  }
  const { customers } = await readStore();
  const scoped = customerId ? customers.filter((c) => c.id === customerId) : customers;
  return scoped.flatMap((c) =>
    (c.tickets ?? [])
      .filter((t) => isOpenTicket(t.ticketStatus))
      .map((t) => ({ ...t, customerId: c.id, customerName: c.name })),
  );
}

export async function resolveFollowUp(
  customerId: string,
  followUpId: string,
  /** The caller's workspace; a ticket outside it is "not found". Omitted only by system paths. */
  orgId?: string | null,
): Promise<Ticket> {
  const db = getDb();
  if (db) {
    const updated = await withOrgDb(await scopeFor(customerId, orgId), (tx) =>
      tx
        .update(ticketsTable)
        .set({ ticketStatus: "Resolved" satisfies Ticket["ticketStatus"] })
        .where(and(eq(ticketsTable.customerId, customerId), eq(ticketsTable.ticketId, followUpId)))
        .returning(),
    );
    if (updated.length === 0) {
      throw new Error(`Ticket ${followUpId} not found for customer ${customerId}`);
    }
    return ticketReadSchema.parse(rowToEntity(updated[0]));
  }
  const store = await readStore();
  const customer = store.customers.find((c) => c.id === customerId);
  const ticket = customer?.tickets?.find((t) => t.ticketId === followUpId);
  if (!customer || !ticket) {
    throw new Error(`Ticket ${followUpId} not found for customer ${customerId}`);
  }
  ticket.ticketStatus = "Resolved";
  await writeStore(store);
  return ticket;
}

/**
 * Set a ticket's status — the promote/approval step for email-intake drafts:
 * moving a "Needs Triage" draft to "Open" (or another status) is how a human
 * approves it into a live ticket. Also updates lastActivityDate.
 */
export async function setTicketStatus(
  customerId: string,
  ticketId: string,
  ticketStatus: Ticket["ticketStatus"],
  /** The caller's workspace; a ticket outside it is "not found". Omitted only by system paths. */
  orgId?: string | null,
): Promise<Ticket> {
  const now = new Date().toISOString();
  const db = getDb();
  if (db) {
    const updated = await withOrgDb(await scopeFor(customerId, orgId), (tx) =>
      tx
        .update(ticketsTable)
        .set({ ticketStatus, lastActivityDate: now })
        .where(and(eq(ticketsTable.customerId, customerId), eq(ticketsTable.ticketId, ticketId)))
        .returning(),
    );
    if (updated.length === 0) {
      throw new Error(`Ticket ${ticketId} not found for customer ${customerId}`);
    }
    return ticketReadSchema.parse(rowToEntity(updated[0]));
  }
  const store = await readStore();
  const customer = store.customers.find((c) => c.id === customerId);
  const ticket = customer?.tickets?.find((t) => t.ticketId === ticketId);
  if (!customer || !ticket) {
    throw new Error(`Ticket ${ticketId} not found for customer ${customerId}`);
  }
  ticket.ticketStatus = ticketStatus;
  ticket.lastActivityDate = now;
  await writeStore(store);
  return ticket;
}

/**
 * The triage queue: draft tickets awaiting a human's approval (status
 * "Needs Triage"), across all customers. These are what email intake stages —
 * a person promotes them to "Open" (approve) or resolves them (discard).
 */
export async function listTriageTickets(): Promise<
  Array<Ticket & { customerId: string; customerName: string }>
> {
  const db = getDb();
  if (db) {
    const rows = await acrossOrgDbs((tx) =>
      tx
        .select({ ticket: ticketsTable, customerName: customersTable.customerName })
        .from(ticketsTable)
        .innerJoin(customersTable, eq(ticketsTable.customerId, customersTable.customerId))
        .where(eq(ticketsTable.ticketStatus, "Needs Triage"))
        .orderBy(ticketsTable.customerId, ticketsTable.ticketId),
    );
    return rows.map((row) => ({
      ...ticketReadSchema.parse(rowToEntity(row.ticket)),
      customerId: row.ticket.customerId,
      customerName: row.customerName,
    }));
  }
  const { customers } = await readStore();
  return customers.flatMap((c) =>
    (c.tickets ?? [])
      .filter((t) => t.ticketStatus === "Needs Triage")
      .map((t) => ({ ...t, customerId: c.id, customerName: c.name })),
  );
}

/** Freemail providers — a sender here can only match by exact contact email,
 *  never by domain (else every gmail sender would match one customer). */
const FREEMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.in", "yahoo.in", "ymail.com", "icloud.com", "me.com",
  "proton.me", "protonmail.com", "aol.com", "rediffmail.com", "zoho.com",
]);

export type CustomerMatch =
  | { matched: true; customerId: string; customerName: string; fdeOwner?: string; matchedOn: "contact" | "domain" }
  | { matched: false };

/**
 * Deterministically match an inbound email sender to a customer — the reliable
 * replacement for asking the model to eyeball the roster. Exact (case-insensitive)
 * match on any owner contact email (business/technical/executive), else, for a
 * non-freemail sender, an exact match on company_domain. Returns {matched:false}
 * when nothing lines up — the caller must NOT guess past that.
 */
export async function matchCustomerByEmail(
  sender: string,
  /** The caller's workspace: only its customers can match. Omitted, every workspace's can (a system inbox). */
  orgId?: string | null,
): Promise<CustomerMatch> {
  const raw = (sender ?? "").trim().toLowerCase();
  // Accept a raw address or a "Name <addr>" header form.
  const bare = (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim();
  const at = bare.lastIndexOf("@");
  if (at <= 0 || at === bare.length - 1) return { matched: false };
  const domain = bare.slice(at + 1);

  const db = getDb();
  if (db) {
    const run = <T>(fn: (tx: Db) => Promise<T[]>): Promise<T[]> => (orgId ? withOrgDb(orgId, fn) : acrossOrgDbs(fn));
    const [byContact] = await run((tx) =>
      tx
        .select({ id: customersTable.customerId, name: customersTable.customerName, fdeOwner: customersTable.fdeOwner })
        .from(customersTable)
        .where(
          or(
            ilike(customersTable.businessOwnerEmail, bare),
            ilike(customersTable.technicalOwnerEmail, bare),
            ilike(customersTable.executiveSponsorEmail, bare),
          ),
        )
        .limit(1),
    );
    if (byContact) {
      return { matched: true, customerId: byContact.id, customerName: byContact.name, fdeOwner: byContact.fdeOwner ?? undefined, matchedOn: "contact" };
    }
    if (!FREEMAIL_DOMAINS.has(domain)) {
      const [byDomain] = await run((tx) =>
        tx
          .select({ id: customersTable.customerId, name: customersTable.customerName, fdeOwner: customersTable.fdeOwner })
          .from(customersTable)
          .where(ilike(customersTable.companyDomain, domain))
          .limit(1),
      );
      if (byDomain) {
        return { matched: true, customerId: byDomain.id, customerName: byDomain.name, fdeOwner: byDomain.fdeOwner ?? undefined, matchedOn: "domain" };
      }
    }
    return { matched: false };
  }

  const { customers } = await readStore();
  const hit = customers.find(
    (c) =>
      [c.businessOwnerEmail, c.technicalOwnerEmail, c.executiveSponsorEmail].some(
        (e) => e?.toLowerCase() === bare,
      ) ||
      (!FREEMAIL_DOMAINS.has(domain) && c.companyDomain?.toLowerCase() === domain),
  );
  return hit
    ? { matched: true, customerId: hit.id, customerName: hit.name, fdeOwner: hit.fdeOwner, matchedOn: "contact" }
    : { matched: false };
}

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
import { sampleCustomerStore } from "./sample-data.ts";
import {
  customerPatchSchema,
  customerReadSchema,
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
 * written: the account's own (`custom`, account_fields.custom_fields) and each area row's. A patch REPLACES
 * `deployments[]` and `implementation` wholesale and merges over the account, but `custom` follows the rule every
 * write path shares: a record that already exists keeps the custom values the patch does not mention, a new one
 * must carry the required ones, an undeclared key is refused. Throws the plain sentences; the model reads them.
 */
export function applyCustomFields(
  patch: CustomerPatch,
  existing: Customer | null,
  /** The declared fields per record; this build's profile unless a test passes another's (a missing one = none). */
  declared?: Partial<Record<CustomFieldArea, CustomFieldSpec[]>>,
): CustomerPatch {
  return applyCustomFieldsWithDelta(patch, existing, declared).patch;
}

/**
 * applyCustomFields, plus what the patch CHANGES in the account's `custom` (`accountDelta`, undefined when it
 * names none of it), which writeCustomerToPostgres merges in SQL at write time rather than writing back the whole
 * column read earlier. `custom_append` (long-text additions, the model's way to add to a long note without
 * resending it) is resolved here: into the returned patch's `custom` (what the record reads after the write)
 * and into the delta's `append`, and is never part of the stored record. A model rewriting a long_text value
 * whole may not cut it below half its length (validateCustom's shrinkGuard): it appends, or clears first.
 */
export function applyCustomFieldsWithDelta(
  patch: CustomerPatch,
  existing: Customer | null,
  declared: Partial<Record<CustomFieldArea, CustomFieldSpec[]>> = { account: customFieldsOf("account"), deployments: customFieldsOf("deployments"), implementations: customFieldsOf("implementations") },
): { patch: CustomerPatch; accountDelta?: CustomDelta } {
  const errors: string[] = [];
  let accountDelta: CustomDelta | undefined;
  const check = (area: CustomFieldArea, what: string, custom: unknown, prev: { custom?: unknown } | undefined, append?: unknown) => {
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
    }
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
      const custom = check("deployments", d.deploymentId, d.custom, existing?.deployments?.find((p) => p.deploymentId === d.deploymentId));
      return custom === undefined ? d : { ...d, custom };
    });
  }
  if (patch.implementation) {
    const custom = check("implementations", patch.implementation.rolloutId ?? patch.id, patch.implementation.custom, existing?.implementation);
    if (custom !== undefined) out.implementation = { ...patch.implementation, custom };
  }
  if (errors.length) throw new Error(`Custom fields were not accepted, so nothing was written. ${errors.join(" ")}`);
  return { patch: out, accountDelta };
}

/** An account whose own values were all cleared has no `custom`, as one that never had any (customers.custom is NULL). */
function withoutEmptyCustom(customer: Customer): Customer {
  if (customer.custom && Object.keys(customer.custom).length === 0) {
    const { custom: _empty, ...rest } = customer;
    return rest;
  }
  return customer;
}

export async function upsertCustomer(
  patch: CustomerPatch,
  orgId?: string | null,
): Promise<Customer> {
  const parsedPatch = customerPatchSchema.parse(patch);
  const db = getDb();
  if (db) {
    // The record being patched is read in the CALLER's workspace. Read across all of them, another workspace's
    // record was merged into this patch and written under the caller's scope; the database refused the write,
    // and the refusal text carried every merged value back to the model.
    const existing = await dbGetCustomer(db, parsedPatch.id, orgId);
    const validPatch = applyCustomFields(parsedPatch, existing);
    const merged = withoutEmptyCustom(existing
      ? customerSchema.parse({ ...existing, ...validPatch })
      : customerSchema.parse({ name: validPatch.id, ...validPatch }));
    // Only what the patch changed in `custom`, merged in SQL: never the whole column as read above.
    const { accountDelta } = applyCustomFieldsWithDelta(parsedPatch, existing);
    await writeCustomerToPostgres(db, merged, orgId, { accountCustom: accountDelta });
    return merged;
  }
  const store = await readStore();
  const idx = store.customers.findIndex((c) => c.id === parsedPatch.id);
  const validPatch = applyCustomFields(parsedPatch, idx === -1 ? null : store.customers[idx]);
  if (idx === -1) {
    const created = withoutEmptyCustom(customerSchema.parse({ name: validPatch.id, ...validPatch }));
    store.customers.push(created);
    await writeStore(store);
    return created;
  }
  const merged = withoutEmptyCustom(customerSchema.parse({ ...store.customers[idx], ...validPatch }));
  store.customers[idx] = merged;
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

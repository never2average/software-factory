import { NextRequest, NextResponse } from "next/server";
import { asc, eq, sql } from "drizzle-orm";
import {
  customerStakeholders,
  customers,
  deployments,
  implementation,
  interactions,
  internalStaff,
  platform,
  solutions,
  tickets,
} from "@/agent/lib/db/schema";
import { getOpsDb, withOrgRls, type Db } from "@/lib/ops-db";
import { orgContextForRequest } from "@/lib/org-context";
import { isEmptyStore } from "@/lib/pg-error";
import { sampleCustomerStore, samplePeople } from "@/agent/lib/sample-data";
import { W } from "@/lib/ui-words";
import {
  TRUNCATED_MARK,
  WORKBOOK_ORDER,
  WORKBOOK_ROW_CAP,
  cutText,
  dateSortKeySql,
  listedOwnFields,
  workbookHidden,
  type WorkbookTable,
  type WorkbookTableInfo,
} from "@/lib/workbook-fields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ops/workbook — the workspace's OWN records, as the data room's Master.xlsx previews show them.
 *
 * The previews used to be built in the browser from the bundled data/customers.json and data/people.json, so every
 * workspace showed the same two invented accounts (factory task mold_v1-120). They are built from this answer now:
 * the caller's workspace, each table read inside its row-level-security scope, and nothing else.
 *
 * Shape: { customers: [{ id, name, ...scalar, platform?, deployments[], solutions[], implementation?, tickets[],
 *          interactions[] }], people: { internalStaffAssignments[], customerStakeholders[] },
 *          tables: { <table>: { rows, truncated, cap } }, unavailable: <table>[] }
 *
 * What it sends is what the data room may SHOW (review of PR #62; scripts/test-workbook-route-db.mjs):
 *   - no field the profile hides (lib/workbook-fields.ts: account_fields.hidden, the areas' hidden fields); a hidden
 *     nested part (platform, solutions, tickets) is not read at all;
 *   - of the profile's own fields (`custom`), only those it lists (show_in_list), as /api/ops/customers sends them.
 *     A 2 MB note used to go out on every open;
 *   - text cut to a preview (TEXT_PREVIEW_CHARS), marked in the text and named in the row's `_truncated`;
 *   - at most WORKBOOK_ROW_CAP rows per table, the MOST RECENT first where a table has a date (read as the date the
 *     free text says, lib/workbook-fields.ts dateSortKeySql, not as a string), else by name or id; `truncated` said
 *     when there were more, and `order` saying which of those the kept rows are.
 *
 * One table is one table. Each is read on its own: one that cannot be read (missing, refused, failed) is named in
 * `unavailable` and the rest are served. It used to be one read, where any failure answered the WHOLE workspace as
 * empty and the data room said "No companies yet" over real records. Only a store with no tables at all (before the
 * first migration) is empty; accounts that cannot be read are a 503, never an empty workspace.
 *
 * With no database this answers the no-database fallback's records: none, unless the server runs a local demo with
 * DEMO_SAMPLE_DATA=1 (agent/lib/sample-data.ts). Never cached: it is one workspace's data (Cache-Control: private,
 * no-store).
 */

type Row = Record<string, unknown>;
const NO_STORE = { "Cache-Control": "private, no-store" };

/** A text value as a preview: cut on whole characters (never inside an emoji), and the cut said. */
function preview(value: unknown, key: string, cut: string[]): unknown {
  if (typeof value !== "string") return value;
  const short = cutText(value);
  if (short === null) return value;
  cut.push(key);
  return short + TRUNCATED_MARK;
}

/**
 * A stored row as the previews read it: no workspace id or foreign key, no NULLs, no hidden field, only the listed own
 * fields, long text cut. `listed` is the own-field keys this row's area lists.
 */
function clean(row: Row, hidden: ReadonlySet<string>, listed: ReadonlySet<string>, drop: string[] = ["orgId", "customerId"]): Row {
  const out: Row = {};
  const cut: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (drop.includes(k) || hidden.has(k) || v === null || v === undefined) continue;
    if (k === "custom") {
      const own = Object.fromEntries(
        Object.entries((v ?? {}) as Row)
          .filter(([ck, cv]) => listed.has(ck) && cv !== null && cv !== undefined)
          .map(([ck, cv]) => [ck, preview(cv, `custom.${ck}`, cut)]),
      );
      if (Object.keys(own).length) out.custom = own;
      continue;
    }
    out[k] = preview(v instanceof Date ? v.toISOString() : v, k, cut);
  }
  if (cut.length) out._truncated = cut;
  return out;
}

type Read = { ok: true; rows: Row[]; info: WorkbookTableInfo } | { ok: false; missing: boolean };

/** One table, in its own scope and transaction: its failure is its own. One row past the cap says there were more. */
async function readTable(orgId: string, table: WorkbookTable, query: (tx: Db) => Promise<Row[]>): Promise<Read> {
  try {
    const rows = await withOrgRls(orgId, query);
    const truncated = rows.length > WORKBOOK_ROW_CAP;
    const kept = truncated ? rows.slice(0, WORKBOOK_ROW_CAP) : rows;
    return { ok: true, rows: kept, info: { rows: kept.length, truncated, cap: WORKBOOK_ROW_CAP, order: WORKBOOK_ORDER[table] } };
  } catch (e) {
    const missing = isEmptyStore(e);
    if (!missing) console.error(`workbook GET: ${table} could not be read`, e);
    return { ok: false, missing };
  }
}

export async function GET(request: NextRequest) {
  const ctx = await orgContextForRequest(request);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  const hidden = workbookHidden();
  const listed = {
    account: new Set(listedOwnFields("account").map((f) => f.key)),
    deployments: new Set(listedOwnFields("deployments").map((f) => f.key)),
    implementation: new Set(listedOwnFields("implementations").map((f) => f.key)),
  };
  const NONE = new Set<string>();
  const db = getOpsDb();
  if (!db) {
    // No database: the fallback's records. Empty on every deployment; the sample only in a local demo. Trimmed the
    // same way, so a demo shows what a real workspace would.
    const people = samplePeople();
    const demo = (sampleCustomerStore().customers as Row[]).map((c) => ({
      ...clean(c, new Set([...hidden.account, ...hidden.tables]), listed.account, ["orgId"]),
      deployments: ((c.deployments as Row[]) ?? []).map((d) => clean(d, hidden.deployments, listed.deployments)),
      implementation: c.implementation ? clean(c.implementation as Row, hidden.implementation, listed.implementation) : undefined,
    }));
    return NextResponse.json({ customers: demo, people, tables: {}, unavailable: [] }, { headers: NO_STORE });
  }

  const org = ctx.orgId;
  const cap = WORKBOOK_ROW_CAP + 1;
  // A nested part the profile hides is not read at all.
  const skip = async (): Promise<Read> => ({ ok: true, rows: [], info: { rows: 0, truncated: false, cap: WORKBOOK_ROW_CAP, order: "id" } });
  const attempted = (t: WorkbookTable) => !hidden.tables.has(t);
  // Most useful first, deterministically: the most recent activity where a table has a date, then a stable id.
  // The date columns are free text: ordered by the date the text says (NULL when it says none), then as written.
  const newest = (column: string) => sql.raw(`${dateSortKeySql(column)} desc nulls last, ${column} desc nulls last`);
  const reads: Record<WorkbookTable, Promise<Read>> = {
    customers: readTable(org, "customers", (tx) =>
      tx.select().from(customers).where(eq(customers.orgId, org)).orderBy(asc(customers.customerName), asc(customers.customerId)).limit(cap)),
    platform: hidden.tables.has("platform") ? skip() : readTable(org, "platform", (tx) =>
      tx.select().from(platform).where(eq(platform.orgId, org)).orderBy(asc(platform.customerId)).limit(cap)),
    deployments: readTable(org, "deployments", (tx) =>
      tx.select().from(deployments).where(eq(deployments.orgId, org))
        .orderBy(newest(`"deployments"."last_deploy_at"`), asc(deployments.deploymentId)).limit(cap)),
    solutions: hidden.tables.has("solutions") ? skip() : readTable(org, "solutions", (tx) =>
      tx.select().from(solutions).where(eq(solutions.orgId, org))
        .orderBy(newest(`"solutions"."last_reviewed_date"`), asc(solutions.solutionId)).limit(cap)),
    implementation: readTable(org, "implementation", (tx) =>
      tx.select().from(implementation).where(eq(implementation.orgId, org)).orderBy(asc(implementation.customerId)).limit(cap)),
    tickets: hidden.tables.has("tickets") ? skip() : readTable(org, "tickets", (tx) =>
      tx.select().from(tickets).where(eq(tickets.orgId, org)).orderBy(newest(`"tickets"."last_activity_date"`), asc(tickets.ticketId)).limit(cap)),
    interactions: readTable(org, "interactions", (tx) =>
      tx.select().from(interactions).where(eq(interactions.orgId, org))
        .orderBy(newest(`"interactions"."interaction_at"`), asc(interactions.interactionId)).limit(cap)),
    internal_staff: readTable(org, "internal_staff", (tx) =>
      tx.select().from(internalStaff).where(eq(internalStaff.orgId, org))
        .orderBy(newest(`"internal_staff"."last_contact"`), asc(internalStaff.name)).limit(cap)),
    customer_stakeholders: readTable(org, "customer_stakeholders", (tx) =>
      tx.select().from(customerStakeholders).where(eq(customerStakeholders.orgId, org))
        .orderBy(newest(`"customer_stakeholders"."last_contact"`), asc(customerStakeholders.name)).limit(cap)),
  };
  const entries = await Promise.all((Object.entries(reads) as [WorkbookTable, Promise<Read>][]).map(async ([t, p]) => [t, await p] as const));
  const read = Object.fromEntries(entries) as Record<WorkbookTable, Read>;

  const failed = entries.filter(([, r]) => !r.ok) as [WorkbookTable, { ok: false; missing: boolean }][];
  // Before the first migration there are no tables at all: that, and only that, is an empty workspace.
  if (failed.length === entries.filter(([t]) => attempted(t)).length && failed.every(([, r]) => r.missing)) {
    return NextResponse.json(
      { customers: [], people: { internalStaffAssignments: [], customerStakeholders: [] }, tables: {}, unavailable: [] },
      { headers: NO_STORE },
    );
  }
  // Without the accounts nothing else can be placed: said as a failure, never as a workspace with none.
  if (!read.customers.ok) {
    return NextResponse.json({ error: `${W.Account} records are unavailable right now.` }, { status: 503, headers: NO_STORE });
  }

  const rowsOf = (t: WorkbookTable) => (read[t].ok ? (read[t] as { rows: Row[] }).rows : []);
  const byCustomer = (t: WorkbookTable, hiddenKeys: ReadonlySet<string>, listedKeys: ReadonlySet<string>) => {
    const by = new Map<string, Row[]>();
    for (const r of rowsOf(t)) {
      const id = String(r.customerId ?? "");
      const list = by.get(id) ?? [];
      list.push(clean(r, hiddenKeys, listedKeys));
      by.set(id, list);
    }
    return by;
  };
  const platformBy = byCustomer("platform", NONE, NONE);
  const implBy = byCustomer("implementation", hidden.implementation, listed.implementation);
  const depsBy = byCustomer("deployments", hidden.deployments, listed.deployments);
  const solsBy = byCustomer("solutions", NONE, NONE);
  const tixBy = byCustomer("tickets", NONE, NONE);
  const intsBy = byCustomer("interactions", NONE, NONE);

  const out = rowsOf("customers").map((c) => {
    const id = String(c.customerId);
    const { customerId: _id, customerName, ...rest } = c;
    return {
      id,
      name: customerName ?? id,
      ...clean(rest, hidden.account, listed.account),
      ...(hidden.tables.has("platform") ? {} : { platform: platformBy.get(id)?.[0] }),
      implementation: implBy.get(id)?.[0],
      deployments: depsBy.get(id) ?? [],
      ...(hidden.tables.has("solutions") ? {} : { solutions: solsBy.get(id) ?? [] }),
      ...(hidden.tables.has("tickets") ? {} : { tickets: tixBy.get(id) ?? [] }),
      interactions: intsBy.get(id) ?? [],
    };
  });
  // People rows keep their customer_id: it is a column of both People sheets.
  const person = (r: Row) => {
    const { customerId, ...rest } = r;
    return { customer_id: customerId, ...clean(rest, NONE, NONE) };
  };
  const tables = Object.fromEntries(
    entries.filter(([t, r]) => r.ok && !hidden.tables.has(t)).map(([t, r]) => [t, (r as { info: WorkbookTableInfo }).info]),
  );
  return NextResponse.json(
    {
      customers: out,
      people: {
        internalStaffAssignments: rowsOf("internal_staff").map(person),
        customerStakeholders: rowsOf("customer_stakeholders").map(person),
      },
      tables,
      unavailable: failed.map(([t]) => t),
    },
    { headers: NO_STORE },
  );
}

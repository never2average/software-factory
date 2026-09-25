/**
 * WHAT THE DATA ROOM'S MASTER.XLSX PREVIEWS MAY SHOW, in this deployment's profile. Shared by the route that serves
 * the records (app/api/ops/workbook) and the data room that renders them (app/_components/dataroom.tsx), so a field
 * the profile hides is dropped twice: never sent, and never a column even if an answer carries it.
 *
 *   - HIDDEN: `account_fields.hidden` (the account's own scalars: arr, seats, aeOwner, renewal*, …, and the nested
 *     parts `platform`, `solutions`, `tickets`, whose sheets then do not show) and `domains.<area>.fields.<key>.hidden`
 *     for the two redefinable areas. A hidden field with a `fixed` value is hidden here too: the forms never show it,
 *     and a column of one repeated value says nothing.
 *   - LISTED OWN FIELDS: the profile's custom fields marked `show_in_list`, per area. Only those are sent (as
 *     /api/ops/customers sends them) and they show as columns in the profile's labels. A long note is not for a grid.
 *   - CAPS: rows per table, and characters per text cell, with the cut said rather than silent.
 *
 * Pure: plain data from the generated profile, safe on the client and the server (and importable by node scripts).
 */
import { DEPLOYMENT_PROFILE, type CustomFieldSpec } from "./deployment-profile.generated.ts";

/** The tables a workbook is read from, one answer each. */
export const WORKBOOK_TABLES = [
  "customers",
  "platform",
  "deployments",
  "solutions",
  "implementation",
  "tickets",
  "interactions",
  "internal_staff",
  "customer_stakeholders",
] as const;
export type WorkbookTable = (typeof WORKBOOK_TABLES)[number];

/** Rows per table in one answer. Past it the answer says `truncated`, and keeps the most recent rows. */
export const WORKBOOK_ROW_CAP = 5000;
/** Characters per text value in one answer. Longer text is cut to this, marked, and named in the row's `_truncated`. */
export const TEXT_PREVIEW_CHARS = 500;
export const TRUNCATED_MARK = "… [cut: open the record for the full text]";

/** One table's part of an answer. */
export interface WorkbookTableInfo {
  rows: number;
  truncated: boolean;
  cap: number;
}

type ProfileFields = Pick<typeof DEPLOYMENT_PROFILE, "account_fields" | "domains">;
type OwnFieldArea = "account" | "deployments" | "implementations";

export interface WorkbookHidden {
  /** Account keys (camelCase) the profile hides. */
  account: ReadonlySet<string>;
  deployments: ReadonlySet<string>;
  implementation: ReadonlySet<string>;
  /** Tables whose whole sheet is hidden: the account's nested parts the profile hides. */
  tables: ReadonlySet<WorkbookTable>;
}

const NESTED_TABLES: Record<string, WorkbookTable> = { platform: "platform", solutions: "solutions", tickets: "tickets" };

export function workbookHidden(profile: ProfileFields = DEPLOYMENT_PROFILE): WorkbookHidden {
  const area = (fields: Record<string, { hidden?: boolean }> | undefined) =>
    new Set(Object.entries(fields ?? {}).filter(([, f]) => f?.hidden).map(([k]) => k));
  const accountHidden = (profile.account_fields?.hidden ?? []).filter((k) => k !== "id" && k !== "name");
  return {
    account: new Set(accountHidden.filter((k) => !(k in NESTED_TABLES))),
    deployments: area(profile.domains.deployments?.fields),
    implementation: area(profile.domains.implementations?.fields),
    tables: new Set(accountHidden.filter((k) => k in NESTED_TABLES).map((k) => NESTED_TABLES[k])),
  };
}

/** The own fields an area's list shows (`show_in_list`), in the profile's order. */
export function listedOwnFields(area: OwnFieldArea, profile: ProfileFields = DEPLOYMENT_PROFILE): CustomFieldSpec[] {
  const all = (area === "account" ? profile.account_fields?.custom_fields : profile.domains[area]?.custom_fields) ?? [];
  return all.filter((f) => f.show_in_list);
}

/** A field key and a sheet column compared as the same name: `renewalDate` ~ `renewal_date`, `uptime30dPct` ~ `uptime_30d_pct`. */
export const sameKey = (a: string, b: string): boolean =>
  a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");

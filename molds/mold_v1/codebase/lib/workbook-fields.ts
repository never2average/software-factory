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
 *   - COLUMN HEADERS: a sheet's column keys in the profile's words (sheetColumnKey).
 *
 * Pure: plain data from the generated profile, safe on the client and the server (and importable by node scripts).
 */
import { DEPLOYMENT_PROFILE, DOMAIN_FIELDS, type CustomFieldSpec } from "./deployment-profile.generated.ts";
import { speakIdentifier, VOCABULARY_RELABELLED } from "../agent/lib/agent-vocabulary.ts";
import { speakKey } from "./ui-keys.ts";

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

/** Rows per table in one answer. Past it the answer says `truncated`, and keeps the first rows in the table's order. */
export const WORKBOOK_ROW_CAP = 5000;
/** Characters per text value in one answer. Longer text is cut to this, marked, and named in the row's `_truncated`. */
export const TEXT_PREVIEW_CHARS = 500;
export const TRUNCATED_MARK = "… [cut: open the record for the full text]";

/**
 * The order a table's rows are read in, so the cap keeps the most useful ones and the sheet can say which. Tables
 * with a date keep the most recent; the rest go by name or id, and the cap banner must not call that "most recent".
 */
export type WorkbookOrder = "recent" | "name" | "id";
export const WORKBOOK_ORDER: Record<WorkbookTable, WorkbookOrder> = {
  customers: "name",
  platform: "id",
  deployments: "recent",
  solutions: "recent",
  implementation: "id",
  tickets: "recent",
  interactions: "recent",
  internal_staff: "recent",
  customer_stakeholders: "recent",
};

/** How a sheet's cap banner says the order it kept rows in. */
export function orderPhrase(order: WorkbookOrder | undefined): string {
  return order === "recent" ? "most recent first" : order === "name" ? "in name order" : "in id order";
}

/** One table's part of an answer. */
export interface WorkbookTableInfo {
  rows: number;
  truncated: boolean;
  cap: number;
  /** The order the kept rows were chosen in (absent in an answer from before it was sent: said as id order). */
  order?: WorkbookOrder;
}

/** The most code units a cut preview may carry, whatever its characters (see cutText). */
export const CUT_CODE_UNIT_CEILING = TEXT_PREVIEW_CHARS * 8;

const graphemes = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/**
 * `text` cut to at most `max` characters as a person counts them (grapheme clusters: an emoji, a flag, an accented
 * letter written as two code points, a family emoji of seven), or null when it fits. It used to be sliced on UTF-16
 * code units, which split a surrogate pair into a lone half (rendered as a replacement box) or a family emoji into
 * its members.
 */
export function cutText(text: string, max: number = TEXT_PREVIEW_CHARS): string | null {
  // Never more characters than code units: short text needs no segmenting.
  if (text.length <= max) return null;
  let out: string | null = null;
  if (!graphemes) {
    // No segmenter (very old runtimes): at least never split a surrogate pair.
    out = text.slice(0, /[\uD800-\uDBFF]/.test(text[max - 1] ?? "") ? max - 1 : max);
  } else {
    let count = 0;
    for (const { index } of graphemes.segment(text)) {
      if (count === max) {
        out = text.slice(0, index);
        break;
      }
      count++;
    }
  }
  // The backstop (review of #76): one grapheme has no length limit (a letter with two million combining marks is one
  // character), so a preview is also held to a code-unit ceiling, cut where it splits no surrogate pair.
  const kept = out ?? text;
  if (kept.length <= CUT_CODE_UNIT_CEILING) return out;
  const end = /[\uD800-\uDBFF]/.test(kept[CUT_CODE_UNIT_CEILING - 1] ?? "") ? CUT_CODE_UNIT_CEILING - 1 : CUT_CODE_UNIT_CEILING;
  return kept.slice(0, end);
}

/**
 * A SQL expression that orders a FREE-TEXT date column by the date it says, newest highest: a bigint
 * YYYYMMDDhhmmss, or NULL for text that is not a date in a form people write (sorted after every date, NULLS LAST).
 *
 * The date columns are text (`last_deploy_at`, `interaction_at`, `last_contact`, …), filled by people, the agent
 * and imports, so "2026-09-29", "29 Sep 2026", "Sep 29, 2026" and "29/09/2026" all occur. Ordered as strings,
 * "29/09/2026" sorted below "2026-01-01" and "01 Oct 2026" below all of them, so past WORKBOOK_ROW_CAP the NEWEST
 * rows were the ones dropped. Read here, in SQL, so the cap keeps the right rows:
 *
 *   2026-09-29 · 2026/9/29 · 2026-09-29T10:00:00Z · 2026-09-29 10:00   year first, time kept (zone ignored)
 *   29/09/2026 · 29-09-2026 · 29.09.2026                              day first, unless the day cannot be (09/29/2026)
 *   29 Sep 2026 · 29th September, 2026 · 29-Sep-2026                  day, month name, year
 *   Sep 29, 2026 · September 29th 2026                                month name, day, year
 *   Sep 2026 · 2026-09 · 2026                                         a month or a year: before its days
 *
 * Every piece is digits a regular expression already matched, so nothing here can raise an error for any text (a
 * cast to date would, on "2026-02-31", and one bad row would fail the whole read). `column` is SQL for a column of
 * the query, written by the caller; never user input.
  *
 * PERFORMANCE (follow-up, review of #76): the key is computed per row at read time, so ordering is a full scan with a
 * sort, measured at 413 ms for 6k rows and 3.2 s for 50k. The fix when a workspace gets there is an expression index
 * on this key, or a sort key stored on write.
 */
export function dateSortKeySql(column: string): string {
  const x = `btrim(${column})`;
  const month = (name: string) => `(case when strpos('janfebmaraprmayjunjulaugsepoctnovdec', lower(left(${name}, 3))) % 3 = 1 then (strpos('janfebmaraprmayjunjulaugsepoctnovdec', lower(left(${name}, 3))) + 2) / 3 end)`;
  // A date only when it is one: month 1-12 and day 1-31 (0 only for a month or a year written without them), and a
  // time on the clock. Anything else is NULL, sorted after every date, so garbage ("99/99/2026", "2026-13-45") never
  // takes the cap's slots from real rows (review of #76).
  const between = (v: string, lo: number, hi: number) => (v === "0" ? "true" : `(${v}) between ${lo} and ${hi}`);
  const key = (y: string, m: string, d: string, time: [string, string, string] = ["0", "0", "0"]) =>
    `(case when ${between(m, 1, 12)} and ${between(d, 1, 31)} and ${between(time[0], 0, 23)} and ${between(time[1], 0, 59)} and ${between(time[2], 0, 59)} ` +
    `then (${y})::bigint * 10000000000 + (${m})::bigint * 100000000 + (${d})::bigint * 1000000 + (${time[0]}) * 10000 + (${time[1]}) * 100 + (${time[2]}) end)`;
  const n = (i: number) => `(a[${i}])::bigint`;
  const on = (pattern: string, body: string) => `when ${x} ~* '${pattern}' then (select ${body} from (select regexp_match(${x}, '${pattern}', 'i') as a) as m)`;
  return `(case
    ${on("^(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})(?:[T ]+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?", key(n(1), n(2), n(3), [`coalesce(${n(4)}, 0)`, `coalesce(${n(5)}, 0)`, `coalesce(${n(6)}, 0)`]))}
    ${on("^(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{4})", key(n(3), `case when ${n(1)} > 12 then ${n(2)} when ${n(2)} > 12 then ${n(1)} else ${n(2)} end`, `case when ${n(1)} > 12 then ${n(1)} when ${n(2)} > 12 then ${n(2)} else ${n(1)} end`))}
    ${on("^(\\d{1,2})(?:st|nd|rd|th)?[ ,-]+([a-z]{3,})\\.?,?[ ,-]+(\\d{4})", key(n(3), month("a[2]"), n(1)))}
    ${on("^([a-z]{3,})\\.?[ -]+(\\d{1,2})(?:st|nd|rd|th)?,?[ -]+(\\d{4})", key(n(3), month("a[1]"), n(2)))}
    ${on("^([a-z]{3,})\\.?,?[ -]+(\\d{4})$", key(n(2), month("a[1]"), "0"))}
    ${on("^(\\d{4})[-/](\\d{1,2})$", key(n(1), n(2), "0"))}
    ${on("^(\\d{4})$", key(n(1), "0", "0"))}
  end)`;
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
  const named = (profile.account_fields?.hidden ?? []).filter((k) => k !== "id" && k !== "name");
  // The owner is one field under two keys (drizzle/0028_neutral_owner_columns.sql): hiding either hides both.
  const OWNER_KEYS = ["fdeOwner", "accountOwner"];
  const accountHidden = named.some((k) => OWNER_KEYS.includes(k)) ? [...new Set([...named, ...OWNER_KEYS])] : named;
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

/** The sheets that hold a record area's own rows. */
const SHEET_AREA: Partial<Record<string, "deployments" | "implementations">> = { Deployments: "deployments", Implementation: "implementations" };

/**
 * A sheet's column key as a person reads it: lib/ui-keys.ts speakKey, plus the one case it leaves alone on purpose.
 *
 * speakKey keeps a key such as `deployment_strategy` or `deployment_model` as written, because across the product
 * "deployment" in those keys describes software deployment, not the record area. On the record area's OWN sheet it
 * is a field of that record, and under a relabel (Deployments -> Coverage reports) the header read
 * `deployment_strategy` whenever a workspace had rows (review of #62). There it is named as the model is given it
 * (`coverage_report_strategy`), so a person and the agent call the column the same thing. Every other sheet, and the
 * default profile, reads exactly as before.
 */
export function sheetColumnKey(sheet: string, column: string): string {
  const spoken = speakKey(column);
  const area = SHEET_AREA[sheet];
  if (!VOCABULARY_RELABELLED || !area || spoken !== column) return spoken;
  return Object.keys(DOMAIN_FIELDS[area]).some((k) => sameKey(k, column)) ? speakIdentifier(column) : spoken;
}

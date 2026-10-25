/**
 * A record area's records as CSV (mold_v0-108): the generated MCP tool `<prefix>_export_<area>` (src/mcp-catalog.ts,
 * src/mcp-tools.ts) and the same file the console's Export CSV writes on an area tab and an area's records page
 * (web/src/features/tabs/export.ts, which reads the console's own record routes).
 *
 * Read through the data API's workspace door (src/data-api.ts dataApi.list: the caller's workspace from its session or
 * key, never from input; the area's read roles for the caller's role; a shared area's rows as every workspace reads
 * them; a sealed area opened for the workspace that owns it), so an export holds exactly what list_<area> would page
 * through, and nothing of another workspace.
 *
 * The file: a header row (Key, Title, each field's label in the area's order, Updated), then a row per record. A cell
 * is the stored value: a list's items joined with "; ", a file its path, json as JSON text. A text cell that a
 * spreadsheet would read as a formula (it starts with =, +, -, @, a tab or a carriage return) is written with a leading
 * apostrophe. RFC 4180 quoting, CRLF line ends, no byte-order mark (the MCP answer is text).
 */
import type { RecordQuery, RecordRow } from "./pack-api.js";
import { PackError } from "./pack-api.js";
import { dataApi, type DataCaller } from "./data-api.js";
import { areaOrThrow } from "./record-areas.js";

/** At most this many records, and about this much CSV, per call; the rest by `next`. */
export const EXPORT_MAX_ROWS = 5000;
export const EXPORT_MAX_BYTES = 1024 * 1024;
const PAGE = 200;

type Field = { name: string; label: string; type: string };

/** A value as a CSV cell (before quoting). */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(cellText).filter((x) => x !== "").join("; ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return typeof o.path === "string" ? o.path : JSON.stringify(v);
  }
  return String(v);
}
/** One cell, quoted when it must be; text a spreadsheet would run as a formula is defused with an apostrophe. */
export function csvCell(v: unknown): string {
  let s = cellText(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (cells: unknown[]) => `${cells.map(csvCell).join(",")}\r\n`;

/** The header row of an area's export, and a record's row. */
export const exportHeader = (fields: readonly Field[]) => csvLine(["Key", "Title", ...fields.map((f) => f.label), "Updated"]);
export const exportRow = (fields: readonly Field[], r: Pick<RecordRow, "key" | "title" | "data" | "updated_at">) =>
  csvLine([r.key, r.title ?? "", ...fields.map((f) => r.data?.[f.name]), r.updated_at]);

/**
 * One export call: the records of `area` the caller may read, filtered and sorted as list_<area>, from `after`, up to
 * EXPORT_MAX_ROWS records and EXPORT_MAX_BYTES of CSV. -> the CSV, how many records it holds and `next` (null: all).
 */
export async function exportArea(caller: DataCaller, area: string, q: Pick<RecordQuery, "filter" | "sort" | "after"> = {},
  limits: { rows: number; bytes: number } = { rows: EXPORT_MAX_ROWS, bytes: EXPORT_MAX_BYTES }) {
  const a = areaOrThrow(area);
  const fields = a.fields as Field[];
  const header = exportHeader(fields);
  let csv = header, bytes = Buffer.byteLength(header), count = 0;
  let after = q.after, next: string | null = null;
  for (;;) {
    const room = limits.rows - count;
    if (room <= 0) { next = after ?? null; break; }
    const query = { filter: q.filter, sort: q.sort, ...(after ? { after } : {}) };
    const page = await dataApi.list(caller, a.name, { ...query, limit: Math.min(PAGE, room) });
    const lines = page.records.map((r) => exportRow(fields, r));
    let fit = 0, add = 0;
    for (const l of lines) { const b = Buffer.byteLength(l); if (bytes + add + b > limits.bytes) break; add += b; fit++; }
    if (fit < lines.length) {
      // The page does not fit whole: read just the records that do, so `next` is the cursor after the last of them.
      if (fit === 0 && count === 0) throw new PackError(`one record of ${a.name} is larger than an export may hold (${limits.bytes} bytes)`, 413);
      if (fit > 0) {
        const part = await dataApi.list(caller, a.name, { ...query, limit: fit });
        for (const r of part.records) csv += exportRow(fields, r);
        count += part.records.length;
        next = part.next;
      } else next = after ?? null;
      break;
    }
    csv += lines.join(""); bytes += add; count += lines.length;
    if (!page.next) { next = null; break; }
    after = page.next;
  }
  return { area: a.name, format: "csv" as const, records: count, next, csv };
}

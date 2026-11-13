'use client';
// Export CSV (mold_v0-108): an area tab's records (one area, or a merged tab's rows) and an area's records page, as one
// CSV file. It pages through the same read-only routes the page shows (/api/records: this workspace's rows and the
// shared ones, as the person's role may read them; /api/admin/records for staff), so the file holds what the person
// could page through and nothing else. The file is the generated MCP tool's (src/record-export.ts export_<area>): a
// header (Key, Title, each field's label, Updated), a row per record, lists joined with "; ", a file by its path, json as
// JSON text, and text a spreadsheet would run as a formula defused with a leading apostrophe. mold_v0-217: a list's
// Export (its search row, just left of the primary action) writes the view: when search or a filter narrows the list,
// the file holds those rows alone (the same pages are read, so the data trail records the export as before).
// mold_v0-235: on a workspace's list Export shows only to the roles that may export (an area's contract may narrow it
// below read; the server refuses the rest). mold_v0-294: Export is an item of the list's Actions ▾ menu, beside
// Import (features/records/workspace-import.tsx useImportAction) and Ask AI.
import { useState } from 'react';
import { toast } from 'sonner';
import type { RowAction } from '@/components/layout/record-filters';
import { Icons } from '@/components/icons';
import { exportWithheldAreas, recordAreas, type RecordAreaSpec } from '@/config/pack-nav.generated';
import { useAccountRole } from '@/features/portal/role';
import { downloadText, today } from '@/lib/csv';

type Row = { key: string; title: string | null; data: Record<string, unknown>; updated_at: string };
type Page = { records: Row[]; next: string | null };

/** At most this many records in one file (the page says so when there were more). */
export const EXPORT_MAX = 10000;

const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(cellText).filter((x) => x !== '').join('; ');
  // A stored file (mold_v0-220): its name only.
  if (typeof v === 'object') { const o = v as Record<string, unknown>; return typeof o.path === 'string' ? o.path : typeof o.object === 'string' && typeof o.name === 'string' ? o.name : JSON.stringify(v); }
  return String(v);
};
export const csvCell = (v: unknown): string => {
  let s = cellText(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
};
const line = (cells: unknown[]) => `${cells.map(csvCell).join(',')}\r\n`;

/** Every record behind `url` (a records route that pages with limit and after), as CSV text; `more`: cut at EXPORT_MAX. */
export async function exportCsv(url: string, area: Pick<RecordAreaSpec, 'fields'>, rows: (p: Page) => Page = (p) => p, keep?: ReadonlySet<string> | null) {
  let csv = line(['Key', 'Title', ...area.fields.map((f) => f.label), 'Updated']), count = 0, after: string | null = null;
  for (;;) {
    // audit=export: the data trail (mold_v0-197) records these pages as one export each, not as list reads.
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}limit=200&audit=export${after ? `&after=${encodeURIComponent(after)}` : ''}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as Page & { error?: string };
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    const page = rows(body);
    for (const r of page.records) {
      if (keep && !keep.has(r.key)) continue;
      if (count >= EXPORT_MAX) return { csv, count, more: true };
      csv += line([r.key, r.title ?? '', ...area.fields.map((f) => r.data?.[f.name]), r.updated_at]);
      count++;
    }
    if (!page.next) return { csv, count, more: false };
    after = page.next;
  }
}

type ExportProps = { url: string; area: Pick<RecordAreaSpec, 'fields'>; name: string; rows?: (p: Page) => Page; areas: string[] };

/**
 * A list's Export CSV, an item of its Actions ▾ menu (mold_v0-294, components/layout/actions-menu.tsx): null when the
 * area's pack withholds its export (mold_v0-067 mcp settings), and on a workspace's list (/api/records) for the roles
 * that may not export (mold_v0-235). `keys`: the view's rows when search or a filter narrows the list (mold_v0-217): the
 * file holds these alone. What it wrote (or why not) is said in a toast.
 */
export function useExportCsv({ url, area, name, rows, areas }: ExportProps): { item: (keys?: readonly string[] | null) => RowAction | null; busy: boolean } {
  const [busy, setBusy] = useState(false);
  const workspace = url.startsWith('/api/records');
  // The role is a workspace's (/api/app/me): read only on a workspace's list, whose url never changes for one list.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { role, loaded } = workspace ? useAccountRole() : { role: null, loaded: true };
  // Until the role is known nothing is hidden (the server refuses what the role may not do).
  const exportable = !workspace || !loaded || !role || areas.every((n) => { const s = recordAreas.find((a) => a.name === n); return !s?.export_roles || s.export_roles.includes(role); });
  const withheld = areas.some((a) => exportWithheldAreas.includes(a));
  const run = async (keys?: readonly string[] | null) => {
    setBusy(true);
    try {
      const { csv, count, more } = await exportCsv(url, area, rows, keys ? new Set(keys) : null);
      downloadText(`${name}-${today()}.csv`, '\ufeff' + csv, 'text/csv;charset=utf-8');
      toast.success(`${count} record${count === 1 ? '' : 's'} exported${more ? ` (the first ${EXPORT_MAX}; ask your agent to export the rest with the export tool)` : ''}.`);
    } catch (e) {
      toast.error(`The export failed: ${(e as Error).message}`);
    } finally { setBusy(false); }
  };
  return {
    busy,
    item: (keys) => (withheld || !exportable ? null : {
      label: busy ? 'Exporting…' : keys ? `Export CSV (${keys.length} shown)` : 'Export CSV', icon: <Icons.download aria-hidden='true' />,
      disabled: busy, testId: 'export-csv', onSelect: () => void run(keys),
    }),
  };
}

/**
 * Export CSV of a list the page already holds (mold_v0-176: runs, reports, schedules, notices), an Actions ▾ item: every
 * row it read, a column per typed column (its plain name, its raw value), text a spreadsheet would run as a formula
 * defused as above.
 */
export function exportRowsItem<T>({ name, rows, cols }: { name: string; rows: readonly T[]; cols: { key: string; label: unknown; name?: string; value?: (r: T) => unknown; csv?: false }[] }): RowAction {
  const shown = cols.filter((c) => c.value && c.csv !== false);
  const run = () => {
    const head = shown.map((c) => c.name ?? (typeof c.label === 'string' ? c.label : c.key));
    downloadText(`${name}-${today()}.csv`, '\ufeff' + line(head) + rows.map((r) => line(shown.map((c) => c.value!(r)))).join(''), 'text/csv;charset=utf-8');
  };
  return { label: `Export CSV (${rows.length} rows)`, icon: <Icons.download aria-hidden='true' />, onSelect: run, disabled: !rows.length, testId: 'export-csv' };
}

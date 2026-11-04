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
// below read; the server refuses the rest), and mold_v0-234: Import sits beside it where the area's contract grants
// import to the person's role (features/records/workspace-import.tsx).
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { exportWithheldAreas, recordAreas, type RecordAreaSpec } from '@/config/pack-nav.generated';
import { useAccountRole } from '@/features/portal/role';
import { WorkspaceImportButton } from '@/features/records/workspace-import';
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

type ExportProps = {
  url: string; area: Pick<RecordAreaSpec, 'fields'>; name: string; rows?: (p: Page) => Page; areas: string[];
  /** The view's rows when search or a filter narrows the list (mold_v0-217): the file holds these alone. */
  keys?: readonly string[] | null;
  /** In a list's search row: "Export", the icon alone on a phone. */
  compact?: boolean;
};

/**
 * The Export CSV button: nothing when the area's pack withholds its export (mold_v0-067 mcp settings). On a workspace's
 * list (/api/records) it follows the person's role: Export for the roles that may export, Import beside it for the
 * roles the area's contract lets import.
 */
export function ExportCsvButton(props: ExportProps) {
  return props.url.startsWith('/api/records') ? <WorkspaceListData {...props} /> : <ExportControl {...props} />;
}

function WorkspaceListData(props: ExportProps) {
  const { role, loaded } = useAccountRole();
  const specs = props.areas.map((n) => recordAreas.find((a) => a.name === n));
  // Until the role is known nothing is hidden (the server refuses what the role may not do).
  const exportable = !loaded || !role || specs.every((s) => !s?.export_roles || s.export_roles.includes(role));
  const one = specs.length === 1 ? specs[0] : undefined;
  const importable = !!(loaded && role && one?.scope === 'workspace' && one.import_roles?.includes(role));
  if (!importable) return exportable ? <ExportControl {...props} /> : null;
  return (
    <div className='flex min-w-0 flex-wrap items-center gap-2'>
      <WorkspaceImportButton area={{ name: one!.name, label: one!.label }} compact={props.compact} />
      {exportable && <ExportControl {...props} />}
    </div>
  );
}

function ExportControl({ url, area, name, rows, areas, keys, compact = false }: ExportProps) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  if (areas.some((a) => exportWithheldAreas.includes(a))) return null;
  const run = async () => {
    setBusy(true); setNote(null);
    try {
      const { csv, count, more } = await exportCsv(url, area, rows, keys ? new Set(keys) : null);
      downloadText(`${name}-${today()}.csv`, '\ufeff' + csv, 'text/csv;charset=utf-8');
      setNote({ error: false, text: `${count} record${count === 1 ? '' : 's'} exported${more ? ` (the first ${EXPORT_MAX}; ask your AI client to export the rest with the export tool)` : ''}.` });
    } catch (e) {
      setNote({ error: true, text: `The export failed: ${(e as Error).message}` });
    } finally { setBusy(false); }
  };
  return (
    <div className='flex min-w-0 flex-wrap items-center gap-2'>
      <Button variant='outline' size={compact ? 'default' : 'sm'} onClick={() => void run()} disabled={busy} data-testid='export-csv'
        aria-label={compact ? (keys ? 'Export the rows shown as CSV' : 'Export CSV') : undefined} title={compact ? (keys ? 'Export the rows shown as CSV' : 'Export CSV') : undefined}
        className={compact ? 'max-sm:w-8 max-sm:px-0' : undefined}>
        {busy ? <Icons.spinner aria-hidden='true' className='animate-spin' /> : <Icons.download aria-hidden='true' />}
        {compact ? <span className='hidden sm:inline'>{busy ? 'Exporting…' : 'Export'}</span> : busy ? ' Exporting…' : ' Export CSV'}
      </Button>
      <span role='status' className={note?.error ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}>{note?.text ?? ''}</span>
    </div>
  );
}

/**
 * Export CSV of a list the page already holds (mold_v0-176: runs, reports, schedules, notices): every row it read, a
 * column per typed column (its plain name, its raw value), text a spreadsheet would run as a formula defused as above.
 */
export function ExportRowsButton<T>({ name, rows, cols }: { name: string; rows: readonly T[]; cols: { key: string; label: unknown; name?: string; value?: (r: T) => unknown; csv?: false }[] }) {
  const shown = cols.filter((c) => c.value && c.csv !== false);
  const run = () => {
    const head = shown.map((c) => c.name ?? (typeof c.label === 'string' ? c.label : c.key));
    downloadText(`${name}-${today()}.csv`, '﻿' + line(head) + rows.map((r) => line(shown.map((c) => c.value!(r)))).join(''), 'text/csv;charset=utf-8');
  };
  return (
    <Button variant='outline' size='sm' onClick={run} disabled={!rows.length} data-testid='export-csv'>
      <Icons.download aria-hidden='true' /> Export CSV
    </Button>
  );
}

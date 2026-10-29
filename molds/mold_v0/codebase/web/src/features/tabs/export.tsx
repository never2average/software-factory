'use client';
// Export CSV (mold_v0-108): an area tab's records (one area, or a merged tab's rows) and an area's records page, as one
// CSV file. It pages through the same read-only routes the page shows (/api/records: this workspace's rows and the
// shared ones, as the person's role may read them; /api/admin/records for staff), so the file holds what the person
// could page through and nothing else. The file is the generated MCP tool's (src/record-export.ts export_<area>): a
// header (Key, Title, each field's label, Updated), a row per record, lists joined with "; ", a file by its path, json as
// JSON text, and text a spreadsheet would run as a formula defused with a leading apostrophe.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { exportWithheldAreas, type RecordAreaSpec } from '@/config/pack-nav.generated';
import { downloadText, today } from '@/lib/csv';

type Row = { key: string; title: string | null; data: Record<string, unknown>; updated_at: string };
type Page = { records: Row[]; next: string | null };

/** At most this many records in one file (the page says so when there were more). */
export const EXPORT_MAX = 10000;

const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(cellText).filter((x) => x !== '').join('; ');
  if (typeof v === 'object') { const o = v as Record<string, unknown>; return typeof o.path === 'string' ? o.path : JSON.stringify(v); }
  return String(v);
};
export const csvCell = (v: unknown): string => {
  let s = cellText(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
};
const line = (cells: unknown[]) => `${cells.map(csvCell).join(',')}\r\n`;

/** Every record behind `url` (a records route that pages with limit and after), as CSV text; `more`: cut at EXPORT_MAX. */
export async function exportCsv(url: string, area: Pick<RecordAreaSpec, 'fields'>, rows: (p: Page) => Page = (p) => p) {
  let csv = line(['Key', 'Title', ...area.fields.map((f) => f.label), 'Updated']), count = 0, after: string | null = null;
  for (;;) {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}limit=200${after ? `&after=${encodeURIComponent(after)}` : ''}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as Page & { error?: string };
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    const page = rows(body);
    for (const r of page.records) {
      if (count >= EXPORT_MAX) return { csv, count, more: true };
      csv += line([r.key, r.title ?? '', ...area.fields.map((f) => r.data?.[f.name]), r.updated_at]);
      count++;
    }
    if (!page.next) return { csv, count, more: false };
    after = page.next;
  }
}

/** The Export CSV button: nothing when the area's pack withholds its export (mold_v0-067 mcp settings). */
export function ExportCsvButton({ url, area, name, rows, areas }: { url: string; area: Pick<RecordAreaSpec, 'fields'>; name: string; rows?: (p: Page) => Page; areas: string[] }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  if (areas.some((a) => exportWithheldAreas.includes(a))) return null;
  const run = async () => {
    setBusy(true); setNote(null);
    try {
      const { csv, count, more } = await exportCsv(url, area, rows);
      downloadText(`${name}-${today()}.csv`, '\ufeff' + csv, 'text/csv;charset=utf-8');
      setNote({ error: false, text: `${count} record${count === 1 ? '' : 's'} exported${more ? ` (the first ${EXPORT_MAX}; ask your AI client to export the rest with the export tool)` : ''}.` });
    } catch (e) {
      setNote({ error: true, text: `The export failed: ${(e as Error).message}` });
    } finally { setBusy(false); }
  };
  return (
    <div className='flex min-w-0 flex-wrap items-center gap-2'>
      <Button variant='outline' size='sm' onClick={() => void run()} disabled={busy} data-testid='export-csv'>
        {busy ? <Icons.spinner aria-hidden='true' className='animate-spin' /> : <Icons.download aria-hidden='true' />} {busy ? 'Exporting…' : 'Export CSV'}
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

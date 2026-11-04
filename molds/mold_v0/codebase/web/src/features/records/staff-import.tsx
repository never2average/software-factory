'use client';
// A shared area's Import (mold_v0-221; /admin/records/<area>?import=1, the search row's secondary action beside New):
// a CSV or JSON file read in the browser, its columns mapped to the area's key, title and fields (matched by name or
// label first), a preview from the server (POST /api/admin/records/_console/<area>/import, src/record-import.ts: what
// each row would do, and each invalid row's problems), then the import itself: the valid rows as staff rows, in one
// transaction, idempotent by key (a row that changes nothing is not written). Nothing is written before Import.
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Icons } from '@/components/icons';
import { CardForm, type FormField } from '@/features/tabs/tab-action';
import { fail } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { ADMIN_HEADERS } from '@/lib/env-names';

type Action = 'create' | 'update' | 'override' | 'unchanged' | 'invalid';
interface Report { area: string; dry_run: boolean; rows: { row: number; key: string; action: Action; errors: string[] }[]; counts: Record<Action, number>; written: number }
interface Parsed { name: string; columns: string[]; rows: Record<string, unknown>[] }

/** At most this many rows per file (the server's own limit, src/record-import.ts IMPORT_MAX_ROWS). */
const MAX_ROWS = 1000;
/** Rows of the preview drawn (every row is checked; the counts cover them all). */
const SHOWN = 200;

/** CSV text as rows of cells: quoted cells (with "" inside, commas and line breaks), CRLF or LF, a BOM; , ; or tab. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const count = (c: string) => first.split(c).length;
  const sep = [',', ';', '\t'].reduce((a, b) => (count(b) > count(a) ? b : a), ',');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

/** A file's rows as objects by column: a CSV's header row names them; JSON is a list of objects (or {records|rows: [...]}),
 * a row's nested `data` object read as columns of their own. */
export function parseFile(name: string, text: string): Parsed {
  if (/\.json$/i.test(name) || /^\s*[[{]/.test(text)) {
    let doc: unknown;
    try { doc = JSON.parse(text); } catch { throw new Error('The file is not valid JSON'); }
    const list = Array.isArray(doc) ? doc : (doc as { records?: unknown; rows?: unknown })?.records ?? (doc as { rows?: unknown })?.rows;
    if (!Array.isArray(list)) throw new Error('A JSON file holds a list of rows (or {"records": [...]})');
    const rows = list.filter((r) => r && typeof r === 'object' && !Array.isArray(r)).map((r) => {
      const { data, ...rest } = r as Record<string, unknown>;
      return data && typeof data === 'object' && !Array.isArray(data) ? { ...rest, ...(data as Record<string, unknown>) } : { ...rest };
    });
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    return { name, columns, rows };
  }
  const [head, ...body] = parseCsv(text);
  if (!head) throw new Error('The file is empty');
  const columns = head.map((h, i) => h.trim() || `Column ${i + 1}`);
  return { name, columns, rows: body.map((cells) => Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? '']))) };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** A column for each target, matched by its name or label: key (also id), title (also name). */
function autoMap(columns: string[], fields: FormField[]): Record<string, string> {
  const find = (...names: string[]) => columns.find((c) => names.map(norm).includes(norm(c))) ?? '';
  const map: Record<string, string> = { _key: find('key', 'id'), _title: find('title', 'name') };
  for (const f of fields) map[f.name] = find(f.name, f.label);
  return map;
}

const ACTION_LABEL: Record<Action, string> = { create: 'New', update: 'Updates a staff row', override: 'Overrides the repository', unchanged: 'Unchanged', invalid: 'Invalid' };

async function post(url: string, body: unknown): Promise<Report> {
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json', ...ADMIN_HEADERS }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Report & { error?: string };
  if (!res.ok) throw httpError(res.status, json);
  return json;
}

/** The import card's form (inside an ActionCard: features/tabs/tab-action.tsx). */
export function ImportRecordsForm({ area, fields, noun, url, onDone }: { area: { name: string; label: string }; fields: FormField[]; noun: string; url: string; onDone: () => void }) {
  const [file, setFile] = useState<Parsed | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = useMemo(() => (file && map._key ? file.rows.map((r) => ({
    key: r[map._key],
    ...(map._title ? { title: r[map._title] } : {}),
    data: Object.fromEntries(fields.filter((f) => map[f.name]).map((f) => [f.name, r[map[f.name]!]])),
  })) : []), [file, map, fields]);
  const read = async (f: File | undefined) => {
    setPreview(null);
    if (!f) return setFile(null);
    try {
      const parsed = parseFile(f.name, await f.text());
      if (!parsed.rows.length) throw new Error('The file has no rows');
      if (parsed.rows.length > MAX_ROWS) throw new Error(`The file has ${parsed.rows.length} rows; import at most ${MAX_ROWS} at a time`);
      setFile(parsed);
      setMap(autoMap(parsed.columns, fields));
    } catch (e) { setFile(null); fail(e); }
  };
  const remap = (target: string, col: string) => { setMap((m) => ({ ...m, [target]: col })); setPreview(null); };
  const valid = preview ? preview.counts.create + preview.counts.update + preview.counts.override : 0;
  const submit = async () => {
    if (!rows.length) return void toast.error('Choose a file and the column that holds each row’s key');
    setBusy(true);
    try {
      if (!preview) { setPreview(await post(url, { rows, dry_run: true })); return; }
      const done = await post(url, { rows, dry_run: false });
      toast.success(`Imported ${done.written} ${done.written === 1 ? noun : `${noun}s`}${done.counts.invalid ? `; ${done.counts.invalid} invalid skipped` : ''}`);
      onDone();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const target = (id: string, label: string, required = false) => (
    <div key={id} className='flex flex-col gap-1.5'>
      <Label htmlFor={`import-map-${id}`}>{label}{required && <span className='text-destructive' aria-hidden> *</span>}</Label>
      <NativeSelect id={`import-map-${id}`} className='w-full' value={map[id] ?? ''} onChange={(e) => remap(id, e.target.value)}>
        <NativeSelectOption value=''>{required ? 'Choose a column' : 'Not imported'}</NativeSelectOption>
        {file?.columns.map((c) => <NativeSelectOption key={c} value={c}>{c}</NativeSelectOption>)}
      </NativeSelect>
    </div>
  );
  return (
    <CardForm onSubmit={submit} submit={
      <Button type='submit' disabled={busy || !rows.length || (!!preview && !valid)} data-import-submit=''>
        {preview ? <Icons.upload /> : <Icons.eye />}
        {busy ? (preview ? 'Importing…' : 'Checking…') : preview ? `Import ${valid} ${valid === 1 ? noun : `${noun}s`}` : 'Preview'}
      </Button>}>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='import-file'>File<span className='text-destructive' aria-hidden> *</span></Label>
        <Input id='import-file' type='file' accept='.csv,.json,text/csv,application/json' onChange={(e) => void read(e.target.files?.[0])} />
        <p className='text-muted-foreground text-xs'>A CSV with a header row, or a JSON list of rows; up to {MAX_ROWS} rows. Rows become staff rows of {area.label}: a key already there is updated (fields the file leaves out keep their values), and a repository’s row is overridden.</p>
      </div>
      {file && (
        <fieldset className='flex flex-col gap-3' data-import-map=''>
          <legend className='mb-1 text-sm font-medium'>Columns of {file.name} ({file.rows.length} {file.rows.length === 1 ? 'row' : 'rows'})</legend>
          <div className='grid gap-3 sm:grid-cols-2'>
            {target('_key', 'Key', true)}
            {target('_title', 'Title')}
            {fields.map((f) => target(f.name, f.label))}
          </div>
        </fieldset>
      )}
      {preview && (
        <section className='flex flex-col gap-2' data-import-preview=''>
          <h3 className='text-sm font-medium'>Preview</h3>
          <p className='text-muted-foreground text-sm' data-import-counts=''>
            {(['create', 'update', 'override', 'unchanged', 'invalid'] as Action[]).filter((a) => preview.counts[a]).map((a) => `${preview.counts[a]} ${ACTION_LABEL[a].toLowerCase()}`).join(' · ')}
            {preview.counts.invalid ? '. Invalid rows are skipped.' : '.'}
          </p>
          <div className='max-h-96 overflow-auto rounded-md border'>
            <table className='w-full text-sm'>
              <thead className='bg-muted/50 sticky top-0'>
                <tr className='text-left'><th className='px-3 py-2 font-medium'>Row</th><th className='px-3 py-2 font-medium'>Key</th><th className='px-3 py-2 font-medium'>What happens</th><th className='px-3 py-2 font-medium'>Problems</th></tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, SHOWN).map((r) => (
                  <tr key={r.row} className='border-t align-top' data-import-row={r.action}>
                    <td className='px-3 py-2 tabular-nums'>{r.row}</td>
                    <td className='px-3 py-2 font-mono text-xs break-all'>{r.key || '—'}</td>
                    <td className='px-3 py-2'><Badge variant={r.action === 'invalid' ? 'destructive' : r.action === 'unchanged' ? 'outline' : 'secondary'}>{ACTION_LABEL[r.action]}</Badge></td>
                    <td className='text-destructive px-3 py-2 text-xs'>{r.errors.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows.length > SHOWN && <p className='text-muted-foreground text-xs'>The first {SHOWN} of {preview.rows.length} rows; the counts cover every row.</p>}
        </section>
      )}
    </CardForm>
  );
}

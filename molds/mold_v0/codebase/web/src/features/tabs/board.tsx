// The pieces of a record area's views (mold_v0-058; ./tab-page.tsx): a field's value in words, a record's link, and
// the board (a column per state). Pure: the tab page loads the records; a rendered check draws them as they are
// (scripts/console-tabs-test.ts).
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import type { RecordAreaSpec, RecordFieldSpec } from '@/config/pack-nav.generated';

export type RecordRow = { key: string; title: string | null; data: Record<string, unknown>; updated_at: string };
export type Page = { records: RecordRow[]; next: string | null };

export const optionLabel = (f: RecordFieldSpec | undefined, v: string) => {
  const o = f?.options?.find((x) => (typeof x === 'string' ? x : x.value) === v);
  return o === undefined ? v : typeof o === 'string' ? o : o.label ?? o.value;
};
/** A field's value in words: an enum's option label, a list joined, a date as written. */
export function show(area: RecordAreaSpec, field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const f = area.fields.find((x) => x.name === field);
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? optionLabel(f, x) : typeof x === 'object' && x && 'path' in x ? String((x as { name?: string; path: string }).name ?? (x as { path: string }).path) : JSON.stringify(x))).join(', ');
  if (typeof v === 'string') return f?.type === 'enum' ? optionLabel(f, v) : v;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
export const fieldLabel = (area: RecordAreaSpec, field: string) => area.fields.find((f) => f.name === field)?.label ?? field;

export function RecordLink({ area, r, detail }: { area: RecordAreaSpec; r: RecordRow; detail: boolean }) {
  const text = r.title || r.key;
  return detail ? <Link className='underline-offset-4 hover:underline' href={`/app/records/${area.name}/${encodeURIComponent(r.key)}`}>{text}</Link> : <span>{text}</span>;
}

/** A board: a column per option of `by` (in declared order; a stored value no longer an option gets its own), a card per record. */
export function BoardColumns({ area, by, detail, data }: { area: RecordAreaSpec; by: string; detail: boolean; data: Page }) {
  const f = area.fields.find((x) => x.name === by);
  const states = (f?.options ?? []).map((o) => (typeof o === 'string' ? o : o.value));
  const initial = area.lifecycle?.field === by ? area.lifecycle.initial : null;
  const stateOf = (r: RecordRow) => (typeof r.data[by] === 'string' ? (r.data[by] as string) : initial ?? '');
  const extra = [...new Set(data.records.map(stateOf).filter((s) => !states.includes(s)))];
  const columns = [...states, ...extra];
  const cols = area.list_columns.filter((c) => c !== by).slice(0, 3);
  return (
    <div className='flex flex-col gap-2'>
      {data.next && <p className='text-muted-foreground text-xs'>The first 200 records; the table has them all.</p>}
      <div className='flex gap-3 overflow-x-auto pb-2' role='list' aria-label={`${area.label} by ${fieldLabel(area, by)}`}>
        {columns.map((s) => {
          const rows = data.records.filter((r) => stateOf(r) === s);
          return (
            <section key={s || 'none'} role='listitem' className='bg-muted/40 flex w-64 shrink-0 flex-col gap-2 rounded-lg border p-2'>
              <h3 className='flex items-center justify-between px-1 text-sm font-medium'>
                <span>{s ? optionLabel(f, s) : 'No value'}</span>
                <Badge variant='secondary' className='tabular-nums'>{rows.length}</Badge>
              </h3>
              <ul className='flex flex-col gap-2'>
                {rows.map((r) => (
                  <li key={r.key} className='bg-background rounded-md border p-2 text-sm'>
                    <RecordLink area={area} r={r} detail={detail} />
                    {cols.length > 0 && (
                      <dl className='text-muted-foreground mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-xs'>
                        {cols.map((c) => show(area, c, r.data[c]) && (
                          <div key={c} className='contents'><dt>{fieldLabel(area, c)}</dt><dd className='truncate'>{show(area, c, r.data[c])}</dd></div>
                        ))}
                      </dl>
                    )}
                  </li>
                ))}
                {!rows.length && <li className='text-muted-foreground px-1 text-xs'>None</li>}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

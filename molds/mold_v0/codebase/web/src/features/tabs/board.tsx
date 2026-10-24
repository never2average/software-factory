// The pieces of a record area's views (mold_v0-058; ./tab-page.tsx): a field's value in words, a record's link, and
// the board (a column per state). Pure: the tab page loads the records; a rendered check draws them as they are
// (scripts/console-tabs-test.ts).
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { RecordAreaSpec, RecordFieldSpec } from '@/config/pack-nav.generated';
import { useScrollsSideways } from '@/hooks/use-scrolls-sideways';

/** A row of an area's list; a merged tab's row (mold_v0-135) also names the areas that hold its key, in the tab's order. */
export type RecordRow = { key: string; title: string | null; data: Record<string, unknown>; updated_at: string; areas?: string[] };
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
  // A merged tab's row opens the record of the first of its areas (mold_v0-135).
  const at = r.areas?.[0] ?? area.name;
  return detail ? <Link className='underline-offset-4 hover:underline' href={`/app/records/${at}/${encodeURIComponent(r.key)}`}>{text}</Link> : <span>{text}</span>;
}

/** A board: a column per option of `by` (in declared order; a stored value no longer an option gets its own), a card per record. */
/**
 * The moves a record in state `from` may make along the area's lifecycle, for `role` (null: not known, every move the
 * lifecycle declares; the server's record store checks the role, the transition and the area's move permission anyway).
 */
export function movesFrom(area: RecordAreaSpec, from: string, role: string | null) {
  const lc = area.lifecycle;
  if (!lc) return [];
  return lc.transitions.filter((t) => (t.from === '*' || t.from.includes(from)) && t.to !== from && (!role || !t.roles || t.roles.includes(role)))
    .map((t) => ({ to: t.to, label: t.label ?? optionLabel(area.fields.find((f) => f.name === lc.field), t.to) }))
    .filter((t, i, all) => all.findIndex((x) => x.to === t.to) === i);
}

/**
 * A board. With `onMove` (a workspace area whose board is by its lifecycle field), each card offers the moves its state
 * allows, as a labelled menu (keyboard and screen-reader friendly, no drag needed), through the record store's move.
 */
export function BoardColumns({ area, by, detail, data, onMove, role = null }: {
  area: RecordAreaSpec; by: string; detail: boolean; data: Page; onMove?: (key: string, to: string) => void; role?: string | null;
}) {
  const f = area.fields.find((x) => x.name === by);
  const states = (f?.options ?? []).map((o) => (typeof o === 'string' ? o : o.value));
  const initial = area.lifecycle?.field === by ? area.lifecycle.initial : null;
  const stateOf = (r: RecordRow) => (typeof r.data[by] === 'string' ? (r.data[by] as string) : initial ?? '');
  const extra = [...new Set(data.records.map(stateOf).filter((s) => !states.includes(s)))];
  const columns = [...states, ...extra];
  const cols = area.list_columns.filter((c) => c !== by).slice(0, 3);
  const name = `${area.label} by ${fieldLabel(area, by)}`;
  const scroller = useScrollsSideways<HTMLDivElement>();
  return (
    <div className='flex flex-col gap-2'>
      {data.next && <p className='text-muted-foreground text-xs'>The first 200 records; the table has them all.</p>}
      {/* The columns scroll sideways on a narrow window: then the scroller is a named tab stop (mold_v0-114). */}
      <div ref={scroller.ref} {...scroller.scrollRegion(name)} data-slot='board-scroller'
        className='focus-visible:ring-ring/50 overflow-x-auto rounded-sm pb-2 outline-none focus-visible:ring-[3px]'>
      <div className='flex w-max gap-3' role='list' aria-label={name}>
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
                    {onMove && movesFrom(area, s, role).length > 0 && (
                      <select aria-label={`Move ${r.title || r.key}`} className='border-input bg-background mt-2 block w-full rounded-md border px-2 py-1 text-xs'
                        value='' onChange={(e) => { if (e.target.value) onMove(r.key, e.target.value); }}>
                        <option value=''>Move to…</option>
                        {movesFrom(area, s, role).map((m) => <option key={m.to} value={m.to}>{m.label}</option>)}
                      </select>
                    )}
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
    </div>
  );
}

/** A page of records as a table: the record, then the area's list columns (a merged tab's: its columns, mold_v0-135). */
export function RecordTable({ area, detail, data }: { area: RecordAreaSpec; detail: boolean; data: Page }) {
  return (
    <Table label={area.label}>
      <TableHeader>
        <TableRow>
          <TableHead>Record</TableHead>
          {area.list_columns.map((c) => <TableHead key={c}>{fieldLabel(area, c)}</TableHead>)}
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.records.map((r) => (
          <TableRow key={r.key}>
            <TableCell><RecordLink area={area} r={r} detail={detail} /></TableCell>
            {area.list_columns.map((c) => <TableCell key={c}>{show(area, c, r.data[c])}</TableCell>)}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Records on a timeline by `by` (a date field, or updated): newest month first, the undated after; each with a badge of
 * the `badge` field (the lifecycle's state; a merged tab's board field).
 */
export function TimelineList({ area, by, badge, detail, data }: { area: RecordAreaSpec; by: string; badge: string | null; detail: boolean; data: Page }) {
  const when = (r: RecordRow) => {
    const v = by === 'updated' ? r.updated_at : r.data[by];
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  };
  const dated = data.records.filter((r) => when(r)).sort((a, b) => when(b)!.localeCompare(when(a)!));
  const undated = data.records.filter((r) => !when(r));
  const months = [...new Set(dated.map((r) => when(r)!.slice(0, 7)))];
  const month = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const label = by === 'updated' ? 'Last changed' : fieldLabel(area, by);
  return (
    <div className='flex flex-col gap-6'>
      {data.next && <p className='text-muted-foreground text-xs'>The first 200 records; the table has them all.</p>}
      {months.map((m) => (
        <section key={m} className='flex flex-col gap-2'>
          <h3 className='text-sm font-medium'>{month(m)}</h3>
          <ol className='border-l pl-4'>
            {dated.filter((r) => when(r)!.startsWith(m)).map((r) => (
              <li key={r.key} className='relative py-1.5 text-sm'>
                <span aria-hidden className='bg-foreground/40 absolute top-3 -left-[1.3rem] size-2 rounded-full' />
                <span className='text-muted-foreground mr-3 inline-block w-14 tabular-nums'><span className='sr-only'>{label}: </span>{day(when(r)!)}</span>
                <RecordLink area={area} r={r} detail={detail} />
                {badge && r.data[badge] !== undefined && r.data[badge] !== null && r.data[badge] !== '' && (
                  <Badge variant='outline' className='ml-2'>{show(area, badge, r.data[badge])}</Badge>
                )}
              </li>
            ))}
          </ol>
        </section>
      ))}
      {undated.length > 0 && (
        <section className='flex flex-col gap-2'>
          <h3 className='text-sm font-medium'>No {label.toLowerCase()}</h3>
          <ul className='flex flex-col gap-1 text-sm'>{undated.map((r) => <li key={r.key}><RecordLink area={area} r={r} detail={detail} /></li>)}</ul>
        </section>
      )}
    </div>
  );
}

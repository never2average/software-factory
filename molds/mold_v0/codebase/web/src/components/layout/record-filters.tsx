'use client';
// The Notion-style database controls for RecordView: the column / rule types, the pure filter, sort and group helpers,
// and the toolbar menus (filter chips, sort, properties, group). RecordView re-exports the types; pages import from there.
import type { ReactNode } from 'react';
import { IconAdjustmentsHorizontal, IconArrowsSort, IconColumns3, IconFilter, IconLayoutRows } from '@tabler/icons-react';
import { DateRangePicker, last30, rangeLabel, type DateRange } from '@/components/layout/date-range-picker';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';

export type PropType = 'text' | 'select' | 'number' | 'date' | 'boolean';
export type RawValue = string | number | boolean | null | undefined;

export interface RecordCol<T> {
  key: string;
  label: ReactNode;
  /** Plain label for menus, chips, CSV and the peek; defaults to `label` when it is a string, else `key`. */
  name?: string;
  render: (row: T) => ReactNode;
  className?: string;
  /** Still shown while a record is open beside the table (the narrow 40% view). */
  keep?: boolean;
  /** With `value`, makes the column filterable and sortable. */
  type?: PropType;
  /** The raw value: dates as ISO strings. */
  value?: (row: T) => RawValue;
  /** Select options; their order is also the group order. Omitted: the distinct values in the rows, sorted. */
  options?: { value: string; label?: string }[];
  /** The title column: cannot be hidden, and is the peek's default title. */
  title?: boolean;
  /** Hidden until shown from the Properties menu. */
  hidden?: boolean;
  peek?: false;
  csv?: false;
}

/** One entry in a ⋯ menu; `separator` draws a line before it. */
/** `hint`: a short note shown next to a disabled action (say, the role it needs). */
export interface RowAction { label: string; icon?: ReactNode; onSelect: () => void; destructive?: boolean; disabled?: boolean; separator?: boolean; hint?: string }

export type Op =
  | 'contains' | 'not_contains' | 'is' | 'is_not' | 'empty' | 'not_empty'
  | 'any_of' | 'none_of'
  | 'gt' | 'lt' | 'eq'
  | 'before' | 'after' | 'within'
  | 'true' | 'false';
export interface FilterRule { id: string; key: string; op: Op; value?: string | number | string[] | DateRange }
export interface SortRule { key: string; dir: 'asc' | 'desc' }

export interface RecordViewDef<T> {
  id: string;
  label: string;
  /** The view's own predicate, applied before search and filters. */
  match?: (row: T) => boolean;
  sort?: SortRule[];
  /** Key of a select column to group by. */
  group?: string;
  /** Show the row count on the tab (default true). */
  count?: boolean;
}

export const colName = <T,>(c: RecordCol<T>) => c.name ?? (typeof c.label === 'string' ? c.label : c.key);
export const typed = <T,>(c: RecordCol<T>) => !!(c.type && c.value);

export const OPS: Record<PropType, Op[]> = {
  text: ['contains', 'not_contains', 'is', 'is_not', 'empty', 'not_empty'],
  select: ['any_of', 'none_of', 'empty'],
  number: ['gt', 'lt', 'eq', 'empty'],
  date: ['before', 'after', 'within'],
  boolean: ['true', 'false']
};
const OP_LABEL: Record<Op, string> = {
  contains: 'contains', not_contains: "doesn't contain", is: 'is', is_not: 'is not', empty: 'is empty', not_empty: 'is not empty',
  any_of: 'is any of', none_of: 'is none of', gt: '>', lt: '<', eq: '=', before: 'before', after: 'after', within: 'within',
  true: 'is yes', false: 'is no'
};
const NO_VALUE: Op[] = ['empty', 'not_empty', 'true', 'false'];

let seq = 0;
export function defaultRule<T>(c: RecordCol<T>): FilterRule {
  const id = `f${++seq}`;
  switch (c.type) {
    case 'select': return { id, key: c.key, op: 'any_of', value: [] };
    case 'number': return { id, key: c.key, op: 'gt', value: '' };
    case 'date': return { id, key: c.key, op: 'within', value: last30() };
    case 'boolean': return { id, key: c.key, op: 'true' };
    default: return { id, key: c.key, op: 'contains', value: '' };
  }
}

/** A rule with an empty value is ignored rather than matching nothing. */
export const ruleActive = (r: FilterRule) =>
  NO_VALUE.includes(r.op) || !(r.value === undefined || r.value === '' || (Array.isArray(r.value) && !r.value.length));

const blank = (v: RawValue) => v === null || v === undefined || v === '';

export function matchRule(v: RawValue, r: FilterRule): boolean {
  const x = r.value;
  switch (r.op) {
    case 'empty': return blank(v);
    case 'not_empty': return !blank(v);
    case 'true': return !!v;
    case 'false': return !v;
    case 'contains': return String(v ?? '').toLowerCase().includes(String(x).toLowerCase());
    case 'not_contains': return !String(v ?? '').toLowerCase().includes(String(x).toLowerCase());
    case 'is': return String(v ?? '').toLowerCase() === String(x).toLowerCase();
    case 'is_not': return String(v ?? '').toLowerCase() !== String(x).toLowerCase();
    case 'any_of': return (x as string[]).includes(String(v ?? ''));
    case 'none_of': return !(x as string[]).includes(String(v ?? ''));
    case 'gt': return !blank(v) && Number(v) > Number(x);
    case 'lt': return !blank(v) && Number(v) < Number(x);
    case 'eq': return !blank(v) && Number(v) === Number(x);
    case 'before': return !blank(v) && String(v).slice(0, 10) < String(x);
    case 'after': return !blank(v) && String(v).slice(0, 10) > String(x);
    case 'within': { const d = String(v ?? '').slice(0, 10), rg = x as DateRange; return !!d && d >= rg.from && d <= rg.to; }
  }
}

/** Rules are ANDed; unknown keys and empty rules are skipped. */
export function applyFilters<T>(rows: readonly T[], cols: RecordCol<T>[], rules: FilterRule[]): T[] {
  const live = rules.filter(ruleActive).map((r) => ({ r, c: cols.find((c) => c.key === r.key && typed(c)) })).filter((x) => x.c);
  if (!live.length) return rows.slice();
  return rows.filter((row) => live.every(({ r, c }) => matchRule(c!.value!(row), r)));
}

const cmp = (a: RawValue, b: RawValue) =>
  typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

/** Multi-key sort by `value()`; blanks go last whatever the direction, and ties keep the original order. */
export function sortRows<T>(rows: T[], cols: RecordCol<T>[], sort: SortRule[]): T[] {
  const keys = sort.map((s) => ({ s, c: cols.find((c) => c.key === s.key && typed(c)) })).filter((x) => x.c);
  if (!keys.length) return rows;
  return rows.map((row, i) => ({ row, i, v: keys.map(({ c }) => c!.value!(row)) }))
    .sort((a, b) => {
      for (let k = 0; k < keys.length; k++) {
        const x = a.v[k], y = b.v[k];
        if (blank(x) || blank(y)) { if (blank(x) !== blank(y)) return blank(x) ? 1 : -1; continue; }
        const d = cmp(x, y);
        if (d) return keys[k].s.dir === 'desc' ? -d : d;
      }
      return a.i - b.i;
    })
    .map((x) => x.row);
}

/** A select column's options: its own, else the distinct values in the rows (alphabetical). */
export function colOptions<T>(c: RecordCol<T>, rows: readonly T[]): { value: string; label: string }[] {
  if (c.options) return c.options.map((o) => ({ value: o.value, label: o.label ?? o.value }));
  const set = new Set<string>();
  for (const r of rows) { const v = c.value?.(r); if (!blank(v)) set.add(String(v)); }
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((v) => ({ value: v, label: v }));
}

export interface Group<T> { value: string; label: string; rows: T[] }
/** Groups in option order, then the rest alphabetically, then blanks; empty groups are left out. */
export function groupRows<T>(rows: T[], c: RecordCol<T>): Group<T>[] {
  const by = new Map<string, T[]>();
  for (const r of rows) { const v = c.value?.(r), k = blank(v) ? '' : String(v); (by.get(k) ?? by.set(k, []).get(k)!).push(r); }
  const order = (c.options ?? []).map((o) => o.value);
  const rest = [...by.keys()].filter((k) => k && !order.includes(k)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const label = (k: string) => (k ? c.options?.find((o) => o.value === k)?.label ?? k : 'Empty');
  return [...order, ...rest, ''].filter((k) => by.get(k)?.length).map((k) => ({ value: k, label: label(k), rows: by.get(k)! }));
}

function ruleText<T>(c: RecordCol<T>, r: FilterRule, rows: readonly T[]) {
  if (NO_VALUE.includes(r.op)) return OP_LABEL[r.op];
  if (r.op === 'within') return `${OP_LABEL.within} ${rangeLabel(r.value as DateRange)}`;
  if (Array.isArray(r.value)) {
    const opts = colOptions(c, rows), labels = r.value.map((v) => opts.find((o) => o.value === v)?.label ?? v);
    return `${OP_LABEL[r.op]} ${labels.length > 2 ? `${labels.slice(0, 2).join(', ')} +${labels.length - 2}` : labels.join(', ') || '…'}`;
  }
  return `${OP_LABEL[r.op]} ${r.value === '' || r.value === undefined ? '…' : String(r.value)}`;
}

/** Edits one rule's operator and value. */
function RuleEditor<T>({ c, r, rows, set }: { c: RecordCol<T>; r: FilterRule; rows: readonly T[]; set: (r: FilterRule) => void }) {
  const ops = OPS[c.type!];
  const setOp = (op: Op) => set({ ...r, op, value: op === 'within' ? (r.op === 'within' ? r.value : last30()) : r.op === 'within' ? '' : r.value });
  const opts = c.type === 'select' ? colOptions(c, rows) : [];
  const picked = Array.isArray(r.value) ? r.value : [];
  return (
    <div className='flex flex-col gap-2'>
      <div className='flex items-center gap-2 text-xs leading-none'>
        <span className='text-muted-foreground font-medium'>{colName(c)}</span>
        <NativeSelect size='sm' aria-label='Operator' value={r.op} onChange={(e) => setOp(e.target.value as Op)} className='ml-auto'>
          {ops.map((o) => <NativeSelectOption key={o} value={o}>{OP_LABEL[o]}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      {NO_VALUE.includes(r.op) ? null : c.type === 'select' ? (
        <ul className='flex max-h-56 flex-col gap-0.5 overflow-y-auto'>
          {opts.length ? opts.map((o) => (
            <li key={o.value}>
              <label className='hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-sm leading-none'>
                <Checkbox checked={picked.includes(o.value)}
                  onCheckedChange={(on) => set({ ...r, value: on ? [...picked, o.value] : picked.filter((v) => v !== o.value) })} />
                <span className='min-w-0 flex-1 truncate'>{o.label}</span>
              </label>
            </li>
          )) : <li className='text-muted-foreground px-1.5 py-1.5 text-xs'>No values.</li>}
        </ul>
      ) : r.op === 'within' ? (
        <DateRangePicker value={(r.value as DateRange) ?? last30()} onChange={(v) => set({ ...r, value: v })} className='w-full' />
      ) : (
        <Input autoFocus type={c.type === 'number' ? 'number' : c.type === 'date' ? 'date' : 'text'} value={String(r.value ?? '')}
          onChange={(e) => set({ ...r, value: e.target.value })} placeholder='Value' aria-label='Value' />
      )}
    </div>
  );
}

/** The menu of filterable columns (the toolbar's Filter button and the chips row's + Add filter). */
export function AddFilterMenu<T>({ cols, onAdd, trigger }: { cols: RecordCol<T>[]; onAdd: (r: FilterRule) => void; trigger: ReactNode }) {
  const can = cols.filter(typed);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger as React.ReactElement} />
      <DropdownMenuContent align='start' className='w-48'>
        {can.map((c) => <DropdownMenuItem key={c.key} onClick={() => onAdd(defaultRule(c))}>{colName(c)}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FilterButton<T>({ cols, count, onAdd }: { cols: RecordCol<T>[]; count: number; onAdd: (r: FilterRule) => void }) {
  return (
    <AddFilterMenu cols={cols} onAdd={onAdd}
      trigger={<Button variant='ghost' size='sm' className={cn(count && 'text-primary')}><IconFilter /> Filter</Button>} />
  );
}

/** One chip per rule ("Status: is any of Pending ✕"); clicking a chip edits it in a popover. */
export function FilterChips<T>({ cols, rows, rules, setRules, editing, setEditing }: {
  cols: RecordCol<T>[]; rows: readonly T[]; rules: FilterRule[]; setRules: (r: FilterRule[]) => void;
  editing: string | null; setEditing: (id: string | null) => void;
}) {
  const put = (r: FilterRule) => setRules(rules.map((x) => (x.id === r.id ? r : x)));
  const add = (r: FilterRule) => { setRules([...rules, r]); setTimeout(() => setEditing(r.id), 0); };
  return (
    <div className='flex min-w-0 flex-wrap items-center gap-1.5'>
      {rules.map((r) => {
        const c = cols.find((x) => x.key === r.key && typed(x));
        if (!c) return null;
        return (
          <Popover key={r.id} open={editing === r.id} onOpenChange={(o) => setEditing(o ? r.id : null)}>
            <span className={cn('flex h-7 items-center rounded-full border text-xs leading-none', ruleActive(r) ? 'border-primary/40 bg-primary/10 text-primary' : 'text-muted-foreground')}>
              <PopoverTrigger render={<button type='button' className='max-w-72 truncate py-1 pr-1 pl-2.5' />}>
                <span className='font-medium'>{colName(c)}:</span> {ruleText(c, r, rows)}
              </PopoverTrigger>
              <button type='button' aria-label={`Remove ${colName(c)} filter`} className='hover:text-foreground pr-2 pl-0.5'
                onClick={() => setRules(rules.filter((x) => x.id !== r.id))}><Icons.close className='size-3' /></button>
            </span>
            <PopoverContent align='start' className='w-72'><RuleEditor c={c} r={r} rows={rows} set={put} /></PopoverContent>
          </Popover>
        );
      })}
      <AddFilterMenu cols={cols} onAdd={add} trigger={<Button variant='ghost' size='xs' className='text-muted-foreground'><Icons.add /> Add filter</Button>} />
    </div>
  );
}

/** Multi-rule sort: [column ▾][Asc/Desc ▾] ✕, then + Add sort. */
export function SortMenu<T>({ cols, sort, setSort }: { cols: RecordCol<T>[]; sort: SortRule[]; setSort: (s: SortRule[]) => void }) {
  const can = cols.filter(typed);
  const free = can.find((c) => !sort.some((s) => s.key === c.key));
  const put = (i: number, s: SortRule) => setSort(sort.map((x, j) => (j === i ? s : x)));
  return (
    <Popover>
      <PopoverTrigger render={<Button variant='ghost' size='sm' className={cn(sort.length && 'text-primary')} />}>
        <IconArrowsSort /> Sort{sort.length ? ` ${sort.length}` : ''}
      </PopoverTrigger>
      <PopoverContent align='end' className='w-80'>
        {sort.length ? sort.map((s, i) => (
          <div key={i} className='flex items-center gap-2'>
            <NativeSelect size='sm' aria-label='Sort by' value={s.key} onChange={(e) => put(i, { ...s, key: e.target.value })} className='flex-1'>
              {can.filter((c) => c.key === s.key || !sort.some((x) => x.key === c.key)).map((c) => <NativeSelectOption key={c.key} value={c.key}>{colName(c)}</NativeSelectOption>)}
            </NativeSelect>
            <NativeSelect size='sm' aria-label='Direction' value={s.dir} onChange={(e) => put(i, { ...s, dir: e.target.value as SortRule['dir'] })}>
              <NativeSelectOption value='asc'>Ascending</NativeSelectOption>
              <NativeSelectOption value='desc'>Descending</NativeSelectOption>
            </NativeSelect>
            <Button variant='ghost' size='icon-xs' aria-label='Remove sort' onClick={() => setSort(sort.filter((_, j) => j !== i))}><Icons.close /></Button>
          </div>
        )) : <p className='text-muted-foreground text-xs leading-none'>No sort: rows keep their order.</p>}
        <div className='flex items-center gap-2'>
          <Button variant='ghost' size='xs' disabled={!free} onClick={() => free && setSort([...sort, { key: free.key, dir: 'asc' }])}><Icons.add /> Add sort</Button>
          {sort.length > 0 && <Button variant='ghost' size='xs' className='text-muted-foreground ml-auto' onClick={() => setSort([])}>Clear</Button>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Show or hide columns; the title column stays. */
export function PropertiesMenu<T>({ cols, hidden, setHidden }: { cols: RecordCol<T>[]; hidden: string[]; setHidden: (h: string[]) => void }) {
  const n = hidden.filter((k) => cols.some((c) => c.key === k && !c.title)).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant='ghost' size='sm' />}><IconColumns3 /> Properties{n ? ` · ${n} hidden` : ''}</DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='max-h-96 w-52'>
        {cols.map((c) => (
          <DropdownMenuCheckboxItem key={c.key} disabled={c.title} checked={c.title || !hidden.includes(c.key)} closeOnClick={false}
            onCheckedChange={(on) => setHidden(on ? hidden.filter((k) => k !== c.key) : [...hidden, c.key])}>
            {colName(c)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setHidden([])}>Show all</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setHidden(cols.filter((c) => !c.title).map((c) => c.key))}>Hide all</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** None, or any select column. */
export function GroupMenu<T>({ cols, group, setGroup }: { cols: RecordCol<T>[]; group: string | null; setGroup: (g: string | null) => void }) {
  const can = cols.filter((c) => c.type === 'select' && c.value);
  const cur = can.find((c) => c.key === group);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant='ghost' size='sm' className={cn(cur && 'text-primary')} />}><IconLayoutRows /> Group{cur ? `: ${colName(cur)}` : ''}</DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-48'>
        <DropdownMenuCheckboxItem checked={!cur} onCheckedChange={() => setGroup(null)}>None</DropdownMenuCheckboxItem>
        {can.map((c) => <DropdownMenuCheckboxItem key={c.key} checked={cur?.key === c.key} onCheckedChange={() => setGroup(c.key)}>{colName(c)}</DropdownMenuCheckboxItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Sort, group and columns in one popover, so the toolbar is just search, Filter, this and the primary action. */
export function ViewMenu<T>({ cols, sort, setSort, group, setGroup, hidden, setHidden, groupable, properties }: {
  cols: RecordCol<T>[]; sort: SortRule[]; setSort: (s: SortRule[]) => void;
  group: string | null; setGroup: (g: string | null) => void; hidden: string[]; setHidden: (h: string[]) => void;
  groupable?: boolean; properties?: boolean;
}) {
  const sortable = cols.filter(typed), groupBy = cols.filter((c) => c.type === 'select' && c.value);
  const first = sort[0], cur = groupBy.find((c) => c.key === group);
  const nHidden = hidden.filter((k) => cols.some((c) => c.key === k && !c.title)).length;
  const label = 'text-muted-foreground text-xs font-medium leading-none';
  return (
    <Popover>
      <PopoverTrigger render={<Button variant='ghost' size='icon' aria-label='View options' title='Sort, group and columns' />}>
        <IconAdjustmentsHorizontal />
      </PopoverTrigger>
      <PopoverContent align='end' className='flex w-72 flex-col gap-4'>
        {sortable.length > 0 && (
          <div className='flex flex-col gap-2'>
            <span className={label}>Sort by</span>
            <div className='flex items-center gap-2'>
              <NativeSelect size='sm' aria-label='Sort by' value={first?.key ?? ''} className='flex-1'
                onChange={(e) => setSort(e.target.value ? [{ key: e.target.value, dir: first?.dir ?? 'asc' }] : [])}>
                <NativeSelectOption value=''>Default order</NativeSelectOption>
                {sortable.map((c) => <NativeSelectOption key={c.key} value={c.key}>{colName(c)}</NativeSelectOption>)}
              </NativeSelect>
              <NativeSelect size='sm' aria-label='Direction' value={first?.dir ?? 'asc'} disabled={!first}
                onChange={(e) => first && setSort([{ ...first, dir: e.target.value as SortRule['dir'] }, ...sort.slice(1)])}>
                <NativeSelectOption value='asc'>Ascending</NativeSelectOption>
                <NativeSelectOption value='desc'>Descending</NativeSelectOption>
              </NativeSelect>
            </div>
          </div>
        )}
        {groupable && groupBy.length > 0 && (
          <div className='flex flex-col gap-2'>
            <span className={label}>Group by</span>
            <NativeSelect size='sm' aria-label='Group by' value={cur?.key ?? ''} onChange={(e) => setGroup(e.target.value || null)}>
              <NativeSelectOption value=''>No grouping</NativeSelectOption>
              {groupBy.map((c) => <NativeSelectOption key={c.key} value={c.key}>{colName(c)}</NativeSelectOption>)}
            </NativeSelect>
          </div>
        )}
        {properties && (
          <div className='flex flex-col gap-2'>
            <div className='flex items-center justify-between'>
              <span className={label}>Columns</span>
              {nHidden > 0 && <button type='button' className='text-primary text-xs leading-none hover:underline' onClick={() => setHidden([])}>Show all</button>}
            </div>
            <ul className='flex max-h-56 flex-col gap-0.5 overflow-y-auto'>
              {cols.map((c) => (
                <li key={c.key}>
                  <label className={cn('hover:bg-muted flex items-center gap-2 rounded px-1.5 py-1.5 text-sm leading-none', c.title ? 'opacity-60' : 'cursor-pointer')}>
                    <Checkbox disabled={c.title} checked={c.title || !hidden.includes(c.key)}
                      onCheckedChange={(on) => setHidden(on ? hidden.filter((k) => k !== c.key) : [...hidden, c.key])} />
                    <span className='truncate'>{colName(c)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

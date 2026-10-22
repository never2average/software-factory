'use client';
// A Notion-style database page: view tabs, a toolbar (full-width search, filters, sort, properties, group, the primary
// action), one paged table exactly the page's height that scrolls inside, a ⋯ menu of actions on each row, and a side peek.
// Clicking a row narrows the table to 40% and opens the record beside it; Escape or ✕ closes it, j/k walk the list. On
// small screens the record replaces the table, with a way back. Every database feature is opt-in, so simple pages stay simple.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconArrowDown, IconArrowUp } from '@tabler/icons-react';
import {
  applyFilters, colName, FilterButton, FilterChips, groupRows, ruleActive, sortRows, ViewMenu, typed,
  type FilterRule, type Group, type RecordCol, type RowAction, type SortRule
} from '@/components/layout/record-filters';
import { TablePager, usePaged } from '@/components/layout/table-pager';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { downloadCsv, today, type CsvValue } from '@/lib/csv';
import { cn } from '@/lib/utils';

export type { FilterRule, Op, PropType, RecordCol, RecordViewDef, RowAction, SortRule } from '@/components/layout/record-filters';
import type { RecordViewDef } from '@/components/layout/record-filters';

/** useState mirrored to localStorage under `key` (null: memory only). Loaded after mount so SSR markup matches; storage
 * can throw (private windows, blocked site data), so every read and write is guarded. */
export function useStored<V>(key: string | null, init: V): [V, (v: V | ((prev: V) => V)) => void] {
  const [v, setV] = useState<V>(init);
  useEffect(() => {
    if (!key) return;
    try { const s = localStorage.getItem(key); if (s !== null) setV(JSON.parse(s) as V); } catch { /* unreadable: keep init */ }
  }, [key]);
  const set = useCallback((n: V | ((prev: V) => V)) => setV((p) => {
    const next = typeof n === 'function' ? (n as (prev: V) => V)(p) : n;
    if (key) try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* not saved */ }
    return next;
  }), [key]);
  return [v, set];
}

// A page item: a row, or a collapsed group's header standing in for its rows.
interface Item<T> { row?: T; g?: Group<T> }
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function RecordView<T>({
  rows, rowKey, cols, searchText, searchPlaceholder = 'Search', filters, primary, detail, detailTitle, actions, empty, noun = 'items', loading, initialSize,
  id, views, defaultSort, groupable, bulk, exportName, primaryMenu, properties, detailActions, compact, openKey, onOpenChange, summary
}: {
  rows: readonly T[];
  rowKey: (row: T) => string;
  cols: RecordCol<T>[];
  /** The text a row is searched by; every word typed must appear in it. */
  searchText: (row: T) => string;
  searchPlaceholder?: string;
  filters?: ReactNode;
  primary?: ReactNode;
  /** The record, shown beside the table when a row is clicked; without it rows are not clickable. */
  detail?: (row: T, close: () => void) => ReactNode;
  detailTitle?: (row: T) => ReactNode;
  /** The row's ⋯ menu: toggles and actions live here, not in the cells. */
  actions?: (row: T) => RowAction[];
  empty: ReactNode;
  noun?: string;
  loading?: boolean;
  initialSize?: number;
  /** Saves columns, view, sort and group to localStorage under `rv:${id}:`. */
  id?: string;
  /** Tabs above the toolbar; the first is the default. */
  views?: RecordViewDef<T>[];
  defaultSort?: SortRule[];
  groupable?: boolean;
  /** Turns on the checkbox column and the bulk bar. */
  bulk?: (rows: T[], clear: () => void) => RowAction[];
  /** Turns on CSV export: `${exportName}-YYYY-MM-DD.csv`. */
  exportName?: string;
  /** Extra items in the primary's ▾ menu. */
  primaryMenu?: RowAction[];
  /** The peek lists every column as a property above detail(). */
  properties?: boolean;
  detailActions?: (row: T, close: () => void) => ReactNode;
  /** Inside a page with other content (a tab under a summary): as tall as its rows, at most most of the screen. */
  compact?: boolean;
  /** Controls which record is open (a deep link; a page that pauses refresh while one is); omitted, the view keeps it. */
  openKey?: string | null;
  onOpenChange?: (key: string | null) => void;
  /** Headline numbers between the toolbar and the table (a StatStrip or two). */
  summary?: ReactNode;
}) {
  const ns = (s: string) => (id ? `rv:${id}:${s}` : null);
  const [q, setQ] = useState('');
  const [openState, setOpenState] = useState<string | null>(null);
  const open = openKey !== undefined ? openKey : openState;
  const setOpen = (k: string | null) => { if (openKey === undefined) setOpenState(k); onOpenChange?.(k); };
  const [sortMap, setSortMap] = useStored<Record<string, SortRule[]>>(ns('sort'), {});
  const [groupMap, setGroupMap] = useStored<Record<string, string | null>>(ns('group'), {});
  const [hiddenStored, setHidden] = useStored<string[] | null>(ns('cols'), null);
  const [ruleMap, setRuleMap] = useState<Record<string, FilterRule[]>>({}); // per view, memory only
  const [editing, setEditing] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [sel, setSel] = useState<Set<string>>(() => new Set());

  // No view tabs: every table shows its first (whole) view; search and filters do the narrowing.
  const view = views?.[0];
  const vid = view?.id ?? '_';
  const presetSort = view?.sort ?? defaultSort ?? [];
  const sorts = isObj(sortMap) ? sortMap : {}, groups = isObj(groupMap) ? groupMap : {};
  const sort = Array.isArray(sorts[vid]) ? sorts[vid] : presetSort;
  const presetGroup = view?.group ?? null;
  const group = vid in groups ? groups[vid] : presetGroup;
  const rules = ruleMap[vid] ?? [];
  const hidden = (Array.isArray(hiddenStored) ? hiddenStored : cols.filter((c) => c.hidden).map((c) => c.key))
    .filter((k) => cols.some((c) => c.key === k && !c.title));
  const groupCol = cols.find((c) => c.key === group && c.type === 'select' && c.value);
  const setRules = (r: FilterRule[]) => setRuleMap((m) => ({ ...m, [vid]: r }));
  const setSort = (s: SortRule[]) => setSortMap({ ...sorts, [vid]: s });
  const setGroup = (g: string | null) => setGroupMap({ ...groups, [vid]: g });
  const addRule = (r: FilterRule) => { setRules([...rules, r]); setTimeout(() => setEditing(r.id), 0); };
  const dirty = rules.length > 0 || (Array.isArray(sorts[vid]) && JSON.stringify(sorts[vid]) !== JSON.stringify(presetSort)) || (vid in groups && groups[vid] !== presetGroup);
  const reset = () => {
    setRules([]);
    const { [vid]: _s, ...s } = sorts; setSortMap(s);
    const { [vid]: _g, ...g } = groups; setGroupMap(g);
  };

  // rows → view → search → filters → sort → group order; the pager pages the flattened list.
  const data = useMemo(() => {
    const base = view?.match ? rows.filter(view.match) : rows.slice();
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const searched = words.length ? base.filter((r) => { const t = searchText(r).toLowerCase(); return words.every((w) => t.includes(w)); }) : base;
    const sorted = sortRows(applyFilters(searched, cols, rules), cols, sort);
    const gs = groupCol ? groupRows(sorted, groupCol) : null;
    const items: Item<T>[] = gs ? gs.flatMap((g) => (collapsed.has(g.value) ? [{ g }] : g.rows.map((row) => ({ row, g })))) : sorted.map((row) => ({ row }));
    return { base: base.length, ordered: gs ? gs.flatMap((g) => g.rows) : sorted, items };
  }, [rows, view, q, searchText, cols, rules, sort, groupCol, collapsed]);
  const page = usePaged(data.items, initialSize);

  // Selection survives paging; keys that drop out of the filtered set are pruned.
  const live = useMemo(() => new Set(data.ordered.map(rowKey)), [data.ordered, rowKey]);
  useEffect(() => { setSel((s) => { const n = new Set([...s].filter((k) => live.has(k))); return n.size === s.size ? s : n; }); }, [live]);
  const selRows = data.ordered.filter((r) => sel.has(rowKey(r)));
  const clearSel = () => setSel(new Set());
  const pageKeys = page.rows.flatMap((i) => (i.row ? [rowKey(i.row)] : []));
  const allOnPage = pageKeys.length > 0 && pageKeys.every((k) => sel.has(k)), someOnPage = pageKeys.some((k) => sel.has(k));
  const toggle = (keys: string[], on: boolean) => setSel((s) => { const n = new Set(s); keys.forEach((k) => (on ? n.add(k) : n.delete(k))); return n; });

  const current = open ? rows.find((r) => rowKey(r) === open) : undefined;
  const close = () => setOpen(null);

  // ↑ ↓ walk the rows as listed (collapsed groups skipped), turning the page when needed.
  const navRows = data.items.flatMap((i) => (i.row ? [i.row] : []));
  const at = current ? navRows.indexOf(current) : -1;
  const go = (d: number) => {
    const next = navRows[at + d];
    if (at < 0 || !next) return;
    setOpen(rowKey(next));
    const i = data.items.findIndex((x) => x.row === next);
    page.setPage(Math.floor(i / page.size) + 1);
  };
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    onKey.current = (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest?.('input,textarea,select') || t.isContentEditable)) return;
      if (document.querySelector('[role=dialog]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') setOpen(null);
      else if (!database) return; // simple pages: Escape only, as before
      else if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); go(1); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); go(-1); }
    };
  });
  const hasCurrent = !!current;
  useEffect(() => {
    if (!hasCurrent) return;
    const h = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [hasCurrent]);

  const shownCols = cols.filter((c) => !hidden.includes(c.key));
  // Beside an open record the table is a narrow list: the title and one more column, truncated rather than clipped.
  const narrow = Boolean(current && detail);
  const titled = shownCols.filter((c) => c.title), kept = shownCols.filter((c) => c.keep && !c.title);
  const visible = narrow ? (titled.length ? [...titled, ...kept.slice(0, 1)] : kept.slice(0, 2)) : shownCols;
  const span = visible.length + (actions ? 1 : 0) + (bulk ? 1 : 0);
  const anyTyped = cols.some(typed);
  // Simple pages (no id, views or typed columns) keep today's toolbar exactly.
  const database = !!id || !!views || anyTyped || cols.some((c) => c.hidden || c.title);
  const searching = !!q.trim() || rules.some(ruleActive);
  const narrowed = searching;
  const clearAll = () => { setQ(''); setRuleMap({}); };

  // CSV: every shown column; value() when given, else render() when it is plain text, else the column is skipped.
  const exportRows = (list: readonly T[], suffix = '') => {
    const sample = rows[0];
    const csvCols = shownCols.filter((c) => c.csv !== false && (c.value || (sample !== undefined && ['string', 'number'].includes(typeof c.render(sample)))));
    const cell = (c: RecordCol<T>, r: T): CsvValue => { if (c.value) return c.value(r); const x = c.render(r); return typeof x === 'string' || typeof x === 'number' ? x : ''; };
    downloadCsv(`${exportName}${suffix}-${today()}.csv`, csvCols.map(colName), list.map((r) => csvCols.map((c) => cell(c, r))));
  };
  const menuItems = primaryMenu?.length || exportName ? (<>
    {primaryMenu?.map((a, i) => <MenuItem key={i} a={a} sep={i > 0} />)}
    {!!primaryMenu?.length && exportName && <DropdownMenuSeparator />}
    {exportName && (<>
      <DropdownMenuItem onClick={() => exportRows(data.ordered)}><Icons.download /> Export CSV ({data.ordered.length} rows)</DropdownMenuItem>
      <DropdownMenuItem onClick={() => exportRows(rows, '-all')}><Icons.download /> Export all ({rows.length} rows)</DropdownMenuItem>
    </>)}
  </>) : null;
  const primaryNode = menuItems && !primary ? (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size='icon' variant='ghost' aria-label='Export' title='Export' />}><Icons.download /></DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-56'>{menuItems}</DropdownMenuContent>
    </DropdownMenu>
  ) : menuItems ? (
    <ButtonGroup>
      {primary || (exportName && <Button variant='outline' onClick={() => exportRows(data.ordered)}><Icons.download /> Export CSV</Button>)}
      <DropdownMenu>
        <DropdownMenuTrigger render={primary
          ? <Button size='icon' aria-label='More actions' className='border-primary-foreground/20 border-l' />
          : <Button size='icon' variant='outline' aria-label='More export options' />}>
          <Icons.chevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' className='w-56'>{menuItems}</DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  ) : primary;

  const sortDir = (k: string) => sort.find((s) => s.key === k)?.dir;
  const cycle = (k: string) => {
    const d = sort.length === 1 && sort[0].key === k ? sort[0].dir : null;
    setSort(d === 'asc' ? [{ key: k, dir: 'desc' }] : d === 'desc' ? [] : [{ key: k, dir: 'asc' }]);
  };
  const titleCol = cols.find((c) => c.title);
  const bulkItems = bulk && selRows.length ? bulk(selRows, clearSel) : [];
  // compact: fill from where the table starts to the bottom of the window (content above it, like a summary and tabs,
  // varies), so the page itself never scrolls; re-measured on resize.
  const fitRef = useRef<HTMLDivElement>(null);
  const [fitH, setFitH] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!compact) return;
    const fit = () => { const el = fitRef.current; if (el && el.offsetParent !== null) setFitH(Math.max(256, window.innerHeight - (el.getBoundingClientRect().top + window.scrollY) - 24)); };
    fit();
    window.addEventListener('resize', fit);
    // A table in a tab that starts hidden measures as if at the top: measure again once it is shown.
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) fit(); });
    if (fitRef.current) io.observe(fitRef.current);
    return () => { window.removeEventListener('resize', fit); io.disconnect(); };
  }, [compact]);

  return (
    // Fills the page below the header (header 3.5–4rem plus the page's padding): the table frame never scrolls or shrinks.
    <div ref={fitRef} style={compact && fitH ? { height: fitH } : undefined} className={cn('flex min-w-0 flex-col gap-3', compact ? 'min-h-[16rem]' : 'h-[calc(100svh-5.5rem)] min-h-[24rem]')}>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='relative min-w-48 flex-1'>
          <Icons.search className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
          <Input type='search' value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder} className='h-9 pl-8' />
        </div>
        {filters}
        {anyTyped && <FilterButton cols={cols} count={rules.filter(ruleActive).length} onAdd={addRule} />}
        {(anyTyped || groupable || (database && cols.length > 3)) && (
          <ViewMenu cols={cols} sort={sort} setSort={setSort} group={groupCol?.key ?? null} setGroup={setGroup}
            hidden={hidden} setHidden={setHidden} groupable={groupable} properties={database && cols.length > 3} />
        )}
        {primaryNode}
      </div>
      {summary && <div className='flex shrink-0 flex-col'>{summary}</div>}

      {selRows.length > 0 ? (
        <div className='flex min-h-8 shrink-0 flex-wrap items-center gap-1 text-sm leading-none'>
          <span className='mr-2 font-medium tabular-nums'>{selRows.length} selected</span>
          {bulkItems.map((a, i) => (
            <Button key={i} variant='ghost' size='sm' disabled={a.disabled} title={a.hint} onClick={a.onSelect} className={cn(a.destructive && 'text-destructive hover:text-destructive')}>{a.icon}{a.label}</Button>
          ))}
          {exportName && <Button variant='ghost' size='sm' onClick={() => exportRows(selRows, '-selected')}><Icons.download /> Export selected</Button>}
          <Button variant='ghost' size='sm' className='text-muted-foreground ml-auto' onClick={clearSel}>Clear</Button>
        </div>
      ) : rules.length > 0 && (
        <div className='flex min-h-8 shrink-0 items-center gap-2'>
          <FilterChips cols={cols} rows={rows} rules={rules} setRules={setRules} editing={editing} setEditing={setEditing} />
          {(!views || dirty) && <Button variant='ghost' size='xs' className='text-muted-foreground ml-auto' onClick={reset}>Reset</Button>}
        </div>
      )}

      <div className='flex min-h-0 flex-1 gap-4'>
        <div className={cn('flex min-h-0 min-w-0 flex-col border', current ? 'hidden lg:flex lg:w-[40%] lg:shrink-0' : 'w-full')}>
          <div className='min-h-0 flex-1 overflow-auto'>
            <Table className={cn(narrow && 'table-fixed')}>
              <TableHeader className='bg-background sticky top-0 z-10 shadow-[0_1px_0_var(--border)]'>
                <TableRow>
                  {bulk && (
                    <TableHead className='w-8'>
                      <Checkbox aria-label='Select all on this page' checked={allOnPage} indeterminate={!allOnPage && someOnPage}
                        onCheckedChange={(on) => toggle(pageKeys, !!on)} />
                    </TableHead>
                  )}
                  {visible.map((c) => {
                    const d = sortDir(c.key);
                    return (
                      <TableHead key={c.key} className={cn('px-3', c.className)} aria-sort={d === 'asc' ? 'ascending' : d === 'desc' ? 'descending' : undefined}>
                        {typed(c) ? (
                          <button type='button' onClick={() => cycle(c.key)} className='hover:text-foreground inline-flex min-h-6 items-center gap-1 leading-none'>
                            {c.label}{d === 'asc' ? <IconArrowUp className='size-3' /> : d === 'desc' ? <IconArrowDown className='size-3' /> : null}
                          </button>
                        ) : c.label}
                      </TableHead>
                    );
                  })}
                  {actions && <TableHead className='w-10'><span className='sr-only'>Actions</span></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={span} className='text-muted-foreground py-12 text-center'>Loading…</TableCell></TableRow>
                ) : data.items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={span} className='text-muted-foreground py-12 text-center whitespace-normal'>
                      {narrowed ? (
                        <span className='inline-flex items-center gap-2 leading-none'>Nothing matches.{(searching || views) && <Button variant='link' size='sm' className='h-auto p-0' onClick={clearAll}>Clear filters</Button>}</span>
                      ) : empty}
                    </TableCell>
                  </TableRow>
                ) : page.rows.map((it, i) => {
                  const head = it.g && (i === 0 || page.rows[i - 1].g !== it.g);
                  const r = it.row, k = r ? rowKey(r) : '';
                  return (
                    <Fragment key={r ? k : `g:${it.g!.value}`}>
                      {head && it.g && (
                        <TableRow className='bg-muted/30 hover:bg-muted/30'>
                          <TableCell colSpan={span} className='py-1.5'>
                            <button type='button' className='flex min-h-6 items-center gap-1.5 text-xs font-medium leading-none'
                              onClick={() => setCollapsed((s) => { const n = new Set(s); if (!n.delete(it.g!.value)) n.add(it.g!.value); return n; })}>
                              <Icons.chevronRight className={cn('size-3.5 transition-transform', !collapsed.has(it.g.value) && 'rotate-90')} />
                              {it.g.label}<span className='text-muted-foreground tabular-nums'>{it.g.rows.length}</span>
                            </button>
                          </TableCell>
                        </TableRow>
                      )}
                      {r && (
                        <TableRow data-state={open === k ? 'selected' : undefined}
                          className={cn('align-top', detail && 'cursor-pointer', sel.has(k) && open !== k && 'bg-muted/40')}
                          onClick={detail ? () => setOpen(open === k ? null : k) : undefined}
                          onKeyDown={detail ? (e) => { if (e.key === 'Enter') setOpen(k); } : undefined}
                          tabIndex={detail ? 0 : undefined}>
                          {bulk && (
                            <TableCell className='w-8 py-3' onClick={(e) => e.stopPropagation()}>
                              <Checkbox aria-label='Select row' checked={sel.has(k)} onCheckedChange={(on) => toggle([k], !!on)} />
                            </TableCell>
                          )}
                          {visible.map((c) => <TableCell key={c.key} className={cn('px-3 py-3.5', narrow ? 'overflow-hidden text-ellipsis whitespace-nowrap [&>*]:truncate' : 'whitespace-normal', c.className)}>{c.render(r)}</TableCell>)}
                          {actions && <TableCell className='w-10 py-1.5 text-center' onClick={(e) => e.stopPropagation()}><ActionsMenu items={actions(r)} /></TableCell>}
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <TablePager p={page} noun={noun} className='border-t px-2' count={data.ordered.length} of={searching ? data.base : undefined} />
        </div>

        {current && detail && (
          <aside aria-label='Record' className='bg-card flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border lg:w-[60%]'>
            <div className='flex items-center gap-2 border-b px-5 py-3'>
              <Button variant='ghost' size='icon-sm' className='lg:hidden' aria-label='Back to the list' onClick={close}><Icons.chevronLeft /></Button>
              <div className='min-w-0 flex-1 truncate leading-none font-semibold'>{detailTitle ? detailTitle(current) : titleCol?.render(current)}</div>
              {detailActions?.(current, close)}
              {at >= 0 && database && (<>
                <Button variant='ghost' size='icon-sm' aria-label='Previous record' disabled={at <= 0} onClick={() => go(-1)}><Icons.chevronUp /></Button>
                <Button variant='ghost' size='icon-sm' aria-label='Next record' disabled={at >= navRows.length - 1} onClick={() => go(1)}><Icons.chevronDown /></Button>
              </>)}
              <Button variant='ghost' size='icon-sm' aria-label='Close' onClick={close}><Icons.close /></Button>
            </div>
            <div className='min-h-0 flex-1 overflow-y-auto p-5'>
              {properties && (<>
                <dl>{cols.filter((c) => c.peek !== false).map((c) => <Field key={c.key} label={colName(c)}>{c.render(current)}</Field>)}</dl>
                <Separator className='my-4' />
              </>)}
              {detail(current, close)}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function MenuItem({ a, sep }: { a: RowAction; sep: boolean }) {
  return (<>
    {a.separator && sep && <DropdownMenuSeparator />}
    <DropdownMenuItem disabled={a.disabled} onClick={a.onSelect} className={cn(a.destructive && 'text-destructive focus:text-destructive')}>{a.icon}{a.label}
      {a.hint && <span className='text-muted-foreground ml-auto pl-3 text-xs'>{a.hint}</span>}</DropdownMenuItem>
  </>);
}

/** A ⋯ menu of actions: on each table row, and on sub-table rows inside a peek. */
export function ActionsMenu({ items, align = 'end', label = 'Actions' }: { items: RowAction[]; align?: 'start' | 'center' | 'end'; label?: string }) {
  if (!items.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant='ghost' size='icon-sm' aria-label={label} />}><Icons.dots /></DropdownMenuTrigger>
      <DropdownMenuContent align={align} className='w-48'>
        {items.map((a, i) => <MenuItem key={i} a={a} sep={i > 0} />)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A label / value pair for a record's side panel. */
export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className='grid items-center gap-1.5 border-b py-3 leading-none last:border-b-0 sm:grid-cols-[10rem_1fr] sm:gap-4'>
      <dt className='text-muted-foreground text-xs font-medium'>{label}</dt>
      <dd className='min-w-0 text-sm break-words'>{children}</dd>
    </div>
  );
}

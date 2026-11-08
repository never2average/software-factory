'use client';
// A Notion-style database page: headline numbers (the summary: a list tab's four cards) first, then view tabs, a toolbar (full-width search, filters, sort, properties, group, export,
// then the page's primary action at its right end), one paged table exactly the page's height that scrolls inside, a ⋯ menu of actions on each row, and the record panel.
// mold_v0-278: clicking a row never leaves the page: the list narrows and the record opens in a panel at its right
// (./detail-panel.tsx: a splitter, Expand / Collapse, the ⋯ menu with Open in its own page, ✕ and Esc, Back to list on
// a phone), the open row highlighted and kept in the address (?id=<key>, &panel=full, &panelTab=); another row switches
// it, ↑ ↓ (j k) walk the rows. Every database feature is opt-in, so simple pages stay simple.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { parseAsString, useQueryStates } from 'nuqs';
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
import { RecordPanel, guarded, usePanelSplit } from '@/components/layout/detail-panel';
import { DETAIL_PARAM, PANEL_FULL, PANEL_PARAM, PANEL_TAB_PARAM, type PanelKind } from '@/lib/split-panel';
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

/** mold_v0-260: a wide list's table: its natural width (at least the frame's), the first column sticky with its own background and a line. */
const WIDE_TABLE = 'w-max min-w-full [&_td]:max-w-72 [&_tr>*:first-child]:sticky [&_tr>*:first-child]:left-0 [&_tr>*:first-child]:z-[1] [&_td:first-child]:bg-background [&_tr[data-state=selected]>td:first-child]:bg-muted [&_th:first-child]:bg-background [&_tr>*:first-child]:shadow-[1px_0_0_var(--border)]';

export function RecordView<T>({
  rows, rowKey, cols, searchText, searchPlaceholder = 'Search', filters, primary, detail, detailTitle, actions, empty, noun = 'items', loading, initialSize,
  id, views, defaultSort, groupable, bulk, exportName, primaryMenu, properties, panelActions, panelMenu, pageHref, panelKind = 'detail', compact, openKey, onOpenChange, summary, toolbarAction, initialRules, onRulesChange, wide
}: {
  /**
   * mold_v0-260 (flag wide_lists): a list of more than 8 columns: the table keeps each column's width and scrolls sideways
   * inside its own frame (never the page), its first column kept in view.
   */
  wide?: boolean;
  rows: readonly T[];
  rowKey: (row: T) => string;
  cols: RecordCol<T>[];
  /** The text a row is searched by; every word typed must appear in it. */
  searchText: (row: T) => string;
  searchPlaceholder?: string;
  filters?: ReactNode;
  /** The toolbar's own action (Export); a function is given the view: its rows as shown and whether search or a filter narrows them. */
  primary?: ReactNode | ((view: { rows: readonly T[]; narrowed: boolean }) => ReactNode);
  /** The record, shown in the panel beside the table when a row is clicked (mold_v0-278); without it rows are not clickable. */
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
  /** The panel lists every column as a property above detail() (a function: for the rows it says). */
  properties?: boolean | ((row: T) => boolean);
  /** mold_v0-278: the open record's actions, the panel's ⋯ menu (before the row's own ⋯ items and Open in its own page). */
  panelActions?: (row: T, close: () => void) => RowAction[];
  /** A ⋯ menu of its own (a component reading the record's own data), given the items the panel would show. */
  panelMenu?: (row: T, items: RowAction[], close: () => void) => ReactNode;
  /** The record's own page: the ⋯ menu's "Open in its own page" (Expand shows it at the list's full width in place). */
  pageHref?: (row: T) => string | null;
  /** An editor (half the width at first) or details (40%). */
  panelKind?: PanelKind;
  /** Inside a page with other content (a tab under a summary): as tall as its rows, at most most of the screen. */
  compact?: boolean;
  /** Controls which record is open (a page's own address parameter); omitted, the view keeps it in the address as ?id=<key>. */
  openKey?: string | null;
  onOpenChange?: (key: string | null) => void;
  /**
   * Headline numbers above the toolbar (a StatStrip or two; a list tab's four cards). mold_v0-208: every list reads cards,
   * then the search row, then the table (before, the cards sat between the toolbar and the table).
   */
  summary?: ReactNode;
  /**
   * The page's primary action (mold_v0-208, features/tabs/tab-action.tsx): mold_v0-217, the last control of the search
   * row, at its right end (a primary button; the icon alone on a phone), opening its form as a full card in the list's place.
   */
  toolbarAction?: ReactNode;
  /** Filters on at first (mold_v0-217: an address's, e.g. ?overdue=1), and every change to them. */
  initialRules?: FilterRule[];
  onRulesChange?: (rules: FilterRule[]) => void;
}) {
  const ns = (s: string) => (id ? `rv:${id}:${s}` : null);
  const [q, setQ] = useState('');
  // mold_v0-278: the open row is the address's ?id=<key> (a reload or a shared link reopens it), &panel=full expands it;
  // a page that names its own parameter (openKey) keeps it, and its Expand is the view's own.
  const [url, setUrl] = useQueryStates({ [DETAIL_PARAM]: parseAsString, [PANEL_PARAM]: parseAsString, [PANEL_TAB_PARAM]: parseAsString }, { history: 'replace', scroll: false });
  const controlled = openKey !== undefined;
  const [ownExpanded, setOwnExpanded] = useState(false);
  const open = controlled ? openKey : url[DETAIL_PARAM] ?? null;
  const expanded = controlled ? ownExpanded : url[PANEL_PARAM] === PANEL_FULL;
  const setExpanded = (v: boolean) => (controlled ? setOwnExpanded(v) : void setUrl({ [PANEL_PARAM]: v ? PANEL_FULL : null }));
  const setOpen = (k: string | null) => {
    if (!controlled) void setUrl(k ? { [DETAIL_PARAM]: k } : { [DETAIL_PARAM]: null, [PANEL_PARAM]: null, [PANEL_TAB_PARAM]: null });
    else if (!k) setOwnExpanded(false);
    onOpenChange?.(k);
  };
  const [sortMap, setSortMap] = useStored<Record<string, SortRule[]>>(ns('sort'), {});
  const [groupMap, setGroupMap] = useStored<Record<string, string | null>>(ns('group'), {});
  const [hiddenStored, setHidden] = useStored<string[] | null>(ns('cols'), null);
  const [ruleMap, setRuleMap] = useState<Record<string, FilterRule[]>>(() => (initialRules?.length ? { [views?.[0]?.id ?? '_']: initialRules } : {})); // per view, memory only
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
  const setRules = (r: FilterRule[]) => { setRuleMap((m) => ({ ...m, [vid]: r })); onRulesChange?.(r); };
  // Rules the address turns on (initialRules) may arrive after the first render (the address read on the client):
  // each is added once, when it first appears.
  const initialKey = JSON.stringify(initialRules ?? []);
  useEffect(() => {
    if (!initialRules?.length) return;
    setRuleMap((m) => {
      const have = m[vid] ?? [];
      const add = initialRules.filter((r) => !have.some((x) => x.id === r.id));
      return add.length ? { ...m, [vid]: [...have, ...add] } : m;
    });
  }, [initialKey, vid]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // The panel's close asks first when an editor in it has unsaved changes, then focuses the row again.
  const panelClose = useRef<(() => void) | null>(null);
  const close = () => (panelClose.current ? panelClose.current() : setOpen(null));
  const hostRef = useRef<HTMLDivElement>(null);
  const showRecord = Boolean(current && detail);
  const split = usePanelSplit(hostRef, showRecord, `${id ?? noun}`, panelKind, expanded);
  const openRow = (k: string) => { if (k !== open) guarded(() => setOpen(k)); };

  // ↑ ↓ walk the rows as listed (collapsed groups skipped), turning the page when needed.
  const navRows = data.items.flatMap((i) => (i.row ? [i.row] : []));
  const at = current ? navRows.indexOf(current) : -1;
  const go = (d: number) => {
    const next = navRows[at + d];
    if (at < 0 || !next) return;
    const k = rowKey(next);
    guarded(() => {
      setOpen(k);
      const i = data.items.findIndex((x) => x.row === next);
      page.setPage(Math.floor(i / page.size) + 1);
      // Focus follows the open row (it was on a row: the list's keyboard).
      requestAnimationFrame(() => {
        if (!(document.activeElement as HTMLElement | null)?.closest?.('[data-row-key]')) return;
        hostRef.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(k)}"]`)?.focus();
      });
    });
  };
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    onKey.current = (e) => {
      const t = e.target as HTMLElement | null;
      if (e.defaultPrevented || (t && (t.closest?.('input,textarea,select,[role=separator],[data-slot=detail-panel]') || t.isContentEditable))) return;
      if (document.querySelector('[role=dialog],[role=alertdialog],[role=menu]') || e.metaKey || e.ctrlKey || e.altKey) return;
      // Esc is the panel's own (./detail-panel.tsx: it asks first when something is unsaved, then focuses the row).
      if (!database) return; // simple pages: Escape only, as before
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
  const visible = shownCols;
  const span = visible.length + (actions ? 1 : 0) + (bulk ? 1 : 0);
  const anyTyped = cols.some(typed);
  // Simple pages (no id, views or typed columns) keep today's toolbar exactly.
  const database = !!id || !!views || anyTyped || cols.some((c) => c.hidden || c.title);
  const searching = !!q.trim() || rules.some(ruleActive);
  const narrowed = searching;
  const clearAll = () => { setQ(''); setRuleMap({}); onRulesChange?.([]); };

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
  const primaryEl: ReactNode = typeof primary === 'function' ? primary({ rows: data.ordered, narrowed: searching }) : primary;
  const primaryNode = menuItems && !primaryEl ? (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size='icon' variant='ghost' aria-label='Export' title='Export' />}><Icons.download /></DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-56'>{menuItems}</DropdownMenuContent>
    </DropdownMenu>
  ) : menuItems ? (
    <ButtonGroup>
      {primaryEl || (exportName && <Button variant='outline' onClick={() => exportRows(data.ordered)}><Icons.download /> Export CSV</Button>)}
      <DropdownMenu>
        <DropdownMenuTrigger render={primaryEl
          ? <Button size='icon' aria-label='More actions' className='border-l-primary-foreground/20 border-l' />
          : <Button size='icon' variant='outline' aria-label='More export options' />}>
          <Icons.chevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' className='w-56'>{menuItems}</DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  ) : primaryEl;

  const sortDir = (k: string) => sort.find((s) => s.key === k)?.dir;
  const cycle = (k: string) => {
    const d = sort.length === 1 && sort[0].key === k ? sort[0].dir : null;
    setSort(d === 'asc' ? [{ key: k, dir: 'desc' }] : d === 'desc' ? [] : [{ key: k, dir: 'asc' }]);
  };
  const titleCol = cols.find((c) => c.title);
  // The panel's header: the title; the ⋯ menu: the record's own actions, the row's ⋯ items, then Open in its own page.
  const panelTitle: ReactNode = current ? (detailTitle ? detailTitle(current) : titleCol?.render(current)) : null;
  const href = current && pageHref ? pageHref(current) : null;
  const own = current ? panelActions?.(current, close) ?? [] : [];
  const rowItems = (current && actions ? actions(current) : []).filter((a) => !own.some((x) => x.label === a.label));
  const panelItems: RowAction[] = [...own, ...rowItems.map((a, i) => (i === 0 && own.length ? { ...a, separator: true } : a)),
    ...(href ? [{ label: 'Open in its own page', icon: <Icons.externalLink />, href, separator: true }] : [])];
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
  }, [compact, showRecord]);

  return (
    // Fills the page below the header (header 3.5–4rem plus the page's padding): the table frame never scrolls or shrinks.
    // mold_v0-278: the list and, when a row is open, the record panel at its right (the list's column narrows).
    <div ref={hostRef} style={compact && fitH ? { height: fitH } : undefined} data-slot='list-split' data-panel-open={showRecord || undefined}
      className={cn('flex min-w-0 items-stretch', compact ? 'min-h-[16rem]' : 'h-[calc(100svh-5.5rem)] min-h-[24rem]')}>
    <div ref={fitRef} data-slot='list-main' className={cn('flex min-h-0 min-w-0 flex-1 flex-col gap-3', split.layout?.full && 'lg:hidden')}>
      {summary && <div className='flex shrink-0 flex-col'>{summary}</div>}
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
        {toolbarAction}
      </div>

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
        <div className='flex min-h-0 w-full min-w-0 flex-col border'>
          <div className='flex min-h-0 flex-1 flex-col overflow-auto' {...(wide ? { 'data-wide-list': '' } : {})}>
            <Table className={wide ? WIDE_TABLE : undefined}>
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
                          // A column heading is plain text that sorts on click, never an outlined button (operator rule, mold_v0-250).
                          <button type='button' data-column-header='' onClick={() => cycle(c.key)} className='text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1 rounded-sm font-medium focus:outline-none focus-visible:ring-1'>
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
                {loading || data.items.length === 0 ? null : page.rows.map((it, i) => {
                  const head = it.g && (i === 0 || page.rows[i - 1].g !== it.g);
                  const r = it.row, k = r ? rowKey(r) : '';
                  return (
                    <Fragment key={r ? k : `g:${it.g!.value}`}>
                      {head && it.g && (
                        <TableRow className='bg-muted/30 hover:bg-muted/30'>
                          <TableCell colSpan={span} className='py-0.5'>
                            <Button variant='ghost' size='xs' className='-ml-1 gap-1.5'
                              onClick={() => setCollapsed((s) => { const n = new Set(s); if (!n.delete(it.g!.value)) n.add(it.g!.value); return n; })}>
                              <Icons.chevronRight className={cn('size-3.5 transition-transform', !collapsed.has(it.g.value) && 'rotate-90')} />
                              {it.g.label}<span className='text-muted-foreground tabular-nums'>{it.g.rows.length}</span>
                            </Button>
                          </TableCell>
                        </TableRow>
                      )}
                      {r && (
                        <TableRow data-state={open === k ? 'selected' : undefined} data-row-key={detail ? k : undefined} aria-current={detail && open === k ? 'true' : undefined}
                          className={cn('align-top', detail && 'cursor-pointer', sel.has(k) && open !== k && 'bg-muted/40')}
                          // mold_v0-278: a row opens its record in the panel beside the list (never a page of its own).
                          onClick={detail ? (e) => { if ((e.target as HTMLElement).closest('a[href]')) return; openRow(k); } : undefined}
                          onKeyDown={detail ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openRow(k); } : undefined}
                          tabIndex={detail ? 0 : undefined}>
                          {bulk && (
                            <TableCell className='w-8 py-3' onClick={(e) => e.stopPropagation()}>
                              <Checkbox aria-label='Select row' checked={sel.has(k)} onCheckedChange={(on) => toggle([k], !!on)} />
                            </TableCell>
                          )}
                          {visible.map((c) => <TableCell key={c.key} className={cn('px-3 py-3.5', 'whitespace-normal', c.className)}>{c.render(r)}</TableCell>)}
                          {actions && <TableCell className='w-10 py-1.5 text-center' onClick={(e) => e.stopPropagation()}><ActionsMenu items={actions(r)} /></TableCell>}
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
            {/* Loading and the empty state fill the whole table area below the headings (operator, 2026-11-08), centred. */}
            {(loading || data.items.length === 0) && (
              <div className='text-muted-foreground flex flex-1 items-center justify-center px-6 py-12 text-center text-sm whitespace-normal' data-list-empty={loading ? undefined : ''}>
                {loading ? 'Loading…' : narrowed ? (
                  <span className='inline-flex items-center gap-2 leading-none'>Nothing matches.{(searching || views) && <Button variant='outline' size='xs' onClick={clearAll}>Clear filters</Button>}</span>
                ) : <div className='max-w-xl'>{empty}</div>}
              </div>
            )}
          </div>
          <TablePager p={page} noun={noun} className='border-t px-2' count={data.ordered.length} of={searching ? data.base : undefined} />
        </div>

      </div>
    </div>
      {current && detail && (
        <RecordPanel hostRef={hostRef} split={split} type={id ?? noun} rowKey={open!} title={panelTitle}
          name={typeof panelTitle === 'string' && panelTitle ? panelTitle : 'Record'} items={panelItems} menu={panelMenu?.(current, panelItems, close)}
          expanded={expanded} onExpandedChange={setExpanded} onClose={() => setOpen(null)} closeRef={(c) => { panelClose.current = c; }}>
          {(typeof properties === 'function' ? properties(current) : properties) && (<>
            <dl>{cols.filter((c) => c.peek !== false).map((c) => <Field key={c.key} label={colName(c)}>{c.render(current)}</Field>)}</dl>
            <Separator className='mb-4' />
          </>)}
          <div key={open!} className='pb-4' data-record-body=''>{detail(current, close)}</div>
        </RecordPanel>
      )}
    </div>
  );
}

function MenuItem({ a, sep }: { a: RowAction; sep: boolean }) {
  return (<>
    {a.separator && sep && <DropdownMenuSeparator />}
    <DropdownMenuItem disabled={a.disabled} onClick={a.onSelect} render={a.href && !a.disabled ? <Link href={a.href} /> : undefined} className={cn(a.destructive && 'text-destructive focus:text-destructive')}>{a.icon}{a.label}
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

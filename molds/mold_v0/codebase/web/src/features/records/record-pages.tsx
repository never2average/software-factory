'use client';
// The shell's generic record-area pages (mold_v0-047): a list page and a detail page for every area a pack declares in
// definePack({ recordAreas }), with no pack code. Labels and columns come from the generated registry
// (web/src/config/pack-nav.generated.ts); rows from /api/records (a workspace's view: shared areas and its own) or
// /api/admin/records (platform staff: the shared areas). The lists read; a workspace adds records through an area's own
// lists' primary action (mold_v0-237: AreaRecordList, its Settings tab and its Records page, as an area tab's).
// The list is the console's database table (RecordView, as on Accounts; mold_v0-170), and so is every customer list of
// an area's records (mold_v0-176: RecordTableView, which a pack's area tab draws too, features/tabs/tab-page.tsx).
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { useQueryState } from 'nuqs';
import { parseAsFlag } from '@/lib/query-flag';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { RecordAreaSpec, RecordFieldSpec } from '@/config/pack-nav.generated';
import { Field, RecordView, type PropType, type RecordCol, type SortRule } from '@/components/layout/record-view';
import type { FilterRule, RawValue } from '@/components/layout/record-filters';
import { useRepositories } from '@/features/admin/repositories';
import { EmptyState } from '@/features/tabs/empty';
import { cn } from '@/lib/utils';
import { recordEmptyText, repoOf } from './empty';
import { ErrorState, LoadingCards, useOrgLoad } from '@/features/portal/shared';
import { areaFieldLabel, findRecordArea, recordsApi } from './registry';
import { ExportCsvButton } from '@/features/tabs/export';
import { httpError } from '@/features/status/from-error';
import { ClockSection, clockColumns, isOverdue, type ClockEvent, type ClockView } from './clocks';
import { RecordDocuments, isStoredFile } from './documents';
import { Sparklines } from '@/features/tabs/sparklines';
import { isWebAddress, useAreaAction } from '@/features/tabs/tab-action';

/** A row of an area's list; a merged tab's row (mold_v0-135) also names the areas that hold its key, in the tab's order. */
export type RecordRow = { key: string; title: string | null; data: Record<string, unknown>; version?: string | null; updated_at: string; areas?: string[]; clocks?: Record<string, ClockView>;
  /** A shared row on the staff pages (mold_v0-221, src/record-areas.ts Provenance): staff's or its repository's, and what a staff override stands over. */
  provenance?: Provenance };
export type Provenance = { by: 'staff' | 'repository'; repository: string | null; overrides: { title: string | null; version: string | null } | null };
export type Page = { records: RecordRow[]; next: string | null };
type Detail = { record: RecordRow; links: { field: string; area: string; records: { key: string; title: string | null }[] }[]; clock_events?: ClockEvent[];
  /** A workspace record's writer (mold_v0-236, src/record-areas.ts RowProvenance): where it came from. */
  provenance?: { by: 'staff' | 'people' | 'repository' | 'intake' | 'run' | null; written_by: string | null; updated_by: string | null } };
/** Where a workspace record came from, in words (mold_v0-236). */
const ADDED_BY: Record<string, string> = { people: 'A person of this workspace', staff: 'Platform staff', intake: 'The email intake', run: "The app's own automation", repository: 'Its data source' };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, body);
  return body;
}

const cell = (v: unknown) => (v == null ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));
const where = (area: RecordAreaSpec) => (area.scope === 'platform' ? 'Shared by every workspace (read only)' : "This workspace's own");

/** How many records the list reads in one go (pages of 200, the API's most): search, sort and filter run on these. */
export const LIST_MAX = 2000;

/** Every record of the area up to LIST_MAX, and whether there were more; `rows` completes each page (a merged tab's source). */
async function loadAll(url: string, rows: (p: Page) => Page = (p) => p): Promise<{ records: RecordRow[]; more: boolean }> {
  const records: RecordRow[] = [];
  let after: string | null = null;
  for (;;) {
    const page: Page = rows(await getJson<Page>(`${url}?limit=200${after ? `&after=${encodeURIComponent(after)}` : ''}`));
    records.push(...page.records);
    after = page.next;
    if (!after) return { records, more: false };
    if (records.length >= LIST_MAX) return { records: records.slice(0, LIST_MAX), more: true };
  }
}

const optionLabel = (f: RecordFieldSpec, v: unknown) => {
  const o = f.options?.find((x) => (typeof x === 'string' ? x : x.value) === v);
  return o && typeof o !== 'string' ? o.label ?? o.value : String(v);
};
/** A field's value as the list and the peek show it: an option's label, Yes / No, a date, lists joined. */
export function fieldText(f: RecordFieldSpec | undefined, v: unknown): string {
  if (v == null || v === '') return '';
  // An encrypted field (mold_v0-194) is never read here: every answer carries the mask; a reveal is its own request.
  if (f?.encrypted) return '•••••• (encrypted)';
  // A file field (mold_v0-220): its file names only (the first, and how many more), never a reference's insides.
  if (f?.type === 'file') {
    const names = (Array.isArray(v) ? v : [v]).map((x) => (x && typeof x === 'object' ? String((x as { name?: unknown; path?: unknown }).name ?? (x as { path?: unknown }).path ?? '') : String(x))).filter(Boolean);
    return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0] ?? '';
  }
  if (Array.isArray(v)) return v.map((x) => fieldText(f, x)).filter(Boolean).join(', ');
  if (f?.type === 'enum') return optionLabel(f, v);
  if (f?.type === 'boolean' || typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (f?.type === 'date' && typeof v === 'string') return v.slice(0, 10);
  return cell(v);
}
/** The filter-only column of an area with a clock: any of its clocks overdue (mold_v0-217). */
const OVERDUE_COL = '_overdue';
const COL_TYPE: Record<string, PropType> = { enum: 'select', number: 'number', date: 'date', boolean: 'boolean' };
const dash = <span className='text-muted-foreground'>—</span>;

/**
 * A data adapter (mold_v0-205): the same table over rows that do not come from a records route, as a read-only system
 * area (the Access log's trails, features/audit/access-log.tsx). `load` reads the rows (at most LIST_MAX; `more` when
 * there were more), `primary` is the toolbar's action in place of Export CSV, `title` types the record column (the
 * entry's time: sorted and filtered by date range), `hidden` adds fields as columns the column picker shows on request,
 * `updated` false leaves out the Updated column, and `defaultSort` orders the rows at first.
 */
export interface RecordSource {
  load: () => Promise<{ records: RecordRow[]; more: boolean }>;
  /** What the rows depend on (reloaded when it changes). */
  key: string;
  primary?: ReactNode;
  title?: { label: string; type: PropType; value: (r: RecordRow) => RawValue };
  hidden?: string[];
  updated?: false;
  defaultSort?: SortRule[];
  noun?: string;
}

/** The list's columns: the record (its title, its key under it), then the area's list columns, typed by their fields. */
function columnsOf(area: RecordAreaSpec, source?: RecordSource): RecordCol<RecordRow>[] {
  const record: RecordCol<RecordRow> = {
    key: '_record', label: source?.title?.label ?? 'Record', title: true, keep: true, type: source?.title?.type ?? 'text', className: 'min-w-56',
    value: source?.title?.value ?? ((r) => r.title || r.key),
    render: (r) => (
      <span className='flex min-w-0 flex-col gap-1'>
        <span className='leading-snug font-medium'>{r.title || r.key}</span>
        {r.title && r.title !== r.key && <span className='text-muted-foreground font-mono text-xs leading-none break-all'>{r.key}</span>}
      </span>
    )
  };
  const hidden = new Set(source?.hidden ?? []);
  const fields = [...area.list_columns, ...hidden].map((name): RecordCol<RecordRow> => {
    const f = area.fields.find((x) => x.name === name);
    const type = (f && !f.multiple && !f.encrypted && COL_TYPE[f.type]) || 'text';
    return {
      key: name, label: areaFieldLabel(area, name), type, keep: false, ...(hidden.has(name) ? { hidden: true } : {}),
      ...(type === 'select' && f?.options ? { options: f.options.map((o) => (typeof o === 'string' ? { value: o } : { value: o.value, label: o.label })) } : {}),
      value: (r) => {
        const v = r.data[name];
        if (v == null) return null;
        if (type === 'number') return typeof v === 'number' ? v : Number(v);
        if (type === 'boolean') return Boolean(v);
        return type === 'select' || type === 'date' ? String(v) : fieldText(f, v);
      },
      render: (r) => {
        const t = fieldText(f, r.data[name]);
        return t ? <span className={cn('line-clamp-2', type === 'number' && 'tabular-nums')}>{t}</span> : dash;
      }
    };
  });
  const updated: RecordCol<RecordRow> = { key: '_updated', label: 'Updated', type: 'date', hidden: true, value: (r) => r.updated_at, render: (r) => r.updated_at.slice(0, 10) };
  // mold_v0-191: each clock's deadline and status (./clocks); mold_v0-217: whether any is overdue, a filter only (?overdue=1).
  const overdue: RecordCol<RecordRow>[] = area.clocks?.length
    ? [{ key: OVERDUE_COL, label: 'Overdue', type: 'boolean', hidden: true, keep: false, csv: false, peek: false, value: (r) => isOverdue(r), render: (r) => (isOverdue(r) ? 'Yes' : 'No') }] : [];
  return [record, ...fields, ...clockColumns<RecordRow>(area), ...overdue, ...(source?.updated === false ? [] : [updated])];
}

/** A field's value in the peek: a reference to a record this page can show links to it. */
export function FieldValue({ area, base, f, v }: { area: RecordAreaSpec; base: 'app' | 'admin'; f: RecordFieldSpec; v: unknown }) {
  const to = f.type === 'reference' ? f.to : area.links.find((l) => l.field === f.name)?.area;
  const keys = (Array.isArray(v) ? v : [v]).filter((k): k is string => typeof k === 'string' && k !== '');
  if (to && keys.length && findRecordArea(base, to)) return (
    <span className='flex flex-wrap gap-x-3 gap-y-1'>
      {keys.map((k) => <Link key={k} className='underline-offset-4 hover:underline' href={`/${base}/records/${to}/${encodeURIComponent(k)}`}>{k}</Link>)}
    </span>
  );
  // A url field (mold_v0-238): its address as a link, opened in a new tab (only an http or https address).
  if (f.type === 'url' && typeof v === 'string' && isWebAddress(v)) return (
    <a className='break-all underline-offset-4 hover:underline' href={v} target='_blank' rel='noopener noreferrer nofollow'>{v}</a>
  );
  return <>{fieldText(f, v) || dash}</>;
}

/** The empty state inside the table: what fills the area and, for staff, where to fill it now. */
export function RecordEmpty({ area, base }: { area: RecordAreaSpec; base: 'app' | 'admin' }) {
  const repos = useRepositories(base === 'admin');
  const e = recordEmptyText(area, base, base === 'admin' ? repoOf(area.name, repos.data?.repositories) : null);
  return <div className='sticky left-0 max-w-[min(36rem,calc(100vw-5rem))] text-left sm:mx-auto'><EmptyState empty={e} id={`records-${area.name}-empty`} /></div>;
}

/**
 * An area's records as the console's database table (mold_v0-170, mold_v0-176): the area's list columns typed by their
 * fields (an enum filters by its options; dates and numbers sort as such), search, a record count, sorting, filters, a
 * pager, Export CSV, a loading state and the empty state it is given; a row opens the record beside the list, with Open
 * record for its own page when `open` (a merged tab's row: the record of the first of its areas). `url` is a records
 * route that pages with limit and after (an area's, or a merged tab's, src/record-merge.ts); `rows` completes each page.
 */
export function RecordTableView({ area, base, url, rows, id, empty, open = true, exportName, exportAreas, compact = true, summary, source, toolbarAction, rowAction, detailNote }: {
  area: RecordAreaSpec; base: 'app' | 'admin'; url: string; rows?: (p: Page) => Page; id: string; empty: ReactNode; open?: boolean;
  /** Rows from a data adapter instead of `url` (mold_v0-205: a read-only system area, the Access log). */
  source?: RecordSource;
  /** Above the toolbar: a tab's four cards (mold_v0-181, features/tabs/sparklines.tsx; mold_v0-208: cards, search, table). */
  summary?: ReactNode;
  /** The tab's primary action (mold_v0-208, features/tabs/tab-action.tsx): the search row's last control (mold_v0-217). */
  toolbarAction?: ReactNode;
  /** An open record's own action beside Open record (mold_v0-212: a staff record page's Edit, features/records/staff-records.tsx). */
  rowAction?: (r: RecordRow) => ReactNode;
  /** An open record's first lines (mold_v0-221: a staff row's provenance and an override's mark, features/records/staff-records.tsx). */
  detailNote?: (r: RecordRow) => ReactNode;
  /** Fit the table to the window below what is above it (the default); false: a whole window's height (below charts). */
  compact?: boolean;
  /** The CSV file's name (default the area's) and the areas whose export the packs may withhold (default the area). */
  exportName?: string; exportAreas?: string[];
}) {
  const { data, error } = useOrgLoad(() => (source ? source.load() : loadAll(url, rows)), [source?.key ?? url, rows]);
  const cols = useMemo(() => columnsOf(area, source), [area, source]);
  // The Overdue filter (mold_v0-191): an area with a clock lists its overdue records alone when it is on. Kept in the
  // address (?overdue=1, mold_v0-207): the home page's Due soon card links to a list with it on. mold_v0-217: a rule of
  // the Filter menu (Overdue is Yes) rather than a toggle with a count above the table; removing it drops ?overdue.
  const [overdueParam, setOverdueParam] = useQueryState('overdue', parseAsFlag.withDefault(false));
  const clocked = !!area.clocks?.length;
  const overdueRule = (r: FilterRule) => r.key === OVERDUE_COL && r.op === 'true';
  const initialRules = useMemo(() => (clocked && overdueParam ? [{ id: 'overdue', key: OVERDUE_COL, op: 'true' as const }] : undefined), [clocked, overdueParam]);
  const shown = data?.records ?? [];
  const recordArea = (r: RecordRow) => r.areas?.[0] ?? area.name;
  const detailHref = (r: RecordRow) => (open && findRecordArea(base, recordArea(r)) ? `/${base}/records/${recordArea(r)}/${encodeURIComponent(r.key)}` : null);
  if (error) return <ErrorState error={error} />;
  return (
    <RecordView<RecordRow>
      id={id} compact={compact} noun={source?.noun ?? 'records'} properties summary={summary} toolbarAction={toolbarAction} defaultSort={source?.defaultSort}
      initialRules={initialRules} onRulesChange={(r) => { if (overdueParam && !r.some(overdueRule)) void setOverdueParam(null); }}
      rows={shown} rowKey={(r) => r.key} cols={cols} loading={!data}
      searchText={(r) => `${r.key} ${r.title ?? ''} ${area.list_columns.map((c) => fieldText(area.fields.find((f) => f.name === c), r.data[c])).join(' ')}`}
      searchPlaceholder={`Search ${area.label.toLowerCase()}`}
      filters={data?.more ? <span className='text-muted-foreground text-xs'>First {LIST_MAX.toLocaleString('en')} {source?.noun ?? 'records'}: search and sort cover these</span> : undefined}
      // Export (mold_v0-217): every list's, empty or not, just left of the primary action; the view's rows when narrowed.
      primary={source ? source.primary : ({ rows: view, narrowed }) => (
        <ExportCsvButton url={url} area={area} rows={rows} name={exportName ?? area.name} areas={exportAreas ?? [area.name]} compact
          keys={narrowed ? view.map((r) => r.key) : null} />
      )}
      empty={empty}
      detailTitle={(r) => r.title || r.key}
      detailActions={(r) => { const href = detailHref(r); return <>{rowAction?.(r)}{href && <Button variant='outline' size='sm' render={<Link href={href} />}>Open record</Button>}</>; }}
      detail={(r) => (<>
        <dl>
          {detailNote?.(r)}
          {r.version && <Field label='Version'>{r.version}</Field>}
          {area.fields.filter((f) => !area.list_columns.includes(f.name) && !source?.hidden?.includes(f.name) && !isStoredFile(f, r.data[f.name])).map((f) => (
            <Field key={f.name} label={f.label}><FieldValue area={area} base={base} f={f} v={r.data[f.name]} /></Field>
          ))}
        </dl>
        {/* mold_v0-220: its files and documents as cards (a merged tab's row: the first of its areas). */}
        {!source && recordArea(r) === area.name && <div className='pt-4'><RecordDocuments area={area} base={base} recordKey={r.key} /></div>}
      </>)}
    />
  );
}

/**
 * An area's own list in a workspace (mold_v0-237): its Records page and its Settings tab. The standard list, as an area
 * tab's: its four cards (the server's for the area, /api/records/_console/<area>/sparklines), the search row with Export
 * CSV and the area's primary action (the registry's `action`, for the people the server says may use it: Add <its
 * singular>, its form a full card in the list's place, ?new=1), then the table. An area with none (`no_action` says
 * why) has Export alone.
 */
export function AreaRecordList({ area, id }: { area: RecordAreaSpec; id: string }) {
  // A record added from the primary action: the list is read again.
  const [round, setRound] = useState(0);
  const { button, card } = useAreaAction(area, () => setRound((n) => n + 1));
  if (card) return card;
  return (
    <RecordTableView key={round} area={area} base='app' url={`${recordsApi('app')}/${area.name}`} id={id} empty={<RecordEmpty area={area} base='app' />}
      summary={<Sparklines url={`${recordsApi('app')}/_console/${encodeURIComponent(area.name)}/sparklines`} tag={`records/${area.name}`} label={`${area.label}: key numbers`} />}
      toolbarAction={button ?? undefined} />
  );
}

export function RecordListPage({ area, base }: { area: RecordAreaSpec; base: 'app' | 'admin' }) {
  return (
    // A list (mold_v0-217): no title or description above it.
    <PageContainer>
      {base === 'app' ? <AreaRecordList area={area} id={`app-records-${area.name}`} />
        : <RecordTableView area={area} base={base} url={`${recordsApi(base)}/${area.name}`} id={`${base}-records-${area.name}`} empty={<RecordEmpty area={area} base={base} />} />}
    </PageContainer>
  );
}

/** A record's own page (mold_v0-217): one details card, as a staff record page's (./staff-records.tsx) and an open row's. */
export function RecordDetailPage({ area, recordKey, base }: { area: RecordAreaSpec; recordKey: string; base: 'app' | 'admin' }) {
  const url = `${recordsApi(base)}/${area.name}/${encodeURIComponent(recordKey)}`;
  const { data, error } = useOrgLoad(() => getJson<Detail>(url), [url]);
  return (
    <PageContainer>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={2} /> : (
        <Card className='w-full max-w-4xl gap-0 py-0' data-record-card=''>
          <CardHeader className='border-b py-4 [.border-b]:pb-4'>
            <CardDescription>{area.label} · {where(area)}</CardDescription>
            <CardTitle className='text-lg leading-snug break-words'>{data.record.title || recordKey}</CardTitle>
          </CardHeader>
          <CardContent className='flex flex-col gap-6 py-2'>
            <dl>
              <Field label='Key'><span className='font-mono text-xs break-all'>{data.record.key}</span></Field>
              {data.record.version && <Field label='Version'>{data.record.version}</Field>}
              {data.provenance?.by && <Field label='Added by'>{ADDED_BY[data.provenance.by] ?? data.provenance.by}</Field>}
              {area.fields.filter((f) => !isStoredFile(f, data.record.data[f.name])).map((f) => (
                <Field key={f.name} label={f.label}><span className='whitespace-pre-wrap'><FieldValue area={area} base={base} f={f} v={data.record.data[f.name]} /></span></Field>
              ))}
            </dl>
            <RecordDocuments area={area} base={base} recordKey={data.record.key} />
            <ClockSection record={data.record} events={data.clock_events} />
            {data.links.map((l) => {
              const target = findRecordArea(base, l.area);
              return (
                <section key={l.field} className='flex flex-col gap-2 pb-4'>
                  <h2 className='text-sm font-medium'>{areaFieldLabel(area, l.field)} · {target?.label ?? l.area}</h2>
                  <ul className='flex flex-col gap-1 text-sm'>
                    {l.records.map((r) => (
                      <li key={r.key}><Link className='underline-offset-4 hover:underline' href={`/${base}/records/${l.area}/${encodeURIComponent(r.key)}`}>{r.title || r.key}</Link></li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </CardContent>
        </Card>
      )}
    </PageContainer>
  );
}

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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { recordAreas, type RecordAreaSpec, type RecordFieldSpec } from '@/config/pack-nav.generated';
import { keyChunks, latestField, placeColumns, type RelatedColumns } from './related-columns';
import { Field, RecordView, type PropType, type RecordCol, type RowAction, type SortRule } from '@/components/layout/record-view';
import type { FilterRule, RawValue } from '@/components/layout/record-filters';
import { useRepositories } from '@/features/admin/repositories';
import { EmptyState } from '@/features/tabs/empty';
import { cn } from '@/lib/utils';
import { recordEmptyText, repoOf } from './empty';
import { ErrorState, LoadingCards, useOrgLoad } from '@/features/portal/shared';
import { areaFieldLabel, findRecordArea, recordsApi } from './registry';
import { useExportCsv } from '@/features/tabs/export';
import { useImportAction } from './workspace-import';
import { httpError } from '@/features/status/from-error';
import { ClockSection, clockColumns, isOverdue, type ClockEvent, type ClockView } from './clocks';
import { RecordDocuments, isStoredFile } from './documents';
import { Sparklines } from '@/features/tabs/sparklines';
import { singular } from '@/features/tabs/run-rows';
import { FormHost, isWebAddress, REPOSITORY_NAME, useAreaAction } from '@/features/tabs/tab-action';
import { useRecordCredentials } from '@/features/credentials/record-credentials';
import { isDocument, jsonLine } from './json-text';
import { JsonValue } from './json-value';
import { featureOn } from '@/config/features';
import { LINKED_PARAM, columnUnit, layoutOf, numberWords, parseLinked } from './detail-layout';
import { LaidOutRecord } from './detail-page';
import { RowCreateMenu } from './row-create';
import { PANEL_TAB_PARAM } from '@/lib/split-panel';
import { ShareButton, VisibilityBadge, visibilityColumn, visibilityOf, visibilityRule, type RecordVisibility } from '@/features/teams/visibility';

/** A row of an area's list; a merged tab's row (mold_v0-135) also names the areas that hold its key, in the tab's order. */
export type RecordRow = { key: string; title: string | null; data: Record<string, unknown>; version?: string | null; updated_at: string; areas?: string[]; clocks?: Record<string, ClockView>;
  /** mold_v0-262 (flag record_pages): the titles of the records its references name, {field: {key: title}}. */
  ref_titles?: Record<string, Record<string, string>>;
  /** A shared row on the staff pages (mold_v0-221, src/record-areas.ts Provenance): staff's or its repository's, and what a staff override stands over. */
  provenance?: Provenance;
  /** mold_v0-259 (flag teams): who sees it, on an area that declares visibility. */
  visibility?: RecordVisibility };
export type Provenance = { by: 'staff' | 'repository'; repository: string | null; overrides: { title: string | null; version: string | null } | null };
export type Page = { records: RecordRow[]; next: string | null };
type Detail = { record: RecordRow; links: { field: string; area: string; records: { key: string; title: string | null }[] }[]; clock_events?: ClockEvent[];
  /** A workspace record's writer (mold_v0-236, src/record-areas.ts RowProvenance): where it came from. */
  provenance?: { by: 'staff' | 'people' | 'repository' | 'intake' | 'run' | null; written_by: string | null; updated_by: string | null };
  /** mold_v0-259 (flag teams): whether this person may change who sees it (Share). */
  can_share?: boolean };
/** Where a workspace record came from, in words (mold_v0-236). */
const ADDED_BY: Record<string, string> = { people: 'A person of this workspace', staff: 'Platform staff', intake: 'The email intake', run: "The app's own automation", repository: 'Its data source' };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, body);
  return body;
}

// A json value (mold_v0-240, ./json-text.ts): one readable line, never raw JSON.
const cell = (v: unknown, recordKey?: string) => (v == null ? '' : isDocument(v) ? jsonLine(v, recordKey) : Array.isArray(v) ? v.join(', ') : String(v));
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
/**
 * A field's value as the list and the peek show it: an option's label, Yes / No, a date, lists joined; a json value
 * one readable line (mold_v0-240; `recordKey` hides a value repeating the record's own key).
 */
export function fieldText(f: RecordFieldSpec | undefined, v: unknown, recordKey?: string): string {
  if (v == null || v === '') return '';
  // An encrypted field (mold_v0-194) is never read here: every answer carries the mask; a reveal is its own request.
  if (f?.encrypted) return '•••••• (encrypted)';
  // A file field (mold_v0-220): its file names only (the first, and how many more), never a reference's insides.
  if (f?.type === 'file') {
    const names = (Array.isArray(v) ? v : [v]).map((x) => (x && typeof x === 'object' ? String((x as { name?: unknown; path?: unknown }).name ?? (x as { path?: unknown }).path ?? '') : String(x))).filter(Boolean);
    return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0] ?? '';
  }
  if (isDocument(v)) return jsonLine(v, recordKey);
  if (Array.isArray(v)) return v.map((x) => fieldText(f, x, recordKey)).filter(Boolean).join(', ');
  if (f?.type === 'enum') return optionLabel(f, v);
  if (f?.type === 'boolean' || typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (f?.type === 'date' && typeof v === 'string') return v.slice(0, 10);
  return cell(v, recordKey);
}
/** The filter-only column of an area with a clock: any of its clocks overdue (mold_v0-217). */
const OVERDUE_COL = '_overdue';
const COL_TYPE: Record<string, PropType> = { enum: 'select', number: 'number', date: 'date', boolean: 'boolean' };
const dash = <span className='text-muted-foreground'>—</span>;

/**
 * A data adapter (mold_v0-205): the same table over rows that do not come from a records route, as a read-only system
 * area (the Access log's trails, features/audit/access-log.tsx). `load` reads the rows (at most LIST_MAX; `more` when
 * there were more), `exports` are its Actions ▾ export items in place of Export CSV, `title` types the record column (the
 * entry's time: sorted and filtered by date range), `hidden` adds fields as columns the column picker shows on request,
 * `updated` false leaves out the Updated column, and `defaultSort` orders the rows at first.
 */
export interface RecordSource {
  load: () => Promise<{ records: RecordRow[]; more: boolean }>;
  /** What the rows depend on (reloaded when it changes). */
  key: string;
  exports?: RowAction[];
  title?: { label: string; type: PropType; value: (r: RecordRow) => RawValue };
  hidden?: string[];
  updated?: false;
  defaultSort?: SortRule[];
  noun?: string;
  /**
   * mold_v0-286 (the Access log): the first column's cell drawn by the source (no key under it: a system area's rows
   * have hidden keys), each row's ⋯ menu (also in the panel's), the panel's body in place of the area's fields, and
   * the panel's title.
   */
  render?: (r: RecordRow) => ReactNode;
  actions?: (r: RecordRow) => RowAction[];
  detail?: (r: RecordRow) => ReactNode;
  detailTitle?: (r: RecordRow) => ReactNode;
  /** false: the panel draws only `detail` (one card), not the area's facts above it (the Access log, 2026-11-09). */
  properties?: false;
}

/** The list's columns: the record (its title, its key under it), then the area's list columns, typed by their fields. */
function columnsOf(area: RecordAreaSpec, source?: RecordSource, extra: string[] = [], base: 'app' | 'admin' = 'app'): RecordCol<RecordRow>[] {
  const record: RecordCol<RecordRow> = {
    key: '_record', label: source?.title?.label ?? singular(area.label), title: true, keep: true, type: source?.title?.type ?? 'text', className: 'min-w-56',
    value: source?.title?.value ?? ((r) => r.title || r.key),
    render: source?.render ?? ((r) => (
      <span className='leading-snug font-medium'>{r.title || r.key}</span>
    ))
  };
  const hidden = new Set([...(source?.hidden ?? []), ...extra.filter((n) => !area.list_columns.includes(n))]);
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
        if (refTarget(area, f) && r.ref_titles?.[name]) return refWords(v, r.ref_titles[name]);
        return type === 'select' || type === 'date' ? String(v) : fieldText(f, v, r.key);
      },
      render: (r) => {
        // mold_v0-262 (flag record_pages): a reference shows the record's title, linked; a chips field its chips.
        const to = refTarget(area, f), titles = r.ref_titles?.[name];
        if (to && titles && findRecordArea(base, to)) {
          const keys = (Array.isArray(r.data[name]) ? r.data[name] as unknown[] : [r.data[name]]).filter((k): k is string => typeof k === 'string' && k !== '');
          if (keys.length) return <span className='line-clamp-2' data-ref-cell={name}>{keys.map((k, i) => <span key={k}>{i > 0 && ', '}<Link href={`/${base}/records/${to}/${encodeURIComponent(k)}`} className='underline-offset-4 hover:underline' onClick={(e) => e.stopPropagation()}>{titles[k] ?? k}</Link></span>)}</span>;
        }
        const chips = chipWords(f, chipValues(f, r.data[name]));
        if (chips) return <Chips values={chips} max={4} />;
        // mold_v0-289: a number with its field's or its page's unit ($0.42, 5m 0s), a date on one line.
        const unit = type === 'number' ? (f as { unit?: string } | undefined)?.unit ?? columnUnit(area, name) : undefined;
        if (unit && r.data[name] != null) return <span className='tabular-nums'>{moneyOr(r.data[name], unit)}</span>;
        const t = fieldText(f, r.data[name], r.key);
        return t ? <span className={cn('line-clamp-2', type === 'number' && 'tabular-nums', type === 'date' && 'whitespace-nowrap')}>{t}</span> : dash;
      }
    };
  });
  const updated: RecordCol<RecordRow> = { key: '_updated', label: 'Updated', type: 'date', hidden: true, value: (r) => r.updated_at, render: (r) => r.updated_at.slice(0, 10) };
  // mold_v0-191: each clock's deadline and status (./clocks); mold_v0-217: whether any is overdue, a filter only (?overdue=1).
  const overdue: RecordCol<RecordRow>[] = area.clocks?.length
    ? [{ key: OVERDUE_COL, label: 'Overdue', type: 'boolean', hidden: true, keep: false, csv: false, peek: false, value: (r) => isOverdue(r), render: (r) => (isOverdue(r) ? 'Yes' : 'No') }] : [];
  return [record, ...fields, ...clockColumns<RecordRow>(area), ...overdue, ...(source?.updated === false ? [] : [updated])];
}

/** The area a reference or link field names (mold_v0-262: its cells link to the record, by its title). */
export const refTarget = (area: RecordAreaSpec, f: RecordFieldSpec | undefined) => (!f ? undefined : f.type === 'reference' ? f.to : area.links.find((l) => l.field === f.name)?.area);
/** A reference's words: the named records' titles where the row has them, else their keys (mold_v0-262). */
export const refWords = (v: unknown, titles?: Record<string, string>) => (Array.isArray(v) ? v : [v]).filter((k) => typeof k === 'string' && k !== '').map((k) => titles?.[k as string] ?? String(k)).join(', ');
/** A json field declared `display: "chips"` holding a list of strings or numbers: its values (mold_v0-262), else null. */
export const chipValues = (f: RecordFieldSpec | undefined, v: unknown): string[] | null =>
  f && f.type === 'json' && (f as RecordFieldSpec & { display?: string }).display === 'chips' && featureOn('record_pages') && Array.isArray(v) && v.length
    && v.every((x) => typeof x === 'string' || typeof x === 'number') ? v.map(String) : null;
/** A number in its unit: "$0.42" for dollars, else the record page's words for a unit (5m 0s, 87.4%). */
const moneyOr = (v: unknown, unit: string) => (/^(usd|\$)$/i.test(unit.trim()) ? `$${Number(v).toFixed(2)}` : numberWords(v, unit));

/** A chip's words, when its field asks for them (pack field `chip_words: true`, mold_v0-289): web-app reads "Web app". */
const chipWords = (f: RecordFieldSpec | undefined, values: string[] | null) => !values || !(f as { chip_words?: boolean } | undefined)?.chip_words ? values
  : values.map((x) => x.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()));

/** A list of short strings as chips (mold_v0-262, a json field with `display: chips`). */
export function Chips({ values, max }: { values: string[]; max?: number }) {
  const shown = max ? values.slice(0, max) : values;
  return (
    <span className='flex flex-wrap gap-1' data-chips=''>
      {shown.map((x, i) => <span key={`${x}-${i}`} className='bg-muted text-foreground inline-flex max-w-full items-center truncate rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-border ring-inset' data-chip=''>{x}</span>)}
      {max && values.length > max && <span className='text-muted-foreground px-1 text-xs' data-chip-more=''>+{values.length - max}</span>}
    </span>
  );
}

/**
 * A field's value in the peek and on a record's page: a reference to a record this page can show links to it; a json
 * value readable (mold_v0-240, ./json-value.tsx: a list of objects one line per item, an object one line per field,
 * bookkeeping and `recordKey` repeated hidden, common short values in words).
 */
export function FieldValue({ area, base, f, v, recordKey, titles }: { area: RecordAreaSpec; base: 'app' | 'admin'; f: RecordFieldSpec; v: unknown; recordKey?: string;
  /** mold_v0-262: the named records' titles (the row's ref_titles of this field): shown in place of their keys. */
  titles?: Record<string, string> }) {
  const to = refTarget(area, f);
  const keys = (Array.isArray(v) ? v : [v]).filter((k): k is string => typeof k === 'string' && k !== '');
  if (to && keys.length && findRecordArea(base, to)) return (
    <span className='flex flex-wrap gap-x-3 gap-y-1'>
      {keys.map((k) => <Link key={k} className='underline-offset-4 hover:underline' title={titles?.[k] ? k : undefined} data-ref-key={k} href={`/${base}/records/${to}/${encodeURIComponent(k)}`}>{titles?.[k] ?? k}</Link>)}
    </span>
  );
  const chips = chipValues(f, v);
  if (chips) return <Chips values={chips} />;
  // A url field (mold_v0-238): its address as a link, opened in a new tab (only an http or https address).
  if (f.type === 'url' && typeof v === 'string' && isWebAddress(v)) return (
    <a className='break-all underline-offset-4 hover:underline' href={v} target='_blank' rel='noopener noreferrer nofollow'>{v}</a>
  );
  // mold_v0-282 (flag record_resources): a linked GitHub repository, owner/name, as a link to it.
  if (f.type === 'repository' && typeof v === 'string' && REPOSITORY_NAME.test(v)) return (
    <a className='break-all font-mono text-xs underline-offset-4 hover:underline' href={`https://github.com/${v}`} target='_blank' rel='noopener noreferrer nofollow' data-repository-link=''>{v}</a>
  );
  if (!f.encrypted && f.type !== 'file' && isDocument(v)) return <JsonValue v={v} recordKey={recordKey} empty={dash} />;
  return <>{fieldText(f, v, recordKey) || dash}</>;
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
export function RecordTableView({ area, base, url, rows, id, empty, open = true, exportName, exportAreas, compact = true, summary, source, toolbarAction, importAction, rowActions, detailNote, related }: {
  area: RecordAreaSpec; base: 'app' | 'admin'; url: string; rows?: (p: Page) => Page; id: string; empty: ReactNode; open?: boolean;
  /** Rows from a data adapter instead of `url` (mold_v0-205: a read-only system area, the Access log). */
  source?: RecordSource;
  /** Above the toolbar: a tab's four cards (mold_v0-181, features/tabs/sparklines.tsx; mold_v0-208: cards, search, table). */
  summary?: ReactNode;
  /** The tab's primary action (mold_v0-208, features/tabs/tab-action.tsx): the search row's last control (mold_v0-217). */
  toolbarAction?: ReactNode;
  /** The list's Import (mold_v0-234, ./workspace-import.tsx): an item of the Actions ▾ menu, before Export (mold_v0-294). */
  importAction?: RowAction | null;
  /** An open record's own actions, its panel's ⋯ items (mold_v0-212: a staff record's Edit, features/records/staff-records.tsx). */
  rowActions?: (r: RecordRow) => RowAction[];
  /** An open record's first lines (mold_v0-221: a staff row's provenance and an override's mark, features/records/staff-records.tsx). */
  detailNote?: (r: RecordRow) => ReactNode;
  /** Fit the table to the window below what is above it (the default); false: a whole window's height (below charts). */
  compact?: boolean;
  /** The CSV file's name (default the area's) and the areas whose export the packs may withhold (default the area). */
  exportName?: string; exportAreas?: string[];
  /** mold_v0-256 (flag record_pages): columns computed from the records that point back to each row (./related-columns.ts). */
  related?: RelatedColumns;
}) {
  const { data, error } = useOrgLoad(() => (source ? source.load() : loadAll(url, rows)), [source?.key ?? url, rows]);
  const exporter = useExportCsv({ url, area, rows, name: exportName ?? area.name, areas: exportAreas ?? [area.name] });
  // mold_v0-256: the computed columns' values for the rows read, as the person reading (an area they may not read: empty).
  const rowKeys = useMemo(() => (data?.records ?? []).map((r) => r.key), [data]);
  const relatedValues = useOrgLoad(async () => {
    if (!related || !rowKeys.length) return {} as Record<string, Record<string, unknown> | { hidden: true }>;
    const out: Record<string, Record<string, unknown>> = {};
    for (const keys of keyChunks(rowKeys)) {
      const got = await getJson<{ columns: Record<string, Record<string, unknown> | { hidden: true }> }>(`${related.url}?keys=${encodeURIComponent(keys.join(','))}`);
      for (const [c, v] of Object.entries(got.columns)) out[c] = { ...(out[c] ?? {}), ...((v as { hidden?: boolean }).hidden ? {} : v) };
    }
    return out;
  }, [related?.url, rowKeys]);
  // mold_v0-254 (flag record_pages): a related list's Show all, ?linked=<field>:<key>: the records pointing at one record,
  // a rule of the Filter menu (its column added, hidden, when the list does not show it); removing it drops the address's.
  const [linkedParam, setLinkedParam] = useQueryState(LINKED_PARAM);
  const linked = featureOn('record_pages') && !source ? parseLinked(linkedParam, area) : null;
  // mold_v0-259 (flag teams): an area that declares visibility lists who sees each record, a column the Filter menu filters.
  const visible = base === 'app' && !source && !!visibilityOf(area);
  const cols = useMemo(() => {
    const plain = columnsOf(area, source, linked ? [linked.field] : [], base);
    const own = visible ? [...plain, visibilityColumn<RecordRow>(data?.records ?? [])] : plain;
    if (!related) return own;
    // A count reads as a number; a latest value as the related area's own cell (an enum's label, a date, ...).
    const values = relatedValues.data ?? {};
    const extra = related.columns.map((c): RecordCol<RecordRow> & { at: number } => {
      const f = latestField(c, recordAreas, c.area);
      const type: PropType = !f ? 'number' : (!f.multiple && !f.encrypted && COL_TYPE[f.type]) || 'text';
      const raw = (r: RecordRow) => (values[c.id] as Record<string, unknown> | undefined)?.[r.key];
      return {
        key: c.id, label: c.label, type, keep: false, at: c.at, className: !f ? 'text-right' : undefined,
        ...(type === 'select' && f?.options ? { options: f.options.map((o) => (typeof o === 'string' ? { value: o } : { value: o.value, label: o.label })) } : {}),
        value: (r) => { const v = raw(r); return v == null ? null : !f ? Number(v) : type === 'select' || type === 'date' ? String(v) : type === 'number' ? Number(v) : fieldText(f, v); },
        render: (r) => {
          const v = raw(r);
          if (!relatedValues.data && !relatedValues.error) return <span className='bg-muted inline-block h-3 w-8 animate-pulse rounded' aria-busy='true' />;
          if (v == null || v === '') return dash;
          return <span className={cn('line-clamp-2', (!f || f.type === 'number') && 'tabular-nums')} data-related-cell={c.id}>{!f ? Number(v).toLocaleString('en') : fieldText(f, v, r.key)}</span>;
        }
      };
    });
    return placeColumns(own, extra);
  }, [area, source, linked?.field, related, relatedValues.data, relatedValues.error, visible, data, base]);
  // The Overdue filter (mold_v0-191): an area with a clock lists its overdue records alone when it is on. Kept in the
  // address (?overdue=1, mold_v0-207): the home page's Due soon card links to a list with it on. mold_v0-217: a rule of
  // the Filter menu (Overdue is Yes) rather than a toggle with a count above the table; removing it drops ?overdue.
  const [overdueParam, setOverdueParam] = useQueryState('overdue', parseAsFlag.withDefault(false));
  const clocked = !!area.clocks?.length;
  const overdueRule = (r: FilterRule) => r.key === OVERDUE_COL && r.op === 'true';
  const linkedList = linked ? !!(area.fields.find((f) => f.name === linked.field)?.multiple || area.fields.find((f) => f.name === linked.field)?.type === 'link') : false;
  // mold_v0-259: ?visibility=workspace|private|team:<name> (a team's page links to its records' list) is a Filter rule.
  const [visibilityParam, setVisibilityParam] = useQueryState('visibility');
  const visRule = visible ? visibilityRule(visibilityParam) : null;
  const initialRules = useMemo(() => {
    const rules = [...(clocked && overdueParam ? [{ id: 'overdue', key: OVERDUE_COL, op: 'true' as const }] : []),
      ...(linked ? [{ id: 'linked', key: linked.field, op: (linkedList ? 'contains' : 'is') as 'contains' | 'is', value: linked.key }] : []),
      ...(visRule ? [visRule] : [])];
    return rules.length ? rules : undefined;
  }, [clocked, overdueParam, linked?.field, linked?.key, linkedList, visRule?.value]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = data?.records ?? [];
  const recordArea = (r: RecordRow) => r.areas?.[0] ?? area.name;
  const detailHref = (r: RecordRow) => (open && findRecordArea(base, recordArea(r)) ? `/${base}/records/${recordArea(r)}/${encodeURIComponent(r.key)}` : null);
  const laidOut = (r: RecordRow) => !source && !detailNote && recordArea(r) === area.name && featureOn('record_pages') && !!layoutOf(area);
  if (error) return <ErrorState error={error} />;
  return (
    <RecordView<RecordRow>
      id={id} compact={compact} noun={source?.noun ?? 'records'} summary={summary} toolbarAction={toolbarAction} defaultSort={source?.defaultSort}
      initialRules={initialRules} onRulesChange={(r) => {
        if (overdueParam && !r.some(overdueRule)) void setOverdueParam(null);
        if (linked && !r.some((x) => x.id === 'linked')) void setLinkedParam(null);
        if (visibilityParam && !r.some((x) => x.id === 'visibility')) void setVisibilityParam(null);
      }}
      rows={shown} rowKey={(r) => r.key} cols={cols} loading={!data} wide={featureOn('wide_lists') && cols.filter((c) => !c.hidden).length > 9}
      searchText={(r) => `${r.key} ${r.title ?? ''} ${area.list_columns.map((c) => fieldText(area.fields.find((f) => f.name === c), r.data[c], r.key)).join(' ')}`}
      searchPlaceholder={`Search ${area.label.toLowerCase()}`}
      filters={data?.more ? <span className='text-muted-foreground text-xs'>First {LIST_MAX.toLocaleString('en')} {source?.noun ?? 'records'}: search and sort cover these</span> : undefined}
      // mold_v0-294: Import and Export (every list's, empty or not; the view's rows when narrowed, mold_v0-217) are items
      // of the search row's Actions ▾ menu, with Ask AI, before the primary action.
      imports={importAction ? [importAction] : undefined}
      exports={source ? source.exports ?? [] : ({ rows: view, narrowed }) => { const it = exporter.item(narrowed ? view.map((r) => r.key) : null); return it ? [it] : []; }}
      empty={empty}
      detailTitle={(r) => (source?.detailTitle ? source.detailTitle(r) : r.title || r.key)}
      actions={source?.actions}
      // mold_v0-278: the panel's ⋯ menu: the row's own actions (a staff row's Edit), its page's Add <related record>
      // actions (flag record_pages), then Open in its own page.
      panelActions={(r) => rowActions?.(r) ?? []}
      panelMenu={base === 'app' && !source ? (r, items) => (recordArea(r) === area.name ? <RowCreateMenu area={area} recordKey={r.key} items={items} name={r.title || r.key} /> : undefined) : undefined}
      pageHref={detailHref}
      // A record whose area declares its page's layout (flag record_pages): the laid-out record itself in the panel.
      properties={(r) => source?.properties !== false && !laidOut(r)}
      detail={(r) => source?.detail ? source.detail(r) : laidOut(r) ? <RecordDetailBody area={area} recordKey={r.key} base={base} inPanel /> : (<>
        <dl>
          {detailNote?.(r)}
          {visible && r.visibility && <Field label='Who sees it'><VisibilityBadge v={r.visibility} /></Field>}
          {r.version && <Field label='Version'>{r.version}</Field>}
          {area.fields.filter((f) => !area.list_columns.includes(f.name) && !source?.hidden?.includes(f.name) && !isStoredFile(f, r.data[f.name])).map((f) => (
            <Field key={f.name} label={f.label}><FieldValue area={area} base={base} f={f} v={r.data[f.name]} titles={r.ref_titles?.[f.name]} recordKey={r.key} /></Field>
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
  const { button, card, panel } = useAreaAction(area, () => setRound((n) => n + 1));
  // mold_v0-234: Import, where the area's contract grants it to this person: an Actions ▾ item before Export, its card in the list's place.
  const imp = useImportAction(area, () => setRound((n) => n + 1));
  if (imp.card && !card) return imp.card;
  // The Add form: the full card in the list's place, or (mold_v0-256, flag side_panel_forms) a panel beside the list.
  return (
    <FormHost card={card} panel={panel}>
      <RecordTableView key={round} area={area} base='app' url={`${recordsApi('app')}/${area.name}`} id={id} empty={<RecordEmpty area={area} base='app' />}
        summary={<Sparklines url={`${recordsApi('app')}/_console/${encodeURIComponent(area.name)}/sparklines`} tag={`records/${area.name}`} label={`${area.label}: key numbers`} />}
        toolbarAction={button ?? undefined} importAction={imp.item} />
    </FormHost>
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

/**
 * A record's own page (mold_v0-217): one details card, as a staff record page's (./staff-records.tsx) and an open row's.
 * In a workspace, its Credentials card below it when credentials belong to its records (mold_v0-239,
 * features/credentials/record-credentials.tsx); setting one opens a full card in the page's place. With the flag
 * record_pages on and a layout declared for the area (mold_v0-253), the page is laid out instead (./detail-page.tsx).
 */
export function RecordDetailPage({ area, recordKey, base }: { area: RecordAreaSpec; recordKey: string; base: 'app' | 'admin' }) {
  return <PageContainer><RecordDetailBody area={area} recordKey={recordKey} base={base} /></PageContainer>;
}

/** A record's page without its page (mold_v0-278: also a list's record panel, `inPanel`: its tabs under &panelTab=). */
export function RecordDetailBody({ area, recordKey, base, inPanel = false }: { area: RecordAreaSpec; recordKey: string; base: 'app' | 'admin'; inPanel?: boolean }) {
  const url = `${recordsApi(base)}/${area.name}/${encodeURIComponent(recordKey)}`;
  const { data, error, reload } = useOrgLoad(() => getJson<Detail>(url), [url]);
  // mold_v0-260 (flag credential_sets): a tenant area's records have credentials too (the server says which: 404 otherwise).
  const credentials = useRecordCredentials(area, recordKey, base === 'app' && (area.role === 'asset' || featureOn('credential_sets')), featureOn('record_pages') && !!layoutOf(area));
  if (credentials.card) return <>{credentials.card}</>;
  const layout = featureOn('record_pages') ? layoutOf(area) : null;
  if (layout) return (
    <>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={3} /> : (
        <LaidOutRecord area={area} base={base} layout={layout} record={data.record} links={data.links} clockEvents={data.clock_events}
          provenance={data.provenance} where={where(area)} credentials={credentials.section} onChanged={() => void reload()} canShare={!!data.can_share}
          tabParam={inPanel ? PANEL_TAB_PARAM : undefined} />
      )}
    </>
  );
  return (
    <>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={2} /> : (<div className='flex w-full flex-col gap-6'>
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
              {/* mold_v0-259 (flag teams): who sees it, and Share for the people who may change it. */}
              {base === 'app' && data.record.visibility && visibilityOf(area) && (
                <Field label='Who sees it'>
                  <span className='flex flex-wrap items-center gap-2' data-record-visibility=''>
                    <VisibilityBadge v={data.record.visibility} />
                    <ShareButton area={area} recordKey={data.record.key} visibility={data.record.visibility} canShare={!!data.can_share} onShared={() => void reload()} />
                  </span>
                </Field>
              )}
              {area.fields.filter((f) => !isStoredFile(f, data.record.data[f.name])).map((f) => (
                <Field key={f.name} label={f.label}><span className='whitespace-pre-wrap'><FieldValue area={area} base={base} f={f} v={data.record.data[f.name]} titles={data.record.ref_titles?.[f.name]} recordKey={data.record.key} /></span></Field>
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
        {credentials.section}
      </div>)}
    </>
  );
}

'use client';
// The shell's generic record-area pages (mold_v0-047): a list page and a detail page for every area a pack declares in
// definePack({ recordAreas }), with no pack code. Labels and columns come from the generated registry
// (web/src/config/pack-nav.generated.ts); rows from /api/records (a workspace's view: shared areas and its own) or
// /api/admin/records (platform staff: the shared areas). Read only: records are written by the packs and the platform.
// The list is the console's database table (RecordView, as on Accounts; mold_v0-170), and so is every customer list of
// an area's records (mold_v0-176: RecordTableView, which a pack's area tab draws too, features/tabs/tab-page.tsx).
import Link from 'next/link';
import { useMemo, type ReactNode } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import type { RecordAreaSpec, RecordFieldSpec } from '@/config/pack-nav.generated';
import { Field, RecordView, type PropType, type RecordCol } from '@/components/layout/record-view';
import { useRepositories } from '@/features/admin/repositories';
import { EmptyState } from '@/features/tabs/empty';
import { cn } from '@/lib/utils';
import { recordEmptyText, repoOf } from './empty';
import { ErrorState, LoadingCards, useOrgLoad } from '@/features/portal/shared';
import { areaFieldLabel, findRecordArea, recordsApi } from './registry';
import { ExportCsvButton } from '@/features/tabs/export';
import { httpError } from '@/features/status/from-error';

/** A row of an area's list; a merged tab's row (mold_v0-135) also names the areas that hold its key, in the tab's order. */
type RecordRow = { key: string; title: string | null; data: Record<string, unknown>; version?: string | null; updated_at: string; areas?: string[] };
export type Page = { records: RecordRow[]; next: string | null };
type Detail = { record: RecordRow; links: { field: string; area: string; records: { key: string; title: string | null }[] }[] };

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
  if (Array.isArray(v)) return v.map((x) => fieldText(f, x)).filter(Boolean).join(', ');
  if (f?.type === 'enum') return optionLabel(f, v);
  if (f?.type === 'boolean' || typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (f?.type === 'date' && typeof v === 'string') return v.slice(0, 10);
  return cell(v);
}
const COL_TYPE: Record<string, PropType> = { enum: 'select', number: 'number', date: 'date', boolean: 'boolean' };
const dash = <span className='text-muted-foreground'>—</span>;

/** The list's columns: the record (its title, its key under it), then the area's list columns, typed by their fields. */
function columnsOf(area: RecordAreaSpec): RecordCol<RecordRow>[] {
  const record: RecordCol<RecordRow> = {
    key: '_record', label: 'Record', title: true, keep: true, type: 'text', className: 'min-w-56',
    value: (r) => r.title || r.key,
    render: (r) => (
      <span className='flex min-w-0 flex-col gap-1'>
        <span className='leading-snug font-medium'>{r.title || r.key}</span>
        {r.title && r.title !== r.key && <span className='text-muted-foreground font-mono text-xs leading-none break-all'>{r.key}</span>}
      </span>
    )
  };
  const fields = area.list_columns.map((name): RecordCol<RecordRow> => {
    const f = area.fields.find((x) => x.name === name);
    const type = (f && !f.multiple && COL_TYPE[f.type]) || 'text';
    return {
      key: name, label: areaFieldLabel(area, name), type, keep: false,
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
  return [record, ...fields, updated];
}

/** A field's value in the peek: a reference to a record this page can show links to it. */
function FieldValue({ area, base, f, v }: { area: RecordAreaSpec; base: 'app' | 'admin'; f: RecordFieldSpec; v: unknown }) {
  const to = f.type === 'reference' ? f.to : area.links.find((l) => l.field === f.name)?.area;
  const keys = (Array.isArray(v) ? v : [v]).filter((k): k is string => typeof k === 'string' && k !== '');
  if (to && keys.length && findRecordArea(base, to)) return (
    <span className='flex flex-wrap gap-x-3 gap-y-1'>
      {keys.map((k) => <Link key={k} className='underline-offset-4 hover:underline' href={`/${base}/records/${to}/${encodeURIComponent(k)}`}>{k}</Link>)}
    </span>
  );
  return <>{fieldText(f, v) || dash}</>;
}

/** The empty state inside the table: what fills the area and, for staff, where to fill it now. */
function RecordEmpty({ area, base }: { area: RecordAreaSpec; base: 'app' | 'admin' }) {
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
export function RecordTableView({ area, base, url, rows, id, empty, open = true, exportName, exportAreas, compact = true, summary }: {
  area: RecordAreaSpec; base: 'app' | 'admin'; url: string; rows?: (p: Page) => Page; id: string; empty: ReactNode; open?: boolean;
  /** Between the toolbar and the table: a tab's four cards (mold_v0-181, features/tabs/sparklines.tsx). */
  summary?: ReactNode;
  /** Fit the table to the window below what is above it (the default); false: a whole window's height (below charts). */
  compact?: boolean;
  /** The CSV file's name (default the area's) and the areas whose export the packs may withhold (default the area). */
  exportName?: string; exportAreas?: string[];
}) {
  const { data, error } = useOrgLoad(() => loadAll(url, rows), [url, rows]);
  const cols = useMemo(() => columnsOf(area), [area]);
  const recordArea = (r: RecordRow) => r.areas?.[0] ?? area.name;
  const detailHref = (r: RecordRow) => (open && findRecordArea(base, recordArea(r)) ? `/${base}/records/${recordArea(r)}/${encodeURIComponent(r.key)}` : null);
  if (error) return <ErrorState error={error} />;
  return (
    <RecordView<RecordRow>
      id={id} compact={compact} noun='records' properties summary={summary}
      rows={data?.records ?? []} rowKey={(r) => r.key} cols={cols} loading={!data}
      searchText={(r) => `${r.key} ${r.title ?? ''} ${area.list_columns.map((c) => fieldText(area.fields.find((f) => f.name === c), r.data[c])).join(' ')}`}
      searchPlaceholder={`Search ${area.label.toLowerCase()}`}
      filters={data?.more ? <span className='text-muted-foreground text-xs'>First {LIST_MAX.toLocaleString('en')} records: search and sort cover these</span> : undefined}
      primary={data?.records.length ? <ExportCsvButton url={url} area={area} rows={rows} name={exportName ?? area.name} areas={exportAreas ?? [area.name]} /> : undefined}
      empty={empty}
      detailTitle={(r) => r.title || r.key}
      detailActions={(r) => { const href = detailHref(r); return href ? <Button variant='outline' size='sm' render={<Link href={href} />}>Open record</Button> : null; }}
      detail={(r) => (
        <dl>
          {r.version && <Field label='Version'>{r.version}</Field>}
          {area.fields.filter((f) => !area.list_columns.includes(f.name)).map((f) => (
            <Field key={f.name} label={f.label}><FieldValue area={area} base={base} f={f} v={r.data[f.name]} /></Field>
          ))}
        </dl>
      )}
    />
  );
}

export function RecordListPage({ area, base }: { area: RecordAreaSpec; base: 'app' | 'admin' }) {
  return (
    <PageContainer pageTitle={area.label} pageDescription={area.description ?? where(area)}>
      <RecordTableView area={area} base={base} url={`${recordsApi(base)}/${area.name}`} id={`${base}-records-${area.name}`} empty={<RecordEmpty area={area} base={base} />} />
    </PageContainer>
  );
}

export function RecordDetailPage({ area, recordKey, base }: { area: RecordAreaSpec; recordKey: string; base: 'app' | 'admin' }) {
  const url = `${recordsApi(base)}/${area.name}/${encodeURIComponent(recordKey)}`;
  const { data, error } = useOrgLoad(() => getJson<Detail>(url), [url]);
  return (
    <PageContainer pageTitle={data?.record.title || recordKey} pageDescription={`${area.label} · ${where(area)}`}>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={2} /> : (
        <div className='flex flex-col gap-6'>
          <dl className='grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[12rem_1fr]'>
            <dt className='text-muted-foreground text-sm'>Key</dt><dd className='font-mono text-sm break-all'>{data.record.key}</dd>
            {data.record.version && (<><dt className='text-muted-foreground text-sm'>Version</dt><dd className='text-sm'>{data.record.version}</dd></>)}
            {area.fields.map((f) => (
              <div key={f.name} className='contents'>
                <dt className='text-muted-foreground text-sm'>{f.label}</dt>
                <dd className='text-sm break-words whitespace-pre-wrap'>{cell(data.record.data[f.name]) || '—'}</dd>
              </div>
            ))}
          </dl>
          {data.links.map((l) => {
            const target = findRecordArea(base, l.area);
            return (
              <section key={l.field} className='flex flex-col gap-2'>
                <h2 className='text-sm font-medium'>{areaFieldLabel(area, l.field)} · {target?.label ?? l.area}</h2>
                <ul className='flex flex-col gap-1 text-sm'>
                  {l.records.map((r) => (
                    <li key={r.key}><Link className='underline-offset-4 hover:underline' href={`/${base}/records/${l.area}/${encodeURIComponent(r.key)}`}>{r.title || r.key}</Link></li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </PageContainer>
  );
}

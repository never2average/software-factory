'use client';
// A record's page, laid out as its area declares (mold_v0-253, flag record_pages; ./detail-layout.ts decides, this
// draws). In the standard grid, each part a full-width card:
//   the header   the area and where its records live, the title, the summary line, the status badges, Copy ID and
//                Copy link; up to 8 facts (each formatted by its type); who added the record, its id and when it changed
//   notices      a banner per notice whose condition holds on the record (info, warning, danger)
//   tabs         the strip (?tab=<id>; one tab: no strip), then the open tab's sections: a card each, its fields in
//                groups of 1, 2 or 3 columns (one on a phone; a number with the unit its fact gives), its own empty state
//                when every field of it is empty
//   first tab    after its sections: "Other details" (fields the layout does not place, unless it hides them), the
//                record's documents, deadlines and links, and its Credentials card, as on the page without a layout
// Every copy (the id, the page's link, a copyable field) confirms with a toast and works on a phone (the clipboard,
// else a selection copied the old way). Buttons are the shared outlined ones; no caption above any list.
// Part 2 (mold_v0-254), in a workspace (GET /api/records/_page/<area>/<key>, src/record-page-routes.ts):
//   actions      declared ones replace Copy ID and Copy link in the header: the primary, the secondary, More (the rest,
//                then Copy ID and Copy link); a start_run's or an edit's form is a full card in the page's place
//                (./page-actions.tsx)
//   related      a section listing another area's records that point here: its columns (formatted as its list's cells),
//                its sort and row limit, Show all (its list filtered to this record), each row's own actions, its empty
//                state; not drawn for a role that may not read that area
//   runs         a section listing the runs that ran on this record: kind (a link to the run), status, started,
//                duration, cost, who started it
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { packTabs, type RecordAreaSpec, type RecordFieldSpec } from '@/config/pack-nav.generated';
import { ErrorState, useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { formatValue } from '@/features/tabs/charts';
import { duration, runKindLabel, runSeconds, statusLabel } from '@/features/tabs/run-rows';
import { recordAreas } from '@/config/pack-nav.generated';
import { cn } from '@/lib/utils';
import { ClockSection, type ClockEvent } from './clocks';
import { RecordDocuments, isStoredFile } from './documents';
import {
  BADGE_CLASS, LOG_POLL_MS, NOTICE_CLASS, RUN_STATUS_COLOR, badgeColor, columnUnit, columnsClass, copyText, countWords, dateWords, declaresActions, declaresCopyLink, isEmptyValue,
  isTimeUnit, linkPieces, logLive, numberWords, openTab, optionWords, readsComputed, readsHistory, relatedColumns, sectionEmpty, sectionGroups, sectionKey, showAllHref,
  shownNotices, tabId, unplacedFields,
  type BadgeColor, type ComputedFact, type DetailFact, type DetailLayout, type DetailSection, type HistoryData, type LaidOutField, type NoticeTone, type PageData,
  type RelatedData, type RunsData
} from './detail-layout';
import { RowActions, usePageActionsBar, type ActionHost } from './page-actions';
import { CodeView, JsonTable } from './code-view';
import { languageOf } from './code-text';
import { FileBrowser } from './file-browser';
import { HistoryList } from './history-section';
import { linesOf } from './log-lines';
import { LogViewer } from './log-viewer';
import { FormHost } from '@/features/tabs/tab-action';
import { areaFieldLabel, findRecordArea } from './registry';
import { FieldValue, fieldText, type RecordRow } from './record-pages';

type Links = { field: string; area: string; records: { key: string; title: string | null }[] }[];

/** Put text on the clipboard and say so; a browser without the clipboard API (an older phone) copies a selection. */
export async function copyWithToast(text: string, done: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('copy refused');
    }
    toast.success(done);
  } catch {
    toast.error('Could not copy: select the text and copy it yourself.');
  }
}

/** A colour token's badge (a tinted chip with a dot). */
export function ToneBadge({ color, children }: { color: BadgeColor; children: ReactNode }) {
  return (
    <Badge variant='secondary' data-badge-color={color} className={cn('gap-1.5 ring-1 ring-inset', BADGE_CLASS[color])}>
      <span aria-hidden className='size-1.5 shrink-0 rounded-full bg-current opacity-80' />
      {children}
    </Badge>
  );
}

/** A small outlined copy button beside a value. */
function CopyButton({ text, what }: { text: string; what: string }) {
  return (
    <Button type='button' variant='outline' size='icon-sm' aria-label={`Copy ${what}`} title={`Copy ${what}`} data-copy=''
      className='text-muted-foreground hover:text-foreground shrink-0' onClick={() => void copyWithToast(text, `${what} copied`)}>
      <Icons.copy aria-hidden />
    </Button>
  );
}

/** A date: relative words, the exact date on hover and focus (and to a screen reader, through <time>). */
export function DateText({ v, relative }: { v: unknown; relative: boolean }) {
  const w = dateWords(v);
  if (!w) return <>{String(v)}</>;
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={w.iso} tabIndex={0} className='decoration-muted-foreground/50 cursor-default underline decoration-dotted underline-offset-4' />}>
        {relative ? w.relative : w.absolute}
      </TooltipTrigger>
      <TooltipContent>{relative ? w.absolute : w.relative}</TooltipContent>
    </Tooltip>
  );
}

/** A field's value on the laid-out page: by its type, an enum as its badge, a date and a number in words, the rest as everywhere. */
function LaidOutValue({ area, base, layout, f, v, recordKey, relative = false, unit }: {
  area: RecordAreaSpec; base: 'app' | 'admin'; layout: DetailLayout; f: RecordFieldSpec; v: unknown; recordKey: string; relative?: boolean; unit?: string;
}) {
  if (isEmptyValue(v)) return <span className='text-muted-foreground'>—</span>;
  if (f.encrypted) return <FieldValue area={area} base={base} f={f} v={v} recordKey={recordKey} />;
  if (f.type === 'enum') return (
    <span className='flex flex-wrap gap-1.5'>
      {(Array.isArray(v) ? v : [v]).map((x) => <ToneBadge key={String(x)} color={badgeColor(layout, f.name, x)}>{optionWords(f, x)}</ToneBadge>)}
    </span>
  );
  if (f.type === 'date') return <DateText v={v} relative={relative} />;
  if (f.type === 'number') return isTimeUnit(unit)
    ? <span className='tabular-nums' title={`${numberWords(v)} ${unit}`}>{numberWords(v, unit)}</span>
    : <span className='tabular-nums'>{numberWords(v, unit)}</span>;
  // mold_v0-256: an address in a fact wraps at its slashes (never inside a word), a piece too long for its box truncated.
  if (relative && f.type === 'url' && typeof v === 'string') return <LinkText href={v} />;
  return <span className='whitespace-pre-wrap'><FieldValue area={area} base={base} f={f} v={v} recordKey={recordKey} /></span>;
}

/**
 * A web address in a header fact (mold_v0-256): its pieces (after each /, ?, & and =) each kept whole, so it wraps only
 * between them; a piece longer than the fact's box is cut with an ellipsis, the whole address on hover and focus.
 */
export function LinkText({ href }: { href: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<a href={href} target='_blank' rel='noopener noreferrer nofollow' className='inline max-w-full underline-offset-4 hover:underline [overflow-wrap:normal] [word-break:normal]' data-link-text='' />}>
        {linkPieces(href).map((p, i) => <span key={i} className='inline-block max-w-full truncate align-bottom'>{p}</span>)}
      </TooltipTrigger>
      <TooltipContent className='max-w-96 break-all'>{href}</TooltipContent>
    </Tooltip>
  );
}

/** One label and value of a section or the facts, with its copy button when the field is copyable and has a value. */
function FieldCell({ label, children, copy, className }: { label: ReactNode; children: ReactNode; copy?: { text: string; what: string } | null; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)} data-detail-field=''>
      <dt className='text-muted-foreground text-xs font-medium'>{label}</dt>
      <dd className='flex min-w-0 items-start gap-2 text-sm leading-relaxed break-words'>
        <span className='min-w-0'>{children}</span>
        {copy && <CopyButton text={copy.text} what={copy.what} />}
      </dd>
    </div>
  );
}
const copyOf = (f: RecordFieldSpec, v: unknown) => ((f as LaidOutField).copyable && !isEmptyValue(v) ? { text: copyText(v), what: f.label } : null);

/** A section: a full-width card, its groups of fields in its columns, or its empty state. */
function SectionCard({ s, area, base, layout, record, id }: { s: DetailSection; area: RecordAreaSpec; base: 'app' | 'admin'; layout: DetailLayout; record: RecordRow; id: string }) {
  const empty = sectionEmpty(s, record.data);
  return (
    <Card className='w-full gap-0 py-0' data-detail-section={id} aria-labelledby={`${id}-title`} role='region'>
      <CardHeader className='border-b py-3.5 [.border-b]:pb-3.5'>
        <CardTitle id={`${id}-title`} className='text-sm font-semibold'>{s.title}</CardTitle>
      </CardHeader>
      <CardContent className='py-4'>
        {empty ? (
          <div className='flex items-center gap-3 py-2' data-section-empty=''>
            <Icons.inbox aria-hidden className='text-muted-foreground size-5 shrink-0' />
            <p className='text-muted-foreground text-sm'>{s.empty ?? 'Nothing here yet.'}</p>
          </div>
        ) : (
          <div className='flex flex-col gap-5'>
            {sectionGroups(s).map((g, gi) => (
              <div key={gi} className={cn('flex flex-col gap-3', gi > 0 && 'border-t pt-5')}>
                {g.title && <h3 className='text-muted-foreground text-xs font-semibold tracking-wide uppercase'>{g.title}</h3>}
                <dl className={cn('grid gap-x-8 gap-y-5', columnsClass(s.columns))}>
                  {g.fields.map((n) => {
                    const f = area.fields.find((x) => x.name === n);
                    if (!f) return null;
                    const v = record.data[n];
                    return (
                      <FieldCell key={n} label={f.label} copy={copyOf(f, v)} className={f.type === 'json' && s.columns !== 1 ? 'sm:col-span-full' : undefined}>
                        <LaidOutValue area={area} base={base} layout={layout} f={f} v={v} recordKey={record.key} unit={layout.header?.facts?.find((x) => x.field === n)?.unit} />
                      </FieldCell>
                    );
                  })}
                </dl>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type PageLoad = { data: PageData | null; error: Error | null };

/** A section of the open tab: its fields, a related list or the record's runs (mold_v0-254). */
function AnySection({ s, id, pageKey, area, base, layout, record, page, data, changed }: {
  s: DetailSection; id: string; area: RecordAreaSpec; base: 'app' | 'admin'; layout: DetailLayout; record: RecordRow; page: PageLoad;
  /** Its key in the page's answer (<tab>-<section>): a history section's Show older asks for it. */
  pageKey: string;
  data: RelatedData | RunsData | HistoryData | undefined; changed: () => void;
}) {
  // Staff pages read no workspace's lists or runs: those sections are a workspace's.
  if ((s.related || s.runs) && base !== 'app') return null;
  if (s.related) return <RelatedSection s={s} id={id} base={base} record={record} page={page} data={data as RelatedData | undefined} changed={changed} />;
  if (s.runs) return <RunsSection s={s} id={id} page={page} data={data as RunsData | undefined} />;
  // mold_v0-256: a log, the change history, a code view, a table, a file browser.
  const copy = (t: string, done: string) => void copyWithToast(t, done);
  const fieldLabel = (n: string) => area.fields.find((f) => f.name === n)?.label ?? n;
  if (s.log) {
    const v = record.data[s.log.field];
    return (
      <ListCard id={id} kind='log' title={s.title}>
        <LogViewer lines={linesOf(v)} live={logLive(s, record.data)} name={[record.key, s.log.field]} label={`${record.title || record.key}: ${fieldLabel(s.log.field)}`}
          empty={s.empty ?? 'No log lines yet.'} copied={(ok) => (ok ? toast.success('Line copied') : toast.error('Could not copy: select the line and copy it yourself.'))} />
      </ListCard>
    );
  }
  if (s.history) {
    if (base !== 'app') return null;
    if (page.data && !data) return null;
    return (
      <ListCard id={id} kind='history' title={s.title}>
        {page.error && !data ? <div className='px-6 py-4'><ErrorState error={page.error} /></div> : !data ? <ListLoading />
          : <HistoryList area={area} data={data as unknown as HistoryData} empty={s.empty ?? 'No changes recorded yet.'}
              url={`/api/records/_page/${encodeURIComponent(area.name)}/${encodeURIComponent(record.key)}/history?section=${pageKey}`} />}
      </ListCard>
    );
  }
  if (s.code) {
    const v = record.data[s.code.field], f = area.fields.find((x) => x.name === s.code!.field);
    return (
      <ListCard id={id} kind='code' title={s.title}>
        {isEmptyValue(v) ? <ListEmpty text={s.empty ?? 'Nothing here yet.'} />
          : <CodeView value={v} language={languageOf(v, s.code.language, f?.type)} name={s.code.field} label={fieldLabel(s.code.field)} copy={copy} />}
      </ListCard>
    );
  }
  if (s.table) return (
    <ListCard id={id} kind='table' title={s.title}>
      <JsonTable value={record.data[s.table.field]} columns={s.table.columns} label={fieldLabel(s.table.field)} copy={copy} empty={s.empty ?? 'Nothing here yet.'} />
    </ListCard>
  );
  if (s.files) return (
    <ListCard id={id} kind='files' title={s.title}>
      <FileBrowser area={area} base={base} recordKey={record.key} fields={s.files.fields} empty={s.empty ?? 'No files on this record yet.'} />
    </ListCard>
  );
  return <SectionCard s={s} id={id} area={area} base={base} layout={layout} record={record} />;
}

/**
 * A list section's card: its title, an optional link at the right (Show all), then its body. mold_v0-256: no count
 * beside the title (the list says what it holds; Show all stays a button).
 */
function ListCard({ id, title, link, children, kind }: { id: string; title: string; link?: ReactNode; children: ReactNode; kind: 'related' | 'runs' | 'log' | 'history' | 'code' | 'table' | 'files' }) {
  return (
    <Card className='w-full gap-0 py-0' data-detail-section={id} data-section-kind={kind} aria-labelledby={`${id}-title`} role='region'>
      <CardHeader className='flex flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b py-3 [.border-b]:pb-3'>
        <CardTitle id={`${id}-title`} className='text-sm font-semibold'>{title}</CardTitle>
        {link}
      </CardHeader>
      <CardContent className='px-0 py-0'>{children}</CardContent>
    </Card>
  );
}
/** A list section's empty state, as a fields section's. */
const ListEmpty = ({ text }: { text: string }) => (
  <div className='flex items-center gap-3 px-6 py-5' data-section-empty=''>
    <Icons.inbox aria-hidden className='text-muted-foreground size-5 shrink-0' />
    <p className='text-muted-foreground text-sm'>{text}</p>
  </div>
);
const ListLoading = () => (
  <div className='flex flex-col gap-2 px-6 py-4' aria-busy='true' data-section-loading=''>
    {[0, 1, 2].map((i) => <div key={i} className='bg-muted h-5 animate-pulse rounded' style={{ width: `${80 - i * 15}%` }} />)}
  </div>
);
const TH = 'text-muted-foreground h-9 px-3 text-left align-middle text-xs font-medium whitespace-nowrap first:pl-6 last:pr-6';
const TD = 'px-3 py-2.5 align-middle first:pl-6 last:pr-6';

/** A cell of a related list: as the area's list shows it (an enum its layout colours as a badge). */
function RelatedCell({ target, f, v, recordKey }: { target: RecordAreaSpec; f: RecordFieldSpec; v: unknown; recordKey: string }) {
  if (isEmptyValue(v)) return <span className='text-muted-foreground'>—</span>;
  const tl = (target as RecordAreaSpec & { detail?: DetailLayout }).detail ?? null;
  if (f.type === 'enum' && !f.encrypted) return (
    <span className='flex flex-wrap gap-1'>{(Array.isArray(v) ? v : [v]).map((x) => <ToneBadge key={String(x)} color={badgeColor(tl, f.name, x)}>{optionWords(f, x)}</ToneBadge>)}</span>
  );
  // mold_v0-256: a number with the unit its own page gives it (a duration in seconds reads "21m 52s", a share "87.4%").
  const unit = f.type === 'number' ? columnUnit(target, f.name) : undefined;
  if (unit) return <span className='tabular-nums' title={isTimeUnit(unit) ? `${numberWords(v)} ${unit}` : undefined} data-unit={unit}>{numberWords(v, unit)}</span>;
  const t = fieldText(f, v, recordKey);
  return <span className={cn('line-clamp-2', f.type === 'number' && 'tabular-nums')}>{t}</span>;
}

/**
 * A related list (mold_v0-254): the records of another area that point back to this one, newest first unless it says
 * another order, at most its limit, then Show all (that area's list, narrowed to this record). A table on a desktop, a
 * list of cards on a phone; each row opens its record and has its own actions.
 */
function RelatedSection({ s, id, base, record, page, data, changed }: {
  s: DetailSection; id: string; base: 'app' | 'admin'; record: RecordRow; page: PageLoad; data: RelatedData | undefined; changed: () => void;
}) {
  const target = findRecordArea(base, s.related!.area);
  // Hidden from this role (it may not read that area), or nothing for it in the page's answer: no card at all.
  if (!target || data?.hidden || (page.data && !data)) return null;
  // mold_v0-256: each column its field and its own heading, when it has one.
  const cols = relatedColumns(target, s.related!).map((c) => ({ ...target.fields.find((f) => f.name === c.field)!, label: c.label ?? target.fields.find((f) => f.name === c.field)?.label ?? c.field })).filter((f) => !!f.name);
  const href = (k: string) => `/${base}/records/${target.name}/${encodeURIComponent(k)}`;
  const rows = data && !data.hidden ? data.records : [];
  const more = !!(data && !data.hidden && data.more);
  const all = data && !data.hidden && data.match !== null ? showAllHref(base, target.name, data.via, data.match ?? record.key) : null;
  const hostOf = (r: (typeof rows)[number]): ActionHost => ({ area: target.name, areaLabel: target.label, base, record: { key: r.key, title: r.title, data: r.data, updated_at: r.updated_at },
    copy: (t, done) => void copyWithToast(t, done), changed, deleted: changed });
  return (
    <ListCard id={id} kind='related' title={s.title}
      link={all && more ? <Button variant='outline' size='sm' nativeButton={false} render={<Link href={all} />} data-show-all=''>Show all<Icons.arrowRight aria-hidden data-icon='inline-end' /></Button> : undefined}>
      {page.error && !data ? <div className='px-6 py-4'><ErrorState error={page.error} /></div>
        : !data ? <ListLoading />
        : !rows.length ? <ListEmpty text={s.empty ?? `No ${target.label.toLowerCase()} point to this record yet.`} />
        : (<>
          <div className='hidden overflow-x-auto md:block'>
            <table className='w-full caption-bottom text-sm' data-related-table=''>
              <thead className='[&_tr]:border-b'>
                <tr><th scope='col' className={TH}>{singularLabel(target.label)}</th>{cols.map((f) => <th key={f.name} scope='col' className={cn(TH, f.type === 'number' && 'text-right')}>{f.label}</th>)}<th scope='col' className={cn(TH, 'w-10')}><span className='sr-only'>Actions</span></th></tr>
              </thead>
              <tbody className='[&_tr:last-child]:border-0'>
                {rows.map((r) => (
                  <tr key={r.key} className='hover:bg-muted/40 border-b transition-colors' data-related-row={r.key}>
                    <td className={cn(TD, 'min-w-40')}>
                      <Link href={href(r.key)} className='font-medium underline-offset-4 hover:underline'>{r.title || r.key}</Link>
                      {r.title && r.title !== r.key && <span className='text-muted-foreground block font-mono text-xs break-all'>{r.key}</span>}
                    </td>
                    {cols.map((f) => <td key={f.name} className={cn(TD, f.type === 'number' && 'text-right')}><RelatedCell target={target} f={f} v={r.data[f.name]} recordKey={r.key} /></td>)}
                    <td className={cn(TD, 'w-10 text-right')}><RowActions host={hostOf(r)} actions={r.actions} href={href(r.key)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className='divide-y md:hidden' data-related-list=''>
            {rows.map((r) => (
              <li key={r.key} className='flex items-start gap-3 px-4 py-3' data-related-row={r.key}>
                <div className='flex min-w-0 flex-1 flex-col gap-1.5'>
                  <Link href={href(r.key)} className='font-medium underline-offset-4 hover:underline'>{r.title || r.key}</Link>
                  <dl className='grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs'>
                    {cols.map((f) => (
                      <div key={f.name} className='flex min-w-0 flex-col gap-0.5'>
                        <dt className='text-muted-foreground'>{f.label}</dt>
                        <dd className='min-w-0 text-sm break-words'><RelatedCell target={target} f={f} v={r.data[f.name]} recordKey={r.key} /></dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <RowActions host={hostOf(r)} actions={r.actions} href={href(r.key)} />
              </li>
            ))}
          </ul>
          {more && all && (
            <div className='border-t px-6 py-2.5 text-xs md:hidden'>
              <Link href={all} className='text-primary underline-offset-4 hover:underline'>Show all {target.label.toLowerCase()}</Link>
            </div>
          )}
        </>)}
    </ListCard>
  );
}
const singularLabel = (label: string) =>
  /ies$/i.test(label) ? label.replace(/ies$/i, 'y') : /(ss|us)$/i.test(label) ? label : /(ches|shes|xes|sses)$/i.test(label) ? label.replace(/es$/i, '') : label.replace(/s$/i, '');

/** A run's link (mold_v0-256): its own page, /app/runs/<id> (with the flag on, which this page needs). */
const runHref = (_pack: string, id: string) => `/app/runs/${encodeURIComponent(id)}`;

/** The record's runs (mold_v0-254): newest first, at most its limit, each with its state, timing, cost and who started it. */
function RunsSection({ s, id, page, data }: { s: DetailSection; id: string; page: PageLoad; data: RunsData | undefined }) {
  const runs = data?.runs ?? [];
  if (page.data && !data) return null;
  const tab = runs.length ? packTabs.find((x) => x.pack === runs[0]!.pack && x.kind === 'runs') : null;
  const status = (r: (typeof runs)[number]) => (
    <span title={r.status === 'failed' && r.error ? r.error : undefined}><ToneBadge color={RUN_STATUS_COLOR[r.status] ?? 'neutral'}>{statusLabel(r.status)}</ToneBadge></span>
  );
  const kind = (r: (typeof runs)[number]) => { const h = runHref(r.pack, r.id); const label = runKindLabel(r.pack, r.kind);
    return h ? <Link href={h} className='font-medium underline-offset-4 hover:underline' data-run-link={r.id}>{label}</Link> : <span className='font-medium'>{label}</span>; };
  const started = (r: (typeof runs)[number]) => (r.started_at ?? r.created_at ? <DateText v={r.started_at ?? r.created_at} relative /> : <span className='text-muted-foreground'>—</span>);
  const took = (r: (typeof runs)[number]) => duration(runSeconds(r)) || '—';
  return (
    <ListCard id={id} kind='runs' title={s.title}
      link={tab && data && data.total > runs.length ? <Button variant='outline' size='sm' nativeButton={false} render={<Link href={tab.url} />} data-all-runs=''>All runs<Icons.arrowRight aria-hidden data-icon='inline-end' /></Button> : undefined}>
      {page.error && !data ? <div className='px-6 py-4'><ErrorState error={page.error} /></div>
        : !data ? <ListLoading />
        : !runs.length ? <ListEmpty text={s.empty ?? 'Nothing has run on this record yet.'} />
        : (<>
          <div className='hidden overflow-x-auto md:block'>
            <table className='w-full text-sm' data-runs-table=''>
              <thead className='[&_tr]:border-b'>
                <tr>{['Run', 'Status', 'Started', 'Duration', 'Cost', 'By'].map((h) => <th key={h} scope='col' className={cn(TH, (h === 'Duration' || h === 'Cost') && 'text-right')}>{h}</th>)}</tr>
              </thead>
              <tbody className='[&_tr:last-child]:border-0'>
                {runs.map((r) => (
                  <tr key={r.id} className='hover:bg-muted/40 border-b transition-colors' data-run-row={r.id}>
                    <td className={cn(TD, 'min-w-44')}>{kind(r)}<span className='text-muted-foreground block font-mono text-xs break-all'>{r.id}</span></td>
                    <td className={TD}>{status(r)}</td>
                    <td className={cn(TD, 'whitespace-nowrap')}>{started(r)}</td>
                    <td className={cn(TD, 'text-right tabular-nums')}>{took(r)}</td>
                    <td className={cn(TD, 'text-right tabular-nums')}>{formatValue(r.cost_usd, 'usd')}</td>
                    <td className={cn(TD, 'max-w-48 truncate')} title={r.by}>{r.by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className='divide-y md:hidden' data-runs-list=''>
            {runs.map((r) => (
              <li key={r.id} className='flex flex-col gap-1.5 px-4 py-3' data-run-row={r.id}>
                <div className='flex items-start justify-between gap-3'>{kind(r)}{status(r)}</div>
                <p className='text-muted-foreground flex flex-wrap gap-x-2 text-xs'>
                  <span>{started(r)}</span><span aria-hidden>·</span><span className='tabular-nums'>{took(r)}</span><span aria-hidden>·</span>
                  <span className='tabular-nums'>{formatValue(r.cost_usd, 'usd')}</span><span aria-hidden>·</span><span className='break-all'>{r.by}</span>
                </p>
              </li>
            ))}
          </ul>
        </>)}
    </ListCard>
  );
}

const NOTICE_ICON: Record<NoticeTone, keyof typeof Icons> = { info: 'info', success: 'circleCheck', warning: 'warning', danger: 'alertCircle' };
/**
 * A fact computed from related records (mold_v0-256), as the server answered it for this person: a count (linked to that
 * area's list narrowed to this record), or the newest related record's value formatted as its own page shows it (an
 * enum as its badge, a number with its unit, a date in words), linked to that record.
 */
function ComputedValue({ fact, answer, loading, base, recordKey }: { fact: DetailFact; answer: ComputedFact | undefined; loading: boolean; base: 'app' | 'admin'; recordKey: string }) {
  if (loading) return <span className='bg-muted inline-block h-4 w-12 animate-pulse rounded align-middle' aria-busy='true' />;
  if (!answer || answer.hidden) return <span className='text-muted-foreground'>—</span>;
  if (answer.op === 'count') {
    const words = countWords(answer.value, answer.capped, fact.unit);
    return answer.via
      ? <Link href={showAllHref(base, answer.area, answer.via, recordKey)} className='tabular-nums underline-offset-4 hover:underline' data-computed-count={answer.value}>{words}</Link>
      : <span className='tabular-nums'>{words}</span>;
  }
  const target = recordAreas.find((a) => a.name === answer.area);
  const f = target?.fields.find((x) => x.name === answer.field);
  if (isEmptyValue(answer.value) || !target || !f) return <span className='text-muted-foreground'>—</span>;
  const tl = (target as RecordAreaSpec & { detail?: DetailLayout }).detail ?? null;
  const v = answer.value;
  const shown = f.type === 'enum' ? <ToneBadge color={badgeColor(tl, f.name, v)}>{optionWords(f, v)}</ToneBadge>
    : f.type === 'number' ? <span className='tabular-nums'>{numberWords(v, fact.unit ?? columnUnit(target, f.name))}</span>
    : f.type === 'date' ? <DateText v={v} relative />
    : <span className='break-words'>{fieldText(f, v)}</span>;
  if (!answer.record) return shown;
  return (
    <span className='inline-flex flex-wrap items-center gap-x-2 gap-y-1'>
      {shown}
      <Link href={`/${base}/records/${answer.area}/${encodeURIComponent(answer.record.key)}`} className='text-muted-foreground text-xs font-normal underline-offset-4 hover:underline' data-computed-from={answer.record.key}>
        {answer.record.title || answer.record.key}
      </Link>
    </span>
  );
}

/** Where a workspace record came from, in words (mold_v0-236; the same words as the page without a layout). */
const ADDED_BY: Record<string, string> = { people: 'A person of this workspace', staff: 'Platform staff', intake: 'The email intake', run: "The app's own automation", repository: 'Its data source' };

/** Whether a layout reads anything from the page's own route (mold_v0-254): actions, a related list, the record's runs. */
const readsPage = (layout: DetailLayout) => declaresActions(layout) || readsHistory(layout) || readsComputed(layout) || layout.tabs.some((t) => t.sections.some((s) => s.related || s.runs));

async function getPage(url: string): Promise<PageData> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as PageData & { error?: string };
  if (!res.ok) throw httpError(res.status, body);
  return body;
}

export function LaidOutRecord({ area, base, layout, record, links, clockEvents, provenance, where, credentials, onChanged }: {
  area: RecordAreaSpec; base: 'app' | 'admin'; layout: DetailLayout; record: RecordRow; links: Links; clockEvents?: ClockEvent[];
  provenance?: { by: string | null } | null; where: string; credentials: ReactNode;
  /** Read the record again (mold_v0-254: after an action changed it). */
  onChanged?: () => void;
}) {
  const [asked, setAsked] = useQueryState('tab');
  const tab = openTab(layout, asked);
  const first = tab === layout.tabs[0];
  const ti = layout.tabs.indexOf(tab);
  // mold_v0-254: the page's actions and the open tab's related lists and runs, a workspace's (staff pages read none).
  const reads = base === 'app' && readsPage(layout);
  const pageUrl = reads ? `/api/records/_page/${encodeURIComponent(area.name)}/${encodeURIComponent(record.key)}?tab=${tabId(tab.label)}` : null;
  const page = useOrgLoad(() => (pageUrl ? getPage(pageUrl) : Promise.resolve(null)), [pageUrl]);
  // The header's actions stay as they were while another tab's sections load (they do not depend on the tab).
  const [actions, setActions] = useState<PageData['actions'] | null>(null);
  useEffect(() => { if (page.data) setActions(page.data.actions); }, [page.data]);
  const changed = () => { void page.reload(); onChanged?.(); };
  const host: ActionHost = { area: area.name, areaLabel: area.label, base, record, copy: (t, done) => void copyWithToast(t, done), changed };
  const withActions = base === 'app' && declaresActions(layout);
  const { bar, card, panel } = usePageActionsBar(host, withActions ? actions ?? page.data?.actions ?? [] : [], !actions && !page.data && !page.error, declaresCopyLink(layout));
  // mold_v0-256: a log section that is live (its live_when holds) reads the record again every few seconds.
  const live = tab.sections.some((s) => logLive(s, record.data, record.clocks));
  useEffect(() => {
    if (!live || !onChanged) return;
    const t = setInterval(() => onChanged(), LOG_POLL_MS);
    return () => clearInterval(t);
  }, [live, onChanged]);
  // An action's form (a run, an edit, a new related record): a full card in the page's place; with side_panel_forms on,
  // an edit's or a new record's opens first in a panel over the page (FormHost, mold_v0-256).
  return (
    <FormHost card={withActions && card ? <div className='flex w-full flex-col gap-4' data-page-action-card=''>{card}</div> : null} panel={panel}>
      <LaidOutBody area={area} base={base} layout={layout} record={record} links={links} clockEvents={clockEvents} provenance={provenance} where={where}
        credentials={credentials} tab={tab} ti={ti} first={first} page={page} changed={changed} withActions={withActions} bar={bar} setAsked={setAsked} />
    </FormHost>
  );
}

/** The laid-out page itself: the header, the notices, the tabs and their sections. */
function LaidOutBody({ area, base, layout, record, links, clockEvents, provenance, where, credentials, tab, ti, first, page, changed, withActions, bar, setAsked }: {
  area: RecordAreaSpec; base: 'app' | 'admin'; layout: DetailLayout; record: RecordRow; links: Links; clockEvents?: ClockEvent[];
  provenance?: { by: string | null } | null; where: string; credentials: ReactNode; tab: DetailLayout['tabs'][number]; ti: number; first: boolean;
  page: PageLoad & { data: PageData | null }; changed: () => void; withActions: boolean; bar: ReactNode; setAsked: (v: string | null) => unknown;
}) {
  const h = layout.header ?? {};
  const field = (n?: string) => (n ? area.fields.find((f) => f.name === n) : undefined);
  const titleField = field(h.title);
  const title = titleField && !isEmptyValue(record.data[titleField.name]) ? String(record.data[titleField.name]) : record.title || record.key;
  const subtitle = field(h.subtitle);
  // mold_v0-256: a computed fact is shown once the server answered it for this person (hidden from one who may not read its area).
  const facts = (h.facts ?? []).map((x, i) => ({ ...x, i, f: field(x.field) }))
    .filter((x) => (x.computed ? !(page.data?.facts?.[String(x.i)] as { hidden?: boolean } | undefined)?.hidden && (base === 'app') : !!x.f));
  const notices = shownNotices(layout, record.data, record.clocks);
  const added = h.creator !== false && provenance?.by ? ADDED_BY[provenance.by] ?? provenance.by : null;
  const rest = unplacedFields(area, layout).filter((f) => !isStoredFile(f, record.data[f.name]) && !isEmptyValue(record.data[f.name]));
  const updated = dateWords(record.updated_at);
  const sectionId = (i: number) => `detail-${tabId(tab.label)}-${i}`;

  return (
    <div className='flex w-full flex-col gap-4 md:gap-6' data-record-layout=''>
      <Card className='w-full gap-0 py-0' data-record-header=''>
        <CardContent className='flex flex-col gap-5 py-5'>
          <div className='flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between'>
            <div className='flex min-w-0 flex-col gap-2'>
              <p className='text-muted-foreground text-xs'>{area.label} · {where}</p>
              <h1 className='text-xl leading-tight font-semibold tracking-tight break-words md:text-2xl'>{title}</h1>
              {subtitle && !isEmptyValue(record.data[subtitle.name]) && (
                <p className='text-muted-foreground max-w-prose text-sm leading-relaxed break-words' data-record-subtitle=''>{String(record.data[subtitle.name])}</p>
              )}
              {!!h.badges?.length && (
                <div className='flex flex-wrap items-center gap-2 pt-1' data-record-badges=''>
                  {h.badges.map((b) => {
                    const f = field(b.field), v = record.data[b.field];
                    return f && !isEmptyValue(v) ? <ToneBadge key={b.field} color={badgeColor(layout, b.field, v)}><span className='sr-only'>{f.label}: </span>{optionWords(f, v)}</ToneBadge> : null;
                  })}
                </div>
              )}
            </div>
            {withActions ? bar : (
              <div className='flex shrink-0 flex-wrap gap-2'>
                <Button type='button' variant='outline' size='sm' data-copy-id='' onClick={() => void copyWithToast(record.key, 'Record ID copied')}>
                  <Icons.copy aria-hidden data-icon='inline-start' />Copy ID
                </Button>
                <Button type='button' variant='outline' size='sm' data-copy-link='' onClick={() => void copyWithToast(window.location.href, 'Link copied')}>
                  <Icons.link aria-hidden data-icon='inline-start' />Copy link
                </Button>
              </div>
            )}
          </div>
          {!!facts.length && (
            <dl className='grid grid-cols-2 gap-x-6 gap-y-5 border-t pt-5 sm:grid-cols-3 lg:grid-cols-4' data-record-facts=''>
              {facts.map((x) => x.computed ? (
                <FieldCell key={`computed-${x.i}`} label={x.label ?? ''}>
                  <span className='font-medium' data-computed-fact={x.i}><ComputedValue fact={x} answer={page.data?.facts?.[String(x.i)]} loading={!page.data && !page.error} base={base} recordKey={record.key} /></span>
                </FieldCell>
              ) : (
                <FieldCell key={x.field} label={x.label ?? x.f!.label} copy={copyOf(x.f!, record.data[x.field!])}>
                  <span className='font-medium'><LaidOutValue area={area} base={base} layout={layout} f={x.f!} v={record.data[x.field!]} recordKey={record.key} relative unit={x.unit} /></span>
                </FieldCell>
              ))}
            </dl>
          )}
          <p className='text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-4 text-xs' data-record-meta=''>
            {added && <span data-record-creator=''>Added by <span className='text-foreground'>{added}</span></span>}
            {added && <span aria-hidden>·</span>}
            <span className='min-w-0 break-all'>ID <span className='text-foreground font-mono'>{record.key}</span></span>
            {record.version && <><span aria-hidden>·</span><span>Version <span className='text-foreground'>{record.version}</span></span></>}
            {updated && <><span aria-hidden>·</span><span>Updated <DateText v={record.updated_at} relative /></span></>}
          </p>
        </CardContent>
      </Card>

      {notices.map((n, i) => {
        const Icon = Icons[NOTICE_ICON[n.tone]];
        return (
          <div key={i} role={n.tone === 'info' || n.tone === 'success' ? 'status' : 'alert'} data-record-notice={n.tone}
            className={cn('grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-xl border px-4 py-3 text-sm', NOTICE_CLASS[n.tone])}>
            <Icon aria-hidden className='row-span-2 mt-0.5 size-4' />
            {n.title && <p className='font-medium'>{n.title}</p>}
            <p className={cn('text-foreground/90 leading-relaxed', !n.title && 'row-span-2')}>{n.text}</p>
          </div>
        );
      })}

      {layout.tabs.length > 1 ? (
        <Tabs value={tabId(tab.label)} onValueChange={(v) => void setAsked(v === tabId(layout.tabs[0]!.label) ? null : String(v))} className='w-full gap-4'>
          <div className='max-w-full overflow-x-auto'>
            <TabsList variant='line' className='flex-nowrap justify-start gap-x-6 p-0 group-data-horizontal/tabs:h-auto' data-record-tabs=''>
              {layout.tabs.map((t) => <TabsTrigger key={t.label} value={tabId(t.label)} className='h-9 flex-none px-0'>{t.label}</TabsTrigger>)}
            </TabsList>
          </div>
          <TabsContent value={tabId(tab.label)} className='flex flex-col gap-4 md:gap-6'>
            {tab.sections.map((s, i) => <AnySection key={i} s={s} id={sectionId(i)} pageKey={sectionKey(ti, i)} area={area} base={base} layout={layout} record={record} page={page} data={page.data?.sections[sectionKey(ti, i)]} changed={changed} />)}
            {first && <FirstTabRest area={area} base={base} layout={layout} record={record} rest={rest} links={links} clockEvents={clockEvents} credentials={credentials} />}
          </TabsContent>
        </Tabs>
      ) : (
        <div className='flex w-full flex-col gap-4 md:gap-6'>
          {tab.sections.map((s, i) => <AnySection key={i} s={s} id={sectionId(i)} pageKey={sectionKey(ti, i)} area={area} base={base} layout={layout} record={record} page={page} data={page.data?.sections[sectionKey(ti, i)]} changed={changed} />)}
          <FirstTabRest area={area} base={base} layout={layout} record={record} rest={rest} links={links} clockEvents={clockEvents} credentials={credentials} />
        </div>
      )}
    </div>
  );
}

/** The first tab's end: the fields the layout leaves out, then what every record page has (documents, deadlines, links, credentials). */
function FirstTabRest({ area, base, layout, record, rest, links, clockEvents, credentials }: {
  area: RecordAreaSpec; base: 'app' | 'admin'; layout: DetailLayout; record: RecordRow; rest: RecordFieldSpec[]; links: Links; clockEvents?: ClockEvent[]; credentials: ReactNode;
}) {
  const linked = links.filter((l) => l.records.length);
  return (
    <>
      {!!rest.length && (
        <SectionCard s={{ title: 'Other details', fields: rest.map((f) => f.name), columns: 2 }} id='detail-other' area={area} base={base} layout={layout} record={record} />
      )}
      {/* The record's documents and deadlines, drawn as on every record page; the card shows only when one of them does. */}
      <Card className='w-full gap-0 py-0 [&:not(:has(section))]:hidden' data-record-extras=''>
        <CardContent className='flex flex-col gap-6 py-5'>
          {/* mold_v0-256: a layout with a file browser shows the documents there, not again here. */}
          {!layout.tabs.some((t) => t.sections.some((x) => x.files)) && <RecordDocuments area={area} base={base} recordKey={record.key} count={false} />}
          <ClockSection record={record} events={clockEvents} />
        </CardContent>
      </Card>
      {!!linked.length && (
        <Card className='w-full gap-0 py-0' data-record-links=''>
          <CardHeader className='border-b py-3.5 [.border-b]:pb-3.5'><CardTitle className='text-sm font-semibold'>Linked records</CardTitle></CardHeader>
          <CardContent className='flex flex-col gap-5 py-4'>
            {linked.map((l) => {
              const target = findRecordArea(base, l.area);
              return (
                <section key={l.field} aria-label={`${areaFieldLabel(area, l.field)} · ${target?.label ?? l.area}`} className='flex flex-col gap-2'>
                  <h3 className='text-muted-foreground text-xs font-medium'>{areaFieldLabel(area, l.field)} · {target?.label ?? l.area}</h3>
                  <ul className='flex flex-col gap-1.5 text-sm'>
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
      {credentials}
    </>
  );
}

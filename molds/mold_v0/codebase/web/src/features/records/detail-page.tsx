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
import { RUN_STATUS_WORDS, runStatusOf } from '@/lib/run-status';
import { TargetVersions } from '@/features/agent/dock/target-versions';
import { featureOn } from '@/config/features';
import Link from 'next/link';
import { RunLinkText } from './run-link';
import { createContext, useContext, useEffect, useLayoutEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { packCharts, packTabs, type PackChartSpec, type RecordAreaSpec, type RecordFieldSpec } from '@/config/pack-nav.generated';
import { ErrorState, useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { ChartCell, formatValue, type MetricResult } from '@/features/tabs/charts';
import { OutcomeBadge, RunStatusBadge } from '@/features/agent/run-badges';
import { RUN_STATUSES, type RunNeeds, type RunOutcomeBadge, type RunStatus } from '@/lib/run-status';
import { duration, runKindLabel, runSeconds, statusLabel } from '@/features/tabs/run-rows';
import { recordAreas } from '@/config/pack-nav.generated';
import { cn } from '@/lib/utils';
import { useInRecordPanel, useOpenRelated, usePanelHeaderSlots, useRecordPanelFull } from '@/components/layout/detail-panel';
import { createPortal } from 'react-dom';
import { CopyLink, LinkRow, NoticeLine, RailEmpty, RailFields, RailHeading, RailNumbers, RailSection, RailSteps, TextLink, type RailRow } from './record-kit';
import { ClockSection, type ClockEvent } from './clocks';
import { RecordDocuments, isStoredFile } from './documents';
import {
  addedByWords, BADGE_CLASS, staleWords, fieldLabelShown, LOG_POLL_MS, NOTICE_CLASS, RUN_STATUS_COLOR, badgeColor, columnUnit, columnsClass, copyText, countWords, dateRule, dateWords, declaresActions, factShown, declaresCopyLink, isEmptyValue,
  isTimeUnit, linkedShown, linkPieces, logLive, numberWords, sectionShown, openTab, shownTabs, optionWords, readsComputed, readsHistory, relatedColumns, sectionEmpty, sectionGroups, sectionKey, showAllHref,
  shownNotices, tabId, unplacedFields, dotTone, headerContext, isRail, railBadges, railHeaderFields, relatedRowWords, stepRows, stateSince, sinceWords,
  type BadgeColor, type ComputedFact, type DetailFact, type DetailLayout, type DetailSection, type HistoryData, type LaidOutField, type NoticeTone, type PageData,
  type RelatedData, type RunsData, type SessionsData, type AgentRunsData
} from './detail-layout';
import { RowActions, usePageActionsBar, type ActionHost, type RailActions } from './page-actions';
import { CodeView, JsonTable } from './code-view';
import { languageOf } from './code-text';
import { FileBrowser } from './file-browser';
import { HistoryList } from './history-section';
import { linesOf } from './log-lines';
import { LogViewer } from './log-viewer';
import { FormHost } from '@/features/tabs/tab-action';
import { areaFieldLabel, findRecordArea } from './registry';
import { Chips, chipValues, FieldValue, fieldText, refTarget, shownText, refWords, type RecordRow } from './record-pages';
import { inheritedVisibility, ShareButton, VisibilityBadge, visibilityOf } from '@/features/teams/visibility';

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

/**
 * A date by the page's one rule (mold_v0-309, ./detail-layout.ts dateRule): within 7 days relative words, else the day
 * ("15 Nov 2026"); the other form on hover and focus (and to a screen reader, through <time>).
 */
/** mold_v0-339: the day a record entered its state ("3 Oct"), the exact time on hover. */
function SinceText({ at }: { at: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={at} tabIndex={0} className='decoration-muted-foreground/50 cursor-default underline decoration-dotted underline-offset-4 whitespace-nowrap' />}>
        {sinceWords(at)}
      </TooltipTrigger>
      <TooltipContent>{new Date(at).toLocaleString()}</TooltipContent>
    </Tooltip>
  );
}
export function DateText({ v }: { v: unknown }) {
  const w = dateRule(v);
  if (!w) return <>{String(v)}</>;
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={w.iso} tabIndex={0} className='decoration-muted-foreground/50 cursor-default underline decoration-dotted underline-offset-4 whitespace-nowrap' />}>
        {w.text}
      </TooltipTrigger>
      <TooltipContent>{w.hover}</TooltipContent>
    </Tooltip>
  );
}

/** A field's value on the laid-out page: by its type, an enum as its badge, a date and a number in words, the rest as everywhere. */
function LaidOutValue({ area, base, layout, f, v, recordKey, fact = false, unit, titles, linkText }: {
  area: RecordAreaSpec; base: 'app' | 'admin'; layout: DetailLayout; f: RecordFieldSpec; v: unknown; recordKey: string;
  /** A header fact's value (an address wraps at its slashes). */
  fact?: boolean; unit?: string;
  /** mold_v0-262: a reference's records' titles (the record's ref_titles of this field). */
  titles?: Record<string, string>;
  /** mold_v0-329: a fact's words for its web address (link_text). */
  linkText?: string;
}) {
  if (isEmptyValue(v)) return <span className='text-muted-foreground'>—</span>;
  if (f.encrypted) return <FieldValue area={area} base={base} f={f} v={v} recordKey={recordKey} />;
  // mold_v0-300: a number without a fact's unit takes its field's own (usd reads "$0.90", s "21m 52s").
  unit = unit ?? f.unit;
  if (f.type === 'enum') return (
    <span className='flex flex-wrap gap-1.5'>
      {(Array.isArray(v) ? v : [v]).map((x) => <ToneBadge key={String(x)} color={badgeColor(layout, f.name, x)}>{optionWords(f, x)}</ToneBadge>)}
    </span>
  );
  if (f.type === 'date') return <DateText v={v} />;
  if (f.type === 'number') return isTimeUnit(unit)
    ? <span className='tabular-nums' title={`${numberWords(v)} ${unit}`}>{numberWords(v, unit)}</span>
    : <span className='tabular-nums'>{numberWords(v, unit)}</span>;
  // mold_v0-256: an address in a fact wraps at its slashes (never inside a word), a piece too long for its box truncated.
  if (fact && f.type === 'url' && typeof v === 'string') return <LinkText href={v} text={linkText} />;
  // mold_v0-298: a block (FieldValue may draw a log's table), still inline-sized beside a fact's label.
  return <span className='block whitespace-pre-wrap'><FieldValue area={area} base={base} f={f} v={v} recordKey={recordKey} titles={titles} /></span>;
}

/**
 * A web address in a header fact (mold_v0-256): its pieces (after each /, ?, & and =) each kept whole, so it wraps only
 * between them; a piece longer than the fact's box is cut with an ellipsis, the whole address on hover and focus.
 */
export function LinkText({ href, text }: { href: string; /** mold_v0-329: words in place of the address (the address on hover). */ text?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<a href={href} target='_blank' rel='noopener noreferrer nofollow' className={cn('inline max-w-full underline-offset-4 hover:underline [overflow-wrap:normal] [word-break:normal]', text && 'underline')} data-link-text='' />}>
        {text ?? linkPieces(href).map((p, i) => <span key={i} className='inline-block max-w-full truncate align-bottom'>{p}</span>)}
      </TooltipTrigger>
      <TooltipContent className='max-w-96 break-all'>{href}</TooltipContent>
    </Tooltip>
  );
}

/** One label and value of a section or the facts, with its copy button when the field is copyable and has a value. */
function FieldCell({ label, children, copy, className, labelHidden = false }: { label: ReactNode; children: ReactNode; copy?: { text: string; what: string } | null; className?: string; labelHidden?: boolean }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)} data-detail-field=''>
      {/* mold_v0-300: a label the section's title already says is kept for a screen reader only. */}
      <dt className={labelHidden ? 'sr-only' : 'text-muted-foreground text-xs font-medium'} data-label-hidden={labelHidden ? '' : undefined}>{label}</dt>
      <dd className='flex min-w-0 items-start gap-2 text-sm leading-relaxed break-words'>
        <span className='min-w-0'>{children}</span>
        {copy && <CopyButton text={copy.text} what={copy.what} />}
      </dd>
    </div>
  );
}
const copyOf = (f: RecordFieldSpec, v: unknown) => ((f as LaidOutField).copyable && !isEmptyValue(v) ? { text: copyText(v), what: f.label } : null);

/**
 * mold_v0-328: a record tab holding one section whose title is the tab's own name (Builds › Builds) draws no visible
 * card title: the tab strip already says it. The title stays for screen readers (the card is named by it). Not on the
 * first tab, where the record's other cards (Other details, Linked records) follow it.
 */
const SoleSectionTab = createContext<string | null>(null);
function useRepeatsTab(title: string) {
  const tab = useContext(SoleSectionTab);
  return tab != null && tab.trim().toLowerCase() === title.trim().toLowerCase();
}

/** mold_v0-331: the page draws in the rail style (flat sections, label and value rows, thin-bordered tables). */
const RailStyle = createContext(false);
const useRail = () => useContext(RailStyle);

/** A section: a full-width card, its groups of fields in its columns, or its empty state. */
function SectionCard({ s, area, base, layout, record, id, labels = 'auto' }: { s: DetailSection; area: RecordAreaSpec; base: 'app' | 'admin'; layout: DetailLayout; record: RecordRow; id: string; labels?: 'auto' | 'always' }) {
  const empty = sectionEmpty(s, record.data);
  const repeatsTab = useRepeatsTab(s.title);
  const rail = useRail();
  const value = (n: string) => {
    const f = area.fields.find((x) => x.name === n);
    return f ? <LaidOutValue area={area} base={base} layout={layout} f={f} v={record.data[n]} recordKey={record.key} unit={layout.header?.facts?.find((x) => x.field === n)?.unit} titles={record.ref_titles?.[n]} /> : null;
  };
  // mold_v0-331: a section of counts (display numbers): the values right-aligned in a column, each label beside it.
  const numbers = s.display === 'numbers' && !empty
    ? <RailNumbers items={sectionGroups(s).flatMap((g) => g.fields).flatMap((n) => { const f = area.fields.find((x) => x.name === n); return f ? [{ key: n, label: f.label, value: value(n) }] : []; })} />
    : null;
  if (rail) return (
    <RailSection id={id} title={s.title} titleHidden={repeatsTab}>
      {empty ? <RailEmpty>{s.empty ?? 'Nothing here yet.'}</RailEmpty> : numbers ?? (
        <div className='grid gap-4'>
          {sectionGroups(s).map((g, gi) => (
            <div key={gi} className='grid gap-[7px]'>
              {g.title && <h4 className='text-muted-foreground m-0 text-xs font-medium'>{g.title}</h4>}
              <RailFields rows={g.fields.map((n): RailRow => {
                const f = area.fields.find((x) => x.name === n);
                if (!f) return null;
                const c = copyOf(f, record.data[n]);
                return { key: n, label: f.label, value: value(n), labelHidden: labels === 'auto' && !fieldLabelShown(s, f.label),
                  wide: f.type === 'json' || (f.type === 'text' && typeof record.data[n] === 'string' && (record.data[n] as string).length > 120),
                  copy: c ? <CopyLink what={c.what} onCopy={() => copyWithToast(c.text, `${c.what} copied`)} /> : undefined };
              })} />
            </div>
          ))}
        </div>
      )}
    </RailSection>
  );
  if (numbers) return (
    <Card className='w-full gap-0 py-0' data-detail-section={id} aria-labelledby={`${id}-title`} role='region'>
      <CardHeader className={repeatsTab ? 'sr-only' : 'border-b py-3.5 [.border-b]:pb-3.5'}><CardTitle id={`${id}-title`} className='text-sm font-semibold'>{s.title}</CardTitle></CardHeader>
      <CardContent className='py-4'>{numbers}</CardContent>
    </Card>
  );
  return (
    <Card className='w-full gap-0 py-0' data-detail-section={id} aria-labelledby={`${id}-title`} role='region'>
      <CardHeader className={repeatsTab ? 'sr-only' : 'border-b py-3.5 [.border-b]:pb-3.5'} data-title-repeats-tab={repeatsTab ? '' : undefined}>
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
                      <FieldCell key={n} label={f.label} copy={copyOf(f, v)} className={f.type === 'json' && s.columns !== 1 ? 'sm:col-span-full' : undefined} labelHidden={labels === 'auto' && !fieldLabelShown(s, f.label)}>
                        <LaidOutValue area={area} base={base} layout={layout} f={f} v={v} recordKey={record.key} unit={layout.header?.facts?.find((x) => x.field === n)?.unit} titles={record.ref_titles?.[n]} />
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
  data: RelatedData | RunsData | HistoryData | SessionsData | AgentRunsData | undefined; changed: () => void;
}) {
  // Staff pages read no workspace's runs; their related lists are of shared areas only (mold_v0-271: the staff page's
  // own route answers a workspace area's list as hidden, and the section is not drawn).
  if (s.runs && base !== 'app') return null;
  // mold_v0-262: a section shown only while its condition holds on the record.
  if (!sectionShown(s, record.data, record.clocks, page.data?.facts)) return null;
  if (s.related) return <RelatedSection s={s} id={id} base={base} record={record} page={page} data={data as RelatedData | undefined} changed={changed} />;
  if (s.runs) return <RunsSection s={s} id={id} page={page} data={data as RunsData | undefined} />;
  // mold_v0-340: the record's agent sessions, the runs among them, and charts over its records (a workspace's only).
  if ((s.sessions || s.agent_runs || s.charts) && base !== 'app') return null;
  if (s.sessions) return <SessionsSection s={s} id={id} page={page} data={data as SessionsData | undefined} />;
  if (s.agent_runs) return <AgentRunsSection s={s} id={id} page={page} data={data as AgentRunsData | undefined} />;
  if (s.charts) return <ChartsSection s={s} id={id} area={area} record={record} pageKey={pageKey} />;
  // mold_v0-292 (flag nested_runs): the program runs that targeted this record and the versions they made.
  if (s.versions) return featureOn('nested_runs') ? <TargetVersions target={record.key} title={s.title} empty={s.empty} /> : null;
  // mold_v0-331: a lifecycle's progress as numbered steps.
  if (s.steps) return <StepsSection s={s} id={id} area={area} layout={layout} record={record} stateAt={page.data?.state_at ?? null} />;
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
          : <HistoryList area={area} data={data as unknown as HistoryData} empty={s.empty ?? 'No changes recorded yet.'} titles={record.ref_titles}
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
function ListCard({ id, title, link, children, kind }: { id: string; title: string; link?: ReactNode; children: ReactNode; kind: 'related' | 'runs' | 'log' | 'history' | 'code' | 'table' | 'files' | 'sessions' | 'agent_runs' | 'charts' }) {
  const repeatsTab = useRepeatsTab(title);
  // mold_v0-331: the rail style: the small title (its link at the right), the content in a thin border (none round an empty line).
  if (useRail()) return (
    <RailSection id={id} title={title} titleHidden={repeatsTab} action={link} data-section-kind={kind}>
      <div className='min-w-0 overflow-hidden rounded-lg border has-[>[data-section-empty]]:rounded-none has-[>[data-section-empty]]:border-0' data-rail-box=''>{children}</div>
    </RailSection>
  );
  return (
    <Card className='w-full gap-0 py-0' data-detail-section={id} data-section-kind={kind} aria-labelledby={`${id}-title`} role='region'>
      <CardHeader className={repeatsTab && !link ? 'sr-only' : cn('flex flex-row flex-wrap items-center gap-x-4 gap-y-2 border-b py-3 [.border-b]:pb-3', repeatsTab ? 'justify-end' : 'justify-between')}
        data-title-repeats-tab={repeatsTab ? '' : undefined}>
        <CardTitle id={`${id}-title`} className={repeatsTab ? 'sr-only' : 'text-sm font-semibold'}>{title}</CardTitle>
        {link}
      </CardHeader>
      <CardContent className='px-0 py-0'>{children}</CardContent>
    </Card>
  );
}
/** A list section's empty state, as a fields section's. */
const ListEmpty = ({ text }: { text: string }) => useRail() ? <RailEmpty>{text}</RailEmpty> : (
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
const TH_CARD = 'text-muted-foreground h-9 px-3 text-left align-middle text-xs font-medium whitespace-nowrap first:pl-6 last:pr-6';
const TD_CARD = 'px-3 py-2.5 align-middle first:pl-6 last:pr-6';
// mold_v0-331: the rail style's short table: a muted header row, 13px rows, hairlines.
const TH_RAIL = 'bg-muted h-8 px-[9px] text-left align-middle text-[13px] font-semibold whitespace-nowrap first:pl-3 last:pr-3';
const TD_RAIL = 'px-[9px] py-1.5 align-middle text-[13px] first:pl-3 last:pr-3';

/** A cell of a related list: as the area's list shows it (an enum its layout colours as a badge). */
function RelatedCell({ target, f, v, recordKey, titles, base = 'app' }: { target: RecordAreaSpec; f: RecordFieldSpec; v: unknown; recordKey: string; titles?: Record<string, string>; base?: 'app' | 'admin' }) {
  if (isEmptyValue(v)) return <span className='text-muted-foreground'>—</span>;
  // mold_v0-262: a reference column shows the named records' titles, each linked to its record.
  if (refTarget(target, f)) return <span className='line-clamp-2'><FieldValue area={target} base={base} f={f} v={v} recordKey={recordKey} titles={titles} /></span>;
  const chips = chipValues(f, v);
  if (chips) return <Chips values={chips} max={4} />;
  const tl = (target as RecordAreaSpec & { detail?: DetailLayout }).detail ?? null;
  if (f.type === 'enum' && !f.encrypted) return (
    <span className='flex flex-wrap gap-1'>{(Array.isArray(v) ? v : [v]).map((x) => <ToneBadge key={String(x)} color={badgeColor(tl, f.name, x)}>{optionWords(f, x)}</ToneBadge>)}</span>
  );
  // mold_v0-256: a number with the unit its own page gives it (a duration in seconds reads "21m 52s", a share "87.4%").
  const unit = f.type === 'number' ? columnUnit(target, f.name) : undefined;
  if (unit) return <span className='tabular-nums' title={isTimeUnit(unit) ? `${numberWords(v)} ${unit}` : undefined} data-unit={unit}>{numberWords(v, unit)}</span>;
  // mold_v0-309: a date by the page's one rule, on one line (never the stored "2026-11-12").
  if (f.type === 'date' && !f.encrypted) return <DateText v={v} />;
  const t = shownText(f, v, recordKey);
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
  const rail = useRail();
  // mold_v0-348: inside a list's record panel a row opens in that panel (a plain click; a new tab still opens its page).
  const openRelated = useOpenRelated();
  // Hidden from this role (it may not read that area), or nothing for it in the page's answer: no card at all.
  if (!target || data?.hidden || (page.data && !data)) return null;
  // mold_v0-256: each column its field and its own heading, when it has one.
  const cols = relatedColumns(target, s.related!).map((c) => ({ ...target.fields.find((f) => f.name === c.field)!, label: c.label ?? target.fields.find((f) => f.name === c.field)?.label ?? c.field })).filter((f) => !!f.name);
  const href = (k: string) => `/${base}/records/${target.name}/${encodeURIComponent(k)}`;
  const rows = data && !data.hidden ? data.records : [];
  const more = !!(data && !data.hidden && data.more);
  const all = data && !data.hidden && data.match !== null ? showAllHref(base, target.name, data.via, data.match ?? record.key) : null;
  const opener = (r: { key: string; title: string | null }) => (e: MouseEvent) => {
    if (!openRelated || !target || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openRelated({ area: target.name, key: r.key, title: r.title || r.key });
  };
  const hostOf = (r: (typeof rows)[number]): ActionHost => ({ area: target.name, areaLabel: target.label, base, record: { key: r.key, title: r.title, data: r.data, updated_at: r.updated_at },
    copy: (t, done) => void copyWithToast(t, done), changed, deleted: changed });
  // mold_v0-331: display rows: one link row (what is there, in words, and View → the list narrowed to this record).
  if (s.display === 'rows') {
    const words = page.error && !data ? 'Could not load' : !data ? 'Loading…' : relatedRowWords(rows.length, more, target.label);
    // mold_v0-348: the records themselves under the count (each opening as a related row does), View all only when there
    // are more than it lists.
    const row = <LinkRow id={id} title={s.title} detail={words} action={more ? 'View all' : 'View'} href={rows.length && !more ? null : all} data-section-kind='related' data-related-count={data ? String(rows.length) : undefined} />;
    const list = rows.length > 0 && (
      <ul className='mb-1.5 flex flex-col gap-1 pl-0.5 text-sm' data-related-rows=''>
        {rows.map((r) => (
          <li key={r.key} className='flex min-w-0 items-baseline gap-2' data-related-row={r.key}>
            <Link href={href(r.key)} onClick={opener(r)} className='truncate underline-offset-4 hover:underline' title={r.title && r.title !== r.key ? r.key : undefined}>{r.title || r.key}</Link>
            {cols[0] && r.data[cols[0].name] != null && r.data[cols[0].name] !== '' && (
              <span className='text-muted-foreground min-w-0 truncate text-[13px]'><RelatedCell target={target} f={cols[0]} v={r.data[cols[0].name]} recordKey={r.key} titles={r.ref_titles?.[cols[0].name]} base={base} /></span>
            )}
          </li>
        ))}
      </ul>
    );
    return rail ? <>{row}{list}</> : <div className='bg-card w-full rounded-xl border px-4 py-1.5' data-related-card=''>{row}{list}</div>;
  }
  const TH = rail ? TH_RAIL : TH_CARD, TD = rail ? TD_RAIL : TD_CARD;
  return (
    <ListCard id={id} kind='related' title={s.title}
      link={all && more ? (rail ? <TextLink label='Show all →' href={all} data-show-all='' />
        : <Button variant='outline' size='sm' nativeButton={false} render={<Link href={all} />} data-show-all=''>Show all<Icons.arrowRight aria-hidden data-icon='inline-end' /></Button>) : undefined}>
      {page.error && !data ? <div className='px-6 py-4'><ErrorState error={page.error} /></div>
        : !data ? <ListLoading />
        : !rows.length ? <ListEmpty text={s.empty ?? `No ${target.label.toLowerCase()} point to this record yet.`} />
        : (<>
          <div className='relative hidden overflow-x-auto md:block'>
            <table className='w-full caption-bottom text-sm' data-related-table=''>
              <thead className='[&_tr]:border-b'>
                <tr><th scope='col' className={TH}>{singularLabel(target.label)}</th>{cols.map((f) => <th key={f.name} scope='col' className={cn(TH, f.type === 'number' && 'text-right')}>{f.label}</th>)}<th scope='col' className={cn(TH, 'w-10')}><span className='sr-only'>Actions</span></th></tr>
              </thead>
              <tbody className='[&_tr:last-child]:border-0'>
                {rows.map((r) => (
                  <tr key={r.key} className='hover:bg-muted/40 border-b transition-colors' data-related-row={r.key}>
                    <td className={cn(TD, 'min-w-40')}>
                      {/* mold_v0-309: the title alone (its key on hover), never the key printed under it. */}
                      <Link href={href(r.key)} onClick={opener(r)} className='font-medium underline-offset-4 hover:underline' title={r.title && r.title !== r.key ? r.key : undefined}>{r.title || r.key}</Link>
                    </td>
                    {cols.map((f) => <td key={f.name} className={cn(TD, f.type === 'number' && 'text-right')}><RelatedCell target={target} f={f} v={r.data[f.name]} recordKey={r.key} titles={r.ref_titles?.[f.name]} base={base} /></td>)}
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
                  <Link href={href(r.key)} onClick={opener(r)} className='font-medium underline-offset-4 hover:underline'>{r.title || r.key}</Link>
                  <dl className='grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs'>
                    {cols.map((f) => (
                      <div key={f.name} className='flex min-w-0 flex-col gap-0.5'>
                        <dt className='text-muted-foreground'>{f.label}</dt>
                        <dd className='min-w-0 text-sm break-words'><RelatedCell target={target} f={f} v={r.data[f.name]} recordKey={r.key} titles={r.ref_titles?.[f.name]} base={base} /></dd>
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
  const rail = useRail();
  const runs = data?.runs ?? [];
  // mold_v0-310 (`wrote`): the runs and agent sessions that made or changed it.
  const wrote = data?.wrote ?? [];
  // mold_v0-261 (flag agent_harness): the workspace agent sessions started from this record (its start_agent actions).
  const sessions = data?.sessions?.rows ?? [];
  if (page.data && !data) return null;
  const tab = runs.length ? packTabs.find((x) => x.pack === runs[0]!.pack && x.kind === 'runs') : null;
  const status = (r: (typeof runs)[number]) => (
    <span title={r.status === 'failed' && r.error ? r.error : undefined}><ToneBadge color={RUN_STATUS_COLOR[r.status] ?? 'neutral'}>{statusLabel(r.status)}</ToneBadge></span>
  );
  const kind = (r: (typeof runs)[number]) => { const h = runHref(r.pack, r.id); const label = runKindLabel(r.pack, r.kind);
    return h ? <Link href={h} className='font-medium underline-offset-4 hover:underline' data-run-link={r.id}>{label}</Link> : <span className='font-medium'>{label}</span>; };
  const started = (r: (typeof runs)[number]) => (r.started_at ?? r.created_at ? <DateText v={r.started_at ?? r.created_at} /> : <span className='text-muted-foreground'>—</span>);
  const took = (r: (typeof runs)[number]) => duration(runSeconds(r)) || '—';
  const TH = rail ? TH_RAIL : TH_CARD, TD = rail ? TD_RAIL : TD_CARD;
  return (
    <ListCard id={id} kind='runs' title={s.title}
      link={tab && data && data.total > runs.length ? (rail ? <TextLink label='All runs →' href={tab.url} data-all-runs='' />
        : <Button variant='outline' size='sm' nativeButton={false} render={<Link href={tab.url} />} data-all-runs=''>All runs<Icons.arrowRight aria-hidden data-icon='inline-end' /></Button>) : undefined}>
      {page.error && !data ? <div className='px-6 py-4'><ErrorState error={page.error} /></div>
        : !data ? <ListLoading />
        : !runs.length && !sessions.length && !wrote.length ? <ListEmpty text={s.empty ?? 'Nothing has run on this record yet.'} />
        : (<>
          {runs.length > 0 && <>
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
          </>}
          {sessions.length > 0 && <RecordSessions rows={sessions} total={data?.sessions?.total ?? sessions.length} />}
          {wrote.length > 0 && <RecordWriterList rows={wrote} top={runs.length > 0 || sessions.length > 0} />}
        </>)}
    </ListCard>
  );
}

/**
 * mold_v0-340: whether a list of sessions or runs draws as compact stacked rows: inside a record panel beside its list
 * (narrow whatever the screen), not when the panel is expanded to the list's full width with room.
 */
const useCompactRows = () => { const inPanel = useInRecordPanel(), full = useRecordPanelFull(); return inPanel && !full; };
/**
 * mold_v0-340: one compact row, as the other rail lists draw it: the title on one full-width line (cut with an ellipsis,
 * the whole on hover), the state and spend on the second, who and when muted on the third.
 */
export function CompactRunRow({ id, title, href, state, spend, meta, kind }: { id: string; title: ReactNode; href: string; state: ReactNode; spend: ReactNode; meta: ReactNode; kind: 'session' | 'run' }) {
  const whole = typeof title === 'string' ? title : undefined;
  return (
    <li className='flex min-w-0 flex-col gap-1 px-4 py-2.5' data-compact-row={kind} {...(kind === 'session' ? { 'data-record-session': id } : { 'data-record-run': id })}>
      <Link href={href} title={whole} className='block min-w-0 truncate font-medium underline-offset-4 hover:underline' data-compact-title=''>{title}</Link>
      <span className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs'>{state}<span className='tabular-nums'>{spend}</span></span>
      <span className='text-muted-foreground min-w-0 truncate text-xs'>{meta}</span>
    </li>
  );
}

/** mold_v0-340: a record's agent sessions (its own and its related records'), newest activity first, each opening on the agent's page. */
function SessionsSection({ s, id, page, data }: { s: DetailSection; id: string; page: PageLoad; data: SessionsData | undefined }) {
  if (data?.hidden || (page.data && !data)) return null;
  const rows = data && !data.hidden ? data.rows : [];
  return (
    <ListCard id={id} kind='sessions' title={s.title}>
      {page.error && !data ? <div className='px-6 py-4'><ErrorState error={page.error} /></div>
        : !data ? <ListLoading />
        : !rows.length ? <ListEmpty text={s.empty ?? 'No agent session has worked on this yet.'} />
        : <RecordSessions rows={rows} total={data && !data.hidden ? data.total : rows.length} bare />}
    </ListCard>
  );
}

const asStatus = (v: string): RunStatus => ((RUN_STATUSES as readonly string[]).includes(v) ? (v as RunStatus) : 'running');
/** mold_v0-340: the runs among a record's sessions (Active runs' rows), active and finished, each opening its own page. */
function AgentRunsSection({ s, id, page, data }: { s: DetailSection; id: string; page: PageLoad; data: AgentRunsData | undefined }) {
  const compact = useCompactRows();
  if (data?.hidden || (page.data && !data)) return null;
  const rows = data && !data.hidden ? data.rows : [];
  const total = data && !data.hidden ? data.total : 0;
  return (
    <ListCard id={id} kind='agent_runs' title={s.title}>
      {page.error && !data ? <div className='px-6 py-4'><ErrorState error={page.error} /></div>
        : !data ? <ListLoading />
        : !rows.length ? <ListEmpty text={s.empty ?? 'No run has worked on this yet.'} />
        : (<>
          {total > rows.length && <p className='text-muted-foreground px-6 pt-3 pb-1 text-xs font-medium'>The newest {rows.length} of {total}</p>}
          <ul className='divide-y' data-record-runs=''>
            {rows.map((r) => compact ? (
              <CompactRunRow key={r.id} id={r.id} kind='run' href={`/app/agent/runs/${encodeURIComponent(r.id)}`} title={r.ref ? `${r.ref} · ${r.title}` : r.title}
                state={<><RunStatusBadge status={asStatus(r.status)} needs={r.needs as RunNeeds | null} />{r.outcome && <OutcomeBadge outcome={r.outcome as RunOutcomeBadge} />}</>}
                spend={<>{formatValue(r.spent_usd, 'usd')} <span className='text-muted-foreground'>of {formatValue(r.budget_usd, 'usd')}</span></>}
                meta={<>{r.finished ? <>Finished <DateText v={r.settled_at ?? r.last_activity_at} /></> : <>{r.open - r.waiting} of {r.children} at work · <DateText v={r.last_activity_at} /></>}{r.status === 'failed' && r.why ? <> · {r.why}</> : null}</>} />
            ) : (
              <li key={r.id} className='flex flex-col gap-1 px-6 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4' data-record-run={r.id}>
                <span className='flex min-w-0 flex-col gap-0.5'>
                  <Link href={`/app/agent/runs/${encodeURIComponent(r.id)}`} className='font-medium break-words underline-offset-4 hover:underline'>
                    {r.ref && <><span className='text-muted-foreground font-mono text-xs whitespace-nowrap'>{r.ref}</span><span className='text-muted-foreground' aria-hidden> · </span></>}{r.title}
                  </Link>
                  <span className='text-muted-foreground text-xs'>
                    {r.finished ? <>Finished <DateText v={r.settled_at ?? r.last_activity_at} /></> : <>{r.open - r.waiting} of {r.children} at work · <DateText v={r.last_activity_at} /></>}
                    {r.status === 'failed' && r.why ? <> · {r.why}</> : null}
                  </span>
                </span>
                <span className='flex shrink-0 flex-wrap items-center gap-2 text-xs'>
                  <RunStatusBadge status={asStatus(r.status)} needs={r.needs as RunNeeds | null} />
                  {r.outcome && <OutcomeBadge outcome={r.outcome as RunOutcomeBadge} />}
                  <span className='tabular-nums'>{formatValue(r.spent_usd, 'usd')} <span className='text-muted-foreground'>of {formatValue(r.budget_usd, 'usd')}</span></span>
                </span>
              </li>
            ))}
          </ul>
        </>)}
    </ListCard>
  );
}

/** mold_v0-340: a charts section: the pack's charts, their numbers counted over this record's records (one request). */
function ChartsSection({ s, id, area, record, pageKey }: { s: DetailSection; id: string; area: RecordAreaSpec; record: RecordRow; pageKey: string }) {
  const charts = (s.charts?.charts ?? []).map((n) => packCharts.find((c) => c.pack === area.pack && c.name === n)).filter((c): c is PackChartSpec => !!c);
  const url = `/api/records/_page/${encodeURIComponent(area.name)}/${encodeURIComponent(record.key)}/metrics?section=${pageKey}`;
  const { data, error } = useOrgLoad(async () => {
    const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as { metrics?: MetricResult[]; error?: string };
    if (!res.ok) throw httpError(res.status, body);
    return new Map((body.metrics ?? []).map((m) => [m.name, m]));
  }, [url]);
  const results = data ?? new Map<string, MetricResult>();
  // A chart whose every metric this person may not read is left out (as on an overview); none left, no section.
  const shown = charts.filter((c) => !c.metrics.every((n) => { const r = results.get(n); return !!r && 'error' in r && r.status === 403; }));
  if (data && !shown.length) return null;
  return (
    <ListCard id={id} kind='charts' title={s.title}>
      {error ? <div className='px-6 py-4'><ErrorState error={error} /></div>
        : <div className='grid lg:grid-cols-2 [&>*]:border-0 [&>*]:border-b lg:[&>*:nth-child(odd)]:border-r' data-record-charts=''>
          {shown.map((c) => <ChartCell key={`${c.pack}/${c.name}`} chart={c} results={results} />)}
        </div>}
    </ListCard>
  );
}

/** The runs and agent sessions that made or changed a record (mold_v0-310, a runs section's `wrote`): each opens its page. */
function RecordWriterList({ rows, top }: { rows: NonNullable<RunsData['wrote']>; top: boolean }) {
  return (
    <div className={cn(top && 'border-t')} data-record-writers=''>
      <p className='text-muted-foreground px-6 pt-3 pb-1 text-xs font-medium'>Made and changed by</p>
      <ul className='divide-y'>
        {rows.map((x) => (
          <li key={`${x.kind}:${x.id}`} className='flex flex-col gap-1 px-6 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4' data-record-writer={x.id}>
            <span className='flex min-w-0 flex-col gap-0.5'>
              <Link href={x.href} className='font-medium break-words underline-offset-4 hover:underline'>{x.title}</Link>
              <span className='text-muted-foreground text-xs'>{x.kind === 'run' ? 'Run' : x.program ? `Program ${x.program}, agent session` : 'Agent session'} · <DateText v={x.at} /></span>
            </span>
            <ToneBadge color={x.how === 'Made' ? 'success' : 'info'}>{x.how}</ToneBadge>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The workspace agent sessions started from a record (mold_v0-261): each opens on the agent's page. */
const sessionTone = (phase: string): BadgeColor => (phase === 'failed' ? 'danger' : phase === 'awaiting_approval' || phase === 'waiting' ? 'warning' : ['working', 'waking'].includes(phase) ? 'info' : 'neutral');
function RecordSessions({ rows, total, bare = false }: { rows: NonNullable<RunsData['sessions']>['rows']; total: number; /** mold_v0-340: a sessions section's own list (no rule above, no heading but the count). */ bare?: boolean }) {
  const compact = useCompactRows();
  return (
    <div className={cn(!bare && 'border-t')} data-record-sessions=''>
      {(!bare || total > rows.length) && <p className='text-muted-foreground px-6 pt-3 pb-1 text-xs font-medium'>{bare ? `The newest ${rows.length} of ${total}` : `Agent sessions${total > rows.length ? ` (the newest ${rows.length} of ${total})` : ''}`}</p>}
      <ul className='divide-y'>
        {rows.map((x) => compact ? (
          <CompactRunRow key={x.id} id={x.id} kind='session' href={`/app/agent?session=${encodeURIComponent(x.id)}`} title={x.title}
            state={<ToneBadge color={sessionTone(x.phase)}>{SESSION_PHASE[x.phase] ?? x.phase}</ToneBadge>}
            spend={<>{formatValue(x.spent_usd, 'usd')} <span className='text-muted-foreground'>of {formatValue(x.budget_usd, 'usd')}</span></>}
            meta={<>{x.profile ? `${x.profile.name}, version ${x.profile.version}` : 'Workspace agent'} · {x.started_by ?? 'Someone'} · <DateText v={x.created_at} /></>} />
        ) : (
          <li key={x.id} className='flex flex-col gap-1 px-6 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4' data-record-session={x.id}>
            <span className='flex min-w-0 flex-col gap-0.5'>
              <Link href={`/app/agent?session=${encodeURIComponent(x.id)}`} className='font-medium break-words underline-offset-4 hover:underline'>{x.title}</Link>
              <span className='text-muted-foreground text-xs'>{x.profile ? `${x.profile.name}, version ${x.profile.version}` : 'Workspace agent'} · {x.started_by ?? 'Someone'} · <DateText v={x.created_at} /></span>
            </span>
            <span className='flex shrink-0 items-center gap-3 text-xs'>
              <ToneBadge color={sessionTone(x.phase)}>{SESSION_PHASE[x.phase] ?? x.phase}</ToneBadge>
              <span className='tabular-nums'>{formatValue(x.spent_usd, 'usd')} <span className='text-muted-foreground'>of {formatValue(x.budget_usd, 'usd')}</span></span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
// mold_v0-334: a session's phase in the one run vocabulary (web/src/lib/run-status.ts).
const SESSION_PHASE: Record<string, string> = Object.fromEntries(['starting', 'working', 'waiting', 'parked', 'waking', 'paused', 'awaiting_approval', 'stopped', 'failed', 'archived'].map((p) => [p, RUN_STATUS_WORDS[runStatusOf(p)]]));

/**
 * mold_v0-331: a lifecycle's progress: its states in order (the declared ones, else the field's options), done up to the
 * record's state, which is marked; a state off that path (a failure) is said on a line of its own under them.
 */
function StepsSection({ s, id, area, layout, record, stateAt }: { s: DetailSection; id: string; area: RecordAreaSpec; layout: DetailLayout; record: RecordRow; stateAt: Record<string, string> | null }) {
  const rail = useRail();
  const repeatsTab = useRepeatsTab(s.title);
  const f = area.fields.find((x) => x.name === s.steps!.field);
  if (!f) return null;
  const states = s.steps!.states ?? (f.options ?? []).map((o) => (typeof o === 'string' ? o : o.value));
  // mold_v0-333: a record that left the path (failed, cancelled) shows the step it stopped at.
  const { steps, off } = stepRows(states, record.data[f.name], { stage: s.steps!.failed_stage ? record.data[s.steps!.failed_stage] : null, stateAt });
  const body = (
    <div className='grid gap-2'>
      <RailSteps label={s.title} steps={steps.map((x) => ({ key: x.value, label: optionWords(f, x.value), state: x.state, ...(x.state === 'failed' && off ? { word: `${optionWords(f, off)} here` } : {}) }))} />
      {off && <p className='text-muted-foreground m-0 text-[13px]' data-steps-off={off}>Now: <ToneBadge color={badgeColor(layout, f.name, off)}>{optionWords(f, off)}</ToneBadge></p>}
    </div>
  );
  if (rail) return <RailSection id={id} title={s.title} titleHidden={repeatsTab} data-section-kind='steps'>{body}</RailSection>;
  return (
    <Card className='w-full gap-0 py-0' data-detail-section={id} data-section-kind='steps' aria-labelledby={`${id}-title`} role='region'>
      <CardHeader className={repeatsTab ? 'sr-only' : 'border-b py-3.5 [.border-b]:pb-3.5'}><CardTitle id={`${id}-title`} className='text-sm font-semibold'>{s.title}</CardTitle></CardHeader>
      <CardContent className='py-4'>{body}</CardContent>
    </Card>
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
  // mold_v0-333: a pointer (no field): the newest related record itself, its title linked ("Serving: Web · Production").
  if (answer.field === null) {
    if (!answer.record) return <span className='text-muted-foreground'>—</span>;
    return <Link href={`/${base}/records/${answer.area}/${encodeURIComponent(answer.record.key)}`} className='break-words underline-offset-4 hover:underline' data-computed-pointer={answer.record.key}>{answer.record.title || answer.record.key}</Link>;
  }
  const target = recordAreas.find((a) => a.name === answer.area);
  const f = target?.fields.find((x) => x.name === answer.field);
  if (isEmptyValue(answer.value) || !target || !f) return <span className='text-muted-foreground'>—</span>;
  const tl = (target as RecordAreaSpec & { detail?: DetailLayout }).detail ?? null;
  const v = answer.value;
  const shown = f.type === 'enum' ? <ToneBadge color={badgeColor(tl, f.name, v)}>{optionWords(f, v)}</ToneBadge>
    : f.type === 'number' ? <span className='tabular-nums'>{numberWords(v, fact.unit ?? columnUnit(target, f.name))}</span>
    : f.type === 'date' ? <DateText v={v} />
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

/** Whether a layout reads anything from the page's own route (mold_v0-254): actions, a related list, the record's runs. */
const readsPage = (layout: DetailLayout) => declaresActions(layout) || readsHistory(layout) || readsComputed(layout) || layout.tabs.some((t) => t.sections.some((s) => s.related || s.runs || s.sessions || s.agent_runs));

async function getPage(url: string): Promise<PageData> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as PageData & { error?: string };
  if (!res.ok) throw httpError(res.status, body);
  return body;
}

export function LaidOutRecord({ area, base, layout, record, links, clockEvents, provenance, where, credentials, onChanged, canShare = false, tabParam = 'tab', headerActions, onDeleted }: {
  area: RecordAreaSpec; base: 'app' | 'admin'; layout: DetailLayout; record: RecordRow; links: Links; clockEvents?: ClockEvent[];
  provenance?: { by: string | null } | null; where: string; credentials: ReactNode;
  /** Read the record again (mold_v0-254: after an action changed it). */
  onChanged?: () => void;
  /** mold_v0-259 (flag teams): this person may change who sees it (the header's Share). */
  canShare?: boolean;
  /** The address parameter of its tab (mold_v0-278: `panelTab` in a list's record panel, so the list's own `tab` stays). */
  tabParam?: string;
  /** mold_v0-271: a staff page's own Edit and Remove, in the header beside Copy ID and Copy link. */
  headerActions?: ReactNode;
  /** mold_v0-348: after its Delete, instead of the area's own list (a list's panel closes and reads its list again). */
  onDeleted?: () => void;
}) {
  const [asked, setAsked] = useQueryState(tabParam);
  // mold_v0-298: the tabs whose condition holds on this record; ti stays the declared index (sectionKey matches the server's).
  const tabs = shownTabs(layout, record.data, record.clocks);
  const tab = openTab(layout, asked, tabs);
  const first = tab === layout.tabs[0];
  const ti = layout.tabs.indexOf(tab);
  // mold_v0-254: the page's actions and the open tab's related lists and runs, a workspace's; mold_v0-271: a staff page's
  // computed facts and related lists of shared areas, from the staff records route.
  const reads = base === 'app' ? readsPage(layout) : readsComputed(layout) || layout.tabs.some((t) => t.sections.some((s) => s.related));
  const pageUrl = reads ? `${base === 'app' ? '/api/records' : '/api/admin/records'}/_page/${encodeURIComponent(area.name)}/${encodeURIComponent(record.key)}?tab=${tabId(tab.label)}` : null;
  const page = useOrgLoad(() => (pageUrl ? getPage(pageUrl) : Promise.resolve(null)), [pageUrl]);
  // The header's actions stay as they were while another tab's sections load (they do not depend on the tab).
  const [actions, setActions] = useState<PageData['actions'] | null>(null);
  useEffect(() => { if (page.data) setActions(page.data.actions); }, [page.data]);
  const changed = () => { void page.reload(); onChanged?.(); };
  const host: ActionHost = { area: area.name, areaLabel: area.label, base, record, copy: (t, done) => void copyWithToast(t, done), changed, canShare, ...(onDeleted ? { deleted: onDeleted } : {}) };
  const withActions = base === 'app' && declaresActions(layout);
  const { bar, card, panel, rail } = usePageActionsBar(host, withActions ? actions ?? page.data?.actions ?? [] : [], !actions && !page.data && !page.error, declaresCopyLink(layout));
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
        credentials={credentials} tabs={tabs} tab={tab} ti={ti} first={first} page={page} changed={changed} withActions={withActions} bar={bar} rail={rail} setAsked={setAsked} canShare={canShare} headerActions={headerActions} />
    </FormHost>
  );
}

/** The laid-out page itself: the header, the notices, the tabs and their sections. */
function LaidOutBody({ area, base, layout, record, links, clockEvents, provenance, where, credentials, tabs, tab, ti, first, page, changed, withActions, bar: actionsBar, rail, setAsked, canShare, headerActions }: {
  area: RecordAreaSpec; base: 'app' | 'admin'; layout: DetailLayout; record: RecordRow; links: Links; clockEvents?: ClockEvent[];
  provenance?: { by: string | null } | null; where: string; credentials: ReactNode; /** mold_v0-298: the tabs shown for this record */ tabs: DetailLayout['tabs']; tab: DetailLayout['tabs'][number]; ti: number; first: boolean;
  page: PageLoad & { data: PageData | null }; changed: () => void; withActions: boolean; bar: ReactNode; setAsked: (v: string | null) => unknown; canShare: boolean;
  headerActions?: ReactNode;
  /** mold_v0-331: the rail style's header actions (the main one as a text link, one ⋯). */
  rail: RailActions;
}) {
  // mold_v0-259 (flag teams): who sees it, in the header, with Share for the people who may change it.
  const visibility = base === 'app' && (visibilityOf(area) || inheritedVisibility(area)) ? record.visibility ?? null : null;
  const share = visibility ? <ShareButton area={area} recordKey={record.key} visibility={visibility} canShare={canShare} onShared={changed} /> : null;
  // Share sits beside the declared actions, ahead of them.
  const bar = share && canShare ? <div className='flex max-w-full min-w-0 flex-wrap items-start gap-2 sm:justify-end'>{share}{actionsBar}</div> : actionsBar;
  const h = layout.header ?? {};
  const field = (n?: string) => (n ? area.fields.find((f) => f.name === n) : undefined);
  const titleField = field(h.title);
  // mold_v0-298: the title field in words (a reference's record title, an option's label), as the breadcrumb says it.
  const tv = titleField ? record.data[titleField.name] : undefined;
  const title = titleField && !isEmptyValue(tv)
    ? (refTarget(area, titleField) && record.ref_titles?.[titleField.name] ? refWords(tv, record.ref_titles[titleField.name]) : fieldText(titleField, tv, record.key)) || record.title || record.key
    : record.title || record.key;
  const subtitle = field(h.subtitle);
  // mold_v0-256: a computed fact is shown once the server answered it for this person (hidden from one who may not read its area).
  const facts = (h.facts ?? []).map((x, i) => ({ ...x, i, f: field(x.field) }))
    // mold_v0-309: a fact with hide_empty left out while it has no value, one with `when` while it does not hold.
    .filter((x) => (x.computed || !!x.f || (!!x.state_since && !!stateSince(area, x, record.data, page.data?.state_at))) && factShown(x, record.data, record.clocks, page.data?.facts?.[String(x.i)]));
  const notices = shownNotices(layout, record.data, record.clocks, page.data?.facts); // mold_v0-298: a notice may test a computed fact
  const added = h.creator !== false && provenance?.by ? addedByWords(provenance.by) : null;
  const made = h.creator !== false ? page.data?.writers?.made ?? null : null, lastRun = h.creator !== false ? page.data?.writers?.changed[0] ?? null : null;
  const rest = unplacedFields(area, layout).filter((f) => !isStoredFile(f, record.data[f.name]) && !isEmptyValue(record.data[f.name]));
  const updated = dateWords(record.updated_at);
  const sectionId = (i: number) => `detail-${tabId(tab.label)}-${i}`;
  // mold_v0-289: in a list's side panel the title is the panel's own (not repeated here) and the actions take their own row.
  const inRecordPanel = useInRecordPanel();

  if (isRail(layout)) return (
    <RailBody area={area} base={base} layout={layout} record={record} links={links} clockEvents={clockEvents} where={where} credentials={credentials}
      tabs={tabs} tab={tab} ti={ti} first={first} page={page} changed={changed} rail={rail} setAsked={setAsked} share={share} headerActions={headerActions}
      title={title} subtitle={subtitle} facts={facts} notices={notices} added={added} made={made} lastRun={lastRun} rest={rest} visibility={visibility} />
  );

  return (
    <div className='flex w-full flex-col gap-4 md:gap-6' data-record-layout=''>
      <Card className='w-full gap-0 py-0' data-record-header=''>
        <CardContent className='flex flex-col gap-5 py-5'>
          <div className={cn('flex flex-col gap-4', !inRecordPanel && 'sm:flex-row sm:items-start sm:justify-between')}>
            <div className='flex min-w-0 flex-1 flex-col gap-2'>
              <p className='text-muted-foreground text-xs'>{area.label}{where && <> · {where}</>}</p>
              {!inRecordPanel && <h1 className='text-xl leading-tight font-semibold tracking-tight break-words md:text-2xl'>{title}</h1>}
              {subtitle && !isEmptyValue(record.data[subtitle.name]) && (
                <p className='text-muted-foreground max-w-prose text-sm leading-relaxed break-words' data-record-subtitle=''>{String(record.data[subtitle.name])}</p>
              )}
              {/* mold_v0-300: no chip for the default (the whole workspace sees it): the line above already says it is the workspace's. */}
              {visibility && visibility.mode !== 'workspace' && <div className='flex flex-wrap items-center gap-2' data-record-visibility=''><VisibilityBadge v={visibility} /></div>}
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
                {share}
                {headerActions}
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
            <dl className={cn('grid grid-cols-2 gap-x-6 gap-y-5 border-t pt-5', !inRecordPanel && 'sm:grid-cols-3 lg:grid-cols-4')} data-record-facts=''>
              {facts.map((x) => x.state_since ? (
                <FieldCell key={`since-${x.i}`} label={stateSince(area, x, record.data, page.data?.state_at)!.label}>
                  <span className='font-medium' data-state-since=''><SinceText at={stateSince(area, x, record.data, page.data?.state_at)!.at} /></span>
                </FieldCell>
              ) : x.computed ? (
                <FieldCell key={`computed-${x.i}`} label={x.label ?? ''}>
                  <span className='font-medium' data-computed-fact={x.i}><ComputedValue fact={x} answer={page.data?.facts?.[String(x.i)]} loading={!page.data && !page.error} base={base} recordKey={record.key} /></span>
                </FieldCell>
              ) : (
                <FieldCell key={x.field} label={x.label ?? x.f!.label} copy={copyOf(x.f!, record.data[x.field!])}>
                  <span className='font-medium'><LaidOutValue area={area} base={base} layout={layout} f={x.f!} v={record.data[x.field!]} recordKey={record.key} fact unit={x.unit} titles={record.ref_titles?.[x.field!]} linkText={x.link_text} /></span>
                </FieldCell>
              ))}
            </dl>
          )}
          <p className='text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-4 text-xs' data-record-meta=''>
            {added && <span data-record-creator=''>Added by <span className='text-foreground'>{added}</span></span>}
            {added && <span aria-hidden>·</span>}
            {/* mold_v0-310: the run or agent session it came from, and the latest one that changed it since, linked. */}
            {made && <><span data-record-made-by=''>Made by <RunLinkText link={made} /></span><span aria-hidden>·</span></>}
            {lastRun && <><span data-record-changed-by=''>Changed by <RunLinkText link={lastRun} /></span><span aria-hidden>·</span></>}
            <span className='min-w-0 break-all'>ID <span className='text-foreground font-mono'>{record.key}</span></span>
            {record.version && <><span aria-hidden>·</span><span>Version <span className='text-foreground'>{record.version}</span></span></>}
            {updated && <><span aria-hidden>·</span><span>Updated <DateText v={record.updated_at} /></span></>}
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

      {tabs.length > 1 ? (
        <Tabs value={tabId(tab.label)} onValueChange={(v) => void setAsked(v === tabId(tabs[0]!.label) ? null : String(v))} className='w-full gap-4'>
          <RecordTabStrip tabs={tabs} open={tabId(tab.label)} />
          <TabsContent value={tabId(tab.label)} className='flex flex-col gap-4 md:gap-6'>
            <SoleSectionTab.Provider value={tab.sections.length === 1 && !first ? tab.label : null}>
              {tab.sections.map((s, i) => <AnySection key={i} s={s} id={sectionId(i)} pageKey={sectionKey(ti, i)} area={area} base={base} layout={layout} record={record} page={page} data={page.data?.sections[sectionKey(ti, i)]} changed={changed} />)}
            </SoleSectionTab.Provider>
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

type FactRow = NonNullable<DetailLayout['header']>['facts'] extends (infer F)[] | undefined ? F & { i: number; f: RecordFieldSpec | undefined } : never;

/**
 * mold_v0-331: the rail style. One header row (the status dot, the title, "status · context", the main action as a text
 * link, one ⋯), in a record panel the panel's own header row; then the notices as single lines and every fact as label
 * and value in a left column (290px) beside the tabs, stacked when the space is under 44rem (a panel beside its list, a
 * phone); the open tab's sections flat. A status appears once (in the header) and the ID once (as a field, with Copy).
 */
function RailBody({ area, base, layout, record, links, clockEvents, where, credentials, tabs, tab, ti, first, page, changed, rail, setAsked, share, headerActions,
  title, subtitle, facts, notices, added, made, lastRun, rest, visibility }: {
  area: RecordAreaSpec; base: 'app' | 'admin'; layout: DetailLayout; record: RecordRow; links: Links; clockEvents?: ClockEvent[]; where: string; credentials: ReactNode;
  tabs: DetailLayout['tabs']; tab: DetailLayout['tabs'][number]; ti: number; first: boolean; page: PageLoad & { data: PageData | null }; changed: () => void;
  rail: RailActions; setAsked: (v: string | null) => unknown; share: ReactNode; headerActions?: ReactNode;
  title: string; subtitle: RecordFieldSpec | undefined; facts: FactRow[]; notices: ReturnType<typeof shownNotices>; added: string | null;
  made: NonNullable<PageData['writers']>['made'] | null; lastRun: NonNullable<PageData['writers']>['changed'][number] | null; rest: RecordFieldSpec[];
  visibility: RecordRow['visibility'] | null;
}) {
  const h = layout.header ?? {};
  const field = (n?: string) => (n ? area.fields.find((f) => f.name === n) : undefined);
  const statusField = field(h.status);
  const sv = statusField ? record.data[statusField.name] : undefined;
  // mold_v0-332: a working test older than its pack's stale_after_days reads "Tested N days ago", neutral.
  const stale = statusField && record.health?.field === statusField.name ? staleWords(record.health) : null;
  const status = stale ?? (statusField && !isEmptyValue(sv) ? optionWords(statusField, sv) : null);
  const tone = stale ? 'neutral' : statusField && !isEmptyValue(sv) ? dotTone(badgeColor(layout, statusField.name, sv)) : null;
  const context = headerContext(status, (h.context ?? []).map((n) => { const f = field(n), v = f ? record.data[n] : undefined;
    return f && !isEmptyValue(v) ? (refTarget(area, f) && record.ref_titles?.[n] ? refWords(v, record.ref_titles[n]) : fieldText(f, v, record.key)) : null; }));
  const slots = usePanelHeaderSlots();
  const claim = slots?.claim;
  useLayoutEffect(() => claim?.(true), [claim]);
  const name = title || record.key;
  const trailing = <>{rail.main}{share}{headerActions}</>;
  const heading = <RailHeading title={title} tone={tone} status={status} context={context} trailing={slots ? trailing : null} level={slots ? 'h2' : 'h1'} />;
  const menu = rail.menu(slots?.items ?? [], name);
  const updated = dateWords(record.updated_at);
  const copyId = () => copyWithToast(record.key, 'Record ID copied');
  const said = railHeaderFields(layout);
  const rows: RailRow[] = [
    ...railBadges(layout).map((b): RailRow => { const f = field(b.field), v = record.data[b.field];
      return f && !isEmptyValue(v) ? { key: `badge-${b.field}`, label: f.label, value: <ToneBadge color={badgeColor(layout, b.field, v)}>{optionWords(f, v)}</ToneBadge>, attrs: { 'data-record-badge': b.field } } : null; }),
    ...facts.filter((x) => x.computed || !said.has(x.field!)).map((x): RailRow => x.state_since
      ? (() => { const w = stateSince(area, x, record.data, page.data?.state_at)!; return { key: `since-${x.i}`, label: w.label, value: <span data-state-since=''><SinceText at={w.at} /></span> }; })()
      : x.computed
      ? { key: `computed-${x.i}`, label: x.label ?? '', value: <span data-computed-fact={x.i}><ComputedValue fact={x} answer={page.data?.facts?.[String(x.i)]} loading={!page.data && !page.error} base={base} recordKey={record.key} /></span> }
      : { key: `fact-${x.field}`, label: x.label ?? x.f!.label, value: <LaidOutValue area={area} base={base} layout={layout} f={x.f!} v={record.data[x.field!]} recordKey={record.key} fact unit={x.unit} titles={record.ref_titles?.[x.field!]} linkText={x.link_text} />,
          copy: (() => { const c = copyOf(x.f!, record.data[x.field!]); return c ? <CopyLink what={c.what} onCopy={() => copyWithToast(c.text, `${c.what} copied`)} /> : undefined; })() }),
    visibility && visibility.mode !== 'workspace' && { key: 'visibility', label: 'Who sees it', value: <VisibilityBadge v={visibility} /> },
    { key: 'id', label: 'ID', value: <code className='font-mono text-xs break-all'>{record.key}</code>, copy: <CopyLink what='ID' onCopy={copyId} />, attrs: { 'data-record-id': '' } },
    !!record.version && { key: 'version', label: 'Version', value: record.version },
    !!updated && { key: 'updated', label: 'Updated', value: <DateText v={record.updated_at} /> },
    !!added && { key: 'added', label: 'Added by', value: added, attrs: { 'data-record-creator': '' } },
    !!made && { key: 'made', label: 'Made by', value: <RunLinkText link={made!} />, attrs: { 'data-record-made-by': '' } },
    !!lastRun && { key: 'changed', label: 'Changed by', value: <RunLinkText link={lastRun!} />, attrs: { 'data-record-changed-by': '' } },
  ];
  const sectionId = (i: number) => `detail-${tabId(tab.label)}-${i}`;
  const sections = (
    <div className='flex min-w-0 flex-col gap-6 [&>[data-link-row]+[data-link-row]]:-mt-6 [&>[data-link-row]+[data-link-row]]:border-t' data-rail-sections=''>
      <SoleSectionTab.Provider value={tab.sections.length === 1 && !first ? tab.label : null}>
        {tab.sections.map((s, i) => <AnySection key={i} s={s} id={sectionId(i)} pageKey={sectionKey(ti, i)} area={area} base={base} layout={layout} record={record} page={page} data={page.data?.sections[sectionKey(ti, i)]} changed={changed} />)}
      </SoleSectionTab.Provider>
      {first && <FirstTabRest area={area} base={base} layout={layout} record={record} rest={rest} links={links} clockEvents={clockEvents} credentials={credentials} />}
    </div>
  );
  return (
    <RailStyle.Provider value>
      {slots?.heading && createPortal(heading, slots.heading)}
      {slots?.menu && createPortal(menu, slots.menu)}
      <div className='@container w-full' data-record-layout='' data-style='rail'>
        {!slots && (
          <div className='mb-4 flex min-w-0 items-center gap-2 border-b pb-3' data-record-header=''>
            <div className='min-w-0 flex-1'>{heading}</div>
            <span className='flex shrink-0 items-center gap-2'>{trailing}</span>
            {menu}
          </div>
        )}
        {rail.dialog}
        <div className='flex flex-col @min-[44rem]:grid @min-[44rem]:grid-cols-[290px_minmax(0,1fr)]' data-rail-columns=''>
          <div className='grid min-w-0 content-start gap-3 border-b pb-4 @min-[44rem]:border-r @min-[44rem]:border-b-0 @min-[44rem]:pr-5 @min-[44rem]:pb-0' data-rail='' data-record-facts=''>
            {!slots && where && <p className='text-muted-foreground m-0 text-xs'>{area.label} · {where}</p>}
            {notices.map((n, i) => <NoticeLine key={i} tone={n.tone} title={n.title} text={n.text} />)}
            {subtitle && !isEmptyValue(record.data[subtitle.name]) && (
              <p className='m-0 text-sm leading-normal whitespace-pre-wrap [overflow-wrap:anywhere]' data-record-subtitle=''>{String(record.data[subtitle.name])}</p>
            )}
            <RailFields rows={rows} />
          </div>
          <div className='min-w-0 pt-3 @min-[44rem]:pt-0 @min-[44rem]:pl-5' data-rail-main=''>
            {tabs.length > 1 ? (
              <Tabs value={tabId(tab.label)} onValueChange={(v) => void setAsked(v === tabId(tabs[0]!.label) ? null : String(v))} className='w-full gap-4'>
                <RecordTabStrip tabs={tabs} open={tabId(tab.label)} />
                <TabsContent value={tabId(tab.label)}>{sections}</TabsContent>
              </Tabs>
            ) : sections}
          </div>
        </div>
      </div>
    </RailStyle.Provider>
  );
}

/**
 * The record page's tab strip (mold_v0-300; mold_v0-340: it wraps). Every tab is whole and in view: when the tabs are wider
 * than the page or the panel (a phone, a record panel beside its list, eight tabs) they go on to a second row, never
 * clipped and never in a sideways scroller. No tab's label breaks inside itself (each trigger keeps its width).
 */
export const RECORD_TAB_STRIP_CLASS = 'max-w-full flex-wrap justify-start gap-x-4 gap-y-1 p-0 group-data-horizontal/tabs:h-auto';
function RecordTabStrip({ tabs }: { tabs: DetailLayout['tabs']; open: string }) {
  return (
    <div className='max-w-full pb-1.5' data-tab-strip-room='' data-tab-strip-wraps=''>
      <TabsList variant='line' className={RECORD_TAB_STRIP_CLASS} data-record-tabs=''>
        {tabs.map((t) => <TabsTrigger key={t.label} value={tabId(t.label)} className='h-9 flex-none px-0 whitespace-nowrap'>{t.label}</TabsTrigger>)}
      </TabsList>
    </div>
  );
}

/** The first tab's end: the fields the layout leaves out, then what every record page has (documents, deadlines, links, credentials). */
function FirstTabRest({ area, base, layout, record, rest, links, clockEvents, credentials }: {
  area: RecordAreaSpec; base: 'app' | 'admin'; layout: DetailLayout; record: RecordRow; rest: RecordFieldSpec[]; links: Links; clockEvents?: ClockEvent[]; credentials: ReactNode;
}) {
  // mold_v0-262: none with linked: false; else only the links the page does not show already (as a fact or a section's field).
  const listed = new Set(linkedShown(layout, links.map((l) => l.field)));
  const linked = links.filter((l) => l.records.length && listed.has(l.field));
  // mold_v0-331: the rail style: Other details as label and value rows, the linked records as link rows.
  if (useRail()) return (
    <>
      {!!rest.length && (
        <SectionCard s={{ title: 'Other details', fields: rest.map((f) => f.name), columns: 2 }} id='detail-other' area={area} base={base} layout={layout} record={record} labels='always' />
      )}
      <div className='flex flex-col gap-6 [&:not(:has(section))]:hidden' data-record-extras=''>
        {!layout.tabs.some((t) => t.sections.some((x) => x.files)) && <RecordDocuments area={area} base={base} recordKey={record.key} count={false} />}
        <ClockSection record={record} events={clockEvents} />
      </div>
      {!!linked.length && (
        <RailSection id='detail-linked' title='Linked records' data-record-links=''>
          <div className='grid [&>*+*]:border-t'>
            {linked.flatMap((l) => {
              const target = findRecordArea(base, l.area);
              return l.records.map((r) => (
                <LinkRow key={`${l.field}-${r.key}`} id={`linked-${l.field}-${r.key}`} title={r.title || r.key} detail={`${areaFieldLabel(area, l.field)} · ${target?.label ?? l.area}`}
                  action='Open' href={`/${base}/records/${l.area}/${encodeURIComponent(r.key)}`} />
              ));
            })}
          </div>
        </RailSection>
      )}
      {credentials}
    </>
  );
  return (
    <>
      {!!rest.length && (
        <SectionCard s={{ title: 'Other details', fields: rest.map((f) => f.name), columns: 2 }} id='detail-other' area={area} base={base} layout={layout} record={record} labels='always' />
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

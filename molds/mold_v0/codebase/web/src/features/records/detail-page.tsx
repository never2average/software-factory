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
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { RecordAreaSpec, RecordFieldSpec } from '@/config/pack-nav.generated';
import { cn } from '@/lib/utils';
import { ClockSection, type ClockEvent } from './clocks';
import { RecordDocuments, isStoredFile } from './documents';
import {
  BADGE_CLASS, NOTICE_CLASS, badgeColor, columnsClass, copyText, dateWords, isEmptyValue, numberWords, openTab, optionWords,
  sectionEmpty, sectionGroups, shownNotices, tabId, unplacedFields,
  type BadgeColor, type DetailLayout, type DetailSection, type LaidOutField, type NoticeTone
} from './detail-layout';
import { areaFieldLabel, findRecordArea } from './registry';
import { FieldValue, type RecordRow } from './record-pages';

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
function DateText({ v, relative }: { v: unknown; relative: boolean }) {
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
  if (f.type === 'number') return <span className='tabular-nums'>{numberWords(v, unit)}</span>;
  return <span className='whitespace-pre-wrap'><FieldValue area={area} base={base} f={f} v={v} recordKey={recordKey} /></span>;
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

const NOTICE_ICON: Record<NoticeTone, keyof typeof Icons> = { info: 'info', warning: 'warning', danger: 'alertCircle' };
/** Where a workspace record came from, in words (mold_v0-236; the same words as the page without a layout). */
const ADDED_BY: Record<string, string> = { people: 'A person of this workspace', staff: 'Platform staff', intake: 'The email intake', run: "The app's own automation", repository: 'Its data source' };

export function LaidOutRecord({ area, base, layout, record, links, clockEvents, provenance, where, credentials }: {
  area: RecordAreaSpec; base: 'app' | 'admin'; layout: DetailLayout; record: RecordRow; links: Links; clockEvents?: ClockEvent[];
  provenance?: { by: string | null } | null; where: string; credentials: ReactNode;
}) {
  const [asked, setAsked] = useQueryState('tab');
  const tab = openTab(layout, asked);
  const first = tab === layout.tabs[0];
  const h = layout.header ?? {};
  const field = (n?: string) => (n ? area.fields.find((f) => f.name === n) : undefined);
  const titleField = field(h.title);
  const title = titleField && !isEmptyValue(record.data[titleField.name]) ? String(record.data[titleField.name]) : record.title || record.key;
  const subtitle = field(h.subtitle);
  const facts = (h.facts ?? []).map((x) => ({ ...x, f: field(x.field) })).filter((x): x is typeof x & { f: RecordFieldSpec } => !!x.f);
  const notices = shownNotices(layout, record.data);
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
            <div className='flex shrink-0 flex-wrap gap-2'>
              <Button type='button' variant='outline' size='sm' data-copy-id='' onClick={() => void copyWithToast(record.key, 'Record ID copied')}>
                <Icons.copy aria-hidden data-icon='inline-start' />Copy ID
              </Button>
              <Button type='button' variant='outline' size='sm' data-copy-link='' onClick={() => void copyWithToast(window.location.href, 'Link copied')}>
                <Icons.link aria-hidden data-icon='inline-start' />Copy link
              </Button>
            </div>
          </div>
          {!!facts.length && (
            <dl className='grid grid-cols-2 gap-x-6 gap-y-5 border-t pt-5 sm:grid-cols-3 lg:grid-cols-4' data-record-facts=''>
              {facts.map((x) => (
                <FieldCell key={x.field} label={x.label ?? x.f.label} copy={copyOf(x.f, record.data[x.field])}>
                  <span className='font-medium'><LaidOutValue area={area} base={base} layout={layout} f={x.f} v={record.data[x.field]} recordKey={record.key} relative unit={x.unit} /></span>
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
          <div key={i} role={n.tone === 'info' ? 'status' : 'alert'} data-record-notice={n.tone}
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
            {tab.sections.map((s, i) => <SectionCard key={i} s={s} id={sectionId(i)} area={area} base={base} layout={layout} record={record} />)}
            {first && <FirstTabRest area={area} base={base} layout={layout} record={record} rest={rest} links={links} clockEvents={clockEvents} credentials={credentials} />}
          </TabsContent>
        </Tabs>
      ) : (
        <div className='flex w-full flex-col gap-4 md:gap-6'>
          {tab.sections.map((s, i) => <SectionCard key={i} s={s} id={sectionId(i)} area={area} base={base} layout={layout} record={record} />)}
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
          <RecordDocuments area={area} base={base} recordKey={record.key} />
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

'use client';
// A run's own page (mold_v0-256, flag record_pages; /app/runs/<id>, GET /api/runs/<id>/page: src/run-page.ts), linked
// from every runs list (an open run's Open run) and from a record's runs. In the standard grid, full-width cards:
//   the header   its kind in the pack's words, its status as a badge (a pulse while it runs), the record it ran on, who
//                started it, when, how long (counting while it runs), its cost against its budget; Re-run (filled),
//                Stop while it runs (outlined, asked first) and Copy link (outlined); its error, when it failed
//   tabs         each shown only when it has something (?tab=): Timeline (its events in the event/log viewer, following
//                while it runs), Agent (harness, model, turns, tokens and cost by model), Tools (each call, its input
//                and output collapsed), Results (its required outputs, the checks' results), Files (what it wrote, as a
//                tree with each file's facts or preview), Related (the records it ran on, checked, created or changed)
// While the run is queued or running the page asks for new events every two seconds (GET /api/runs/<id>/events?after=)
// and stops once it ends (reading the whole page once more for its final results, files and spend).
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Icons } from '@/components/icons';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/features/admin/ui';
import { ErrorState, fail, LoadingCards, useOrgLoad } from '@/features/portal/shared';
import { findRecordArea } from '@/features/records/registry';
import { DateText, ToneBadge, copyWithToast } from '@/features/records/detail-page';
import { RUN_STATUS_COLOR, durationWords } from '@/features/records/detail-layout';
import { fileTree, folderPaths, sizeWords, tokensOf, treeRows, TOKEN_CLASS, type TreeNode } from '@/features/records/code-text';
import { LogViewer } from '@/features/records/log-viewer';
import { httpError } from '@/features/status/from-error';
import { formatValue } from '@/features/tabs/charts';
import { RESULT_LABELS, runStatusText } from '@/features/tabs/run-rows';
import { cn } from '@/lib/utils';

import { RUN_POLL_MS, costWords, eventLines, ranFor, runTabs, TAB_WORDS, LIVE, type EventLine, type ModelUsage, type Ref, type RunHead, type RunPageData, type RunTab, type Since, type ToolCall } from './run-view';
export type { RunPageData } from './run-view';

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json', ...(init?.method === 'POST' ? { 'x-pack-request': '1' } : {}) }, ...init });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, body);
  return body;
}
const recordHref = (r: Ref) => (findRecordArea('app', r.area) ? `/app/records/${r.area}/${encodeURIComponent(r.key)}` : null);
const areaLabel = (a: string) => findRecordArea('app', a)?.label ?? a;

/** The run's page: read once, then followed while it is live. */
export function RunPage({ id }: { id: string }) {
  const url = `/api/runs/${encodeURIComponent(id)}/page`;
  const { data, error, reload, setData } = useOrgLoad(() => getJson<RunPageData>(url), [url]);
  const live = !!data && LIVE.has(data.run.status);
  const last = useRef(0);
  useEffect(() => { if (data) last.current = Math.max(last.current, data.timeline.last); }, [data]);
  // While it runs: its new events every two seconds; once it ends, the whole page once more (its results, files, spend).
  useEffect(() => {
    if (!live) return;
    let stop = false;
    const t = setInterval(async () => {
      try {
        const s = await getJson<Since>(`/api/runs/${encodeURIComponent(id)}/events?after=${last.current}`);
        if (stop) return;
        last.current = Math.max(last.current, s.last);
        setData((d) => d && ({ ...d, run: { ...d.run, ...s.run }, timeline: { ...d.timeline, events: [...d.timeline.events, ...s.events.filter((e) => e.id > (d.timeline.events.at(-1)?.id ?? 0))], last: s.last },
          tools: [...d.tools, ...s.tools.filter((x) => !d.tools.some((y) => y.id === x.id))] }));
        if (!LIVE.has(s.run.status)) void reload();
      } catch { /* the next tick tries again */ }
    }, RUN_POLL_MS);
    return () => { stop = true; clearInterval(t); };
  }, [live, id, reload, setData]);
  return (
    <PageContainer>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={3} /> : <RunBody d={data} live={live} reload={() => void reload()} />}
    </PageContainer>
  );
}

function RunBody({ d, live, reload }: { d: RunPageData; live: boolean; reload: () => void }) {
  const r = d.run;
  const router = useRouter();
  const [asked, setAsked] = useQueryState('tab');
  const tabs = runTabs(d);
  const tab = (tabs as string[]).includes(asked ?? '') ? (asked as RunTab) : tabs[0];
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!live) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [live]);
  const took = ranFor(r, now);
  const lines = useMemo(() => eventLines(d.timeline.events), [d.timeline.events]);
  const rerun = async () => {
    setBusy('rerun');
    try {
      const got = await getJson<{ run: { id: string } }>(`/api/runs/${encodeURIComponent(r.id)}/rerun`, { method: 'POST' });
      toast.success(`${r.label} started again`);
      router.push(`/app/runs/${encodeURIComponent(got.run.id)}`);
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const stop = async () => {
    setBusy('stop');
    try { await getJson(`/api/runs/${encodeURIComponent(r.id)}/stop`, { method: 'POST' }); toast.success('Stop asked for: the run ends at its next check-in'); reload(); }
    catch (e) { fail(e); } finally { setBusy(null); }
  };
  const record = r.record ?? (r.target ? { ...r.target, title: null } : null);
  const recordLink = record ? recordHref(record) : null;
  const spent = r.budget_usd > 0 ? Math.min(1, r.cost_usd / r.budget_usd) : 0;
  return (
    <div className='flex w-full flex-col gap-4 md:gap-6' data-run-page={r.status}>
      <Card className='w-full gap-0 py-0' data-run-header=''>
        <CardContent className='flex flex-col gap-5 py-5'>
          <div className='flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between'>
            <div className='flex min-w-0 flex-col gap-2'>
              <p className='text-muted-foreground text-xs'>Run · {record ? areaLabel(record.area) : 'This workspace'}</p>
              <h1 className='text-xl leading-tight font-semibold tracking-tight break-words md:text-2xl'>{r.label}</h1>
              <div className='flex flex-wrap items-center gap-2 pt-1' data-run-status={r.status}>
                <ToneBadge color={RUN_STATUS_COLOR[r.status] ?? 'neutral'}>
                  {live && <span aria-hidden className='relative -ml-0.5 flex size-2'><span className='absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60 motion-reduce:hidden' /><span className='relative inline-flex size-2 rounded-full bg-current' /></span>}
                  {runStatusText(r)}{r.cancel_requested && live ? ' · stop asked for' : ''}
                </ToneBadge>
                {live && <span className='text-muted-foreground text-xs' data-run-live=''>Updating as it runs</span>}
              </div>
            </div>
            <div className='flex shrink-0 flex-wrap items-center gap-2' data-run-actions=''>
              {d.can.rerun && <Gate reason={d.can.rerun.disabled}>
                <Button type='button' size='sm' data-run-action='rerun' aria-disabled={!!d.can.rerun.disabled || busy === 'rerun' || undefined} aria-describedby={d.can.rerun.disabled ? 'why-rerun' : undefined}
                  className={cn(d.can.rerun.disabled && 'cursor-not-allowed opacity-50 hover:bg-primary')} onClick={() => { if (!d.can.rerun?.disabled && !busy) void rerun(); }}>
                  <Icons.refresh aria-hidden data-icon='inline-start' />{busy === 'rerun' ? 'Starting…' : 'Re-run'}
                </Button>
              </Gate>}
              {d.can.stop && live && <Gate reason={d.can.stop.disabled}>
                <Button type='button' variant='outline' size='sm' data-run-action='stop' aria-disabled={!!d.can.stop.disabled || busy === 'stop' || undefined}
                  className={cn(d.can.stop.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent')} onClick={() => { if (!d.can.stop?.disabled && !busy) setStopping(true); }}>
                  <Icons.stop aria-hidden data-icon='inline-start' />Stop
                </Button>
              </Gate>}
              <Button type='button' variant='outline' size='sm' data-run-action='copy-link' onClick={() => void copyWithToast(window.location.href.replace(/[?#].*$/, ''), 'Link copied')}>
                <Icons.link aria-hidden data-icon='inline-start' />Copy link
              </Button>
              <ConfirmDialog open={stopping} onOpenChange={setStopping} destructive title={`Stop ${r.label}?`} confirmLabel='Stop'
                description='It stops spending now and ends at its next check-in; what it has not written yet is not kept. This cannot be undone: run it again to start over.'
                onConfirm={() => void stop()} />
            </div>
          </div>
          <dl className='grid grid-cols-2 gap-x-6 gap-y-5 border-t pt-5 sm:grid-cols-3 lg:grid-cols-5' data-run-facts=''>
            <Fact label={r.record ? 'Ran on' : r.target ? 'Target' : 'Ran on'}>
              {record ? recordLink ? <Link href={recordLink} className='underline-offset-4 hover:underline' data-run-record={record.key}>{record.title || record.key}</Link> : <span>{record.title || record.key}</span>
                : <span className='text-muted-foreground'>No record</span>}
            </Fact>
            <Fact label='Started by'><span className='break-words'>{r.by}</span></Fact>
            <Fact label='Started'>{r.started_at ?? r.created_at ? <DateText v={r.started_at ?? r.created_at} relative /> : <span className='text-muted-foreground'>—</span>}</Fact>
            <Fact label='Duration'><span className='tabular-nums' data-run-duration=''>{took === null ? (r.status === 'queued' ? 'Waiting to start' : '—') : durationWords(took)}</span></Fact>
            <Fact label='Cost'>
              <span className='flex flex-col gap-1.5'>
                <span className='tabular-nums' data-run-cost=''>{costWords(r.cost_usd, r.budget_usd)}</span>
                <span className='bg-muted h-1.5 w-full max-w-36 overflow-hidden rounded-full' role='meter' aria-label='Budget used' aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(spent * 100)}>
                  <span className={cn('block h-full rounded-full', spent >= 0.9 ? 'bg-destructive' : spent >= 0.7 ? 'bg-amber-500' : 'bg-primary')} style={{ width: `${Math.max(spent * 100, r.cost_usd > 0 ? 3 : 0)}%` }} />
                </span>
              </span>
            </Fact>
          </dl>
          <p className='text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-4 text-xs' data-run-meta=''>
            <span className='min-w-0 break-all'>ID <span className='text-foreground font-mono'>{r.id}</span></span>
            {r.max_attempts > 1 && <><span aria-hidden>·</span><span>Attempt <span className='text-foreground'>{r.attempt} of {r.max_attempts}</span></span></>}
            <span aria-hidden>·</span><span>Queued <DateText v={r.created_at} relative /></span>
            {r.ended_at && <><span aria-hidden>·</span><span>Ended <DateText v={r.ended_at} relative /></span></>}
          </p>
        </CardContent>
      </Card>

      {r.status === 'failed' && r.error && (
        <div role='alert' data-run-error='' className='border-destructive/60 bg-destructive/5 grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-xl border px-4 py-3 text-sm *:[svg]:text-destructive'>
          <Icons.alertCircle aria-hidden className='row-span-2 mt-0.5 size-4' />
          <p className='font-medium'>This run failed</p>
          <p className='text-foreground/90 leading-relaxed break-words whitespace-pre-wrap'>{r.error}</p>
        </div>
      )}

      {!tabs.length ? (
        <Card className='w-full gap-0 py-0'><CardContent className='flex items-center gap-3 py-5'>
          <Icons.clock aria-hidden className='text-muted-foreground size-5 shrink-0' /><p className='text-muted-foreground text-sm'>Nothing has happened in this run yet.</p>
        </CardContent></Card>
      ) : (
        <Tabs value={tab} onValueChange={(v) => void setAsked(v === tabs[0] ? null : String(v))} className='w-full gap-4'>
          <div className='max-w-full overflow-x-auto'>
            <TabsList variant='line' className='flex-nowrap justify-start gap-x-6 p-0 group-data-horizontal/tabs:h-auto' data-run-tabs=''>
              {tabs.map((t) => <TabsTrigger key={t} value={t} className='h-9 flex-none px-0' data-run-tab={t}>{TAB_WORDS[t]}</TabsTrigger>)}
            </TabsList>
          </div>
          <TabsContent value={tab!} className='flex flex-col gap-4 md:gap-6'>
            {tab === 'timeline' && (
              <Section id='timeline' title='Timeline'>
                <LogViewer lines={lines} live={live} name={[r.id, 'timeline']} label={`${r.label}: timeline`} maxHeight={560}
                  copied={(ok) => (ok ? toast.success('Line copied') : toast.error('Could not copy: select the line and copy it yourself.'))} />
                {d.timeline.more && <p className='text-muted-foreground border-t px-6 py-2.5 text-xs'>The first {d.timeline.events.length.toLocaleString('en')} events are shown.</p>}
              </Section>
            )}
            {tab === 'agent' && d.agent && <AgentTab a={d.agent} />}
            {tab === 'tools' && <ToolsTab tools={d.tools} />}
            {tab === 'results' && d.results && <ResultsTab res={d.results} />}
            {tab === 'files' && d.files && <FilesTab files={d.files} />}
            {tab === 'related' && <RelatedTab related={d.related} />}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

/** A disabled action keeps its place and focus, its reason on hover and focus. */
function Gate({ reason, children }: { reason: string | null; children: React.ReactElement }) {
  if (!reason) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent className='max-w-72 text-pretty'>{reason}</TooltipContent>
    </Tooltip>
  );
}
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex min-w-0 flex-col gap-1.5' data-run-fact={label}>
      <dt className='text-muted-foreground text-xs font-medium'>{label}</dt>
      <dd className='min-w-0 text-sm font-medium'>{children}</dd>
    </div>
  );
}
function Section({ id, title, children, link }: { id: string; title: string; children: ReactNode; link?: ReactNode }) {
  return (
    <Card className='w-full gap-0 py-0' data-run-section={id} aria-labelledby={`run-${id}-title`} role='region'>
      <CardHeader className='flex flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b py-3 [.border-b]:pb-3'>
        <CardTitle id={`run-${id}-title`} className='text-sm font-semibold'>{title}</CardTitle>{link}
      </CardHeader>
      <CardContent className='px-0 py-0'>{children}</CardContent>
    </Card>
  );
}
const TH = 'text-muted-foreground h-9 px-3 text-left align-middle text-xs font-medium whitespace-nowrap first:pl-6 last:pr-6';
const TD = 'px-3 py-2.5 align-middle first:pl-6 last:pr-6';
const n = (x: number) => Math.round(x).toLocaleString('en');

function AgentTab({ a }: { a: NonNullable<RunPageData['agent']> }) {
  const total = a.usage.reduce((s, u) => ({ requests: s.requests + u.requests, input: s.input + u.input_tokens, output: s.output + u.output_tokens, cost: s.cost + u.cost_usd }), { requests: 0, input: 0, output: 0, cost: 0 });
  return (<>
    <Section id='agent' title='Agent'>
      <dl className='grid grid-cols-2 gap-x-6 gap-y-5 px-6 py-5 sm:grid-cols-4' data-run-agent=''>
        <Fact label='Harness'><span className='font-mono text-xs break-all'>{a.harness ?? '—'}</span></Fact>
        <Fact label={a.models.length > 1 ? 'Models' : 'Model'}><span className='break-words'>{a.models.length ? a.models.join(', ') : '—'}</span></Fact>
        <Fact label='Turns'><span className='tabular-nums'>{a.turns ?? '—'}</span></Fact>
        <Fact label='Providers'><span className='break-words'>{a.providers.length ? a.providers.join(', ') : '—'}</span></Fact>
      </dl>
    </Section>
    <Section id='usage' title='Tokens and cost by model'>
      {!a.usage.length ? <p className='text-muted-foreground px-6 py-5 text-sm'>No model was called in this run.</p> : (<>
        <div className='hidden overflow-x-auto md:block'>
          <table className='w-full text-sm' data-run-usage=''>
            <thead className='[&_tr]:border-b'><tr>{['Model', 'Provider', 'Requests', 'Input tokens', 'Output tokens', 'Cost'].map((h, i) => <th key={h} scope='col' className={cn(TH, i > 1 && 'text-right')}>{h}</th>)}</tr></thead>
            <tbody>
              {a.usage.map((u, i) => (
                <tr key={i} className='border-b' data-usage-model={u.model ?? u.provider ?? ''}>
                  <td className={cn(TD, 'font-medium')}>{u.model ?? <span className='text-muted-foreground'>Not reported</span>}</td><td className={TD}>{u.provider ?? '—'}</td>
                  <td className={cn(TD, 'text-right tabular-nums')}>{n(u.requests)}</td><td className={cn(TD, 'text-right tabular-nums')}>{n(u.input_tokens)}</td>
                  <td className={cn(TD, 'text-right tabular-nums')}>{n(u.output_tokens)}</td><td className={cn(TD, 'text-right tabular-nums')}>{formatValue(u.cost_usd, 'usd')}</td>
                </tr>
              ))}
            </tbody>
            {a.usage.length > 1 && <tfoot><tr className='font-medium'><td className={TD}>Total</td><td className={TD} /><td className={cn(TD, 'text-right tabular-nums')}>{n(total.requests)}</td>
              <td className={cn(TD, 'text-right tabular-nums')}>{n(total.input)}</td><td className={cn(TD, 'text-right tabular-nums')}>{n(total.output)}</td><td className={cn(TD, 'text-right tabular-nums')}>{formatValue(total.cost, 'usd')}</td></tr></tfoot>}
          </table>
        </div>
        <ul className='divide-y md:hidden'>
          {a.usage.map((u, i) => (
            <li key={i} className='flex flex-col gap-1 px-4 py-3'>
              <div className='flex items-baseline justify-between gap-3'><span className='font-medium break-words'>{u.model ?? u.provider ?? 'Not reported'}</span><span className='tabular-nums'>{formatValue(u.cost_usd, 'usd')}</span></div>
              <p className='text-muted-foreground text-xs tabular-nums'>{n(u.requests)} requests · {n(u.input_tokens)} in · {n(u.output_tokens)} out{u.provider && u.model ? ` · ${u.provider}` : ''}</p>
            </li>
          ))}
        </ul>
      </>)}
    </Section>
  </>);
}

/** A JSON value, highlighted and numbered, scrolling both ways. */
function JsonBlock({ v, label }: { v: unknown; label: string }) {
  const text = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  if (!text) return <p className='text-muted-foreground text-xs italic'>Nothing</p>;
  return (
    <pre className='bg-muted/30 dark:bg-muted/20 max-h-72 overflow-auto rounded-md border py-2 font-mono text-xs leading-5' aria-label={label} tabIndex={0}>
      {text.split('\n').map((l, i) => (
        <div key={i} className='flex'><span className='text-muted-foreground/70 w-9 shrink-0 pr-3 text-right select-none' aria-hidden>{i + 1}</span>
          <code className='pr-3 whitespace-pre'>{tokensOf(l, typeof v === 'string' ? 'text' : 'json').map((t, k) => <span key={k} className={TOKEN_CLASS[t.kind] || undefined}>{t.text}</span>)}</code></div>
      ))}
    </pre>
  );
}

function ToolsTab({ tools }: { tools: ToolCall[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (id: number) => setOpen((s) => { const x = new Set(s); if (x.has(id)) x.delete(id); else x.add(id); return x; });
  return (
    <Section id='tools' title='Tool calls' link={tools.length > 1 ? (
      <Button type='button' variant='outline' size='sm' onClick={() => setOpen(open.size === tools.length ? new Set() : new Set(tools.map((t) => t.id)))} data-tools-all=''>
        {open.size === tools.length ? 'Collapse all' : 'Expand all'}
      </Button>) : undefined}>
      <ol className='divide-y' data-run-tools=''>
        {tools.map((t, i) => {
          const isOpen = open.has(t.id);
          return (
            <li key={t.id} data-tool-call={t.name} data-open={isOpen ? 'true' : 'false'}>
              <div className='flex items-center gap-3 px-4 py-2.5 sm:px-6'>
                <Button type='button' variant='outline' size='icon-sm' aria-expanded={isOpen} aria-controls={`tool-${t.id}`} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${t.name}`} onClick={() => toggle(t.id)}>
                  {isOpen ? <Icons.chevronDown aria-hidden /> : <Icons.chevronRight aria-hidden />}
                </Button>
                <span className='text-muted-foreground w-6 shrink-0 text-right text-xs tabular-nums'>{i + 1}</span>
                <span className='min-w-0 flex-1 truncate font-mono text-sm font-medium' title={t.name}>{t.name}</span>
                {t.error ? <ToneBadge color='danger'>Failed</ToneBadge> : <ToneBadge color='success'>Done</ToneBadge>}
                <span className='text-muted-foreground hidden w-16 shrink-0 text-right text-xs tabular-nums sm:inline'>{t.ms !== null ? durationWords(t.ms / 1000) : ''}</span>
                <time dateTime={t.at} className='text-muted-foreground hidden shrink-0 text-xs tabular-nums sm:inline'>{t.at.slice(11, 19)}</time>
              </div>
              {isOpen && (
                <div id={`tool-${t.id}`} className='grid gap-3 px-4 pb-4 sm:px-6 lg:grid-cols-2'>
                  <div className='flex min-w-0 flex-col gap-1.5'><p className='text-muted-foreground text-xs font-medium'>Input</p><JsonBlock v={t.input} label={`${t.name}: input`} /></div>
                  <div className='flex min-w-0 flex-col gap-1.5'><p className='text-muted-foreground text-xs font-medium'>{t.error ? 'Error' : 'Output'}</p>
                    {t.error ? <p className='text-destructive text-sm break-words whitespace-pre-wrap'>{t.error}</p> : <JsonBlock v={t.output} label={`${t.name}: output`} />}</div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

const OUTPUT_WORDS = { written: 'Written', missing: 'Missing', pending: 'Not yet', unknown: 'Not known' } as const;
const RESULT_COLOR: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = { pass: 'success', fail: 'danger', error: 'danger', not_applicable: 'neutral', unknown: 'warning' };
function ResultsTab({ res }: { res: NonNullable<RunPageData['results']> }) {
  const link = (x: Ref | null) => { if (!x) return <span className='text-muted-foreground'>—</span>; const h = recordHref(x); return h ? <Link href={h} className='underline-offset-4 hover:underline'>{x.key}</Link> : <>{x.key}</>; };
  return (<>
    {!!res.outputs.length && (
      <Section id='outputs' title='Required outputs'>
        <ul className='divide-y' data-run-outputs=''>
          {res.outputs.map((o) => (
            <li key={o.pattern} className='flex items-center gap-3 px-4 py-2.5 sm:px-6' data-output={o.state}>
              {o.state === 'written' ? <Icons.circleCheck aria-hidden className='size-4 shrink-0 text-emerald-600 dark:text-emerald-400' />
                : o.state === 'missing' ? <Icons.circleX aria-hidden className='text-destructive size-4 shrink-0' /> : <Icons.clock aria-hidden className='text-muted-foreground size-4 shrink-0' />}
              <code className='min-w-0 flex-1 truncate font-mono text-sm' title={o.pattern}>{o.pattern}</code>
              <span className={cn('text-xs font-medium', o.state === 'missing' ? 'text-destructive' : 'text-muted-foreground')}>{OUTPUT_WORDS[o.state]}</span>
            </li>
          ))}
        </ul>
      </Section>
    )}
    {!!res.checks.length && (
      <Section id='checks' title='Checks'>
        <div className='flex flex-wrap gap-2 border-b px-4 py-3 sm:px-6' data-run-check-counts=''>
          {Object.entries(res.counts).map(([k, v]) => <ToneBadge key={k} color={RESULT_COLOR[k] ?? 'neutral'}>{v} {(RESULT_LABELS[k] ?? k).toLowerCase()}</ToneBadge>)}
        </div>
        <div className='overflow-x-auto'>
          <table className='w-full text-sm' data-run-checks=''>
            <thead className='[&_tr]:border-b'><tr>{['Check', 'Asset', 'Result', 'Evidence'].map((h) => <th key={h} scope='col' className={TH}>{h}</th>)}</tr></thead>
            <tbody className='[&_tr:last-child]:border-0'>
              {res.checks.map((c, i) => (
                <tr key={i} className='border-b'>
                  <td className={cn(TD, 'break-all')}>{link(c.check)}</td><td className={cn(TD, 'break-all')}>{link(c.asset)}</td>
                  <td className={TD}><ToneBadge color={RESULT_COLOR[c.status] ?? 'neutral'}>{RESULT_LABELS[c.status] ?? c.status}</ToneBadge></td>
                  <td className={cn(TD, 'font-mono text-xs break-all')}>{c.evidence_ref ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    )}
  </>);
}

type RunFile = NonNullable<RunPageData['files']>['files'][number];
function FilesTab({ files }: { files: NonNullable<RunPageData['files']> }) {
  const tree = useMemo(() => fileTree(files.files.map((f) => ({ path: f.path, item: f }))), [files.files]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(folderPaths(tree)));
  const [chosen, setChosen] = useState<string | null>(null);
  const rows = treeRows(tree, open);
  const current = (rows.find((r) => r.node.path === chosen)?.node.item ?? rows.find((r) => r.node.item)?.node.item ?? null) as RunFile | null;
  const act = (nd: TreeNode<RunFile>) => (nd.item ? setChosen(nd.path) : setOpen((s) => { const x = new Set(s); if (x.has(nd.path)) x.delete(nd.path); else x.add(nd.path); return x; }));
  return (
    <Section id='files' title='Files it wrote' link={files.version !== null ? <span className='text-muted-foreground text-xs' data-run-version={files.version}>Workspace version {files.version}</span> : undefined}>
      {!files.files.length ? <p className='text-muted-foreground px-6 py-5 text-sm'>It kept no files of its own; its changes are in the workspace{files.version !== null ? ` (version ${files.version})` : ''}.</p> : (
        <div className='grid min-w-0 md:grid-cols-[minmax(14rem,20rem)_1fr]' data-run-files=''>
          <ul role='tree' aria-label='Files it wrote' className='flex flex-col gap-px border-b p-2 md:border-r md:border-b-0'>
            {rows.map(({ node: nd, depth }) => (
              <li key={nd.path} role='treeitem' aria-level={depth + 1} aria-selected={nd.item ? nd.item === current : undefined} aria-expanded={nd.item ? undefined : open.has(nd.path)}
                tabIndex={0} onClick={() => act(nd)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(nd); } }} data-run-file={nd.path}
                className={cn('flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring', nd.item && nd.item === current ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-muted/60')}
                style={{ paddingLeft: `${0.5 + depth}rem` }}>
                {nd.item ? <Icons.file aria-hidden className='text-muted-foreground size-4 shrink-0' /> : <Icons.folder aria-hidden className='size-4 shrink-0 text-amber-600 dark:text-amber-400' />}
                <span className='min-w-0 flex-1 truncate' title={nd.name}>{nd.name}</span>
                {nd.item?.size != null && <span className='text-muted-foreground text-xs tabular-nums'>{sizeWords(nd.item.size)}</span>}
              </li>
            ))}
          </ul>
          <div className='flex min-w-0 flex-col gap-3 p-4' data-run-file-preview={current?.path ?? ''}>
            {current && (<>
              <p className='font-mono text-sm font-medium break-all'>{current.path}</p>
              <dl className='text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs'>
                <dt>Kind</dt><dd className='text-foreground'>{current.kind === 'output' ? 'An output of the run' : 'A file its kind keeps'}</dd>
                <dt>Size</dt><dd className='text-foreground tabular-nums'>{sizeWords(current.size) || '—'}</dd>
                {current.sha256 && <><dt>SHA-256</dt><dd className='text-foreground font-mono break-all'>{current.sha256}</dd></>}
              </dl>
              {current.preview !== null && current.preview !== undefined ? <JsonBlock v={current.preview} label={`${current.path}: contents`} />
                : <p className='text-muted-foreground text-xs'>Its contents are in the workspace&apos;s files.</p>}
            </>)}
          </div>
        </div>
      )}
    </Section>
  );
}

function RelatedTab({ related }: { related: RunPageData['related'] }) {
  return (
    <Section id='related' title='Records'>
      <ul className='divide-y' data-run-related=''>
        {related.map((x) => {
          const h = recordHref(x);
          return (
            <li key={`${x.area}/${x.key}`} className='flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 sm:px-6' data-related-record={x.key}>
              <div className='flex min-w-0 flex-1 flex-col'>
                {h ? <Link href={h} className='font-medium underline-offset-4 hover:underline'>{x.title || x.key}</Link> : <span className='font-medium'>{x.title || x.key}</span>}
                <span className='text-muted-foreground text-xs'>{areaLabel(x.area)}{x.title && x.title !== x.key ? <> · <span className='font-mono'>{x.key}</span></> : null}</span>
              </div>
              <span className='flex flex-wrap gap-1.5'>{x.how.map((w) => <ToneBadge key={w} color={w === 'Created' ? 'success' : w === 'Changed' ? 'info' : 'neutral'}>{w}</ToneBadge>)}</span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

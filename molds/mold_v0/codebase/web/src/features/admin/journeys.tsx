'use client';
// /admin Journeys as one database: the customer journeys (use-case pipelines customers follow on /app; written and
// promoted here) and the tips Octillion delivers in chat and on /app (from PostHog Workflows, or sent by hand). Views split
// the two kinds; every action sits in a row's ⋯ menu, the bulk bar or the peek. Journeys are not ordered.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import PageContainer from '@/components/layout/page-container';
import { ActionsMenu, Field, RecordView, type RecordCol, type RecordViewDef, type RowAction } from '@/components/layout/record-view';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Dock } from '@/features/portal/memory';
import { post, useAdmin, useAdminAction } from './lib';
import { blank, Editor, toDraft, type Draft, type Playbook } from './playbooks';
import { copyText, CopyField, ErrorBox, Mono, StatusBadge, When, type Tone } from './ui';
import { Gate, useAdminRole } from './role';

interface Step { step: string; when: string; channels: string[]; message: string; prompt?: string; link?: string; body: string }
interface Recipe { id: string; name: string; goal: string; trigger: string; steps: Step[] }
interface Tip { id: number; created_at: string; expires_at: string; dismissed_at: string | null; shown_count: number; last_shown_at: string | null;
  org_slug: string; org_name: string; user_id: string | null; email: string | null; journey: string; step: string; source: string; message: string; prompt?: string | null }
interface StepStat { journey: string; step: string; queued: number; shown: number; dismissed: number; active: number; last: string }
interface Nudges {
  configured: boolean; posthog: boolean; webhook_url: string; interval_hours: number; max_chat_shows: number; muted: number;
  steps: StepStat[]; recent: Tip[]; recipes: Recipe[];
}
/** What POST /journeys/nudges takes (src/journeys.ts NudgeInput plus the admin's org_slug). */
export interface NudgeInput { org_slug: string; user_id: string; journey: string; step: string; message: string; prompt: string; link: string; ttl_days: number }
type Row = { key: string; kind: 'journey'; p: Playbook } | { key: string; kind: 'tip'; t: Tip };
type J = Extract<Row, { kind: 'journey' }>;
type T = Extract<Row, { kind: 'tip' }>;
interface Ask { title: string; description: ReactNode; label: string; run: () => void }

const NA = <span className='text-muted-foreground'>—</span>;
const Label = ({ children }: { children: ReactNode }) => <div className='text-muted-foreground mb-2 text-xs font-medium leading-none'>{children}</div>;
/** Long prose under a plain label: Field centres its label (items-center), which floats beside multi-line values. */
const Prose = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className='flex flex-col gap-2'><div className='text-muted-foreground text-xs font-medium leading-none'>{label}</div><div className='text-sm leading-relaxed whitespace-pre-wrap'>{children}</div></div>);
const Dot = () => <span className='text-muted-foreground/60'>·</span>;
const Muted = ({ children }: { children: ReactNode }) => <span className='text-muted-foreground'>{children}</span>;
// The peek states status as a plain word (the table keeps the badge): live states in foreground, finished ones muted.
const Status = ({ s }: { s: string }) => <span className={cn('capitalize', s === 'promoted' || s === 'shown' || s === 'waiting' ? 'text-foreground font-medium' : 'text-muted-foreground')}>{s}</span>;
const META = 'text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-none';
const PROMPT = 'font-mono text-xs leading-relaxed whitespace-pre-wrap border-l-2 pl-3';
/** queued · shown · dismissed · active for one journey/step across every account; numbers in foreground, words muted. */
const Delivery = ({ x }: { x: StepStat }) => (
  <span className='text-sm tabular-nums'>{x.queued} <Muted>queued ·</Muted> {x.shown} <Muted>shown ·</Muted> {x.dismissed} <Muted>dismissed ·</Muted> {x.active} <Muted>active</Muted></span>);
const tipState = (t: Tip) => t.dismissed_at ? 'dismissed' : new Date(t.expires_at) < new Date() ? 'expired' : t.shown_count ? 'shown' : 'waiting';
const statusOf = (r: Row) => r.kind === 'journey' ? (r.p.promoted ? 'promoted' : 'hidden') : tipState(r.t);
const TONE: Record<string, Tone> = { promoted: 'ok', hidden: 'neutral', waiting: 'info', shown: 'ok', dismissed: 'neutral', expired: 'neutral' };
// Origin comes from the seeded ids (PLAYBOOKS in src/playbooks.ts), not updated_by, which promote/hide/edit overwrite.
// Tips are 'admin' (sent by hand) or 'posthog'.
const SEEDED = new Set(['baseline', 'fix-loss', 'head-to-head', 'agent-audit', 'new-capability', 'release-watch']);
const sourceOf = (r: Row) => r.kind === 'journey' ? (SEEDED.has(r.p.id) ? 'template' : 'admin') : r.t.source === 'admin' ? 'admin' : 'posthog';
const SOURCES = [{ value: 'template', label: 'template' }, { value: 'admin', label: 'by hand' }, { value: 'posthog', label: 'PostHog' }];
const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : '—');
const hours = (h: number | null | undefined) => h == null ? null : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`;
const isJ = (r: Row): r is J => r.kind === 'journey', isT = (r: Row): r is T => r.kind === 'tip';
const tipLive = (t: Tip) => !t.dismissed_at && new Date(t.expires_at) >= new Date();
const audience = (r: Row) => r.kind === 'journey' ? r.p.who || null : r.t.user_id ? (r.t.email ?? 'one person') : 'everyone';
// Tips upsert on (account, person, journey, step), so a copy needs an unused step or it would overwrite the original's history.
const tipKey = (t: { org_slug?: string; user_id?: string | null; journey?: string; step?: string }) => `${t.org_slug}|${t.user_id ?? ''}|${t.journey}|${t.step}`;
const duplicate = (t: Tip, tips: Tip[]): Partial<NudgeInput> => {
  const taken = new Set(tips.map(tipKey)), base = t.step.replace(/-\d+$/, '');
  let n = 2; while (taken.has(tipKey({ ...t, step: `${base}-${n}` }))) n++;
  return { org_slug: t.org_slug, user_id: t.user_id ?? '', journey: t.journey, step: `${base}-${n}`, message: t.message, prompt: t.prompt ?? '' };
};

const VIEWS: RecordViewDef<Row>[] = [
  { id: 'all', label: 'All', group: 'kind' },
  { id: 'journeys', label: 'Journeys', match: isJ },
  { id: 'promoted', label: 'Promoted', match: (r) => isJ(r) && r.p.promoted },
  { id: 'hidden', label: 'Hidden', match: (r) => isJ(r) && !r.p.promoted },
  { id: 'tips', label: 'Tips', match: isT },
  { id: 'tips_active', label: 'Active tips', match: (r) => isT(r) && tipLive(r.t) },
  { id: 'tips_admin', label: 'Sent by hand', match: (r) => isT(r) && r.t.source === 'admin' },
  { id: 'tips_posthog', label: 'From PostHog', match: (r) => isT(r) && r.t.source !== 'admin' },
  { id: 'tips_done', label: 'Finished tips', match: (r) => isT(r) && !tipLive(r.t) }
];

const cols: RecordCol<Row>[] = [
  { key: 'name', label: 'Name', keep: true, title: true, peek: false, type: 'text', value: (r) => r.kind === 'journey' ? r.p.name : r.t.message,
    render: (r) => r.kind === 'journey' ? <span className='leading-none font-medium'>{r.p.name}</span> : <span className='line-clamp-1 text-sm leading-none'>{r.t.message}</span> },
  { key: 'kind', label: 'Kind', className: 'w-24', hidden: true, type: 'select', value: (r) => r.kind, options: [{ value: 'journey', label: 'Journey' }, { value: 'tip', label: 'Tip' }],
    render: (r) => <span className='text-muted-foreground text-sm leading-none'>{r.kind === 'journey' ? 'Journey' : 'Tip'}</span> },
  { key: 'status', label: 'Status', className: 'w-28', keep: true, type: 'select', value: statusOf, options: Object.keys(TONE).map((value) => ({ value })),
    render: (r) => { const s = statusOf(r); return <StatusBadge tone={TONE[s]}>{s === 'shown' && r.kind === 'tip' ? `shown ${r.t.shown_count}×` : s}</StatusBadge>; } },
  { key: 'source', label: 'Source', hidden: true, className: 'w-24', type: 'select', value: sourceOf, options: SOURCES,
    render: (r) => <span className='text-muted-foreground text-xs leading-none'>{SOURCES.find((s) => s.value === sourceOf(r))?.label}</span> },
  { key: 'account', label: 'Account', hidden: true, className: 'w-36', type: 'text', value: (r) => (r.kind === 'tip' ? r.t.org_name : null),
    render: (r) => (r.kind === 'tip' ? <span className='text-xs leading-none'>{r.t.org_name}</span> : NA) },
  { key: 'audience', label: 'Audience', hidden: true, className: 'w-48', type: 'text', value: audience,
    render: (r) => { const a = audience(r); return a ? <span className='text-muted-foreground line-clamp-1 text-xs leading-none'>{a}</span> : NA; } },
  { key: 'reach', label: 'Reach', className: 'w-36', type: 'number', value: (r) => (r.kind === 'journey' ? r.p.adoption?.started ?? 0 : r.t.shown_count),
    render: (r) => <span className='flex min-w-0 flex-col gap-1'><span className='text-sm tabular-nums leading-none'>{r.kind === 'journey' ? r.p.adoption?.started ?? 0 : r.t.shown_count}</span>
      <span className='text-muted-foreground text-xs'>{r.kind === 'journey' ? `started · ${r.p.adoption?.completed ?? 0} finished` : 'shown'}</span></span> },
  { key: 'completed', label: 'Finished', name: 'Finished', hidden: true, className: 'w-28 text-right', type: 'number', value: (r) => (r.kind === 'journey' ? r.p.adoption?.completed ?? 0 : null),
    render: (r) => r.kind === 'journey' ? <span className='text-xs tabular-nums leading-none'>{r.p.adoption?.completed ?? 0} <span className='text-muted-foreground'>· {pct(r.p.adoption?.completed ?? 0, r.p.adoption?.started ?? 0)}</span></span> : NA },
  { key: 'median_h', label: 'Median time', hidden: true, className: 'w-24 text-right', type: 'number', value: (r) => (r.kind === 'journey' ? r.p.adoption?.median_hours_to_complete ?? null : null),
    render: (r) => (r.kind === 'journey' && hours(r.p.adoption?.median_hours_to_complete)) || NA },
  { key: 'dropoff', label: 'Most stop at', hidden: true, type: 'text', value: (r) => (r.kind === 'journey' ? r.p.adoption?.dropoff?.title ?? null : null),
    render: (r) => { const d = r.kind === 'journey' ? r.p.adoption?.dropoff : null; return d ? <span className='text-xs leading-none'>{d.title} <span className='text-muted-foreground'>−{d.lost}</span></span> : NA; } },
  { key: 'last_activity', label: 'Last activity', className: 'w-28', type: 'date', value: (r) => (r.kind === 'journey' ? r.p.adoption?.last_activity : r.t.last_shown_at) ?? null,
    render: (r) => { const d = r.kind === 'journey' ? r.p.adoption?.last_activity : r.t.last_shown_at; return <span className='flex min-w-0 flex-col gap-1'>{d ? <When d={d} className='text-muted-foreground text-xs' /> : NA}
      {r.kind === 'tip' && tipLive(r.t) && <span className='text-muted-foreground text-xs'>expires <When d={r.t.expires_at} /></span>}</span>; } },
  { key: 'expires_at', label: 'Expires', hidden: true, className: 'w-28', type: 'date', value: (r) => (r.kind === 'tip' ? r.t.expires_at : null),
    render: (r) => (r.kind === 'tip' ? <When d={r.t.expires_at} className='text-muted-foreground text-xs' /> : NA) },
  { key: 'updated', label: 'Changed', hidden: true, className: 'w-28', type: 'date', value: (r) => (r.kind === 'journey' ? r.p.updated_at : r.t.created_at),
    render: (r) => <When d={r.kind === 'journey' ? r.p.updated_at : r.t.created_at} className='text-muted-foreground text-xs' /> }
];

export function AdminJourneys() {
  const { lock } = useAdminRole();
  const { data: pb, error, isLoading } = useAdmin<{ playbooks: Playbook[]; tools: string[] }>('/playbooks');
  const { data: nj } = useAdmin<Nudges>('/journeys');
  const [draft, setDraft] = useState<Draft | null>(null);
  // n remounts the non-modal dock on each new prefill, so picking another row never leaves the old form in place.
  const [tipping, setTip] = useState<{ v: Partial<NudgeInput>; n: number } | null>(null);
  const setTipping = (v: Partial<NudgeInput> | null) => setTip(v ? { v, n: Date.now() } : null);
  const [setup, setSetup] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const promote = useAdminAction((v: { id: string; on: boolean }) => post(`/playbooks/${v.id}/promote`, { promoted: v.on }), { success: 'Saved' });
  const remove = useAdminAction((id: string) => adminApi('DELETE', `/playbooks/${id}`), { success: 'Journey deleted' });
  const removeTip = useAdminAction((id: number) => adminApi('DELETE', `/journeys/nudges/${id}`), { success: 'Tip removed' });
  // Bulk: one request per row in sequence (the API has no batch endpoints), one toast, one invalidation.
  const many = useAdminAction(async (v: { run: (r: Row) => Promise<unknown>; rows: Row[]; done: string }) => { for (const r of v.rows) await v.run(r); return `${v.rows.length} ${v.done}`; },
    { success: (m: string) => m });

  const rows: Row[] = useMemo(() => [
    ...(pb?.playbooks ?? []).map((p) => ({ key: `j-${p.id}`, kind: 'journey' as const, p })),
    ...(nj?.recent ?? []).map((t) => ({ key: `t-${t.id}`, kind: 'tip' as const, t }))
  ], [pb, nj]);

  const delJourney = (p: Playbook) => setAsk({ title: `Delete ${p.name}?`, description: 'Customers stop seeing it at once. This cannot be undone.', label: 'Delete', run: () => remove.mutate(p.id) });
  const delTip = (t: Tip) => setAsk({ title: 'Remove this tip?', description: `It stops showing to ${t.org_name}.`, label: 'Remove', run: () => removeTip.mutate(t.id) });
  const actions = (r: Row): RowAction[] => r.kind === 'journey' ? [
    lock({ label: r.p.promoted ? 'Hide from customers' : 'Promote to customers', icon: r.p.promoted ? <Icons.eyeOff /> : <Icons.check />, onSelect: () => promote.mutate({ id: r.p.id, on: !r.p.promoted }) }, 'library'),
    lock({ label: 'Edit', icon: <Icons.edit />, onSelect: () => setDraft(toDraft(r.p)) }, 'library'),
    lock({ label: 'Send a tip for this journey', icon: <Icons.send />, onSelect: () => setTipping({ journey: r.p.id }) }, 'journeys'),
    lock({ label: 'Delete', icon: <Icons.trash />, destructive: true, separator: true, onSelect: () => delJourney(r.p) }, 'delete')
  ] : [
    lock({ label: 'Duplicate as new tip', icon: <Icons.add />, onSelect: () => setTipping(duplicate(r.t, nj?.recent ?? [])) }, 'journeys'),
    lock({ label: 'Remove tip', icon: <Icons.trash />, destructive: true, separator: true, onSelect: () => delTip(r.t) }, 'journeys')
  ];
  const bulk = (sel: Row[], clear: () => void): RowAction[] => {
    const js = sel.filter(isJ), ts = sel.filter(isT);
    const toPromote = js.filter((r) => !r.p.promoted), toHide = js.filter((r) => r.p.promoted);
    const go = (v: Parameters<typeof many.mutate>[0]) => many.mutate(v, { onSuccess: clear });
    const out: RowAction[] = [];
    if (toPromote.length) out.push(lock({ label: `Promote ${toPromote.length}`, icon: <Icons.check />, onSelect: () => go({ rows: toPromote, done: 'promoted', run: (r) => post(`/playbooks/${(r as J).p.id}/promote`, { promoted: true }) }) }, 'library'));
    if (toHide.length) out.push(lock({ label: `Hide ${toHide.length}`, icon: <Icons.eyeOff />, onSelect: () => go({ rows: toHide, done: 'hidden', run: (r) => post(`/playbooks/${(r as J).p.id}/promote`, { promoted: false }) }) }, 'library'));
    if (js.length) out.push(lock({ label: `Delete ${js.length} journey${js.length === 1 ? '' : 's'}`, icon: <Icons.trash />, destructive: true, onSelect: () => setAsk({
      title: `Delete ${js.length} journey${js.length === 1 ? '' : 's'}?`, description: js.map((r) => r.p.name).join(', ') + '. Customers stop seeing them at once.', label: 'Delete',
      run: () => go({ rows: js, done: 'deleted', run: (r) => adminApi('DELETE', `/playbooks/${(r as J).p.id}`) }) }) }, 'delete'));
    if (ts.length) out.push(lock({ label: `Remove ${ts.length} tip${ts.length === 1 ? '' : 's'}`, icon: <Icons.trash />, destructive: true, onSelect: () => setAsk({
      title: `Remove ${ts.length} tip${ts.length === 1 ? '' : 's'}?`, description: 'They stop showing in chat and on /app.', label: 'Remove',
      run: () => go({ rows: ts, done: 'removed', run: (r) => adminApi('DELETE', `/journeys/nudges/${(r as T).t.id}`) }) }) }, 'journeys'));
    return out;
  };

  return (
    <PageContainer>
      <ErrorBox error={error} />
      <RecordView<Row>
        id='admin-journeys-v2' noun='items' exportName='journeys' groupable views={VIEWS} defaultSort={[{ key: 'name', dir: 'asc' }]}
        rows={rows} rowKey={(r) => r.key} cols={cols} actions={actions} bulk={bulk} loading={isLoading}
        searchText={(r) => r.kind === 'journey' ? `journey ${r.p.name} ${r.p.id} ${r.p.outcome} ${r.p.who} ${r.p.stages.map((s) => s.title).join(' ')}` : `tip ${r.t.message} ${r.t.org_name} ${r.t.org_slug} ${r.t.email ?? ''} ${r.t.journey} ${r.t.step}`}
        searchPlaceholder='Search journeys and tips'
        primary={<Gate need='library'><Button onClick={() => setDraft(blank())}><Icons.add /> New journey</Button></Gate>}
        primaryMenu={[
          lock({ label: 'Send a tip', icon: <Icons.send />, onSelect: () => setTipping({}) }, 'journeys'),
          { label: 'PostHog setup', icon: <Icons.settings />, onSelect: () => setSetup(true) }
        ]}
        empty='No journeys or tips yet.'
        detailTitle={(r) => r.kind === 'journey' ? r.p.name : r.t.message}
        // Journeys keep Edit inline (and only there); a tip's actions all sit in ⋯.
        detailActions={(r) => r.kind === 'journey' ? (<>
          <Gate need='library'><Button size='sm' variant='outline' onClick={() => setDraft(toDraft(r.p))}><Icons.edit /> Edit</Button></Gate>
          <ActionsMenu items={actions(r).filter((a) => a.label !== 'Edit')} />
        </>) : <ActionsMenu items={actions(r)} />}
        detail={(r) => r.kind === 'journey' ? <JourneyBody p={r.p} nj={nj} /> : <TipBody t={r.t} steps={nj?.steps ?? []} />}
      />
      {draft && <Editor draft={draft} tools={pb?.tools ?? []} onClose={() => setDraft(null)} />}
      {tipping && <TipDock key={tipping.n} initial={tipping.v} onClose={() => setTipping(null)} />}
      {setup && nj && <PostHogSetup j={nj} onClose={() => setSetup(false)} onTry={(r, x) => { setSetup(false); setTipping({ journey: r.id, step: x.step, message: x.message, prompt: x.prompt ?? '', link: x.link ?? '' }); }} />}
      <AlertDialog open={!!ask} onOpenChange={(o) => !o && setAsk(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{ask?.title}</AlertDialogTitle>
            <AlertDialogDescription>{ask?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={() => { ask?.run(); setAsk(null); }}>{ask?.label}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}

/** The journey peek: one meta line, adoption, each stage as the customer runs it (with how many accounts did it), the
 * tips sent for it, then the customer copy last. Sections are split by gap only. */
function JourneyBody({ p, nj }: { p: Playbook; nj?: Nudges }) {
  const a = p.adoption, started = a?.started ?? 0, active = p.accounts_active ?? 0;
  const by = p.updated_by && p.updated_by !== 'built-in' ? p.updated_by : null;
  const tips = (nj?.recent ?? []).filter((t) => t.journey === p.id).sort((x, y) => +new Date(y.created_at) - +new Date(x.created_at));
  const st = (nj?.steps ?? []).filter((x) => x.journey === p.id);
  // `recent` is the newest 50 tips across every journey, so the count comes from the per-step totals (count(*) as a string).
  const total = Math.max(tips.length, st.reduce((n, x) => n + Number(x.queued), 0)), list = tips.slice(0, 8);
  return (
    <div className='flex flex-col gap-8'>
      <div className={META}>
        <Status s={p.promoted ? 'promoted' : 'hidden'} /><Dot />
        <span>{SEEDED.has(p.id) ? 'Built-in' : 'Written by hand'}</span><Dot />
        <Mono>{p.id}</Mono><Dot />
        <span>Updated <When d={p.updated_at} />{by && ` by ${by}`}</span>
      </div>

      <section>
        <Label>Adoption</Label>
        {!a || started === 0
          ? <p className='text-muted-foreground text-sm leading-none'>No account has started this journey yet <Dot /> {active} active accounts.</p>
          : (
            <dl className='tabular-nums'>
              <Field label='Started'>{started}<Muted> of {active} active accounts · {pct(started, active)}</Muted></Field>
              <Field label='Finished'>{a.completed}<Muted> · {pct(a.completed, started)} of starters</Muted></Field>
              {started > a.completed && <Field label='Not finished'>{started - a.completed}<Muted> started but not finished</Muted></Field>}
              {a.dropoff && <Field label='Most stop at'>{a.dropoff.title}<Muted> · −{a.dropoff.lost}</Muted></Field>}
              <Field label='Median to finish'>{hours(a.median_hours_to_complete) ?? <Muted>No one has finished yet</Muted>}</Field>
              <Field label='Last activity'><When d={a.last_activity} /></Field>
            </dl>
          )}
      </section>

      <section>
        <Label>Stages<span className='tabular-nums'> {p.stages.length}</span></Label>
        {!p.stages.length && <p className='text-muted-foreground text-sm leading-none'>No stages yet.</p>}
        <ol>
          {p.stages.map((s, k) => {
            // Each stage's count is computed on its own (src/playbooks.ts), so a later stage can top an earlier one: "did this", not a funnel.
            const f = a?.funnel.find((x) => x.id === s.id) ?? a?.funnel[k];
            return (
              <li key={s.id ?? k} className='grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1.5 border-b py-3 last:border-b-0'>
                <span className='text-muted-foreground text-xs tabular-nums leading-none'>{k + 1}</span>
                <span className='truncate text-sm font-medium leading-none' title={s.title}>{s.title}</span>
                <span className='text-muted-foreground text-xs tabular-nums leading-none'>
                  {started > 0 && f ? `${f.reached} did this` : '—'}
                  {s.id && s.id === a?.dropoff?.id && <span className='text-amber-600 dark:text-amber-400'> · −{a.dropoff.lost}</span>}
                </span>
                {s.why && <p className='text-muted-foreground col-span-2 col-start-2 text-xs leading-snug'>{s.why}</p>}
                <code className={cn('col-span-2 col-start-2', PROMPT)}>{s.prompt}</code>
                <div className={cn('col-span-2 col-start-2', META)}>
                  {s.expect && <><span>You&apos;ll see <span className='text-foreground'>{s.expect}</span></span><Dot /></>}
                  {s.manual || !s.tools.length
                    ? <span>Marked by the customer</span>
                    : <span>Done by {s.tools.map((t, i) => <span key={t}>{i > 0 && ', '}<Mono>{t}</Mono></span>)}</span>}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section>
        <Label>Tips<span className='tabular-nums'> {total}</span></Label>
        {st.length > 0 && <dl className='mb-4'>{st.map((x) => <Field key={x.step} label={<Mono>{x.step}</Mono>}><Delivery x={x} /></Field>)}</dl>}
        {total
          ? (<>
            <ul>
              {list.map((t) => (
                <li key={t.id} className='flex items-center gap-3 border-b py-2.5 text-sm leading-none last:border-b-0'>
                  <span className='min-w-0 flex-1 truncate' title={t.message}>{t.message}</span>
                  <span className='text-muted-foreground flex shrink-0 items-center gap-2 text-xs'>{t.org_name}<Dot /><span className='capitalize'>{tipState(t)}</span><Dot /><When d={t.created_at} /></span>
                </li>
              ))}
            </ul>
            {/* Older tips fall outside the newest 50 loaded, so they are counted but not listed. */}
            {!list.length ? <p className='text-muted-foreground text-sm leading-none'>None among the 50 newest tips loaded.</p>
              : total > list.length && <p className='text-muted-foreground mt-2 text-xs leading-none tabular-nums'>{total - list.length} more{tips.length > list.length && ' in the Tips view'}</p>}
          </>)
          : <p className='text-muted-foreground text-sm leading-none'>No tips sent for this journey.</p>}
      </section>

      {(p.outcome || p.who || p.time || p.example.title || p.example.result) && (
        <section>
          <Label>Customer copy</Label>
          <div className='flex flex-col gap-4'>
            {p.outcome && <Prose label='Outcome'>{p.outcome}</Prose>}
            {p.who && <Prose label='For'>{p.who}</Prose>}
            {p.time && <Prose label='Takes'>{p.time}</Prose>}
            {(p.example.title || p.example.result) && <Prose label='Worked example'><span className='font-medium'>{p.example.title}</span>{p.example.result && <p className='text-muted-foreground mt-1'>{p.example.result}</p>}</Prose>}
          </div>
        </section>
      )}
    </div>
  );
}

/** The tip peek: one meta line, the full message (the title truncates it), its prompt, then delivery to its account and
 * how its journey/step is doing across every account. Never links into the customer's account. */
function TipBody({ t, steps }: { t: Tip; steps: StepStat[] }) {
  const agg = steps.find((x) => x.journey === t.journey && x.step === t.step);
  return (
    <div className='flex flex-col gap-8'>
      <div className={META}>
        <Status s={tipState(t)} /><Dot />
        <span>{t.source === 'admin' ? 'By hand' : 'From PostHog'}</span><Dot />
        <Mono>{t.journey} / {t.step}</Mono>
      </div>
      <Prose label='Message'>{t.message}</Prose>
      {t.prompt && <section><Label>Prompt</Label><code className={cn('block', PROMPT)}>{t.prompt}</code></section>}
      <dl>
        <Field label='To'>
          {t.org_name}
          {!t.user_id ? <Muted> · everyone</Muted> : t.email ? <Muted> · {t.email}</Muted>
            : <><Muted> · one person (email unknown) </Muted><span className='text-muted-foreground font-mono text-xs' title={t.user_id}>{t.user_id}</span></>}
        </Field>
        <Field label='Shown'>{t.shown_count ? <><span className='tabular-nums'>{t.shown_count}×</span>{t.last_shown_at && <Muted> · last <When d={t.last_shown_at} /></Muted>}</> : <Muted>Not yet</Muted>}</Field>
        <Field label='Queued'>{t.created_at ? <When d={t.created_at} /> : NA}</Field>
        <Field label='Ends'>{t.dismissed_at ? <>Dismissed <When d={t.dismissed_at} /></> : !t.expires_at ? NA
          : new Date(t.expires_at) < new Date() ? <>Expired <When d={t.expires_at} /></> : <>Expires <When d={t.expires_at} /></>}</Field>
        {agg && <Field label='All accounts'><Delivery x={agg} /></Field>}
      </dl>
    </div>
  );
}

/** Send a tip by hand: an account (and optionally one person), the journey/step it counts as, the message, a prompt, an
 * optional link and how long it stays. `initial` prefills it (a journey's tip, a duplicate, a recommended workflow step). */
export function TipDock({ initial = {}, onClose }: { initial?: Partial<NudgeInput>; onClose: () => void }) {
  const { data: orgs } = useAdmin<{ orgs: { slug: string; name: string }[] }>('/orgs');
  const [org, setOrg] = useState(initial.org_slug ?? '');
  const [user, setUser] = useState(initial.user_id ?? '');
  const [f, setF] = useState({ journey: initial.journey ?? 'manual', step: initial.step ?? 'announcement', message: initial.message ?? '', prompt: initial.prompt ?? '',
    link: initial.link ?? '', ttl_days: String(initial.ttl_days ?? 7) });
  const account = org || orgs?.orgs[0]?.slug || '';
  const { data: detail } = useAdmin<{ members: { user_id: string; email: string | null; status: string }[] }>(account ? `/orgs/${encodeURIComponent(account)}` : null);
  // A prefilled person belongs to the prefilled account; changing the account resets it.
  const prev = useRef(account);
  useEffect(() => { if (prev.current && prev.current !== account) setUser(''); prev.current = account; }, [account]);
  const send = useAdminAction(() => post('/journeys/nudges', { org_slug: account, user_id: user || undefined, journey: f.journey, step: f.step, message: f.message,
    prompt: f.prompt || undefined, link: f.link || undefined, ttl_days: Number(f.ttl_days) || undefined }), { success: 'Tip queued' });
  return (
    <Dock title='Send a tip' onClose={onClose}>
      <form className='flex flex-col gap-3 p-4' onSubmit={(e) => { e.preventDefault(); send.mutate(undefined, { onSuccess: onClose }); }}>
        <div className='grid gap-2 sm:grid-cols-2'>
          <NativeSelect aria-label='Account' value={account} onChange={(e) => setOrg(e.target.value)} className='w-full'>
            {(orgs?.orgs ?? []).map((o) => <NativeSelectOption key={o.slug} value={o.slug}>{o.name}</NativeSelectOption>)}
          </NativeSelect>
          <NativeSelect aria-label='Person' value={user} onChange={(e) => setUser(e.target.value)} className='w-full'>
            <NativeSelectOption value=''>Everyone in the account</NativeSelectOption>
            {(detail?.members ?? []).filter((m) => m.status === 'active' || m.user_id === user).map((m) => <NativeSelectOption key={m.user_id} value={m.user_id}>{m.email || m.user_id}</NativeSelectOption>)}
          </NativeSelect>
          <Input aria-label='Journey' placeholder='Journey' value={f.journey} onChange={(e) => setF({ ...f, journey: e.target.value })} />
          <Input aria-label='Step' placeholder='Step' value={f.step} onChange={(e) => setF({ ...f, step: e.target.value })} />
        </div>
        <Textarea aria-label='Message' required maxLength={280} rows={3} placeholder='The tip, up to 280 characters' value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} className='resize-none' />
        <Input aria-label='Prompt' maxLength={300} placeholder='Prompt to try (optional), e.g. Show my visibility report.' value={f.prompt} onChange={(e) => setF({ ...f, prompt: e.target.value })} />
        <div className='grid gap-2 sm:grid-cols-[1fr_7rem]'>
          {/* The API takes https:// links or /app paths only. */}
          <Input aria-label='Link' maxLength={500} pattern='(https://|/app).*' title='https://… or a /app path' placeholder='Link (optional): https://… or /app#setup' value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} />
          <Input aria-label='Days it stays' type='number' min={1} max={30} title='Days before it expires (1–30)' value={f.ttl_days} onChange={(e) => setF({ ...f, ttl_days: e.target.value })} />
        </div>
        <div className='flex items-center gap-2 border-t pt-3'>
          <Gate need='journeys'><Button type='submit' disabled={send.isPending || !account || !f.message.trim()}>Queue tip</Button></Gate>
          <span className='text-muted-foreground ml-auto text-xs tabular-nums'>{f.message.length}/280 · expires in {Number(f.ttl_days) || 7} d</span>
        </div>
      </form>
    </Dock>
  );
}

/** The PostHog connection, what has been delivered, and the recommended workflows to build there. */
function PostHogSetup({ j, onClose, onTry }: { j: Nudges; onClose: () => void; onTry: (r: Recipe, x: Step) => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>PostHog setup</DialogTitle>
          <DialogDescription>Tips come from PostHog Workflows: a webhook step posts to Octillion, which shows the tip in chat and on /app.</DialogDescription>
        </DialogHeader>
        <dl>
          <Field label='PostHog events'><StatusBadge tone={j.posthog ? 'ok' : 'neutral'}>{j.posthog ? 'on' : 'off'}</StatusBadge>{!j.posthog && <span className='text-muted-foreground text-xs'> set <Mono>POSTHOG_API_KEY</Mono></span>}</Field>
          <Field label='Journey webhook'><StatusBadge tone={j.configured ? 'ok' : 'neutral'}>{j.configured ? 'on' : 'off'}</StatusBadge>{!j.configured && <span className='text-muted-foreground text-xs'> set <Mono>OCTILLION_JOURNEY_SECRET</Mono></span>}</Field>
          <Field label='Webhook URL'><CopyField value={j.webhook_url} /></Field>
          <Field label='Limits'>One tip per person every {j.interval_hours} h in chat, shown up to {j.max_chat_shows}×; {j.muted} people turned tips off.</Field>
          <Field label='Delivered'>{j.steps.length ? j.steps.map((x) => `${x.journey}/${x.step}: ${x.shown} shown of ${x.queued}`).join(' · ') : 'Nothing yet.'}</Field>
        </dl>
        <div className='space-y-3'>
          <p className='text-sm font-medium'>Recommended workflows</p>
          {j.recipes.map((r) => (
            <details key={r.id} className='group rounded-lg border p-3'>
              <summary className='flex cursor-pointer list-none items-center gap-2 text-sm leading-none'>
                <Icons.chevronRight className='size-4 transition-transform group-open:rotate-90' /><span className='font-medium'>{r.name}</span><span className='text-muted-foreground truncate text-xs'>{r.goal}</span>
              </summary>
              <p className='mt-3 text-sm'><span className='font-medium'>Trigger:</span> {r.trigger}</p>
              {r.steps.filter((x) => x.channels.some((c) => c === 'chat' || c === 'app')).map((x, i) => (
                <div key={i} className='mt-3 space-y-2 border-l-2 pl-3'>
                  <p className='text-xs leading-none'><Mono>{x.step}</Mono> <span className='text-muted-foreground'>{x.when}</span></p>
                  <p className='text-sm'>{x.message}</p>
                  <div className='flex gap-2'>
                    <Button variant='outline' size='sm' onClick={() => copyText(x.body, 'Webhook body copied')}>Copy webhook body</Button>
                    <Button variant='ghost' size='sm' onClick={() => onTry(r, x)}>Send to an account</Button>
                  </div>
                </div>
              ))}
            </details>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

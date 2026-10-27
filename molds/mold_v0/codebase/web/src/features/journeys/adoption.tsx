'use client';
// /app/journeys (mold_v0-143: the journeys component's page, src/journeys.ts; it was a host pack's), a Notion-style
// database, person by person: each use case (the platform's journeys plus the account's own) with everyone who has
// worked on it, how far they got and how much they used it, what went wrong, and who can
// help. Stuck people ask the team; a teammate picks the request up, gets where they are stuck, and closes it when done.
// Filters: a date range (who was active in it) and people. Use cases import and export as JSON or CSV. Click a row to
// open it beside the table: help, then stages with their prompts, what is done, and mark-done for steps without a tool.
import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { DateRangePicker, PRESETS, rangeQuery, type DateRange } from '@/components/layout/date-range-picker';
import { MultiSelectFilter } from '@/components/layout/multi-select-filter';
import { Field, RecordView, type RecordCol, type RowAction } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { downloadCsv, downloadJson, parseCsv, today } from '@/lib/csv';
import { cn } from '@/lib/utils';
import { Dock } from '@/components/layout/dock';
import { CopyButton, ErrorState, When, copy, fail, useOrgLoad } from '@/features/portal/shared';
import { Allowed, useAccountRole } from '@/features/portal/role';
import { profile } from '@/config/profile.generated';
import { journeyFacts, launchesWork, launchGroup } from './config';

interface Setup { clients: { client: string; last: string }[]; groups: { id: string; label: string; prompt: string; used: number; total: number }[]; viewer_note?: string | null }
interface Stage { id: string; title: string; why: string; prompt: string; tools: string[]; expect: string; manual?: boolean; done: boolean; at: string | null }
interface Journey { id: string; name: string; outcome: string; who: string; time: string; stages: Stage[]; done: number; total: number; own?: boolean; added_by?: string | null }
interface Person { user_id: string; label: string; email: string | null; done: number; total: number; calls: number; errors: number; last_error: string | null; stuck: string | null; at: string | null; finished: boolean }
interface UseCaseUse { id: string; name: string; outcome: string; total: number; people: Person[]; helper: string | null; helper_label: string | null; helper_email: string | null }
interface Help {
  id: number; journey_id: string; requester: string; helper: string | null; note: string; status: 'open' | 'picked' | 'done'; created_at: string; picked_at: string | null;
  requester_label: string | null; requester_email: string | null; helper_label: string | null; helper_email: string | null;
}
interface Adoption { me: string | null; use_cases: UseCaseUse[]; help: Help[]; members: { user_id: string; label: string | null; calls?: number }[];
  workflow?: { id: string; people: { user_id: string | null; label: string | null; used: number; total: number; calls: number }[] }[] }
type Row =
  | { key: string; type: 'workflow'; name: string; detail: string; done: number; total: number; g: Setup['groups'][number]; person: string | null }
  | { key: string; type: 'use case'; name: string; detail: string; done: number; total: number; j: Journey; who: Person | null; uc: UseCaseUse | null; help: Help | null }
  | { key: string; type: 'client'; name: string; detail: string; done: number; total: number; at: string };

const last90 = () => PRESETS.find((p) => p.id === '90d')!.range();

export function AdoptionPage() {
  const [range, setRange] = useState<DateRange>(last90);
  const [users, setUsers] = useState<string[]>([]);
  const q = `${rangeQuery(range)}${users.length ? `&user=${users.map(encodeURIComponent).join(',')}` : ''}`;
  const { data: s, error, reload: reloadSetup } = useOrgLoad(() => appApi<Setup>('GET', '/setup'));
  const { data: jr, reload: reloadJourneys } = useOrgLoad(() => appApi<{ journeys: Journey[] }>('GET', '/journeys'));
  const { data: ad, reload: reloadAdoption } = useOrgLoad(() => appApi<Adoption>('GET', `/adoption?${q}`), [q]);
  const reload = () => { reloadJourneys(); reloadAdoption(); };
  const [adding, setAdding] = useState(false);
  const [asking, setAsking] = useState<Journey | null>(null);
  const router = useRouter();
  const me = ad?.me ?? null;
  const file = useRef<HTMLInputElement>(null);
  const { lock } = useAccountRole();
  const note = s?.viewer_note ?? null;

  const removeUseCase = (j: Journey) => {
    if (!window.confirm(`Remove ${j.name}?`)) return;
    appApi('DELETE', `/journeys/${encodeURIComponent(j.id)}`).then(() => { toast.success('Use case removed'); reload(); }).catch(fail);
  };
  const helpAct = (h: Help, action: 'pick' | 'done' | 'release' | 'cancel', ok: string, then?: () => void) =>
    appApi('POST', `/adoption/help/${h.id}/${action}`).then(() => { toast.success(ok); reloadAdoption(); then?.(); }).catch(fail);
  // Pick up a request, then start helping straight away: an email to the asker with where they are stuck.
  const pickUp = (h: Help, j: Journey, who: Person | null) => helpAct(h, 'pick', `You picked up ${h.requester_label ?? 'the request'}`, () => {
    const link = helpLink(h, j, who); if (link) window.location.href = link;
  });

  const prefix = journeyFacts()?.words.export_prefix ?? 'use-cases';
  const exportJson = () => jr && downloadJson(`${prefix}-${today()}.json`, { use_cases: jr.journeys.map(portable) });
  const exportCsv = () => jr && downloadCsv(`${prefix}-${today()}.csv`, ['use_case', 'outcome', 'step', 'title', 'prompt'],
    jr.journeys.flatMap((j) => j.stages.map((st, i) => [j.name, j.outcome, i + 1, st.title, st.prompt])));
  const importFile = async (f: File) => {
    let items: Portable[];
    try { items = parseUseCases(f.name, await f.text()); } catch (e) { fail(e); return; }
    if (!items.length) { toast.error('No use cases found in that file'); return; }
    appApi<{ imported: number; skipped: number; errors: string[] }>('POST', '/journeys/import', { items })
      .then((r) => { toast.success(`Imported ${r.imported} use case${r.imported === 1 ? '' : 's'}${r.skipped ? `, skipped ${r.skipped} (already here or incomplete)` : ''}`); if (r.errors[0]) toast.error(r.errors[0]); reload(); })
      .catch(fail);
  };

  const narrowed = users.length > 0;
  const rows: Row[] = !s ? [] : [
    // One row per person who worked on a use case in the range; a use case nobody touched gets one row of its own
    // (hidden while filtering by people).
    ...(jr?.journeys ?? []).flatMap((j): Row[] => {
      const uc = ad?.use_cases.find((x) => x.id === j.id) ?? null;
      const base = { type: 'use case' as const, name: j.name, detail: j.outcome, j, uc };
      const helpFor = (user: string) => ad?.help.find((h) => h.journey_id === j.id && h.requester === user && h.status !== 'done') ?? null;
      if (uc?.people.length) return uc.people.map((p) => ({ ...base, key: `j-${j.id}-${p.user_id}`, done: p.done, total: p.total, who: p, help: helpFor(p.user_id) }));
      return narrowed ? [] : [{ ...base, key: `j-${j.id}`, done: 0, total: j.total, who: null, help: null }];
    }),
    // Workflow parts person by person (from the tool calls each made); a part nobody used is one "Nobody yet" row.
    ...s.groups.flatMap((g): Row[] => {
      const people = ad?.workflow?.find((w) => w.id === g.id)?.people ?? [];
      if (people.length) return people.map((p) => ({ key: `w-${g.id}-${p.user_id ?? 'key'}`, type: 'workflow' as const, name: g.label,
        detail: `Workflow · ${p.calls} call${p.calls === 1 ? '' : 's'}`, done: p.used, total: p.total, g, person: p.label }));
      return narrowed ? [] : [{ key: `w-${g.id}`, type: 'workflow' as const, name: g.label, detail: 'Workflow · Not tried yet', done: 0, total: g.total, g, person: null }];
    }),
    ...(narrowed ? [] : s.clients.filter((c) => c.last.slice(0, 10) >= range.from && c.last.slice(0, 10) <= range.to)
      .map((c) => ({ key: `c-${c.client}`, type: 'client' as const, name: c.client, detail: 'AI client', done: 1, total: 1, at: c.last })))
  ];
  // Who a row is about: the person on a use case or workflow part (nobody in the range: "Nobody yet"; calls made with a
  // connector key rather than a signed-in person: "Connector key"), you for clients (the list is yours).
  const userOf = (r: Row) => r.type === 'use case' ? (r.who?.label ?? 'Nobody yet') : r.type === 'workflow' ? (r.person ?? 'Nobody yet') : 'You';
  const helpState = (r: Row) => helpStatus(r, me);
  const cols: RecordCol<Row>[] = [
    { key: 'item', label: 'Item', className: 'min-w-72', keep: true, title: true, type: 'text', value: (r) => r.name, render: (r) => (<>
      <p className='text-sm leading-none font-medium'>{r.name}</p>
      {r.detail && <p className='text-muted-foreground mt-1.5 line-clamp-1 text-xs leading-none'>{r.detail}</p>}
    </>) },
    { key: 'user', label: 'User', className: 'w-40', keep: true, type: 'select', value: userOf, render: (r) => <span className={cn('block max-w-40 truncate text-sm', (r.type === 'use case' && r.who) || (r.type === 'workflow' && r.person) ? '' : 'text-muted-foreground')}>{userOf(r)}</span> },
    { key: 'usage', label: 'Usage', className: 'w-44', type: 'number', value: (r) => r.done / Math.max(1, r.total), render: (r) => (
      <div className='space-y-1.5'>
        <Progress done={r.done} total={r.total} check={r.type === 'client'} />
        {/* Line 2, the first that applies: what failed, the outcome reached, or where they are stuck (was the Issues column). */}
        {r.type === 'use case' && r.who && (r.who.errors
          ? <p className='text-destructive block max-w-44 truncate text-xs leading-none' title={r.who.last_error ?? undefined}>{r.who.errors} failed · {r.who.last_error ?? 'tool error'}</p>
          : <p className='text-muted-foreground block max-w-44 truncate text-xs leading-none' title={!r.who.finished && r.who.stuck ? `Next: ${r.who.stuck}` : undefined}>
            {r.who.calls} call{r.who.calls === 1 ? '' : 's'}{r.who.finished ? ' · outcome reached' : r.who.stuck ? ` · Next: ${r.who.stuck}` : ''}</p>)}
      </div>
    ) },
    { key: 'help', label: 'Help', className: 'w-48', type: 'select', value: (r) => helpState(r).label,
      render: (r) => <HelpCell r={r} me={me} onPick={(h) => r.type === 'use case' && pickUp(h, r.j, r.who)} /> },
    { key: 'last', label: 'Last', className: 'hidden w-24 sm:table-cell', type: 'date', value: (r) => r.type === 'client' ? r.at : r.type === 'use case' ? r.who?.at ?? null : null,
      render: (r) => <span className='text-muted-foreground text-xs'>{r.type === 'client' ? <When d={r.at} /> : r.type === 'use case' && r.who?.at ? <When d={r.who.at} /> : '—'}</span> }
  ];

  // Actions on a use-case row, by who you are to it: the stuck person asks; teammates pick up, offer or email.
  const useCaseActions = (r: Extract<Row, { type: 'use case' }>): RowAction[] => {
    const h = r.help, mine = !!r.who && r.who.user_id === me, a: RowAction[] = [];
    // Help requests and removing a use case need 'edit'; emails and opening Setup stay open to everyone.
    const w = (...xs: RowAction[]) => a.push(...xs.map((x) => lock(x, 'edit')));
    if (h && h.status === 'open' && !mine) w({ label: `Pick up and help ${h.requester_label}`, icon: <Icons.check />, onSelect: () => pickUp(h, r.j, r.who) });
    if (h && h.status === 'picked' && h.helper === me) {
      const link = helpLink(h, r.j, r.who);
      if (link) a.push({ label: `Email ${h.requester_label}`, icon: <Icons.send />, onSelect: () => { window.location.href = link; } });
      w({ label: 'Mark helped', icon: <Icons.check />, onSelect: () => helpAct(h, 'done', 'Marked helped') },
        { label: 'Hand it back', icon: <Icons.arrowRight />, onSelect: () => helpAct(h, 'release', 'Handed back to the team') });
    }
    if (mine && !r.who!.finished && !h) w({ label: 'Ask the team for help', icon: <Icons.help />, onSelect: () => setAsking(r.j) });
    if (mine && h) {
      if (h.status === 'picked') w({ label: 'Mark helped', icon: <Icons.check />, onSelect: () => helpAct(h, 'done', 'Marked helped') });
      w({ label: 'Withdraw help request', icon: <Icons.close />, onSelect: () => helpAct(h, 'cancel', 'Help request withdrawn') });
    }
    const offer = offerLink(r, me);
    if (offer && !h) a.push({ label: `Offer help to ${r.who!.label}`, icon: <Icons.send />, onSelect: () => { window.location.href = offer; } });
    const ask = askLink(r);
    if (ask && !h) a.push({ label: `Email ${r.uc!.helper_label} for help`, icon: <Icons.send />, onSelect: () => { window.location.href = ask; } });
    a.push({ label: r.who ? 'Open in Setup & training' : 'Start in Setup & training', icon: <Icons.arrowRight />, separator: a.length > 0,
      onSelect: () => router.push(`/app?journey=${encodeURIComponent(r.j.id)}`) });
    if (r.j.own) w({ label: 'Remove use case', icon: <Icons.trash />, destructive: true, separator: true, onSelect: () => removeUseCase(r.j) });
    return a;
  };

  // One button plus RecordView's ▾ menu holding Import and the exports.
  const primary = <Allowed need='edit'><Button onClick={() => setAdding(true)}><Icons.add /> Add use case</Button></Allowed>;
  const primaryMenu: RowAction[] = [
    lock({ label: 'Import JSON or CSV', icon: <Icons.upload />, onSelect: () => file.current?.click() }, 'edit'),
    { label: 'Export JSON', icon: <Icons.download />, separator: true, disabled: !jr?.journeys.length, onSelect: exportJson },
    { label: 'Export CSV', icon: <Icons.download />, disabled: !jr?.journeys.length, onSelect: exportCsv }
  ];
  const peopleOpts = useMemo(() => (ad?.members ?? []).map((m) => ({ value: m.user_id, label: m.label ?? 'Unnamed', count: m.calls })), [ad?.members]);

  if (error) return <PageContainer><ErrorState error={error} /></PageContainer>;
  return (
    <PageContainer>
      <RecordView<Row>
        id='portal-adoption' rows={rows} rowKey={(r) => r.key} cols={cols} loading={!s || !ad} noun='items'
        searchText={(r) => `${r.type} ${r.name} ${r.detail} ${userOf(r)} ${helpState(r).label}`}
        searchPlaceholder='Search adoption: use cases, people, issues'
        filters={<>
          <MultiSelectFilter noun='people' icon={<Icons.teams />} options={peopleOpts} value={users} onChange={setUsers} />
          <DateRangePicker value={range} onChange={setRange} />
        </>}
        primary={primary} primaryMenu={primaryMenu}
        empty={narrowed ? 'Nobody you picked worked on a use case in this period.' : 'Nothing to show yet.'}
        detailTitle={(r) => r.name}
        actions={(r) => r.type === 'use case' ? useCaseActions(r) : r.type === 'workflow' ? (note && launchGroup(r.g.id) ? [] : [{ label: 'Copy prompt', icon: <Icons.page />, onSelect: () => copy(r.g.prompt) }])
          : [{ label: 'Remove from my clients', icon: <Icons.trash />, destructive: true, onSelect: () => void appApi('DELETE', `/clients/${encodeURIComponent(r.name)}`).then(() => { toast.success(`${r.name} removed`); reloadSetup(); }, fail) }]}
        detail={(r) => r.type === 'use case' ? (
          <div className='flex flex-col gap-6'>
            <HelpPanel r={r} me={me} onPick={(h) => pickUp(h, r.j, r.who)} onAct={helpAct} onAsk={() => setAsking(r.j)} />
            <UseCase j={r.j} onChanged={reload} note={note} />
          </div>
        ) : r.type === 'workflow' ? <Workflow g={r.g} note={note && launchGroup(r.g.id) ? note : null} /> : <Client name={r.name} at={r.at} />}
      />
      <input ref={file} type='file' accept='.json,.csv,application/json,text/csv' className='hidden' onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
      {adding && <UseCaseEditor onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
      {asking && <AskDialog j={asking} stuck={ad?.use_cases.find((u) => u.id === asking.id)?.people.find((p) => p.user_id === me)?.stuck ?? null}
        onClose={() => setAsking(null)} onSent={() => { setAsking(null); reloadAdoption(); }} />}
    </PageContainer>
  );
}

// ---------- import / export ----------

interface Portable { name: string; outcome: string; stages: { title: string; prompt: string }[] }
const portable = (j: Journey): Portable => ({ name: j.name, outcome: j.outcome, stages: j.stages.map((st) => ({ title: st.title, prompt: st.prompt })) });

/** A use-case file: our JSON export ({ use_cases: [...] } or a bare list), or CSV with use_case, outcome, title, prompt
 *  columns, one row per step (rows with the same use_case join up in order). */
function parseUseCases(name: string, text: string): Portable[] {
  const t = text.replace(/^\uFEFF/, '').trim();
  if (name.toLowerCase().endsWith('.json') || t.startsWith('[') || t.startsWith('{')) {
    const data = JSON.parse(t);
    const list = Array.isArray(data) ? data : Array.isArray(data?.use_cases) ? data.use_cases : null;
    if (!list) throw new Error('JSON must be a list of use cases, e.g. [{ "name": "…", "outcome": "…", "stages": [{ "title": "…", "prompt": "…" }] }]');
    return list.map((x: any) => ({ name: String(x?.name ?? ''), outcome: String(x?.outcome ?? ''),
      stages: (Array.isArray(x?.stages) ? x.stages : []).map((st: any) => ({ title: String(st?.title ?? ''), prompt: String(st?.prompt ?? '') })) }));
  }
  const [head, ...rest] = parseCsv(t);
  if (!head) return [];
  const cols = head.map((h) => h.trim().toLowerCase());
  const at = (k: string[]) => cols.findIndex((c) => k.includes(c));
  const nameAt = at(['use_case', 'use case', 'name']), outAt = at(['outcome']), titleAt = at(['title', 'step_title']), promptAt = at(['prompt']);
  if (nameAt < 0 || promptAt < 0) throw new Error('CSV needs use_case and prompt columns (outcome and title are optional)');
  const by = new Map<string, Portable>();
  for (const r of rest) {
    const n = (r[nameAt] ?? '').trim(); if (!n) continue;
    const u = by.get(n) ?? by.set(n, { name: n, outcome: '', stages: [] }).get(n)!;
    if (!u.outcome && outAt >= 0) u.outcome = (r[outAt] ?? '').trim();
    if ((r[promptAt] ?? '').trim()) u.stages.push({ title: titleAt >= 0 ? (r[titleAt] ?? '').trim() : '', prompt: r[promptAt].trim() });
  }
  return [...by.values()];
}

// ---------- helping each other ----------

/** Where a use-case row stands on help, as a short label (also the Help column's filter value). */
function helpStatus(r: Row, me: string | null): { label: string; tone: 'want' | 'busy' | 'muted' | 'link' } {
  if (r.type !== 'use case') return { label: '—', tone: 'muted' };
  const h = r.help, mine = r.who?.user_id === me;
  if (h?.status === 'open') return mine ? { label: 'Asked the team', tone: 'busy' } : { label: 'Help wanted', tone: 'want' };
  if (h?.status === 'picked') return { label: h.helper === me ? 'You are helping' : `${h.helper_label ?? 'Someone'} is helping`, tone: 'busy' };
  if (askLink(r)) return { label: 'Ask a teammate', tone: 'link' };
  if (r.who?.finished) return { label: (r.uc?.people ?? []).some((p) => !p.finished) ? 'Can help others' : 'Finished', tone: 'muted' };
  return { label: r.who ? 'Nobody ahead yet' : 'Be the first', tone: 'muted' };
}

/** A mailto that asks the teammate who finished (or got furthest on) a use case for help with it. */
function askLink(r: Row) {
  if (r.type !== 'use case' || !r.uc?.helper || !r.uc.helper_email || r.who?.finished || r.who?.user_id === r.uc.helper) return null;
  const stuck = r.who?.stuck ? ` I'm stuck at "${r.who.stuck}".` : '';
  return `mailto:${r.uc.helper_email}?subject=${encodeURIComponent(`Help with "${r.j.name}" in ${profile.name}`)}&body=${encodeURIComponent(`Hi, you got through "${r.j.name}" in ${profile.name}.${stuck} Could you show me how you did it?`)}`;
}

/** You finished this use case and the row is a teammate who has not: offer to walk them through it. */
function offerLink(r: Extract<Row, { type: 'use case' }>, me: string | null) {
  if (!me || !r.who || r.who.finished || r.who.user_id === me || !r.who.email) return null;
  if (!r.uc?.people.some((p) => p.user_id === me && p.finished)) return null;
  const stage = r.j.stages.find((st) => st.title === r.who!.stuck);
  return `mailto:${r.who.email}?subject=${encodeURIComponent(`Want a hand with "${r.j.name}"?`)}&body=${encodeURIComponent(`Hi, I got through "${r.j.name}" in ${profile.name} and saw you're at "${r.who.stuck ?? 'the start'}".${stage ? `\n\nThe prompt for that step:\n${stage.prompt}` : ''}\n\nHappy to walk you through it.`)}`;
}

/** After picking up a request: an email to the asker with their note, where they are stuck and that step's prompt. */
function helpLink(h: Help, j: Journey, who: Person | null) {
  if (!h.requester_email) return null;
  const stuck = who?.stuck ?? null, stage = j.stages.find((st) => st.title === stuck);
  const body = [`Hi, I picked up your request for help with "${j.name}" in ${profile.name}.`, h.note && `You wrote: "${h.note}"`,
    stuck && `You're at "${stuck}".${stage ? ` The prompt for that step:\n${stage.prompt}` : ''}`, 'When works for a quick call or chat?'].filter(Boolean).join('\n\n');
  return `mailto:${h.requester_email}?subject=${encodeURIComponent(`Helping with "${j.name}"`)}&body=${encodeURIComponent(body)}`;
}

/** The Help column: an open request from someone else is a Pick up button; everything else is a short status. */
function HelpCell({ r, me, onPick }: { r: Row; me: string | null; onPick: (h: Help) => void }) {
  const st = helpStatus(r, me);
  if (r.type === 'use case' && r.help?.status === 'open' && r.who?.user_id !== me) {
    const h = r.help;
    return (
      <span className='flex items-center gap-2 text-xs leading-none'>
        <span className='text-amber-600 dark:text-amber-400'>Help wanted</span>
        <Allowed need='edit'><Button size='xs' onClick={(e) => { e.stopPropagation(); onPick(h); }}>Pick up</Button></Allowed>
      </span>
    );
  }
  const link = r.type === 'use case' && st.tone === 'link' ? askLink(r) : null;
  if (link && r.type === 'use case') return <a href={link} onClick={(e) => e.stopPropagation()} className='text-primary block max-w-48 truncate text-xs leading-none hover:underline'>Ask {r.uc!.helper_label}</a>;
  return <span className={cn('block max-w-48 truncate text-xs leading-none', st.tone === 'busy' ? 'text-primary' : 'text-muted-foreground')}>{st.label}</span>;
}

/** Top of an open use case: the help request, if any, with what you can do about it. */
function HelpPanel({ r, me, onPick, onAct, onAsk }: {
  r: Extract<Row, { type: 'use case' }>; me: string | null; onPick: (h: Help) => void;
  onAct: (h: Help, action: 'pick' | 'done' | 'release' | 'cancel', ok: string) => void; onAsk: () => void;
}) {
  const h = r.help, mine = !!r.who && r.who.user_id === me;
  if (!h) {
    if (mine && !r.who!.finished) return (
      <div className='flex items-center justify-between gap-3 border-b pb-4 text-sm leading-none'>
        <span className='text-muted-foreground'>Stuck{r.who!.stuck ? ` at "${r.who!.stuck}"` : ''}? Ask the team.</span>
        <Allowed need='edit'><Button size='sm' variant='outline' onClick={onAsk}><Icons.help /> Ask for help</Button></Allowed>
      </div>
    );
    const offer = offerLink(r, me);
    if (offer) return (
      <div className='flex items-center justify-between gap-3 border-b pb-4 text-sm leading-none'>
        <span className='text-muted-foreground'>You finished this; {r.who!.label} is at &ldquo;{r.who!.stuck}&rdquo;.</span>
        <Button size='sm' variant='outline' render={<a href={offer} />}><Icons.send /> Offer help</Button>
      </div>
    );
    return null;
  }
  const link = helpLink(h, r.j, r.who);
  return (
    <div className='flex flex-col gap-3 border-b pb-4'>
      <div className='flex items-center justify-between gap-3 text-sm leading-none'>
        <span>
          <span className={h.status === 'open' ? 'text-amber-600 dark:text-amber-400' : 'text-primary'}>
            {h.status === 'open' ? (mine ? 'You asked the team for help' : `${h.requester_label} asked for help`) : h.helper === me ? `You are helping ${h.requester_label}` : `${h.helper_label} is helping ${mine ? 'you' : h.requester_label}`}
          </span>
          <span className='text-muted-foreground'> · <When d={h.status === 'picked' && h.picked_at ? h.picked_at : h.created_at} /></span>
        </span>
        <span className='flex shrink-0 items-center gap-1.5'>
          {h.status === 'open' && !mine && <Allowed need='edit'><Button size='sm' onClick={() => onPick(h)}><Icons.check /> Pick up and help</Button></Allowed>}
          {h.status === 'picked' && h.helper === me && link && <Button size='sm' variant='outline' render={<a href={link} />}><Icons.send /> Email</Button>}
          {h.status === 'picked' && (h.helper === me || mine) && <Allowed need='edit'><Button size='sm' variant='outline' onClick={() => onAct(h, 'done', 'Marked helped')}>Mark helped</Button></Allowed>}
          {h.status === 'open' && mine && <Allowed need='edit'><Button size='sm' variant='ghost' onClick={() => onAct(h, 'cancel', 'Help request withdrawn')}>Withdraw</Button></Allowed>}
        </span>
      </div>
      {h.note && <p className='text-muted-foreground border-l-2 pl-3 text-sm leading-relaxed whitespace-pre-wrap'>{h.note}</p>}
    </div>
  );
}

/** Ask the team: an optional note on what is in the way; teammates see it on the row and can pick it up. */
function AskDialog({ j, stuck, onClose, onSent }: { j: Journey; stuck: string | null; onClose: () => void; onSent: () => void }) {
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false);
  const send = (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    appApi('POST', '/adoption/help', { journey_id: j.id, note: note.trim() })
      .then(() => { toast.success('Asked the team. Teammates can pick it up on Adoption.'); onSent(); }).catch(fail).finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={send} className='flex flex-col gap-4'>
          <DialogHeader>
            <DialogTitle>Ask the team about {j.name}</DialogTitle>
            <DialogDescription>{stuck ? `You're at "${stuck}". ` : ''}Your teammates see the request on Adoption and one of them picks it up.</DialogDescription>
          </DialogHeader>
          <Textarea autoFocus rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder='What is in the way? (optional)' aria-label='Note' className='resize-none' />
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Button type='submit' disabled={busy}>Ask the team</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Progress({ done, total, check }: { done: number; total: number; check?: boolean }) {
  return (
    <div className='flex items-center gap-2'>
      <div className='bg-muted h-1.5 flex-1 overflow-hidden rounded-full'><div className={cn('h-full rounded-full', done ? 'bg-primary' : 'bg-muted')} style={{ width: `${Math.round((done / Math.max(1, total)) * 100)}%` }} /></div>
      <span className='text-muted-foreground w-10 text-right text-xs tabular-nums'>{check ? '✓' : `${done}/${total}`}</span>
    </div>
  );
}

function UseCase({ j, onChanged, note }: { j: Journey; onChanged: () => void; note: string | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const mark = (st: Stage) => {
    setBusy(st.id);
    appApi('POST', `/journeys/${encodeURIComponent(j.id)}/stages/${encodeURIComponent(st.id)}`, { done: !st.done })
      .then(() => { toast.success(st.done ? 'Marked not done' : 'Marked done'); onChanged(); }).catch(fail).finally(() => setBusy(null));
  };
  return (
    <div className='flex flex-col gap-5'>
      <dl>
        <Field label='Outcome'>{j.outcome}</Field>
        {j.who && <Field label='For'>{j.who}</Field>}
        {j.time && <Field label='Takes'>{j.time}</Field>}
        <Field label='Progress'><Progress done={j.done} total={j.total} /></Field>
        <Field label='Source'>{j.own ? `Your account${j.added_by ? ` · added by ${j.added_by.replace(/^customer:/, '')}` : ''}` : profile.name}</Field>
      </dl>
      <ol className='flex flex-col gap-4'>
        {j.stages.map((st, i) => (
          <li key={st.id} className='flex gap-3'>
            <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold', st.done ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground')}>
              {st.done ? <Icons.check className='size-3.5' /> : i + 1}
            </span>
            <div className='min-w-0 flex-1 space-y-1.5'>
              <p className='text-sm font-medium'>{st.title}</p>
              {st.why && <p className='text-muted-foreground text-xs'>{st.why}</p>}
              {note && st.tools.some(launchesWork) ? <p className='text-muted-foreground text-xs'>{note}</p> : (
                <div className='flex items-center gap-2'>
                  <code className='bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 text-xs' title={st.prompt}>{st.prompt}</code>
                  <CopyButton text={st.prompt} />
                </div>)}
              <p className='text-muted-foreground text-xs'>
                {st.manual ? 'Marked by hand.' : `Done when your AI client runs ${st.tools.join(' or ')}.`}{st.done && st.at && <> Done <When d={st.at} />.</>}
              </p>
              {st.manual && <Allowed need='edit'><Button size='sm' variant={st.done ? 'outline' : 'default'} disabled={busy === st.id} onClick={() => mark(st)}>{st.done ? 'Mark not done' : 'Mark done'}</Button></Allowed>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Workflow({ g, note }: { g: Setup['groups'][number]; note: string | null }) {
  return (
    <div className='flex flex-col gap-5'>
      <dl>
        <Field label='Used'>{g.used} of {g.total} tools</Field>
        <Field label='Progress'><Progress done={g.used} total={g.total} /></Field>
      </dl>
      <div className='space-y-2'>
        <p className='text-sm font-medium'>{g.used ? 'Do it again' : 'Try it'}</p>
        {note ? <p className='text-muted-foreground text-sm'>{note}</p> : (<>
          <div className='flex items-center gap-2'>
            <code className='bg-muted min-w-0 flex-1 rounded px-2 py-1.5 text-xs whitespace-pre-wrap'>{g.prompt}</code>
            <CopyButton text={g.prompt} />
          </div>
          <p className='text-muted-foreground text-xs'>Paste it into your AI client with {profile.name} connected.</p>
        </>)}
      </div>
    </div>
  );
}

function Client({ name, at }: { name: string; at: string }) {
  return (
    <dl>
      <Field label='Client'>{name}</Field>
      <Field label='Last connected'><When d={at} /></Field>
      <Field label='Add another'><Link className='text-primary underline-offset-4 hover:underline' href='/app'>Connection string on Setup & training</Link></Field>
    </dl>
  );
}

/** Add use case: a name, the outcome, and the steps, each a prompt to type; steps are marked done by hand. */
function UseCaseEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: '', outcome: '' });
  const [steps, setSteps] = useState([{ title: '', prompt: '' }]);
  const [busy, setBusy] = useState(false);
  const setStep = useCallback((i: number, k: 'title' | 'prompt', v: string) => setSteps((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: v } : x))), []);
  const ok = f.name.trim() && f.outcome.trim() && steps.some((x) => x.prompt.trim());
  const save = (e: React.FormEvent) => {
    e.preventDefault(); if (!ok) return; setBusy(true);
    appApi('POST', '/journeys', { name: f.name.trim(), outcome: f.outcome.trim(), stages: steps.filter((x) => x.prompt.trim()).map((x) => ({ title: x.title.trim(), prompt: x.prompt.trim() })) })
      .then(() => { toast.success('Use case added'); onSaved(); }).catch(fail).finally(() => setBusy(false));
  };
  return (
    <Dock title='New use case' onClose={onClose}>
      <form onSubmit={save} className='flex max-h-[70vh] flex-col gap-3 overflow-y-auto p-4'>
        <Input autoFocus maxLength={80} placeholder={journeyFacts()?.words.use_case_name_placeholder} aria-label='Name' value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Textarea rows={2} maxLength={300} placeholder='Outcome: what you know or have at the end' aria-label='Outcome' value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} className='resize-none' />
        <p className='text-muted-foreground pt-1 text-xs font-medium'>Steps</p>
        {steps.map((x, i) => (
          <div key={i} className='flex flex-col gap-1.5 border-l-2 pl-3'>
            <Input maxLength={120} placeholder={`Step ${i + 1} title (optional)`} aria-label={`Step ${i + 1} title`} value={x.title} onChange={(e) => setStep(i, 'title', e.target.value)} />
            <Textarea rows={2} maxLength={600} placeholder='The prompt to type in your AI client' aria-label={`Step ${i + 1} prompt`} value={x.prompt} onChange={(e) => setStep(i, 'prompt', e.target.value)} className='resize-none' />
          </div>
        ))}
        {steps.length < 12 && <Button type='button' variant='ghost' size='sm' className='self-start' onClick={() => setSteps((xs) => [...xs, { title: '', prompt: '' }])}><Icons.add /> Add step</Button>}
        <div className='flex items-center gap-2 border-t pt-3'>
          <Button type='submit' disabled={busy || !ok}>Add use case</Button>
          <Button type='button' variant='ghost' onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Dock>
  );
}

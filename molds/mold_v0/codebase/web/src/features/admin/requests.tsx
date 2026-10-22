'use client';
// Access requests from the landing page as a database: views by status, approve (a new account, or a person added to
// one), decline, reopen, one at a time from the ⋯ menu or in bulk. Everything is fetched once and the views filter here.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { IconCopy } from '@tabler/icons-react';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { post, useAdmin, useAdminAction, type InviteResult, type OrgList, type OrgRow } from './lib';
import { useResult } from './result-dialog';
import { ActionsMenu, Field, RecordView, type RecordCol, type RecordViewDef, type RowAction } from '@/components/layout/record-view';
import { copyText, ErrorBox, StatusBadge, When } from './ui';
import { Gate, useAdminRole } from './role';
import { hostFeature } from '@/features/packs/host-nav';

interface Req {
  id: number;
  email: string;
  company: string;
  product_url: string | null;
  message: string | null;
  created_at: string;
  decided_at: string | null;
  status: 'pending' | 'approved' | 'declined';
  org_slug: string | null;
  org_name: string | null;
  name: string | null;
  role: string | null;
  team_size: string | null;
  agents: string[] | null;
  source: Record<string, string> | null;
  docs_url: string | null;
  competitors: string | null;
  goal: string | null;
  timeline: string | null;
  heard_from: string | null;
  subindustry: string | null;
  research: Brief | null;
  research_status: 'running' | 'done' | 'failed' | null;
  research_error: string | null;
  researched_at: string | null;
  /** The deep pass on the research harness (latest job), if any. */
  deep: { id: string; status: 'queued' | 'running' | 'completed' | 'failed'; stage: string | null; note: string | null; error: string | null; created_at: string; finished_at: string | null } | null;
}
/** The AI's background research on the company (src/prospect.ts). */
interface Brief {
  summary: string; offering: string; category: string; developer_tool: boolean | null; fit: 'strong' | 'possible' | 'weak' | 'unknown'; fit_reason: string;
  audience: string; stage: string; competitors: { name: string; url?: string }[]; packages: string[]; starter_tasks: string[]; questions: string[]; flags: string[];
  site: { url: string; title: string; description: string } | null; sources: { url: string; title: string }[]; model: string | null; depth?: 'harness';
}
/** A confirmation; with `reason`, a box for the optional reason that goes in the email to the requester. */
interface Confirm { title: string; body: ReactNode; label: string; reason?: boolean; run: (reason: string) => void }

const PERSONAL = /gmail|outlook|hotmail|yahoo|proton|icloud/;
const domainOf = (email: string) => (email.split('@')[1] || '').toLowerCase();
const isWork = (q: Req) => !PERSONAL.test(domainOf(q.email));
/** An existing account whose contact shares the requester's work domain (personal mail never matches). */
export function matchOrg(req: Req, orgs: readonly OrgRow[] | undefined): OrgRow | null {
  const d = domainOf(req.email);
  if (!orgs || !d || !isWork(req)) return null;
  return orgs.find((o) => domainOf(o.contact || '') === d) ?? null;
}
const link = (q: Req) => (q.product_url ? (/^https?:\/\//.test(q.product_url) ? q.product_url : `https://${q.product_url}`) : null);
const host = (q: Req) => { const u = link(q); try { return u ? new URL(u).host.replace(/^www\./, '') : null; } catch { return q.product_url; } };
const FIT = { strong: 'text-primary font-medium', possible: 'text-foreground', weak: 'text-muted-foreground', unknown: 'text-muted-foreground' } as const;
const TONE = { pending: 'info', approved: 'ok', declined: 'neutral' } as const;
// Days a request waited: still waiting when pending, else until it was decided.
const waited = (q: Req) => {
  const end = q.status === 'pending' ? Date.now() : q.decided_at ? Date.parse(q.decided_at) : NaN;
  const d = Math.floor((end - Date.parse(q.created_at)) / 864e5);
  return Number.isFinite(d) ? Math.max(0, d) : null;
};
const emails = (list: readonly Req[]) => [...new Set(list.map((q) => q.email))].join(', ');
const plural = (n: number) => `${n} request${n === 1 ? '' : 's'}`;
const muted = (s: ReactNode) => <span className='text-muted-foreground block truncate text-sm leading-none'>{s}</span>;

// The first view is the one shown (no view tabs): every request, grouped by status, newest first.
const VIEWS: RecordViewDef<Req>[] = [
  { id: 'all', label: 'All', group: 'status', sort: [{ key: 'created_at', dir: 'desc' }] },
  { id: 'pending', label: 'Pending', match: (q) => q.status === 'pending', sort: [{ key: 'created_at', dir: 'asc' }] },
  { id: 'waiting', label: 'Waiting > 2 days', match: (q) => q.status === 'pending' && (waited(q) ?? 0) > 2, sort: [{ key: 'created_at', dir: 'asc' }] },
  { id: 'approved', label: 'Approved', match: (q) => q.status === 'approved', sort: [{ key: 'decided_at', dir: 'desc' }] },
  { id: 'declined', label: 'Declined', match: (q) => q.status === 'declined', sort: [{ key: 'decided_at', dir: 'desc' }] },
];

export function AdminRequests() {
  const { lock } = useAdminRole();
  const [polling, setPolling] = useState(false);
  const { data, error, isLoading } = useAdmin<{ requests: Req[] }>('/requests', { refetchInterval: polling ? 5000 : undefined });
  const running = (data?.requests ?? []).some((q) => q.research_status === 'running' || q.deep?.status === 'running' || q.deep?.status === 'queued');
  useEffect(() => setPolling(running), [running]);
  // Deep research on the harness takes minutes: poll gently while a job is queued or running.
  const { data: orgList } = useAdmin<OrgList>('/orgs');
  const [approving, setApproving] = useState<Req | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const result = useResult();
  const qc = useQueryClient();
  const decline = useAdminAction((v: { q: Req; reason: string }) => post(`/requests/${v.q.id}/decline`, { reason: v.reason || undefined }), { success: 'Declined; they get a short email' });
  const [reason, setReason] = useState('');
  const reopen = useAdminAction((q: Req) => post(`/requests/${q.id}/reopen`), { success: 'Back in pending' });
  const rows = useMemo(() => data?.requests ?? [], [data]);
  // With a finished deep brief, a re-run only queues a fresh deep job and the current brief stays up meanwhile.
  const runResearch = (q: Req) => {
    const deepOnly = q.research?.depth === 'harness';
    toast.info(deepOnly ? `Queuing deep research for ${q.company}…` : `Researching ${q.company}…`);
    if (!deepOnly) void qc.setQueryData<{ requests: Req[] }>(['admin', '/requests'], (d) => d && { requests: d.requests.map((x) => (x.id === q.id ? { ...x, research_status: 'running' } : x)) });
    post(`/requests/${q.id}/research`)
      .then(() => toast.success(deepOnly ? `Deep research queued for ${q.company}; the current brief stays until it is done` : `Quick research ready for ${q.company}; deep research is queued on the research harness`))
      .catch((e) => toast.error((e as Error).message))
      .finally(() => void qc.invalidateQueries({ queryKey: ['admin', '/requests'] }));
  };
  const researchBusy = (q: Req) => q.research_status === 'running' || q.deep?.status === 'queued' || q.deep?.status === 'running';
  const matches = useMemo(() => new Map(rows.map((q) => [q.id, matchOrg(q, orgList?.orgs)?.name ?? null])), [rows, orgList]);

  const askDecline = (q: Req) => setConfirm({
    title: `Decline ${q.company}?`, body: 'They get a short, kind email saying so, with your reason if you give one. You can reopen it later.', label: 'Decline', reason: true,
    run: (why) => decline.mutate({ q, reason: why })
  });
  // Bulk writes go one at a time so a failure is counted, not fatal; one toast and one refetch at the end.
  const runEach = async (list: Req[], verb: 'decline' | 'reopen', clear: () => void, why = '') => {
    let failed = 0;
    for (const q of list) { try { await post(`/requests/${q.id}/${verb}`, verb === 'decline' && why ? { reason: why } : undefined); } catch { failed++; } }
    const ok = list.length - failed, past = verb === 'decline' ? 'Declined' : 'Reopened';
    if (failed) toast.error(`${past} ${ok} of ${plural(list.length)}; ${failed} failed`); else toast.success(`${past} ${plural(ok)}`);
    clear();
    void qc.invalidateQueries({ queryKey: ['admin'] });
  };
  // RecordView keeps the open tab in localStorage under its id; read it back so the menu copies that tab's emails.
  const currentView = () => { try { return VIEWS.find((v) => v.id === JSON.parse(localStorage.getItem('rv:admin-requests:view') ?? 'null')) ?? VIEWS[0]; } catch { return VIEWS[0]; } };

  const copyEmail = (q: Req): RowAction => ({ label: 'Copy email', icon: <IconCopy />, onSelect: () => copyText(q.email, 'Email copied') });
  const statusActions = (q: Req): RowAction[] => [
    ...(q.status === 'pending' ? [{ label: 'Decline', icon: <Icons.close />, destructive: true, onSelect: () => askDecline(q) }] : []),
    ...(q.status === 'declined' ? [{ label: 'Reopen', icon: <Icons.arrowRight />, onSelect: () => reopen.mutate(q) }] : [])
  ].map((a) => lock(a, 'requests'));
  const actions = (q: Req): RowAction[] => {
    const url = link(q);
    return [
      ...(q.status === 'pending' ? [lock({ label: 'Approve…', icon: <Icons.check />, onSelect: () => setApproving(q) }, 'requests')] : []),
      ...statusActions(q),
      // A requester's company research is a host pack's (mold_v0-039: the product's /requests/:id/research).
      ...(hostFeature('research') ? [lock({ label: q.research ? 'Re-run research' : 'Research the company', icon: <Icons.sparkles />, disabled: researchBusy(q), separator: true, onSelect: () => runResearch(q) }, 'requests')] : []),
      copyEmail(q),
      ...(url ? [{ label: 'Open product site', icon: <Icons.externalLink />, onSelect: () => window.open(url, '_blank', 'noopener,noreferrer') }] : [])
    ];
  };
  const bulk = (sel: Req[], clear: () => void): RowAction[] => {
    const pending = sel.filter((q) => q.status === 'pending'), declined = sel.filter((q) => q.status === 'declined');
    return [
      ...[{ label: `Decline ${pending.length} pending`, icon: <Icons.close />, destructive: true, disabled: !pending.length, onSelect: () => setConfirm({
        title: `Decline ${plural(pending.length)}?`, body: 'Each gets a short, kind email saying so, with your reason if you give one. You can reopen them later.', label: 'Decline', reason: true,
        run: (why) => void runEach(pending, 'decline', clear, why)
      }) },
      { label: `Reopen ${declined.length} declined`, icon: <Icons.arrowRight />, disabled: !declined.length, onSelect: () => setConfirm({
        title: `Reopen ${plural(declined.length)}?`, body: 'They go back to pending.', label: 'Reopen', run: () => void runEach(declined, 'reopen', clear)
      }) },
      ...(hostFeature('research') ? [{ label: `Research ${sel.length} compan${sel.length === 1 ? 'y' : 'ies'}`, icon: <Icons.sparkles />, onSelect: () => { sel.forEach(runResearch); clear(); } }] : [])].map((a) => lock(a, 'requests')),
      { label: 'Copy emails', icon: <IconCopy />, onSelect: () => copyText(emails(sel), `${sel.length} emails copied`) }
    ];
  };

  const cols: RecordCol<Req>[] = [
    { key: 'company', label: 'Company', type: 'text', title: true, keep: true, peek: false, value: (q) => q.company, render: (q) => (<>
      <p className='truncate font-medium leading-none'>{q.company}</p>
      {host(q) && <p className='text-muted-foreground mt-1.5 truncate text-xs leading-none'>{host(q)}</p>}
    </>) },
    { key: 'status', label: 'Status', type: 'select', className: 'w-28', keep: true, value: (q) => q.status,
      options: [{ value: 'pending', label: 'Pending' }, { value: 'approved', label: 'Approved' }, { value: 'declined', label: 'Declined' }],
      render: (q) => <StatusBadge tone={TONE[q.status]}>{q.status}</StatusBadge> },
    { key: 'person', label: 'Person', type: 'text', className: 'w-56', value: (q) => `${q.name ?? ''} ${q.email}`, render: (q) => (<>
      <p className='truncate text-sm leading-none'>{q.name || q.email}</p>
      {(q.name || q.role || !isWork(q)) && <p className='text-muted-foreground mt-1.5 truncate text-xs leading-none'>{[q.role, q.name ? q.email : null, isWork(q) ? null : 'personal'].filter(Boolean).join(' · ')}</p>}
    </>) },
    { key: 'fit', label: 'Fit', type: 'select', className: 'w-28', value: (q) => q.research?.fit ?? (q.research_status === 'running' ? 'researching' : 'not researched'),
      render: (q) => q.research_status === 'running' ? muted('Researching…') : q.research ? <span className={cn('text-sm leading-none', FIT[q.research.fit])}>{q.research.fit}</span> : muted('—') },
    { key: 'work', label: 'Work email', type: 'boolean', hidden: true, value: isWork, render: (q) => muted(isWork(q) ? 'Yes' : 'No') },
    { key: 'account', label: 'Account', type: 'text', hidden: true, value: (q) => q.org_name ?? matches.get(q.id), render: (q) => (q.org_name ? <span className='block truncate text-sm leading-none'>{q.org_name}</span> : muted(matches.get(q.id) ? `matches ${matches.get(q.id)}?` : '—')) },
    { key: 'created_at', label: 'Requested', type: 'date', className: 'w-28', keep: true, value: (q) => q.created_at, render: (q) => { const d = waited(q); return (<>
      <When d={q.created_at} className='text-muted-foreground block text-xs leading-none' />
      {d != null && <p className='text-muted-foreground mt-1.5 truncate text-xs leading-none'>{q.status === 'pending' ? `waiting ${d}d` : `decided ${d}d later`}</p>}
    </>); } },
    { key: 'decided_at', label: 'Decided', type: 'date', className: 'w-28', hidden: true, value: (q) => q.decided_at, render: (q) => <When d={q.decided_at} className='text-muted-foreground text-xs leading-none' /> }
  ];

  return (
    <PageContainer>
      <ErrorBox error={error} />
      <RecordView<Req>
        id='admin-requests-v3' noun='requests' exportName='access-requests' views={VIEWS} defaultSort={[{ key: 'created_at', dir: 'desc' }]}
        rows={rows} rowKey={(q) => String(q.id)} cols={cols} actions={actions} bulk={bulk} loading={isLoading || !data}
        searchText={(q) => `${q.company} ${q.email} ${q.name ?? ''} ${q.role ?? ''} ${q.competitors ?? ''} ${q.product_url ?? ''} ${q.message ?? ''} ${q.status} ${q.org_name ?? ''} ${q.research?.category ?? ''} ${q.research?.fit ?? ''}`}
        searchPlaceholder='Search access requests'
        primaryMenu={[{ label: 'Copy emails (current view)', icon: <IconCopy />, onSelect: () => {
          const v = currentView(), list = v.match ? rows.filter(v.match) : rows;
          if (list.length) copyText(emails(list), `${list.length} emails copied`); else toast.info('No requests in this view');
        } }]}
        empty='No pending requests.'
        detailActions={(q) => (<>
          {q.status === 'pending' && <Gate need='requests'><Button size='sm' onClick={() => setApproving(q)}><Icons.check /> Approve</Button></Gate>}
          <ActionsMenu items={[...statusActions(q), copyEmail(q)]} />
        </>)}
        detail={(q) => <RequestPeek q={q} match={matches.get(q.id) ?? null} onResearch={() => runResearch(q)} />}
      />
      {approving && (
        <ApproveDialog
          req={approving}
          onClose={() => setApproving(null)}
          onDone={(r) => {
            setApproving(null);
            result.show(r, `Approved: ${r.org.name}`);
          }}
        />
      )}
      <AlertDialog open={!!confirm} onOpenChange={(o) => { if (!o) { setConfirm(null); setReason(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          {confirm?.reason && (
            <div className='grid gap-2'>
              <Label htmlFor='decline-reason'>Reason (optional)</Label>
              <Textarea id='decline-reason' rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder='For example: we only support developer tools for now.' />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={confirm?.label === 'Decline' ? 'destructive' : 'default'} onClick={() => { confirm?.run(reason.trim()); setConfirm(null); setReason(''); }}>
              {confirm?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {result.dialog}
    </PageContainer>
  );
}

function ApproveDialog({ req, onClose, onDone }: { req: Req; onClose: () => void; onDone: (r: InviteResult) => void }) {
  const { data } = useAdmin<OrgList>('/orgs');
  const domain = domainOf(req.email);
  const match = useMemo(() => matchOrg(req, data?.orgs), [data, req]);
  const [mode, setMode] = useState<'new' | 'existing' | null>(null);
  const [org, setOrg] = useState<string | null>(null);
  const [name, setName] = useState(req.company);
  const [slug, setSlug] = useState('');
  const [err, setErr] = useState('');
  const m = mode ?? (match ? 'existing' : 'new');
  const chosen = org ?? match?.slug ?? data?.orgs[0]?.slug ?? '';
  const approve = useAdminAction(
    () => post<InviteResult>(`/requests/${req.id}/approve`, m === 'existing' ? { org_slug: chosen } : { name: name.trim(), slug: slug.trim() || undefined }),
    {}
  );
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    approve.mutate(undefined, { onSuccess: onDone, onError: (x) => setErr(x.message) });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-lg'>
        <form onSubmit={submit} className='grid min-w-0 gap-4 [&>*]:min-w-0'>
          <DialogHeader>
            <DialogTitle>Approve request</DialogTitle>
            <DialogDescription className='break-words'>
              {req.company} · {req.email}
            </DialogDescription>
          </DialogHeader>
          <div role='radiogroup' aria-label='Approve into' className='grid gap-1.5'>
            {([['new', 'A new account', 'They become its admin.'], ['existing', 'An existing account', 'They join as a member.']] as const).map(([v, label, hint]) => (
              <label key={v} className={cn('flex min-w-0 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2.5 text-sm leading-none', m === v ? 'border-primary bg-primary/10' : 'hover:bg-muted')}>
                <input type='radio' name='ap-mode' value={v} checked={m === v} onChange={() => setMode(v)} className='accent-[var(--primary)]' />
                <span className='font-medium'>{label}</span>
                <span className='text-muted-foreground text-xs'>{hint}</span>
              </label>
            ))}
          </div>
          {m === 'new' ? (
            <div className='grid gap-3'>
              <div className='grid gap-1.5'>
                <Label htmlFor='ap-name'>Account name</Label>
                <Input id='ap-name' required value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor='ap-slug'>Slug (optional)</Label>
                <Input id='ap-slug' placeholder='from the name' value={slug} onChange={(e) => setSlug(e.target.value)} />
              </div>
              <p className='text-muted-foreground text-xs'>Clerk invites the requester as the account&apos;s admin.</p>
            </div>
          ) : (
            <div className='grid gap-1.5'>
              <Label htmlFor='ap-org'>Account</Label>
              {/* Names only: a long internal slug in the option text made the select (and the dialog) as wide as the slug. */}
              <NativeSelect id='ap-org' className='w-full min-w-0 max-w-full' value={chosen} onChange={(e) => setOrg(e.target.value)}>
                {(data?.orgs ?? []).map((o) => (
                  <NativeSelectOption key={o.slug} value={o.slug} title={o.slug}>
                    {o.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <p className='text-muted-foreground text-xs'>Clerk invites them as a member of that account.</p>
            </div>
          )}
          {match && (
            <p className='text-muted-foreground text-xs'>
              {match.name} already has someone from @{domain}.
            </p>
          )}
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>
              Cancel
            </Button>
            <Button type='submit' disabled={approve.isPending}>
              {approve.isPending ? 'Approving…' : 'Approve and invite'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- the open request ----------

const GOAL_LABEL: Record<string, string> = { baseline: 'Their APO baseline', competitor: 'Why agents pick a competitor', docs: 'Fixing docs and SDKs for agents', monitor: 'Tracking every release', other: 'Something else' };
const TIMELINE_LABEL: Record<string, string> = { now: 'this week', month: 'this month', quarter: 'this quarter', exploring: 'just exploring' };

const Label2 = ({ children }: { children: ReactNode }) => <div className='text-muted-foreground mb-2 text-xs font-medium leading-none'>{children}</div>;
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

/** What they told us, where they came from, then the AI's research on the company. */
function RequestPeek({ q, match, onResearch }: { q: Req; match: string | null; onResearch: () => void }) {
  const src = q.source ?? {};
  const came = [src.utm_source && `${src.utm_source}${src.utm_medium ? ` / ${src.utm_medium}` : ''}${src.utm_campaign ? ` · ${src.utm_campaign}` : ''}`,
    src.referrer && `via ${hostOf(src.referrer)}`, src.landing && `landed on ${src.landing}`, [src.city, src.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  const url = link(q);
  return (
    <div className='flex flex-col gap-8 text-sm'>
      <section>
        <Label2>From them</Label2>
        <dl>
          <Field label='Person'>{q.name || '—'}{q.role && <span className='text-muted-foreground'> · {q.role}</span>}</Field>
          <Field label='Email'><a className='hover:underline' href={`mailto:${q.email}`}>{q.email}</a>{!isWork(q) && <span className='text-amber-600 dark:text-amber-400'> · personal</span>}</Field>
          <Field label='Company'>{q.company}{q.team_size && <span className='text-muted-foreground'> · {q.team_size} people</span>}</Field>
          <Field label='Product'>{url ? <a className='text-primary hover:underline' href={url} target='_blank' rel='noopener noreferrer'>{host(q)}</a> : <span className='text-muted-foreground'>Not given</span>}</Field>
          {q.docs_url && <Field label='Docs'><a className='text-primary hover:underline' href={q.docs_url} target='_blank' rel='noopener noreferrer'>{hostOf(q.docs_url)}</a></Field>}
          {q.subindustry && <Field label='Sub-industry'>{q.subindustry}</Field>}
          {q.competitors && <Field label='Competitors'>{q.competitors}</Field>}
          {q.goal && <Field label='Wants first'>{GOAL_LABEL[q.goal] ?? q.goal}{q.timeline && <span className='text-muted-foreground'> · {TIMELINE_LABEL[q.timeline] ?? q.timeline}</span>}</Field>}
          <Field label='Agents'>{q.agents?.length ? q.agents.join(', ') : <span className='text-muted-foreground'>Not given</span>}</Field>
          {q.heard_from && <Field label='Heard from'>{q.heard_from}</Field>}
          <Field label='Came from'>{came || <span className='text-muted-foreground'>Unknown</span>}</Field>
          <Field label='Requested'><When d={q.created_at} />{q.status !== 'pending' && q.decided_at && <span className='text-muted-foreground'> · {q.status} <When d={q.decided_at} /></span>}</Field>
          {match && <Field label='Matches'>Same domain as {match}</Field>}
        </dl>
        <div className='mt-4'>
          <div className='text-muted-foreground mb-1.5 text-xs font-medium leading-none'>Message</div>
          {q.message ? <p className='leading-relaxed whitespace-pre-wrap'>{q.message}</p> : <p className='text-muted-foreground leading-none'>No message.</p>}
        </div>
      </section>

      {hostFeature('research') && <section>
        <div className='mb-2 flex items-center justify-between gap-3'>
          <span className='text-muted-foreground text-xs font-medium leading-none'>AI research</span>
          <Gate need='requests'><Button size='xs' variant='ghost' disabled={q.research_status === 'running' || q.deep?.status === 'queued' || q.deep?.status === 'running'} onClick={onResearch}>
            {q.research_status === 'running' ? <><Icons.spinner className='animate-spin' /> Researching</> : <><Icons.sparkles /> {q.research ? 'Re-run' : 'Research'}</>}
          </Button></Gate>
        </div>
        {q.research_status === 'failed' && <p className='text-destructive mb-3 leading-snug'>Research failed: {q.research_error}</p>}
        <DeepStatus q={q} />
        {!q.research ? (
          q.research_status !== 'running' && <p className='text-muted-foreground leading-none'>Not researched yet.</p>
        ) : <Research b={q.research} at={q.researched_at} />}
      </section>}
    </div>
  );
}

function Research({ b, at }: { b: Brief; at: string | null }) {
  const list = (title: string, xs: ReactNode[]) => xs.length > 0 && (
    <div>
      <Label2>{title}</Label2>
      <ul className='flex flex-col gap-2'>{xs.map((x, i) => <li key={i} className='border-l-2 pl-3 leading-snug'>{x}</li>)}</ul>
    </div>
  );
  return (
    <div className='flex flex-col gap-6'>
      {b.summary && <p className='leading-relaxed'>{b.summary}</p>}
      <dl>
        <Field label='Fit'><span className={FIT[b.fit]}>{b.fit}</span>{b.fit_reason && <span className='text-muted-foreground'> · {b.fit_reason}</span>}</Field>
        {b.offering && <Field label='Sells'>{b.offering}</Field>}
        {b.category && <Field label='Category'>{b.category}</Field>}
        {b.audience && <Field label='Audience'>{b.audience}</Field>}
        {b.stage && <Field label='Stage'>{b.stage}</Field>}
        {b.packages.length > 0 && <Field label='Packages'><span className='font-mono text-xs'>{b.packages.join(', ')}</span></Field>}
        {b.competitors.length > 0 && <Field label='Competitors'>{b.competitors.map((c, i) => (
          <span key={c.name}>{i > 0 && ', '}{c.url ? <a className='hover:underline' href={c.url} target='_blank' rel='noopener noreferrer'>{c.name}</a> : c.name}</span>
        ))}</Field>}
      </dl>
      {b.flags.length > 0 && (
        <ul className='flex flex-col gap-1.5'>{b.flags.map((f, i) => (
          <li key={i} className='flex items-center gap-2 leading-none text-amber-600 dark:text-amber-400'><Icons.warning className='size-3.5 shrink-0' />{f}</li>
        ))}</ul>
      )}
      {list('Starter tasks', b.starter_tasks)}
      {list('Ask on the call', b.questions)}
      {b.sources.length > 0 && (
        <div>
          <Label2>Sources</Label2>
          <ul className='flex flex-col gap-1.5 text-xs'>{b.sources.map((x) => (
            <li key={x.url} className='truncate leading-none'><a className='text-muted-foreground hover:text-foreground hover:underline' href={x.url} target='_blank' rel='noopener noreferrer'>{x.title || hostOf(x.url)} <span className='opacity-60'>· {hostOf(x.url)}</span></a></li>
          ))}</ul>
        </div>
      )}
      <p className='text-muted-foreground text-xs leading-none'>Researched <When d={at} />{b.depth === 'harness' ? ` · deep research on the harness (${b.model})` : b.model ? ` · quick pass · ${b.model}` : ' · quick pass, no AI summary, evidence only'}</p>
    </div>
  );
}

/** Where the deep pass on the research harness stands: queued, running (its stage), failed, or done. */
function DeepStatus({ q }: { q: Req }) {
  const d = q.deep;
  if (!d) return null;
  const line = d.status === 'queued' ? 'Deep research queued on the research harness'
    : d.status === 'running' ? `Deep research running on the harness${d.stage ? ` · ${d.stage}` : ''}${d.note ? ` · ${d.note}` : ''}`
    : d.status === 'failed' ? `Deep research failed: ${d.error ?? 'unknown error'}`
    : null;
  if (!line) return null;
  return (
    <p className={cn('mb-4 flex items-center gap-2 leading-snug', d.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
      {d.status !== 'failed' && <Icons.spinner className='size-3.5 shrink-0 animate-spin' />}{line}
    </p>
  );
}

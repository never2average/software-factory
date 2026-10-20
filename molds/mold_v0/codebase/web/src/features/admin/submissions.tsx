'use client';
// Submissions on /admin/personas and /admin/tasks: personas and tasks accounts published to Octillion's library
// (src/contributions.ts). The page's view dropdown switches between the shared library and these. Accept copies the
// submitted content into the library as a new row (source contributed) and credits the account in Stripe; Decline needs
// a reason, which the account sees. Writes need the `library` permission.
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import PageContainer from '@/components/layout/page-container';
import { ActionsMenu, Field, RecordView, type RecordCol, type RowAction } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { companySize, usd } from '@/lib/octillion-format';
import { post, useAdmin, useAdminAction } from './lib';
import { Gate, useAdminRole } from './role';
import { Chips, ErrorBox, FormRow, Mono, StatusBadge, When, type Tone } from './ui';

export type SubmissionKind = 'persona' | 'task';
type Status = 'submitted' | 'accepted' | 'declined' | 'withdrawn';
export interface Submission {
  id: string; org_id: number; org_name: string; org_slug: string; kind: SubmissionKind; source_ref: string; title: string; status: Status;
  decided_by: string | null; decided_at: string | null; reason: string | null; library_ref: string | null; credit_usd: number | null;
  credit_status: 'none' | 'pending' | 'credited' | null; credit_error: string | null; stripe_txn_id: string | null; created_by: string | null; created_at: string;
  has_stripe_customer: boolean; content: Record<string, any>;
}
interface Data { kind: SubmissionKind; submissions: Submission[]; default_credit_usd: number; counts: Partial<Record<Status, number>>; stripe: boolean }

const NA = <span className='text-muted-foreground'>—</span>;
const META = 'text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-none';
const PROMPT = 'block font-mono text-xs leading-relaxed whitespace-pre-wrap border-l-2 pl-3';
const Dot = () => <span className='text-muted-foreground/60'>·</span>;
const Label = ({ children }: { children: ReactNode }) => <div className='text-muted-foreground mb-2 text-xs font-medium leading-none'>{children}</div>;
const STATUS: Record<Status, { label: string; tone: Tone }> = {
  submitted: { label: 'Waiting for review', tone: 'info' }, accepted: { label: 'Accepted', tone: 'ok' },
  declined: { label: 'Declined', tone: 'bad' }, withdrawn: { label: 'Withdrawn', tone: 'neutral' }
};
const creditWord = (s: Submission) => (s.status !== 'accepted' ? '—' : s.credit_status === 'credited' ? 'Credited' : s.credit_status === 'pending' ? 'Pending' : 'No credit');
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

/** The page's view: the shared library or the accounts' submissions (with how many wait for review). */
export function LibraryViewSwitch({ kind, value, onChange }: { kind: SubmissionKind; value: 'library' | 'submissions'; onChange: (v: 'library' | 'submissions') => void }) {
  const { data } = useAdmin<Data>(`/submissions?kind=${kind}`);
  const open = data?.counts.submitted ?? 0;
  return (
    <NativeSelect aria-label='View' value={value} onChange={(e) => onChange(e.target.value as 'library' | 'submissions')}>
      <NativeSelectOption value='library'>Shared library</NativeSelectOption>
      <NativeSelectOption value='submissions'>Submissions</NativeSelectOption>
    </NativeSelect>
  );
}

/** ?view=submissions opens the Submissions view directly. */
export function useLibraryView() {
  const [view, setView] = useState<'library' | 'submissions'>('library');
  useEffect(() => { if (new URLSearchParams(window.location.search).get('view') === 'submissions') setView('submissions'); }, []);
  return [view, setView] as const;
}

export function Submissions({ kind, switcher }: { kind: SubmissionKind; switcher: ReactNode }) {
  const { lock } = useAdminRole();
  const { data, error, isLoading } = useAdmin<Data>(`/submissions?kind=${kind}`);
  const [status, setStatus] = useState<Status | ''>('submitted');
  const [accepting, setAccepting] = useState<Submission | null>(null);
  const [declining, setDeclining] = useState<Submission | null>(null);
  const retry = useAdminAction((id: string) => post<Submission>(`/submissions/${encodeURIComponent(id)}/retry-credit`),
    { success: (r) => (r.credit_status === 'credited' ? 'Credit made in Stripe' : `Still pending: ${r.credit_error ?? 'Stripe did not answer'}`) });
  const all = data?.submissions ?? [];
  const rows = all.filter((s) => !status || s.status === status);
  const noun = kind === 'persona' ? 'persona' : 'task';

  const cols: RecordCol<Submission>[] = [
    { key: 'title', label: kind === 'persona' ? 'Persona' : 'Task', className: 'min-w-64', title: true, keep: true, peek: false, type: 'text', value: (s) => s.title, render: (s) => (
      <span className='flex min-w-0 flex-col gap-1.5'>
        <span className='truncate leading-none font-medium' title={s.title}>{s.title}</span>
        <span className='text-muted-foreground line-clamp-1 text-xs leading-snug'>{kind === 'persona' ? s.content.summary : s.content.prompt}</span>
      </span>
    ) },
    { key: 'account', label: 'Account', className: 'w-44', type: 'select', value: (s) => s.org_name, render: (s) => s.org_name },
    { key: 'status', label: 'Status', className: 'w-40', keep: true, type: 'select', value: (s) => STATUS[s.status].label,
      options: Object.values(STATUS).map((x) => ({ value: x.label })), render: (s) => (
        <span className='flex min-w-0 flex-col items-start gap-1.5'>
          <StatusBadge tone={STATUS[s.status].tone} title={s.reason ?? undefined}>{STATUS[s.status].label}</StatusBadge>
          {s.status === 'accepted' ? (
            <span className='text-muted-foreground truncate text-xs leading-none' title={s.credit_status === 'pending' ? s.credit_error ?? undefined : undefined}>
              <span className='tabular-nums'>{usd(s.credit_usd ?? 0)}</span> · {s.credit_status === 'credited' ? 'credited' : s.credit_status === 'pending' ? 'pending' : 'no credit'}
            </span>
          ) : s.decided_at && <span className='text-muted-foreground truncate text-xs leading-none'>decided <When d={s.decided_at} /></span>}
        </span>
      ) },
    { key: 'credit', label: 'Credit', className: 'w-36', hidden: true, type: 'select', value: creditWord, options: [{ value: 'Credited' }, { value: 'Pending' }, { value: 'No credit' }, { value: '—' }],
      render: (s) => (s.status !== 'accepted' ? NA : (
        <span className='flex items-center gap-2'>
          <span className='tabular-nums'>{usd(s.credit_usd ?? 0)}</span>
          {s.credit_status === 'pending' ? <StatusBadge tone='warn' title={s.credit_error ?? undefined}>pending</StatusBadge>
            : s.credit_status === 'credited' ? <StatusBadge tone='ok'>credited</StatusBadge> : null}
        </span>
      )) },
    { key: 'created_at', label: 'Submitted', className: 'w-28', type: 'date', value: (s) => s.created_at, render: (s) => <When d={s.created_at} className='text-muted-foreground text-xs' /> },
    { key: 'decided_at', label: 'Decided', className: 'w-28', hidden: true, type: 'date', value: (s) => s.decided_at, render: (s) => (s.decided_at ? <When d={s.decided_at} className='text-muted-foreground text-xs' /> : NA) }
  ];

  const actions = (s: Submission): RowAction[] => [
    ...(s.status === 'submitted' ? [
      { label: 'Accept…', icon: <Icons.check />, onSelect: () => setAccepting(s) },
      { label: 'Decline…', icon: <Icons.xCircle />, destructive: true, onSelect: () => setDeclining(s) }
    ] : []),
    ...(s.status === 'accepted' && s.credit_status === 'pending' ? [{ label: 'Retry credit', icon: <Icons.refresh />, onSelect: () => retry.mutate(s.id) }] : [])
  ].map((a) => lock(a, 'library'));

  const filters = (<>
    {switcher}
    <NativeSelect aria-label='Status' value={status} onChange={(e) => setStatus(e.target.value as Status | '')}>
      <NativeSelectOption value='submitted'>Waiting for review ({data?.counts.submitted ?? 0})</NativeSelectOption>
      <NativeSelectOption value='accepted'>Accepted ({data?.counts.accepted ?? 0})</NativeSelectOption>
      <NativeSelectOption value='declined'>Declined ({data?.counts.declined ?? 0})</NativeSelectOption>
      <NativeSelectOption value='withdrawn'>Withdrawn ({data?.counts.withdrawn ?? 0})</NativeSelectOption>
      <NativeSelectOption value=''>Every status ({all.length})</NativeSelectOption>
    </NativeSelect>
  </>);

  return (
    <PageContainer>
      <ErrorBox error={error} />
      <RecordView<Submission>
        id={`admin-submissions-${kind}`} noun='submissions' exportName={`${kind}-submissions`}
        rows={rows} rowKey={(s) => s.id} cols={cols} actions={actions} loading={isLoading}
        defaultSort={[{ key: 'created_at', dir: 'desc' }]}
        searchText={(s) => `${s.title} ${s.org_name} ${s.org_slug} ${s.id} ${kind === 'persona' ? `${s.content.summary ?? ''} ${s.content.instructions ?? ''}` : s.content.prompt ?? ''}`}
        searchPlaceholder={`Search submitted ${noun}s by title, content or account`}
        filters={filters}
        empty={status === 'submitted' ? `No ${noun}s waiting for review. Accounts publish their own from their ${kind === 'persona' ? 'Developer personas' : 'Programming tasks'} page or with publish_to_library.` : 'Nothing here.'}
        detailTitle={(s) => s.title}
        detailActions={(s) => (<>
          {s.status === 'submitted' && <Gate need='library'><Button size='sm' onClick={() => setAccepting(s)}><Icons.check /> Accept</Button></Gate>}
          {s.status === 'accepted' && s.credit_status === 'pending' && <Gate need='library'><Button size='sm' variant='outline' disabled={retry.isPending} onClick={() => retry.mutate(s.id)}><Icons.refresh /> Retry credit</Button></Gate>}
          <ActionsMenu items={actions(s).filter((a) => !a.label.startsWith('Accept') && a.label !== 'Retry credit')} />
        </>)}
        detail={(s) => <SubmissionBody s={s} />}
      />
      {accepting && <AcceptDialog s={accepting} defaultCredit={data?.default_credit_usd ?? 0} stripe={!!data?.stripe} onClose={() => setAccepting(null)} />}
      {declining && <DeclineDialog s={declining} onClose={() => setDeclining(null)} />}
    </PageContainer>
  );
}

/** The peek: who sent it and where it stands, then the full submitted content. */
function SubmissionBody({ s }: { s: Submission }) {
  const c = s.content ?? {};
  const a = (c.attributes ?? {}) as Record<string, unknown>;
  return (
    <div className='flex flex-col gap-8'>
      <div className={META}>
        <StatusBadge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</StatusBadge><Dot />
        <span>Submitted <When d={s.created_at} />{s.created_by && ` by ${s.created_by.replace(/^(customer|ai):/, '')}`}</span><Dot />
        <Mono>{s.id}</Mono>
      </div>
      <dl>
        <Field label='Account'><Link href={`/admin/accounts/${encodeURIComponent(s.org_slug)}`} className='hover:text-primary'>{s.org_name}</Link> <Mono>{s.org_slug}</Mono></Field>
        <Field label={s.kind === 'persona' ? 'Their persona' : 'Their task'}><Mono>{s.kind === 'persona' ? s.source_ref : `#${s.source_ref}`}</Mono></Field>
        {s.decided_at && <Field label={s.status === 'declined' ? 'Declined' : 'Accepted'}><span><When d={s.decided_at} />{s.decided_by && ` by ${s.decided_by}`}</span></Field>}
        {s.status === 'declined' && <Field label='Reason'>{s.reason}</Field>}
        {s.library_ref && <Field label='Library row'><Mono>{s.kind === 'persona' ? s.library_ref : `#${s.library_ref}`}</Mono></Field>}
        {s.status === 'accepted' && (
          <Field label='Credit'>
            <span className='flex flex-col gap-1'>
              <span>{usd(s.credit_usd ?? 0)} · {s.credit_status === 'credited' ? 'credited in Stripe' : s.credit_status === 'pending' ? 'pending' : 'none'}</span>
              {s.stripe_txn_id && <Mono>{s.stripe_txn_id}</Mono>}
              {s.credit_status === 'pending' && s.credit_error && <span className='text-muted-foreground text-xs'>{s.credit_error}</span>}
            </span>
          </Field>
        )}
      </dl>
      {s.kind === 'persona' ? (<>
        <dl>
          <Field label='Name'>{c.name}</Field>
          <Field label='Role'>{(a.role as string) ?? NA}</Field>
          <Field label='Experience'>{typeof a.experience_years === 'number' ? `${a.experience_years} years` : NA}</Field>
          <Field label='Company size'>{companySize(a.company_size as string | null | undefined)}</Field>
          <Field label='Stack'><Chips items={list(a.stack)} /></Field>
          <Field label='Tone'>{(a.tone as string) ?? NA}</Field>
          {c.environment?.editor && <Field label='Editor'>{c.environment.editor}</Field>}
          {!!c.environment?.tools?.length && <Field label='Tools'><Chips items={c.environment.tools} /></Field>}
          {Object.entries(a).filter(([k, v]) => !['role', 'experience_years', 'company_size', 'stack', 'constraints', 'tone'].includes(k) && v != null && v !== '')
            .map(([k, v]) => <Field key={k} label={k}><span className='break-all'>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span></Field>)}
        </dl>
        <section><Label>Summary</Label>{c.summary ? <div className='text-sm leading-relaxed whitespace-pre-wrap'>{c.summary}</div> : <p className='text-muted-foreground text-sm leading-none'>None.</p>}</section>
        {list(a.constraints).length > 0 && <section><Label>Constraints</Label><ul className='list-disc space-y-1 pl-5 text-sm'>{list(a.constraints).map((x, i) => <li key={i}>{x}</li>)}</ul></section>}
        <section><Label>Instructions</Label>{c.instructions ? <div className='text-sm leading-relaxed whitespace-pre-wrap'>{c.instructions}</div> : <p className='text-muted-foreground text-sm leading-none'>None.</p>}</section>
      </>) : (<>
        <dl>
          <Field label='Language'>{c.language ?? NA}</Field>
          <Field label='Platform'>{c.platform ?? NA}</Field>
          <Field label='Repository'>{c.repo_url ? <a href={c.repo_url} target='_blank' rel='noopener noreferrer' className='hover:text-primary'>{c.repo_url}</a> : <span className='text-muted-foreground'>None: a {c.template ? <Mono>{c.template}</Mono> : 'matching'} starter workspace</span>}</Field>
          <Field label='Tags'><Chips items={list(c.tags)} /></Field>
        </dl>
        <section><Label>Prompt</Label><code className={PROMPT}>{c.prompt}</code></section>
      </>)}
    </div>
  );
}

function AcceptDialog({ s, defaultCredit, stripe, onClose }: { s: Submission; defaultCredit: number; stripe: boolean; onClose: () => void }) {
  const [credit, setCredit] = useState(String(defaultCredit));
  const go = useAdminAction(() => post<Submission>(`/submissions/${encodeURIComponent(s.id)}/accept`, { credit_usd: credit.trim() === '' ? null : Number(credit) }),
    { success: (r) => (r.credit_status === 'pending' ? `Accepted. The credit is pending: ${r.credit_error ?? 'Retry credit later'}` : 'Accepted into the library') });
  const n = Number(credit), bad = credit.trim() !== '' && (!Number.isFinite(n) || n < 0 || n > 1000);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>Accept “{s.title}”?</DialogTitle>
          <DialogDescription>
            A copy goes into the shared library as a new {s.kind === 'persona' ? 'persona' : 'task'} (Contributed), active and editable like any other; {s.org_name}&apos;s own copy stays theirs.
            {' '}{s.org_name} gets the credit below on its next invoice{!stripe ? ' once Stripe is configured' : !s.has_stripe_customer ? ' once it has a Stripe customer (Retry credit then)' : ''}.
          </DialogDescription>
        </DialogHeader>
        <FormRow id='sa-credit' label='Credit (USD)' hint={`From Agent configuration: ${usd(defaultCredit)}. 0 for none.`}>
          <Input id='sa-credit' type='number' min={0} max={1000} step='0.01' value={credit} onChange={(e) => setCredit(e.target.value)} className='w-32' />
        </FormRow>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>Cancel</Button>
          <Gate need='library'><Button disabled={go.isPending || bad} onClick={() => go.mutate(undefined, { onSuccess: onClose })}>Accept</Button></Gate>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeclineDialog({ s, onClose }: { s: Submission; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const go = useAdminAction(() => post(`/submissions/${encodeURIComponent(s.id)}/decline`, { reason }), { success: 'Declined' });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>Decline “{s.title}”?</DialogTitle>
          <DialogDescription>{s.org_name} sees this reason next to the {s.kind}. They can edit it and submit it again.</DialogDescription>
        </DialogHeader>
        <FormRow id='sd-reason' label='Reason'>
          <Textarea id='sd-reason' rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder='e.g. Too close to a persona already in the library' />
        </FormRow>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>Cancel</Button>
          <Gate need='library'><Button variant='destructive' disabled={go.isPending || !reason.trim()} onClick={() => go.mutate(undefined, { onSuccess: onClose })}>Decline</Button></Gate>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

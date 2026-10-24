'use client';
// Every account as a database: views for the questions asked most (who needs attention, who is paying, who went quiet),
// typed columns to filter, sort, group and export, and the account itself in the side peek (account-peek.tsx).
import { useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icons } from '@/components/icons';
import { post, useAdmin, useAdminAction, type InviteResult } from './lib';
import { useResult } from './result-dialog';
import { RecordView, type RecordCol, type RecordViewDef } from '@/components/layout/record-view';
import { AccountPeek, AccountPeekActions, accountActions, dollars, useAccountActions, type Org } from './account-peek';
import { copyText, StageDots, StatusBadge, SubBadge, When } from './ui';
import { Gate } from './role';
import { hostFeature } from '@/features/packs/host-nav';
import { sessionEngine } from './engine';

interface Orgs { orgs: Org[]; stages: { id: string; label: string; next: string }[]; stripe_error?: string }

const DAY = 86_400_000;
const billingTrouble = (o: Org) => ['past_due', 'unpaid', 'incomplete'].includes(o.subscription?.status ?? '') || !!o.subscription?.cancel_at_period_end;
const dormant = (o: Org) => !o.last_seen || Date.now() - new Date(o.last_seen).getTime() > 14 * DAY;
const budgetPct = (o: Org) => (o.budget_usd ? Math.round((o.month_spend_usd / o.budget_usd) * 100) : null);
const dash = <span className='text-muted-foreground'>—</span>;
/** Plan cell second line: the billing state when it is not active, else when it renews. */
const planState = (s: NonNullable<Org['subscription']>) => {
  const line = 'text-muted-foreground text-xs leading-none';
  if (s.cancel_at_period_end) return <span className={line}>cancels <When d={s.renews_at} /></span>;
  if (s.status !== 'active') return <span className={['past_due', 'unpaid', 'incomplete'].includes(s.status) ? 'text-destructive text-xs leading-none' : line}>{s.status.replace(/_/g, ' ')}</span>;
  const d = s.renews_at ?? s.trial_end;
  return d ? <span className={line}>renews <When d={d} /></span> : null;
};
const num = (n: number | null | undefined) => (n == null ? dash : n ? <span className='tabular-nums'>{n}</span> : <span className='text-muted-foreground tabular-nums'>0</span>);

const VIEWS: RecordViewDef<Org>[] = [
  { id: 'all', label: 'All', group: 'stage' },
  { id: 'attention', label: 'Needs attention', match: (o) => o.attention.length > 0 },
  // Not yet at the session engine's run stage; without it, not yet at the last stage (the shell's, then the packs' steps).
  { id: 'onboarding', label: 'Onboarding', match: (o) => o.stage_index < (sessionEngine() ? 6 : Object.keys(o.reached ?? {}).length - 1), group: 'stage' },
  { id: 'active', label: 'Active 7d', match: (o) => o.calls_7d > 0 },
  { id: 'paying', label: 'Paying', match: (o) => o.subscription?.status === 'active' },
  { id: 'trialing', label: 'Trialing', match: (o) => o.subscription?.status === 'trialing' },
  { id: 'billing', label: 'Billing issues', match: billingTrouble },
  { id: 'dormant', label: 'Dormant 14d', match: dormant }
];

/** Contact emails, one per account that has one. */
const contacts = (list: Org[]) => [...new Set(list.map((o) => o.contact).filter(Boolean))].join(', ');

export function AdminAccounts() {
  const { data, error, isLoading } = useAdmin<Orgs>('/orgs');
  const { data: ov } = useAdmin<{ integrations: { clerk?: boolean } }>('/overview');
  const [creating, setCreating] = useState(false);
  const result = useResult();
  const ctl = useAccountActions(result.show, Boolean(ov?.integrations.clerk));
  const orgs = data?.orgs ?? [];
  const n = data?.stages.length || 8;

  const members = (o: Org) => o.clerk_org_id ? (
    <span className='inline-flex flex-wrap items-center gap-1.5 tabular-nums'>{o.members}{o.pending_invites > 0 && <StatusBadge tone='info'>+{o.pending_invites} invited</StatusBadge>}</span>
  ) : (
    <span className='text-muted-foreground'>—</span>
  );
  const sel = (vs: string[]) => vs.map((v) => ({ value: v }));
  const cols: RecordCol<Org>[] = [
    { key: 'name', label: 'Account', name: 'Account', className: 'min-w-64', type: 'text', title: true, keep: true, value: (o) => o.name, render: (o) => (
      <span className='leading-none font-medium'>{o.name}</span>
    ) },
    { key: 'contact', label: 'Contact', hidden: true, type: 'text', value: (o) => o.contact, render: (o) => o.contact ?? dash },
    { key: 'stage', label: 'Stage', className: 'w-48', type: 'select', keep: true, value: (o) => o.stage, options: (data?.stages ?? []).map((s) => ({ value: s.id, label: s.label })),
      render: (o) => <span className='whitespace-nowrap'><span className='hidden 2xl:inline'><StageDots index={o.stage_index} total={n} /></span>{o.stage_label}</span> },
    { key: 'next_step', label: 'Next step', type: 'text', hidden: true, value: (o) => o.next_step, render: (o) => o.next_step },
    { key: 'attention', label: 'Attention', type: 'number', keep: true, value: (o) => o.attention.length, render: (o) => o.attention.length ? (
      <Tooltip>
        <TooltipTrigger render={<span className='flex max-w-72 min-w-0 flex-col gap-1 text-sm leading-none text-amber-400' />}>
          <span className='truncate leading-none'>{o.attention[0]}</span>
          {o.attention.length > 1 && <span className='text-muted-foreground text-xs leading-none'>+{o.attention.length - 1} more</span>}
        </TooltipTrigger>
        <TooltipContent className='block max-w-sm whitespace-pre-line'>{o.attention.join('\n')}</TooltipContent>
      </Tooltip>
    ) : dash },
    { key: 'members', label: 'Members', hidden: true, type: 'number', value: (o) => o.members, render: members },
    { key: 'auth', label: 'Sign-in', type: 'select', hidden: true, options: [{ value: 'clerk', label: 'Clerk' }, { value: 'keys', label: 'Keys' }],
      value: (o) => (o.clerk_org_id ? 'clerk' : 'keys'), render: (o) => (o.clerk_org_id ? 'Clerk' : 'Keys') },
    { key: 'active_keys', label: 'Active keys', type: 'number', hidden: true, value: (o) => o.active_keys, render: (o) => num(o.active_keys) },
    { key: 'plan', label: 'Plan', type: 'select', value: (o) => o.subscription?.plan ?? 'none', render: (o) => o.subscription ? (
      <span className='flex flex-col gap-1'><span className='leading-none'>{o.subscription.plan ?? dash}</span>{planState(o.subscription)}</span>
    ) : dash },
    { key: 'billing', label: 'Billing', hidden: true, type: 'select', options: sel(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'canceled', 'none']),
      value: (o) => o.subscription?.status ?? 'none', render: (o) => <SubBadge sub={o.subscription} /> },
    { key: 'renews', label: 'Renews', type: 'date', hidden: true, value: (o) => o.subscription?.renews_at ?? o.subscription?.trial_end ?? null,
      render: (o) => { const d = o.subscription?.renews_at ?? o.subscription?.trial_end; return d ? <When d={d} /> : dash; } },
    { key: 'last_seen', label: 'Last seen', type: 'date', value: (o) => o.last_seen, render: (o) => (o.last_seen ? <When d={o.last_seen} /> : dash) },
    { key: 'calls_7d', label: 'Calls 7d', hidden: true, type: 'number', value: (o) => o.calls_7d, render: (o) => (
      <span className='inline-flex items-center gap-1.5 tabular-nums'>{o.calls_7d}{o.errors_7d > 0 && <StatusBadge tone='bad'>{o.errors_7d} err</StatusBadge>}</span>
    ) },
    { key: 'errors_7d', label: 'Errors 7d', type: 'number', hidden: true, value: (o) => o.errors_7d, render: (o) => num(o.errors_7d) },
    { key: 'spend', label: 'Spend', name: 'Spend this month', hidden: true, type: 'number', value: (o) => o.month_spend_usd, render: (o) => (
      <span className='flex flex-col gap-0.5 tabular-nums'>
        <span>{dollars(o.month_spend_usd)}{o.budget_usd ? <span className='text-muted-foreground'> / {dollars(o.budget_usd)}</span> : null}</span>
        {o.budget_usd > 0 && <span className='text-muted-foreground text-xs'>{budgetPct(o)}% of budget</span>}
      </span>
    ) },
    { key: 'budget_pct', label: 'Budget used %', type: 'number', hidden: true, value: budgetPct, render: (o) => { const p = budgetPct(o); return p == null ? dash : <span className='tabular-nums'>{p}%</span>; } },
    { key: 'running', label: 'Running', type: 'number', hidden: true, value: (o) => o.onboarding_running + o.sims_running + (o.runs_running ?? 0), render: (o) => num(o.onboarding_running + o.sims_running + (o.runs_running ?? 0)) },
    { key: 'created_at', label: 'Created', type: 'date', hidden: true, value: (o) => o.created_at, render: (o) => <When d={o.created_at} /> },
    { key: 'stripe', label: 'Stripe', name: 'Stripe customer', type: 'boolean', hidden: true, value: (o) => !!o.stripe_customer_id, render: (o) => (o.stripe_customer_id ? 'Yes' : 'No') }
  ];

  // RecordView owns the selected tab; it saves it under rv:admin-accounts:view, so read it there at click time.
  const tabRows = () => {
    let id = VIEWS[0].id;
    try { const v = JSON.parse(localStorage.getItem('rv:admin-accounts:view') ?? 'null'); if (typeof v === 'string') id = v; } catch { /* first view */ }
    const v = VIEWS.find((x) => x.id === id) ?? VIEWS[0];
    return v.match ? orgs.filter(v.match) : orgs;
  };
  const copyContacts = (list: Org[]) => { const t = contacts(list); if (t) copyText(t, 'Contact emails copied'); else toast.info('No contact emails here'); };

  return (
    <PageContainer>
      <RecordView<Org>
        id='admin-accounts-v2' noun='accounts' exportName='accounts' groupable
        rows={orgs} rowKey={(o) => o.slug} cols={cols} views={VIEWS} loading={isLoading}
        defaultSort={[{ key: 'last_seen', dir: 'desc' }]}
        searchText={(o) => `${o.name} ${o.slug} ${o.contact ?? ''} ${o.stage_label} ${o.subscription?.plan ?? ''}`}
        searchPlaceholder='Search accounts by name, slug, email or plan'
        filters={error ? <StatusBadge tone='bad' title={error.message}>Load failed</StatusBadge>
          : data?.stripe_error ? <StatusBadge tone='warn' title={data.stripe_error}>Stripe error</StatusBadge> : undefined}
        primary={<Gate need='requests'><Button onClick={() => setCreating(true)}><Icons.add className='size-4' /> New account</Button></Gate>}
        primaryMenu={[{ label: 'Copy contact emails (current view)', icon: <Icons.teams />, onSelect: () => copyContacts(tabRows()) }]}
        bulk={(list) => [
          { label: 'Copy contact emails', icon: <Icons.teams />, onSelect: () => copyContacts(list) },
          ...(hostFeature('tips') ? [ctl.lock({ label: `Send a tip to ${list.length}`, icon: <Icons.chat />, onSelect: () => ctl.open('tip', ...list) }, 'journeys')] : [])
        ]}
        actions={(o) => accountActions(o, ctl)}
        empty='No accounts yet. Approve an access request or create one.'
        detailActions={(o) => <AccountPeekActions org={o} ctl={ctl} />}
        detail={(o) => <AccountPeek org={o} ctl={ctl} />}
      />
      {creating && (
        <NewAccount
          clerk={Boolean(ov?.integrations.clerk)}
          onClose={() => setCreating(false)}
          onDone={(r) => {
            setCreating(false);
            result.show(r, `Account created: ${r.org.name}`);
          }}
        />
      )}
      {ctl.dialogs}
      {result.dialog}
    </PageContainer>
  );
}

function NewAccount({ clerk, onClose, onDone }: { clerk: boolean; onClose: () => void; onDone: (r: InviteResult) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const create = useAdminAction(() => post<InviteResult>('/orgs', { name: name.trim(), slug: slug.trim() || undefined, email: email.trim() || undefined }));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    create.mutate(undefined, { onSuccess: onDone, onError: (x) => setErr(x.message) });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={submit} className='grid gap-4'>
          <DialogHeader>
            <DialogTitle>New account</DialogTitle>
            <DialogDescription>For someone who did not use the landing page form.</DialogDescription>
          </DialogHeader>
          <div className='grid gap-1.5'>
            <Label htmlFor='na-name'>Account name</Label>
            <Input id='na-name' required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='na-slug'>Slug (optional)</Label>
            <Input id='na-slug' placeholder='from the name' value={slug} onChange={(e) => setSlug(e.target.value)} />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='na-email'>First person&apos;s email (optional)</Label>
            <Input id='na-email' type='email' value={email} onChange={(e) => setEmail(e.target.value)} />
            <p className='text-muted-foreground text-xs'>
              {clerk ? "With an email, Clerk invites that person as the account's admin." : 'Clerk is off: the account gets a secret key link, labelled with the email.'}
            </p>
          </div>
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>
              Cancel
            </Button>
            <Button type='submit' disabled={create.isPending}>
              Create account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

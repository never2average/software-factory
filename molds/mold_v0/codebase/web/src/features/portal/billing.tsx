'use client';
// /app Billing: this month (plan, spend against the cap; for a member, their own budget and the rules in
// plain words; for an admin, a banner from 80% of the allowance or when the pace runs out) above three tabs. People: one
// searchable table of who is in the account, their role, access, team, limit, what is left and what limits them (invite,
// roles, limits and suspension in each row's ⋯ menu; "own settings only" narrows it to the exceptions). Teams: a
// searchable table of team budgets (deleting one first shows what it changes). Budget rules (admins): one table of the
// rules that matter (the allowance, how people share it, the buffer, who can launch, run limits, team budgets and
// people's own settings), who set each and when; each row's Edit saves through the endpoint that owns that rule, which
// checks it. Plans and cards are Stripe's; people are Clerk's.
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { RecordView, type RecordCol, type RowAction } from '@/components/layout/record-view';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { money, num, usd } from '@/lib/octillion-format';
import { cn } from '@/lib/utils';
import { ErrorState, LoadingCards, When, fail, useOrgLoad } from './shared';
import { ACCOUNT_ROLE_LABEL, Allowed, useAccountRole, type AccountRole, type AccountRoleInfo } from './role';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { profile } from '@/config/profile.generated';

interface Sub { status: string; plan: string | null; renews_at: string | null; cancel_at_period_end: boolean; trial_end: string | null }
interface Plan { price_id: string; name: string; amount: number | null; currency: string; interval: string | null; monthly_budget_usd: number | null; trial_days?: number | null; description?: string | null;
  /** Usage pricing, one line per metric (model spend, agent sessions, simulations, sandbox hours), in words. */
  usage?: { metric: string; summary: string }[] }
interface Billing { enabled: boolean; customer: boolean; subscription: Sub | null; budget_usd: number; budget_source?: 'override' | 'plan' | 'default'; prepaid_allowed?: boolean; plans: Plan[]; can_manage: boolean
  contributions?: Contributions }
/** Credits for personas and tasks the platform accepted into its library: from Stripe's balance transactions, plus accepted ones Stripe hasn't taken yet. */
interface Contributions { credits: { id: string; amount_usd: number; description: string | null; created: string; submission_id: string }[]; total_usd: number; error: string | null;
  pending: { id: string; kind: 'persona' | 'task'; title: string; credit_usd: number; decided_at: string | null }[] }
interface Usage {
  period: { start: string; end: string; days: number; elapsed_days: number };
  spent_usd: number; budget_usd: number; projected_usd: number; metered_usd: number; in_flight_usd: number;
  sessions: { finished: number; running: number }; meter: { enabled: boolean };
  daily: { day: string; usd: number; sessions: number }[];
}
interface Member { id: string; user_id: string; status: string; role: string; account_role?: AccountRole; created_at: string; email: string | null; name: string | null }
interface Invite { id: string; email: string; state: string; role?: string; account_role?: AccountRole; created_at: string }
interface Team { clerk: boolean; error: string | null; members: Member[]; invitations: Invite[]; me: string | null; can_manage: boolean }
type Mode = 'pool' | 'even' | 'custom';
interface Policy { mode: Mode; reserve_usd: number; default_cap_usd: number | null; new_members_can_run: boolean; max_concurrent_runs: number | null; max_sessions_per_run: number | null; max_run_usd: number | null }
type LimitCode = 'no_allowance' | 'account_cap' | 'budget_error' | 'launch_access' | 'person_limit' | 'team_budget' | 'rest_pot' | 'buffer' | 'runs_at_once' | 'run_sessions';
/** A budget's figures from allocate(): each person's amount before own limits (null: shared freely), launchers, running now, whether it limits. */
interface Pot { each_usd: number | null; launchers: number; in_flight_usd: number; limited_by: LimitCode | null }
interface LimitTeam extends Pot { id: number; name: string; budget_usd: number | null; max_concurrent_runs: number | null; members: number; spent: number; left_usd: number | null }
interface LimitMember { user_id: string; name?: string | null; email?: string | null; team_id: number | null; pot?: number | null; can_run: boolean; own_can_run?: boolean | null;
  adjust_usd: number; cap_usd: number | null; max_concurrent_runs: number | null; spent: number; in_flight_usd?: number; running: number;
  tokens_in: number; tokens_out: number; limit_usd?: number | null; limit_source?: 'own' | 'share' | 'default' | 'pool'; left_usd?: number | null; blocked?: LimitCode | null;
  limited_by?: LimitCode | null; effective_max_concurrent?: number | null; concurrent_source?: 'you' | 'team' | 'account' }
/** A member's own budget (GET /limits for a member): the budget they draw on, run limits, the account's totals, the rules in plain words. */
interface You { pot: { kind: 'team' | 'rest'; name: string; budget_usd: number; left_usd: number } | null; max_sessions: number; max_run_usd: number | null;
  account: { cap_usd: number; spent_usd: number; left_usd: number }; summary: string[] }
interface Limits { policy: Policy; budget_usd: number; teams: LimitTeam[]; members: LimitMember[]; can_manage: boolean; me: string | null; clerk?: boolean; budget_error?: boolean;
  admins?: { name: string }[]; server_max_sessions?: number; period_end?: string; version?: string; you?: You; alert?: { used_pct: number; runs_out_on: string | null } | null }
/** GET /limits for an admin: the saved rules through allocate(), and who last changed each rule (keys as in src/limits.ts ruleChanges). */
interface AdminLimits extends Limits { budget_error: boolean; rest: Pot & { budget_usd: number; members: number; spent: number; left_usd: number };
  changed?: Record<string, { by_name: string; at: string }> }
/** POST /limits/preview (Delete team asks it what removing the team changes): the rules' picture without it, and who it changes for. */
interface Preview extends Limits { changes: { user_id: string; blocked_now: boolean }[] }

const STATUS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = { active: 'default', trialing: 'secondary', past_due: 'destructive', unpaid: 'destructive', canceled: 'outline' };
const orNull = (v: string) => (v.trim() === '' ? null : Number(v));
const str = (v: number | null | undefined) => (v == null ? '' : String(v));

/** A titled section: the page is the container, no cards. */
function Block({ id, title, action, children }: { id?: string; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className='flex scroll-mt-20 flex-col gap-4'>
      {(title || action) && <div className='flex items-center justify-between gap-2'>{title ? <h2 className='text-base leading-none font-semibold'>{title}</h2> : <span />}{action}</div>}
      {children}
    </section>
  );
}

const urlParam = (k: string) => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get(k));

export function BillingPage() {
  const { data: b, error } = useOrgLoad(() => appApi<Billing>('GET', '/billing'));
  const { data: u } = useOrgLoad(() => appApi<Usage>('GET', '/billing/usage'));
  const { data: t, reload: reloadTeam } = useOrgLoad(() => appApi<Team>('GET', '/team'));
  const { data: l, reload: reloadLimits } = useOrgLoad(() => appApi<Limits>('GET', '/limits'));
  const reload = () => { reloadTeam(); reloadLimits(); };
  // ?tab=people&filter=exceptions opens People with everyone who has their own settings.
  // (The tabs only render once billing has loaded, in the browser, so reading the URL here can't mismatch the server's HTML.)
  const [tab, setTab] = useState(() => { const v = urlParam('tab'); return v && ['people', 'teams', 'rules'].includes(v) ? v : 'people'; });
  const [peopleFilter, setPeopleFilter] = useState<PeopleFilter>(() => (urlParam('filter') === 'exceptions' ? 'exceptions' : 'all'));
  return (
    <PageContainer>
      {error ? <ErrorState error={error} /> : !b ? <LoadingCards count={3} /> : (
        <div className='flex w-full flex-col gap-6'>
          <ThisMonth b={b} u={u ?? undefined} l={l ?? undefined} />
          {/* People, Teams and Budget rules as tabs: the two tables get the full width and height they need. */}
          <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className='gap-4'>
            <TabsList variant='line' className='gap-6 p-0'>
              <TabsTrigger value='people' className='flex-none px-0'>People</TabsTrigger>
              <TabsTrigger value='teams' className='flex-none px-0'>Teams</TabsTrigger>
              {l?.can_manage && <TabsTrigger value='rules' className='flex-none px-0'>Budget rules</TabsTrigger>}
            </TabsList>
            <TabsContent value='people'><People t={t ?? undefined} l={l ?? undefined} reload={reload} filter={peopleFilter} setFilter={setPeopleFilter} /></TabsContent>
            <TabsContent value='teams'>{l ? <Teams l={l} reload={reload} /> : <LoadingCards count={1} />}</TabsContent>
            {l?.can_manage && <TabsContent value='rules'><Rules l={l as AdminLimits} b={b} reload={reload} /></TabsContent>}
          </Tabs>
        </div>
      )}
    </PageContainer>
  );
}

// ---------- this month: plan, spend against the cap ----------

function ThisMonth({ b, u, l }: { b: Billing; u: Usage | undefined; l: Limits | undefined }) {
  const [busy, setBusy] = useState<string | null>(null);
  const go = (path: string, body?: unknown, id = path) => {
    setBusy(id);
    appApi<{ url: string }>('POST', path, body).then((r) => { window.location.href = r.url; }).catch((e) => { setBusy(null); fail(e); });
  };
  const s = b.subscription, live = s && ['active', 'trialing', 'past_due'].includes(s.status);
  // A member's own budget leads; the account's totals move to a smaller line under it.
  const mine = !l?.can_manage && l?.you && !l.budget_error ? l.members.find((m) => m.user_id === l.me) : undefined;
  const cap = u?.budget_usd ?? b.budget_usd;
  const pct = (v: number) => (cap ? Math.min(100, (v / cap) * 100) : 0);
  const over = !!u && cap > 0 && u.projected_usd > cap;
  return (
    <Block title='' action={b.enabled && b.can_manage && b.customer
      ? <Button variant='outline' size='sm' disabled={busy !== null} onClick={() => go('/billing/portal')}>{busy ? <Icons.spinner className='animate-spin' /> : <Icons.creditCard />} Manage billing</Button> : undefined}>
      {s && ['past_due', 'unpaid'].includes(s.status) && <Alert variant='destructive'><Icons.warning /><AlertDescription>The last payment failed. Update the card to keep running simulations.</AlertDescription></Alert>}
      {l?.can_manage && l.alert && <UsageBanner a={l.alert} />}
      {mine && l?.you && <YourBudget m={mine} l={l} you={l.you} />}
      <div className='flex flex-wrap items-baseline gap-x-6 gap-y-2 leading-none'>
        <span className={cn('font-semibold tabular-nums', mine ? 'text-base' : 'text-4xl')}>{mine && 'Account: '}{usd(u?.spent_usd ?? 0)}</span>
        <span className='text-muted-foreground text-sm'>{cap ? `of ${usd(cap)} prepaid this month` : 'no prepaid allowance'}</span>
        <span className='ml-auto flex items-center gap-2 text-sm'>
          {!b.enabled || (b.budget_source === 'override' && !s) ? null : <>
            <span className='font-medium'>{s?.plan ?? 'No plan'}</span>
            {s && <Badge variant={STATUS[s.status] ?? 'outline'}>{s.status.replace('_', ' ')}</Badge>}
            {s?.renews_at && <span className='text-muted-foreground'>{s.cancel_at_period_end ? 'ends' : 'renews'} {new Date(s.renews_at).toLocaleDateString()}</span>}
          </>}
        </span>
      </div>
      {cap > 0 && u && (
        <div className='relative'>
          <div className='bg-muted h-2.5 overflow-hidden rounded-full'><div className={cn('h-full rounded-full', pct(u.spent_usd) >= 100 ? 'bg-destructive' : pct(u.spent_usd) >= 80 ? 'bg-amber-500' : 'bg-primary')} style={{ width: `${pct(u.spent_usd)}%` }} /></div>
          <div className={cn('absolute -top-1 h-4.5 w-0.5 rounded', over ? 'bg-destructive' : 'bg-foreground/50')} style={{ left: `calc(${pct(u.projected_usd)}% - 1px)` }} title={`Projected ${usd(u.projected_usd)}`} />
        </div>
      )}
      {u && (
        <p className='text-muted-foreground flex flex-wrap gap-x-5 gap-y-1 text-xs leading-none'>
          <span className={cn(over && 'text-destructive')}>Projected {usd(u.projected_usd)} by month end</span>
          <span>{usd(u.metered_usd)} metered{u.meter.enabled ? ' to Stripe' : ''} · {u.sessions.finished} sessions</span>
          {u.in_flight_usd > 0 && <span>{usd(u.in_flight_usd)} in flight · {u.sessions.running} running</span>}
          <span>Day {Math.ceil(u.period.elapsed_days)} of {u.period.days}</span>
        </p>
      )}
      {/* No plan and no allowance: runs are off. Plans are invite-only while inference costs are high. */}
      {cap <= 0 && !(b.enabled && b.plans.length > 0) && (
        <Alert><Icons.lock /><AlertDescription>
          Running simulations and onboarding needs a prepaid plan. Plans are invite-only for now: reply to your {profile.name} contact, or write to us, and we&apos;ll set one up for your team.
        </AlertDescription></Alert>
      )}
      {b.enabled && b.plans.length > 0 && !(live && b.customer) && (
        <ul className='divide-y border-y'>
          {b.plans.map((p) => (
            <li key={p.price_id} className='flex flex-wrap items-center gap-x-6 gap-y-2 py-3 leading-none'>
              <span className='w-32 font-medium'>{p.name}</span>
              <span className='text-muted-foreground flex-1 text-sm leading-snug'>
                {p.monthly_budget_usd != null ? `Up to ${usd(p.monthly_budget_usd)} of model spend a month` : 'Model spend as you go'}
                {p.trial_days ? ` · ${p.trial_days}-day free trial` : ''}{p.usage?.map((u) => <span key={u.metric} className='block'>{u.summary}</span>)}
                {p.description ? <span className='block'>{p.description}</span> : null}
              </span>
              <span className='tabular-nums'>{p.amount == null && p.usage?.length ? 'Usage' : money(p.amount, p.currency)}{p.interval && <span className='text-muted-foreground text-sm'> / {p.interval}</span>}{p.amount != null && p.usage?.length ? <span className='text-muted-foreground text-sm'> + usage</span> : null}</span>
              {b.can_manage && <Button size='sm' disabled={busy !== null} onClick={() => go('/billing/checkout', { price_id: p.price_id }, p.price_id)}>Choose</Button>}
            </li>
          ))}
        </ul>
      )}
      {b.contributions && <ContributionCredits c={b.contributions} />}
    </Block>
  );
}

/** "Credits from contributions": what accepted library contributions took off the next invoices (Stripe customer balance). */
function ContributionCredits({ c }: { c: Contributions }) {
  if (!c.credits.length && !c.pending.length) return null;
  return (
    <section className='flex flex-col gap-2'>
      <div className='flex items-baseline gap-3 text-sm leading-none'>
        <span className='font-medium'>Credits from contributions</span>
        {c.credits.length > 0 && <span className='text-muted-foreground tabular-nums'>{usd(c.total_usd)} applied to your next invoices</span>}
      </div>
      <ul className='divide-y border-y text-sm'>
        {c.credits.map((x) => (
          <li key={x.id} className='flex items-center gap-3 py-2 leading-none'>
            <span className='min-w-0 flex-1 truncate'>{x.description ?? 'Library contribution'}</span>
            <span className='text-muted-foreground text-xs'>{new Date(x.created).toLocaleDateString()}</span>
            <span className='w-20 text-right tabular-nums'>{usd(x.amount_usd)}</span>
          </li>
        ))}
        {c.pending.map((x) => (
          <li key={x.id} className='text-muted-foreground flex items-center gap-3 py-2 leading-none'>
            <span className='min-w-0 flex-1 truncate'>Library contribution: {x.title}</span>
            <span className='text-xs'>credit on its way</span>
            <span className='w-20 text-right tabular-nums'>{usd(x.credit_usd)}</span>
          </li>
        ))}
      </ul>
      {c.error && <p className='text-muted-foreground text-xs'>Stripe could not list the credits just now.</p>}
    </section>
  );
}

/** Admins, from 80% of the allowance or when the month's pace runs out before it ends (worked out on GET; nothing is sent). */
function UsageBanner({ a }: { a: NonNullable<Limits['alert']> }) {
  const lines = [
    ...(a.used_pct >= 80 ? [`Your account has used ${a.used_pct}% of this month's allowance.`] : []),
    ...(a.runs_out_on ? [`Your account is on pace to run out on ${utcDate(Date.parse(a.runs_out_on), { month: 'short', day: 'numeric' })}.`] : [])
  ];
  return (
    <Alert variant={a.used_pct >= 100 ? 'destructive' : 'default'} className={a.used_pct >= 100 ? undefined : 'border-amber-500/50'}>
      <Icons.warning /><AlertDescription>{lines.join(' ')}</AlertDescription>
    </Alert>
  );
}

/**
 * A member's own budget (members never see Budget rules): what is left of their limit this month (or, with no personal
 * limit, of the budget they draw on), their team, runs at once, run size and the reset, then the rules in plain words.
 */
function YourBudget({ m, l, you }: { m: LimitMember; l: Limits; you: You }) {
  const reset = l.period_end ? utcDate(Date.parse(l.period_end), { month: 'short', day: 'numeric' }) : null;
  const near = m.limit_usd != null && m.limit_usd > 0 && !m.blocked && m.spent >= 0.8 * m.limit_usd;
  const word = m.limited_by && m.limited_by !== 'launch_access' ? limitedWord(m.limited_by, l.teams, m.team_id, 'Your limit') : null;
  const team = l.teams.find((x) => x.id === m.team_id);
  const details = [
    // The budget they draw on, unless the headline already is it (no personal limit).
    team && team.budget_usd != null ? (m.limit_usd != null ? `Team ${team.name}: ${usd(team.left_usd ?? 0)} left` : `Team ${team.name}`) : team ? `Team ${team.name}` : '',
    m.effective_max_concurrent != null ? `${m.running} of ${m.effective_max_concurrent} running` : m.running ? `${m.running} running` : '',
    `up to ${plural(you.max_sessions, 'session')}${you.max_run_usd != null ? ` and ${usd(you.max_run_usd)}` : ''} per run`,
    reset ? `resets ${reset}` : ''
  ].filter(Boolean);
  return (
    <div className='flex flex-col gap-3'>
      <span className='text-muted-foreground text-xs leading-none'>Your budget</span>
      <div className='flex flex-wrap items-baseline gap-x-3 gap-y-2 leading-none'>
        {!m.can_run ? <span className='text-2xl font-semibold'>You can&apos;t launch simulations yet</span>
          : m.limit_usd == null ? <><span className='text-4xl font-semibold tabular-nums'>{usd(you.pot?.left_usd ?? 0)}</span>
            <span className='text-muted-foreground text-sm'>No personal limit · {you.pot?.name ?? 'Everyone'} has this left</span></>
          : <><span className='text-4xl font-semibold tabular-nums'>{usd(m.left_usd ?? 0)}</span><span className='text-muted-foreground text-sm'>left of {usd(m.limit_usd)} this month</span></>}
        <span className='flex flex-wrap gap-1.5'>
          {near && <Badge variant='outline' className='border-amber-500/50 text-amber-700 dark:text-amber-400'>Near your limit</Badge>}
          {word && <Badge variant={m.blocked ? 'destructive' : 'outline'}>Limited by: {word}</Badge>}
        </span>
      </div>
      <p className='text-muted-foreground text-xs leading-none'>{details.join(' · ')}</p>
      {you.summary.length > 0 && <p className='max-w-3xl text-sm leading-relaxed'>{you.summary.join(' ')}</p>}
    </div>
  );
}

// ---------- people: one table for membership, access and limits ----------

type PersonRow =
  | { kind: 'member'; key: string; m: Member; lim: LimitMember | undefined }
  | { kind: 'invite'; key: string; x: Invite };
type PeopleFilter = 'all' | 'exceptions';

/** A person's own settings, in words ("own limit $150.00", "can't launch"); none: they follow the defaults. Budget rules' rows and People's filter. */
function exceptionWords(m: LimitMember, p: Policy) {
  return [
    ...(m.cap_usd != null ? [`own limit ${usd(m.cap_usd)}`] : []),
    ...(m.adjust_usd ? [`${m.adjust_usd > 0 ? '+' : '−'}${usd(Math.abs(m.adjust_usd))} ${p.mode === 'even' ? 'on top of equal share' : 'adjustment (only applies with an equal share)'}`] : []),
    ...(m.own_can_run != null && m.own_can_run !== p.new_members_can_run ? [m.own_can_run ? 'allowed to launch' : "can't launch"] : []),
    ...(m.max_concurrent_runs != null ? [plural(m.max_concurrent_runs, 'run') + ' at once'] : [])
  ];
}
const SOURCE_WORD = { you: 'own', team: 'team', account: 'account' } as const;

function People({ t, l, reload, filter = 'all', setFilter }: { t: Team | undefined; l: Limits | undefined; reload: () => void; filter?: PeopleFilter; setFilter?: (f: PeopleFilter) => void }) {
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<{ m: Member; lim: LimitMember } | null>(null);
  const [suspend, setSuspend] = useState<Member | null>(null);
  const { lock, roles } = useAccountRole();
  if (!t) return <LoadingCards count={1} />;
  // The team (invite, roles, suspension) is the owners'; Edit limits is Budget rules (owners and billing managers).
  const manage = t.can_manage, budget = !!l?.can_manage, mode = l?.policy.mode ?? 'pool';
  const act = (p: Promise<unknown>, msg: string) => p.then(() => { toast.success(msg); reload(); }).catch(fail);
  const all: PersonRow[] = [
    ...t.members.map((m) => ({ kind: 'member' as const, key: m.id, m, lim: l?.members.find((x) => x.user_id === m.user_id) })),
    ...t.invitations.map((x) => ({ kind: 'invite' as const, key: x.id, x }))
  ];
  // "Own settings only" (?filter=exceptions): the people who don't follow the defaults.
  const own = (r: PersonRow) => r.kind === 'member' && !!r.lim && !!l && exceptionWords(r.lim, l.policy).length > 0;
  const filtered = filter === 'exceptions' && budget;
  const rows = filtered ? all.filter(own) : all;
  const teamName = (id: number | null | undefined) => (id == null ? null : l?.teams.find((x) => x.id === id)?.name ?? null);
  const actions = (r: PersonRow): RowAction[] => {
    if (!manage && !budget) return [];
    if (r.kind === 'invite') return [
      lock({ label: 'Resend invitation', icon: <Icons.send />, onSelect: () => act(appApi('POST', `/team/invitations/${encodeURIComponent(r.x.id)}/resend`), `Invitation resent to ${r.x.email}`) }, 'team'),
      ...(r.x.state === 'pending' ? [lock({ label: 'Cancel invitation', icon: <Icons.close />, destructive: true, onSelect: () => act(appApi('POST', `/team/invitations/${encodeURIComponent(r.x.id)}/revoke`), 'Invitation cancelled') }, 'team')] : [])
    ];
    const { m, lim } = r, self = m.user_id === t.me, active = m.status === 'active', now = roleOf(m);
    return [
      ...(lim ? [lock({ label: 'Edit limits', icon: <Icons.gauge />, onSelect: () => setEditing({ m, lim }) }, 'budget')] : []),
      ...(self ? [] : [
        ...roles.filter((x) => x.id !== now).map((x, i) => lock({ label: `Make ${x.label.toLowerCase()}`, icon: <Icons.teams />, separator: i === 0 && !!lim,
          onSelect: () => act(appApi('POST', `/team/members/${encodeURIComponent(m.id)}/role`, { role: x.id }), `${m.email} is now ${/^[aeiou]/i.test(x.label) ? 'an' : 'a'} ${x.label.toLowerCase()}`) }, 'team')),
        lock(active ? { label: 'Suspend access', icon: <Icons.close />, destructive: true, separator: true, onSelect: () => setSuspend(m) }
          : { label: 'Restore access', icon: <Icons.check />, separator: true, onSelect: () => act(appApi('POST', `/team/members/${encodeURIComponent(m.id)}/reactivate`), `Access restored for ${m.email}`) }, 'team')
      ])
    ];
  };
  const statusOf = (r: PersonRow) => (r.kind === 'invite' ? (r.x.state === 'expired' ? 'Invitation expired' : 'Invited') : r.m.status === 'active' ? 'Active' : 'Suspended');
  const cols: RecordCol<PersonRow>[] = [
    { key: 'person', label: 'Person', keep: true, type: 'text', value: (r) => (r.kind === 'invite' ? r.x.email : r.m.name || r.m.email || ''),
      // Invites: when it was sent, as a second line (Joined is off by default).
      render: (r) => r.kind === 'invite' ? (<>
        <span className='font-medium'>{r.x.email}</span>
        <div className='text-muted-foreground mt-1 text-xs leading-none'>sent <When d={r.x.created_at} /></div>
      </>) : (<>
        <span className='font-medium'>{r.m.name || r.m.email}</span>
        {r.m.user_id === t.me && <span className='text-muted-foreground ml-2 text-xs'>you</span>}
        {r.m.name && <span className='text-muted-foreground ml-2 text-xs'>{r.m.email}</span>}
      </>) },
    { key: 'role', label: 'Role', className: 'w-36', type: 'select', value: (r) => ACCOUNT_ROLE_LABEL[roleOf(r.kind === 'invite' ? r.x : r.m)],
      // The status badge under the role, only when it isn't Active (Status itself is off by default).
      render: (r) => { const x = roleOf(r.kind === 'invite' ? r.x : r.m), st = statusOf(r); return (<>
        <span className={x === 'owner' ? '' : 'text-muted-foreground'} title={roles.find((y) => y.id === x)?.help}>{ACCOUNT_ROLE_LABEL[x]}</span>
        {st !== 'Active' && <div className='mt-1'><Badge variant={st === 'Invited' ? 'outline' : 'destructive'}>{st}</Badge></div>}
      </>); } },
    { key: 'status', label: 'Status', className: 'w-36', type: 'select', hidden: true, value: statusOf,
      render: (r) => <Badge variant={statusOf(r) === 'Active' ? 'secondary' : statusOf(r) === 'Invited' ? 'outline' : 'destructive'}>{statusOf(r)}</Badge> },
    { key: 'team', label: 'Team', className: 'w-36', type: 'select', value: (r) => (r.kind === 'member' ? teamName(r.lim?.team_id) ?? 'No team' : 'No team'),
      render: (r) => <span className='text-muted-foreground'>{r.kind === 'member' ? teamName(r.lim?.team_id) ?? '—' : '—'}</span> },
    { key: 'spend', label: 'Spend this month', className: 'w-56', type: 'number', value: (r) => (r.kind === 'member' ? r.lim?.spent ?? 0 : 0),
      // Line 1: the bar (or "· shared budget" with no own limit); line 2: what is left and, when one applies, the limit that binds (red when blocked).
      render: (r) => {
        if (r.kind === 'invite' || !r.lim) return <span className='text-muted-foreground'>—</span>;
        const lim = r.lim, w = limitedWord(lim.limited_by, l?.teams ?? [], lim.team_id);
        return (<>
          {lim.limit_usd == null
            ? <span className='text-xs tabular-nums'>{usd(lim.spent)} <span className='text-muted-foreground'>· shared budget</span></span>
            : <Allowance spent={lim.spent} cap={lim.limit_usd} />}
          {(lim.left_usd != null || w) && <div className='text-muted-foreground mt-1 text-xs leading-none tabular-nums'>
            {lim.left_usd != null && `${usd(lim.left_usd)} left`}
            {w && <span className={cn(lim.blocked && 'text-destructive')}>{lim.left_usd != null && ' · '}{w}</span>}
          </div>}
        </>);
      } },
    // What is left before the first limit that applies (their own, their budget, the buffer, the account), and which one binds.
    { key: 'left', label: 'Left', className: 'w-24', type: 'number', hidden: true, value: (r) => (r.kind === 'member' && r.lim ? r.lim.left_usd ?? undefined : undefined),
      render: (r) => <span className='text-xs tabular-nums'>{r.kind === 'member' && r.lim?.left_usd != null ? usd(r.lim.left_usd) : <span className='text-muted-foreground'>—</span>}</span> },
    { key: 'limited', label: 'Limited by', className: 'w-36', type: 'select', hidden: true, value: (r) => (r.kind === 'member' && r.lim ? limitedWord(r.lim.limited_by, l?.teams ?? [], r.lim.team_id) ?? '—' : '—'),
      render: (r) => {
        const w = r.kind === 'member' && r.lim ? limitedWord(r.lim.limited_by, l?.teams ?? [], r.lim.team_id) : null;
        return w ? <span className={cn('text-xs', r.kind === 'member' && r.lim?.blocked && 'text-destructive')}>{w}</span> : <span className='text-muted-foreground'>—</span>;
      } },
    { key: 'tokens', label: 'Tokens', className: 'w-28', type: 'number', hidden: true, value: (r) => (r.kind === 'member' && r.lim ? Number(r.lim.tokens_in) + Number(r.lim.tokens_out) : 0),
      render: (r) => <span className='text-xs tabular-nums'>{r.kind === 'member' && r.lim ? num(Number(r.lim.tokens_in) + Number(r.lim.tokens_out)) : '—'}</span> },
    // The one that applies (the most specific: their own, their team's, the account's) and where it comes from: "2 · team".
    { key: 'runs', label: 'Runs at once', className: 'w-36', hidden: true, render: (r) => r.kind === 'invite' || !r.lim ? <span className='text-muted-foreground'>—</span> : (
      <span className='text-xs tabular-nums'>
        {r.lim.effective_max_concurrent == null ? <span className='text-muted-foreground'>no limit</span>
          : <>{r.lim.effective_max_concurrent}<span className='text-muted-foreground'> · {SOURCE_WORD[r.lim.concurrent_source ?? 'account']}</span></>}
        {r.lim.running > 0 && <span className='text-primary ml-1.5'>· {r.lim.running} now</span>}
      </span>) },
    { key: 'can_run', label: 'Can run', className: 'w-24', type: 'select', hidden: true, value: (r) => (r.kind === 'member' && r.lim ? (r.lim.can_run ? 'Yes' : 'No') : '—'),
      render: (r) => <span className={r.kind === 'member' && r.lim?.can_run ? '' : 'text-muted-foreground'}>{r.kind === 'member' && r.lim ? (r.lim.can_run ? 'Yes' : 'No') : '—'}</span> },
    { key: 'joined', label: 'Joined', className: 'w-28', type: 'date', hidden: true, value: (r) => (r.kind === 'invite' ? r.x.created_at : r.m.created_at),
      render: (r) => <span className='text-muted-foreground text-xs'>{r.kind === 'invite' ? <>sent <When d={r.x.created_at} /></> : <When d={r.m.created_at} />}</span> }
  ];
  return (
    <div className='flex flex-col gap-3'>
      {t.error && <Alert variant='destructive'><AlertDescription>{t.error}</AlertDescription></Alert>}
      <RecordView compact id='billing-people' rows={rows} rowKey={(r) => r.key} cols={cols} noun='people'
        searchText={(r) => (r.kind === 'invite' ? r.x.email : `${r.m.name ?? ''} ${r.m.email ?? ''} ${teamName(r.lim?.team_id) ?? ''}`)}
        searchPlaceholder='Search people by name, email or team'
        filters={<>
          {budget && (
            <Button variant={filtered ? 'secondary' : 'outline'} size='sm' aria-pressed={!!filtered} onClick={() => setFilter?.(filtered ? 'all' : 'exceptions')}
              title='People with their own limit, adjustment, launch access or runs at once'>
              Own settings only
            </Button>)}
          <RolesHelp roles={roles} />
        </>}
        views={[{ id: 'all', label: 'Everyone' }, { id: 'active', label: 'Active', match: (r) => statusOf(r) === 'Active' }, { id: 'invited', label: 'Invited', match: (r) => r.kind === 'invite' },
          { id: 'suspended', label: 'Suspended', match: (r) => statusOf(r) === 'Suspended' }]}
        primary={<Allowed need='team'><Button onClick={() => setInviting(true)}><Icons.add /> Invite</Button></Allowed>}
        actions={manage || budget ? actions : undefined} exportName='people' empty={filtered ? 'Nobody has their own settings.' : 'Nobody here yet.'} />
      {inviting && <InviteDialog roles={roles} onClose={() => setInviting(false)} onSent={reload} />}
      {editing && l && <LimitsDialog m={editing.m} lim={editing.lim} l={l} mode={mode} onClose={() => setEditing(null)} onSaved={reload} />}
      <Dialog open={!!suspend} onOpenChange={(o) => !o && setSuspend(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Suspend {suspend?.email}?</DialogTitle>
            <DialogDescription>Their AI client and this portal stop working for them within a minute. They stay in the account, and you can restore access any time.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant='outline' onClick={() => setSuspend(null)}>Keep access</Button>
            <Button variant='destructive' onClick={() => suspend && act(appApi('POST', `/team/members/${encodeURIComponent(suspend.id)}/deactivate`), `Access suspended for ${suspend.email}`).finally(() => setSuspend(null))}>Suspend</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Allowance({ spent, cap }: { spent: number; cap: number }) {
  const p = cap ? Math.min(100, (spent / cap) * 100) : 0;
  return (
    <div className='flex items-center gap-2'>
      <div className='bg-muted h-1.5 w-20 overflow-hidden rounded-full'><div className={cn('h-full rounded-full', p >= 100 ? 'bg-destructive' : p >= 80 ? 'bg-amber-500' : 'bg-primary')} style={{ width: `${p}%` }} /></div>
      <span className='text-xs tabular-nums'>{usd(spent)} <span className='text-muted-foreground'>of {usd(cap)}</span></span>
    </div>
  );
}

/** A person's or invitation's account role (older servers sent only Clerk's admin / member). */
const roleOf = (x: { role?: string; account_role?: AccountRole }): AccountRole => x.account_role ?? (x.role === 'admin' ? 'owner' : 'member');

/** What each role can do, one line each, next to Invite. */
function RolesHelp({ roles }: { roles: AccountRoleInfo[] }) {
  if (!roles.length) return null;
  return (
    <Popover>
      <PopoverTrigger render={<Button variant='ghost' size='sm' className='text-muted-foreground' />}>Roles</PopoverTrigger>
      <PopoverContent align='end' className='w-80'><RoleLines roles={roles} /></PopoverContent>
    </Popover>
  );
}
const RoleLines = ({ roles, on }: { roles: AccountRoleInfo[]; on?: string }) => (
  <dl className='grid gap-2 text-sm'>
    {roles.map((r) => <div key={r.id} className={cn(on && on !== r.id && 'text-muted-foreground')}><dt className='font-medium'>{r.label}</dt><dd className='text-muted-foreground text-xs'>{r.help}</dd></div>)}
  </dl>
);

function InviteDialog({ roles, onClose, onSent }: { roles: AccountRoleInfo[]; onClose: () => void; onSent: () => void }) {
  const [email, setEmail] = useState(''), [role, setRole] = useState('member'), [busy, setBusy] = useState(false);
  const send = (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    appApi('POST', '/team/invitations', { email: email.trim(), role })
      .then(() => { toast.success(`Invitation sent to ${email.trim()}`); onSent(); onClose(); }).catch(fail).finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={send} className='grid gap-4'>
          <DialogHeader><DialogTitle>Invite someone</DialogTitle><DialogDescription>They get an email and join this account with the role you pick when they accept.</DialogDescription></DialogHeader>
          <div className='flex gap-2'>
            <Input autoFocus type='email' required placeholder='name@company.com' value={email} onChange={(e) => setEmail(e.target.value)} aria-label='Email' />
            <NativeSelect value={role} onChange={(e) => setRole(e.target.value)} aria-label='Role' className='w-40'>
              {(roles.length ? roles : [{ id: 'member', label: 'Member', help: '' }]).map((r) => <NativeSelectOption key={r.id} value={r.id}>{r.label}</NativeSelectOption>)}
            </NativeSelect>
          </div>
          <RoleLines roles={roles} on={role} />
          <DialogFooter><Button type='button' variant='outline' onClick={onClose}>Cancel</Button><Button type='submit' disabled={busy || !email.trim()}>Send invitation</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const runWord = (v: boolean | null) => (v == null ? 'default' : v ? 'yes' : 'no');

/**
 * One person's limits, one per row: their monthly limit (the default for how the account shares budgets, or their own,
 * in every mode), their adjustment (equal share only), team, launch access (the account's setting, or yes or no) and
 * runs at once (empty: their team's or the account's). Only what was changed is sent, so opening and saving never pins
 * a default onto the person.
 */
function LimitsDialog({ m, lim, l, mode, onClose, onSaved }: { m: Pick<Member, 'user_id' | 'name' | 'email'>; lim: LimitMember; l: Limits; mode: Mode; onClose: () => void; onSaved: () => void }) {
  const init = { team: lim.team_id == null ? '' : String(lim.team_id), run: runWord(lim.own_can_run ?? null), limit: lim.cap_usd == null ? 'default' : 'own', cap: str(lim.cap_usd),
    adjust: lim.adjust_usd ? String(lim.adjust_usd) : '', conc: str(lim.max_concurrent_runs) };
  const [f, setF] = useState(init);
  const p = l.policy;
  // The default, as it stands for this person's budget: the shared pot, their equal share, or the account's set amount.
  const pot = lim.pot == null ? (l as Partial<AdminLimits>).rest : l.teams.find((x) => x.id === lim.pot);
  const byDefault = mode === 'pool' ? 'shared budget, no personal limit' : mode === 'custom' ? `${usd(p.default_cap_usd ?? 0)} for everyone` : `equal share: ${usd(pot?.each_usd ?? 0)}`;
  const team = l.teams.find((x) => String(x.id) === f.team);
  const runsDefault = team?.max_concurrent_runs ?? p.max_concurrent_runs;
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (f.team !== init.team) body.team_id = f.team === '' ? null : Number(f.team);
    if (f.run !== init.run) body.can_run = f.run === 'default' ? null : f.run === 'yes';
    if (f.conc !== init.conc) body.max_concurrent_runs = orNull(f.conc);
    const cap = f.limit === 'own' ? orNull(f.cap) : null;
    if (cap !== lim.cap_usd) body.cap_usd = cap;
    if (mode === 'even' && f.adjust !== init.adjust) body.adjust_usd = orNull(f.adjust) ?? 0;
    if (!Object.keys(body).length) return onClose();
    appApi('PUT', `/limits/members/${encodeURIComponent(m.user_id)}`, body)
      .then(() => { toast.success('Limits saved'); onSaved(); onClose(); }).catch(fail);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={save} className='grid gap-4'>
          <DialogHeader><DialogTitle>Limits for {m.name || m.email}</DialogTitle>
            <DialogDescription>Spent {usd(lim.spent)} this month{lim.limit_usd != null ? ` of ${usd(lim.limit_usd)}` : ''}{lim.left_usd != null ? `, ${usd(lim.left_usd)} left` : ''}.</DialogDescription></DialogHeader>
          <label className='grid gap-1.5 text-sm'>Monthly limit
            <NativeSelect value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} className='w-full'>
              <NativeSelectOption value='default'>Use the default ({byDefault})</NativeSelectOption>
              <NativeSelectOption value='own'>Own limit</NativeSelectOption>
            </NativeSelect>
          </label>
          {f.limit === 'own' && <label className='grid gap-1.5 text-sm'>Own limit ($ a month)<Input type='number' inputMode='decimal' required min={0} step={0.01} value={f.cap} onChange={(e) => setF({ ...f, cap: e.target.value })} /></label>}
          {mode === 'even' && <label className='grid gap-1.5 text-sm'>Adjustment on top of equal share (± $)<Input type='number' inputMode='decimal' step={0.01} value={f.adjust} onChange={(e) => setF({ ...f, adjust: e.target.value })} placeholder='0' /></label>}
          <label className='grid gap-1.5 text-sm'>Team
            <NativeSelect value={f.team} onChange={(e) => setF({ ...f, team: e.target.value })} className='w-full'>
              <NativeSelectOption value=''>No team</NativeSelectOption>
              {l.teams.map((x) => <NativeSelectOption key={x.id} value={String(x.id)}>{x.name}</NativeSelectOption>)}
            </NativeSelect>
          </label>
          <label className='grid gap-1.5 text-sm'>Can launch simulations
            <NativeSelect value={f.run} onChange={(e) => setF({ ...f, run: e.target.value })} className='w-full'>
              <NativeSelectOption value='default'>Use the account setting ({p.new_members_can_run ? 'everyone can launch' : 'only people allowed'})</NativeSelectOption>
              <NativeSelectOption value='yes'>Yes</NativeSelectOption>
              <NativeSelectOption value='no'>No</NativeSelectOption>
            </NativeSelect>
          </label>
          <label className='grid gap-1.5 text-sm'>Runs at once<Input type='number' inputMode='numeric' min={1} step={1} value={f.conc} onChange={(e) => setF({ ...f, conc: e.target.value })}
            placeholder={`Use team or account setting (${runsDefault ?? 'no limit'})`} /></label>
          <DialogFooter><Button type='button' variant='outline' onClick={onClose}>Cancel</Button><Button type='submit'>Save limits</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- budget rules (admins): one table, one row per rule; each row's Edit saves through the existing endpoint ----------

/** A rule's history key on GET /limits `changed` (who last changed it, when): "policy.<field>", "team:<id>", "member:<user id>". */
type PolicyField = keyof Policy;
interface RuleRow { key: string; rule: string; value: string; hint?: string; applies: string; by: string; at: string | null; edit?: () => void; reset?: () => void }
type PolicyEdit = { field: PolicyField; rule: string; kind: 'mode' | 'money' | 'count' | 'bool'; hint: string };

const MODE_WORDS: Record<Mode, string> = { pool: 'Shared pool: anyone can use the whole budget', even: 'Split evenly between the people who can launch',
  custom: 'Custom caps: each person up to the default cap' };
const MODE_OPTIONS: { id: Mode; label: string }[] = [{ id: 'pool', label: 'Shared pool' }, { id: 'even', label: 'Split evenly' }, { id: 'custom', label: 'Custom caps' }];

function Rules({ l, b, reload }: { l: AdminLimits; b: Billing; reload: () => void }) {
  const [policyEdit, setPolicyEdit] = useState<PolicyEdit | null>(null);
  const [teamEdit, setTeamEdit] = useState<LimitTeam | null>(null);
  const [personEdit, setPersonEdit] = useState<LimitMember | null>(null);
  const { lock } = useAccountRole();
  const p = l.policy, ch = l.changed ?? {};
  const who = (k: string) => ch[k] ?? null;
  const policyRow = (field: PolicyField, rule: string, value: string, applies: string, kind: PolicyEdit['kind'], hint: string): RuleRow => {
    const c = who(`policy.${field}`);
    return { key: `policy.${field}`, rule, value, applies, by: c?.by_name ?? 'Default', at: c?.at ?? null, edit: () => setPolicyEdit({ field, rule, kind, hint }) };
  };
  const max = l.server_max_sessions;
  const rows: RuleRow[] = [
    { key: 'allowance', rule: 'Monthly allowance', applies: 'Account', by: profile.name, at: null,
      value: l.budget_error ? "Couldn't load" : l.budget_usd > 0 ? `${usd(l.budget_usd)} a month` : 'No prepaid allowance' },
    // The short label; the sentence is its tooltip (and the dialog's hint).
    { ...policyRow('mode', 'How people share it', MODE_OPTIONS.find((m) => m.id === p.mode)?.label ?? p.mode, 'Each budget', 'mode', 'How the people in each budget share it. Own limits apply in every mode.'), hint: MODE_WORDS[p.mode] },
    policyRow('reserve_usd', 'Held back (buffer)', p.reserve_usd ? usd(p.reserve_usd) : 'None', 'Account', 'money', 'Nobody can launch into this. It absorbs runs that finish past a limit.'),
    ...(p.mode === 'custom' ? [policyRow('default_cap_usd', 'Default cap per person', `${usd(p.default_cap_usd ?? 0)} a month`, 'Each person without their own limit', 'money',
      'The most each person can spend a month. A budget still stops at its total.')] : []),
    policyRow('new_members_can_run', 'New members can launch', p.new_members_can_run ? 'Yes' : 'No', 'Everyone', 'bool',
      "No stops everyone who hasn't been allowed individually, including people already here."),
    policyRow('max_concurrent_runs', 'Runs at once (per person)', p.max_concurrent_runs == null ? 'No limit' : String(p.max_concurrent_runs), 'Each person', 'count',
      'Whole simulations running at once. Teams and people can set their own; the most specific one wins.'),
    policyRow('max_sessions_per_run', 'Sessions per run', p.max_sessions_per_run == null ? `${profile.name}'s maximum${max ? ` (${max})` : ''}` : String(p.max_sessions_per_run), 'Each simulation', 'count',
      `Agent sessions per simulation, adaptive runs included.${max ? ` ${profile.name}'s maximum is ${max}.` : ''}`),
    policyRow('max_run_usd', 'Spend cap per run', p.max_run_usd == null ? 'No limit' : usd(p.max_run_usd), 'Each simulation', 'money',
      'Adaptive runs stop adding sessions once a run reaches this. Sessions already running finish.'),
    ...l.teams.filter((t) => t.budget_usd != null || t.max_concurrent_runs != null).map((t): RuleRow => {
      const c = who(`team:${t.id}`);
      return { key: `team:${t.id}`, rule: t.budget_usd != null ? 'Team budget' : 'Team settings', applies: `${t.name} team`, by: c?.by_name ?? 'Default', at: c?.at ?? null, edit: () => setTeamEdit(t),
        value: [t.budget_usd == null ? "No budget (shares Everyone else's)" : `${usd(t.budget_usd)} a month`, ...(t.max_concurrent_runs != null ? [`${plural(t.max_concurrent_runs, 'run')} at once per person`] : [])].join(' · ') };
    }),
    ...l.members.flatMap((m): RuleRow[] => {
      const words = exceptionWords(m, p);
      if (!words.length) return [];
      const c = who(`member:${m.user_id}`);
      return [{ key: `member:${m.user_id}`, rule: 'Own settings', value: words.join(' · '), applies: m.name || m.email || m.user_id, by: c?.by_name ?? 'Default', at: c?.at ?? null,
        edit: () => setPersonEdit(m),
        reset: () => appApi('PUT', `/limits/members/${encodeURIComponent(m.user_id)}`, { cap_usd: null, adjust_usd: 0, can_run: null, max_concurrent_runs: null })
          .then(() => { toast.success('Back to the defaults'); reload(); }).catch(fail) }];
    })
  ];
  const cols: RecordCol<RuleRow>[] = [
    { key: 'rule', label: 'Rule', keep: true, title: true, type: 'text', value: (r) => r.rule, render: (r) => <span className='font-medium'>{r.rule}</span> },
    { key: 'value', label: 'Value', type: 'text', value: (r) => r.value, render: (r) => <span className='tabular-nums' title={r.hint}>{r.value}</span> },
    { key: 'applies', label: 'Applies to', className: 'w-56', type: 'select', value: (r) => r.applies, render: (r) => <span className='text-muted-foreground'>{r.applies}</span> },
    // Who last changed it, and when on a second line (never for Default or the platform, which have no date). Set by and Last changed stay hidden for filtering, grouping and sorting.
    { key: 'changed', label: 'Changed', className: 'w-48', peek: false, render: (r) => (<>
      <span className={r.by === 'Default' || r.by === profile.name ? 'text-muted-foreground' : ''}>{r.by}</span>
      {r.at && <div className='text-muted-foreground mt-1 text-xs leading-none'><When d={r.at} /></div>}
    </>) },
    { key: 'by', label: 'Set by', className: 'w-48', type: 'select', hidden: true, value: (r) => r.by, render: (r) => <span className={r.by === 'Default' || r.by === profile.name ? 'text-muted-foreground' : ''}>{r.by}</span> },
    { key: 'at', label: 'Last changed', className: 'w-32', type: 'date', hidden: true, value: (r) => r.at ?? undefined,
      render: (r) => <span className='text-muted-foreground text-xs'>{r.at ? <When d={r.at} /> : '—'}</span> }
  ];
  const actions = (r: RuleRow): RowAction[] => [
    ...(r.edit ? [lock({ label: 'Edit', icon: <Icons.edit />, onSelect: r.edit }, 'budget')] : []),
    ...(r.reset ? [lock({ label: 'Reset to defaults', icon: <Icons.close />, separator: true, onSelect: r.reset }, 'budget')] : [])
  ];
  const person = personEdit && { user_id: personEdit.user_id, name: personEdit.name ?? null, email: personEdit.email ?? null };
  return (
    <>
      <RecordView compact id='billing-rules' rows={rows} rowKey={(r) => r.key} cols={cols} noun='rules'
        searchText={(r) => `${r.rule} ${r.value} ${r.applies} ${r.by}`} searchPlaceholder='Search rules'
        actions={actions} exportName='budget-rules' empty='No rules.' />
      {policyEdit && <PolicyDialog e={policyEdit} l={l} b={b} onClose={() => setPolicyEdit(null)} onSaved={reload} />}
      {teamEdit && <TeamDialog team={teamEdit} onClose={() => setTeamEdit(null)} onSaved={reload} />}
      {personEdit && person && <LimitsDialog m={person} lim={personEdit} l={l} mode={p.mode} onClose={() => setPersonEdit(null)} onSaved={reload} />}
    </>
  );
}

/** One account rule: PUT /limits/policy with just that field (the server checks it, as everywhere). */
function PolicyDialog({ e, l, b, onClose, onSaved }: { e: PolicyEdit; l: AdminLimits; b: Billing; onClose: () => void; onSaved: () => void }) {
  const p = l.policy, cur = p[e.field];
  const [v, setV] = useState(e.kind === 'bool' ? (cur ? 'yes' : 'no') : e.kind === 'mode' ? String(cur) : e.field === 'reserve_usd' && !cur ? '' : str(cur as number | null));
  const [cap, setCap] = useState(str(p.default_cap_usd));
  const [busy, setBusy] = useState(false);
  const needCap = e.kind === 'mode' && v === 'custom' && p.default_cap_usd == null;
  const save = (ev: React.FormEvent) => {
    ev.preventDefault();
    const value = e.kind === 'bool' ? v === 'yes' : e.kind === 'mode' ? v : orNull(v);
    const body: Record<string, unknown> = { [e.field]: e.field === 'reserve_usd' ? value ?? 0 : value, ...(needCap ? { default_cap_usd: orNull(cap) } : {}) };
    setBusy(true);
    appApi('PUT', '/limits/policy', body).then(() => { toast.success(`${e.rule} saved`); onSaved(); onClose(); }).catch(fail).finally(() => setBusy(false));
  };
  const placeholder = e.field === 'reserve_usd' ? '0.00' : e.field === 'max_sessions_per_run' ? (l.server_max_sessions ? String(l.server_max_sessions) : '') : 'no limit';
  const allowance = b.budget_usd > 0 ? ` Your allowance is ${usd(b.budget_usd)} a month.` : '';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={save} className='grid gap-4'>
          <DialogHeader><DialogTitle>{e.rule}</DialogTitle><DialogDescription>{e.hint}{e.kind === 'money' ? allowance : ''} Changes apply right away to this month&apos;s spend.</DialogDescription></DialogHeader>
          {e.kind === 'mode' ? (
            <NativeSelect value={v} onChange={(x) => setV(x.target.value)} aria-label={e.rule} className='w-full'>
              {MODE_OPTIONS.map((m) => <NativeSelectOption key={m.id} value={m.id}>{m.label}</NativeSelectOption>)}
            </NativeSelect>
          ) : e.kind === 'bool' ? (
            <NativeSelect value={v} onChange={(x) => setV(x.target.value)} aria-label={e.rule} className='w-full'>
              <NativeSelectOption value='yes'>Yes, everyone on the account</NativeSelectOption>
              <NativeSelectOption value='no'>No, only people allowed individually</NativeSelectOption>
            </NativeSelect>
          ) : (
            <Input autoFocus type='number' inputMode={e.kind === 'money' ? 'decimal' : 'numeric'} min={e.kind === 'money' ? 0 : 1} step={e.kind === 'money' ? 0.01 : 1}
              value={v} onChange={(x) => setV(x.target.value)} placeholder={placeholder} aria-label={e.rule} required={e.field === 'default_cap_usd'} />
          )}
          {needCap && <label className='grid gap-1.5 text-sm'>Default cap per person ($ a month)<Input type='number' inputMode='decimal' required min={0.01} step={0.01} value={cap} onChange={(x) => setCap(x.target.value)} /></label>}
          <DialogFooter><Button type='button' variant='outline' onClick={onClose}>Cancel</Button><Button type='submit' disabled={busy}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Oct 31": the UTC month's dates, like the budget. */
const utcDate = (ms: number, o: Intl.DateTimeFormatOptions) => new Date(ms).toLocaleDateString('en-US', { ...o, timeZone: 'UTC' });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a limit is called beside a person or budget: "Their limit" (to a member, "Your limit"), "Mobile budget". */
function limitedWord(c: LimitCode | null | undefined, teams: { id: number; name: string }[], teamId?: number | null, person = 'Their limit') {
  if (!c) return null;
  const team = teams.find((t) => t.id === teamId)?.name ?? 'Team';
  const words: Record<LimitCode, string> = { no_allowance: 'No allowance', account_cap: 'Allowance', budget_error: 'Allowance', launch_access: "Can't launch",
    person_limit: person, team_budget: `${team} budget`, rest_pot: 'Everyone else', buffer: 'Buffer', runs_at_once: 'Runs at once', run_sessions: 'Sessions per run' };
  return words[c];
}

/** Teams as one full table: budget used against the team cap, what is left, runs at once, people. Add, edit and delete (admins). */
function Teams({ l, reload }: { l: Limits; reload: () => void }) {
  // undefined: closed; null: adding a team.
  const [edit, setEdit] = useState<LimitTeam | null | undefined>(undefined);
  const [removing, setRemoving] = useState<LimitTeam | null>(null);
  const manage = l.can_manage;
  const cols: RecordCol<LimitTeam>[] = [
    { key: 'team', label: 'Team', keep: true, type: 'text', value: (x) => x.name, render: (x) => <span className='font-medium'>{x.name}</span> },
    // Line 1: the bar (or "· no team cap"); line 2: what is left (amber when it limits the team's people).
    { key: 'budget', label: 'Spent', className: 'w-72', type: 'number', value: (x) => x.spent,
      render: (x) => (<>
        {x.budget_usd == null ? <span className='text-xs tabular-nums'>{usd(x.spent)} <span className='text-muted-foreground'>· no team cap</span></span> : <Allowance spent={x.spent} cap={x.budget_usd} />}
        {x.left_usd != null && <div className={cn('text-muted-foreground mt-1 text-xs leading-none tabular-nums', x.limited_by && 'text-amber-700 dark:text-amber-400')}
          title={x.limited_by ? 'Limits its people (90% or more used)' : undefined}>{usd(x.left_usd)} left</div>}
      </>) },
    // The cap and what is left already read in "Spent" ("$x of $cap", "$y left"); kept hidden for sorting, filtering and export.
    { key: 'cap', label: 'Monthly cap', className: 'w-32', hidden: true, type: 'number', value: (x) => x.budget_usd ?? undefined, render: (x) => <span className='tabular-nums'>{x.budget_usd == null ? <span className='text-muted-foreground'>none</span> : usd(x.budget_usd)}</span> },
    { key: 'left', label: 'Left', className: 'w-28', type: 'number', hidden: true, value: (x) => x.left_usd ?? undefined,
      render: (x) => <span className={cn('text-xs tabular-nums', x.limited_by && 'text-amber-700 dark:text-amber-400')} title={x.limited_by ? 'Limits its people (90% or more used)' : undefined}>
        {x.left_usd == null ? <span className='text-muted-foreground'>—</span> : usd(x.left_usd)}</span> },
    { key: 'conc', label: <span title='Per person'>Runs at once</span>, name: 'Runs at once, per person', className: 'w-32', type: 'number', value: (x) => x.max_concurrent_runs ?? undefined,
      render: (x) => <span className='text-xs tabular-nums'>{x.max_concurrent_runs ?? <span className='text-muted-foreground' title='Account default'>—</span>}</span> },
    { key: 'people', label: 'People', className: 'w-20', type: 'number', value: (x) => x.members, render: (x) => <span className={cn('text-xs tabular-nums', !x.members && 'text-muted-foreground')}>{x.members}</span> }
  ];
  return (
    <>
      <RecordView compact id='billing-teams-v2' rows={l.teams} rowKey={(x) => String(x.id)} cols={cols} noun='teams'
        searchText={(x) => x.name} searchPlaceholder='Search teams'
        primary={manage ? <Button onClick={() => setEdit(null)}><Icons.add /> Add team</Button> : undefined}
        actions={manage ? (x) => [
          { label: 'Edit team', icon: <Icons.edit />, onSelect: () => setEdit(x) },
          { label: 'Delete team', icon: <Icons.trash />, destructive: true, separator: true, onSelect: () => setRemoving(x) }
        ] : undefined}
        exportName='teams' empty='No teams: everyone shares the account cap. Put people in teams from their row on People (Edit limits).' />
      {edit !== undefined && <TeamDialog team={edit} onClose={() => setEdit(undefined)} onSaved={reload} />}
      {removing && <DeleteTeam team={removing} l={l} onClose={() => setRemoving(null)} onDeleted={reload} />}
    </>
  );
}

/** Add a team (null), or edit one: an edit sends only what changed, so a rename can't put back a budget someone saved meanwhile. Teams and Budget rules. */
function TeamDialog({ team, onClose, onSaved }: { team: LimitTeam | null; onClose: () => void; onSaved: () => void }) {
  const was = team ? { name: team.name, budget: str(team.budget_usd), conc: str(team.max_concurrent_runs) } : null;
  const [f, setF] = useState(was ?? { name: '', budget: '', conc: '' });
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const body = { ...(!was || f.name !== was.name ? { name: f.name } : {}), ...(!was || f.budget !== was.budget ? { budget_usd: orNull(f.budget) } : {}),
      ...(!was || f.conc !== was.conc ? { max_concurrent_runs: orNull(f.conc) } : {}) };
    (team ? appApi('PUT', `/limits/teams/${team.id}`, body) : appApi('POST', '/limits/teams', body))
      .then(() => { toast.success(team ? 'Team saved' : 'Team added'); onSaved(); onClose(); }).catch(fail);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={save} className='grid gap-4'>
          <DialogHeader><DialogTitle>{team ? 'Edit team' : 'Add a team'}</DialogTitle><DialogDescription>This budget is set aside for the team and is the most it can spend. Leave it empty and the team shares Everyone else&apos;s.</DialogDescription></DialogHeader>
          <label className='grid gap-1.5 text-sm'>Name<Input required autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className='grid gap-1.5 text-sm'>Monthly budget ($)<Input type='number' min={0} step={0.01} value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} placeholder='no cap' /></label>
          <label className='grid gap-1.5 text-sm'>Runs at once, per person<Input type='number' min={1} step={1} value={f.conc} onChange={(e) => setF({ ...f, conc: e.target.value })} placeholder='account default' /></label>
          <DialogFooter><Button type='button' variant='outline' onClick={onClose}>Cancel</Button><Button type='submit'>{team ? 'Save team' : 'Add team'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Before a team is deleted: what it changes, from the preview (the server's allocate() with the team gone). Its people
 * move to Everyone else, their limits there, its budget going back, and who would be blocked right away.
 */
function DeleteTeam({ team, l, onClose, onDeleted }: { team: LimitTeam; l: Limits; onClose: () => void; onDeleted: () => void }) {
  const [pv, setPv] = useState<Preview | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { appApi<Preview>('POST', '/limits/preview', { remove_teams: [team.id] }).then(setPv, () => setFailed(true)); }, [team.id]);
  const ids = new Set(l.members.filter((m) => m.team_id === team.id).map((m) => m.user_id));
  const moved = pv?.members.filter((m) => ids.has(m.user_id)) ?? [];
  const limits = [...new Set(moved.filter((m) => m.can_run && m.limit_source !== 'own').map((m) => m.limit_usd ?? 0))];
  const blocked = pv?.changes.filter((c) => c.blocked_now).length ?? 0;
  const n = ids.size, they = n === 1 ? 'Their limit becomes' : 'Their limits become';
  const lines = [
    n ? `Its ${plural(n, 'person', 'people')} ${n === 1 ? 'moves' : 'move'} to Everyone else.` : 'Nobody is in it.',
    ...(!n || !pv ? [] : pv.policy.mode === 'pool' ? ["They share Everyone else's budget, with no personal limit."]
      : limits.length === 1 ? [`${they} ${usd(limits[0]!)}${n > 1 ? ' each' : ''}.`] : limits.length ? [`${they} ${limits.map(usd).join(', ')}.`] : []),
    ...(moved.some((m) => m.limit_source === 'own') ? ['Own limits stay.'] : []),
    ...(team.budget_usd != null ? [`The ${usd(team.budget_usd)} set aside goes back to Everyone else.`] : []),
    ...(blocked ? [`${plural(blocked, 'person', 'people')} will be blocked right away.`] : [])
  ];
  const remove = () => {
    setBusy(true);
    appApi('DELETE', `/limits/teams/${team.id}`).then(() => { toast.success('Team deleted'); onDeleted(); onClose(); }).catch(fail).finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>Delete team {team.name}?</DialogTitle>
          <DialogDescription>{!pv && !failed ? 'Working out what changes…' : failed ? "We couldn't work out what changes. Its people move to Everyone else." : lines.join(' ')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>Keep team</Button>
          <Button variant='destructive' disabled={busy || (!pv && !failed)} onClick={remove}>{blocked ? `Delete and block ${blocked}` : 'Delete team'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

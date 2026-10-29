'use client';
// Overview: the onboarding funnel for accounts created in a period, and the accounts that need a person.
import { useMemo, useState } from 'react';
import { DateRangePicker, last30, rangeQuery, type DateRange } from '@/components/layout/date-range-picker';
import { Input } from '@/components/ui/input';
import PageContainer from '@/components/layout/page-container';
import { Icons } from '@/components/icons';
import { useAdmin } from './lib';
import { packSteps, sessionEngine } from './engine';
import { StatStrip } from '@/components/layout/section';
import { DataList, ErrorBox, LoadingCards, Notice, Section, StatusBadge, When } from './ui';

interface Overview {
  public_url: string;
  stripe_error?: string;
  requests: { pending: number; approved: number; declined: number; oldest_pending: string | null };
  funnel: { id: string; label: string; reached: number }[];
  attention: { slug: string; name: string; stage_label: string; attention: string[]; contact: string | null; last_seen: string | null }[];
  active_7d: number;
  paying: number;
  trialing: number;
  orgs: number;
  /** One point per day of the period: each card's figure as it stood at the end of that day. */
  daily: { days: string[]; pending: number[]; accounts: number[]; active_7d: number[]; paying: number[]; reported: number[] };
}

export function AdminOverview() {
  const [range, setRange] = useState<DateRange>(last30);
  const [q, setQ] = useState('');
  const { data: o, error, isLoading } = useAdmin<Overview>(`/overview?${rangeQuery(range)}`);
  const attention = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (o?.attention ?? []).filter((a) => words.every((w) => `${a.name} ${a.slug} ${a.contact ?? ''} ${a.stage_label} ${a.attention.join(' ')}`.toLowerCase().includes(w)));
  }, [o, q]);
  const reported = o ? o.funnel[o.funnel.length - 1]?.reached ?? 0 : 0;
  // The funnel's last step: the session engine's report; else the packs' last onboarding step, or the first tool call.
  const last = sessionEngine() ? null : o?.funnel.at(-1)?.id ?? null;
  const lastLabel = sessionEngine() ? 'Reached a report' : last === 'first_call' ? 'Called a tool' : 'Finished onboarding';
  const max = o ? Math.max(1, o.funnel[0]?.reached ?? 1) : 1;
  return (
    <PageContainer pageTitle='Onboarding' pageDescription={sessionEngine() ? 'From access request to first report, across every account.' : packSteps() ? 'From access request to the last onboarding step, across every account.' : 'From access request to the first tool call, across every account.'}>
      <ErrorBox error={error} />
      {isLoading || !o ? (
        <LoadingCards count={5} />
      ) : (
        <div className='flex w-full flex-col gap-8'>
          {o.stripe_error && <Notice>Stripe: {o.stripe_error}</Notice>}
          <StatStrip
            items={[
              { label: 'Pending requests', value: o.requests.pending, href: '/admin/requests', spark: o.daily.pending,
                hint: o.requests.oldest_pending ? <>oldest <When d={o.requests.oldest_pending} /></> : 'inbox clear' },
              { label: 'Accounts', value: o.orgs, spark: o.daily.accounts, hint: `${o.requests.approved} approved, ${o.requests.declined} declined` },
              { label: 'Active in 7 days', value: o.active_7d, spark: o.daily.active_7d, hint: 'called a tool' },
              { label: 'Paying', value: o.paying, spark: o.daily.paying, hint: `${o.trialing || 0} trialing` },
              { label: lastLabel, value: reported, spark: o.daily.reported, hint: o.orgs ? `${Math.round((reported / o.orgs) * 100)}% of accounts` : '' }
            ]}
          />

          <Section title='Funnel' description='Accounts created in the period, by the furthest step they reached. On the right, the share of the step before that stopped short of this one.'
            action={<DateRangePicker value={range} onChange={setRange} />}>
            {/* Labels wrap rather than cut off (mold_v0-170); on a phone each step's label sits on its own line over its bar. */}
            <ol className='grid gap-x-3 gap-y-2.5 sm:gap-y-2'>
              {o.funnel.map((f, idx) => {
                const prev = idx ? o.funnel[idx - 1].reached : f.reached;
                const drop = idx && prev ? Math.round(((prev - f.reached) / prev) * 100) : 0;
                const before = idx ? o.funnel[idx - 1].label : '';
                return (
                  <li key={f.id} className='grid grid-cols-[1fr_3rem_4.5rem] items-center gap-x-3 gap-y-1.5 text-sm sm:grid-cols-[minmax(0,15rem)_1fr_3rem_4.5rem]'>
                    <span className='col-span-3 leading-snug break-words sm:col-span-1'>{f.label}</span>
                    <div className='bg-muted h-6 overflow-hidden rounded-md'>
                      <div className='bg-primary/85 h-full rounded-md transition-all' style={{ width: `${(f.reached / max) * 100}%` }} />
                    </div>
                    <span className='text-right leading-none tabular-nums'>{f.reached}</span>
                    <span className='text-muted-foreground text-right text-xs leading-none tabular-nums'
                      title={drop > 0 ? `${drop}% of the ${prev} that reached ${before} stopped before ${f.label}` : undefined}>
                      {drop > 0 ? <>−{drop}%<span className='sr-only'> of the {prev} that reached {before} stopped before this step</span></> : ''}
                    </span>
                  </li>
                );
              })}
            </ol>
          </Section>

          <Section title='Needs attention' description='Accounts where a person should step in.'>
            <div className='relative'>
              <Icons.search className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
              <Input type='search' value={q} onChange={(e) => setQ(e.target.value)} placeholder='Search accounts, contacts or issues' aria-label='Search accounts needing attention' className='h-9 pl-8' />
            </div>
            <div className='border'>
              <DataList
                noun='accounts'
                minWidth={760}
                height='h-[28rem]'
                rows={attention}
                empty={q ? 'Nothing matches.' : 'Nobody is stuck.'}
                cols={[
                  { label: 'Account', className: 'w-48', render: (a) => <span className='font-medium'>{a.name}</span> },
                  { label: 'Stage', className: 'w-40', render: (a) => <StatusBadge>{a.stage_label}</StatusBadge> },
                  { label: 'Issues', render: (a) => <span className='block max-w-xl truncate text-amber-700 dark:text-amber-400' title={a.attention.join('\n')}>{a.attention.length > 1 ? `${a.attention.length} · ` : ''}{a.attention.join(' · ')}</span> },
                  { label: 'Contact', className: 'w-56', render: (a) => <span className='text-muted-foreground block max-w-56 truncate'>{a.contact ?? '—'}</span> },
                  { label: 'Last seen', className: 'w-28', render: (a) => <When d={a.last_seen} className='text-muted-foreground text-xs' /> }
                ]}
              />
            </div>
          </Section>
        </div>
      )}
    </PageContainer>
  );
}

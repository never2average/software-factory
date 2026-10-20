'use client';
// Overview: the onboarding funnel for accounts created in a period, and the accounts that need a person.
import { useMemo, useState } from 'react';
import { DateRangePicker, last30, rangeQuery, type DateRange } from '@/components/layout/date-range-picker';
import { Input } from '@/components/ui/input';
import PageContainer from '@/components/layout/page-container';
import { Icons } from '@/components/icons';
import { useAdmin } from './lib';
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
  const max = o ? Math.max(1, o.funnel[0]?.reached ?? 1) : 1;
  return (
    <PageContainer pageTitle='Onboarding' pageDescription='From access request to first report, across every account.'>
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
              { label: 'Reached a report', value: reported, spark: o.daily.reported, hint: o.orgs ? `${Math.round((reported / o.orgs) * 100)}% of accounts` : '' }
            ]}
          />

          <Section title='Funnel' description='Accounts created in the period, by the furthest step they reached.'
            action={<DateRangePicker value={range} onChange={setRange} />}>
            <ol className='grid gap-2.5'>
              {o.funnel.map((f, idx) => {
                const prev = idx ? o.funnel[idx - 1].reached : f.reached;
                const drop = idx && prev ? Math.round(((prev - f.reached) / prev) * 100) : 0;
                return (
                  <li key={f.id} className='grid grid-cols-[minmax(0,11rem)_1fr_3rem_3.5rem] items-center gap-3 text-sm leading-none'>
                    <span className='truncate'>{f.label}</span>
                    <div className='bg-muted h-6 overflow-hidden rounded-md'>
                      <div className='bg-primary/85 h-full rounded-md transition-all' style={{ width: `${(f.reached / max) * 100}%` }} />
                    </div>
                    <span className='text-right tabular-nums'>{f.reached}</span>
                    <span className='text-muted-foreground text-right text-xs tabular-nums'>{drop > 0 ? `−${drop}%` : ''}</span>
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
                  { label: 'Issues', render: (a) => <span className='block max-w-xl truncate text-amber-400' title={a.attention.join('\n')}>{a.attention.length > 1 ? `${a.attention.length} · ` : ''}{a.attention.join(' · ')}</span> },
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

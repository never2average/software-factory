'use client';
// One account in full: onboarding timeline, people (Clerk), billing (Stripe), activity, products and runs, legacy keys.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Icons } from '@/components/icons';
import { money, usd } from '@/lib/display-format';
import { cn } from '@/lib/utils';
import { adminApi } from '@/lib/api-client';
import { ACCOUNT_ROLES, accountRoleLabel, accountRoleOf, post, STAGE_LABELS, useAdmin, useAdminAction, type InviteResult, type OrgList } from './lib';
import { Gate } from './role';
import { useResult } from './result-dialog';
import { StatStrip } from '@/components/layout/section';
import { ConfirmButton, copyText, DataList, ErrorBox, Mono, Notice, Section, StatusBadge, SubBadge, When, type Tone } from './ui';
import { profile } from '@/config/profile.generated';
import { KEY_PREFIX } from '@/lib/namespace';
import { W } from '@/lib/vocabulary';
import { sessionEngine } from './engine';

type Detail = any; // GET /orgs/:slug (src/admin.ts orgDetail)
/** An account's pack runs (src/admin.ts accountRuns), in a build without the session engine; null with no job kind. */
export interface AccountRuns {
  word: { one: string; many: string };
  by_kind: { pack: string; kind: string; label: string; total: number; running: number; succeeded: number; failed: number; last_at: string | null; usd: number }[];
  recent: { id: string; pack: string; kind: string; label: string; status: string; error: string | null; created_at: string; ended_at: string | null }[];
}
const day = (d: unknown) => (d ? String(d).slice(0, 10) : '—');

export function AdminAccountDetail({ slug }: { slug: string }) {
  const path = `/orgs/${encodeURIComponent(slug)}`;
  const { data: d, error, isLoading } = useAdmin<Detail>(path);
  const { data: list } = useAdmin<OrgList>('/orgs');
  const result = useResult();
  const labelOf = (k: string) => list?.stages.find((s) => s.id === k)?.label ?? STAGE_LABELS[k] ?? k;
  // The session engine's products and runs (a host pack's), else the packs' runs per job kind (mold_v0-104).
  const engine = sessionEngine() && d?.engine !== false;
  const show = (r: InviteResult, t: string) => result.show(r, t);

  return (
    <PageContainer
      pageTitle={d?.org.name ?? slug}
      pageDescription={d ? `${d.org.slug} · created ${day(d.org.created_at)} · Clerk and Stripe keep the change history (Events).` : 'Loading account…'}
      pageHeaderAction={
        <Link className={buttonVariants({ variant: 'outline' })} href='/admin/accounts'>
          <Icons.chevronLeft className='size-4' /> Accounts
        </Link>
      }
    >
      <ErrorBox error={error} />
      {/* An account that is not there (404) or a refusal: the status page above alone (mold_v0-131), no endless skeleton. */}
      {error && !d ? null : isLoading || !d ? (
        <div className='flex flex-col gap-8'>
          <Skeleton className='h-24' />
          <Skeleton className='h-64' />
        </div>
      ) : (
        <div className='flex w-full flex-col gap-8'>
          {/* Sparklines: the last 30 days (spend: this month), day by day. The stage is under Onboarding, the plan on
              Billing, the people on People. */}
          <StatStrip
            items={[
              { label: 'Calls in 7 days', value: d.org.calls_7d, spark: d.daily?.calls },
              { label: 'Errors in 7 days', value: d.org.errors_7d, spark: d.daily?.errors },
              { label: 'Model spend this month', value: usd(d.org.month_spend_usd), spark: d.daily?.spend, hint: d.org.budget_usd ? `of ${usd(d.org.budget_usd)} budget` : 'no cap' },
              // The session engine's sessions, else the packs' runs (mold_v0-104); neither with zero packs.
              ...(engine ? [{ label: 'Agent sessions, 30 days', value: d.daily ? d.daily.sessions.reduce((a: number, b: number) => a + b, 0) : '—', spark: d.daily?.sessions }]
                : d.runs ? [{ label: `${W.Runs}, 30 days`, value: d.daily?.runs ? d.daily.runs.reduce((a: number, b: number) => a + b, 0) : '—', spark: d.daily?.runs }] : [])
            ]}
          />

          <Section title='Onboarding' description={<>Stage: <span className='text-foreground font-medium'>{d.org.stage_label}</span> · next: {d.org.next_step}</>} action={<Rename path={path} name={d.org.name} />}>
            <ol className='grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8'>
              {Object.keys(d.org.reached).map((k) => (
                <li
                  key={k}
                  className={cn('border-l-2 py-1 pl-3 text-xs', d.org.reached[k] ? 'border-primary' : 'border-muted text-muted-foreground')}
                >
                  <div className='flex items-center gap-1 font-medium text-foreground'>
                    {d.org.reached[k] ? <Icons.circleCheck className='text-primary size-3.5' /> : <Icons.circle className='size-3.5 opacity-40' />}
                    {labelOf(k)}
                  </div>
                  <div className='mt-0.5'>{d.org.reached[k] ? <When d={d.org.reached[k]} /> : 'not yet'}</div>
                </li>
              ))}
            </ol>
            {d.org.attention.length > 0 && (
              <div className='mt-4'>
                <Notice>
                  <b>Needs attention</b>
                  <ul className='mt-1 list-disc pl-5'>
                    {d.org.attention.map((a: string) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                </Notice>
              </div>
            )}
          </Section>

          <Tabs defaultValue='people'>
            <div className='-mx-4 overflow-x-auto px-4'>
              <TabsList>
                <TabsTrigger value='people'>People</TabsTrigger>
                <TabsTrigger value='billing'>Billing</TabsTrigger>
                <TabsTrigger value='activity'>Activity</TabsTrigger>
                {engine ? <TabsTrigger value='products'>Products & runs</TabsTrigger> : d.runs && <TabsTrigger value='runs'>{W.Runs}</TabsTrigger>}
                <TabsTrigger value='keys'>Legacy keys</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value='people'>
              <People d={d} path={path} onResult={show} />
            </TabsContent>
            <TabsContent value='billing'>
              <Billing d={d} path={path} />
            </TabsContent>
            <TabsContent value='activity'>
              <Activity d={d} />
            </TabsContent>
            {engine ? (
              <TabsContent value='products'>
                <Products d={d} />
              </TabsContent>
            ) : d.runs && (
              <TabsContent value='runs'>
                <PackRuns runs={d.runs} />
              </TabsContent>
            )}
            <TabsContent value='keys'>
              <Keys d={d} path={path} onResult={show} />
            </TabsContent>
          </Tabs>
        </div>
      )}
      {result.dialog}
    </PageContainer>
  );
}

function Rename({ path, name }: { path: string; name: string }) {
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name]);
  const rename = useAdminAction(() => adminApi('PATCH', path, { name: v }), { success: 'Renamed' });
  return (
    <form
      className='flex gap-2'
      onSubmit={(e) => {
        e.preventDefault();
        rename.mutate();
      }}
    >
      <Input value={v} onChange={(e) => setV(e.target.value)} className='h-8 w-44 sm:w-56' aria-label='Account name' />
      <Gate need='accounts'><Button variant='outline' type='submit' disabled={rename.isPending || v.trim() === name || !v.trim()}>
        Rename
      </Button></Gate>
    </form>
  );
}

const inviteTone = (s: string): Tone => (s === 'accepted' ? 'ok' : s === 'pending' ? 'info' : s === 'expired' ? 'warn' : 'neutral');

function People({ d, path, onResult }: { d: Detail; path: string; onResult: (r: InviteResult, t: string) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const link = useAdminAction(() => post(`${path}/clerk`), { success: 'Moved to Clerk: invite people by email now' });
  const invite = useAdminAction(() => post<InviteResult>(`${path}/invitations`, { email: email.trim(), role }));
  const member = useAdminAction(({ id, action }: { id: string; action: 'deactivate' | 'reactivate' }) => post(`${path}/members/${encodeURIComponent(id)}/${action}`), {
    success: 'Updated'
  });
  const setMemberRole = useAdminAction(({ id, role }: { id: string; role: string }) => post(`${path}/members/${encodeURIComponent(id)}/role`, { role }), {
    success: 'Role changed'
  });
  const inv = useAdminAction(({ id, action }: { id: string; action: 'resend' | 'revoke' }) => post(`${path}/invitations/${encodeURIComponent(id)}/${action}`), {
    success: (r) => (r ? 'Invitation resent' : 'Invitation revoked')
  });
  const clerkOn = d.integrations.clerk ?? d.integrations.workos;
  const linked = d.org.clerk_org_id ?? d.org.workos_org_id;

  if (!linked)
    return (
      <Section title='People'>
        {clerkOn ? (
          <div className='grid gap-3'>
            <p className='text-muted-foreground text-sm'>
              This account predates Clerk: people connect with key links. Move it to Clerk to invite people by email and let them sign in.
            </p>
            <div>
              <Gate need='accounts'><Button disabled={link.isPending} onClick={() => link.mutate()}>
                Move to Clerk
              </Button></Gate>
            </div>
          </div>
        ) : (
          <p className='text-muted-foreground text-sm'>
            Clerk is off (<Mono>CLERK_SECRET_KEY</Mono>). People connect with the legacy key links.
          </p>
        )}
      </Section>
    );

  const submitInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    invite.mutate(undefined, {
      onSuccess: (r) => {
        setEmail('');
        onResult(r, `Invited to ${r.org.name}`);
      }
    });
  };
  const members = d.members ?? [];
  const invitations = d.invitations ?? [];
  return (
    <div className='flex flex-col gap-8'>
      {(d.clerk_error || d.workos_error) && <Notice>Clerk: {d.clerk_error || d.workos_error}</Notice>}
      <Section
        title='Members'
        description='Suspending someone stops their sign-ins and connector calls; tokens already issued expire within minutes.'
        action={
          d.clerk_dashboard ? (
            <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={d.clerk_dashboard} target='_blank' rel='noopener noreferrer'>
              Open in Clerk <Icons.externalLink className='size-3.5' />
            </a>
          ) : null
        }
      >
        <DataList
          rows={members}
          empty='Nobody has joined yet.'
          cols={[
            {
              label: 'Person',
              render: (m: any) => (
                <>
                  <div className='font-medium'>{m.email || m.user_id}</div>
                  {m.name && <div className='text-muted-foreground text-xs'>{m.name}</div>}
                </>
              )
            },
            {
              label: 'Role',
              render: (m: any) => (
                <Gate need='accounts'><NativeSelect
                  size='sm'
                  value={accountRoleOf(m)}
                  disabled={setMemberRole.isPending}
                  onChange={(e) => setMemberRole.mutate({ id: m.id, role: e.target.value })}
                  aria-label={`Role for ${m.email || m.user_id}`}
                >
                  {ACCOUNT_ROLES.map((r) => <NativeSelectOption key={r.id} value={r.id}>{r.label}</NativeSelectOption>)}
                </NativeSelect></Gate>
              )
            },
            {
              label: 'Status',
              render: (m: any) => <StatusBadge tone={m.status === 'active' ? 'ok' : m.status === 'inactive' ? 'bad' : 'info'}>{m.status === 'inactive' ? 'suspended' : m.status}</StatusBadge>
            },
            { label: 'Joined', render: (m: any) => <When d={m.created_at} /> },
            {
              label: '',
              key: 'act',
              className: 'text-right',
              render: (m: any) =>
                m.status === 'active' ? (
                  <Gate need='accounts'><ConfirmButton
                    label='Suspend'
                    variant='destructive'
                    title={`Suspend ${m.email || m.user_id}?`}
                    description={`They can no longer use ${profile.name} in this account until you restore access.`}
                    confirmLabel='Suspend'
                    onConfirm={() => member.mutate({ id: m.id, action: 'deactivate' })}
                  /></Gate>
                ) : m.status === 'inactive' ? (
                  <Gate need='accounts'><Button variant='outline' size='sm' onClick={() => member.mutate({ id: m.id, action: 'reactivate' })}>
                    Restore
                  </Button></Gate>
                ) : null
            }
          ]}
        />
        <form onSubmit={submitInvite} className='mt-4 flex flex-wrap gap-2'>
          <Input type='email' required placeholder='colleague@company.com' className='w-full sm:w-72' value={email} onChange={(e) => setEmail(e.target.value)} aria-label='Email to invite' />
          <NativeSelect value={role} onChange={(e) => setRole(e.target.value)} aria-label='Role'>
            {ACCOUNT_ROLES.map((r) => <NativeSelectOption key={r.id} value={r.id}>{r.label}</NativeSelectOption>)}
          </NativeSelect>
          <Gate need='invite'><Button type='submit' disabled={invite.isPending}>
            <Icons.send className='size-3.5' /> Invite
          </Button></Gate>
        </form>
      </Section>
      {invitations.length > 0 && (
        <Section title='Invitations'>
          <DataList
            rows={invitations}
            empty=''
            cols={[
              { label: 'Email', render: (x: any) => x.email },
              { label: 'Role', render: (x: any) => accountRoleLabel(x) },
              { label: 'State', render: (x: any) => <StatusBadge tone={inviteTone(x.state)}>{x.state}</StatusBadge> },
              { label: 'Sent', render: (x: any) => <When d={x.created_at} /> },
              { label: 'Expires', render: (x: any) => (x.state === 'pending' && x.expires_at ? <When d={x.expires_at} /> : <span className='text-muted-foreground'>—</span>) },
              {
                label: '',
                key: 'act',
                className: 'text-right',
                render: (x: any) => (
                  <div className='flex justify-end gap-2'>
                    {(x.state === 'pending' || x.state === 'expired') && (
                      <Gate need='invite'><Button variant='outline' size='sm' onClick={() => inv.mutate({ id: x.id, action: 'resend' })}>
                        Resend
                      </Button></Gate>
                    )}
                    {x.state === 'pending' && (
                      <Gate need='invite'><ConfirmButton
                        label='Revoke'
                        variant='destructive'
                        title={`Revoke the invitation for ${x.email}?`}
                        description='The link in their email stops working.'
                        confirmLabel='Revoke'
                        onConfirm={() => inv.mutate({ id: x.id, action: 'revoke' })}
                      /></Gate>
                    )}
                  </div>
                )
              }
            ]}
          />
        </Section>
      )}
      <p className='text-muted-foreground text-xs'>Enterprise SSO (SAML / OIDC) for an account is set up on its organization in the Clerk dashboard.</p>
    </div>
  );
}

function Billing({ d, path }: { d: Detail; path: string }) {
  const [plan, setPlan] = useState<string>(d.plans?.[0]?.price_id ?? '');
  const checkout = useAdminAction(() => post<{ url: string }>(`${path}/billing/checkout`, { price_id: plan }));
  const portal = useAdminAction(() => post<{ url: string }>(`${path}/billing/portal`));
  if (!d.integrations.stripe)
    return (
      <Section title='Billing'>
        <p className='text-muted-foreground text-sm'>
          Stripe is off (<Mono>STRIPE_SECRET_KEY</Mono>). The account gets the default budget of {usd(d.org.budget_usd)} a month.
        </p>
      </Section>
    );
  const s = d.org.subscription;
  return (
    <div className='flex flex-col gap-8'>
      <Section
        title='Plan'
        action={
          d.stripe_dashboard ? (
            <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={d.stripe_dashboard} target='_blank' rel='noopener noreferrer'>
              Open in Stripe <Icons.externalLink className='size-3.5' />
            </a>
          ) : null
        }
      >
        <div className='flex flex-wrap items-center gap-x-4 gap-y-2 text-sm'>
          <SubBadge sub={s} />
          {s?.renews_at && (
            <span>
              {s.cancel_at_period_end ? <StatusBadge tone='warn' className='mr-1'>cancels</StatusBadge> : 'renews '}
              {day(s.renews_at)}
            </span>
          )}
          {s?.trial_end && <span>trial ends {day(s.trial_end)}</span>}
          <span className='text-muted-foreground'>
            {usd(d.org.month_spend_usd)} of {d.org.budget_usd ? usd(d.org.budget_usd) : 'no cap'} model spend this month
          </span>
        </div>
        <div className='mt-4 flex flex-wrap gap-2'>
          {d.plans.length ? (
            <>
              <NativeSelect value={plan} onChange={(e) => setPlan(e.target.value)} aria-label='Plan'>
                {d.plans.map((p: any) => (
                  <NativeSelectOption key={p.price_id} value={p.price_id}>
                    {p.name}
                    {p.amount != null ? ` · ${money(p.amount, p.currency)}${p.interval ? `/${p.interval}` : ''}` : ''}
                    {p.monthly_budget_usd != null ? ` · ${usd(p.monthly_budget_usd)} budget` : ''}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Gate need='accounts'><Button variant='outline' disabled={checkout.isPending} onClick={() => checkout.mutate(undefined, { onSuccess: (r) => copyText(r.url, 'Checkout link copied') })}>
                Copy checkout link
              </Button></Gate>
            </>
          ) : (
            <span className='text-muted-foreground text-sm'>
              No plans: add Stripe prices with a lookup_key starting <Mono>{KEY_PREFIX}</Mono>.
            </span>
          )}
          <Gate need='accounts'><Button variant='outline' disabled={portal.isPending} onClick={() => portal.mutate(undefined, { onSuccess: (r) => window.open(r.url, '_blank', 'noopener') })}>
            Open billing portal
          </Button></Gate>
        </div>
      </Section>
      <Section title='Invoices'>
        <DataList
          rows={d.invoices}
          empty='No invoices yet.'
          minWidth={480}
          cols={[
            { label: 'Invoice', render: (x: any) => x.number || x.id },
            { label: 'Status', render: (x: any) => <StatusBadge tone={x.status === 'paid' ? 'ok' : x.status === 'open' ? 'warn' : 'neutral'}>{x.status}</StatusBadge> },
            { label: 'Total', render: (x: any) => money(x.total, x.currency) },
            { label: 'Date', render: (x: any) => day(x.created) },
            {
              label: '',
              key: 'v',
              render: (x: any) =>
                x.url ? (
                  <a className='text-primary text-sm underline-offset-4 hover:underline' href={x.url} target='_blank' rel='noopener noreferrer'>
                    View
                  </a>
                ) : null
            }
          ]}
        />
      </Section>
    </div>
  );
}

function Activity({ d }: { d: Detail }) {
  return (
    <div className='grid gap-8 lg:grid-cols-2 lg:gap-12'>
      <Section title='Tool use' className='lg:col-span-2' description={d.clients.length ? `Clients: ${d.clients.map((c: any) => `${c.client} (${c.n})`).join(', ')}` : undefined}>
        <DataList
          rows={d.tools}
          empty='No tool calls yet.'
          minWidth={520}
          cols={[
            { label: 'Tool', render: (t: any) => <Mono>{t.name}</Mono> },
            { label: 'Calls', render: (t: any) => t.calls },
            { label: 'Errors', render: (t: any) => (Number(t.errors) ? <StatusBadge tone='bad'>{t.errors}</StatusBadge> : '0') },
            { label: 'Avg', render: (t: any) => (t.avg_ms != null ? `${t.avg_ms} ms` : '') },
            { label: 'Last', render: (t: any) => <When d={t.last} /> }
          ]}
        />
      </Section>
      {d.errors.length > 0 && (
        <Section title='Recent errors' className='lg:col-span-2'>
          <DataList
            rows={d.errors}
            empty=''
            minWidth={520}
            cols={[
              { label: 'When', render: (e: any) => <When d={e.at} /> },
              { label: 'Call', render: (e: any) => <Mono>{e.name || e.method}</Mono> },
              { label: 'Error', render: (e: any) => <span className='text-sm'>{e.error}</span> }
            ]}
          />
        </Section>
      )}
    </div>
  );
}

function Products({ d }: { d: Detail }) {
  return (
    <div className='flex flex-col gap-8'>
      <Section title='Onboarding research'>
        <DataList
          rows={d.research}
          empty={d.products.length ? `Products were added directly, without onboarding research: ${d.products.map((p: any) => p.name).join(', ')}` : 'No product onboarded yet.'}
          minWidth={520}
          cols={[
            { label: 'Product', render: (r: any) => r.product },
            {
              label: 'Onboarding',
              render: (r: any) => (
                <span className='inline-flex items-center gap-1.5'>
                  <StatusBadge tone={r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'bad' : 'info'}>{r.status}</StatusBadge>
                  {r.stage && r.status === 'running' && <span className='text-muted-foreground text-xs'>{r.stage}</span>}
                </span>
              )
            },
            { label: 'Started', render: (r: any) => <When d={r.created_at} /> },
            // Only errors fill it: shown when a row has one, as in the accounts peek.
            ...(d.research.some((r: any) => r.error) ? [{ label: 'Detail', render: (r: any) => <span className='text-sm'>{r.error || ''}</span> }] : [])
          ]}
        />
      </Section>
      <Section title={W.Runs}>
        <DataList
          rows={d.simulations}
          empty={`No ${W.runs} yet.`}
          minWidth={520}
          cols={[
            { label: W.Run, render: (s: any) => s.name },
            { label: 'Status', render: (s: any) => <StatusBadge tone={s.status === 'completed' ? 'ok' : s.status === 'cancelled' ? 'neutral' : 'info'}>{s.status}</StatusBadge> },
            { label: 'Sessions', render: (s: any) => `${s.completed} / ${s.sessions}` },
            { label: 'Started', render: (s: any) => <When d={s.created_at} /> }
          ]}
        />
      </Section>
    </div>
  );
}

/** The account's pack runs (src/admin.ts accountRuns): per job kind, in the pack's words, then the latest. */
export function PackRuns({ runs }: { runs: AccountRuns }) {
  const tone = (s: string): Tone => (s === 'succeeded' ? 'ok' : s === 'failed' ? 'bad' : s === 'cancelled' ? 'neutral' : 'info');
  return (
    <div className='flex flex-col gap-8'>
      <Section title={`${runs.word.many} by kind`}>
        <DataList
          rows={runs.by_kind}
          empty={`No ${runs.word.many.toLowerCase()} yet.`}
          minWidth={520}
          cols={[
            { label: 'Kind', render: (k) => k.label },
            { label: runs.word.many, render: (k) => <span className='tabular-nums'>{k.total}</span> },
            { label: 'Succeeded', render: (k) => <span className='tabular-nums'>{k.succeeded}</span> },
            { label: 'Failed', render: (k) => (k.failed ? <span className='text-destructive tabular-nums'>{k.failed}</span> : <span className='tabular-nums'>0</span>) },
            { label: 'Spend', render: (k) => <span className='tabular-nums'>{usd(k.usd)}</span> },
            { label: 'Last', render: (k) => <When d={k.last_at} /> }
          ]}
        />
      </Section>
      <Section title={`Latest ${runs.word.many.toLowerCase()}`}>
        <DataList
          rows={runs.recent}
          empty={`No ${runs.word.many.toLowerCase()} yet.`}
          minWidth={520}
          cols={[
            { label: runs.word.one, render: (r) => <span className='flex flex-col'><span>{r.label}</span><Mono>{r.id}</Mono></span> },
            { label: 'Status', render: (r) => <StatusBadge tone={tone(r.status)}>{r.status}</StatusBadge> },
            { label: 'Started', render: (r) => <When d={r.created_at} /> },
            ...(runs.recent.some((r) => r.error) ? [{ label: 'Detail', render: (r: AccountRuns['recent'][number]) => <span className='text-sm'>{r.error || ''}</span> }] : [])
          ]}
        />
      </Section>
    </div>
  );
}

function Keys({ d, path, onResult }: { d: Detail; path: string; onResult: (r: InviteResult, t: string) => void }) {
  const [label, setLabel] = useState('');
  const issue = useAdminAction(() => post<InviteResult>(`${path}/keys`, { label: label.trim() || undefined }));
  const rotate = useAdminAction((id: number) => post<InviteResult>(`${path}/keys/${id}/rotate`));
  const revoke = useAdminAction((id: number) => post(`${path}/keys/${id}/revoke`), { success: 'Key revoked' });
  const active = d.keys.filter((k: any) => !k.revoked_at).length;
  return (
    <Section
      title={`Legacy API keys (${active} active)`}
      description='API keys from before Clerk sign-in, for clients that send a header (never in the URL). One per person.'
    >
      <DataList
        rows={d.keys}
        empty='No keys.'
        cols={[
          { label: 'Label', render: (k: any) => k.label },
          { label: 'Key', render: (k: any) => <Mono>{k.key_prefix}…</Mono> },
          { label: 'Created', render: (k: any) => <When d={k.created_at} /> },
          { label: 'Last used', render: (k: any) => <When d={k.last_used_at} /> },
          {
            label: '',
            key: 'act',
            className: 'text-right',
            render: (k: any) =>
              k.revoked_at ? (
                <StatusBadge>
                  revoked <When d={k.revoked_at} />
                </StatusBadge>
              ) : (
                <div className='flex justify-end gap-2'>
                  <Gate need='delete'><ConfirmButton
                    label='Rotate'
                    title='Rotate this key?'
                    description='The current link stops working now and a new one is shown once.'
                    confirmLabel='Rotate'
                    onConfirm={() => rotate.mutate(k.id, { onSuccess: (r) => onResult(r, `Rotated key for ${r.org.name}`) })}
                  /></Gate>
                  <Gate need='delete'><ConfirmButton
                    label='Revoke'
                    variant='destructive'
                    title={`Revoke the key for ${k.label}?`}
                    description='Their connector stops working immediately.'
                    confirmLabel='Revoke'
                    onConfirm={() => revoke.mutate(k.id)}
                  /></Gate>
                </div>
              )
          }
        ]}
      />
      <form
        className='mt-4 flex flex-wrap gap-2'
        onSubmit={(e) => {
          e.preventDefault();
          issue.mutate(undefined, {
            onSuccess: (r) => {
              setLabel('');
              onResult(r, `New key for ${r.org.name}`);
            }
          });
        }}
      >
        <Input placeholder='Email or a label' className='w-full sm:w-72' value={label} onChange={(e) => setLabel(e.target.value)} aria-label='Key label' />
        <Gate need='accounts'><Button variant='outline' type='submit' disabled={issue.isPending}>
          Issue key
        </Button></Gate>
      </form>
    </Section>
  );
}

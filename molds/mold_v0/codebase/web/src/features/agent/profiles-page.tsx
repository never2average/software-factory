'use client';
// Admin › Agent profiles (mold_v0-261, flag agent_harness; src/agent-routes.ts /api/admin/onboarding/agent-profiles,
// src/agent-profiles.ts): named sets of what a workspace agent session runs with. The list is the standard one (four
// cards, the search row with New profile, the table); a row opens the profile's own page, laid out as a record's page
// (mold_v0-253: a header with its name, badges, facts and actions, then tabs of full-width cards): its instructions, its
// model and limits, which of the app's tools run freely, ask first or are hidden, its web access, the files it gives a
// session's workspace, who may start it, its per-workspace overrides, and every version and change (who, before, after).
// New profile and Edit open their form in the side panel (flag side_panel_forms; Open full page keeps what was typed),
// else as the full in-page card. Every setting a profile leaves unset is the platform setting in force (Agent
// configuration); the Default profile leaves them all unset. Platform staff with the Operator role or more change them.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { useQueryState } from 'nuqs';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { adminApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { ConfirmDialog, ErrorBox, LoadingCards, When } from '@/features/admin/ui';
import { useAdmin, useAdminAction } from '@/features/admin/lib';
import { Gate, useAdminRole } from '@/features/admin/role';
import { copyWithToast, ToneBadge } from '@/features/records/detail-page';
import { ActionCard, CardForm, FormHost, ToolbarAction, useActionOpen } from '@/features/tabs/tab-action';

type ToolsBase = 'reads' | 'reads_and_named' | 'all' | 'none';
type WebTools = 'off' | 'fetch' | 'search';
type Role = 'member' | 'billing' | 'owner';
export interface ProfileConfig {
  instructions?: { append_system?: string | null; on_start?: string | null; on_resume?: string | null };
  model?: string | null; provider?: string | null; budget_usd?: number | null; ceiling_usd?: number | null; max_turns?: number | null; wake_max_minutes?: number | null;
  tools?: { base?: 'reads' | 'all' | 'none' | null; free?: string[]; ask?: string[]; hidden?: string[] };
  web?: { tools?: WebTools | null; hosts?: string[] | null };
  files?: { path: string; content: string }[];
  roles?: Role[] | null;
  overrides?: { workspace: string; budget_usd?: number; ceiling_usd?: number; model?: string }[];
}
interface Summary {
  id: string; name: string; description: string; version: number; status: 'active' | 'archived'; source: 'platform' | 'pack'; pack: string | null; is_default: boolean;
  model: string; budget_usd: number; ceiling_usd: number; roles: Role[]; tools: { base: ToolsBase; free: number; ask: number; hidden: number };
  web: WebTools; files: number; overrides: number; sessions: number; updated_at: string; updated_by: string;
}
type From = 'profile' | 'workspace' | 'setting';
interface Effective {
  model: string; provider: string; budget_usd: number; ceiling_usd: number; max_turns: number; wake_max_minutes: number;
  web: { tools: WebTools; hosts: string[] }; tools: { base: ToolsBase; free: string[]; ask: string[]; hidden: string[] }; roles: Role[];
  instructions: { append_system: string | null; on_start: string | null; on_resume: string | null }; files: { path: string; content: string }[];
  from: Record<'model' | 'provider' | 'budget_usd' | 'ceiling_usd' | 'max_turns' | 'wake_max_minutes' | 'web' | 'tools' | 'roles', From>;
}
interface Change { id: number; version: number; action: 'created' | 'edited' | 'archived' | 'restored'; by: string; at: string; before: Snapshot | null; after: Snapshot; changed: string[] }
interface Snapshot { name: string; description: string; status: string; config: ProfileConfig }
interface Detail extends Summary {
  config: ProfileConfig; effective: Effective; created_at: string; created_by: string; archived_at: string | null;
  versions: { version: number; name: string; by: string; at: string }[]; changes: Change[];
}
interface Facts {
  models: string[]; tools: { name: string; title: string | null; read: boolean }[]; workspaces: { slug: string; name: string }[]; roles: Role[];
  settings: { model: string; provider: string; budget_usd: number; ceiling_usd: number; max_turns: number; wake_max_minutes: number; web: { tools: WebTools; hosts: string[] }; tools: { base: ToolsBase; free: string[] } };
}
interface ListAnswer extends Facts { profiles: Summary[] }

const BASE = '/admin/agent-profiles';
const usd = (n: number) => `$${n.toFixed(2)}`;
const ROLE_WORDS: Record<Role, string> = { member: 'Members', billing: 'Billing managers', owner: 'Owners' };
const rolesWords = (rs: readonly Role[]) => (rs.length === 3 ? 'Members, billing managers and owners' : rs.map((r, i) => (i ? ROLE_WORDS[r].toLowerCase() : ROLE_WORDS[r])).join(' and '));
const BASE_WORDS: Record<ToolsBase, string> = { reads: 'Reads freely, asks before a change', reads_and_named: 'Reads and the named tools freely, asks before any other change', all: 'Every tool freely', none: 'Asks before every tool' };
const WEB_WORDS: Record<WebTools, string> = { off: 'Off', fetch: 'Reads allowed hosts', search: 'Searches and reads allowed hosts' };
const ACTION_WORDS: Record<Change['action'], string> = { created: 'Created', edited: 'Edited', archived: 'Archived', restored: 'Restored' };
const KEY_WORDS: Record<string, string> = {
  name: 'Name', description: 'Description', status: 'Status', instructions: 'Instructions', model: 'Model', provider: 'Provider', budget_usd: 'Budget', ceiling_usd: 'Ceiling',
  max_turns: 'Turns per wake', wake_max_minutes: 'Longest wake', tools: 'Tools', web: 'Web access', files: 'Files', roles: 'Who may start it', overrides: 'Workspace overrides'
};
const fromWords = (f: From) => (f === 'setting' ? 'Platform setting' : f === 'workspace' ? "This workspace's override" : 'Set in this profile');

// ---------------------------------------------------------------- the list

/** Admin › Agent profiles: the four cards, the search row with New profile, the table; a row opens the profile's page. */
export function AgentProfilesPage() {
  const router = useRouter();
  const { data, error, isLoading } = useAdmin<ListAnswer>(BASE.replace('/admin', ''));
  const [creating, setCreating] = useActionOpen('new');
  const rows = data?.profiles ?? [];
  const cols: RecordCol<Summary>[] = [
    { key: 'name', label: 'Profile', title: true, keep: true, type: 'text', className: 'min-w-60', value: (p) => p.name,
      render: (p) => <span className='flex min-w-0 flex-col gap-1'><span className='leading-snug font-medium'>{p.name}</span>{p.description && <span className='text-muted-foreground line-clamp-2 text-xs whitespace-normal'>{p.description}</span>}</span> },
    { key: 'status', label: 'Status', type: 'select', keep: true, options: [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }], value: (p) => p.status, render: (p) => <StatusBadges p={p} /> },
    { key: 'model', label: 'Model', type: 'text', value: (p) => p.model, render: (p) => <span className='font-mono text-xs'>{p.model}</span> },
    { key: 'budget', label: 'Budget', type: 'number', value: (p) => p.budget_usd, render: (p) => <span className='tabular-nums'>{usd(p.budget_usd)} <span className='text-muted-foreground'>up to {usd(p.ceiling_usd)}</span></span> },
    { key: 'roles', label: 'Who may start it', type: 'text', value: (p) => rolesWords(p.roles), render: (p) => rolesWords(p.roles) },
    { key: 'tools', label: 'App tools', type: 'text', value: (p) => BASE_WORDS[p.tools.base], render: (p) => <span className='flex flex-col gap-0.5'><span>{BASE_WORDS[p.tools.base]}</span>
      {(p.tools.free + p.tools.ask + p.tools.hidden > 0) && <span className='text-muted-foreground text-xs'>{[p.tools.free && `${p.tools.free} free`, p.tools.ask && `${p.tools.ask} ask first`, p.tools.hidden && `${p.tools.hidden} hidden`].filter(Boolean).join(' · ')}</span>}</span> },
    { key: 'sessions', label: 'Sessions', type: 'number', value: (p) => p.sessions, render: (p) => <span className='tabular-nums'>{p.sessions.toLocaleString('en')}</span> },
    { key: 'version', label: 'Version', type: 'number', value: (p) => p.version, render: (p) => <span className='tabular-nums'>{p.version}</span> },
    { key: 'updated', label: 'Changed', type: 'date', keep: true, value: (p) => p.updated_at, render: (p) => <When d={p.updated_at} /> }
  ];
  const active = rows.filter((p) => p.status === 'active');
  return (
    <PageContainer>
      <ErrorBox error={error} />
      <FormHost panel card={creating && data ? (
        <ActionCard open onOpenChange={setCreating} title='New profile' description='A named set of what a session runs with. Anything you leave unset is the platform setting in force (Agent configuration). Saved as version 1.'>
          <ProfileForm facts={data} onDone={(id) => { setCreating(false); if (id) router.push(`${BASE}/${encodeURIComponent(id)}`); }} />
        </ActionCard>
      ) : null}>
        <RecordView<Summary>
          id='admin-agent-profiles' noun={rows.length === 1 ? 'profile' : 'profiles'} loading={isLoading}
          rows={rows} rowKey={(p) => p.id} cols={cols} openKey={null} onOpenChange={(k) => { if (k) router.push(`${BASE}/${encodeURIComponent(k)}`); }} detail={() => null}
          defaultSort={[{ key: 'name', dir: 'asc' }]}
          summary={<StatStrip quad items={[
            { label: 'Active profiles', value: active.length, said: `${active.length} active profiles` },
            { label: 'From packs', value: rows.filter((p) => p.source === 'pack').length, said: `${rows.filter((p) => p.source === 'pack').length} profiles brought by the app's packs` },
            { label: 'Archived', value: rows.length - active.length, said: `${rows.length - active.length} archived profiles` },
            { label: 'Sessions started', value: rows.reduce((t, p) => t + p.sessions, 0).toLocaleString('en'), said: `${rows.reduce((t, p) => t + p.sessions, 0)} sessions started with these profiles` }
          ]} />}
          searchText={(p) => `${p.name} ${p.id} ${p.description} ${p.model} ${p.pack ?? ''} ${p.status}`} searchPlaceholder='Search profiles'
          toolbarAction={<div className='ml-auto flex shrink-0 gap-2'><Gate need='compute'><ToolbarActionGate label='New profile' onClick={() => setCreating(true)} /></Gate></div>}
          exportName='agent-profiles'
          empty={<p className='text-muted-foreground text-sm'>No profiles yet: the Default profile appears once the workspace agent is used.</p>}
        />
      </FormHost>
    </PageContainer>
  );
}

/** The search row's primary button, disabled (by Gate) for a role that may not change profiles. */
function ToolbarActionGate({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return disabled ? <Button disabled aria-label={label} title={label} className='ml-auto shrink-0 max-sm:w-8 max-sm:px-0'><Icons.add /><span className='hidden sm:inline'>{label}</span></Button>
    : <ToolbarAction label={label} icon={<Icons.add />} onClick={onClick} />;
}

function StatusBadges({ p }: { p: Pick<Summary, 'status' | 'is_default' | 'source' | 'pack'> }) {
  return (
    <span className='flex flex-wrap items-center gap-1.5' data-profile-status={p.status}>
      <ToneBadge color={p.status === 'active' ? 'success' : 'neutral'}>{p.status === 'active' ? 'Active' : 'Archived'}</ToneBadge>
      {p.is_default && <ToneBadge color='info'>Default</ToneBadge>}
      {p.source === 'pack' && <Badge variant='outline' className='font-normal'>From {p.pack}</Badge>}
    </span>
  );
}

// ---------------------------------------------------------------- a profile's page

const TABS = ['overview', 'workspaces', 'history'] as const;
type Tab = (typeof TABS)[number];
const TAB_WORDS: Record<Tab, string> = { overview: 'Overview', workspaces: 'Workspaces', history: 'Versions and changes' };

/** A profile's own page: its header (name, badges, facts, Edit, Archive or Restore, Copy link), then its tabs. */
export function AgentProfilePage({ id }: { id: string }) {
  const { data, error, isLoading } = useAdmin<{ profile: Detail }>(`/agent-profiles/${encodeURIComponent(id)}`);
  const facts = useAdmin<ListAnswer>('/agent-profiles');
  const [editing, setEditing] = useQueryState('edit');
  const [asked, setAsked] = useQueryState('tab');
  const [confirm, setConfirm] = useState(false);
  const { can } = useAdminRole();
  const p = data?.profile;
  const archive = useAdminAction((on: boolean) => adminApi('POST', `/agent-profiles/${encodeURIComponent(id)}/${on ? 'archive' : 'restore'}`), { success: (r: { profile: Detail }) => (r.profile.status === 'archived' ? 'Archived: no new session starts with it' : 'Restored') });
  if (error) return <PageContainer><ErrorBox error={error} /></PageContainer>;
  if (isLoading || !p) return <PageContainer><LoadingCards count={3} /></PageContainer>;
  const tab: Tab = (TABS as readonly string[]).includes(asked ?? '') ? (asked as Tab) : 'overview';
  const e = p.effective;
  const close = () => { void setEditing(null, { history: 'replace' }); setTimeout(() => document.querySelector<HTMLElement>('[data-profile-action=edit]')?.focus(), 50); };
  const card = editing && facts.data && p.status === 'active' ? (
    <ActionCard open onOpenChange={(o) => { if (!o) close(); }} title={`Edit ${p.name}`} back='Back to the profile'
      description={`Saved as version ${p.version + 1}. Sessions already running keep the version they started with; new ones start with this.`}>
      <ProfileForm facts={facts.data} profile={p} onDone={() => close()} />
    </ActionCard>
  ) : null;
  return (
    <PageContainer>
      <FormHost card={card} panel>
        <div className='flex w-full flex-col gap-4 md:gap-6' data-profile-page={p.id}>
          <Card className='w-full gap-0 py-0' data-profile-header=''>
            <CardContent className='flex flex-col gap-5 py-5'>
              <div className='flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between'>
                <div className='flex min-w-0 flex-col gap-2'>
                  <p className='text-muted-foreground text-xs'><Link href={BASE} className='underline-offset-4 hover:underline'>Agent profiles</Link></p>
                  <h1 className='text-xl leading-tight font-semibold tracking-tight break-words md:text-2xl'>{p.name}</h1>
                  {p.description && <p className='text-muted-foreground max-w-3xl text-sm'>{p.description}</p>}
                  <div className='pt-1'><StatusBadges p={p} /></div>
                </div>
                <div className='flex shrink-0 flex-wrap items-center gap-2' data-profile-actions=''>
                  {p.status === 'active' && <Gate need='compute'>
                    <Button type='button' size='sm' data-profile-action='edit' data-primary='' onClick={() => void setEditing('1', { history: 'push' })}><Icons.edit aria-hidden data-icon='inline-start' />Edit</Button>
                  </Gate>}
                  {!p.is_default && <Gate need='compute'>
                    <Button type='button' variant={p.status === 'archived' ? 'default' : 'outline'} size='sm' data-profile-action={p.status === 'archived' ? 'restore' : 'archive'} disabled={archive.isPending || !can('compute')}
                      onClick={() => (p.status === 'archived' ? archive.mutate(false) : setConfirm(true))}>
                      {p.status === 'archived' ? <><Icons.refresh aria-hidden data-icon='inline-start' />Restore</> : <><Icons.trash aria-hidden data-icon='inline-start' />Archive</>}
                    </Button>
                  </Gate>}
                  <Button type='button' variant='outline' size='sm' data-profile-action='copy-link' onClick={() => void copyWithToast(window.location.href.replace(/[?#].*$/, ''), 'Link copied')}>
                    <Icons.link aria-hidden data-icon='inline-start' />Copy link
                  </Button>
                  <ConfirmDialog open={confirm} onOpenChange={setConfirm} destructive title={`Archive ${p.name}?`} confirmLabel='Archive'
                    description={`No new session starts with it, and its buttons on record pages are disabled. Sessions already running keep version ${p.version}. You can restore it later.`}
                    onConfirm={() => archive.mutate(true)} />
                </div>
              </div>
              <dl className='grid grid-cols-2 gap-x-6 gap-y-5 border-t pt-5 sm:grid-cols-4 lg:grid-cols-8' data-profile-facts=''>
                <Fact label='Model' from={e.from.model}><span className='font-mono text-xs break-all'>{e.model}</span></Fact>
                <Fact label='Budget' from={e.from.budget_usd}><span className='tabular-nums'>{usd(e.budget_usd)}</span></Fact>
                <Fact label='Ceiling' from={e.from.ceiling_usd}><span className='tabular-nums'>{usd(e.ceiling_usd)}</span></Fact>
                <Fact label='Turns per wake' from={e.from.max_turns}><span className='tabular-nums'>{e.max_turns}</span></Fact>
                <Fact label='Longest wake' from={e.from.wake_max_minutes}><span className='tabular-nums'>{e.wake_max_minutes} min</span></Fact>
                <Fact label='Who may start it' from={e.from.roles}>{rolesWords(e.roles)}</Fact>
                <Fact label='Sessions'><span className='tabular-nums'>{p.sessions.toLocaleString('en')}</span></Fact>
                <Fact label='Version'><span className='tabular-nums'>{p.version}</span></Fact>
              </dl>
              <p className='text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-4 text-xs' data-profile-meta=''>
                <span>ID <span className='text-foreground font-mono'>{p.id}</span></span><span aria-hidden>·</span>
                <span>Version <span className='text-foreground'>{p.version}</span></span><span aria-hidden>·</span>
                <span>Changed <When d={p.updated_at} /> by <span className='text-foreground'>{p.updated_by}</span></span>
              </p>
            </CardContent>
          </Card>
          {p.status === 'archived' && (
            <div role='status' className='bg-muted/40 grid w-full grid-cols-[auto_1fr] gap-x-3 rounded-xl border px-4 py-3 text-sm' data-profile-archived=''>
              <Icons.info aria-hidden className='mt-0.5 size-4' /><p>Archived <When d={p.archived_at} />: no new session starts with it. Restore it to change it or start sessions with it again.</p>
            </div>
          )}
          <Tabs value={tab} onValueChange={(v) => void setAsked(v === 'overview' ? null : String(v))} className='w-full gap-4'>
            <div className='max-w-full overflow-x-auto'>
              <TabsList variant='line' className='flex-nowrap justify-start gap-x-6 p-0 group-data-horizontal/tabs:h-auto' data-profile-tabs=''>
                {TABS.map((t) => <TabsTrigger key={t} value={t} className='h-9 flex-none px-0' data-profile-tab={t}>{TAB_WORDS[t]}</TabsTrigger>)}
              </TabsList>
            </div>
            <TabsContent value={tab} className='flex flex-col gap-4 md:gap-6'>
              {tab === 'overview' && <Overview p={p} tools={facts.data?.tools ?? []} />}
              {tab === 'workspaces' && <Workspaces p={p} />}
              {tab === 'history' && <History p={p} />}
            </TabsContent>
          </Tabs>
        </div>
      </FormHost>
    </PageContainer>
  );
}

function Fact({ label, from, children }: { label: string; from?: From; children: ReactNode }) {
  return (
    <div className='flex min-w-0 flex-col gap-1.5' data-profile-fact={label}>
      <dt className='text-muted-foreground text-xs font-medium'>{label}</dt>
      <dd className='min-w-0 text-sm font-medium'>{children}</dd>
      {from && <dd className='text-muted-foreground text-xs'>{fromWords(from)}</dd>}
    </div>
  );
}
function Section({ id, title, children, aside }: { id: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <Card className='w-full gap-0 py-0' data-profile-section={id} aria-labelledby={`profile-${id}-title`} role='region'>
      <CardHeader className='flex flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b py-3 [.border-b]:pb-3'>
        <CardTitle id={`profile-${id}-title`} className='text-sm font-semibold'>{title}</CardTitle>{aside}
      </CardHeader>
      <CardContent className='flex flex-col gap-4 py-4'>{children}</CardContent>
    </Card>
  );
}

function Overview({ p, tools }: { p: Detail; tools: Facts['tools'] }) {
  const e = p.effective;
  const title = (n: string) => tools.find((t) => t.name === n)?.title;
  const list = (names: string[], empty: string) => names.length
    ? <ul className='flex flex-wrap gap-x-4 gap-y-1'>{names.map((n) => <li key={n} className='inline-flex items-center gap-1'><span className='font-mono text-xs'>{n}</span>{title(n) && title(n) !== n && <span className='text-muted-foreground text-xs'>({title(n)})</span>}</li>)}</ul>
    : <p className='text-muted-foreground text-sm'>{empty}</p>;
  const ins: [string, keyof Effective['instructions'], string][] = [
    ['Standing instructions', 'append_system', "Added to the harness's own system prompt on every wake, before what the session is told about its workspace."],
    ['On start', 'on_start', "The first message's template: {{message}} is the person's own words (without it, their words follow it)."],
    ['On resume', 'on_resume', 'Said when the session continues without a message (after a pause, a park or a crash).']
  ];
  return (<>
    <Section id='instructions' title='Instructions'>
      <dl className='grid gap-4'>
        {ins.map(([label, k, help]) => (
          <div key={k} className='grid gap-1.5' data-profile-instruction={k}>
            <dt className='text-sm font-medium'>{label}<span className='text-muted-foreground block text-xs font-normal'>{help}</span></dt>
            <dd>{e.instructions[k]
              ? <pre className='bg-muted/40 max-h-60 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap break-words'>{e.instructions[k]}</pre>
              : <span className='text-muted-foreground text-sm'>{k === 'on_start' ? "None: the person's message is the first turn." : "The harness's own."}</span>}</dd>
          </div>
        ))}
      </dl>
    </Section>
    <Section id='tools' title="The app's tools" aside={<span className='text-muted-foreground text-xs'>{fromWords(e.from.tools)}</span>}>
      <p className='text-sm'>{BASE_WORDS[e.tools.base]}. A session uses them as the person who started it, with their role: a tool their role may not use stays closed whatever this says.</p>
      <dl className='grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[12rem_1fr]'>
        <dt className='text-muted-foreground'>Run freely</dt><dd data-profile-tools-free=''>{list(e.tools.free, e.tools.base === 'all' ? 'Every tool' : e.tools.base === 'none' ? 'None' : 'Reads only')}</dd>
        <dt className='text-muted-foreground'>Ask first</dt><dd data-profile-tools-ask=''>{list(e.tools.ask, e.tools.base === 'none' ? 'Every tool' : e.tools.base === 'all' ? 'None' : 'Every change')}</dd>
        <dt className='text-muted-foreground'>Hidden</dt><dd data-profile-tools-hidden=''>{list(e.tools.hidden, 'None: every tool the person may use is listed to the session')}</dd>
      </dl>
    </Section>
    <Section id='web' title='Web access' aside={<span className='text-muted-foreground text-xs'>{fromWords(e.from.web)}</span>}>
      <p className='text-sm'>{WEB_WORDS[e.web.tools]}{e.web.tools !== 'off' ? `: ${e.web.hosts.length ? e.web.hosts.join(', ') : 'it asks before every host'}` : ': the session cannot reach the web.'}</p>
    </Section>
    <Section id='files' title='Files given to its workspace' aside={<span className='text-muted-foreground text-xs'>{e.files.length} file{e.files.length === 1 ? '' : 's'}</span>}>
      {e.files.length ? (
        <ul className='flex flex-col gap-2' data-profile-files=''>
          {e.files.map((f) => (
            <li key={f.path}>
              <details className='rounded-md border px-3 py-2'>
                <summary className='cursor-pointer text-sm'><span className='font-mono text-xs'>{f.path}</span><span className='text-muted-foreground ml-2 text-xs'>{f.content.length.toLocaleString('en')} characters</span></summary>
                <pre className='bg-muted/40 mt-2 max-h-72 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap break-words'>{f.content}</pre>
              </details>
            </li>
          ))}
        </ul>
      ) : <p className='text-muted-foreground text-sm'>None. Files written here (a skill under <span className='font-mono text-xs'>.claude/skills/&lt;name&gt;/SKILL.md</span>, a guide, a template) are in the session&apos;s working directory when it starts.</p>}
    </Section>
  </>);
}

function Workspaces({ p }: { p: Detail }) {
  const o = p.config.overrides ?? [];
  return (
    <Section id='overrides' title='Per-workspace overrides' aside={<span className='text-muted-foreground text-xs'>{o.length} workspace{o.length === 1 ? '' : 's'}</span>}>
      {o.length ? (
        <div className='overflow-x-auto'>
          <table className='w-full text-sm' data-profile-overrides=''>
            <thead><tr className='border-b'>{['Workspace', 'Budget', 'Ceiling', 'Model'].map((h) => <th key={h} className='text-muted-foreground h-9 px-3 text-left text-xs font-medium first:pl-0'>{h}</th>)}</tr></thead>
            <tbody>{o.map((x) => (
              <tr key={x.workspace} className='border-b last:border-0'>
                <td className='px-3 py-2.5 first:pl-0'><span className='font-mono text-xs'>{x.workspace}</span></td>
                <td className='px-3 py-2.5 tabular-nums'>{x.budget_usd !== undefined ? usd(x.budget_usd) : <span className='text-muted-foreground'>As the profile ({usd(p.effective.budget_usd)})</span>}</td>
                <td className='px-3 py-2.5 tabular-nums'>{x.ceiling_usd !== undefined ? usd(x.ceiling_usd) : <span className='text-muted-foreground'>As the profile ({usd(p.effective.ceiling_usd)})</span>}</td>
                <td className='px-3 py-2.5'>{x.model ? <span className='font-mono text-xs'>{x.model}</span> : <span className='text-muted-foreground'>As the profile</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className='text-muted-foreground text-sm'>None: every workspace gets the profile as it is. Edit adds one (a named workspace&apos;s own budget, ceiling or model).</p>}
    </Section>
  );
}

const show = (v: unknown) => (v === undefined || v === null || (Array.isArray(v) && !v.length) ? 'unset' : typeof v === 'string' ? (v.length > 120 ? `${v.slice(0, 120)}…` : v) : JSON.stringify(v).slice(0, 200));
function History({ p }: { p: Detail }) {
  return (
    <Section id='history' title='Versions and changes' aside={<span className='text-muted-foreground text-xs'>{p.versions.length} version{p.versions.length === 1 ? '' : 's'}</span>}>
      <ol className='flex flex-col gap-3' data-profile-changes=''>
        {p.changes.map((c) => (
          <li key={c.id} className='rounded-lg border px-3 py-2.5' data-profile-change={c.action}>
            <p className='flex flex-wrap items-center gap-x-2 gap-y-1 text-sm'>
              <span className='font-medium'>{ACTION_WORDS[c.action]}</span><Badge variant='outline' className='font-normal'>Version {c.version}</Badge>
              <span className='text-muted-foreground'>by {c.by}, <When d={c.at} /></span>
            </p>
            {c.action === 'edited' && c.changed.length > 0 && (
              <dl className='mt-2 grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[10rem_1fr]'>
                {c.changed.map((k) => {
                  const pick = (s: Snapshot | null) => (s ? (k in s && k !== 'config' ? (s as unknown as Record<string, unknown>)[k] : (s.config as Record<string, unknown>)[k]) : undefined);
                  return [<dt key={`${k}-t`} className='text-muted-foreground'>{KEY_WORDS[k] ?? k}</dt>,
                    <dd key={`${k}-d`} className='min-w-0 break-words'><span className='text-muted-foreground line-through decoration-1'>{show(pick(c.before))}</span> <Icons.arrowRight aria-label='to' className='inline size-3' /> <span>{show(pick(c.after))}</span></dd>];
                })}
              </dl>
            )}
          </li>
        ))}
      </ol>
    </Section>
  );
}

// ---------------------------------------------------------------- the form (New profile, Edit)

type ToolChoice = 'base' | 'free' | 'ask' | 'hidden';
const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));
/** New profile (no `profile`) or Edit (a new version of `profile`): every setting, each unset meaning the platform's. */
function ProfileForm({ facts, profile, onDone }: { facts: Facts; profile?: Detail; onDone: (id?: string) => void }) {
  const c = profile?.config ?? {};
  const st = facts.settings;
  const [name, setName] = useState(profile?.name ?? '');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [ins, setIns] = useState({ append_system: c.instructions?.append_system ?? '', on_start: c.instructions?.on_start ?? '', on_resume: c.instructions?.on_resume ?? '' });
  const [model, setModel] = useState(c.model ?? '');
  const [nums, setNums] = useState({ budget_usd: c.budget_usd?.toString() ?? '', ceiling_usd: c.ceiling_usd?.toString() ?? '', max_turns: c.max_turns?.toString() ?? '', wake_max_minutes: c.wake_max_minutes?.toString() ?? '' });
  const [base, setBase] = useState<string>(c.tools?.base ?? '');
  const [choice, setChoice] = useState<Record<string, ToolChoice>>(() => Object.fromEntries([
    ...(c.tools?.free ?? []).map((t) => [t, 'free']), ...(c.tools?.ask ?? []).map((t) => [t, 'ask']), ...(c.tools?.hidden ?? []).map((t) => [t, 'hidden'])]));
  const [web, setWeb] = useState<string>(c.web?.tools ?? '');
  const [hosts, setHosts] = useState(c.web?.hosts ? c.web.hosts.join(', ') : '');
  const [hostsSet, setHostsSet] = useState(!!c.web?.hosts);
  const [roles, setRoles] = useState<Role[]>(c.roles ?? []);
  const [files, setFiles] = useState(c.files ?? []);
  const [overrides, setOverrides] = useState(c.overrides ?? []);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toolNames = useMemo(() => [...new Set([...facts.tools.map((t) => t.name), ...Object.keys(choice)])], [facts.tools, choice]);
  const config = (): ProfileConfig => ({
    instructions: { append_system: ins.append_system || null, on_start: ins.on_start || null, on_resume: ins.on_resume || null },
    model: model || null, budget_usd: numOrNull(nums.budget_usd), ceiling_usd: numOrNull(nums.ceiling_usd), max_turns: numOrNull(nums.max_turns), wake_max_minutes: numOrNull(nums.wake_max_minutes),
    tools: { base: (base || null) as 'reads' | 'all' | 'none' | null, free: toolNames.filter((t) => choice[t] === 'free'), ask: toolNames.filter((t) => choice[t] === 'ask'), hidden: toolNames.filter((t) => choice[t] === 'hidden') },
    web: { tools: (web || null) as WebTools | null, hosts: hostsSet ? hosts.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean) : null },
    files: files.filter((f) => f.path.trim()).map((f) => ({ path: f.path.trim(), content: f.content })),
    roles: roles.length ? roles : null,
    overrides: overrides.filter((o) => o.workspace).map((o) => ({ workspace: o.workspace, ...(o.budget_usd !== undefined ? { budget_usd: o.budget_usd } : {}), ...(o.ceiling_usd !== undefined ? { ceiling_usd: o.ceiling_usd } : {}), ...(o.model ? { model: o.model } : {}) }))
  });
  const submit = async () => {
    if (!name.trim()) return void toast.error('Give the profile a name');
    setBusy(true);
    try {
      if (profile) {
        await adminApi('PUT', `/agent-profiles/${encodeURIComponent(profile.id)}`, { version: profile.version, name, description, config: config() });
        toast.success(`Saved as version ${profile.version + 1}`);
        await qc.invalidateQueries({ queryKey: ['admin'] });
        onDone(profile.id);
      } else {
        const r = await adminApi<{ profile: Detail }>('POST', '/agent-profiles', { name, description, config: config() });
        toast.success(`${r.profile.name} created`);
        await qc.invalidateQueries({ queryKey: ['admin'] });
        onDone(r.profile.id);
      }
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const inherit = (v: string | number) => `Platform setting: ${v}`;
  const H = ({ children }: { children: ReactNode }) => <h3 className='border-t pt-4 text-sm font-semibold first:border-0 first:pt-0'>{children}</h3>;
  return (
    <CardForm onSubmit={submit} submit={<Button type='submit' disabled={busy} data-profile-save=''><Icons.check /> {busy ? 'Saving…' : profile ? 'Save version' : 'Create profile'}</Button>}>
      <div className='grid gap-4' data-profile-form=''>
        <H>About</H>
        <Row id='pf-name' label='Name'><Input id='pf-name' value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder='Build an application' /></Row>
        <Row id='pf-description' label='Description' hint='Shown to the people who may start it, in the Start a session dialog.'>
          <Textarea id='pf-description' rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Row>
        <H>Instructions</H>
        <Row id='pf-standing' label='Standing instructions' hint="Added to the harness's system prompt on every wake. Empty: the harness's own.">
          <Textarea id='pf-standing' rows={4} value={ins.append_system} onChange={(e) => setIns((s) => ({ ...s, append_system: e.target.value }))} className='font-mono text-xs' />
        </Row>
        <Row id='pf-start' label='On start' hint="The first message's template: {{message}} is the person's words (without it, they follow it). Empty: their words alone.">
          <Textarea id='pf-start' rows={3} value={ins.on_start} onChange={(e) => setIns((s) => ({ ...s, on_start: e.target.value }))} className='font-mono text-xs' />
        </Row>
        <Row id='pf-resume' label='On resume' hint='Said when it continues without a message. Empty: the harness’s own.'>
          <Textarea id='pf-resume' rows={2} value={ins.on_resume} onChange={(e) => setIns((s) => ({ ...s, on_resume: e.target.value }))} className='font-mono text-xs' />
        </Row>
        <H>Model and limits</H>
        <Row id='pf-model' label='Model' hint='Priced models only: what a session spends is counted against its budget.'>
          <NativeSelect id='pf-model' value={model} onChange={(e) => setModel(e.target.value)} className='w-full sm:w-80'>
            <NativeSelectOption value=''>{inherit(st.model)}</NativeSelectOption>
            {facts.models.map((m) => <NativeSelectOption key={m} value={m}>{m}</NativeSelectOption>)}
          </NativeSelect>
        </Row>
        <div className='grid gap-4 sm:grid-cols-2'>
          {([['budget_usd', 'Budget (USD)', st.budget_usd, '0.01'], ['ceiling_usd', 'Most it can be raised to (USD)', st.ceiling_usd, '0.01'], ['max_turns', 'Turns per wake', st.max_turns, '1'], ['wake_max_minutes', 'Longest wake (minutes)', st.wake_max_minutes, '1']] as const).map(([k, label, v, step]) => (
            <Row key={k} id={`pf-${k}`} label={label}>
              <Input id={`pf-${k}`} type='number' inputMode='decimal' step={step} value={nums[k]} placeholder={inherit(v)} onChange={(e) => setNums((s) => ({ ...s, [k]: e.target.value }))} />
            </Row>
          ))}
        </div>
        <H>The app&apos;s tools</H>
        <Row id='pf-base' label='Without asking it uses' hint='Then each tool below may run freely, ask first or be hidden (never listed to the session, refused by the server).'>
          <NativeSelect id='pf-base' value={base} onChange={(e) => setBase(e.target.value)} className='w-full sm:w-96'>
            <NativeSelectOption value=''>{inherit(BASE_WORDS[st.tools.base])}</NativeSelectOption>
            <NativeSelectOption value='reads'>{BASE_WORDS.reads}</NativeSelectOption>
            <NativeSelectOption value='all'>{BASE_WORDS.all}</NativeSelectOption>
            <NativeSelectOption value='none'>{BASE_WORDS.none}</NativeSelectOption>
          </NativeSelect>
        </Row>
        <div className='max-h-80 overflow-auto rounded-md border' data-profile-tools-form=''>
          <table className='w-full text-sm'>
            <thead className='bg-background sticky top-0'><tr className='border-b'><th className='text-muted-foreground h-9 px-3 text-left text-xs font-medium'>Tool</th><th className='text-muted-foreground h-9 px-3 text-left text-xs font-medium'>This profile</th></tr></thead>
            <tbody>
              {toolNames.map((n) => {
                const t = facts.tools.find((x) => x.name === n);
                return (
                  <tr key={n} className='border-b last:border-0'>
                    <td className='px-3 py-1.5'><label htmlFor={`pf-tool-${n}`} className='flex flex-col'><span className='font-mono text-xs'>{n}</span><span className='text-muted-foreground text-xs'>{t ? (t.read ? 'Reads' : 'Changes something') : 'Not a tool of this app now'}{t?.title && t.title !== n ? ` · ${t.title}` : ''}</span></label></td>
                    <td className='px-3 py-1.5'>
                      <NativeSelect id={`pf-tool-${n}`} size='sm' value={choice[n] ?? 'base'} onChange={(e) => setChoice((s) => { const x = { ...s }; if (e.target.value === 'base') delete x[n]; else x[n] = e.target.value as ToolChoice; return x; })}>
                        <NativeSelectOption value='base'>As above</NativeSelectOption>
                        <NativeSelectOption value='free'>Runs freely</NativeSelectOption>
                        <NativeSelectOption value='ask'>Asks first</NativeSelectOption>
                        <NativeSelectOption value='hidden'>Hidden</NativeSelectOption>
                      </NativeSelect>
                    </td>
                  </tr>
                );
              })}
              {!toolNames.length && <tr><td colSpan={2} className='text-muted-foreground px-3 py-3 text-sm'>This app lists no tools of its own.</td></tr>}
            </tbody>
          </table>
        </div>
        <H>Web access</H>
        <div className='grid gap-4 sm:grid-cols-2'>
          <Row id='pf-web' label='Web tools'>
            <NativeSelect id='pf-web' value={web} onChange={(e) => setWeb(e.target.value)} className='w-full'>
              <NativeSelectOption value=''>{inherit(WEB_WORDS[st.web.tools])}</NativeSelectOption>
              {(['off', 'fetch', 'search'] as const).map((w) => <NativeSelectOption key={w} value={w}>{WEB_WORDS[w]}</NativeSelectOption>)}
            </NativeSelect>
          </Row>
          <Row id='pf-hosts' label='Hosts allowed without asking' hint='Comma-separated; *.example.com allows a domain and everything under it.'>
            <div className='flex flex-col gap-2'>
              <label className='flex items-center gap-2 text-sm'><Checkbox checked={hostsSet} onCheckedChange={(v) => setHostsSet(!!v)} aria-label='Set the hosts in this profile' />Set them here (else: {st.web.hosts.join(', ') || 'none'})</label>
              <Input id='pf-hosts' value={hosts} disabled={!hostsSet} onChange={(e) => setHosts(e.target.value)} placeholder='docs.example.com, *.example.org' className='font-mono text-xs' />
            </div>
          </Row>
        </div>
        <H>Who may start it</H>
        <fieldset className='flex flex-wrap gap-x-6 gap-y-2' data-profile-roles=''>
          <legend className='text-muted-foreground mb-2 text-xs'>None ticked: every role that may start sessions (members, billing managers and owners). A viewer never can.</legend>
          {(['member', 'billing', 'owner'] as const).map((r) => (
            <label key={r} className='flex items-center gap-2 text-sm'>
              <Checkbox checked={roles.includes(r)} onCheckedChange={(v) => setRoles((s) => (v ? [...s, r] : s.filter((x) => x !== r)))} />{ROLE_WORDS[r]}
            </label>
          ))}
        </fieldset>
        <H>Files given to its workspace</H>
        <div className='flex flex-col gap-3' data-profile-files-form=''>
          {files.map((f, i) => (
            <div key={i} className='grid gap-2 rounded-md border p-3'>
              <div className='flex items-end gap-2'>
                <Row id={`pf-file-${i}`} label='Path in the working directory'>
                  <Input id={`pf-file-${i}`} value={f.path} placeholder='.claude/skills/build/SKILL.md' className='font-mono text-xs' onChange={(e) => setFiles((s) => s.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} />
                </Row>
                <Button type='button' variant='outline' size='sm' aria-label={`Remove ${f.path || 'this file'}`} onClick={() => setFiles((s) => s.filter((_, j) => j !== i))}><Icons.trash /></Button>
              </div>
              <Label htmlFor={`pf-file-${i}-text`} className='sr-only'>Its text</Label>
              <Textarea id={`pf-file-${i}-text`} rows={5} value={f.content} className='font-mono text-xs' onChange={(e) => setFiles((s) => s.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))} />
            </div>
          ))}
          <div><Button type='button' variant='outline' size='sm' onClick={() => setFiles((s) => [...s, { path: '', content: '' }])} disabled={files.length >= 20}><Icons.add />Add a file</Button></div>
        </div>
        <H>Per-workspace overrides</H>
        <div className='flex flex-col gap-3' data-profile-overrides-form=''>
          {overrides.map((o, i) => (
            <div key={i} className='grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_8rem_8rem_1fr_auto] sm:items-end'>
              <Row id={`pf-ov-${i}`} label='Workspace'>
                <NativeSelect id={`pf-ov-${i}`} value={o.workspace} onChange={(e) => setOverrides((s) => s.map((x, j) => (j === i ? { ...x, workspace: e.target.value } : x)))} className='w-full'>
                  <NativeSelectOption value=''>Choose a workspace</NativeSelectOption>
                  {facts.workspaces.map((w) => <NativeSelectOption key={w.slug} value={w.slug}>{w.name || w.slug}</NativeSelectOption>)}
                </NativeSelect>
              </Row>
              {(['budget_usd', 'ceiling_usd'] as const).map((k) => (
                <Row key={k} id={`pf-ov-${i}-${k}`} label={k === 'budget_usd' ? 'Budget' : 'Ceiling'}>
                  <Input id={`pf-ov-${i}-${k}`} type='number' step='0.01' value={o[k]?.toString() ?? ''} placeholder='As the profile'
                    onChange={(e) => setOverrides((s) => s.map((x, j) => (j === i ? { ...x, [k]: e.target.value === '' ? undefined : Number(e.target.value) } : x)))} />
                </Row>
              ))}
              <Row id={`pf-ov-${i}-model`} label='Model'>
                <NativeSelect id={`pf-ov-${i}-model`} value={o.model ?? ''} onChange={(e) => setOverrides((s) => s.map((x, j) => (j === i ? { ...x, model: e.target.value || undefined } : x)))} className='w-full'>
                  <NativeSelectOption value=''>As the profile</NativeSelectOption>
                  {facts.models.map((m) => <NativeSelectOption key={m} value={m}>{m}</NativeSelectOption>)}
                </NativeSelect>
              </Row>
              <Button type='button' variant='outline' size='sm' aria-label='Remove this override' onClick={() => setOverrides((s) => s.filter((_, j) => j !== i))}><Icons.trash /></Button>
            </div>
          ))}
          <div><Button type='button' variant='outline' size='sm' onClick={() => setOverrides((s) => [...s, { workspace: '' }])}><Icons.add />Add a workspace</Button></div>
        </div>
      </div>
    </CardForm>
  );
}

function Row({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className={cn('flex min-w-0 flex-1 flex-col gap-1.5')}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className='text-muted-foreground text-xs'>{hint}</p>}
    </div>
  );
}

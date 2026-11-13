'use client';
// A team's page (mold_v0-259, flag teams; GET /api/teams/<id>, src/team-routes.ts), in the record page layout
// (mold_v0-253/254/256, ./records/detail-page.tsx): a header card (what it is, its name and description, badges, four
// facts, who added it and when) with its actions (Add people, the primary; Rename; Delete in More, the workspace's owners
// only), then tabs: People (leads first; make a lead, make a member, remove), Records (the records shared with it, as
// this person may see them) and History (every change of it and its membership, newest first, with Show more). Add
// people and Rename open as full cards in the page's place.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryState } from 'nuqs';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { ConfirmDialog } from '@/features/admin/ui';
import { ErrorState, LoadingCards, useOrgLoad } from '@/features/portal/shared';
import { ToneBadge } from '@/features/records/detail-page';
import { ActionCard, CardForm } from '@/features/tabs/tab-action';
import { httpError } from '@/features/status/from-error';
import { settingsTabUrl } from '@/config/settings';
import { personWords, sendJson, type Person, type TeamSummary } from './visibility';
import { IdentityName } from '@/components/identity-avatar';

interface TeamPerson { user_id: string; role: 'member' | 'lead'; added_at: string; added_by: string | null; name: string | null; email: string | null;
  /** mold_v0-262: the role in the app's words. */
  role_id?: string; role_label?: string }
/** A team role in the app's words (mold_v0-262: profile.json or a pack's team_roles; else Lead and Member). */
export interface TeamRoleDef { id: string; label: string; level: 'lead' | 'member' }
const BUILT_IN_ROLES: TeamRoleDef[] = [{ id: 'member', label: 'Member', level: 'member' }, { id: 'lead', label: 'Lead', level: 'lead' }];
const LEVEL_WORDS = { lead: 'also changes who sees them', member: "sees the team's records" } as const;
interface TeamChange { id: number; action: string; user_id: string | null; detail: string | null; by: string | null; at: string; by_name: string | null; user_name: string | null }
interface TeamPageData {
  team: TeamSummary & { created_by: string | null }; can_manage: boolean; me: string | null; roles?: TeamRoleDef[];
  people: TeamPerson[]; candidates: Person[];
  records: { area: string; label: string; key: string; title: string | null; updated_at: string }[];
  changes: { changes: TeamChange[]; more: boolean };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, body);
  return body;
}
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const TABS = [{ id: 'people', label: 'People' }, { id: 'records', label: 'Records' }, { id: 'history', label: 'History' }] as const;

/** A change in words: "added Ana as a lead", "renamed it (from Design)". */
function changeWords(c: TeamChange, me: string | null) {
  const who = c.user_id ? (c.user_id === me ? (c.by === me ? 'yourself' : 'you') : c.user_name ?? 'a person') : '';
  switch (c.action) {
    case 'created': return 'created the team';
    case 'renamed': return `renamed it${c.detail ? ` (${c.detail})` : ''}`;
    case 'deleted': return `deleted it${c.detail ? ` (${c.detail})` : ''}`;
    case 'member_added': return `added ${who}${c.detail ? ` ${c.detail}` : ''}`;
    case 'member_removed': return `took ${who} out`;
    case 'lead_set': return `made ${who} a lead`;
    case 'lead_unset': return `made ${who} a member`;
    case 'role_set': return `made ${who}${c.detail ? ` ${c.detail.replace(/^as /, '')}` : ' another role'}`;
    default: return c.action;
  }
}

export function TeamPage({ id }: { id: string }) {
  const url = `/api/teams/${encodeURIComponent(id)}`;
  const { data, error, reload, setData } = useOrgLoad(() => getJson<TeamPageData>(url), [url]);
  const [asked, setAsked] = useQueryState('tab');
  const [act, setAct] = useQueryState('act');
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();
  if (error) return <PageContainer><ErrorState error={error} /></PageContainer>;
  if (!data) return <PageContainer><LoadingCards count={3} /></PageContainer>;
  const { team, people, can_manage, me } = data;
  const tab = TABS.find((t) => t.id === asked) ?? TABS[0];
  const leads = people.filter((p) => p.role === 'lead');
  const myRole = people.find((p) => p.user_id === me)?.role ?? null;
  const name = (p: { user_id: string; name: string | null; email: string | null }) => personWords({ user_id: p.user_id, name: p.name, email: p.email }, p.user_id, me);
  const changed = () => void reload();
  const close = () => void setAct(null);
  const back = settingsTabUrl('teams') ?? '/app/settings';

  if (act === 'add' && can_manage) return (
    <PageContainer>
      <ActionCard open onOpenChange={(o) => { if (!o) close(); }} title={`Add people to ${team.name}`} description='Each sees the records shared with the team. A lead may also change who sees them.' back='Back to the team'>
        <AddPeopleForm id={team.id} candidates={data.candidates} me={me} roles={data.roles?.length ? data.roles : BUILT_IN_ROLES} onDone={() => { close(); changed(); }} />
      </ActionCard>
    </PageContainer>
  );
  if (act === 'rename' && can_manage) return (
    <PageContainer>
      <ActionCard open onOpenChange={(o) => { if (!o) close(); }} title={`Rename ${team.name}`} back='Back to the team'>
        <RenameForm team={team} onDone={() => { close(); changed(); }} />
      </ActionCard>
    </PageContainer>
  );
  const remove = async () => {
    try {
      const r = await sendJson<{ records: number }>('DELETE', url);
      toast.success(r.records ? `Deleted: its ${r.records} record(s) are now private to their owners` : 'Deleted');
      router.push(back);
    } catch (e) { toast.error((e as Error).message); }
  };
  const roles = data.roles?.length ? data.roles : BUILT_IN_ROLES;
  const setRole = async (p: TeamPerson, role: TeamRoleDef) => {
    try { await sendJson('POST', `${url}/people/${encodeURIComponent(p.user_id)}`, { role: role.id }); toast.success(`Made ${role.label}`); changed(); }
    catch (e) { toast.error((e as Error).message); }
  };
  const takeOut = async (p: TeamPerson) => {
    try { await sendJson('DELETE', `${url}/people/${encodeURIComponent(p.user_id)}`); toast.success('Taken out of the team'); changed(); }
    catch (e) { toast.error((e as Error).message); }
  };
  const more = async () => {
    const last = data.changes.changes[data.changes.changes.length - 1];
    if (!last) return;
    try {
      const got = await getJson<{ changes: TeamChange[]; more: boolean }>(`${url}/changes?before=${last.id}`);
      setData({ ...data, changes: { changes: [...data.changes.changes, ...got.changes.map((c) => ({ ...c, by_name: null, user_name: null }))], more: got.more } });
    } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <PageContainer>
      <div className='flex w-full flex-col gap-4 md:gap-6' data-record-layout='' data-team-page={team.id}>
        <Card className='w-full gap-0 py-0' data-record-header=''>
          <CardContent className='flex flex-col gap-5 py-5'>
            <div className='flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between'>
              <div className='flex min-w-0 flex-col gap-2'>
                <p className='text-muted-foreground text-xs'><Link href={back} className='underline-offset-4 hover:underline'>Teams</Link> · This workspace&apos;s own</p>
                <h1 className='text-xl leading-tight font-semibold tracking-tight break-words md:text-2xl'>{team.name}</h1>
                {team.description && <p className='text-muted-foreground max-w-prose text-sm leading-relaxed break-words' data-record-subtitle=''>{team.description}</p>}
                <div className='flex flex-wrap items-center gap-2 pt-1' data-record-badges=''>
                  {myRole && <ToneBadge color={myRole === 'lead' ? 'info' : 'success'}>{myRole === 'lead' ? 'You lead it' : 'You are in it'}</ToneBadge>}
                  {!leads.length && <ToneBadge color='warning'>No lead</ToneBadge>}
                </div>
              </div>
              {can_manage && (
                <div className='flex shrink-0 flex-wrap items-center gap-2' data-page-actions=''>
                  <Button type='button' size='sm' data-page-action='add' onClick={() => void setAct('add')}><Icons.add aria-hidden data-icon='inline-start' />Add people</Button>
                  <Button type='button' variant='outline' size='sm' data-page-action='rename' onClick={() => void setAct('rename')}><Icons.edit aria-hidden data-icon='inline-start' />Rename</Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button type='button' variant='outline' size='sm' data-page-more='' aria-label='More actions' />}>
                      <Icons.dots aria-hidden data-icon='inline-start' />More
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align='end' className='w-56' data-page-more-menu=''>
                      <DropdownMenuGroup>
                        <DropdownMenuItem onClick={() => void navigator.clipboard?.writeText(window.location.href).then(() => toast.success('Link copied'))}><Icons.link aria-hidden />Copy link</DropdownMenuItem>
                        <DropdownMenuItem variant='destructive' onClick={() => setConfirming(true)} data-team-delete=''><Icons.trash aria-hidden />Delete team</DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </div>
            <dl className='grid grid-cols-2 gap-x-6 gap-y-5 border-t pt-5 sm:grid-cols-3 lg:grid-cols-4' data-record-facts=''>
              <Fact label='People'>{people.length}</Fact>
              <Fact label='Leads'>{leads.length ? leads.map(name).join(', ') : 'None'}</Fact>
              <Fact label='Records shared with it'>{data.records.length}{data.records.length >= 50 ? '+' : ''}</Fact>
              <Fact label='Created'>{day(team.created_at)}</Fact>
            </dl>
            <p className='text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-4 text-xs' data-record-meta=''>
              <span>Team ID <span className='text-foreground font-mono'>{team.id}</span></span>
              <span aria-hidden>·</span><span>Updated {when(team.updated_at)}</span>
            </p>
          </CardContent>
        </Card>

        <Tabs value={tab.id} onValueChange={(v) => void setAsked(v === TABS[0].id ? null : String(v))} className='w-full gap-4'>
          {/* mold_v0-298: on a phone a long strip wraps to a second line rather than clip its last tab (as Settings). */}
          <div className='max-w-full pb-1.5' data-tab-strip-room=''>
            <TabsList variant='line' className='max-w-full flex-wrap justify-start gap-x-6 gap-y-3 p-0 group-data-horizontal/tabs:h-auto' data-record-tabs=''>
              {TABS.map((t) => <TabsTrigger key={t.id} value={t.id} className='h-9 flex-none px-0'>{t.label}</TabsTrigger>)}
            </TabsList>
          </div>
          <TabsContent value='people'>
            <Section title='People' id='team-people' empty={people.length ? null : (can_manage ? 'Nobody yet. Add people adds them.' : 'Nobody yet.')}>
              <Table>
                <TableHeader><TableRow><TableHead>Person</TableHead><TableHead>Role</TableHead><TableHead className='max-sm:hidden'>Added</TableHead>{can_manage && <TableHead className='w-px'><span className='sr-only'>Actions</span></TableHead>}</TableRow></TableHeader>
                <TableBody>
                  {people.map((p) => (
                    <TableRow key={p.user_id} data-team-person={p.user_id}>
                      <TableCell><IdentityName id={p.user_id} name={p.name} email={p.email}><span className='font-medium'>{name(p)}</span>{p.email && p.name && <span className='text-muted-foreground block text-xs'>{p.email}</span>}</IdentityName></TableCell>
                      <TableCell data-team-role={p.role_id ?? p.role}>{p.role === 'lead' ? <ToneBadge color='info'>{p.role_label ?? 'Lead'}</ToneBadge> : p.role_label ?? 'Member'}</TableCell>
                      <TableCell className='max-sm:hidden'>{day(p.added_at)}</TableCell>
                      {can_manage && (
                        <TableCell className='text-right'>
                          <DropdownMenu>
                            <DropdownMenuTrigger render={<Button type='button' variant='ghost' size='sm' aria-label={`Actions for ${name(p)}`} />}><Icons.ellipsis aria-hidden /></DropdownMenuTrigger>
                            <DropdownMenuContent align='end' className='w-48'>
                              <DropdownMenuGroup>
                                {/* mold_v0-262: every other role, in the app's words */}
                                {roles.filter((r) => r.id !== (p.role_id ?? p.role)).map((r) => <DropdownMenuItem key={r.id} onClick={() => void setRole(p, r)} data-set-role={r.id}>Make {r.label}</DropdownMenuItem>)}
                                <DropdownMenuItem variant='destructive' onClick={() => void takeOut(p)}>Take out of the team</DropdownMenuItem>
                              </DropdownMenuGroup>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
          </TabsContent>
          <TabsContent value='records'>
            <Section title='Records shared with it' id='team-records' empty={data.records.length ? null : 'No record you can see is shared with this team.'}>
              <ul className='flex flex-col divide-y'>
                {data.records.map((r) => (
                  <li key={`${r.area}/${r.key}`} className='flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 text-sm'>
                    <span className='min-w-0'><Link className='font-medium underline-offset-4 hover:underline' href={`/app/records/${r.area}/${encodeURIComponent(r.key)}`}>{r.title || r.key}</Link>
                      <span className='text-muted-foreground'> · {r.label}</span></span>
                    <span className='text-muted-foreground text-xs'>Updated {day(r.updated_at)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          </TabsContent>
          <TabsContent value='history'>
            <Section title='History' id='team-history' empty={data.changes.changes.length ? null : 'No change yet.'}>
              <ol className='flex flex-col divide-y' data-team-history=''>
                {data.changes.changes.map((c) => (
                  <li key={c.id} className='flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 text-sm'>
                    <span><span className='font-medium'>{c.by === me ? 'You' : c.by_name ?? 'An owner'}</span> {changeWords(c, me)}</span>
                    <span className='text-muted-foreground text-xs'>{when(c.at)}</span>
                  </li>
                ))}
              </ol>
              {data.changes.more && <Button type='button' variant='outline' size='sm' className='mt-3' onClick={() => void more()}>Show more</Button>}
            </Section>
          </TabsContent>
        </Tabs>
      </div>
      <ConfirmDialog open={confirming} onOpenChange={setConfirming} destructive title={`Delete ${team.name}?`} confirmLabel='Delete team' onConfirm={() => void remove()}
        description={`Its people leave it. The records shared with it become private to their owners (and their collaborators); the workspace's owners still see them.`} />
    </PageContainer>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='flex min-w-0 flex-col gap-1.5' data-detail-field=''>
      <dt className='text-muted-foreground text-xs font-medium'>{label}</dt>
      <dd className='text-sm leading-relaxed font-medium break-words'>{children}</dd>
    </div>
  );
}

function Section({ title, id, empty, children }: { title: string; id: string; empty: string | null; children: React.ReactNode }) {
  return (
    <Card className='w-full gap-0 py-0' data-detail-section={id} aria-labelledby={`${id}-title`} role='region'>
      <CardHeader className='border-b py-3.5 [.border-b]:pb-3.5'><CardTitle id={`${id}-title`} className='text-sm font-semibold'>{title}</CardTitle></CardHeader>
      <CardContent className='py-4'>
        {empty ? (
          <div className='flex items-center gap-3 py-2' data-section-empty=''>
            <Icons.inbox aria-hidden className='text-muted-foreground size-5 shrink-0' />
            <p className='text-muted-foreground text-sm'>{empty}</p>
          </div>
        ) : children}
      </CardContent>
    </Card>
  );
}

function AddPeopleForm({ id, candidates, me, roles, onDone }: { id: number; candidates: Person[]; me: string | null; roles: TeamRoleDef[]; onDone: () => void }) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [role, setRole] = useState<string>((roles.find((r) => r.level === 'member') ?? roles[0]!).id);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = candidates.filter((p) => words.every((w) => `${p.name ?? ''} ${p.email ?? ''}`.toLowerCase().includes(w)));
  const submit = async () => {
    if (!chosen.size) return void toast.error('Choose who to add');
    setBusy(true);
    try { await sendJson('POST', `/api/teams/${id}/people`, { people: [...chosen], role }); toast.success(`Added ${chosen.size}`); onDone(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <CardForm onSubmit={submit} submit={<Button type='submit' disabled={busy || !chosen.size}><Icons.add /> {busy ? 'Adding…' : `Add ${chosen.size || ''}`.trim()}</Button>}>
      {candidates.length > 6 && (
        <div className='flex flex-col gap-1.5'>
          <Label htmlFor='team-add-search'>Search people</Label>
          <Input id='team-add-search' value={q} onChange={(e) => setQ(e.target.value)} placeholder='A name or an address' className='sm:w-80' />
        </div>
      )}
      <fieldset className='flex flex-col gap-2'>
        <legend className='mb-1 text-sm font-medium'>People of this workspace</legend>
        {shown.map((p) => (
          <label key={p.user_id} className='flex cursor-pointer items-center gap-2 text-sm'>
            <Checkbox checked={chosen.has(p.user_id)} onCheckedChange={(c) => setChosen((s) => { const n = new Set(s); if (c) n.add(p.user_id); else n.delete(p.user_id); return n; })} />
            <span className='min-w-0 truncate'>{personWords(p, p.user_id, me)}{p.name && p.email ? <span className='text-muted-foreground'> · {p.email}</span> : null}</span>
          </label>
        ))}
        {!shown.length && <p className='text-muted-foreground text-sm'>{candidates.length ? 'Nobody matches.' : 'Everyone in the workspace is in this team already.'}</p>}
      </fieldset>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='team-add-role'>As</Label>
        <NativeSelect id='team-add-role' value={role} onChange={(e) => setRole(e.target.value)}>
          {roles.map((r) => <NativeSelectOption key={r.id} value={r.id}>{r.label}: {r.level === 'lead' ? `sees the team's records and ${LEVEL_WORDS.lead}` : LEVEL_WORDS.member}</NativeSelectOption>)}
        </NativeSelect>
      </div>
    </CardForm>
  );
}

function RenameForm({ team, onDone }: { team: TeamSummary; onDone: () => void }) {
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? '');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { await sendJson('PATCH', `/api/teams/${team.id}`, { name: name.trim(), description: description.trim() || null }); toast.success('Saved'); onDone(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <CardForm onSubmit={submit} submit={<Button type='submit' disabled={busy || !name.trim()}><Icons.check /> {busy ? 'Saving…' : 'Save'}</Button>}>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='team-rename'>Name<span className='text-destructive' aria-hidden> *</span></Label>
        <Input id='team-rename' value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} />
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='team-rename-description'>About</Label>
        <Textarea id='team-rename-description' value={description} maxLength={500} rows={3} onChange={(e) => setDescription(e.target.value)} />
      </div>
    </CardForm>
  );
}

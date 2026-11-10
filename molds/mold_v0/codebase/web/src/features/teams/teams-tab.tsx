'use client';
// Settings › Teams (mold_v0-259, flag teams; the server's src/team-routes.ts): the workspace's teams, the standard
// full-area list: four cards, the search row with New team (the workspace's owners), then the table; a row opens its
// team's page (/app/settings/teams/<id>, ./team-page.tsx). New team opens its form as a full card in the list's place (?new=1).
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { ErrorState } from '@/features/portal/shared';
import { CardForm, ToolbarAction, useActionOpen } from '@/features/tabs/tab-action';
import { personWords, sendJson, useTeams, type TeamSummary } from './visibility';

export const teamUrl = (id: number) => `/app/settings/teams/${id}`;
const dateText = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export function TeamsTab() {
  const { data, error, reload } = useTeams();
  const router = useRouter();
  const [adding, setAdding] = useActionOpen('new');
  if (error) return <ErrorState error={error} />;
  const teams = data?.teams ?? [];
  const mine = new Map((data?.mine ?? []).map((t) => [t.id, t.role]));
  const people = data?.people ?? [];
  const named = (id: string) => personWords(people.find((p) => p.user_id === id), id, data?.me);
  const cols: RecordCol<TeamSummary>[] = [
    { key: 'name', label: 'Team', title: true, keep: true, type: 'text', className: 'min-w-40', value: (t) => t.name,
      render: (t) => <Link className='font-medium underline-offset-4 hover:underline' href={teamUrl(t.id)} data-team-link={t.id}>{t.name}</Link> },
    { key: 'members', label: 'People', type: 'number', className: 'text-right', value: (t) => t.members, render: (t) => <span className='tabular-nums'>{t.members}</span> },
    { key: 'leads', label: 'Leads', type: 'text', value: (t) => t.leads.map(named).join(', '), render: (t) => (t.leads.length ? <span className='line-clamp-2'>{t.leads.map(named).join(', ')}</span> : <span className='text-muted-foreground'>None</span>) },
    { key: 'yours', label: 'You', type: 'select', options: [{ value: 'Lead' }, { value: 'Member' }, { value: 'Not in it' }],
      value: (t) => (mine.get(t.id) === 'lead' ? 'Lead' : mine.has(t.id) ? 'Member' : 'Not in it'), render: (t) => (mine.get(t.id) === 'lead' ? 'Lead' : mine.has(t.id) ? 'Member' : <span className='text-muted-foreground'>Not in it</span>) },
    { key: 'description', label: 'About', type: 'text', value: (t) => t.description ?? '', render: (t) => <span className='line-clamp-2'>{t.description ?? ''}</span> },
    { key: 'created_at', label: 'Created', type: 'date', value: (t) => t.created_at, render: (t) => dateText(t.created_at) }
  ];
  const total = teams.reduce((n, t) => n + t.members, 0);
  return (
    <RecordView<TeamSummary>
      id='settings-teams' compact noun='teams' properties loading={!data}
      rows={teams} rowKey={(t) => String(t.id)} cols={cols}
      summary={<StatStrip quad items={[
        { label: 'Teams', value: teams.length, said: `${teams.length} teams` },
        { label: 'Places in teams', value: total, said: `${total} places in teams` },
        { label: 'Leads', value: teams.reduce((n, t) => n + t.leads.length, 0), said: 'leads' },
        { label: 'Your teams', value: mine.size, said: `${mine.size} of your teams` }
      ]} />}
      searchText={(t) => `${t.name} ${t.description ?? ''} ${t.leads.map(named).join(' ')}`}
      searchPlaceholder='Search teams'
      toolbarAction={data?.can_manage ? <ToolbarAction label='New team' icon={<Icons.add />} onClick={() => setAdding(true)} /> : undefined}
      // mold_v0-289: New team opens in the side panel beside the list (?new=1).
      sidePanel={adding && data?.can_manage ? { key: 'new-team', title: 'New team', onClose: () => setAdding(false), body: <NewTeamForm onDone={(id) => { setAdding(false); void reload(); if (id) router.push(teamUrl(id)); }} /> } : null}
      empty={<p className='text-muted-foreground text-sm' data-teams-empty=''>{data?.can_manage ? 'No teams yet. New team adds one; a record shared with a team is seen by its people.' : 'No teams yet. The workspace\'s owners add them.'}</p>}
      detailTitle={(t) => t.name}
      pageHref={(t) => teamUrl(t.id)}
      detail={(t) => (
        <dl className='grid gap-3 text-sm'>
          {t.description && <div><dt className='text-muted-foreground'>About</dt><dd>{t.description}</dd></div>}
          <div><dt className='text-muted-foreground'>People</dt><dd>{t.members}</dd></div>
          <div><dt className='text-muted-foreground'>Leads</dt><dd>{t.leads.length ? t.leads.map(named).join(', ') : 'None'}</dd></div>
        </dl>
      )}
    />
  );
}

function NewTeamForm({ onDone }: { onDone: (id: number | null) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) return void toast.error('Give the team a name');
    setBusy(true);
    try {
      const r = await sendJson<{ team: TeamSummary }>('POST', '/api/teams', { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) });
      toast.success('Team added');
      onDone(r.team.id);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <CardForm onSubmit={submit} submit={<Button type='submit' disabled={busy || !name.trim()}><Icons.add /> {busy ? 'Adding…' : 'Add team'}</Button>}>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='team-name'>Name<span className='text-destructive' aria-hidden> *</span></Label>
        <Input id='team-name' value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} placeholder='Design' />
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='team-description'>About</Label>
        <Textarea id='team-description' value={description} maxLength={500} rows={3} onChange={(e) => setDescription(e.target.value)} placeholder='What the team works on (optional)' />
      </div>
    </CardForm>
  );
}

'use client';
// Admin › Programs (mold_v0-291, flag nested_runs with agent_harness; src/program-routes.ts /api/admin/onboarding/programs,
// src/programs.ts, src/nested-runs.ts): the definitions an agent session may spawn, each a typed record in versions, and
// the guardian's decisions about the candidates they produced. The standard list (four cards, the search row with New
// program, the table), a row opening its panel: its definition, versions and the decisions and promoted versions.
// A program's configuration is one JSON document, checked by the server: a keyword it cannot enforce is refused there.
import { useState, type ReactNode } from 'react';
import { useQueryState } from 'nuqs';
import { useQueryClient } from '@tanstack/react-query';
import { PageFrame } from '@/components/layout/page-container';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { adminApi } from '@/lib/api-client';
import { ErrorBox, LoadingCards, When } from '@/features/admin/ui';
import { useAdmin, useAdminAction } from '@/features/admin/lib';
import { Gate, useAdminRole } from '@/features/admin/role';
import { ToneBadge } from '@/features/records/detail-page';
import { ToolbarAction } from '@/features/tabs/tab-action';

// ---------------------------------------------------------------- the shapes (src/programs.ts, src/nested-runs.ts)

interface Summary { id: string; name: string; description: string; icon: string; status: 'active' | 'archived'; version: number; source: 'staff' | 'pack'; updated_by: string; updated_at: string; machine: boolean; acceptance: boolean; spawned_by: string[] }
interface Detail extends Summary { config: Record<string, unknown>; versions: { version: number; note: string; by: string; at: string }[]; created_by: string; created_at: string; archived_at: string | null }
interface Evaluation { id: string; workspace?: string | null; program: string; program_version: number; target: { kind: string; id: string }; hypothesis: string; status: string; outcome: string | null; reasons: string[]; metrics: { n?: number; baseline_mean?: number | null; candidate_mean?: number | null; lift?: number | null; ci_low?: number | null }; candidate: { sha256: string; bytes: number; paths: string[] }; decided_at: string | null; reviewed_by: string | null; review_decision: string | null; promoted_id: string | null; created_at: string }
interface Champion { id: string; version: number; target: { kind: string; id: string }; status: string; metrics: { lift?: number | null }; evaluation: string | null; program: string | null; applied_at: string | null; applied_by: string | null; applied_ref: string | null; rolled_back_at: string | null; rollback_reason: string | null; created_at: string; workspace?: string | null }
interface ListAnswer { programs: Summary[]; evaluations: Evaluation[]; champions: Champion[] }

const BASE = '/programs';
const enc = encodeURIComponent;
const EXAMPLE = `{
  "icon": "sparkles",
  "prompt": "Look into {topic} and report what you find.",
  "inputs": { "type": "object", "required": ["topic"], "properties": { "topic": { "type": "string" } } },
  "outputs": { "type": "object", "required": ["findings"], "properties": { "findings": { "type": "array", "items": { "type": "string" } } } },
  "budget_usd": 1,
  "failure_policy": "continue",
  "retries": 1,
  "spawned_by": ["default"]
}`;
const OUTCOME: Record<string, { label: string; color: 'success' | 'danger' | 'warning' | 'neutral' }> = {
  accepted: { label: 'Accepted', color: 'success' },
  refused: { label: 'Refused', color: 'danger' },
  needs_review: { label: 'Needs a person', color: 'warning' },
};
const Outcome = ({ e }: { e: Evaluation }) => {
  if (e.status !== 'decided' || !e.outcome) return <ToneBadge color='neutral'>Measuring</ToneBadge>;
  const o = OUTCOME[e.outcome]!;
  return <ToneBadge color={o.color}>{o.label}</ToneBadge>;
};
const CHAMPION: Record<string, { label: string; color: 'success' | 'neutral' | 'danger' }> = { champion: { label: 'Current', color: 'success' }, superseded: { label: 'Earlier', color: 'neutral' }, rolled_back: { label: 'Rolled back', color: 'danger' } };
const pct = (v: number | null | undefined) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : 'Not measured');

// ---------------------------------------------------------------- the list

export function ProgramsPage({ bare = false }: { bare?: boolean } = {}) {
  const { data, error, isLoading } = useAdmin<ListAnswer>(BASE);
  const [creating, setCreating] = useQueryState('new');
  const [open, setOpen] = useQueryState('program');
  const rows = data?.programs ?? [];
  const active = rows.filter((r) => r.status === 'active');
  const waiting = (data?.evaluations ?? []).filter((e) => e.outcome === 'needs_review' && !e.review_decision);
  const cols: RecordCol<Summary>[] = [
    { key: 'name', label: 'Program', title: true, keep: true, type: 'text', className: 'min-w-60', value: (r) => r.name, render: (r) => <span className='font-medium'>{r.name}</span> },
    { key: 'kind', label: 'Kind', type: 'text', value: (r) => (r.machine ? 'Steps' : 'One run'), render: (r) => <span className='text-sm'>{r.machine ? 'Steps' : 'One run'}</span> },
    { key: 'guard', label: 'Acceptance', type: 'text', value: (r) => (r.acceptance ? 'Yes' : 'No'), render: (r) => <span className='text-sm'>{r.acceptance ? 'Yes' : 'No'}</span> },
    { key: 'version', label: 'Version', type: 'number', value: (r) => r.version, render: (r) => <span className='tabular-nums'>{r.version}</span> },
    { key: 'status', label: 'Status', type: 'text', value: (r) => r.status, render: (r) => <StatusBadge s={r.status} /> },
    { key: 'updated_at', label: 'Changed', type: 'date', value: (r) => r.updated_at, render: (r) => <When d={r.updated_at} /> },
  ];
  return (
    <PageFrame bare={bare}>
      <ErrorBox error={error} />
      <RecordView<Summary>
        id='admin-programs' noun={rows.length === 1 ? 'program' : 'programs'} loading={isLoading}
        rows={rows} rowKey={(r) => r.id} cols={cols} detailTitle={(r) => r.name}
        openKey={open} onOpenChange={(k) => void setOpen(k)} detail={(r) => <ProgramView key={r.id} id={r.id} />}
        defaultSort={[{ key: 'name', dir: 'asc' }]}
        summary={<StatStrip quad items={[
          { label: 'Active programs', value: active.length, said: `${active.length} active programs` },
          { label: 'With acceptance', value: active.filter((r) => r.acceptance).length, said: 'programs whose candidates are judged by the guardian' },
          { label: 'Waiting for a person', value: waiting.length, said: `${waiting.length} decisions waiting for a person` },
          { label: 'Current champions', value: (data?.champions ?? []).filter((c) => c.status === 'champion').length, said: 'versions currently promoted' },
        ]} />}
        searchText={(r) => `${r.name} ${r.id} ${r.description}`} searchPlaceholder='Search programs'
        toolbarAction={<div className='ml-auto flex shrink-0 gap-2'><Gate need='compute'><ToolbarAction label='New program' icon={<Icons.add />} onClick={() => void setCreating('1')} /></Gate></div>}
        exportName='programs'
        empty={<p className='text-muted-foreground text-sm'>No programs yet. A program is a typed definition of a child session: what it is asked to do, what it takes and returns, and how a run of it is judged.</p>}
      />
      {creating && <ProgramModal program={null} onClose={() => void setCreating(null)} onSaved={(id) => void setOpen(id)} />}
    </PageFrame>
  );
}
const StatusBadge = ({ s }: { s: 'active' | 'archived' }) => <ToneBadge color={s === 'active' ? 'success' : 'neutral'}>{s === 'active' ? 'Active' : 'Archived'}</ToneBadge>;

// ---------------------------------------------------------------- one program

function ProgramView({ id }: { id: string }) {
  const { data, error, isLoading } = useAdmin<{ program: Detail; evaluations: Evaluation[] }>(`${BASE}/${enc(id)}`);
  const all = useAdmin<ListAnswer>(BASE).data;
  const { can } = useAdminRole();
  const qc = useQueryClient();
  const [tab, setTab] = useQueryState('panelTab');
  const [editing, setEditing] = useState(false);
  const archive = useAdminAction((on: boolean) => adminApi('POST', `${BASE}/${enc(id)}/${on ? 'archive' : 'restore'}`), { success: 'Saved' });
  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <LoadingCards count={3} />;
  const p = data.program;
  const evaluations = data.evaluations;
  const champions = (all?.champions ?? []).filter((c) => c.program === p.id);
  const refresh = () => void qc.invalidateQueries();
  return (
    <>
      <div className='flex flex-col gap-4'>
        <Card className='gap-0 py-4'>
          <CardContent className='flex flex-col gap-4 px-6'>
            <div className='flex flex-wrap items-center gap-2'>
              <StatusBadge s={p.status} />
              <span className='text-muted-foreground text-xs'>Version {p.version}{p.source === 'pack' ? ' (from the app)' : ''}</span>
              {can('compute') && <div className='ml-auto flex items-center gap-2'>
                <Button size='sm' variant='outline' onClick={() => setEditing(true)}>Edit</Button>
                <Button size='sm' variant='outline' disabled={archive.isPending} onClick={() => archive.mutate(p.status === 'active')}>{p.status === 'active' ? 'Archive' : 'Restore'}</Button>
              </div>}
            </div>
            {p.description && <p className='text-sm'>{p.description}</p>}
            <dl className='grid grid-cols-2 gap-x-6 gap-y-4 border-t pt-4 sm:grid-cols-4'>
              <Fact label='Kind'>{p.machine ? 'Steps' : 'One run'}</Fact>
              <Fact label='Budget'>${Number(p.config.budget_usd ?? 0).toFixed(2)}</Fact>
              <Fact label='If it fails'>{failureWords(String(p.config.failure_policy ?? 'continue'))}</Fact>
              <Fact label='Started by'>{p.spawned_by.length ? p.spawned_by.join(', ') : 'People only'}</Fact>
            </dl>
          </CardContent>
        </Card>
        <Tabs value={tab ?? 'definition'} onValueChange={(v) => void setTab(v === 'definition' ? null : String(v))} className='w-full gap-4'>
          <TabsList variant='line' className='flex-nowrap justify-start gap-x-6 p-0 group-data-horizontal/tabs:h-auto'>
            <TabsTrigger value='definition' className='h-9 flex-none px-0'>Definition</TabsTrigger>
            <TabsTrigger value='versions' className='h-9 flex-none px-0'>Versions</TabsTrigger>
            <TabsTrigger value='decisions' className='h-9 flex-none px-0'>Decisions{evaluations.length ? ` (${evaluations.length})` : ''}</TabsTrigger>
            <TabsTrigger value='promoted' className='h-9 flex-none px-0'>Promoted{champions.length ? ` (${champions.length})` : ''}</TabsTrigger>
          </TabsList>
          <TabsContent value='definition'>
            <ListCard title='Definition'><pre className='overflow-x-auto px-6 py-4 font-mono text-xs leading-relaxed whitespace-pre-wrap'>{JSON.stringify(p.config, null, 2)}</pre></ListCard>
          </TabsContent>
          <TabsContent value='versions' className='flex flex-col gap-2'>
            {p.versions.map((v) => <ListCard key={v.version} title={`Version ${v.version}${v.version === p.version ? ' (current)' : ''}`} aside={<span className='text-muted-foreground text-xs'>{v.by} · <When d={v.at} /></span>}>{v.note ? <p className='px-6 py-3 text-sm whitespace-pre-wrap'>{v.note}</p> : null}</ListCard>)}
          </TabsContent>
          <TabsContent value='decisions' className='flex flex-col gap-3'>
            {evaluations.length ? evaluations.map((e) => <EvaluationCard key={e.id} e={e} can={can('compute')} onChanged={refresh} />) : <p className='text-muted-foreground text-sm'>No decisions yet. The guardian records one each time a run of this program reaches an acceptance step.</p>}
          </TabsContent>
          <TabsContent value='promoted' className='flex flex-col gap-3'>
            {champions.length ? champions.map((c) => <ChampionCard key={c.id} c={c} can={can('compute')} onChanged={refresh} />) : <p className='text-muted-foreground text-sm'>No version has been promoted yet.</p>}
          </TabsContent>
        </Tabs>
      </div>
      {editing && <ProgramModal program={p} onClose={() => setEditing(false)} />}
    </>
  );
}
const failureWords = (f: string) => ({ fail_fast: 'Stop the others', continue: 'Carry on', escalate: 'Tell a person' })[f] ?? f;

function EvaluationCard({ e, can, onChanged }: { e: Evaluation; can: boolean; onChanged: () => void }) {
  const [reason, setReason] = useState('');
  const review = useAdminAction((decision: 'accept' | 'decline') => adminApi('POST', `/program-evaluations/${enc(e.id)}/review`, { decision, reason }), { success: 'Recorded' });
  const open = e.outcome === 'needs_review' && !e.review_decision;
  return (
    <ListCard title={`${e.target.kind.replace('_', ' ')} ${e.target.id}`} aside={<span className='flex items-center gap-2'><Outcome e={e} /><When d={e.created_at} /></span>}>
      <div className='flex flex-col gap-3 px-6 py-4 text-sm'>
        {e.hypothesis && <p><span className='text-muted-foreground'>What was tried: </span>{e.hypothesis}</p>}
        <ul className='list-disc pl-4'>{e.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
        <dl className='grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4'>
          <Fact label='Cases'>{e.metrics.n ?? 0}</Fact>
          <Fact label='Current best'>{typeof e.metrics.baseline_mean === 'number' ? e.metrics.baseline_mean.toFixed(3) : 'None yet'}</Fact>
          <Fact label='This candidate'>{typeof e.metrics.candidate_mean === 'number' ? e.metrics.candidate_mean.toFixed(3) : 'Not measured'}</Fact>
          <Fact label='Improvement'>{pct(e.metrics.lift)}</Fact>
        </dl>
        {e.candidate.paths.length > 0 && <p className='text-muted-foreground text-xs'>{e.candidate.paths.length} file{e.candidate.paths.length === 1 ? '' : 's'} changed{e.workspace ? ` · from ${e.workspace}` : ''}</p>}
        {e.review_decision && <p className='text-muted-foreground text-xs'>{e.review_decision === 'accept' ? 'Accepted' : 'Declined'} by {e.reviewed_by}</p>}
        {open && can && <div className='flex flex-col gap-2 border-t pt-3'>
          <Input value={reason} onChange={(x) => setReason(x.target.value)} placeholder='Why (kept with the decision)' aria-label='Why' />
          <div className='flex gap-2'>
            <Button size='sm' disabled={!reason.trim() || review.isPending} onClick={() => review.mutate('accept', { onSuccess: onChanged })}>Accept</Button>
            <Button size='sm' variant='outline' disabled={!reason.trim() || review.isPending} onClick={() => review.mutate('decline', { onSuccess: onChanged })}>Decline</Button>
          </div>
        </div>}
      </div>
    </ListCard>
  );
}

function ChampionCard({ c, can, onChanged }: { c: Champion; can: boolean; onChanged: () => void }) {
  const [why, setWhy] = useState('');
  const [ref, setRef] = useState('');
  const rollback = useAdminAction(() => adminApi('POST', `/program-champions/${enc(c.id)}/rollback`, { reason: why }), { success: 'Rolled back' });
  const apply = useAdminAction(() => adminApi('POST', `/program-champions/${enc(c.id)}/apply`, { ref }), { success: 'Recorded' });
  const live = c.status === 'champion';
  return (
    <ListCard title={`${c.target.kind.replace('_', ' ')} ${c.target.id}: version ${c.version}`} aside={<span className='flex items-center gap-2'><ToneBadge color={CHAMPION[c.status]!.color}>{CHAMPION[c.status]!.label}</ToneBadge><When d={c.created_at} /></span>}>
      <div className='flex flex-col gap-3 px-6 py-4 text-sm'>
        <p className='text-muted-foreground text-xs'>Improvement {pct(c.metrics.lift)}{c.workspace ? ` · from ${c.workspace}` : ''}</p>
        {c.applied_at && <p className='text-xs'>Applied by {c.applied_by}{c.applied_ref ? `: ${c.applied_ref}` : ''}</p>}
        {c.rollback_reason && <p className='text-xs'>Rolled back: {c.rollback_reason}</p>}
        {live && can && <div className='flex flex-col gap-2 border-t pt-3'>
          {!c.applied_at && <div className='flex items-center gap-2'>
            <Input value={ref} onChange={(x) => setRef(x.target.value)} placeholder={c.target.kind === 'recipe' ? 'A note (optional)' : 'What was applied, and where'} aria-label='What was applied' />
            <Button size='sm' variant='outline' disabled={apply.isPending || (c.target.kind !== 'recipe' && !ref.trim())} onClick={() => apply.mutate(undefined, { onSuccess: onChanged })}>Apply</Button>
          </div>}
          <div className='flex items-center gap-2'>
            <Input value={why} onChange={(x) => setWhy(x.target.value)} placeholder='Why roll back' aria-label='Why roll back' />
            <Button size='sm' variant='outline' disabled={!why.trim() || rollback.isPending} onClick={() => rollback.mutate(undefined, { onSuccess: onChanged })}>Roll back</Button>
          </div>
        </div>}
      </div>
    </ListCard>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className='flex min-w-0 flex-col gap-1'><dt className='text-muted-foreground text-xs'>{label}</dt><dd className='text-sm font-medium tabular-nums'>{children}</dd></div>;
}
function ListCard({ title, aside, children }: { title: string; aside?: ReactNode; children?: ReactNode }) {
  return <Card className='w-full gap-0 py-0'><CardHeader className='flex flex-row items-center justify-between gap-3 border-b py-3 [.border-b]:pb-3'><CardTitle className='text-sm font-semibold'>{title}</CardTitle>{aside}</CardHeader>{children ? <CardContent className='px-0'>{children}</CardContent> : null}</Card>;
}

// ---------------------------------------------------------------- new and edit

function ProgramModal({ program, onClose, onSaved }: { program: Detail | null; onClose: () => void; onSaved?: (id: string) => void }) {
  const [name, setName] = useState(program?.name ?? '');
  const [description, setDescription] = useState(program?.description ?? '');
  const [config, setConfig] = useState(program ? JSON.stringify(program.config, null, 2) : EXAMPLE);
  const [note, setNote] = useState('');
  const qc = useQueryClient();
  let parsed: unknown = null, invalid = false;
  try { parsed = JSON.parse(config); } catch { invalid = true; }
  const save = useAdminAction(() => program
    ? adminApi('PUT', `${BASE}/${enc(program.id)}`, { version: program.version, name, description, config: parsed, note })
    : adminApi('POST', BASE, { name, description, config: parsed, note }), { success: 'Saved' });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className='sm:max-w-2xl'>
        <DialogHeader><DialogTitle>{program ? 'Edit program' : 'New program'}</DialogTitle><DialogDescription>Each save is a new version; a run keeps the version it started with.</DialogDescription></DialogHeader>
        <div className='flex flex-col gap-3'>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='Name' aria-label='Name' />
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder='What it is for' aria-label='Description' />
          <Textarea value={config} onChange={(e) => setConfig(e.target.value)} rows={16} className='font-mono text-xs' aria-label='Configuration' spellCheck={false} />
          {invalid && <p className='text-destructive text-xs'>That is not valid JSON yet.</p>}
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder='What changed (optional)' aria-label='What changed' />
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>Cancel</Button>
          <Button disabled={!name.trim() || invalid || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: (r: { program: Detail }) => { void qc.invalidateQueries(); onSaved?.(r.program.id); onClose(); } })}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

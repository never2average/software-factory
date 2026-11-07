'use client';
// Admin › Recipes (mold_v0-271, flag workspace_recipes with agent_harness; src/recipe-routes.ts
// /api/admin/onboarding/recipes, src/recipes.ts): reusable agent workspace recipes, each a named bundle of files and
// runtime binaries kept in versions, which an agent profile's workspace upload names (Agent profiles › Workspace upload ›
// Recipes). The list is the standard one (four cards, the search row with New recipe, the table) under the proposals that
// wait for a decision; a row opens the recipe's own page: its header, then tabs for its files, its versions and the
// agents' proposals (self-improvement: an agent proposes the next version of a recipe its session used; staff accept it
// as a new version or decline it). New recipe, New version and Edit open one modal each; files upload in parts through
// the agent profiles' own upload routes (one storage layer for every file a session receives).
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type ReactNode } from 'react';
import { useQueryState } from 'nuqs';
import PageContainer from '@/components/layout/page-container';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { adminApi } from '@/lib/api-client';
import { ADMIN_HEADERS } from '@/lib/env-names';
import { ErrorBox, LoadingCards, When } from '@/features/admin/ui';
import { useAdmin, useAdminAction } from '@/features/admin/lib';
import { Gate, useAdminRole } from '@/features/admin/role';
import { ToneBadge } from '@/features/records/detail-page';
import { ToolbarAction } from '@/features/tabs/tab-action';

// ---------------------------------------------------------------- the shapes (src/recipes.ts)

interface RecipeFile { id: string; path: string; bytes: number; sha256: string; executable: boolean }
interface Summary { id: string; name: string; description: string; status: 'active' | 'archived'; version: number; files: number; bytes: number; pending_proposals: number; updated_by: string; updated_at: string }
interface Version { version: number; files: RecipeFile[]; note: string; source: 'staff' | 'agent'; proposal: string | null; by: string; at: string }
interface Proposal {
  id: string; recipe: string; recipe_name: string; base_version: number; status: 'pending' | 'accepted' | 'declined'; files: RecipeFile[]; changed: string[]; removed: string[]; note: string;
  workspace: string | null; session: string | null; run: string | null; decided_by: string | null; decided_at: string | null; reason: string | null; accepted_version: number | null; at: string; stale: boolean;
}
interface Detail extends Summary { created_by: string; created_at: string; archived_at: string | null; versions: Version[]; proposals: Proposal[] }
interface ListAnswer { recipes: Summary[]; proposals: Proposal[]; limits: { version_bytes: number; files: number } }

const BASE = '/recipes';
const PAGE = '/admin/recipes';
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.ceil(n / 1024)} KB` : `${n} B`);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- the list

/** Admin › Recipes: the proposals waiting, the four cards, the search row with New recipe, the table; a row opens its page. */
export function RecipesPage() {
  const { data, error, isLoading } = useAdmin<ListAnswer>(BASE);
  const router = useRouter();
  const [creating, setCreating] = useQueryState('new');
  const rows = data?.recipes ?? [];
  const cols: RecordCol<Summary>[] = [
    { key: 'name', label: 'Recipe', title: true, keep: true, type: 'text', className: 'min-w-60', value: (r) => r.name,
      render: (r) => <span className='flex min-w-0 flex-col gap-1'><span className='leading-snug font-medium'>{r.name}</span>{r.description && <span className='text-muted-foreground line-clamp-2 text-xs whitespace-normal'>{r.description}</span>}</span> },
    { key: 'status', label: 'Status', type: 'select', keep: true, options: [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }], value: (r) => r.status, render: (r) => <StatusBadge s={r.status} /> },
    { key: 'version', label: 'Version', type: 'number', value: (r) => r.version, render: (r) => <span className='tabular-nums'>{r.version || 'None yet'}</span> },
    { key: 'files', label: 'Files', type: 'number', value: (r) => r.files, render: (r) => <span className='tabular-nums'>{r.files ? `${r.files} (${size(r.bytes)})` : '0'}</span> },
    { key: 'proposals', label: 'Proposals', type: 'number', value: (r) => r.pending_proposals, render: (r) => (r.pending_proposals ? <ToneBadge color='warning'>{plural(r.pending_proposals, 'waiting', 'waiting')}</ToneBadge> : <span className='text-muted-foreground'>None</span>) },
    { key: 'updated', label: 'Changed', type: 'date', keep: true, value: (r) => r.updated_at, render: (r) => <When d={r.updated_at} /> }
  ];
  const active = rows.filter((r) => r.status === 'active');
  const pending = data?.proposals ?? [];
  return (
    <PageContainer>
      <ErrorBox error={error} />
      {pending.length > 0 && <ProposalsWaiting proposals={pending} />}
      <RecordView<Summary>
        id='admin-recipes' noun={rows.length === 1 ? 'recipe' : 'recipes'} loading={isLoading}
        rows={rows} rowKey={(r) => r.id} cols={cols} openKey={null} onOpenChange={(k) => { if (k) router.push(`${PAGE}/${encodeURIComponent(k)}`); }} detail={() => null}
        defaultSort={[{ key: 'name', dir: 'asc' }]}
        summary={<StatStrip quad items={[
          { label: 'Active recipes', value: active.length, said: `${active.length} active recipes` },
          { label: 'Files in them', value: active.reduce((t, r) => t + r.files, 0).toLocaleString('en'), said: `${active.reduce((t, r) => t + r.files, 0)} files in their latest versions` },
          { label: 'Proposals waiting', value: pending.length, said: `${pending.length} proposals from agents waiting for a decision` },
          { label: 'Archived', value: rows.length - active.length, said: `${rows.length - active.length} archived recipes` }
        ]} />}
        searchText={(r) => `${r.name} ${r.id} ${r.description} ${r.status}`} searchPlaceholder='Search recipes'
        toolbarAction={<div className='ml-auto flex shrink-0 gap-2'><Gate need='compute'><NewButton onClick={() => void setCreating('1')} /></Gate></div>}
        exportName='recipes'
        empty={<p className='text-muted-foreground text-sm'>No recipes yet. A recipe is a bundle of files and programs an agent works with: add one, then pick it in an agent profile&apos;s workspace upload.</p>}
      />
      {data && creating && <RecipeModal recipe={null} limits={data.limits} onClose={() => void setCreating(null)} onSaved={(id) => router.push(`${PAGE}/${encodeURIComponent(id)}`)} />}
    </PageContainer>
  );
}

function NewButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return disabled ? <Button disabled aria-label='New recipe' title='New recipe' className='ml-auto shrink-0 max-sm:w-8 max-sm:px-0'><Icons.add /><span className='hidden sm:inline'>New recipe</span></Button>
    : <ToolbarAction label='New recipe' icon={<Icons.add />} onClick={onClick} />;
}
const StatusBadge = ({ s }: { s: 'active' | 'archived' }) => <ToneBadge color={s === 'active' ? 'success' : 'neutral'}>{s === 'active' ? 'Active' : 'Archived'}</ToneBadge>;

/** The approvals staff have to give: each pending proposal, its recipe, where it came from and why. */
function ProposalsWaiting({ proposals }: { proposals: Proposal[] }) {
  return (
    <Card className='w-full gap-0 py-0' data-recipe-proposals-waiting=''>
      <CardHeader className='border-b py-3.5 [.border-b]:pb-3.5'><CardTitle className='text-sm font-semibold'>Proposals waiting for a decision</CardTitle></CardHeader>
      <CardContent className='divide-y px-0'>
        {proposals.map((p) => (
          <div key={p.id} className='flex flex-col gap-1 px-6 py-3 sm:flex-row sm:items-center sm:justify-between'>
            <span className='min-w-0'>
              <Link href={`${PAGE}/${encodeURIComponent(p.recipe)}?tab=proposals`} className='font-medium underline-offset-4 hover:underline'>{p.recipe_name}</Link>
              <span className='text-muted-foreground block truncate text-xs'>{p.note}</span>
            </span>
            <span className='text-muted-foreground shrink-0 text-xs'>{changeWords(p)} · from {p.workspace ?? 'a workspace'} · <When d={p.at} /></span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
const changeWords = (p: Pick<Proposal, 'changed' | 'removed' | 'base_version'>) =>
  [p.changed.length ? `${plural(p.changed.length, 'file')} changed or added` : '', p.removed.length ? `${plural(p.removed.length, 'file')} removed` : ''].filter(Boolean).join(', ') + ` over version ${p.base_version}`;

// ---------------------------------------------------------------- one recipe's page

/** A recipe's page: its header (name, status, facts, actions), then Files, Versions and Proposals. */
export function RecipePage({ id }: { id: string }) {
  const { data, error, isLoading } = useAdmin<{ recipe: Detail }>(`${BASE}/${encodeURIComponent(id)}`);
  const limits = useAdmin<ListAnswer>(BASE).data?.limits ?? { version_bytes: 0, files: 500 };
  const { can } = useAdminRole();
  const [tab, setTab] = useQueryState('tab');
  const [modal, setModal] = useState<'version' | 'edit' | null>(null);
  const archive = useAdminAction((on: boolean) => adminApi('POST', `${BASE}/${encodeURIComponent(id)}/${on ? 'archive' : 'restore'}`), { success: (r: { recipe: Detail }) => (r.recipe.status === 'archived' ? 'Archived: no profile may pick it' : 'Restored') });
  if (error) return <PageContainer><ErrorBox error={error} /></PageContainer>;
  if (isLoading || !data) return <PageContainer><LoadingCards count={3} /></PageContainer>;
  const r = data.recipe;
  const current = r.versions.find((v) => v.version === r.version) ?? null;
  const pending = r.proposals.filter((p) => p.status === 'pending');
  const editable = can('compute') && r.status === 'active';
  return (
    <PageContainer>
      <div className='flex w-full flex-col gap-4 md:gap-6' data-recipe-page={r.id}>
        <Card className='w-full gap-0 py-0' data-record-header=''>
          <CardContent className='flex flex-col gap-5 py-5'>
            <div className='flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between'>
              <div className='flex min-w-0 flex-1 flex-col gap-2'>
                <p className='text-muted-foreground text-xs'><Link href={PAGE} className='underline-offset-4 hover:underline'>Recipes</Link></p>
                <h1 className='text-xl leading-tight font-semibold tracking-tight break-words md:text-2xl'>{r.name}</h1>
                {r.description && <p className='text-muted-foreground max-w-prose text-sm leading-relaxed break-words'>{r.description}</p>}
                <div className='flex flex-wrap items-center gap-2 pt-1'>
                  <StatusBadge s={r.status} />
                  {pending.length > 0 && <ToneBadge color='warning'>{plural(pending.length, 'proposal')} waiting</ToneBadge>}
                </div>
              </div>
              {can('compute') && (
                <div className='flex shrink-0 flex-wrap gap-2'>
                  {editable && <Button type='button' variant='outline' size='sm' onClick={() => setModal('version')} data-recipe-new-version=''><Icons.upload aria-hidden data-icon='inline-start' />New version</Button>}
                  {editable && <Button type='button' variant='outline' size='sm' onClick={() => setModal('edit')} data-recipe-edit=''><Icons.edit aria-hidden data-icon='inline-start' />Edit</Button>}
                  <Button type='button' variant='outline' size='sm' onClick={() => archive.mutate(r.status === 'active')} data-recipe-archive=''>{r.status === 'active' ? 'Archive' : 'Restore'}</Button>
                </div>
              )}
            </div>
            <dl className='grid grid-cols-2 gap-x-6 gap-y-5 border-t pt-5 sm:grid-cols-4' data-record-facts=''>
              <Fact label='Version'>{r.version || 'None yet'}</Fact>
              <Fact label='Files'>{r.files ? `${r.files} (${size(r.bytes)})` : '0'}</Fact>
              <Fact label='Programs'>{(current?.files ?? []).filter((f) => f.executable).length}</Fact>
              <Fact label='Versions from agents'>{r.versions.filter((v) => v.source === 'agent').length}</Fact>
            </dl>
            <p className='text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-4 text-xs'>
              <span>ID <span className='text-foreground font-mono'>{r.id}</span></span><span aria-hidden>·</span>
              <span>Added by <span className='text-foreground'>{r.created_by}</span></span><span aria-hidden>·</span>
              <span>Changed <When d={r.updated_at} /> by <span className='text-foreground'>{r.updated_by}</span></span>
            </p>
          </CardContent>
        </Card>
        <Tabs value={tab ?? 'files'} onValueChange={(v) => void setTab(v === 'files' ? null : String(v))} className='w-full gap-4'>
          <TabsList variant='line' className='flex-nowrap justify-start gap-x-6 p-0 group-data-horizontal/tabs:h-auto'>
            <TabsTrigger value='files' className='h-9 flex-none px-0'>Files</TabsTrigger>
            <TabsTrigger value='versions' className='h-9 flex-none px-0'>Versions</TabsTrigger>
            <TabsTrigger value='proposals' className='h-9 flex-none px-0'>Proposals{pending.length ? ` (${pending.length})` : ''}</TabsTrigger>
          </TabsList>
          <TabsContent value='files'>
            <ListCard title={current ? `Version ${current.version}` : 'No version yet'}>
              {current ? <FileTable files={current.files} href={(n) => `/api/admin/onboarding${BASE}/${encodeURIComponent(r.id)}/versions/${current.version}/files/${n}`} />
                : <p className='text-muted-foreground px-6 py-4 text-sm'>No files yet: New version uploads its first.</p>}
            </ListCard>
          </TabsContent>
          <TabsContent value='versions' className='flex flex-col gap-4'>
            {r.versions.length ? r.versions.map((v) => (
              <ListCard key={v.version} title={`Version ${v.version}${v.version === r.version ? ' (latest)' : ''}`} aside={<span className='text-muted-foreground text-xs'>{v.source === 'agent' ? 'Proposed by an agent, accepted by ' : 'By '}{v.by} · <When d={v.at} /></span>}>
                {v.note && <p className='border-b px-6 py-3 text-sm whitespace-pre-wrap'>{v.note}</p>}
                <FileTable files={v.files} href={(n) => `/api/admin/onboarding${BASE}/${encodeURIComponent(r.id)}/versions/${v.version}/files/${n}`} />
              </ListCard>
            )) : <p className='text-muted-foreground text-sm'>No version yet.</p>}
          </TabsContent>
          <TabsContent value='proposals' className='flex flex-col gap-4'>
            {r.proposals.length ? r.proposals.map((p) => <ProposalCard key={p.id} p={p} canDecide={can('compute')} />)
              : <p className='text-muted-foreground text-sm'>No proposals yet. An agent whose session started with this recipe proposes an improved version by writing it into <span className='font-mono text-xs'>.recipe-proposal/{r.id}/</span> in its workspace (note.md, remove.txt, files/).</p>}
          </TabsContent>
        </Tabs>
      </div>
      {modal && <RecipeModal recipe={r} mode={modal} limits={limits} onClose={() => setModal(null)} />}
    </PageContainer>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className='flex min-w-0 flex-col gap-1'><dt className='text-muted-foreground text-xs'>{label}</dt><dd className='text-sm font-medium tabular-nums'>{children}</dd></div>;
}
function ListCard({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <Card className='w-full gap-0 py-0'>
      <CardHeader className='flex flex-row items-center justify-between gap-3 border-b py-3.5 [.border-b]:pb-3.5'><CardTitle className='text-sm font-semibold'>{title}</CardTitle>{aside}</CardHeader>
      <CardContent className='px-0'>{children}</CardContent>
    </Card>
  );
}
function FileTable({ files, href, marks }: { files: RecipeFile[]; href: (n: number) => string; marks?: (f: RecipeFile) => ReactNode }) {
  if (!files.length) return <p className='text-muted-foreground px-6 py-4 text-sm'>No files.</p>;
  return (
    <div className='overflow-x-auto'>
      <table className='w-full text-sm' data-recipe-files=''>
        <thead><tr className='text-muted-foreground border-b text-left text-xs'><th className='px-6 py-2 font-medium'>Path</th><th className='px-3 py-2 text-right font-medium'>Size</th><th className='px-3 py-2 font-medium'>Kind</th><th className='px-6 py-2' /></tr></thead>
        <tbody>
          {files.map((f, i) => (
            <tr key={f.path} className='border-b last:border-0'>
              <td className='px-6 py-2 font-mono text-xs break-all'>{f.path}{marks?.(f)}</td>
              <td className='px-3 py-2 text-right tabular-nums'>{size(f.bytes)}</td>
              <td className='px-3 py-2'>{f.executable ? <ToneBadge color='info'>Program</ToneBadge> : <span className='text-muted-foreground text-xs'>File</span>}</td>
              <td className='px-6 py-2 text-right'><a href={href(i + 1)} className='text-xs underline-offset-4 hover:underline' download>Download</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One agent proposal: why, what it changes, where it came from; Accept (the next version) or Decline (with a reason). */
function ProposalCard({ p, canDecide }: { p: Proposal; canDecide: boolean }) {
  const [reason, setReason] = useState('');
  const decide = useAdminAction((accept: boolean) => adminApi('POST', `/recipe-proposals/${p.id}/${accept ? 'accept' : 'decline'}`, accept ? {} : { reason }),
    { success: (x: { proposal: Proposal }) => (x.proposal.status === 'accepted' ? `Accepted as version ${x.proposal.accepted_version}` : 'Declined') });
  const tone = p.status === 'pending' ? 'warning' : p.status === 'accepted' ? 'success' : 'neutral';
  return (
    <ListCard title={`Proposal over version ${p.base_version}`} aside={<span className='flex items-center gap-2'><ToneBadge color={tone}>{p.status === 'pending' ? 'Waiting' : p.status === 'accepted' ? `Accepted as version ${p.accepted_version}` : 'Declined'}</ToneBadge></span>}>
      <div className='flex flex-col gap-3 border-b px-6 py-3 text-sm' data-recipe-proposal={p.status}>
        <p className='whitespace-pre-wrap'>{p.note}</p>
        <p className='text-muted-foreground text-xs'>{changeWords(p)} · from {p.workspace ?? 'a workspace'}{p.session ? `, agent session ${p.session}` : ''} · <When d={p.at} />{p.decided_by ? ` · decided by ${p.decided_by}` : ''}</p>
        {p.reason && <p className='text-muted-foreground text-xs'>Reason: {p.reason}</p>}
        {p.removed.length > 0 && <p className='text-xs'>Removes: <span className='font-mono'>{p.removed.join(', ')}</span></p>}
        {p.stale && <p role='status' className='rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs'>The recipe has a newer version than the one this was made against: it can only be declined.</p>}
        {p.status === 'pending' && canDecide && (
          <div className='flex flex-wrap items-center gap-2'>
            <Button type='button' variant='outline' size='sm' disabled={p.stale || decide.isPending} onClick={() => decide.mutate(true)} data-proposal-accept=''><Icons.check aria-hidden data-icon='inline-start' />Accept as a new version</Button>
            <Input aria-label='Why it is declined' placeholder='Why it is declined' value={reason} onChange={(e) => setReason(e.target.value)} className='min-w-48 flex-1' />
            <Button type='button' variant='outline' size='sm' disabled={!reason.trim() || decide.isPending} onClick={() => decide.mutate(false)} data-proposal-decline=''>Decline</Button>
          </div>
        )}
      </div>
      <FileTable files={p.files} href={(n) => `/api/admin/onboarding/recipe-proposals/${p.id}/files/${n}`}
        marks={(f) => (p.changed.includes(f.path) ? <span className='ml-2'><ToneBadge color='info'>Changed</ToneBadge></span> : null)} />
    </ListCard>
  );
}

// ---------------------------------------------------------------- the modal: a new recipe, a new version, its name

type Row = RecipeFile & { row: number; progress: number | null; error: string | null };
let seq = 0;
const next = () => ++seq;

/** One file to the agent profiles' upload routes, in parts (mold_v0-267): its upload's id, sha256 and whether it is a program. */
async function uploadFile(file: File, progress: (pct: number) => void): Promise<{ id: string; sha256: string; bytes: number; executable: boolean }> {
  const { upload } = await adminApi<{ upload: { id: string; parts: number; part_bytes: number } }>('POST', '/agent-profiles/uploads', { bytes: file.size });
  for (let n = 0; n < upload.parts; n++) {
    const part = file.slice(n * upload.part_bytes, Math.min(file.size, (n + 1) * upload.part_bytes));
    const res = await fetch(`/api/admin/onboarding/agent-profiles/uploads/${upload.id}/parts/${n}`, { method: 'PUT', credentials: 'same-origin', body: part,
      headers: { accept: 'application/json', 'content-type': 'application/octet-stream', ...ADMIN_HEADERS } });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The upload stopped (${res.status}).`);
    progress(Math.round(((n + 1) / upload.parts) * 100));
  }
  return (await adminApi<{ upload: { id: string; sha256: string; bytes: number; executable: boolean } }>('POST', `/agent-profiles/uploads/${upload.id}/complete`, {})).upload;
}

function RecipeModal({ recipe, mode = 'version', limits, onClose, onSaved }: { recipe: Detail | null; mode?: 'version' | 'edit'; limits: { version_bytes: number; files: number }; onClose: () => void; onSaved?: (id: string) => void }) {
  const naming = !recipe || mode === 'edit', filing = !recipe || mode === 'version';
  const current = recipe?.versions.find((v) => v.version === recipe.version);
  const [name, setName] = useState(recipe?.name ?? '');
  const [description, setDescription] = useState(recipe?.description ?? '');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<Row[]>(() => (current?.files ?? []).map((f) => ({ ...f, row: next(), progress: null, error: null })));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null);
  const total = files.reduce((t, f) => t + f.bytes, 0);
  const uploading = files.some((f) => f.progress !== null);
  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    const chosen = [...list];
    if (limits.version_bytes && chosen.reduce((t, f) => t + f.size, total) > limits.version_bytes) { setProblem(`Those files would make ${size(chosen.reduce((t, f) => t + f.size, total))}: a version holds at most ${size(limits.version_bytes)}.`); return; }
    for (const file of chosen) {
      const row = next(), path = (file.webkitRelativePath || file.name).replace(/^\/+/, '');
      setFiles((fs) => [...fs.filter((x) => x.path !== path), { row, id: '', path, bytes: file.size, sha256: '', executable: false, progress: 0, error: null }]);
      try {
        const u = await uploadFile(file, (pct) => setFiles((fs) => fs.map((f) => (f.row === row ? { ...f, progress: pct } : f))));
        setFiles((fs) => fs.map((f) => (f.row === row ? { ...f, id: u.id, sha256: u.sha256, bytes: u.bytes, executable: u.executable, progress: null } : f)));
      } catch (e) { setFiles((fs) => fs.map((f) => (f.row === row ? { ...f, progress: null, error: (e as Error).message } : f))); }
    }
  };
  const submit = async () => {
    setProblem(null); setBusy(true);
    const list = files.filter((f) => f.id).map((f) => ({ id: f.id, path: f.path.trim(), executable: f.executable }));
    try {
      if (!recipe) {
        const r = await adminApi<{ recipe: Detail }>('POST', BASE, { name, description, note, ...(list.length ? { files: list } : {}) });
        onSaved?.(r.recipe.id);
      } else if (mode === 'edit') await adminApi('PUT', `${BASE}/${encodeURIComponent(recipe.id)}`, { name, description });
      else await adminApi('POST', `${BASE}/${encodeURIComponent(recipe.id)}/versions`, { version: recipe.version, files: list, note });
      onClose();
      window.location.reload();
    } catch (e) { setProblem((e as Error).message); } finally { setBusy(false); }
  };
  const title = !recipe ? 'New recipe' : mode === 'edit' ? `Edit ${recipe.name}` : `New version of ${recipe.name}`;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className='max-h-[90dvh] overflow-y-auto sm:max-w-2xl' data-recipe-modal={mode}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{filing ? `Files and folders an agent works with, programs included (made executable in its workspace). At most ${size(limits.version_bytes)} a version; saving makes the next version, and sessions already running keep theirs.` : 'Its name and description (its files are its versions).'}</DialogDescription>
        </DialogHeader>
        <form className='grid gap-4' onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {naming && <>
            <div className='grid gap-1.5'><label htmlFor='rc-name' className='text-xs font-medium'>Name</label><Input id='rc-name' value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></div>
            <div className='grid gap-1.5'><label htmlFor='rc-desc' className='text-xs font-medium'>Description</label><Textarea id='rc-desc' rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></div>
          </>}
          {filing && <>
            <div className='grid gap-2' data-rc-files=''>
              <span className='text-xs font-medium'>Files{files.length ? ` (${files.length}, ${size(total)})` : ''}</span>
              {files.length ? files.map((f) => (
                <div key={f.row} className='flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5'>
                  <Input aria-label='Path in the workspace' value={f.path} className='min-w-0 flex-1 font-mono text-xs' onChange={(e) => setFiles((fs) => fs.map((x) => (x.row === f.row ? { ...x, path: e.target.value } : x)))} />
                  <span className='text-muted-foreground w-20 shrink-0 text-right text-xs tabular-nums'>{f.progress !== null ? `${f.progress}%` : f.error ? 'Failed' : size(f.bytes)}</span>
                  <label className='flex shrink-0 items-center gap-1.5 text-xs'><Checkbox checked={f.executable} disabled={f.progress !== null} onCheckedChange={(v) => setFiles((fs) => fs.map((x) => (x.row === f.row ? { ...x, executable: v === true } : x)))} aria-label={`Executable: ${f.path}`} />Executable</label>
                  <Button type='button' variant='outline' size='sm' aria-label={`Remove ${f.path}`} onClick={() => setFiles((fs) => fs.filter((x) => x.row !== f.row))}><Icons.trash /></Button>
                  {f.error && <span className='text-destructive basis-full text-xs'>{f.error}</span>}
                </div>
              )) : <p className='text-muted-foreground text-sm'>No files yet.</p>}
              <div className='flex flex-wrap gap-2'>
                <input ref={fileInput} type='file' multiple className='sr-only' tabIndex={-1} aria-label='Choose files' onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
                <input ref={folderInput} type='file' multiple className='sr-only' tabIndex={-1} aria-label='Choose a folder' {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
                <Button type='button' variant='outline' size='sm' onClick={() => fileInput.current?.click()} data-rc-add-files=''><Icons.add />Add files</Button>
                <Button type='button' variant='outline' size='sm' onClick={() => folderInput.current?.click()}><Icons.folder />Add folder</Button>
              </div>
            </div>
            <div className='grid gap-1.5'><label htmlFor='rc-note' className='text-xs font-medium'>What this version changes</label><Textarea id='rc-note' rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} /></div>
          </>}
          {problem && <p role='alert' className='border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm'>{problem}</p>}
          <DialogFooter className='gap-2'>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Button type='submit' variant='outline' disabled={busy || uploading || (naming && !name.trim())} data-rc-save=''>{busy ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

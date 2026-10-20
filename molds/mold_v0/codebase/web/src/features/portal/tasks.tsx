'use client';
// /app/tasks: the programming tasks this account brings, as task sets per product (org_task_sets; import_tasks in the
// AI client, or New task set, Add task and Import here; src/private.ts), plus the tasks onboarding picked into a
// product, by title and status only (no badge: the prompt and the library itself stay Octillion's). Members create,
// edit, turn tasks off and publish their own to Octillion's library (the Published column; publish.tsx); viewers read.
// A save here counts for the "Bring your own programming tasks" journey the same as the tool.
import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { ActionsMenu, Field, RecordView, type RecordCol, type RowAction } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { parseCsv } from '@/lib/csv';
import { Chips, Mono, StatusBadge } from '@/features/admin/ui';
import { CopyButton, ErrorState, FormRow, When, fail, useOrgLoad } from './shared';
import { PUBLISHED_OPTIONS, PublishDialog, PublishedBadge, PublishedLine, publishedLabel, withdrawPublication, type Publication } from './publish';
import { Allowed, useAccountRole } from './role';

const PLATFORMS = ['web', 'mobile', 'backend', 'desktop', 'cli', 'data', 'other'] as const;
interface Product { slug: string; name: string }
interface TaskSet { id: string; name: string; description: string | null; product: string; created_at: string; active_tasks: number }
interface Run { task_set: string; id: string; name: string; status: string; created_at: string }
export interface Task {
  id: number; title: string; prompt: string | null; repo_url: string | null; language: string | null; tags: string[] | null; platform: string | null;
  template: string | null; expectation: 'recommend' | 'avoid'; active: boolean; source: string; provenance: string | null; curated: boolean;
  task_set: string | null; product: string; product_name: string; created_at: string; publishable?: boolean; publication?: Publication | null;
}
interface Data { task_sets: TaskSet[]; tasks: Task[]; runs: Run[]; products: Product[]; publish?: { credit_usd: number } }
/** What import_tasks takes for one task. */
export interface TaskInput { title?: string; prompt: string; language?: string; tags?: string[]; platform?: string; template?: string; repo_url?: string; expectation?: string; provenance?: string }
interface Draft { title: string; prompt: string; language: string; platform: string; repo_url: string; tags: string }

const NA = <span className='text-muted-foreground'>—</span>;
const META = 'text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-none';
const PROMPT = 'block font-mono text-xs leading-relaxed whitespace-pre-wrap border-l-2 pl-3';
const Dot = () => <span className='text-muted-foreground/60'>·</span>;
const Label = ({ children }: { children: ReactNode }) => <div className='text-muted-foreground mb-2 text-xs font-medium leading-none'>{children}</div>;
const repoName = (u: string) => { try { const x = new URL(u); return `${x.host}${x.pathname.replace(/\/$/, '')}`; } catch { return u.replace(/^https?:\/\//, ''); } };
const PICKED_SET = '__picked';
const PICKED = 'Picked by onboarding';
const blankDraft = (): Draft => ({ title: '', prompt: '', language: '', platform: '', repo_url: '', tags: '' });
const toDraft = (t: Task): Draft => ({ title: t.title, prompt: t.prompt ?? '', language: t.language ?? '', platform: t.platform ?? '', repo_url: t.repo_url ?? '', tags: (t.tags ?? []).join(', ') });
/** A draft as import_tasks input: blanks left out, so the server picks the platform and starter workspace. */
const toInput = (d: Draft): TaskInput => ({
  prompt: d.prompt.trim(), ...(d.title.trim() ? { title: d.title.trim() } : {}), ...(d.language.trim() ? { language: d.language.trim() } : {}),
  ...(d.platform ? { platform: d.platform } : {}), ...(d.repo_url.trim() ? { repo_url: d.repo_url.trim() } : {}),
  ...(d.tags.trim() ? { tags: d.tags.split(',').map((s) => s.trim()).filter(Boolean) } : {})
});

export function TasksPage() {
  const { data, error, reload } = useOrgLoad(() => appApi<Data>('GET', '/tasks'));
  const { lock } = useAccountRole();
  const [product, setProduct] = useState('');
  const [set, setSet] = useState('');
  const [dialog, setDialog] = useState<null | { kind: 'set' } | { kind: 'add'; set: TaskSet } | { kind: 'edit'; task: Task } | { kind: 'import' } | { kind: 'publish'; task: Task }>(null);

  const sets = useMemo(() => new Map((data?.task_sets ?? []).map((s) => [s.id, s])), [data]);
  const runsOf = (id: string | null) => (data?.runs ?? []).filter((r) => r.task_set === id);
  const products = data?.products ?? [];
  const setsShown = (data?.task_sets ?? []).filter((s) => !product || s.product === product);
  const rows = useMemo(() => (data?.tasks ?? []).filter((t) => (!product || t.product === product)
    && (!set || (set === PICKED_SET ? !t.task_set : t.task_set === set))), [data, product, set]);
  const setName = (t: Task) => (t.task_set ? sets.get(t.task_set)?.name ?? '—' : PICKED);

  const setActive = (t: Task, active: boolean) => appApi('PATCH', `/tasks/${t.id}`, { active })
    .then(() => { toast.success(active ? 'Task turned on' : 'Task turned off'); return reload(); }).catch(fail);

  const cols: RecordCol<Task>[] = [
    { key: 'title', label: 'Task', className: 'min-w-72', title: true, keep: true, peek: false, type: 'text', value: (t) => t.title, render: (t) => (
      <span className='flex min-w-0 flex-col gap-1.5'>
        <span className='truncate leading-none font-medium' title={t.title}>{t.title}</span>
        {!t.curated && t.prompt && <span className='text-muted-foreground line-clamp-1 text-xs leading-snug'>{t.prompt}</span>}
      </span>
    ) },
    { key: 'set', label: 'Task set', className: 'w-48', type: 'select', value: setName, render: (t) => <span className='text-sm'>{setName(t)}</span> },
    { key: 'product', label: 'Product', className: 'w-40', hidden: products.length <= 1, type: 'select', value: (t) => t.product_name, render: (t) => t.product_name },
    { key: 'stack', label: 'Stack', className: 'w-32', type: 'text', value: (t) => [t.language, t.platform].filter(Boolean).join(' / '),
      render: (t) => (!t.language && !t.platform ? NA : (
        <span className='flex flex-col gap-1.5'>
          <span className='leading-none'>{t.language ?? NA}</span>
          {t.platform && <span className='text-muted-foreground text-xs leading-none'>{t.platform}</span>}
        </span>
      )) },
    { key: 'language', label: 'Language', className: 'w-28', hidden: true, type: 'select', value: (t) => t.language, render: (t) => t.language ?? NA },
    { key: 'platform', label: 'Platform', className: 'w-28', hidden: true, type: 'select', value: (t) => t.platform, render: (t) => t.platform ?? NA },
    { key: 'repo', label: 'Repository', className: 'w-52', hidden: true, type: 'text', value: (t) => t.repo_url,
      render: (t) => (t.repo_url ? <span className='text-muted-foreground block max-w-52 truncate text-xs' title={t.repo_url}>{repoName(t.repo_url)}</span> : NA) },
    { key: 'tags', label: 'Tags', className: 'min-w-40', type: 'text', value: (t) => (t.tags ?? []).join(', '), render: (t) => <Chips items={t.tags} max={2} oneLine /> },
    { key: 'created_at', label: 'Added', className: 'w-28', hidden: true, type: 'date', value: (t) => t.created_at, render: (t) => <span className='text-muted-foreground text-xs'><When d={t.created_at} /></span> },
    { key: 'published', label: 'Published', className: 'w-28', hidden: true, type: 'select', value: (t) => publishedLabel(t.publication), options: PUBLISHED_OPTIONS,
      render: (t) => <PublishedBadge p={t.publication} /> },
    { key: 'active', label: 'Status', name: 'Active', className: 'w-24', keep: true, type: 'boolean', value: (t) => t.active,
      render: (t) => (
        <span className='flex flex-col items-start gap-1.5'>
          <StatusBadge tone={t.active ? 'ok' : 'neutral'}>{t.active ? 'on' : 'off'}</StatusBadge>
          {t.publication && <span className='text-muted-foreground text-xs leading-none'>{publishedLabel(t.publication)}</span>}
        </span>
      ) }
  ];

  const actions = (t: Task): RowAction[] => [
    ...(t.task_set ? [lock({ label: 'Edit', icon: <Icons.edit />, onSelect: () => setDialog({ kind: 'edit', task: t }) }, 'edit')] : []),
    ...(t.task_set && sets.get(t.task_set) ? [lock({ label: 'Add a task to this set', icon: <Icons.add />, onSelect: () => setDialog({ kind: 'add', set: sets.get(t.task_set!)! }) }, 'edit')] : []),
    ...(t.publishable && t.publication?.status === 'submitted'
      ? [lock({ label: 'Withdraw from review', icon: <Icons.xCircle />, onSelect: () => void withdrawPublication(t.publication!, reload) }, 'edit')]
      : t.publishable ? [lock({ label: 'Publish to Octillion’s library', icon: <Icons.share />, onSelect: () => setDialog({ kind: 'publish', task: t }) }, 'edit')] : []),
    lock({ label: t.active ? 'Turn off' : 'Turn on', icon: t.active ? <Icons.eyeOff /> : <Icons.check />, separator: true, onSelect: () => void setActive(t, !t.active) }, 'edit')
  ];

  const noProducts = !!data && !products.length;
  // One button plus RecordView's own ▾ menu (Import, then the export items).
  const primary = <Allowed need='edit'><Button disabled={noProducts} onClick={() => setDialog({ kind: 'set' })}><Icons.add /> New task set</Button></Allowed>;
  const importItem = lock({ label: 'Import', icon: <Icons.upload />, onSelect: () => setDialog({ kind: 'import' }) }, 'edit');
  const primaryMenu: RowAction[] = [noProducts ? { ...importItem, disabled: true } : importItem];
  const filters = (<>
    {products.length > 1 && (
      <NativeSelect aria-label='Product' value={product} onChange={(e) => { setProduct(e.target.value); setSet(''); }}>
        <NativeSelectOption value=''>All products</NativeSelectOption>
        {products.map((p) => <NativeSelectOption key={p.slug} value={p.slug}>{p.name}</NativeSelectOption>)}
      </NativeSelect>
    )}
    <NativeSelect aria-label='Task set' value={set} onChange={(e) => setSet(e.target.value)}>
      <NativeSelectOption value=''>All task sets</NativeSelectOption>
      {setsShown.map((s) => <NativeSelectOption key={s.id} value={s.id}>{s.name}{products.length > 1 && !product ? ` (${products.find((p) => p.slug === s.product)?.name ?? s.product})` : ''}</NativeSelectOption>)}
      {(data?.tasks ?? []).some((t) => !t.task_set) && <NativeSelectOption value={PICKED_SET}>{PICKED}</NativeSelectOption>}
    </NativeSelect>
  </>);

  return (
    <PageContainer>
      {error ? <ErrorState error={error} /> : (
        <RecordView<Task>
          id='app-tasks' noun='tasks' exportName='tasks'
          rows={rows} rowKey={(t) => String(t.id)} cols={cols} actions={actions} loading={!data}
          defaultSort={[{ key: 'set', dir: 'asc' }, { key: 'title', dir: 'asc' }]}
          searchText={(t) => `${t.title} ${t.prompt ?? ''} ${setName(t)} ${t.product_name} ${t.language ?? ''} ${t.platform ?? ''} ${(t.tags ?? []).join(' ')}`}
          searchPlaceholder='Search tasks by title, prompt, set or tag'
          filters={filters} primary={primary} primaryMenu={primaryMenu}
          empty={noProducts ? 'Add a product first: an owner adds it under Context, Products, or onboard it from your AI client.'
            : 'No tasks yet. Onboarding picks tasks for your product; create a task set or import your own.'}
          detailTitle={(t) => t.title}
          detailActions={(t) => (<>
            {t.task_set && <Allowed need='edit'><Button size='sm' variant='outline' onClick={() => setDialog({ kind: 'edit', task: t })}><Icons.edit /> Edit</Button></Allowed>}
            <ActionsMenu items={actions(t).filter((a) => a.label !== 'Edit')} />
          </>)}
          detail={(t) => <TaskBody t={t} set={t.task_set ? sets.get(t.task_set) ?? null : null} runs={runsOf(t.task_set)} />}
        />
      )}
      {data && dialog?.kind === 'set' && <TaskDialog products={products} sets={data.task_sets} product={product || products[0]?.slug} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void reload(); }} />}
      {data && dialog?.kind === 'add' && <TaskDialog products={products} sets={data.task_sets} product={dialog.set.product} fixed={dialog.set} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void reload(); }} />}
      {dialog?.kind === 'edit' && <TaskDialog products={products} sets={data?.task_sets ?? []} task={dialog.task} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void reload(); }} />}
      {dialog?.kind === 'publish' && <PublishDialog kind='task' title={dialog.task.title} path={`/tasks/${dialog.task.id}/publish`} creditUsd={data?.publish?.credit_usd}
        onClose={() => setDialog(null)} onDone={() => { setDialog(null); void reload(); }} />}
      {data && dialog?.kind === 'import' && <ImportDialog products={products} sets={data.task_sets} product={product || products[0]?.slug} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void reload(); }} />}
    </PageContainer>
  );
}

/**
 * The task peek: a meta line, properties, the prompt in full, where it came from, and its set with the runs that used
 * it. A task onboarding picked: its title, product and status, without the prompt.
 */
function TaskBody({ t, set, runs }: { t: Task; set: TaskSet | null; runs: Run[] }) {
  const prompt = set ? `Run a simulation for ${t.product_name} on the task set ${set.name}.` : `Run a simulation for ${t.product_name} on the task "${t.title}".`;
  const runIt = (
    <section>
      <Label>Run it</Label>
      <div className='bg-muted/50 flex items-center gap-2 rounded-md border px-3 py-2'>
        <code className='min-w-0 flex-1 font-mono text-xs break-words select-all'>{prompt}</code>
        <CopyButton text={prompt} label='Copy prompt' />
      </div>
    </section>
  );
  if (t.curated) return (
    <div className='flex flex-col gap-8'>
      <div className={META}>
        <span className={t.active ? 'text-foreground font-medium' : ''}>{t.active ? 'On' : 'Off'}</span><Dot />
        <Mono>#{t.id}</Mono><Dot />
        <span>Added <When d={t.created_at} /></span>
      </div>
      <dl>
        <Field label='Product'>{t.product_name}</Field>
        {t.platform && <Field label='Platform'>{t.platform}</Field>}
      </dl>
      <section><Label>Prompt</Label><p className='text-muted-foreground text-sm'>Onboarding picked this task for {t.product_name}. Its prompt isn&apos;t shown, and it can&apos;t be published.</p></section>
      {runIt}
    </div>
  );
  return (
    <div className='flex flex-col gap-8'>
      <div className={META}>
        <span className={t.active ? 'text-foreground font-medium' : ''}>{t.active ? 'On' : 'Off'}</span><Dot />
        <span>Private to your account</span><Dot />
        <Mono>#{t.id}</Mono><Dot />
        <span>Added <When d={t.created_at} /></span>
      </div>
      <dl>
        <Field label='Task set'>{set ? set.name : NA}</Field>
        <Field label='Product'>{t.product_name}</Field>
        <Field label='Language'>{t.language ?? NA}</Field>
        <Field label='Platform'>{t.platform ?? NA}</Field>
        <Field label='Repository'>
          {t.repo_url
            ? <a href={t.repo_url} target='_blank' rel='noopener noreferrer' className='hover:text-primary inline-flex items-center gap-1'>{repoName(t.repo_url)}<Icons.externalLink className='size-3.5' /></a>
            : <span className='text-muted-foreground'>None: runs in the {t.template ? <Mono>{t.template}</Mono> : 'matching'} starter workspace</span>}
        </Field>
        <Field label='Tags'><Chips items={t.tags} /></Field>
        {t.expectation === 'avoid' && <Field label='Expectation'>Agents should not pick the product</Field>}
        {t.provenance && <Field label='Comes from'>{t.provenance}</Field>}
        {t.publishable && <Field label='Published'><PublishedLine p={t.publication} /></Field>}
      </dl>
      <section><Label>Prompt</Label><code className={PROMPT}>{t.prompt}</code></section>
      {set && (
        <section>
          <Label>Runs that used {set.name}</Label>
          {runs.length ? (
            <ul className='divide-y border-y text-sm'>
              {runs.map((r) => (
                <li key={r.id} className='flex items-center gap-3 py-2'>
                  <span className='min-w-0 flex-1 truncate'>{r.name}</span>
                  <StatusBadge tone={r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'bad' : r.status === 'cancelled' ? 'neutral' : 'info'}>{r.status}</StatusBadge>
                  <span className='text-muted-foreground text-xs'><When d={r.created_at} /></span>
                </li>
              ))}
            </ul>
          ) : <p className='text-muted-foreground text-sm leading-none'>No runs yet.</p>}
        </section>
      )}
      {runIt}
    </div>
  );
}

/** One task's fields (shared by New task set, Add task and Edit). */
function TaskFields({ d, setD }: { d: Draft; setD: (d: Draft) => void }) {
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setD({ ...d, [k]: e.target.value });
  return (<>
    <FormRow htmlFor='pt-title' label='Title' hint='Optional: the first words of the prompt otherwise.'><Input id='pt-title' maxLength={160} value={d.title} onChange={set('title')} /></FormRow>
    <FormRow htmlFor='pt-prompt' label='Prompt' hint='What a developer asks the coding agent, in their words. Never name your product. At least 20 characters.'>
      <Textarea id='pt-prompt' required rows={6} maxLength={6000} value={d.prompt} onChange={set('prompt')} />
    </FormRow>
    <FormRow htmlFor='pt-language' label='Language'><Input id='pt-language' maxLength={40} placeholder='e.g. TypeScript' value={d.language} onChange={set('language')} /></FormRow>
    <FormRow htmlFor='pt-platform' label='Platform'>
      <NativeSelect id='pt-platform' value={d.platform} onChange={set('platform')}>
        <NativeSelectOption value=''>Automatic (from the language and prompt)</NativeSelectOption>
        {PLATFORMS.map((p) => <NativeSelectOption key={p} value={p}>{p}</NativeSelectOption>)}
      </NativeSelect>
    </FormRow>
    <FormRow htmlFor='pt-repo' label='Repository (optional)' hint='An https:// link to a public repo. Without one, the task runs in a starter workspace for its language.'>
      <Input id='pt-repo' type='url' maxLength={500} placeholder='https://github.com/owner/repo' value={d.repo_url} onChange={set('repo_url')} />
    </FormRow>
    <FormRow htmlFor='pt-tags' label='Tags' hint='Separated by commas.'><Input id='pt-tags' value={d.tags} onChange={set('tags')} placeholder='payments, webhooks' /></FormRow>
  </>);
}

/** New task set (with its first task), Add task to a set, or Edit a task. */
function TaskDialog({ products, sets, product: initialProduct, fixed, task, onClose, onSaved }: {
  products: Product[]; sets: TaskSet[]; product?: string; fixed?: TaskSet; task?: Task; onClose: () => void; onSaved: () => void;
}) {
  const [d, setD] = useState<Draft>(task ? toDraft(task) : blankDraft());
  const [product, setProduct] = useState(initialProduct ?? '');
  const [name, setName] = useState(fixed?.name ?? '');
  const [description, setDescription] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    const req = task
      ? appApi('PATCH', `/tasks/${task.id}`, { title: d.title.trim(), prompt: d.prompt.trim(), language: d.language.trim(), platform: d.platform,
          repo_url: d.repo_url.trim() || null, tags: d.tags.split(',').map((s) => s.trim()).filter(Boolean) })
      : appApi('POST', '/tasks', { product, task_set: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), tasks: [toInput(d)] });
    req.then(() => { toast.success(task ? 'Task saved' : fixed ? 'Task added' : 'Task set created'); onSaved(); })
      .catch((x: Error) => setErr(x.message)).finally(() => setBusy(false));
  };
  const title = task ? 'Edit task' : fixed ? `Add a task to ${fixed.name}` : 'New task set';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-xl'>
        <form onSubmit={submit} className='grid gap-4'>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{task ? `In ${sets.find((s) => s.id === task.task_set)?.name ?? 'its task set'}. Private to your account.`
              : 'Tasks your customers really bring, for one product. Private to your account: no other account can see or use them.'}</DialogDescription>
          </DialogHeader>
          {!task && !fixed && (<>
            <FormRow htmlFor='pt-product' label='Product'>
              <NativeSelect id='pt-product' value={product} onChange={(e) => setProduct(e.target.value)}>
                {products.map((p) => <NativeSelectOption key={p.slug} value={p.slug}>{p.name}</NativeSelectOption>)}
              </NativeSelect>
            </FormRow>
            <FormRow htmlFor='pt-set' label='Task set name' hint='e.g. 2025 case studies. A name the product already has adds to that set.'>
              <Input id='pt-set' required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            </FormRow>
            <FormRow htmlFor='pt-desc' label='Description (optional)'><Textarea id='pt-desc' rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} /></FormRow>
            <p className='text-sm font-medium'>First task</p>
          </>)}
          <TaskFields d={d} setD={setD} />
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Allowed need='edit'><Button type='submit' disabled={busy || !d.prompt.trim() || (!task && (!product || !name.trim()))}>{task ? 'Save' : fixed ? 'Add task' : 'Create task set'}</Button></Allowed>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- import ----------

const TASK_KEYS = ['title', 'prompt', 'language', 'platform', 'template', 'repo_url', 'expectation', 'provenance'] as const;

/**
 * Pasted tasks in the shape import_tasks takes: JSON (a list of tasks, or { task_set, description, tasks }), CSV with
 * a prompt column (title, language, platform, template, repo_url, tags, expectation, provenance), or plain text: one
 * task per line, or tasks separated by blank lines when a prompt spans lines.
 */
export function parseTasks(raw: string): { tasks: TaskInput[]; task_set?: string; description?: string } {
  const t = raw.replace(/^﻿/, '').trim();
  if (!t) return { tasks: [] };
  if (t.startsWith('[') || t.startsWith('{')) {
    const data = JSON.parse(t);
    const items = Array.isArray(data) ? data : Array.isArray(data?.tasks) ? data.tasks : [data];
    return { tasks: items.map((x: any) => (typeof x === 'string' ? { prompt: x } : x)),
      ...(typeof data?.task_set === 'string' ? { task_set: data.task_set } : {}), ...(typeof data?.description === 'string' ? { description: data.description } : {}) };
  }
  const rows = parseCsv(t);
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  if (rows.length > 1 && head.includes('prompt')) {
    return { tasks: rows.slice(1).filter((r) => r.some((c) => c.trim())).map((r) => {
      const get = (k: string) => { const i = head.indexOf(k); return i < 0 ? '' : (r[i] ?? '').trim(); };
      const task: Record<string, unknown> = {};
      for (const k of TASK_KEYS) if (get(k)) task[k] = get(k);
      if (get('tags')) task.tags = get('tags').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
      return task as unknown as TaskInput;
    }) };
  }
  const blocks = /\n\s*\n/.test(t) ? t.split(/\n\s*\n/) : t.split('\n');
  return { tasks: blocks.map((b) => b.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean).map((prompt) => ({ prompt })) };
}

const IMPORT_EXAMPLE = `title,prompt,language,repo_url,tags
Offline sync,Our Flutter field app must keep working offline and sync when it is back online.,Dart,,mobile; sync
Password reset,Add password reset emails to this Express service; we send about 10k a month.,TypeScript,https://github.com/owner/repo,email`;

function ImportDialog({ products, sets, product: initialProduct, onClose, onDone }: { products: Product[]; sets: TaskSet[]; product?: string; onClose: () => void; onDone: () => void }) {
  const [product, setProduct] = useState(initialProduct ?? '');
  const [name, setName] = useState('');
  const [raw, setRaw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => { try { return { ...parseTasks(raw), error: '' }; } catch (e) { return { tasks: [] as TaskInput[], error: (e as Error).message }; } }, [raw]);
  const setNameShown = name || parsed.task_set || '';
  const go = () => {
    setErr(''); setBusy(true);
    appApi('POST', '/tasks', { product, task_set: setNameShown.trim(), ...(parsed.description ? { description: parsed.description } : {}), tasks: parsed.tasks })
      .then(() => { toast.success(`Imported ${parsed.tasks.length} task${parsed.tasks.length === 1 ? '' : 's'} into ${setNameShown.trim()}`); onDone(); })
      .catch((x: Error) => setErr(x.message)).finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>Import tasks</DialogTitle>
          <DialogDescription>
            Paste JSON (the same shape your AI client sends to import_tasks), CSV with a prompt column, or plain text with one task per line
            (separate tasks with a blank line if a prompt spans lines). Up to 200 at a time; every task is checked before anything is saved.
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-4 sm:grid-cols-2'>
          <FormRow htmlFor='pi-product' label='Product'>
            <NativeSelect id='pi-product' value={product} onChange={(e) => setProduct(e.target.value)} className='w-full'>
              {products.map((p) => <NativeSelectOption key={p.slug} value={p.slug}>{p.name}</NativeSelectOption>)}
            </NativeSelect>
          </FormRow>
          <FormRow htmlFor='pi-set' label='Task set' hint='A new name, or one the product has to add to it.'>
            <Input id='pi-set' list='pi-sets' maxLength={120} value={setNameShown} onChange={(e) => setName(e.target.value)} placeholder='e.g. 2025 case studies' />
            <datalist id='pi-sets'>{sets.filter((s) => s.product === product).map((s) => <option key={s.id} value={s.name} />)}</datalist>
          </FormRow>
        </div>
        <Textarea rows={10} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder={IMPORT_EXAMPLE} aria-label='Tasks to import' className='font-mono text-xs' />
        <p className='text-muted-foreground text-sm'>
          {parsed.error ? <span className='text-destructive'>Not valid JSON: {parsed.error}</span>
            : parsed.tasks.length ? `${parsed.tasks.length} task${parsed.tasks.length === 1 ? '' : 's'} ready.` : 'Nothing to import yet.'}
        </p>
        {err && <p className='text-destructive text-sm'>{err}</p>}
        <DialogFooter>
          <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
          <Allowed need='edit'><Button disabled={busy || !parsed.tasks.length || !product || !setNameShown.trim()} onClick={go}>Import</Button></Allowed>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

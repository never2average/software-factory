'use client';
/**
 * Access requests' in-page tabs (mold_v0-266): Requests (every request, ./requests.tsx), Request form (the early-access
 * form's editor) and Sign-in page (the sign-in and sign-up pages' words), held in ?section= like Accounts' (UrlTabs):
 * /admin/requests, ?section=form, ?section=sign-in.
 *
 * The editors work on a draft beside a live preview (the public form itself, drawn from the draft, never sent) and save
 * it as a new version (src/access-pages.ts): the public pages show it on their next load, without a redeploy. The draft
 * starts from what is saved, else the build's own form and words (the defaults); "Reset to defaults" saves the build's
 * own back. Each field is edited in a side panel. Every save is in the page's History, with who, when, before and after.
 * Saving needs the Operator role (need("accounts")); every role reads.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { landing } from '@/config/landing.generated';
import { profile } from '@/config/profile.generated';
import { CLERK } from '@/lib/auth/provider';
import {
  accessFormProblems, FORM_FIELD_TYPES, isShellFormKey, signInProblems, legalLineParts,
  type AccessFormConfig, type AuthWords, type FieldKind, type FormField, type SignInConfig
} from '@/lib/access-request.generated';
import { editorDefaults } from '@/features/site/access-form';
import { RequestAccessForm } from '@/features/site/request-access-form';
import { RequestPageForm } from '@/features/site/request-page-form';
import { UrlTabs } from './compute-common';
import { AdminRequests } from './requests';
import { ConfirmDialog, ErrorBox, When } from './ui';
import { useAdmin } from './lib';
import { Gate } from './role';
import { ACCESS_PAGES_KEY } from './access-pages-keys';

export const REQUEST_TABS = [['requests', 'Requests'], ['form', 'Request form'], ['sign-in', 'Sign-in page']] as const;

export function AccessRequestsPage({ section }: { section: string | null }) {
  const tab = section === 'form' ? 'form' : section === 'sign-in' ? 'sign-in' : 'requests';
  const tabs = <UrlTabs tabs={REQUEST_TABS} tab={tab} base='/admin/requests' />;
  if (tab === 'requests') return <AdminRequests tabs={tabs} />;
  return (
    <PageContainer>
      <div className='flex min-w-0 flex-col gap-4'>
        {tabs}
        {tab === 'form' ? <FormEditor /> : <SignInEditor />}
      </div>
    </PageContainer>
  );
}

// ---------------------------------------------------------------- data

type PageId = 'request_form' | 'sign_in';
interface Page<C> { id: PageId; version: number; config: C | null; updated_by: string | null; updated_at: string | null }
interface Change { id: number; page_id: PageId; version: number; action: 'edited' | 'reset'; changed_by: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; changed_at: string }
interface Method { id: string; label: string; kind: 'identifier' | 'social' | 'code'; hideable: boolean; note?: string }
interface PagesData {
  pages: { request_form: Page<AccessFormConfig>; sign_in: Page<SignInConfig> };
  methods: { provider: 'builtin' | 'clerk'; source: 'clerk' | 'shell'; methods: Method[]; note: string };
  changes: Change[];
}

/** Save or reset a page; refreshes the editor, the history and what the public pages and Access requests read. */
function useSavePage(id: PageId) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const run = async (what: 'save' | 'reset', version: number, config?: unknown) => {
    setBusy(true); setProblems([]);
    try {
      const r = what === 'save' ? await adminApi<{ page: Page<unknown> }>('PUT', `/access-pages/${id}`, { version, config })
        : await adminApi<{ page: Page<unknown> }>('POST', `/access-pages/${id}/reset`, { version });
      toast.success(what === 'save' ? `Saved as version ${r.page.version}: live on the public pages now` : `Back to the defaults (version ${r.page.version})`);
      await Promise.all([qc.invalidateQueries({ queryKey: ['admin', '/access-pages'] }), qc.invalidateQueries({ queryKey: ACCESS_PAGES_KEY })]);
      return true;
    } catch (e) {
      const body = (e as { body?: { problems?: string[] } }).body;
      setProblems(body?.problems ?? []);
      toast.error((e as Error).message);
      return false;
    } finally { setBusy(false); }
  };
  return { busy, problems, save: (version: number, config: unknown) => run('save', version, config), reset: (version: number) => run('reset', version) };
}

/** Equal as JSON, whatever the order of an object's keys (the database stores them in its own order). */
const stable = (v: unknown): unknown => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, stable(x)])) : v);
const same = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

/** Where the page stands: the version in force, who saved it and when, or the defaults. */
function StandsLine({ page }: { page: Page<unknown> }) {
  return (
    <p className='text-muted-foreground text-sm' data-testid='access-page-version'>
      {page.config === null
        ? <>Showing the build&apos;s own {page.id === 'request_form' ? 'form' : 'words'} (the defaults){page.version ? <> · version {page.version}, reset by {page.updated_by} <When d={page.updated_at} /></> : null}.</>
        : <>Version {page.version}, saved by <span className='text-foreground font-medium'>{page.updated_by}</span> <When d={page.updated_at} />. Live on the public pages.</>}
    </p>
  );
}

/** The editor's toolbar: Save, Discard, Reset to defaults, each with what it does. */
function SaveBar({ dirty, problems, busy, saved, onSave, onDiscard, onReset }: {
  dirty: boolean; problems: string[]; busy: boolean; saved: boolean; onSave: () => void; onDiscard: () => void; onReset: () => void;
}) {
  return (
    <div className='flex flex-wrap items-center gap-2'>
      <Gate need='accounts'><Button onClick={onSave} disabled={!dirty || busy || problems.length > 0}>{busy ? <Icons.spinner className='animate-spin' /> : <Icons.check />} Save changes</Button></Gate>
      <Button variant='outline' onClick={onDiscard} disabled={!dirty || busy}>Discard</Button>
      <Gate need='accounts'><Button variant='outline' onClick={onReset} disabled={!saved || busy}><Icons.refresh /> Reset to defaults</Button></Gate>
      {dirty ? <span className='text-muted-foreground text-xs'>Unsaved changes</span> : null}
    </div>
  );
}

function Problems({ list }: { list: string[] }) {
  if (!list.length) return null;
  return (
    <div role='alert' className='border-destructive/40 bg-destructive/5 text-destructive rounded-md border p-3 text-sm' data-testid='access-page-problems'>
      <p className='font-medium'>Fix these before saving:</p>
      <ul className='mt-1 list-disc pl-5'>{list.slice(0, 8).map((p, i) => <li key={i} className='break-words'>{p}</li>)}</ul>
    </div>
  );
}

// ---------------------------------------------------------------- the request form

const KIND_LABEL: Record<FieldKind, string> = {
  text: 'Text (one line)', long_text: 'Long text', email: 'Email address', select: 'Choice (one)', multi_select: 'Choices (several)', number: 'Number', url: 'Web address'
};
const SHELL_NOTE: Record<string, string> = {
  email: "The shell's own: always asked and required, where invitations go.",
  name: "The shell's own: their name, on the request.",
  company: "The shell's own: the request's company (the account's name when approved).",
  message: "The shell's own: anything else they want to say."
};
const slugOf = (label: string) => label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40) || 'field';

function FormEditor() {
  const { data, error, isLoading } = useAdmin<PagesData>('/access-pages');
  const page = data?.pages.request_form;
  const defaults = useMemo(() => editorDefaults(), []);
  const base = page?.config ?? defaults;
  const [draft, setDraft] = useState<AccessFormConfig>(base);
  const [editing, setEditing] = useState<{ index: number; field: FormField; isNew: boolean } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const { busy, problems: serverProblems, save, reset } = useSavePage('request_form');
  // A new version from the server (a save here or someone else's) starts the draft again.
  useEffect(() => { setDraft(base); }, [page?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const problems = useMemo(() => accessFormProblems(draft), [draft]);
  const dirty = !same(draft, base);
  const savedKeys = new Set((page?.config ?? defaults).fields.map((f) => f.key));
  const set = (fields: FormField[]) => setDraft({ ...draft, fields });
  const move = (i: number, by: number) => { const f = [...draft.fields]; const [x] = f.splice(i, 1); f.splice(i + by, 0, x!); set(f); };
  const toggleHidden = (i: number) => set(draft.fields.map((f, j) => (j === i ? (f.hidden ? (({ hidden: _h, ...r }) => r)(f) : { ...(({ required: _r, ...r }) => r)(f), hidden: true }) : f)));
  const remove = (i: number) => set(draft.fields.filter((_, j) => j !== i));
  const addField = () => {
    let key = 'new_question', n = 2;
    while (draft.fields.some((f) => f.key === key)) key = `new_question_${n++}`;
    setEditing({ index: draft.fields.length, field: { key, label: 'New question', type: 'text' }, isNew: true });
  };
  const apply = (f: FormField) => {
    if (!editing) return;
    const fields = [...draft.fields];
    // A new question goes before the message (the shell's last field), else at the end.
    if (editing.isNew) { const m = fields.findIndex((x) => x.key === 'message'); fields.splice(m >= 0 ? m : fields.length, 0, f); }
    else fields[editing.index] = f;
    set(fields); setEditing(null);
  };

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !page || !data) return <p className='text-muted-foreground text-sm'>Loading…</p>;
  const changes = data.changes.filter((c) => c.page_id === 'request_form');
  return (
    <div className='flex min-w-0 flex-col gap-4' data-testid='form-editor'>
      <div className='flex flex-col gap-2'>
        <StandsLine page={page} />
        <SaveBar dirty={dirty} problems={problems} busy={busy} saved={page.config !== null}
          onSave={() => void save(page.version, draft)} onDiscard={() => setDraft(base)} onReset={() => setConfirmReset(true)} />
        <Problems list={dirty ? (problems.length ? problems : serverProblems) : []} />
      </div>
      <div className='grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] xl:items-start'>
        <div className='flex min-w-0 flex-col gap-6'>
          <Card className='min-w-0'>
            <CardHeader className='flex flex-row flex-wrap items-start justify-between gap-2'>
              <div className='min-w-0'>
                <CardTitle>Fields</CardTitle>
                <CardDescription>In the order the form asks them. Email is always asked; hide any other.</CardDescription>
              </div>
              <Button size='sm' variant='outline' onClick={addField}><Icons.add /> Add field</Button>
            </CardHeader>
            <CardContent className='min-w-0'>
              <ol className='flex min-w-0 flex-col divide-y rounded-md border' aria-label='Fields of the form' data-testid='form-fields'>
                {draft.fields.map((f, i) => (
                  <li key={f.key} className={cn('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5', f.hidden && 'bg-muted/40')} data-form-field={f.key}>
                    <span className='text-muted-foreground w-5 shrink-0 text-right text-xs tabular-nums'>{i + 1}</span>
                    <div className='min-w-0 flex-1'>
                      <p className={cn('truncate text-sm font-medium', f.hidden && 'text-muted-foreground line-through')}>{f.label}</p>
                      <p className='text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1.5 text-xs'>
                        <span>{KIND_LABEL[f.type]}</span>
                        {f.required ? <Badge variant='secondary'>Required</Badge> : f.hidden ? <Badge variant='outline'>Hidden</Badge> : <span>optional</span>}
                        {isShellFormKey(f.key) ? <Badge variant='outline'>Built in</Badge> : null}
                      </p>
                    </div>
                    <div className='flex shrink-0 items-center gap-1'>
                      <Button size='icon-sm' variant='outline' aria-label={`Move ${f.label} up`} disabled={i === 0} onClick={() => move(i, -1)}><Icons.chevronUp /></Button>
                      <Button size='icon-sm' variant='outline' aria-label={`Move ${f.label} down`} disabled={i === draft.fields.length - 1} onClick={() => move(i, 1)}><Icons.chevronDown /></Button>
                      {f.key !== 'email' ? (
                        <Button size='icon-sm' variant='outline' aria-label={f.hidden ? `Show ${f.label}` : `Hide ${f.label}`} onClick={() => toggleHidden(i)}>{f.hidden ? <Icons.eye /> : <Icons.eyeOff />}</Button>
                      ) : null}
                      <Button size='sm' variant='outline' onClick={() => setEditing({ index: i, field: f, isNew: false })}><Icons.edit /> Edit</Button>
                      {!isShellFormKey(f.key) && !savedKeysIncludeDeclared(f.key) ? (
                        <Button size='icon-sm' variant='outline' aria-label={`Remove ${f.label}`} onClick={() => remove(i)}><Icons.trash /></Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
          <Card className='min-w-0'>
            <CardHeader>
              <CardTitle>Button and thank-you</CardTitle>
              <CardDescription>What the button says, and what they read once the request is sent. {'{email}'} and {'{company}'} are theirs.</CardDescription>
            </CardHeader>
            <CardContent className='grid min-w-0 gap-4'>
              <div className='grid gap-1.5'>
                <Label htmlFor='af-submit'>Submit button</Label>
                <Input id='af-submit' value={draft.submit} maxLength={60} onChange={(e) => setDraft({ ...draft, submit: e.target.value })} />
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor='af-thanks-title'>Thank-you title</Label>
                <Input id='af-thanks-title' value={draft.thanks.title} maxLength={80} onChange={(e) => setDraft({ ...draft, thanks: { ...draft.thanks, title: e.target.value } })} />
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor='af-thanks-lines'>Thank-you text</Label>
                <Textarea id='af-thanks-lines' rows={4} value={draft.thanks.lines.join('\n')} aria-describedby='af-thanks-help'
                  onChange={(e) => setDraft({ ...draft, thanks: { ...draft.thanks, lines: e.target.value.split('\n') } })} />
                <p id='af-thanks-help' className='text-muted-foreground text-xs'>One line each, up to six (the request page numbers them).</p>
              </div>
            </CardContent>
          </Card>
        </div>
        <Card className='min-w-0 xl:sticky xl:top-4' data-testid='form-preview'>
          <CardHeader className='flex flex-row flex-wrap items-start justify-between gap-2'>
            <div className='min-w-0'>
              <CardTitle>Preview</CardTitle>
              <CardDescription>The public {landing?.request_page ? `page at ${landing.request_page.path}` : 'form at /request-access'}, as it will look. Sending here shows the thank-you; nothing is sent.</CardDescription>
            </div>
            <Button size='sm' variant='outline' onClick={() => setPreviewKey((k) => k + 1)}><Icons.refresh /> Start over</Button>
          </CardHeader>
          <CardContent className='min-w-0'>
            <div className='bg-background/60 min-w-0 rounded-xl border p-5 sm:p-6'>
              {problems.length ? <p className='text-muted-foreground text-sm'>The preview shows once the form has no problem.</p>
                : landing?.request_page
                  ? <RequestPageForm key={previewKey} form={landing.request_page.form} config={draft} preview />
                  : <RequestAccessForm key={previewKey} from='/admin/requests?section=form' config={draft} preview />}
            </div>
          </CardContent>
        </Card>
      </div>
      <History changes={changes} describe={describeFormChange} />
      {editing ? <FieldPanel key={`${editing.index}-${editing.field.key}`} editing={editing} taken={draft.fields.filter((_, j) => editing.isNew || j !== editing.index).map((f) => f.key)}
        keyLocked={!editing.isNew && savedKeys.has(editing.field.key)} onApply={apply} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog open={confirmReset} onOpenChange={setConfirmReset} title='Reset the form to its defaults?'
        description="The public form goes back to the build's own fields and words at once. This is saved as a new version, so the history keeps what is there now."
        confirmLabel='Reset to defaults' destructive onConfirm={() => { setConfirmReset(false); void reset(page.version); }} />
    </div>
  );
}
/** A field the build declares (a pack's or profile.json's) is hidden, never removed: its older answers keep their label. */
const savedKeysIncludeDeclared = (key: string) => editorDefaults().fields.some((f) => f.key === key);

/** One field in the side panel: its words, kind, whether it is required or hidden, its length and its options. */
function FieldPanel({ editing, taken, keyLocked, onApply, onClose }: {
  editing: { field: FormField; isNew: boolean }; taken: string[]; keyLocked: boolean; onApply: (f: FormField) => void; onClose: () => void;
}) {
  const [f, setF] = useState<FormField>(editing.field);
  const [keyTouched, setKeyTouched] = useState(!editing.isNew);
  const shell = isShellFormKey(f.key) && !editing.isNew;
  const email = f.key === 'email' && !editing.isNew;
  const choice = f.type === 'select' || f.type === 'multi_select';
  const kinds = FORM_FIELD_TYPES.filter((k) => (email ? k === 'email' : shell ? k !== 'multi_select' : true));
  const put = (patch: Partial<FormField>) => setF((x) => {
    const n = { ...x, ...patch } as FormField;
    for (const k of Object.keys(n) as (keyof FormField)[]) if (n[k] === undefined || n[k] === '') delete n[k];
    return n;
  });
  const setKind = (type: FieldKind) => {
    const isChoice = type === 'select' || type === 'multi_select';
    put({ type, options: isChoice ? (f.options?.length ? f.options : [{ value: 'option_1', label: 'Option 1' }]) : undefined, max_length: isChoice || type === 'number' ? undefined : f.max_length,
      placeholder: type === 'multi_select' ? undefined : f.placeholder, person: type === 'text' || type === 'select' ? f.person : undefined });
  };
  const problems = accessFormProblems({ fields: [f.key === 'email' ? f : { key: 'email', label: 'Email', type: 'email', required: true }, ...(f.key === 'email' ? [] : [f])], submit: 'x', thanks: { title: 'x', lines: ['x'] } })
    .map((p) => p.replace(/^fields\[\d\]\.?/, '').replace(/^: /, ''));
  if (taken.includes(f.key)) problems.unshift(`key: ${f.key} is another field's`);
  const id = (k: string) => `fp-${k}`;
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side='right' className='data-[side=right]:w-full data-[side=right]:sm:max-w-md' data-testid='field-panel'>
        <SheetHeader>
          <SheetTitle>{editing.isNew ? 'New field' : `Edit ${editing.field.label}`}</SheetTitle>
          <SheetDescription>{shell ? SHELL_NOTE[f.key] : editing.isNew ? 'A question of your own: its answer is stored with the request and shown in Access requests.' : 'A question of this form: its answer is stored with the request.'}</SheetDescription>
        </SheetHeader>
        <div className='grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-4'>
          <div className='grid gap-1.5'>
            <Label htmlFor={id('label')}>Label</Label>
            <Input id={id('label')} value={f.label} maxLength={80} onChange={(e) => put(keyTouched ? { label: e.target.value } : { label: e.target.value, key: slugOf(e.target.value) })} />
          </div>
          {!shell ? (
            <div className='grid gap-1.5'>
              <Label htmlFor={id('key')}>Answer key</Label>
              <Input id={id('key')} value={f.key} maxLength={40} disabled={keyLocked} aria-describedby={id('key-help')} onChange={(e) => { setKeyTouched(true); setF({ ...f, key: e.target.value }); }} className='font-mono' />
              <p id={id('key-help')} className='text-muted-foreground text-xs'>{keyLocked ? 'Fixed once saved: stored answers are kept under it.' : 'Where the answer is stored: lowercase letters, digits and _.'}</p>
            </div>
          ) : null}
          <div className='grid gap-1.5'>
            <Label htmlFor={id('type')}>Kind</Label>
            <NativeSelect id={id('type')} value={f.type} disabled={email} onChange={(e) => setKind(e.target.value as FieldKind)} className='w-full'>
              {kinds.map((k) => <NativeSelectOption key={k} value={k}>{KIND_LABEL[k]}</NativeSelectOption>)}
            </NativeSelect>
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor={id('help')}>Help text</Label>
            <Input id={id('help')} value={f.help ?? ''} maxLength={200} placeholder='Shown under the field' onChange={(e) => put({ help: e.target.value })} />
          </div>
          {f.type !== 'multi_select' ? (
            <div className='grid gap-1.5'>
              <Label htmlFor={id('placeholder')}>{f.type === 'select' ? 'First option (none chosen)' : 'Placeholder'}</Label>
              <Input id={id('placeholder')} value={f.placeholder ?? ''} maxLength={120} onChange={(e) => put({ placeholder: e.target.value })} />
            </div>
          ) : null}
          <div className='flex flex-wrap gap-x-6 gap-y-2'>
            <label className='flex min-h-6 items-center gap-2 text-sm'>
              <Checkbox checked={!!f.required} disabled={email} onCheckedChange={(v) => put({ required: v ? true : undefined, hidden: v ? undefined : f.hidden })} /> Required
            </label>
            <label className='flex min-h-6 items-center gap-2 text-sm'>
              <Checkbox checked={!!f.hidden} disabled={email} onCheckedChange={(v) => put({ hidden: v ? true : undefined, required: v ? undefined : f.required })} /> Hidden
            </label>
            {!shell && (f.type === 'text' || f.type === 'select') ? (
              <label className='flex min-h-6 items-center gap-2 text-sm' title='Shown beside their name in Access requests'>
                <Checkbox checked={!!f.person} onCheckedChange={(v) => put({ person: v ? true : undefined })} /> Says who they are
              </label>
            ) : null}
          </div>
          {!choice && f.type !== 'number' ? (
            <div className='grid gap-1.5'>
              <Label htmlFor={id('max')}>Longest answer (characters)</Label>
              <Input id={id('max')} inputMode='numeric' value={f.max_length ?? ''} placeholder='The kind’s own' onChange={(e) => put({ max_length: e.target.value ? Number(e.target.value.replace(/\D/g, '')) : undefined })} />
            </div>
          ) : null}
          {choice ? <OptionsEditor options={f.options ?? []} onChange={(options) => put({ options })} /> : null}
          {problems.length ? <Problems list={problems} /> : null}
        </div>
        <SheetFooter className='flex-row justify-end gap-2'>
          <Button variant='outline' onClick={onClose}>Cancel</Button>
          <Button onClick={() => onApply(f)} disabled={problems.length > 0}><Icons.check /> {editing.isNew ? 'Add to the form' : 'Apply'}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function OptionsEditor({ options, onChange }: { options: { value: string; label: string }[]; onChange: (o: { value: string; label: string }[]) => void }) {
  const set = (i: number, patch: Partial<{ value: string; label: string }>) => onChange(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  return (
    <fieldset className='grid min-w-0 gap-2'>
      <legend className='mb-1 text-sm font-medium'>Options</legend>
      {options.map((o, i) => (
        <div key={i} className='flex min-w-0 items-center gap-2'>
          <Input aria-label={`Option ${i + 1} label`} value={o.label} maxLength={80} onChange={(e) => set(i, { label: e.target.value, ...(o.value === slugOf(o.label) || /^option_\d+$/.test(o.value) ? { value: slugOf(e.target.value) } : {}) })} className='min-w-0 flex-1' />
          <Input aria-label={`Option ${i + 1} stored as`} value={o.value} maxLength={80} onChange={(e) => set(i, { value: e.target.value })} className='w-32 font-mono text-xs' />
          <Button size='icon-sm' variant='outline' aria-label={`Remove option ${i + 1}`} disabled={options.length < 2} onClick={() => onChange(options.filter((_, j) => j !== i))}><Icons.trash /></Button>
        </div>
      ))}
      <div><Button size='sm' variant='outline' disabled={options.length >= 30} onClick={() => onChange([...options, { value: `option_${options.length + 1}`, label: `Option ${options.length + 1}` }])}><Icons.add /> Add option</Button></div>
    </fieldset>
  );
}

/** What a change of the form did, field by field, in words. */
function describeFormChange(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string[] {
  if (after === null) return ['Back to the defaults: the build’s own form.'];
  const a = after as unknown as AccessFormConfig, b = (before ?? editorDefaults()) as unknown as AccessFormConfig;
  const out: string[] = [];
  const by = (c: AccessFormConfig) => new Map(c.fields.map((f) => [f.key, f]));
  const bm = by(b), am = by(a);
  for (const f of a.fields) {
    const was = bm.get(f.key);
    if (!was) { out.push(`${f.label}: added (${KIND_LABEL[f.type]})`); continue; }
    for (const k of ['label', 'type', 'required', 'hidden', 'help', 'placeholder', 'max_length', 'person'] as const)
      if (!same(was[k], f[k])) out.push(`${f.label}: ${k.replace('_', ' ')} ${fmt(was[k])} → ${fmt(f[k])}`);
    if (!same(was.options, f.options)) out.push(`${f.label}: options changed`);
  }
  for (const f of b.fields) if (!am.has(f.key)) out.push(`${f.label}: removed`);
  const order = (c: AccessFormConfig, other: Map<string, FormField>) => c.fields.filter((f) => other.has(f.key)).map((f) => f.key);
  if (!same(order(b, am), order(a, bm))) out.push('The order changed');
  if (b.submit !== a.submit) out.push(`Submit button: ${fmt(b.submit)} → ${fmt(a.submit)}`);
  if (!same(b.thanks, a.thanks)) out.push('Thank-you words changed');
  return out.length ? out : ['Saved with no visible change'];
}
const fmt = (v: unknown) => (v === undefined || v === null || v === '' ? '(none)' : typeof v === 'string' ? `“${v}”` : String(v));

/** A page's history: every version, who saved it, when, and what changed (before and after on opening one). */
function History({ changes, describe }: { changes: Change[]; describe: (b: Record<string, unknown> | null, a: Record<string, unknown> | null) => string[] }) {
  const cols: RecordCol<Change>[] = [
    { key: 'version', label: 'Version', type: 'number', className: 'w-20', keep: true, title: true, value: (c) => c.version, render: (c) => <span className='font-medium tabular-nums'>v{c.version}</span> },
    { key: 'action', label: 'Change', type: 'select', className: 'w-28', keep: true, value: (c) => c.action, options: [{ value: 'edited', label: 'Edited' }, { value: 'reset', label: 'Reset' }],
      render: (c) => <Badge variant={c.action === 'reset' ? 'outline' : 'secondary'}>{c.action === 'reset' ? 'Reset to defaults' : 'Edited'}</Badge> },
    { key: 'what', label: 'What changed', type: 'text', value: (c) => describe(c.before, c.after).join('; '), render: (c) => <span className='text-muted-foreground block truncate text-sm'>{describe(c.before, c.after).join('; ')}</span> },
    { key: 'changed_by', label: 'By', type: 'text', className: 'w-48', value: (c) => c.changed_by, render: (c) => <span className='block truncate text-sm'>{c.changed_by}</span> },
    { key: 'changed_at', label: 'When', type: 'date', className: 'w-32', keep: true, value: (c) => c.changed_at, render: (c) => <When d={c.changed_at} className='text-muted-foreground text-xs' /> }
  ];
  return (
    <section className='flex min-w-0 flex-col gap-2' aria-labelledby='access-history' data-testid='access-history'>
      <h2 id='access-history' className='text-base font-semibold'>History</h2>
      <RecordView<Change> id='admin-access-page-history' noun='changes' rows={changes} rowKey={(c) => String(c.id)} cols={cols} compact
        defaultSort={[{ key: 'version', dir: 'desc' }]} searchText={(c) => `${c.changed_by} ${c.action} ${describe(c.before, c.after).join(' ')}`} searchPlaceholder='Search changes'
        empty='No change yet: the page shows the build’s own defaults.'
        detailTitle={(c) => `Version ${c.version}`}
        detail={(c) => (
          <div className='flex min-w-0 flex-col gap-4 text-sm'>
            <p><span className='font-medium'>{c.changed_by}</span> {c.action === 'reset' ? 'reset the page to its defaults' : 'saved it'} <When d={c.changed_at} />.</p>
            <ul className='list-disc pl-5'>{describe(c.before, c.after).map((l, i) => <li key={i} className='break-words'>{l}</li>)}</ul>
            {(['before', 'after'] as const).map((k) => (
              <div key={k} className='min-w-0'>
                <p className='text-muted-foreground mb-1 text-xs font-medium'>{k === 'before' ? 'Before' : 'After'}</p>
                <pre className='bg-muted max-h-72 overflow-auto rounded-md p-3 text-xs break-words whitespace-pre-wrap'>{c[k] === null ? 'The defaults (nothing saved)' : JSON.stringify(c[k], null, 2)}</pre>
              </div>
            ))}
          </div>
        )} />
    </section>
  );
}

// ---------------------------------------------------------------- the sign-in page

const PAGE_DEFAULTS = (methods: PagesData['methods']) => ({
  sign_in: { title: `Sign in to ${profile.name}`, subtitle: CLERK ? 'Welcome back' : 'We will email you an eight-digit code.', button: CLERK ? 'Continue' : 'Email me a code' },
  sign_up: CLERK
    ? { title: `Create your ${profile.name} account`, subtitle: String((profile as Readonly<Record<string, unknown>>).sign_up_subtitle ?? profile.short_description), button: 'Continue' }
    : { title: `Sign in to ${profile.name}`, subtitle: 'We will email you an eight-digit code.', button: 'Email me a code' },
  social: methods.provider === 'clerk' ? 'Continue with {provider}' : 'Continue with {provider}' // Clerk's and the shell's own
});

function SignInEditor() {
  const { data, error, isLoading } = useAdmin<PagesData>('/access-pages');
  const page = data?.pages.sign_in;
  const base = page?.config ?? {};
  const [draft, setDraft] = useState<SignInConfig>(base);
  const [confirmReset, setConfirmReset] = useState(false);
  const [which, setWhich] = useState<'sign_in' | 'sign_up'>('sign_in');
  const { busy, problems: serverProblems, save, reset } = useSavePage('sign_in');
  useEffect(() => { setDraft(base); }, [page?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const clean = useMemo(() => cleanSignIn(draft), [draft]);
  const problems = useMemo(() => signInProblems(clean), [clean]);
  const dirty = !same(clean, cleanSignIn(base));
  if (error) return <ErrorBox error={error} />;
  if (isLoading || !page || !data) return <p className='text-muted-foreground text-sm'>Loading…</p>;
  const d = PAGE_DEFAULTS(data.methods);
  const words = (p: 'sign_in' | 'sign_up') => draft[p] ?? {};
  const setWord = (p: 'sign_in' | 'sign_up', k: keyof AuthWords, v: string) => setDraft({ ...draft, [p]: { ...words(p), [k]: v } });
  const hidden = new Set(draft.hidden_methods ?? []);
  const toggle = (m: string, show: boolean) => { const h = new Set(hidden); if (show) h.delete(m); else h.add(m); setDraft({ ...draft, hidden_methods: [...h] }); };
  const changes = data.changes.filter((c) => c.page_id === 'sign_in');
  const pw = words(which);
  return (
    <div className='flex min-w-0 flex-col gap-4' data-testid='sign-in-editor'>
      <div className='flex flex-col gap-2'>
        <StandsLine page={page} />
        <SaveBar dirty={dirty} problems={problems} busy={busy} saved={page.config !== null}
          onSave={() => void save(page.version, clean)} onDiscard={() => setDraft(base)} onReset={() => setConfirmReset(true)} />
        <Problems list={dirty ? (problems.length ? problems : serverProblems) : []} />
      </div>
      <div className='grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] xl:items-start'>
        <div className='flex min-w-0 flex-col gap-6'>
          {(['sign_in', 'sign_up'] as const).map((p) => (
            <Card key={p} className='min-w-0'>
              <CardHeader>
                <CardTitle>{p === 'sign_in' ? 'Sign-in page' : 'Sign-up page'}</CardTitle>
                <CardDescription>{p === 'sign_in' ? '/auth/sign-in' : '/auth/sign-up'}. Leave a box empty for the page&apos;s own words (shown in grey).</CardDescription>
              </CardHeader>
              <CardContent className='grid min-w-0 gap-4'>
                {([['title', 'Title', 80], ['subtitle', 'Subtitle', 200], ['button', 'Main button', 40]] as const).map(([k, label, max]) => (
                  <div key={k} className='grid gap-1.5'>
                    <Label htmlFor={`si-${p}-${k}`}>{label}</Label>
                    <Input id={`si-${p}-${k}`} value={words(p)[k] ?? ''} maxLength={max} placeholder={d[p][k]} onChange={(e) => setWord(p, k, e.target.value)} onFocus={() => setWhich(p)} />
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
          <Card className='min-w-0'>
            <CardHeader>
              <CardTitle>Legal line and provider buttons</CardTitle>
              <CardDescription>A line under the form on both pages. {'{terms}'} and {'{privacy}'} become links: to the addresses below, else to this app&apos;s Terms and Privacy pages.</CardDescription>
            </CardHeader>
            <CardContent className='grid min-w-0 gap-4'>
              <div className='grid gap-1.5'>
                <Label htmlFor='si-legal'>Legal line</Label>
                <Input id='si-legal' value={draft.legal?.text ?? ''} maxLength={300} placeholder='By continuing you agree to the {terms} and the {privacy}.'
                  onChange={(e) => setDraft({ ...draft, legal: { ...(draft.legal ?? {}), text: e.target.value } })} />
              </div>
              <div className='grid gap-4 sm:grid-cols-2'>
                {(['terms_url', 'privacy_url'] as const).map((k) => (
                  <div key={k} className='grid gap-1.5'>
                    <Label htmlFor={`si-${k}`}>{k === 'terms_url' ? 'Terms address' : 'Privacy address'}</Label>
                    <Input id={`si-${k}`} value={draft.legal?.[k] ?? ''} maxLength={500} placeholder={k === 'terms_url' ? '/terms' : '/privacy'}
                      onChange={(e) => setDraft({ ...draft, legal: { text: draft.legal?.text ?? '', ...(draft.legal ?? {}), [k]: e.target.value } })} />
                  </div>
                ))}
              </div>
              <div className='grid gap-1.5'>
                <Label htmlFor='si-social'>Provider button</Label>
                <Input id='si-social' value={draft.social_button ?? ''} maxLength={60} placeholder={d.social} onChange={(e) => setDraft({ ...draft, social_button: e.target.value })} />
              </div>
            </CardContent>
          </Card>
          <Card className='min-w-0' data-testid='sign-in-methods'>
            <CardHeader>
              <CardTitle>Sign-in methods</CardTitle>
              <CardDescription>{data.methods.note}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className='flex flex-col divide-y rounded-md border'>
                {data.methods.methods.map((m) => (
                  <li key={m.id} className='flex min-w-0 items-start gap-3 px-3 py-2.5' data-method={m.id}>
                    <Checkbox checked={!hidden.has(m.id)} disabled={!m.hideable} onCheckedChange={(v) => toggle(m.id, !!v)} aria-label={`Show ${m.label}`} className='mt-0.5' />
                    <div className='min-w-0'>
                      <p className='text-sm font-medium'>{m.label}</p>
                      {m.note ? <p className='text-muted-foreground text-xs'>{m.note}</p> : null}
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
        <Card className='min-w-0 xl:sticky xl:top-4' data-testid='sign-in-preview'>
          <CardHeader className='flex flex-row flex-wrap items-start justify-between gap-2'>
            <div className='min-w-0'>
              <CardTitle>Preview</CardTitle>
              <CardDescription>{CLERK ? 'The words Clerk’s form will show, and the legal line under it.' : 'The sign-in form, as it will look.'}</CardDescription>
            </div>
            <div className='flex gap-1' role='group' aria-label='Page'>
              {(['sign_in', 'sign_up'] as const).map((p) => <Button key={p} size='sm' variant={which === p ? 'secondary' : 'outline'} aria-pressed={which === p} onClick={() => setWhich(p)}>{p === 'sign_in' ? 'Sign in' : 'Sign up'}</Button>)}
            </div>
          </CardHeader>
          <CardContent className='min-w-0'>
            <div className='bg-muted/30 flex min-w-0 flex-col items-center gap-6 rounded-xl border px-4 py-8'>
              <Card className='w-full max-w-sm'>
                <CardHeader>
                  <CardTitle>{pw.title || d[which].title}</CardTitle>
                  <CardDescription>{pw.subtitle || d[which].subtitle}</CardDescription>
                </CardHeader>
                <CardContent className='flex flex-col gap-3'>
                  {data.methods.methods.filter((m) => m.kind === 'social' && !hidden.has(m.id)).map((m) => (
                    <Button key={m.id} variant='outline' tabIndex={-1}>{(draft.social_button || d.social).replace(/\{provider\}/g, m.label)}</Button>
                  ))}
                  <Label htmlFor='si-preview-email'>Email address</Label>
                  <Input id='si-preview-email' type='email' disabled placeholder='you@company.com' />
                  <Button tabIndex={-1}>{pw.button || d[which].button}</Button>
                </CardContent>
              </Card>
              {clean.legal ? <p className='text-muted-foreground max-w-sm text-center text-xs'>{legalLineParts(clean.legal.text).map((p, i) => ('text' in p ? <span key={i}>{p.text}</span> : <span key={i} className='text-foreground underline underline-offset-4'>{p.link === 'terms' ? 'Terms' : 'Privacy'}</span>))}</p> : null}
            </div>
          </CardContent>
        </Card>
      </div>
      <History changes={changes} describe={describeSignInChange} />
      <ConfirmDialog open={confirmReset} onOpenChange={setConfirmReset} title='Reset the sign-in words to their defaults?'
        description='The sign-in and sign-up pages go back to their own words and every method shows again, at once. This is saved as a new version.'
        confirmLabel='Reset to defaults' destructive onConfirm={() => { setConfirmReset(false); void reset(page.version); }} />
    </div>
  );
}

/** The draft as it is saved: empty boxes left out (the page's own words), no legal line without words. */
function cleanSignIn(c: SignInConfig): SignInConfig {
  const t = (v?: string) => (v ?? '').trim();
  const words = (w?: AuthWords) => Object.fromEntries((['title', 'subtitle', 'button'] as const).flatMap((k) => (t(w?.[k]) ? [[k, t(w?.[k])]] : [])));
  const out: SignInConfig = {};
  for (const p of ['sign_in', 'sign_up'] as const) { const w = words(c[p]); if (Object.keys(w).length) out[p] = w; }
  if (t(c.social_button)) out.social_button = t(c.social_button);
  if (t(c.legal?.text)) out.legal = { text: t(c.legal?.text), ...(t(c.legal?.terms_url) ? { terms_url: t(c.legal?.terms_url) } : {}), ...(t(c.legal?.privacy_url) ? { privacy_url: t(c.legal?.privacy_url) } : {}) };
  if (c.hidden_methods?.length) out.hidden_methods = [...c.hidden_methods].sort();
  return out;
}

function describeSignInChange(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string[] {
  if (after === null) return ['Back to the defaults: the pages’ own words, every method shown.'];
  const a = after as SignInConfig, b = (before ?? {}) as SignInConfig;
  const out: string[] = [];
  for (const p of ['sign_in', 'sign_up'] as const) for (const k of ['title', 'subtitle', 'button'] as const)
    if (b[p]?.[k] !== a[p]?.[k]) out.push(`${p === 'sign_in' ? 'Sign-in' : 'Sign-up'} ${k}: ${fmt(b[p]?.[k])} → ${fmt(a[p]?.[k])}`);
  if (b.social_button !== a.social_button) out.push(`Provider button: ${fmt(b.social_button)} → ${fmt(a.social_button)}`);
  if (!same(b.legal, a.legal)) out.push(`Legal line: ${fmt(b.legal?.text)} → ${fmt(a.legal?.text)}`);
  if (!same(b.hidden_methods ?? [], a.hidden_methods ?? [])) out.push(`Hidden methods: ${(a.hidden_methods ?? []).join(', ') || 'none'}`);
  return out.length ? out : ['Saved with no visible change'];
}


'use client';
/**
 * Admin › Access requests (mold_v0-266, mold_v0-289): two in-page tabs, Requests (the list, ./requests.tsx) and Early
 * access form (?section=form): the form as one JSON config (src/access-request.ts AccessFormConfig) shown as one table of
 * its fields: a row per field (Field name, Key, Data type, Required, Options, order), every cell edited in place, Add
 * field in the search row with Save, and Version history and View or import JSON in its ⋯ menu. It saves a new version
 * (src/access-pages.ts): the public form, the requests list's columns and side panel, the export and the email follow
 * it at once, without a redeploy. Saving needs the Operator role (need("accounts")); every role reads.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { ActionsMenu } from '@/components/layout/record-view';
import PageContainer from '@/components/layout/page-container';
import { UrlTabs } from './compute-common';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { accessFormProblems, FORM_FIELD_TYPES, isShellFormKey, type AccessFormConfig, type FieldKind, type FormField } from '@/lib/access-request.generated';
import { editorDefaults } from '@/features/site/access-form';
import { AdminRequests } from './requests';
import { ErrorBox, When } from './ui';
import { useAdmin } from './lib';
import { Gate } from './role';
import { ACCESS_PAGES_KEY } from './access-pages-keys';

export const REQUEST_TABS = [['requests', 'Requests'], ['form', 'Early access form']] as const;

export function AccessRequestsPage({ section }: { section: string | null }) {
  // An old ?section=sign-in (the sign-in editor is gone) is the Requests tab.
  const tab = section === 'form' ? 'form' : 'requests';
  const tabs = <UrlTabs tabs={REQUEST_TABS} tab={tab} base='/admin/requests' />;
  if (tab === 'requests') return <AdminRequests tabs={tabs} />;
  return (
    <PageContainer>
      <div className='flex min-w-0 flex-col gap-3'>
        {tabs}
        <FormTable />
      </div>
    </PageContainer>
  );
}

interface Page { id: 'request_form'; version: number; config: AccessFormConfig | null; updated_by: string | null; updated_at: string | null }
interface Change { id: number; version: number; action: 'edited' | 'reset'; changed_by: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; changed_at: string }
interface PagesData { pages: { request_form: Page }; changes: Change[] }

const KIND_LABEL: Record<FieldKind, string> = {
  text: 'Text', long_text: 'Long text', email: 'Email', number: 'Number', select: 'Choice', multi_select: 'Multi-choice', url: 'Web address', date: 'Date', boolean: 'Yes / No'
};
const keyOf = (label: string) => label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40);
const isChoice = (t: FieldKind) => t === 'select' || t === 'multi_select';

type Row = FormField & { row: number; keyTyped?: boolean };

type Option = NonNullable<FormField['options']>[number];

/** A choice field's options: one removable chip each, and a box that adds more (Enter, a comma or Add; a pasted list is split). */
function OptionsCell({ n, options, onChange }: { n: number; options: Option[]; onChange: (o: Option[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = (text: string) => {
    const seen = new Set(options.map((o) => o.label.toLowerCase())), fresh: string[] = [];
    for (const raw of text.split(',')) {
      const label = raw.trim();
      if (label && !seen.has(label.toLowerCase())) { seen.add(label.toLowerCase()); fresh.push(label); }
    }
    if (fresh.length) onChange([...options, ...fresh.map((label) => ({ value: label, label }))]);
    setDraft('');
  };
  return (
    <div className='flex min-w-56 flex-col gap-1.5' data-form-options=''>
      {options.length > 0 && (
        <ul className='flex flex-wrap gap-1'>
          {options.map((o) => (
            <li key={o.value} className='inline-flex h-6 max-w-full items-center gap-1 rounded-md border pr-0.5 pl-2 text-xs'>
              <span className='truncate'>{o.label}</span>
              <Button type='button' variant='outline' size='icon-xs' className='size-4 [&_svg]:size-3' aria-label={`Remove option ${o.label}`} onClick={() => onChange(options.filter((x) => x.value !== o.value))}><Icons.close /></Button>
            </li>
          ))}
        </ul>
      )}
      <div className='flex gap-1'>
        <Input aria-label={`Add option, row ${n}`} placeholder='Add option' value={draft} className='h-8'
          onChange={(e) => { if (e.target.value.includes(',')) add(e.target.value); else setDraft(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(draft); } }}
          onBlur={() => { if (draft.trim()) add(draft); }} />
        <Button type='button' variant='outline' size='sm' className='h-8' disabled={!draft.trim()} onClick={() => add(draft)}>Add</Button>
      </div>
    </div>
  );
}

/** The form's fields as one table (the side panel's body): edit in place, Add field, Save. */
function FormTable() {
  const { data, error } = useAdmin<PagesData>('/access-pages');
  const page = data?.pages.request_form;
  if (error) return <ErrorBox error={error} />;
  if (!page || !data) return <p className='text-muted-foreground text-sm'>Loading…</p>;
  return <Editor key={page.version} page={page} changes={data.changes} />;
}

function Editor({ page, changes }: { page: Page; changes: Change[] }) {
  const [dialog, setDialog] = useState<'history' | 'json' | null>(null);
  const [q, setQ] = useState('');
  const qc = useQueryClient();
  const start = useMemo(() => page.config ?? editorDefaults(), [page.config]);
  const seq = useRef(0);
  const toRows = (c: AccessFormConfig): Row[] => c.fields.filter((f) => !f.hidden).map((f) => ({ ...f, row: ++seq.current, keyTyped: true }));
  const [rows, setRows] = useState<Row[]>(() => toRows(start));
  // The words and the fields the table does not show (not asked): kept as they are, changed through the JSON.
  const [rest, setRest] = useState(() => ({ submit: start.submit, thanks: start.thanks, hidden: start.fields.filter((f) => f.hidden) }));
  const [busy, setBusy] = useState(false);
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const config = useMemo<AccessFormConfig>(() => ({
    submit: rest.submit, thanks: rest.thanks,
    fields: [...rows.map(({ row: _r, keyTyped: _k, ...f }) => f as FormField), ...rest.hidden],
  }), [rows, rest]);
  const dirty = JSON.stringify(config) !== JSON.stringify(start);
  const problems = useMemo(() => accessFormProblems(config).map((p) => p.replace(/^fields\[(\d+)\]/, (_m, i: string) => `Row ${Number(i) + 1}`)), [config]);
  const patch = (row: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.row === row ? { ...r, ...p } : r)));
  const move = (i: number, d: -1 | 1) => setRows((rs) => { const n = [...rs]; const t = n[i]!; n[i] = n[i + d]!; n[i + d] = t; return n; });
  const setLabel = (r: Row, label: string) => patch(r.row, { label, ...(r.keyTyped ? {} : { key: keyOf(label) }) });
  const setType = (r: Row, type: FieldKind) => patch(r.row, { type, options: isChoice(type) ? r.options ?? [{ value: 'Option 1', label: 'Option 1' }] : undefined, ...(isChoice(type) ? { max_length: undefined } : {}) });
  const save = async () => {
    setBusy(true); setServerProblems([]);
    try {
      const r = await adminApi<{ page: Page }>('PUT', '/access-pages/request_form', { version: page.version, config });
      toast.success(`Saved as version ${r.page.version}: live on the public pages now`);
      await Promise.all([qc.invalidateQueries({ queryKey: ['admin', '/access-pages'] }), qc.invalidateQueries({ queryKey: ACCESS_PAGES_KEY })]);
    } catch (e) {
      setServerProblems((e as { body?: { problems?: string[] } }).body?.problems ?? []);
      toast.error((e as Error).message);
    } finally { setBusy(false); }
  };
  const importConfig = (c: AccessFormConfig) => {
    setRows(toRows(c));
    setRest({ submit: c.submit, thanks: c.thanks, hidden: c.fields.filter((f) => f.hidden) });
    setDialog(null);
  };
  const shown = dirty ? problems : [];
  const list = serverProblems.length ? serverProblems : shown;
  return (
    <div className='flex min-w-0 flex-col gap-3' data-testid='form-table'>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='relative min-w-48 flex-1'>
          <Icons.search className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
          <Input type='search' value={q} onChange={(e) => setQ(e.target.value)} placeholder='Search fields' aria-label='Search fields' className='h-9 pl-8' />
        </div>
        <Gate need='accounts'><Button variant='outline' disabled={!dirty || busy || problems.length > 0} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button></Gate>
        <Button type='button' onClick={() => setRows((rs) => [...rs, { row: ++seq.current, key: '', label: '', type: 'text' }])}><Icons.add />Add field</Button>
        <ActionsMenu label='Form actions' items={[
          { label: 'Version history', icon: <Icons.history />, onSelect: () => setDialog('history') },
          { label: 'View or import JSON', icon: <Icons.code />, onSelect: () => setDialog('json') },
        ]} />
      </div>
      <div className='overflow-x-auto rounded-md border'>
        <table className='w-full min-w-[46rem] text-sm' data-testid='form-fields'>
          <thead>
            <tr className='border-b text-left text-xs'>
              <th className='p-2 font-medium'>Field name</th><th className='p-2 font-medium'>Key</th><th className='p-2 font-medium'>Data type</th>
              <th className='p-2 font-medium'>Required</th><th className='min-w-60 p-2 font-medium'>Options</th><th className='p-2 font-medium'>Order</th><th className='p-2' aria-label='Remove' />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const email = r.key === 'email', shell = isShellFormKey(r.key);
              if (q.trim() && !`${r.label} ${r.key}`.toLowerCase().includes(q.trim().toLowerCase())) return null;
              return (
                <tr key={r.row} className='border-b last:border-b-0' data-form-field={r.key || `new-${r.row}`}>
                  <td className='p-1.5'><Input aria-label={`Field name, row ${i + 1}`} value={r.label} onChange={(e) => setLabel(r, e.target.value)} className='h-8' /></td>
                  <td className='p-1.5'><Input aria-label={`Key, row ${i + 1}`} value={r.key} disabled={shell} className='h-8 font-mono text-xs' onChange={(e) => patch(r.row, { key: e.target.value, keyTyped: true })} /></td>
                  <td className='p-1.5'>
                    <NativeSelect aria-label={`Data type, row ${i + 1}`} value={r.type} disabled={email} className='w-32' onChange={(e) => setType(r, e.target.value as FieldKind)}>
                      {FORM_FIELD_TYPES.filter((t) => !shell || t !== 'multi_select').map((t) => <NativeSelectOption key={t} value={t}>{KIND_LABEL[t]}</NativeSelectOption>)}
                    </NativeSelect>
                  </td>
                  <td className='p-1.5 text-center'><Checkbox aria-label={`Required, row ${i + 1}`} checked={!!r.required} disabled={email} onCheckedChange={(v) => patch(r.row, { required: v ? true : undefined })} /></td>
                  <td className='p-1.5'>{isChoice(r.type)
                    ? <OptionsCell n={i + 1} options={r.options ?? []} onChange={(options) => patch(r.row, { options: options.length ? options : undefined })} />
                    : <span className='text-muted-foreground'>—</span>}</td>
                  <td className='p-1.5 whitespace-nowrap'>
                    <Button type='button' variant='outline' size='icon-xs' aria-label={`Move row ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><Icons.chevronUp /></Button>{' '}
                    <Button type='button' variant='outline' size='icon-xs' aria-label={`Move row ${i + 1} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}><Icons.chevronDown /></Button>
                  </td>
                  <td className='p-1.5'>{email ? null : <Button type='button' variant='outline' size='icon-xs' aria-label={`Remove row ${i + 1}`} onClick={() => setRows((rs) => rs.filter((x) => x.row !== r.row))}><Icons.close /></Button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {list.length > 0 && (
        <ul role='alert' className='text-destructive list-disc pl-5 text-sm' data-testid='access-page-problems'>{list.slice(0, 8).map((p, i) => <li key={i} className='break-words'>{p}</li>)}</ul>
      )}
      <HistoryDialog open={dialog === 'history'} onClose={() => setDialog(null)} changes={changes} />
      {dialog === 'json' && <JsonDialog config={config} onClose={() => setDialog(null)} onImport={importConfig} />}
    </div>
  );
}

/** Version history: who saved each version and when, with the form before and after. */
function HistoryDialog({ open, onClose, changes }: { open: boolean; onClose: () => void; changes: Change[] }) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className='max-h-[85dvh] overflow-y-auto sm:max-w-2xl' data-testid='access-history'>
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription className='sr-only'>Each saved version of the early access form.</DialogDescription>
        </DialogHeader>
        {changes.length === 0 ? <p className='text-muted-foreground text-sm'>No change yet: the form is the build&apos;s own.</p> : (
          <ul className='flex flex-col gap-2 text-sm'>
            {changes.map((c) => (
              <li key={c.id} className='rounded-md border p-2'>
                <details>
                  <summary className='cursor-pointer'>Version {c.version}: {c.action === 'reset' ? 'back to the build’s own form' : 'saved'} by {c.changed_by}, <When d={c.changed_at} /></summary>
                  {(['before', 'after'] as const).map((k) => (
                    <div key={k} className='mt-2 min-w-0'>
                      <p className='text-muted-foreground mb-1 text-xs'>{k === 'before' ? 'Before' : 'After'}</p>
                      <pre className='bg-muted max-h-60 overflow-auto rounded-md p-2 text-xs break-words whitespace-pre-wrap'>{c[k] === null ? 'The build’s own form' : JSON.stringify(c[k], null, 2)}</pre>
                    </div>
                  ))}
                </details>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The form as JSON: read it, copy it, or paste one to load into the table (Save then saves it). */
function JsonDialog({ config, onClose, onImport }: { config: AccessFormConfig; onClose: () => void; onImport: (c: AccessFormConfig) => void }) {
  const [text, setText] = useState(() => JSON.stringify(config, null, 2));
  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => setProblems([]), [text]);
  const apply = () => {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { setProblems(['That is not valid JSON.']); return; }
    const bad = accessFormProblems(parsed);
    if (bad.length) { setProblems(bad); return; }
    onImport(parsed as AccessFormConfig);
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className='max-h-[85dvh] overflow-y-auto sm:max-w-2xl' data-testid='access-json'>
        <DialogHeader>
          <DialogTitle>View or import JSON</DialogTitle>
          <DialogDescription className='sr-only'>The form as JSON: edit or paste one, then load it into the table.</DialogDescription>
        </DialogHeader>
        <Textarea aria-label='The form as JSON' rows={18} className='font-mono text-xs' value={text} onChange={(e) => setText(e.target.value)} />
        {problems.length > 0 && <ul role='alert' className='text-destructive list-disc pl-5 text-sm'>{problems.slice(0, 8).map((p, i) => <li key={i} className='break-words'>{p}</li>)}</ul>}
        <DialogFooter>
          <Button type='button' variant='outline' onClick={onClose}>Close</Button>
          <Button type='button' onClick={apply}>Load into the table</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

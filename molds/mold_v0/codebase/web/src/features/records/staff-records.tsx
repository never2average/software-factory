'use client';
// The staff record pages (mold_v0-212; /admin/records/<area> and /admin/records/<area>/<key>): a shared (platform) area
// in the console's standard list, exactly as a customer's list tab reads (mold_v0-208): no title or description above
// it, its four cards, then the search row, then the table (RecordTableView, features/records/record-pages.tsx), a row
// opening the record beside the list. The record's own page is one details card: every field with its label, the
// records its links name, its clocks' timeline.
//
// Writes, only where the server says this staff role may make them (GET /api/admin/records/_console/<area>/form,
// src/record-routes.ts: never an area a repository fills, the role's "library", the staff tool not withheld): a primary
// floating New record button opening the create form (features/tabs/action-fab.tsx, as a tab's create_record action),
// and Edit on an open record and on its page. Both go to /api/admin/data, whose checks are unchanged; read-only areas
// (an upstream catalog's registry) show neither.
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Field } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Icons } from '@/components/icons';
import type { RecordAreaSpec } from '@/config/pack-nav.generated';
import { ActionSheet, CreateRecordForm, Fab, FieldsForm, fieldValues, type FormField } from '@/features/tabs/action-fab';
import { Sparklines } from '@/features/tabs/sparklines';
import { ErrorState, fail, LoadingCards, useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { adminDataApi } from '@/lib/api-client';
import { ClockSection, type ClockEvent } from './clocks';
import { FieldValue, RecordEmpty, RecordTableView, type RecordRow } from './record-pages';
import { areaFieldLabel, findRecordArea, recordsApi } from './registry';

/** What the page offers this staff role (src/record-routes.ts `_console/<area>/form`). */
interface StaffForm { area: string; label: string; create: boolean; edit: boolean; fields: FormField[] }
type Detail = { record: RecordRow; links: { field: string; area: string; records: { key: string; title: string | null }[] }[]; clock_events?: ClockEvent[] };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, body);
  return body;
}

const consoleUrl = (area: string, what: 'sparklines' | 'form') => `${recordsApi('admin')}/_console/${encodeURIComponent(area)}/${what}`;

/** The create and edit this role may use on the area; null while it loads or when it cannot be read (nothing shown). */
function useStaffForm(area: string): StaffForm | null {
  const { data } = useOrgLoad(() => getJson<StaffForm>(consoleUrl(area, 'form')).catch(() => null), [area]);
  return data ?? null;
}

/** A shared area's list: its cards, its search row, its table; New record and Edit where the role may write. */
export function StaffRecordListPage({ area }: { area: RecordAreaSpec }) {
  const form = useStaffForm(area.name);
  const [round, setRound] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RecordRow | null>(null);
  const reload = () => setRound((n) => n + 1);
  return (
    <PageContainer>
      <RecordTableView key={round} area={area} base='admin' url={`${recordsApi('admin')}/${area.name}`} id={`admin-records-${area.name}`}
        empty={<RecordEmpty area={area} base='admin' />}
        summary={<Sparklines url={consoleUrl(area.name, 'sparklines')} tag={`records/${area.name}`} label={`${area.label}: key numbers`} />}
        fab={form?.create ? <Fab label='New record' icon={<Icons.add />} onClick={() => setCreating(true)} /> : undefined}
        rowAction={form?.edit ? (r) => <Button variant='outline' size='sm' onClick={() => setEditing(r)}><Icons.edit /> Edit</Button> : undefined} />
      {form?.create && (
        <ActionSheet open={creating} onOpenChange={setCreating} title='New record' description={area.label}>
          <CreateRecordForm area={{ name: area.name, label: area.label, fields: form.fields }}
            post={(body) => adminDataApi('POST', `/${encodeURIComponent(area.name)}`, body)} onDone={() => { setCreating(false); reload(); }} />
        </ActionSheet>
      )}
      {form?.edit && editing && (
        <ActionSheet open onOpenChange={(o) => { if (!o) setEditing(null); }} title={`Edit ${editing.title || editing.key}`} description={area.label}>
          <EditRecordForm area={area.name} fields={form.fields} row={editing} onDone={() => { setEditing(null); reload(); }} />
        </ActionSheet>
      )}
    </PageContainer>
  );
}

/** A record's own page: one details card (every field, its links, its clocks), Edit where the role may write. */
export function StaffRecordDetailPage({ area, recordKey }: { area: RecordAreaSpec; recordKey: string }) {
  const url = `${recordsApi('admin')}/${area.name}/${encodeURIComponent(recordKey)}`;
  const { data, error, reload } = useOrgLoad(() => getJson<Detail>(url), [url]);
  const form = useStaffForm(area.name);
  const [editing, setEditing] = useState(false);
  const listHref = `/admin/records/${area.name}`;
  return (
    <PageContainer>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={2} /> : (
        <Card className='w-full max-w-4xl gap-0 py-0' data-record-card=''>
          <CardHeader className='border-b py-4 [.border-b]:pb-4'>
            <CardDescription>
              <Link className='inline-flex items-center gap-1 underline-offset-4 hover:underline' href={listHref}><Icons.chevronLeft className='size-3.5' />{area.label}</Link>
            </CardDescription>
            <CardTitle className='text-lg leading-snug break-words'>{data.record.title || data.record.key}</CardTitle>
            {form?.edit && <CardAction><Button variant='outline' size='sm' onClick={() => setEditing(true)}><Icons.edit /> Edit</Button></CardAction>}
          </CardHeader>
          <CardContent className='flex flex-col gap-6 py-2'>
            <dl>
              <Field label='Key'><span className='font-mono text-xs break-all'>{data.record.key}</span></Field>
              {data.record.version && <Field label='Version'>{data.record.version}</Field>}
              {area.fields.map((f) => (
                <Field key={f.name} label={f.label}><span className='whitespace-pre-wrap'><FieldValue area={area} base='admin' f={f} v={data.record.data[f.name]} /></span></Field>
              ))}
              <Field label='Updated'>{data.record.updated_at.slice(0, 10)}</Field>
            </dl>
            <ClockSection record={data.record} events={data.clock_events} />
            {data.links.map((l) => {
              const target = findRecordArea('admin', l.area);
              return (
                <section key={l.field} className='flex flex-col gap-2 pb-4'>
                  <h2 className='text-sm font-medium'>{areaFieldLabel(area, l.field)} · {target?.label ?? l.area}</h2>
                  <ul className='flex flex-col gap-1 text-sm'>
                    {l.records.map((r) => (
                      <li key={r.key}>{target ? <Link className='underline-offset-4 hover:underline' href={`/admin/records/${l.area}/${encodeURIComponent(r.key)}`}>{r.title || r.key}</Link> : r.title || r.key}</li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </CardContent>
        </Card>
      )}
      {form?.edit && data && editing && (
        <ActionSheet open onOpenChange={setEditing} title={`Edit ${data.record.title || data.record.key}`} description={area.label}>
          <EditRecordForm area={area.name} fields={form.fields} row={data.record} onDone={() => { setEditing(false); void reload(); }} />
        </ActionSheet>
      )}
    </PageContainer>
  );
}

/** A stored value as the form's input holds it (FieldsForm, fieldValues turn it back). */
function formValue(f: FormField, v: unknown): unknown {
  if (v === undefined || v === null) return undefined;
  if (f.type === 'boolean') return v === true;
  if (f.type === 'json') return JSON.stringify(v, null, 2);
  if (f.type === 'file') return (Array.isArray(v) ? v : [v]).map((x) => (x && typeof x === 'object' ? String((x as { path?: unknown }).path ?? '') : String(x))).filter(Boolean).join(', ');
  if (f.type === 'enum' && f.multiple) return Array.isArray(v) ? v.map(String) : [String(v)];
  if (Array.isArray(v)) return v.map(String).join(', ');
  if (f.type === 'date') return String(v).slice(0, 10);
  return String(v);
}

/** A record's title and fields, saved whole (PUT /api/admin/data/<area>/<key>); data the form does not show is kept. */
function EditRecordForm({ area, fields, row, onDone }: { area: string; fields: FormField[]; row: RecordRow; onDone: () => void }) {
  const [title, setTitle] = useState(row.title ?? '');
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map((f) => [f.name, formValue(f, row.data[f.name])])));
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const { values: data, problem } = fieldValues(fields, values);
    if (problem) return void toast.error(problem);
    const kept = Object.fromEntries(Object.entries(row.data).filter(([k]) => !fields.some((f) => f.name === k)));
    setBusy(true);
    try {
      await adminDataApi('PUT', `/${encodeURIComponent(area)}/${encodeURIComponent(row.key)}`, { title: title.trim() || null, data: { ...kept, ...data } });
      toast.success('Saved');
      onDone();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <form className='flex flex-col gap-4' onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='edit-key'>Key</Label>
        <Input id='edit-key' value={row.key} readOnly disabled className='font-mono text-xs' />
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='edit-title'>Title</Label>
        <Input id='edit-title' value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <FieldsForm fields={fields} values={values} set={(n, v) => setValues((s) => ({ ...s, [n]: v }))} idPrefix='edit-field' />
      <Button type='submit' disabled={busy} className='self-start'><Icons.check /> {busy ? 'Saving…' : 'Save'}</Button>
    </form>
  );
}

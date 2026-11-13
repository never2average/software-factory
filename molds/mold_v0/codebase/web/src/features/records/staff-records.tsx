'use client';
// The staff record pages (mold_v0-212; /admin/records/<area> and /admin/records/<area>/<key>): a shared (platform) area
// in the console's standard list, exactly as a customer's list tab reads (mold_v0-208): no title or description above
// it, its four cards, then the search row, then the table (RecordTableView, features/records/record-pages.tsx), a row
// opening the record beside the list. The record's own page is one details card: every field with its label, the
// records its links name, its clocks' timeline.
//
// Writes, only where the server says this staff role may make them (GET /api/admin/records/_console/<area>/form,
// src/record-routes.ts: the role's "library", the staff tool not withheld, no encrypted field): a primary New <noun>
// button at the search row's right end opening the create form as a full card (features/tabs/tab-action.tsx, as a tab's
// create_record action), Import beside it (features/records/staff-import.tsx), and Edit on an open record and on its
// page. mold_v0-221: every shared area, a repository's too. Rows staff add are staff rows (provenance staff) beside the
// repository's, which stay read only: Edit on a repository's row is Override (a staff row of the same key that wins over
// it until removed); Remove ("delete") deletes a staff row, or removes an override and puts the repository's version
// back. The open record and the record's page say where a row comes from, and mark an override "Overridden by staff".
// The writes go to /api/admin/data, whose checks are the record store's.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import PageContainer, { PageFrame } from '@/components/layout/page-container';
import { Field, type RowAction } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Icons } from '@/components/icons';
import type { RecordAreaSpec } from '@/config/pack-nav.generated';
import { ActionCard, FormHost, CardForm, CreateRecordForm, FieldsForm, ToolbarAction, fieldValues, useActionOpen, type FormField } from '@/features/tabs/tab-action';
import { Sparklines } from '@/features/tabs/sparklines';
import { ErrorState, fail, LoadingCards, useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { adminDataApi } from '@/lib/api-client';
import { ClockSection, type ClockEvent } from './clocks';
import { RecordDocuments } from './documents';
import { singular } from '@/features/tabs/run-rows';
import { FieldValue, RecordEmpty, RecordTableView, type RecordRow } from './record-pages';
import { ImportRecordsForm } from './staff-import';
import { areaFieldLabel, findRecordArea, recordsApi } from './registry';
import { useVisibilityInput, type RecordVisibility } from '@/features/teams/visibility';
import { featureOn } from '@/config/features';
import { useBreadcrumbTitle } from '@/lib/breadcrumb-leaf';
import { layoutOf } from './detail-layout';
import { LaidOutRecord } from './detail-page';
import { ownsDatabase, RecordResources } from './record-resources';

/** What the page offers this staff role (src/record-routes.ts `_console/<area>/form`). */
interface StaffForm {
  area: string; label: string; create: boolean; edit: boolean; import: boolean; remove: boolean;
  /** The repository that fills the area (mold_v0-221: its rows read only, overridden by staff rows). */
  repository: { name: string; kind: string } | null; fields: FormField[];
  /** mold_v0-271: the most bytes a file staff upload into a file field may have (absent: it takes no upload). */
  upload_max?: number;
  /**
   * mold_v0-282 (flag record_resources): the records' own repository and database fields; a database field is left out of
   * `fields` (the platform creates it: mold_v0-285, a schema of the record's own in the app's own database).
   */
  resources?: { repositories: { field: string; label: string }[]; databases: { field: string; label: string; provider: string }[] };
}
type Detail = { record: RecordRow; links: { field: string; area: string; records: { key: string; title: string | null }[] }[]; clock_events?: ClockEvent[] };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, body);
  return body;
}

const consoleUrl = (area: string, what: 'sparklines' | 'form' | 'import') => `${recordsApi('admin')}/_console/${encodeURIComponent(area)}/${what}`;

/** The create and edit this role may use on the area; null while it loads or when it cannot be read (nothing shown). */
function useStaffForm(area: string): StaffForm | null {
  const { data } = useOrgLoad(() => getJson<StaffForm>(consoleUrl(area, 'form')).catch(() => null), [area]);
  return data ?? null;
}

/** One of the area's records, in the singular: "Report formats" a report format; a label that is no plural, by the area's name. */
export function nounOf(area: { name: string; label: string }): string {
  const one = singular(area.label);
  const s = one !== area.label ? one : singular(area.name.replace(/_/g, ' '));
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** A staff row's write controls: Edit (Override on a repository's row) and Remove (Remove override) where the role may. */
/** A staff row's Edit (or Override) and Remove: its record panel's ⋯ items (mold_v0-278). */
function rowItems({ area, form, row, edit, removed }: { area: RecordAreaSpec; form: StaffForm | null; row: RecordRow; edit: () => void; removed: () => void }): RowAction[] {
  const fromRepository = row.provenance?.by === 'repository', overrides = !!row.provenance?.overrides;
  const remove = async () => {
    const name = row.title || row.key;
    // mold_v0-282: a record that owns a database deletes it with the record (at its provider, first).
    if (!window.confirm(overrides ? `Remove the override of ${name}? The repository's version comes back.`
      : ownsDatabase(area) ? `Remove ${name} from ${area.label}? Its own database is deleted too, with everything in it. This cannot be undone.`
      : `Remove ${name} from ${area.label}? This cannot be undone.`)) return;
    try {
      await adminDataApi('DELETE', `/${encodeURIComponent(area.name)}/${encodeURIComponent(row.key)}`);
      toast.success(overrides ? 'Override removed' : 'Removed');
      removed();
    } catch (e) { fail(e); }
  };
  return [
    ...(form?.edit ? [{ label: fromRepository ? 'Override' : 'Edit', icon: <Icons.edit />, onSelect: edit }] : []),
    ...(form?.remove && !fromRepository ? [{ label: overrides ? 'Remove override' : 'Remove', icon: <Icons.trash />, destructive: true, separator: true, onSelect: () => void remove() }] : []),
  ];
}

/** The same on a staff record's own page: its header's buttons. */
function RowActions(props: { area: RecordAreaSpec; form: StaffForm | null; row: RecordRow; edit: () => void; removed: () => void }) {
  return (<>{rowItems(props).map((a) => (
    <Button key={a.label} variant='outline' size='sm' onClick={a.onSelect} data-row-edit={a.icon && !a.destructive ? (a.label === 'Override' ? 'override' : 'edit') : undefined}
      data-row-remove={a.destructive ? '' : undefined}>{a.icon} {a.label}</Button>
  ))}</>);
}

/** Where a shared row comes from (mold_v0-221): staff or its repository; an override marked, with what it stands over. */
function ProvenanceFields({ row, form }: { row: RecordRow; form: StaffForm | null }) {
  const p = row.provenance;
  if (!p) return null;
  return (<>
    <Field label='Added by'>{p.by === 'repository' ? `Repository ${p.repository ?? ''} (read only${form?.edit ? ': Override to change it' : ''})` : 'Staff'}</Field>
    {p.overrides && (
      <Field label='Repository'>
        <span className='flex flex-col items-start gap-1' data-overridden=''>
          <Badge variant='secondary'><Icons.edit /> Overridden by staff</Badge>
          <span className='text-muted-foreground text-xs'>Over {p.repository}’s {p.overrides.title ? `“${p.overrides.title}”` : 'row'}{p.overrides.version ? ` at ${p.overrides.version.slice(0, 12)}` : ''}, which comes back when the override is removed.</span>
        </span>
      </Field>
    )}
  </>);
}

const editTitle = (row: RecordRow) => `${row.provenance?.by === 'repository' ? 'Override' : 'Edit'} ${row.title || row.key}`;
const editDescription = (area: RecordAreaSpec, row: RecordRow) => (row.provenance?.by === 'repository'
  ? `A staff copy of this row of ${row.provenance.repository}, saved as a staff row that wins over it until removed; removing it puts the repository's version back.`
  : `${area.label}: its title and fields, saved whole.`);

/**
 * mold_v0-282: what the New form says of the record's own resources: the database the platform creates for it (mold_v0-285:
 * a schema of its own in the app's own database); a repository is checked when it is saved.
 */
function ResourcesNote({ form, noun }: { form: StaffForm; noun: string }) {
  const r = form.resources;
  if (!r || (!r.databases.length && !r.repositories.length)) return null;
  return (
    <div className='flex flex-col gap-2 pb-2 text-sm' data-resources-note=''>
      {r.databases.length > 0 && (
        <p className='text-muted-foreground'>Adding it creates its own {r.databases.map((d) => d.label.toLowerCase()).join(' and ')} (a schema of its own in this app’s database): its status shows on the {noun}’s page.</p>
      )}
      {r.repositories.length > 0 && <p className='text-muted-foreground'>{r.repositories.map((x) => x.label).join(' and ')}: an existing GitHub repository, owner/name; the platform’s GitHub App must be able to read it.</p>}
    </div>
  );
}

/** A shared area's list: its cards, its search row, its table; New, Import and Edit where the role may write. */
export function StaffRecordListPage({ area, bare = false }: { area: RecordAreaSpec; bare?: boolean }) {
  const form = useStaffForm(area.name);
  const [round, setRound] = useState(0);
  // mold_v0-217: New and Edit are full cards in the list's place; New kept in the address (?new=1), Import too (?import=1).
  const [creating, setCreating] = useActionOpen('new');
  const [importing, setImporting] = useActionOpen('import');
  const [editing, setEditing] = useState<RecordRow | null>(null);
  const reload = () => setRound((n) => n + 1);
  const noun = nounOf(area);
  // mold_v0-256: New and Edit open in a panel beside the list with side_panel_forms on (FormHost); Import stays a full card.
  const card = form?.create && creating ? (
        <ActionCard open onOpenChange={setCreating} title={`New ${noun}`} description={`A new ${noun} in ${area.label}, added to the list at once as a staff row.`}>
          <CreateRecordForm area={{ name: area.name, label: area.label, fields: form.fields }} note={<ResourcesNote form={form} noun={noun} />} uploadMax={form.upload_max ?? null} filesBase='/api/admin/records'
            post={(body) => adminDataApi('POST', `/${encodeURIComponent(area.name)}`, body)} onDone={() => { setCreating(false); reload(); }} />
        </ActionCard>
      ) : form?.import && importing ? (
        <ActionCard open onOpenChange={setImporting} title={`Import ${noun}s`} description={`Rows of a CSV or JSON file as staff rows of ${area.label}: map its columns, preview, then import.`}>
          <ImportRecordsForm area={area} fields={form.fields} noun={noun} url={consoleUrl(area.name, 'import')} onDone={() => { setImporting(false); reload(); }} />
        </ActionCard>
      ) : form?.edit && editing ? (
        <ActionCard open onOpenChange={(o) => { if (!o) setEditing(null); }} title={editTitle(editing)} description={editDescription(area, editing)}>
          <EditRecordForm area={area.name} fields={form.fields} row={editing} onDone={() => { setEditing(null); reload(); }} />
        </ActionCard>
      ) : null;
  return (
    <PageFrame bare={bare}>
      <FormHost card={card} panel={!(form?.import && importing)}>
      <RecordTableView key={round} area={area} base='admin' url={`${recordsApi('admin')}/${area.name}`} id={`admin-records-${area.name}`}
        empty={<RecordEmpty area={area} base='admin' />}
        summary={<Sparklines url={consoleUrl(area.name, 'sparklines')} tag={`records/${area.name}`} label={`${area.label}: key numbers`} />}
        // mold_v0-294: Import is an item of the search row's Actions ▾ menu (before Export); New <noun> the primary action after it.
        importAction={form?.import ? { label: `Import ${area.label}`, icon: <Icons.upload />, hint: 'CSV or JSON', onSelect: () => setImporting(true), testId: 'toolbar-import' } : null}
        toolbarAction={form?.create ? <ToolbarAction label={`New ${noun}`} icon={<Icons.add />} onClick={() => setCreating(true)} /> : undefined}
        rowActions={form?.edit || form?.remove ? (r) => rowItems({ area, form, row: r, edit: () => setEditing(r), removed: reload }) : undefined}
        detailNote={(r) => <ProvenanceFields row={r} form={form} />} />
      </FormHost>
    </PageFrame>
  );
}

/** A record's own page: one details card (every field, its links, its clocks), Edit where the role may write. */
export function StaffRecordDetailPage({ area, recordKey }: { area: RecordAreaSpec; recordKey: string }) {
  const url = `${recordsApi('admin')}/${area.name}/${encodeURIComponent(recordKey)}`;
  const { data, error, reload } = useOrgLoad(() => getJson<Detail>(url), [url]);
  const form = useStaffForm(area.name);
  const [editing, setEditing] = useState(false);
  const listHref = `/admin/records/${area.name}`;
  const router = useRouter();
  // mold_v0-271 (flag record_pages): a shared area with a layout is laid out here as on a workspace's page, with its
  // related lists and computed facts of shared areas and staff's own Edit and Remove in its header.
  const layout = featureOn('record_pages') ? layoutOf(area) : null;
  // mold_v0-298: the top bar's last crumb names the record, not its key from the address.
  useBreadcrumbTitle(data?.record.title || null);
  if (layout) return (
    <PageContainer>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={3} /> : (
        <FormHost panel card={form?.edit && editing ? (
          <ActionCard open onOpenChange={setEditing} title={editTitle(data.record)} description={editDescription(area, data.record)}>
            <EditRecordForm area={area.name} fields={form.fields} row={data.record} onDone={() => { setEditing(false); void reload(); }} />
          </ActionCard>
        ) : null}>
          <LaidOutRecord area={area} base='admin' layout={layout} record={data.record} links={data.links} clockEvents={data.clock_events}
            provenance={data.record.provenance ? { by: data.record.provenance.by === 'repository' ? 'repository' : 'staff' } : null} where='Shared' credentials={null} onChanged={() => void reload()}
            headerActions={form?.edit || form?.remove ? <RowActions area={area} form={form} row={data.record} edit={() => setEditing(true)}
              removed={() => (data.record.provenance?.overrides ? void reload() : router.push(listHref))} /> : null} />
          <RecordResources area={area} recordKey={data.record.key} />
        </FormHost>
      )}
    </PageContainer>
  );
  return (
    <PageContainer>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={2} /> : (
        // mold_v0-256: Edit in a panel over the record (flag side_panel_forms), else the full card in its place.
        <FormHost panel card={form?.edit && editing ? (
          <ActionCard open onOpenChange={setEditing} title={editTitle(data.record)} description={editDescription(area, data.record)}>
            <EditRecordForm area={area.name} fields={form.fields} row={data.record} onDone={() => { setEditing(false); void reload(); }} />
          </ActionCard>
        ) : null}>
        <Card className='w-full max-w-4xl gap-0 py-0' data-record-card=''>
          <CardHeader className='border-b py-4 [.border-b]:pb-4'>
            <CardDescription>
              <Link className='inline-flex items-center gap-1 underline-offset-4 hover:underline' href={listHref}><Icons.chevronLeft className='size-3.5' />{area.label}</Link>
            </CardDescription>
            <CardTitle className='text-lg leading-snug break-words'>{data.record.title || data.record.key}</CardTitle>
            {(form?.edit || form?.remove) && (
              <CardAction className='flex gap-2'>
                <RowActions area={area} form={form} row={data.record} edit={() => setEditing(true)}
                  removed={() => (data.record.provenance?.overrides ? void reload() : router.push(listHref))} />
              </CardAction>
            )}
          </CardHeader>
          <CardContent className='flex flex-col gap-6 py-2'>
            <dl>
              <Field label='Key'><span className='font-mono text-xs break-all'>{data.record.key}</span></Field>
              <ProvenanceFields row={data.record} form={form} />
              {data.record.version && <Field label='Version'>{data.record.version}</Field>}
              {area.fields.map((f) => (
                <Field key={f.name} label={f.label}><span className='whitespace-pre-wrap'><FieldValue area={area} base='admin' f={f} v={data.record.data[f.name]} recordKey={data.record.key} /></span></Field>
              ))}
              <Field label='Updated'>{data.record.updated_at.slice(0, 10)}</Field>
            </dl>
            <RecordDocuments area={area} base='admin' recordKey={data.record.key} />
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
        <RecordResources area={area} recordKey={data.record.key} />
        </FormHost>
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

/**
 * A record's title and fields, saved whole (PUT /api/admin/data/<area>/<key>); data the form does not show is kept. On a
 * repository's row (mold_v0-221) the save is an override: a staff row of the same key, the repository's kept behind it.
 */
/**
 * A record's edit form (its title and fields; the key read only) as a full card. `put` sends it (default: the shared
 * area's /api/admin/data; mold_v0-254, a workspace record page's Edit: its page action). What the form leaves out of the
 * record's data is sent back as it was.
 */
export function EditRecordForm({ area, fields, row, onDone, put, shareable = null }: { area: string; fields: FormField[]; row: RecordRow; onDone: () => void;
  put?: (body: { title: string | null; data: Record<string, unknown> }) => Promise<unknown>;
  /** mold_v0-259 (flag teams): a workspace record whose visibility this person may change (its owner, a team lead, an owner). */
  shareable?: RecordVisibility | null }) {
  const vis = useVisibilityInput(shareable ? findRecordArea('app', area) : null, shareable);
  const [title, setTitle] = useState(row.title ?? '');
  // mold_v0-271: a file field holding stored files is kept as it is (the form edits what it can show; a file is not text).
  fields = fields.filter((f) => !(f.type === 'file' && (Array.isArray(row.data[f.name]) ? (row.data[f.name] as unknown[]) : [row.data[f.name]]).some((x) => !!x && typeof x === 'object' && 'object' in (x as object))));
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map((f) => [f.name, formValue(f, row.data[f.name])])));
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const { values: data, problem } = fieldValues(fields, values);
    if (problem) return void toast.error(problem);
    if (shareable && vis.problem) return void toast.error(vis.problem);
    const kept = Object.fromEntries(Object.entries(row.data).filter(([k]) => !fields.some((f) => f.name === k)));
    setBusy(true);
    try {
      const body = { title: title.trim() || null, data: { ...kept, ...data }, ...(shareable ? vis.body : {}) };
      await (put ? put(body) : adminDataApi('PUT', `/${encodeURIComponent(area)}/${encodeURIComponent(row.key)}`, body));
      toast.success('Saved');
      onDone();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <CardForm onSubmit={submit} submit={<Button type='submit' disabled={busy}><Icons.check /> {busy ? 'Saving…' : row.provenance?.by === 'repository' ? 'Save override' : 'Save'}</Button>}>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='edit-key'>Key</Label>
        <Input id='edit-key' value={row.key} readOnly disabled className='font-mono text-xs' />
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='edit-title'>Title</Label>
        <Input id='edit-title' value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <FieldsForm fields={fields} values={values} set={(n, v) => setValues((s) => ({ ...s, [n]: v }))} idPrefix='edit-field' />
      {shareable && vis.field?.('edit-visibility', shareable.owner)}
    </CardForm>
  );
}

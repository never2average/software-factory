'use client';
// A list tab's primary floating action (mold_v0-208; pack.json tabs[].action, src/tab-actions.ts): one button in the
// brand's primary colour, fixed at the bottom right clear of the safe area (the list keeps its space free below the
// pager: RecordView `fab`, FAB_SPACE), an icon and its label from a small screen up, the icon alone on a phone (the
// label its accessible name). It opens one of the shell's forms in a drawer and is shown only to a role that may use it
// (the server says so, and refuses the rest anyway):
//   start_run      the kind (a picker when the action offers several), its arguments, the record it runs over and its
//                  environment when the kind takes them; started as the generated start_<kind> tool starts a run
//   create_record  a new record's key, title and fields, through the data API (POST /api/data/<area>)
//   new_schedule   the schedules page's Add a schedule form (features/schedules/schedules-page.tsx draws its button)
//   link           (mold_v0-213) a page or an address, e.g. Settings › Email for a list a connected mailbox fills
// Every list tab has one unless its pack says none (mold_v0-213: the build resolves the shell's default, labelled).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import type { PackTabSpec } from '@/config/pack-nav.generated';
import { fail, useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { fill } from '@/lib/vocabulary';

/** A field as the server's form spec gives it (src/tab-actions.ts FormField). */
export interface FormField {
  name: string; label: string; type: string; help: string | null; required: boolean; options: { value: string; label: string }[] | null;
  multiple: boolean; min: number | null; max: number | null; max_length: number | null; to: string | null;
}
interface StartKind { name: string; label: string; description: string | null; args: FormField[]; targets: { name: string; label: string }[] | null; environments: string[] | null }
type ActionSpec =
  | { kind: 'start_run'; label: string | null; allowed: boolean; kinds: StartKind[] }
  | { kind: 'new_schedule'; label: string | null; allowed: boolean; job_kind: string | null }
  | { kind: 'create_record'; label: string | null; allowed: boolean; area: { name: string; label: string; fields: FormField[] } | null };

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-pack-request': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, json);
  return json;
}

/** What the button needs of its tab. */
type TabRef = Pick<PackTabSpec, 'pack' | 'id' | 'action'>;

/** The words a tab's action shows when the pack gives none. */
export const actionLabel = (a: NonNullable<PackTabSpec['action']>) =>
  a.label ?? (a.kind === 'start_run' ? fill('Start {run}') : a.kind === 'new_schedule' ? 'New schedule' : a.kind === 'link' ? 'Open' : 'New record');

const FAB_CLASS = 'fixed right-[calc(1.5rem+env(safe-area-inset-right))] bottom-[calc(1.5rem+env(safe-area-inset-bottom))] z-40 size-14 gap-2 rounded-full p-0 text-sm font-medium shadow-lg sm:w-auto sm:px-5 [&_svg]:size-5';

/**
 * The floating button itself: fixed bottom right, 1.5rem from the window's edges plus the safe-area insets; a 3.5rem
 * circle with the icon on a phone, the icon and the label from sm up.
 */
export function Fab({ label, icon, onClick, href }: { label: string; icon: ReactNode; onClick?: () => void; href?: string }) {
  // A link action (mold_v0-213): the same button, as a link (a page of the console, or an address in a new tab).
  if (href) return (
    <Button aria-label={label} title={label} data-fab='' className={FAB_CLASS} nativeButton={false}
      render={href.startsWith('/') ? <Link href={href} /> : <a href={href} target='_blank' rel='noopener noreferrer' />}>
      {icon}<span className='hidden sm:inline'>{label}</span>
    </Button>
  );
  return (
    <Button type='button' onClick={onClick} aria-label={label} title={label} data-fab='' className={FAB_CLASS}>
      {icon}<span className='hidden sm:inline'>{label}</span>
    </Button>
  );
}

/** A link action's button (mold_v0-213): no form and nothing to ask the server, everyone's who sees the tab. */
export function LinkFab({ action }: { action: NonNullable<PackTabSpec['action']> }) {
  return action.kind === 'link' && action.href ? <Fab label={actionLabel(action)} icon={<Icons.arrowRight />} href={action.href} /> : null;
}

/** A drawer from the right (a phone: the whole width) holding one of the action's forms. */
export function ActionSheet({ open, onOpenChange, title, description, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side='right' className='gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md'>
        <SheetHeader className='border-b'>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className='min-h-0 flex-1 overflow-y-auto p-4'>{children}</div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * A tab's start_run or create_record action: its button once the server says this person may use it, and its drawer.
 * `onDone` reloads the list after a run started or a record was added.
 */
export function TabActionFab({ tab, onDone }: { tab: TabRef; onDone?: () => unknown }) {
  const a = tab.action;
  const { data } = useOrgLoad(() => (a && a.kind !== 'new_schedule' && a.kind !== 'link'
    ? send<ActionSpec>('GET', `/api/tab-actions/${encodeURIComponent(tab.pack)}/${encodeURIComponent(tab.id)}`).catch(() => null)
    : Promise.resolve(null)), [tab.pack, tab.id]);
  const [open, setOpen] = useState(false);
  if (a?.kind === 'link') return <LinkFab action={a} />;
  if (!a || !data || !data.allowed) return null;
  const label = actionLabel(a);
  const done = () => { setOpen(false); void onDone?.(); };
  return (<>
    <Fab label={label} icon={a.kind === 'start_run' ? <Icons.play /> : <Icons.add />} onClick={() => setOpen(true)} />
    <ActionSheet open={open} onOpenChange={setOpen} title={label}
      description={data.kind === 'start_run' ? fill('The {run} is queued and runs on its own; it shows in the list at once.') : undefined}>
      {data.kind === 'start_run' ? <StartRunForm tab={tab} kinds={data.kinds} onDone={done} />
        : data.kind === 'create_record' && data.area ? <CreateRecordForm area={data.area} onDone={done} /> : null}
    </ActionSheet>
  </>);
}

// ---------- the forms ----------

const keysOf = (text: string) => text.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean);

/** The typed values of a form's fields, as the record store and a kind's arguments take them; the first problem, if any. */
export function fieldValues(fields: FormField[], raw: Record<string, unknown>): { values: Record<string, unknown>; problem: string | null } {
  const values: Record<string, unknown> = {};
  for (const f of fields) {
    const v = raw[f.name];
    const blank = v === undefined || v === '' || (Array.isArray(v) && !v.length);
    if (blank) { if (f.required && f.type !== 'boolean') return { values, problem: `${f.label} is required` }; continue; }
    if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) return { values, problem: `${f.label} is a number` };
      values[f.name] = n;
    } else if (f.type === 'boolean') values[f.name] = v === true;
    else if (f.type === 'json') {
      try { values[f.name] = JSON.parse(String(v)); } catch { return { values, problem: `${f.label} is not valid JSON` }; }
    } else if (f.type === 'file') values[f.name] = f.multiple ? keysOf(String(v)).map((path) => ({ path })) : { path: String(v).trim() };
    else if (f.multiple && !Array.isArray(v)) values[f.name] = keysOf(String(v));
    else values[f.name] = v;
  }
  return { values, problem: null };
}

/** One input per field, by its type (the record store checks every value again). */
export function FieldsForm({ fields, values, set, idPrefix }: {
  fields: FormField[]; values: Record<string, unknown>; set: (name: string, v: unknown) => void; idPrefix: string;
}) {
  return (<>
    {fields.map((f) => {
      const id = `${idPrefix}-${f.name}`, v = values[f.name];
      const help = f.help && <p className='text-muted-foreground text-xs'>{f.help}</p>;
      const label = <Label htmlFor={id}>{f.label}{f.required && <span className='text-destructive' aria-hidden> *</span>}</Label>;
      if (f.type === 'boolean') return (
        <div key={f.name} className='flex flex-col gap-1.5'>
          <div className='flex items-center gap-2'><Checkbox id={id} checked={v === true} onCheckedChange={(on) => set(f.name, !!on)} />{label}</div>{help}
        </div>
      );
      if (f.type === 'enum' && f.options && f.multiple) return (
        <fieldset key={f.name} className='flex flex-col gap-1.5'>
          <legend className='mb-1.5 text-sm font-medium'>{f.label}{f.required && <span className='text-destructive' aria-hidden> *</span>}</legend>
          {f.options.map((o) => {
            const list = Array.isArray(v) ? (v as string[]) : [];
            return (
              <label key={o.value} className='flex items-center gap-2 text-sm'>
                <Checkbox checked={list.includes(o.value)} onCheckedChange={(on) => set(f.name, on ? [...list, o.value] : list.filter((x) => x !== o.value))} />{o.label}
              </label>
            );
          })}
          {help}
        </fieldset>
      );
      return (
        <div key={f.name} className='flex flex-col gap-1.5'>
          {label}
          {f.type === 'enum' && f.options ? (
            <NativeSelect id={id} className='w-full' value={String(v ?? '')} onChange={(e) => set(f.name, e.target.value)} required={f.required}>
              <NativeSelectOption value=''>{f.required ? 'Choose one' : 'None'}</NativeSelectOption>
              {f.options.map((o) => <NativeSelectOption key={o.value} value={o.value}>{o.label}</NativeSelectOption>)}
            </NativeSelect>
          ) : f.type === 'json' || (f.type === 'text' && (f.max_length === null || f.max_length > 200)) ? (
            <Textarea id={id} rows={f.type === 'json' ? 5 : 3} className={f.type === 'json' ? 'font-mono text-xs' : undefined} value={String(v ?? '')}
              maxLength={f.max_length ?? undefined} onChange={(e) => set(f.name, e.target.value)} required={f.required} placeholder={f.type === 'json' ? '{ }' : undefined} />
          ) : (
            <Input id={id} value={String(v ?? '')} onChange={(e) => set(f.name, e.target.value)} required={f.required}
              type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} min={f.min ?? undefined} max={f.max ?? undefined}
              maxLength={f.max_length ?? undefined}
              placeholder={f.type === 'reference' || f.type === 'link' ? (f.multiple ? 'record keys, comma-separated' : 'a record key')
                : f.type === 'person' ? 'a person’s sign-in id' : f.type === 'file' ? 'a path in the workspace’s files' : undefined} />
          )}
          {help}
        </div>
      );
    })}
  </>);
}

/** The records a run may target: up to 200 of an asset area, by title. */
function useTargets(area: string | null) {
  const { data } = useOrgLoad(() => (area
    ? send<{ records: { key: string; title: string | null }[] }>('GET', `/api/records/${encodeURIComponent(area)}?limit=200`).catch(() => ({ records: [] }))
    : Promise.resolve({ records: [] })), [area]);
  return data?.records ?? null;
}

function StartRunForm({ tab, kinds, onDone }: { tab: TabRef; kinds: StartKind[]; onDone: () => void }) {
  const [kindName, setKindName] = useState(kinds[0]?.name ?? '');
  const kind = kinds.find((k) => k.name === kindName) ?? kinds[0]!;
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [targetArea, setTargetArea] = useState<string | null>(kind.targets?.[0]?.name ?? null);
  const [target, setTarget] = useState('');
  const [environment, setEnvironment] = useState('');
  const [busy, setBusy] = useState(false);
  const area = kind.targets?.find((t) => t.name === targetArea)?.name ?? kind.targets?.[0]?.name ?? null;
  const records = useTargets(area);
  // The first record is the default target (a run is mostly over one of them); "none" stays a choice.
  useEffect(() => { if (records && !records.some((r) => r.key === target)) setTarget(records[0]?.key ?? ''); }, [records]); // eslint-disable-line react-hooks/exhaustive-deps
  const areaLabel = useMemo(() => kind.targets?.find((t) => t.name === area)?.label ?? 'Record', [kind, area]);
  const submit = async () => {
    const { values: args, problem } = fieldValues(kind.args, values);
    if (problem) return void toast.error(problem);
    setBusy(true);
    try {
      const input = { ...args, ...(area && target ? { target_asset: { area, key: target } } : {}), ...(environment.trim() ? { target_environment: environment.trim() } : {}) };
      await send('POST', `/api/tab-actions/${encodeURIComponent(tab.pack)}/${encodeURIComponent(tab.id)}/start`, { kind: kind.name, input });
      toast.success(`${kind.label}: started`);
      onDone();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <form className='flex flex-col gap-4' onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {kinds.length > 1 && (
        <div className='flex flex-col gap-1.5'>
          <Label htmlFor='fab-kind'>Type</Label>
          <NativeSelect id='fab-kind' className='w-full' value={kind.name} onChange={(e) => { setKindName(e.target.value); setValues({}); setEnvironment(''); }}>
            {kinds.map((k) => <NativeSelectOption key={k.name} value={k.name}>{k.label}</NativeSelectOption>)}
          </NativeSelect>
        </div>
      )}
      {kind.description && <p className='text-muted-foreground text-sm'>{kind.description}</p>}
      {kind.targets && kind.targets.length > 1 && (
        <div className='flex flex-col gap-1.5'>
          <Label htmlFor='fab-target-area'>Runs over</Label>
          <NativeSelect id='fab-target-area' className='w-full' value={area ?? ''} onChange={(e) => setTargetArea(e.target.value)}>
            {kind.targets.map((t) => <NativeSelectOption key={t.name} value={t.name}>{t.label}</NativeSelectOption>)}
          </NativeSelect>
        </div>
      )}
      {area && (
        <div className='flex flex-col gap-1.5'>
          <Label htmlFor='fab-target'>{areaLabel}</Label>
          <NativeSelect id='fab-target' className='w-full' value={target} onChange={(e) => setTarget(e.target.value)} disabled={!records}>
            {(records ?? []).map((r) => <NativeSelectOption key={r.key} value={r.key}>{r.title && r.title !== r.key ? `${r.title} (${r.key})` : r.key}</NativeSelectOption>)}
            <NativeSelectOption value=''>None</NativeSelectOption>
          </NativeSelect>
        </div>
      )}
      {kind.environments && (
        <div className='flex flex-col gap-1.5'>
          <Label htmlFor='fab-env'>Environment</Label>
          {kind.environments.length ? (
            <NativeSelect id='fab-env' className='w-full' value={environment} onChange={(e) => setEnvironment(e.target.value)}>
              <NativeSelectOption value=''>None</NativeSelectOption>
              {kind.environments.map((x) => <NativeSelectOption key={x} value={x}>{x}</NativeSelectOption>)}
            </NativeSelect>
          ) : <Input id='fab-env' value={environment} onChange={(e) => setEnvironment(e.target.value)} placeholder='e.g. production' />}
        </div>
      )}
      <FieldsForm fields={kind.args} values={values} set={(n, v) => setValues((s) => ({ ...s, [n]: v }))} idPrefix='fab-arg' />
      <Button type='submit' disabled={busy} className='self-start'><Icons.play /> {busy ? 'Starting…' : 'Start'}</Button>
    </form>
  );
}

/**
 * A new record's key, title and fields; `post` sends it (default: the workspace's data API; mold_v0-212, a staff record
 * page: the shared area's /api/admin/data).
 */
export function CreateRecordForm({ area, onDone, post }: {
  area: { name: string; label: string; fields: FormField[] }; onDone: () => void; post?: (body: { key: string; title?: string; data: Record<string, unknown> }) => Promise<unknown>;
}) {
  const [key, setKey] = useState('');
  const [title, setTitle] = useState('');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const { values: data, problem } = fieldValues(area.fields, values);
    if (problem) return void toast.error(problem);
    setBusy(true);
    try {
      const body = { key: key.trim(), ...(title.trim() ? { title: title.trim() } : {}), data };
      await (post ? post(body) : send('POST', `/api/data/${encodeURIComponent(area.name)}`, body));
      toast.success('Added');
      onDone();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <form className='flex flex-col gap-4' onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='fab-key'>Key<span className='text-destructive' aria-hidden> *</span></Label>
        <Input id='fab-key' value={key} onChange={(e) => setKey(e.target.value)} required placeholder='a short id, unique in this list' />
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='fab-title'>Title</Label>
        <Input id='fab-title' value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <FieldsForm fields={area.fields} values={values} set={(n, v) => setValues((s) => ({ ...s, [n]: v }))} idPrefix='fab-field' />
      <Button type='submit' disabled={busy || !key.trim()} className='self-start'><Icons.add /> {busy ? 'Adding…' : 'Add'}</Button>
    </form>
  );
}

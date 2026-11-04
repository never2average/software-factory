'use client';
// A list tab's primary action (mold_v0-208; pack.json tabs[].action, src/tab-actions.ts): one button in the brand's
// primary colour at the right end of the list's search row (mold_v0-217: RecordView `toolbarAction`; before, a floating
// button at the window's bottom right), an icon and its label from a small screen up, the icon alone on a phone (the label
// its accessible name and title). It opens one of the shell's forms as a full card in the list's place (mold_v0-217:
// ActionCard, CardForm; the record details card's style: a way back, the title, what will happen, the fields, then the
// submit and Cancel), kept in the address (?start=1 for a run, ?new=1 for a record or a schedule) so Back works; Cancel
// or a submit returns to the list, read again. It is shown only to a role that may use it (the server says so, and
// refuses the rest anyway):
//   start_run      the kind (a picker when the action offers several), its arguments, the record it runs over and its
//                  environment when the kind takes them; started as the generated start_<kind> tool starts a run
//   create_record  a new record's key, title and fields, through the data API (POST /api/data/<area>)
//   new_schedule   the schedules page's Add a schedule form (features/schedules/schedules-page.tsx draws its button)
//   link           (mold_v0-213) a page or an address, e.g. Settings › Email for a list a connected mailbox fills
// Every list tab has one unless its pack says none (mold_v0-213: the build resolves the shell's default, labelled).
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import Link from 'next/link';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
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

// The toolbar's own button size (as Export beside it); a phone: the icon alone, square.
const ACTION_CLASS = 'ml-auto shrink-0 max-sm:w-8 max-sm:px-0';

/**
 * The button itself, the last control of the list's search row (mold_v0-217): a normal primary button, the icon and its
 * label from sm up; on a phone the icon alone, its label the accessible name and the title.
 */
export function ToolbarAction({ label, icon, onClick, href }: { label: string; icon: ReactNode; onClick?: () => void; href?: string }) {
  // A link action (mold_v0-213): the same button, as a link (a page of the console, or an address in a new tab).
  if (href) return (
    <Button aria-label={label} title={label} data-toolbar-action='' className={ACTION_CLASS} nativeButton={false}
      render={href.startsWith('/') ? <Link href={href} /> : <a href={href} target='_blank' rel='noopener noreferrer' />}>
      {icon}<span className='hidden sm:inline'>{label}</span>
    </Button>
  );
  return (
    <Button type='button' onClick={onClick} aria-label={label} title={label} data-toolbar-action='' className={ACTION_CLASS}>
      {icon}<span className='hidden sm:inline'>{label}</span>
    </Button>
  );
}

/** A link action's button (mold_v0-213): no form and nothing to ask the server, everyone's who sees the tab. */
export function LinkAction({ action }: { action: NonNullable<PackTabSpec['action']> }) {
  return action.kind === 'link' && action.href ? <ToolbarAction label={actionLabel(action)} icon={<Icons.arrowRight />} href={action.href} /> : null;
}

/**
 * Whether the page shows an action's card (mold_v0-217), kept in the address: `start` (?start=1) for a run, `new`
 * (?new=1) for a record or a schedule. Opening adds a history entry, so Back returns to the list; closing replaces it.
 */
export function useActionOpen(name: 'start' | 'new'): [boolean, (open: boolean) => void] {
  const [on, set] = useQueryState(name, parseAsBoolean.withDefault(false));
  return [on, (open: boolean) => {
    void set(open ? true : null, { history: open ? 'push' : 'replace' });
    // Back on the list: focus returns to the button that opened the card.
    if (!open) setTimeout(() => document.querySelector<HTMLElement>('[data-toolbar-action]')?.focus(), 50);
  }];
}

const CardCtx = createContext<{ title: string; description?: string; cancel: () => void } | null>(null);

/**
 * An action's form as a full card in the list's place (mold_v0-217; the record details card's style): drawn while
 * `open`; its CardForm reads the title, the description and Cancel from here.
 */
export function ActionCard({ open, onOpenChange, title, description, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: ReactNode;
}) {
  if (!open) return null;
  return <CardCtx.Provider value={{ title, description, cancel: () => onOpenChange(false) }}>{children}</CardCtx.Provider>;
}

/**
 * The card itself: a way back to the list, the title and what will happen, the fields, then the submit and Cancel.
 * Focus moves to its title when it opens.
 */
export function CardForm({ onSubmit, submit, children }: { onSubmit: () => unknown; submit: ReactNode; children: ReactNode }) {
  const c = useContext(CardCtx);
  const title = useRef<HTMLDivElement>(null);
  useEffect(() => { title.current?.focus(); }, []);
  const cancel = () => c?.cancel();
  return (
    <Card className='w-full max-w-4xl gap-0 py-0' data-action-card=''>
      <form className='flex flex-col' onSubmit={(e) => { e.preventDefault(); void onSubmit(); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } }}>
        <CardHeader className='border-b py-4 [.border-b]:pb-4'>
          <CardDescription>
            <button type='button' className='inline-flex items-center gap-1 underline-offset-4 hover:underline' onClick={cancel}>
              <Icons.chevronLeft className='size-3.5' />Back to the list
            </button>
          </CardDescription>
          <CardTitle ref={title} tabIndex={-1} className='text-lg leading-snug break-words outline-none'>{c?.title}</CardTitle>
          {c?.description && <p className='text-muted-foreground text-sm'>{c.description}</p>}
        </CardHeader>
        <CardContent className='flex flex-col gap-4 py-4'>{children}</CardContent>
        <CardFooter data-card-footer='' className='gap-2 border-t py-4 [.border-t]:pt-4'>
          {submit}
          <Button type='button' variant='outline' onClick={cancel}>Cancel</Button>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * A tab's action: its button (once the server says this person may use it; a link action's at once) and, while open,
 * its card (start_run, create_record) for the list's place. `onDone` reloads the list after a run started or a record
 * was added. Called on every render of the list (a hook), with null when the tab has no action.
 */
export function useTabAction(tab: TabRef | null, onDone?: () => unknown): { button: ReactNode; card: ReactNode } {
  const a = tab?.action;
  const { data } = useOrgLoad(() => (tab && a && a.kind !== 'new_schedule' && a.kind !== 'link'
    ? send<ActionSpec>('GET', `/api/tab-actions/${encodeURIComponent(tab.pack)}/${encodeURIComponent(tab.id)}`).catch(() => null)
    : Promise.resolve(null)), [tab?.pack, tab?.id]);
  const [open, setOpen] = useActionOpen(a?.kind === 'start_run' ? 'start' : 'new');
  if (!tab || !a) return { button: null, card: null };
  if (a.kind === 'link') return { button: <LinkAction action={a} />, card: null };
  if (!data || !data.allowed) return { button: null, card: null };
  const label = actionLabel(a);
  const done = () => { setOpen(false); void onDone?.(); };
  return {
    button: <ToolbarAction label={label} icon={a.kind === 'start_run' ? <Icons.play /> : <Icons.add />} onClick={() => setOpen(true)} />,
    // While closed, no card: the list draws.
    card: !open ? null : (
      <ActionCard open onOpenChange={setOpen} title={label}
        description={data.kind === 'start_run' ? fill('The {run} is queued and runs on its own; it shows in the list at once.')
          : data.kind === 'create_record' && data.area ? `A new record in ${data.area.label}, added to the list at once.` : undefined}>
        {data.kind === 'start_run' ? <StartRunForm tab={tab} kinds={data.kinds} onDone={done} />
          : data.kind === 'create_record' && data.area ? <CreateRecordForm area={data.area} onDone={done} /> : null}
      </ActionCard>
    )
  };
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
    <CardForm onSubmit={submit} submit={<Button type='submit' disabled={busy}><Icons.play /> {busy ? 'Starting…' : 'Start'}</Button>}>
      {kinds.length > 1 && (
        <div className='flex flex-col gap-1.5'>
          <Label htmlFor='action-kind'>Type</Label>
          <NativeSelect id='action-kind' className='w-full' value={kind.name} onChange={(e) => { setKindName(e.target.value); setValues({}); setEnvironment(''); }}>
            {kinds.map((k) => <NativeSelectOption key={k.name} value={k.name}>{k.label}</NativeSelectOption>)}
          </NativeSelect>
        </div>
      )}
      {kind.description && <p className='text-muted-foreground text-sm'>{kind.description}</p>}
      {kind.targets && kind.targets.length > 1 && (
        <div className='flex flex-col gap-1.5'>
          <Label htmlFor='action-target-area'>Runs over</Label>
          <NativeSelect id='action-target-area' className='w-full' value={area ?? ''} onChange={(e) => setTargetArea(e.target.value)}>
            {kind.targets.map((t) => <NativeSelectOption key={t.name} value={t.name}>{t.label}</NativeSelectOption>)}
          </NativeSelect>
        </div>
      )}
      {area && (
        <div className='flex flex-col gap-1.5'>
          <Label htmlFor='action-target'>{areaLabel}</Label>
          <NativeSelect id='action-target' className='w-full' value={target} onChange={(e) => setTarget(e.target.value)} disabled={!records}>
            {(records ?? []).map((r) => <NativeSelectOption key={r.key} value={r.key}>{r.title && r.title !== r.key ? `${r.title} (${r.key})` : r.key}</NativeSelectOption>)}
            <NativeSelectOption value=''>None</NativeSelectOption>
          </NativeSelect>
        </div>
      )}
      {kind.environments && (
        <div className='flex flex-col gap-1.5'>
          <Label htmlFor='action-env'>Environment</Label>
          {kind.environments.length ? (
            <NativeSelect id='action-env' className='w-full' value={environment} onChange={(e) => setEnvironment(e.target.value)}>
              <NativeSelectOption value=''>None</NativeSelectOption>
              {kind.environments.map((x) => <NativeSelectOption key={x} value={x}>{x}</NativeSelectOption>)}
            </NativeSelect>
          ) : <Input id='action-env' value={environment} onChange={(e) => setEnvironment(e.target.value)} placeholder='e.g. production' />}
        </div>
      )}
      <FieldsForm fields={kind.args} values={values} set={(n, v) => setValues((s) => ({ ...s, [n]: v }))} idPrefix='action-arg' />
    </CardForm>
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
    <CardForm onSubmit={submit} submit={<Button type='submit' disabled={busy || !key.trim()}><Icons.add /> {busy ? 'Adding…' : 'Add'}</Button>}>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='action-key'>Key<span className='text-destructive' aria-hidden> *</span></Label>
        <Input id='action-key' value={key} onChange={(e) => setKey(e.target.value)} required placeholder='a short id, unique in this list' />
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='action-title'>Title</Label>
        <Input id='action-title' value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <FieldsForm fields={area.fields} values={values} set={(n, v) => setValues((s) => ({ ...s, [n]: v }))} idPrefix='action-field' />
    </CardForm>
  );
}

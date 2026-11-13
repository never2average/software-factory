'use client';
// /app/schedules (mold_v0-035; src/schedule-routes.ts): the workspace's schedules. Each pack's default schedules are
// copied into the workspace; owners turn them off and on, change when they run (UTC) and over which records, and add
// their own. Everyone else in the workspace sees them, with the last time each ran. The list is the console's database
// table (mold_v0-176): a row opens the schedule beside it, where owners change when it runs or remove one they added.
// A schedules tab's primary action (mold_v0-208: pack.json tabs[].action new_schedule) opens the Add a schedule form in
// a full card in the list's place (mold_v0-217, ?new=1), its run kind preset; shown to the owners who may add one.
// mold_v0-298: when a schedule runs reads in plain words in the person's own time zone (./cron-words.ts) and is picked
// the same way (./when-picker.tsx, the cron text an Advanced choice); with no pack action, Add a schedule is the search
// row's primary button opening the form in the side panel (not a form below the list); Remove asks first.
import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { ConfirmDialog } from '@/features/admin/ui';
import { JOB_KINDS } from '@/config/build-facts.generated';
import { EmptyState } from '@/features/tabs/empty';
import { ActionCard, CardForm, LinkAction, ToolbarAction, actionLabel, useActionOpen } from '@/features/tabs/tab-action';
import { packTabs, type PackTabSpec } from '@/config/pack-nav.generated';
import { exportRowsItem } from '@/features/tabs/export';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Icons } from '@/components/icons';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { ErrorState, When, fail, useOrgLoad } from '@/features/portal/shared';
import { cronInWords, cronOf, cronWords, planOf, zoneName } from './cron-words';
import { WhenPicker } from './when-picker';
import { httpError } from '@/features/status/from-error';

interface Schedule {
  id: string; pack: string; name: string; label: string | null; job_kind: string; cron: string;
  assets: { area: string; keys: string[] | null } | null; environment: string | null; enabled: boolean; is_default: boolean; customized: boolean;
  next_at: string | null; last: { slot_at: string; fired_at: string | null; skipped: number; runs: string[]; error: string | null } | null;
}
interface Data { schedules: Schedule[]; kinds: { pack: string; name: string }[]; asset_areas: { pack: string; name: string; label: string }[]; timezone: string; can_manage: boolean }

async function call<T>(method: string, path = '', body?: unknown): Promise<T> {
  const res = await fetch(`/api/schedules${path}`, {
    method, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-pack-request': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 204) return null as T;
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, json);
  return json;
}

const keysOf = (text: string) => text.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean);
const assetWords = (s: Schedule) => (!s.assets ? 'the workspace' : s.assets.keys ? `${s.assets.area}: ${s.assets.keys.join(', ')}` : `every ${s.assets.area} record`);

export function SchedulesPage() {
  return (
    // A list (mold_v0-217): no title or description above it.
    <PageContainer>
      {/* A pack's own schedules tab opens this page (it is not an in-page tab): its primary action is drawn here. */}
      <SchedulesBody action={packTabs.find((t) => t.kind === 'schedules' && t.url === '/app/schedules' && t.action)?.action} />
    </PageContainer>
  );
}

const ADD_LABEL = 'Add a schedule';
const ADD_ABOUT = 'Pick what runs and when, in your own time zone. Optionally, which records it runs over: one run for each record.';

/** The page's body (mold_v0-175: also an in-page tab of a pack's sections tab, with its four cards: mold_v0-181). */
export function SchedulesBody({ summary, action }: { summary?: ReactNode; action?: PackTabSpec['action'] } = {}) {
  const { data, error, reload } = useOrgLoad(() => call<Data>('GET'));
  const cols = useMemo(() => (data ? columns(data, reload) : []), [data, reload]);
  // mold_v0-217: the Add a schedule form as a full card in the list's place, kept in the address (?new=1). mold_v0-298:
  // with no pack action, the same ?new=1 opens the form in the side panel beside the list.
  const [adding, setAdding] = useActionOpen('new');
  // The primary action (mold_v0-208; the search row's last control, mold_v0-217) for those who may add a schedule, when
  // there is a kind to schedule.
  const canAdd = !!data?.can_manage && data.kinds.length > 0;
  const packAdd = action?.kind === 'new_schedule';
  const ownAdd = canAdd && !packAdd && action?.kind !== 'link';
  const addLabel = packAdd ? actionLabel(action!) : ADD_LABEL;
  const toolbarAction = (packAdd || ownAdd) && canAdd
    ? <ToolbarAction label={addLabel} icon={<Icons.calendar />} onClick={() => setAdding(true)} />
    : action?.kind === 'link' ? <LinkAction action={action} /> : undefined;
  if (action?.kind === 'new_schedule' && canAdd && adding) return (
    <ActionCard open onOpenChange={setAdding} title={actionLabel(action)} description={ADD_ABOUT}>
      <AddScheduleForm data={data!} preset={action.job_kind} stacked onAdded={async () => { setAdding(false); await reload(); }} />
    </ActionCard>
  );
  return (
    <>
      {error ? <ErrorState error={error} /> : (
        <div className='flex flex-col gap-10'>
          {/* The console's database table (mold_v0-176, as on Accounts): a row opens the schedule beside the list. */}
          <RecordView<Schedule>
            id='app-schedules' compact noun='schedules' properties summary={summary} toolbarAction={toolbarAction}
            rows={data?.schedules ?? []} rowKey={(s) => s.id} cols={cols} loading={!data}
            searchText={(s) => `${s.label ?? ''} ${s.name} ${kindLabel(s)} ${cronWords(s.cron)} ${s.cron} ${assetWords(s)}`}
            searchPlaceholder='Search schedules'
            filters={data && <span className='text-muted-foreground text-xs'>{data.can_manage ? 'Open a schedule to change when it runs.' : 'An owner of this workspace changes these.'}</span>}
            exports={data?.schedules.length ? [exportRowsItem({ name: 'schedules', rows: data.schedules, cols: [...cols, { key: 'cron_utc', label: 'Cron (UTC)', value: (s: Schedule) => s.cron }] })] : undefined}
            empty={<div className='sticky left-0 max-w-[min(36rem,calc(100vw-5rem))] text-left sm:mx-auto'><EmptyState id='empty-schedules' empty={{
              title: 'No schedules yet.',
              text: canAdd && toolbarAction && (packAdd || ownAdd)
                ? `A schedule runs work for you at set times. Choose ${addLabel} to pick what runs, and when.`
                : data?.can_manage ? 'A schedule runs work for you at set times. There is nothing to schedule in this workspace yet.' : 'A schedule runs work for you at set times. An owner of this workspace adds them.',
              cta: null
            }} /></div>}
            detailTitle={(s) => s.label ?? s.name}
            detail={(s) => <ScheduleDetail key={s.id} s={s} canManage={!!data?.can_manage} onChanged={reload} />}
            sidePanel={ownAdd && adding && data ? {
              key: 'new-schedule', title: ADD_LABEL, onClose: () => setAdding(false),
              body: <AddScheduleForm data={data} onAdded={async () => { setAdding(false); await reload(); }} />
            } : null}
          />
        </div>
      )}
    </>
  );
}

const kindLabel = (s: Pick<Schedule, 'pack' | 'job_kind'>) => JOB_KINDS.find((k) => k.pack === s.pack && k.name === s.job_kind)?.label ?? s.job_kind;
/** The kinds a schedule may run, by their labels (mold_v0-298); two with the same label say their pack too. */
function kindOptions(kinds: Data['kinds']) {
  const labels = kinds.map((k) => kindLabel({ pack: k.pack, job_kind: k.name }));
  return kinds.map((k, i) => ({ value: `${k.pack}/${k.name}`, label: labels.filter((l) => l === labels[i]).length > 1 ? `${labels[i]} (${k.pack})` : labels[i]! }));
}
const patchOf = (s: Schedule, onChanged: () => unknown) => (body: Record<string, unknown>, done: string) =>
  call('PATCH', `/${s.id}`, body).then(() => { toast.success(done); return onChanged(); }).catch(fail);

function columns(data: Data, onChanged: () => unknown): RecordCol<Schedule>[] {
  const kinds = kindOptions(data.kinds);
  return [
    {
      key: 'schedule', label: 'Schedule', title: true, keep: true, type: 'text', className: 'min-w-48', value: (s) => s.label ?? s.name,
      render: (s) => (
        <span className='flex min-w-0 flex-col gap-1'>
          <span className='leading-snug font-medium'>{s.label ?? s.name}</span>
          <span className='text-muted-foreground text-xs leading-none'>{s.is_default ? (s.customized ? 'Default, changed here' : 'Default') : 'Added here'}</span>
        </span>
      )
    },
    { key: 'kind', label: 'Runs', type: 'select', options: kinds, value: (s) => `${s.pack}/${s.job_kind}`, render: (s) => kindLabel(s) },
    // mold_v0-298: in words, in the person's own time zone (the cron text, UTC, on hover).
    // The export names the viewer's time zone for these words and carries the exact cron text (UTC) in its own column.
    { key: 'cron', label: 'When', name: `When (${zoneName()})`, type: 'text', value: (s) => cronWords(s.cron), render: (s) => <span title={`In your time zone, ${zoneName()}. Cron: ${s.cron} (UTC)`}>{cronWords(s.cron)}</span> },
    { key: 'over', label: 'Over', type: 'text', value: (s) => assetWords(s), render: (s) => <>{assetWords(s)}{s.environment ? <span className='text-muted-foreground'> · {s.environment}</span> : null}</> },
    { key: 'next', label: 'Next', type: 'date', value: (s) => (s.enabled ? s.next_at : null), render: (s) => (s.enabled ? <When d={s.next_at} /> : <span className='text-muted-foreground'>off</span>) },
    {
      key: 'last', label: 'Last', type: 'date', value: (s) => s.last?.slot_at ?? null,
      render: (s) => (s.last ? (
        <span className='flex flex-col gap-1'>
          <span><When d={s.last.slot_at} /> · {s.last.runs.length} run{s.last.runs.length === 1 ? '' : 's'}</span>
          {s.last.error && <span className='text-destructive text-xs'>{s.last.error}</span>}
        </span>
      ) : <span className='text-muted-foreground'>not yet</span>)
    },
    {
      key: 'on', label: 'On', type: 'boolean', keep: true, value: (s) => s.enabled,
      render: (s) => (
        // The switch turns the schedule off or on where it is; it does not open the row.
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className='inline-flex'>
          <Switch checked={s.enabled} disabled={!data.can_manage} aria-label={`${s.label ?? s.name} on`}
            onCheckedChange={(on: boolean) => void patchOf(s, onChanged)({ enabled: on }, on ? 'Turned on' : 'Turned off')} />
        </span>
      )
    }
  ];
}

/**
 * A schedule beside the list: when it runs (owners change it here, in plain choices: mold_v0-298), what it last did,
 * and Remove for one added here, asked first.
 */
function ScheduleDetail({ s, canManage, onChanged }: { s: Schedule; canManage: boolean; onChanged: () => unknown }) {
  const [cron, setCron] = useState<string | null>(s.cron);
  const [removing, setRemoving] = useState(false);
  const patch = patchOf(s, onChanged);
  const remove = () => void call('DELETE', `/${s.id}`).then(() => { toast.success('Removed'); return onChanged(); }).catch(fail);
  return (
    <div className='flex flex-col gap-4'>
      {s.last && s.last.skipped > 0 && <dl><Field label='Missed'>{s.last.skipped} missed time{s.last.skipped === 1 ? '' : 's'} not run again</Field></dl>}
      {canManage ? (
        <form className='flex flex-col gap-3' onSubmit={(e) => { e.preventDefault(); if (cron) void patch({ cron }, 'Time changed'); }}>
          <h3 className='text-sm font-medium'>Change when it runs</h3>
          <WhenPicker cron={s.cron} onChange={setCron} idPrefix={`schedule-${s.id}`} />
          <div className='flex flex-wrap items-center gap-2'>
            <Button type='submit' size='sm' variant='outline' disabled={!cron || cron === s.cron}>Save</Button>
            {!s.is_default && <Button type='button' variant='ghost' size='sm' className='text-destructive hover:text-destructive ml-auto'
              onClick={() => setRemoving(true)}><Icons.trash /> Remove</Button>}
          </div>
        </form>
      ) : <p className='text-muted-foreground text-xs'>An owner of this workspace changes these.</p>}
      <ConfirmDialog open={removing} onOpenChange={setRemoving} destructive confirmLabel='Remove'
        title={`Remove ${s.label ?? s.name}?`}
        description={`${cronInWords(s.cron) ? `It stops running ${cronWords(s.cron).replace(/^[A-Z]/, (c) => c.toLowerCase())}.` : 'It stops running at its set times.'} Runs it already started are kept. This cannot be undone.`}
        onConfirm={remove} />
    </div>
  );
}

const keyOf = (k: { pack: string; name: string }) => `${k.pack}/${k.name}`;
/** A machine name for a new schedule from its plain name (mold_v0-298): lowercase letters, digits and _, not one in use. */
function nameOf(label: string, taken: Set<string>): string {
  let base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+$/, '').slice(0, 50);
  if (base.length < 2) base = 'schedule';
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  return name;
}

/**
 * The Add a schedule form: in the side panel (mold_v0-298), or the primary action's full card (mold_v0-208: `stacked`,
 * `preset` the kind chosen first). One labelled field a line, the kinds by their labels; the name is a plain name (the
 * machine name is made from it) and when it runs is picked in the person's own time zone.
 */
function AddScheduleForm({ data, onAdded, preset, stacked = false }: { data: Data; onAdded: () => unknown; preset?: string; stacked?: boolean }) {
  const first = data.kinds.find((k) => k.name === preset) ?? data.kinds[0]!;
  const [kind, setKind] = useState(keyOf(first));
  const [label, setLabel] = useState('');
  const [start] = useState(defaultCron);
  const [cron, setCron] = useState<string | null>(start);
  const [area, setArea] = useState('');
  const [keys, setKeys] = useState('');
  const [busy, setBusy] = useState(false);
  const [pack, jobKind] = kind.split('/') as [string, string];
  const areas = data.asset_areas.filter((a) => a.pack === pack);
  const ready = !busy && !!label.trim() && !!cron;
  const add = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const name = nameOf(label, new Set(data.schedules.map((s) => s.name)));
      await call('POST', '', { pack, job_kind: jobKind, name, label: label.trim(), cron, ...(area ? { assets: { area, ...(keys.trim() ? { keys: keysOf(keys) } : {}) } } : {}) });
      setLabel('');
      toast.success('Schedule added');
      await onAdded();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const row = (text: string, id: string, control: ReactNode) => <div className='flex flex-col gap-1.5'><Label htmlFor={id}>{text}</Label>{control}</div>;
  const fields = (<>
        {row('Runs', 'schedule-kind', <NativeSelect id='schedule-kind' className='w-full' value={kind} onChange={(e) => { setKind(e.target.value); setArea(''); }}>
          {kindOptions(data.kinds).map((k) => <NativeSelectOption key={k.value} value={k.value}>{k.label}</NativeSelectOption>)}
        </NativeSelect>)}
        {row('Name', 'schedule-name', <Input id='schedule-name' maxLength={80} placeholder='For example, Morning check' value={label} onChange={(e) => setLabel(e.target.value)} />)}
        <WhenPicker cron={start} onChange={setCron} idPrefix='schedule-when' />
        {areas.length > 0 && row('Records', 'schedule-area', (
          <NativeSelect id='schedule-area' className='w-full' value={area} onChange={(e) => setArea(e.target.value)}>
            <NativeSelectOption value=''>the workspace</NativeSelectOption>
            {areas.map((a) => <NativeSelectOption key={a.name} value={a.name}>{a.label}</NativeSelectOption>)}
          </NativeSelect>
        ))}
        {area && row('Record keys', 'schedule-keys', <Input id='schedule-keys' placeholder='Leave blank for every record' value={keys} onChange={(e) => setKeys(e.target.value)} />)}
  </>);
  // In the action's card (mold_v0-217): the fields, then Add and Cancel.
  if (stacked) return <CardForm onSubmit={add} submit={<Button type='submit' disabled={!ready}><Icons.calendar /> {busy ? 'Adding…' : 'Add'}</Button>}>{fields}</CardForm>;
  // In the side panel (mold_v0-298): what it does, the fields, then Add.
  return (
    <form className='flex flex-col gap-4' onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <p className='text-muted-foreground text-sm'>{ADD_ABOUT}</p>
      {fields}
      <div><Button type='submit' size='sm' disabled={!ready}><Icons.calendar /> {busy ? 'Adding…' : 'Add'}</Button></div>
    </form>
  );
}

/** A new schedule's first choice: every day at 9:00 in the person's own time zone. */
const defaultCron = () => cronOf({ ...planOf(''), every: 'day', time: '09:00' }) ?? '0 9 * * *';

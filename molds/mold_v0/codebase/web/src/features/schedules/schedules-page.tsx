'use client';
// /app/schedules (mold_v0-035; src/schedule-routes.ts): the workspace's schedules. Each pack's default schedules are
// copied into the workspace; owners turn them off and on, change when they run (UTC) and over which records, and add
// their own. Everyone else in the workspace sees them, with the last time each ran. The list is the console's database
// table (mold_v0-176): a row opens the schedule beside it, where owners change when it runs or remove one they added.
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Section } from '@/components/layout/section';
import { Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { JOB_KINDS } from '@/config/build-facts.generated';
import { EmptyState } from '@/features/tabs/empty';
import { ExportRowsButton } from '@/features/tabs/export';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { ErrorState, When, fail, useOrgLoad } from '@/features/portal/shared';
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
  const { data, error, reload } = useOrgLoad(() => call<Data>('GET'));
  const cols = useMemo(() => (data ? columns(data, reload) : []), [data, reload]);
  return (
    <PageContainer pageTitle='Schedules' pageDescription='When runs start by themselves. Times are cron expressions in UTC; a time missed while nothing was running runs once, not once per missed time.'>
      {error ? <ErrorState error={error} /> : (
        <div className='flex flex-col gap-10'>
          {/* The console's database table (mold_v0-176, as on Accounts): a row opens the schedule beside the list. */}
          <RecordView<Schedule>
            id='app-schedules' compact noun='schedules' properties
            rows={data?.schedules ?? []} rowKey={(s) => s.id} cols={cols} loading={!data}
            searchText={(s) => `${s.label ?? ''} ${s.name} ${kindLabel(s)} ${s.cron} ${assetWords(s)}`}
            searchPlaceholder='Search schedules'
            filters={data && <span className='text-muted-foreground text-xs'>{data.can_manage ? 'Open a schedule to change when it runs.' : 'An owner of this workspace changes these.'}</span>}
            primary={data?.schedules.length ? <ExportRowsButton name='schedules' rows={data.schedules} cols={cols} /> : undefined}
            empty={<div className='sticky left-0 max-w-[min(36rem,calc(100vw-5rem))] text-left sm:mx-auto'><EmptyState id='empty-schedules' empty={{
              title: 'No schedules yet.',
              text: data?.can_manage && data.kinds.length ? 'Add one below: pick what runs, and when (UTC).' : 'An owner of this workspace adds them.',
              cta: null
            }} /></div>}
            detailTitle={(s) => s.label ?? s.name}
            detail={(s) => <ScheduleDetail key={s.id} s={s} canManage={!!data?.can_manage} onChanged={reload} />}
          />
          {data?.can_manage && data.kinds.length > 0 && <AddSchedule data={data} onAdded={reload} />}
        </div>
      )}
    </PageContainer>
  );
}

const kindLabel = (s: Pick<Schedule, 'pack' | 'job_kind'>) => JOB_KINDS.find((k) => k.pack === s.pack && k.name === s.job_kind)?.label ?? s.job_kind;
const patchOf = (s: Schedule, onChanged: () => unknown) => (body: Record<string, unknown>, done: string) =>
  call('PATCH', `/${s.id}`, body).then(() => { toast.success(done); return onChanged(); }).catch(fail);

function columns(data: Data, onChanged: () => unknown): RecordCol<Schedule>[] {
  const kinds = data.kinds.map((k) => ({ value: `${k.pack}/${k.name}`, label: kindLabel({ pack: k.pack, job_kind: k.name }) }));
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
    { key: 'cron', label: 'When (UTC)', type: 'text', value: (s) => s.cron, render: (s) => <span className='font-mono text-xs'>{s.cron}</span> },
    { key: 'over', label: 'Over', type: 'text', value: (s) => assetWords(s), render: (s) => <>{assetWords(s)}{s.environment ? <Badge variant='secondary' className='ml-1'>{s.environment}</Badge> : null}</> },
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

/** A schedule beside the list: when it runs (owners change it here), what it last did, and Remove for one added here. */
function ScheduleDetail({ s, canManage, onChanged }: { s: Schedule; canManage: boolean; onChanged: () => unknown }) {
  const [cron, setCron] = useState(s.cron);
  const patch = patchOf(s, onChanged);
  return (
    <div className='flex flex-col gap-4'>
      <dl>
        {s.last && s.last.skipped > 0 && <Field label='Missed'>{s.last.skipped} missed time{s.last.skipped === 1 ? '' : 's'} not run again</Field>}
        <Field label='Name'><span className='font-mono text-xs'>{s.name}</span></Field>
      </dl>
      {canManage ? (
        <form className='flex flex-wrap items-end gap-2' onSubmit={(e) => { e.preventDefault(); void patch({ cron }, 'Time changed'); }}>
          <Input className='w-44 font-mono text-xs' value={cron} onChange={(e) => setCron(e.target.value)} aria-label={`When ${s.name} runs`} />
          <Button type='submit' size='sm' variant='outline' disabled={cron === s.cron}>Save</Button>
          {!s.is_default && <Button type='button' variant='ghost' size='sm' className='text-destructive hover:text-destructive ml-auto'
            onClick={() => void call('DELETE', `/${s.id}`).then(() => { toast.success('Removed'); return onChanged(); }).catch(fail)}>Remove</Button>}
        </form>
      ) : <p className='text-muted-foreground text-xs'>An owner of this workspace changes these.</p>}
    </div>
  );
}

function AddSchedule({ data, onAdded }: { data: Data; onAdded: () => unknown }) {
  const [kind, setKind] = useState(`${data.kinds[0]!.pack}/${data.kinds[0]!.name}`);
  const [name, setName] = useState('');
  const [cron, setCron] = useState('0 6 * * *');
  const [area, setArea] = useState('');
  const [keys, setKeys] = useState('');
  const [busy, setBusy] = useState(false);
  const [pack, jobKind] = kind.split('/') as [string, string];
  const areas = data.asset_areas.filter((a) => a.pack === pack);
  const add = async () => {
    setBusy(true);
    try {
      await call('POST', '', { pack, job_kind: jobKind, name, cron, ...(area ? { assets: { area, ...(keys.trim() ? { keys: keysOf(keys) } : {}) } } : {}) });
      setName('');
      toast.success('Schedule added');
      await onAdded();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <Section title='Add a schedule' description='A run kind, when it runs (minute hour day month weekday, UTC, at most every 5 minutes) and, optionally, which records it runs over: one run per record.'>
      <form className='flex flex-wrap items-end gap-2' onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <NativeSelect value={kind} onChange={(e) => { setKind(e.target.value); setArea(''); }} aria-label='Run kind'>
          {data.kinds.map((k) => <NativeSelectOption key={`${k.pack}/${k.name}`} value={`${k.pack}/${k.name}`}>{k.pack}/{k.name}</NativeSelectOption>)}
        </NativeSelect>
        <Input className='w-44' placeholder='name (e.g. nightly_check)' value={name} onChange={(e) => setName(e.target.value)} aria-label='Schedule name' />
        <Input className='w-36 font-mono text-xs' value={cron} onChange={(e) => setCron(e.target.value)} aria-label='When (cron, UTC)' />
        {areas.length > 0 && (
          <NativeSelect value={area} onChange={(e) => setArea(e.target.value)} aria-label='Records'>
            <NativeSelectOption value=''>the workspace</NativeSelectOption>
            {areas.map((a) => <NativeSelectOption key={a.name} value={a.name}>{a.label}</NativeSelectOption>)}
          </NativeSelect>
        )}
        {area && <Input className='w-56' placeholder='record keys (blank: every record)' value={keys} onChange={(e) => setKeys(e.target.value)} aria-label='Record keys' />}
        <Button type='submit' size='sm' disabled={busy || !name || !cron}>Add</Button>
      </form>
    </Section>
  );
}

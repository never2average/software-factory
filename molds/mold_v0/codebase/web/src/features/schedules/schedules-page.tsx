'use client';
// /app/schedules (mold_v0-035; src/schedule-routes.ts): the workspace's schedules. Each pack's default schedules are
// copied into the workspace; owners turn them off and on, change when they run (UTC) and over which records, and add
// their own. Everyone else in the workspace sees them, with the last time each ran.
import { useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Section } from '@/components/layout/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ErrorState, LoadingCards, When, fail, useOrgLoad } from '@/features/portal/shared';
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
  return (
    <PageContainer pageTitle='Schedules' pageDescription='When runs start by themselves. Times are cron expressions in UTC; a time missed while nothing was running runs once, not once per missed time.'>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={2} /> : (
        <div className='flex flex-col gap-10'>
          <Section title='Schedules' description={data.can_manage ? 'Turn a schedule off or on, or change when it runs.' : 'An owner of this workspace changes these.'}>
            {data.schedules.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Schedule</TableHead>
                    <TableHead>Runs</TableHead>
                    <TableHead>When (UTC)</TableHead>
                    <TableHead>Over</TableHead>
                    <TableHead>Next</TableHead>
                    <TableHead>Last</TableHead>
                    <TableHead>On</TableHead>
                    {data.can_manage && <TableHead />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.schedules.map((s) => <ScheduleRow key={s.id} s={s} canManage={data.can_manage} onChanged={reload} />)}
                </TableBody>
              </Table>
            ) : <p className='text-muted-foreground text-sm'>No schedules yet.</p>}
          </Section>
          {data.can_manage && data.kinds.length > 0 && <AddSchedule data={data} onAdded={reload} />}
        </div>
      )}
    </PageContainer>
  );
}

function ScheduleRow({ s, canManage, onChanged }: { s: Schedule; canManage: boolean; onChanged: () => unknown }) {
  const [cron, setCron] = useState(s.cron);
  const patch = (body: Record<string, unknown>, done: string) =>
    call('PATCH', `/${s.id}`, body).then(() => { toast.success(done); return onChanged(); }).catch(fail);
  return (
    <TableRow>
      <TableCell>
        <div className='font-medium'>{s.label ?? s.name}</div>
        <div className='text-muted-foreground text-xs'>{s.is_default ? (s.customized ? 'Default, changed here' : 'Default') : 'Added here'}</div>
      </TableCell>
      <TableCell className='font-mono text-xs'>{s.pack}/{s.job_kind}</TableCell>
      <TableCell>
        {canManage ? (
          <form className='flex gap-1' onSubmit={(e) => { e.preventDefault(); void patch({ cron }, 'Time changed'); }}>
            <Input className='w-36 font-mono text-xs' value={cron} onChange={(e) => setCron(e.target.value)} aria-label={`When ${s.name} runs`} />
            {cron !== s.cron && <Button type='submit' size='sm' variant='outline'>Save</Button>}
          </form>
        ) : <span className='font-mono text-xs'>{s.cron}</span>}
      </TableCell>
      <TableCell className='text-sm'>{assetWords(s)}{s.environment ? <Badge variant='secondary' className='ml-1'>{s.environment}</Badge> : null}</TableCell>
      <TableCell>{s.enabled ? <When d={s.next_at} /> : <span className='text-muted-foreground'>off</span>}</TableCell>
      <TableCell className='text-sm'>
        {s.last ? (
          <>
            <When d={s.last.slot_at} /> · {s.last.runs.length} run{s.last.runs.length === 1 ? '' : 's'}
            {s.last.skipped > 0 && <span className='text-muted-foreground'> · {s.last.skipped} missed time{s.last.skipped === 1 ? '' : 's'} not run again</span>}
            {s.last.error && <div className='text-destructive text-xs'>{s.last.error}</div>}
          </>
        ) : <span className='text-muted-foreground'>not yet</span>}
      </TableCell>
      <TableCell>
        <Switch checked={s.enabled} disabled={!canManage} aria-label={`${s.name} on`}
          onCheckedChange={(on: boolean) => void patch({ enabled: on }, on ? 'Turned on' : 'Turned off')} />
      </TableCell>
      {canManage && (
        <TableCell className='text-right'>
          {!s.is_default && <Button variant='ghost' size='sm' onClick={() => void call('DELETE', `/${s.id}`).then(() => { toast.success('Removed'); return onChanged(); }).catch(fail)}>Remove</Button>}
        </TableCell>
      )}
    </TableRow>
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

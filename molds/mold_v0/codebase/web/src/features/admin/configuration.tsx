'use client';
// Agent configuration (/admin/configuration): every global setting but capacity (src/settings.ts: the shell's and a host
// pack's, mold_v0-039), edited in place over GET /compute and PUT /compute/settings. Each setting shows the value in force
// and where it comes from: set here, the server's environment, or the built-in default.
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Icons } from '@/components/icons';
import { List } from './account-peek';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adminApi } from '@/lib/api-client';
import { counted } from '@/lib/display-format';
import { cn } from '@/lib/utils';
import { post, useAdmin, useAdminAction } from './lib';
import { Gate, useAdminRole } from './role';
import { ErrorBox, FormRow, LoadingCards, Mono, Notice, Section, When } from './ui';
import { ActionsMenu, Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { ageOf, dur, SectionLink, UrlTabs, useComputeParams, useNow } from './compute-common';
import { StatStrip } from '@/components/layout/section';
import { ComputeOrchestrators } from './compute-orchestrators';
import { ComputeFailures, type Failures } from './compute-failures';
import { AdminEmails } from './emails';
import { ComputeDecisions, type Tick } from './compute-decisions';

interface Setting {
  key: string; group: string; label: string; help: string; kind: 'text' | 'int' | 'number' | 'choice'; default: string | number;
  options?: string[]; min?: number; max?: number; value: string | number; source: 'set' | 'env' | 'default';
  env: string | null; updated_at: string | null; updated_by: string | null;
}
interface Compute { groups: { id: string; label: string }[]; settings: Setting[] }

/** Agent configuration: one row per setting (models, run sizes, research limits), edited in place. */
export function AdminConfiguration() {
  const { lock } = useAdminRole();
  const { data, error, isLoading } = useAdmin<Compute>('/compute');
  const save = useAdminAction((v: Record<string, string | null>) => adminApi<Compute>('PUT', '/compute/settings', { values: v }), { success: 'Setting saved' });
  const groupName = (id: string) => data?.groups.find((g) => g.id === id)?.label ?? id;
  // Every group but capacity (the Compute page's Limits table edits those): the shell's and a host pack's (mold_v0-039).
  const rows = (data?.settings ?? []).filter((x) => x.group !== 'capacity');
  const changed = rows.filter((x) => x.source === 'set');
  const [askReset, setAskReset] = useState(false);
  // Back to the environment's value where one is set, else the default (saving null clears the admin's value).
  const backTo = (x: Setting) => (x.env != null ? `the environment (${x.env})` : `the default (${x.default})`);
  const cols: RecordCol<Setting>[] = [
    { key: 'setting', label: 'Setting', keep: true, type: 'text', value: (x) => x.label,
      render: (x) => <span className='flex min-w-0 flex-col gap-1'><span className='leading-none font-medium'>{x.label}</span><span className='text-muted-foreground truncate text-xs' title={x.help}>{x.help}</span></span> },
    { key: 'group', label: 'Group', type: 'select', value: (x) => groupName(x.group), render: (x) => groupName(x.group) },
    { key: 'value', label: 'Value', className: 'w-80', keep: true, render: (x) => (
      <span className='flex items-center gap-1' onClick={(e) => e.stopPropagation()}>
        <Gate need='compute'><InlineValue key={String(x.value)} s={x} disabled={save.isPending} onSave={(v) => save.mutate({ [x.key]: v })} /></Gate>
        {x.source === 'set' && <Gate need='compute'><Button variant='ghost' size='xs' className='text-muted-foreground hover:text-foreground' disabled={save.isPending}
          title={`Back to ${backTo(x)}`} onClick={() => save.mutate({ [x.key]: null })}>Reset</Button></Gate>}
      </span>
    ) },
    { key: 'source', label: 'From', type: 'select', value: (x) => (x.source === 'set' ? 'Set here' : x.source === 'env' ? 'Environment' : 'Default'),
      render: (x) => (x.source === 'set' ? <span>Set here{x.updated_at && <span className='text-muted-foreground'> · <When d={x.updated_at} /></span>}</span> : <span className='text-muted-foreground'>{x.source === 'env' ? 'Environment' : 'Default'}</span>) },
    { key: 'key', label: 'Variable', type: 'text', value: (x) => x.key, render: (x) => <Mono>{x.key}</Mono> }
  ];
  return (
    <PageContainer>
      <ErrorBox error={error} />
      <RecordView id='agent-configuration' rows={rows} loading={isLoading} rowKey={(x) => x.key} cols={cols} noun='settings'
        searchText={(x) => `${x.label} ${x.key} ${x.help} ${groupName(x.group)}`} searchPlaceholder='Search settings'
        defaultSort={[{ key: 'group', dir: 'asc' }]} groupable
        actions={(x) => x.source === 'set' ? [lock({ label: `Reset to ${x.env != null ? 'environment' : 'default'}`, icon: <Icons.close />, onSelect: () => save.mutate({ [x.key]: null }) }, 'compute')] : []}
        primary={<span className='flex items-center gap-2'>
          <Gate need='compute'><Button variant='outline' disabled={!changed.length || save.isPending} onClick={() => setAskReset(true)}
            title={changed.length ? `${changed.length} setting${changed.length === 1 ? '' : 's'} changed here` : 'Every setting is at its default'}><Icons.refresh /> Reset to defaults</Button></Gate>
        </span>}
        exportName='agent-configuration' empty='No settings.' />
      <AlertDialog open={askReset} onOpenChange={setAskReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset {changed.length} setting{changed.length === 1 ? '' : 's'} to defaults?</AlertDialogTitle>
            <AlertDialogDescription>
              {changed.map((x) => x.label).join(', ')} go back to their defaults (or the environment's value where one is set). Every server picks this up within 30 s.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setAskReset(false); save.mutate(Object.fromEntries(changed.map((x) => [x.key, null]))); }}>Reset to defaults</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}

/** One setting's value, edited in its row: saves on Enter or when you leave the field, if it changed. */
function InlineValue({ s, onSave, disabled }: { s: Setting; onSave: (v: string) => void; disabled?: boolean }) {
  const [v, setV] = useState(String(s.value));
  const commit = (x: string) => { if (x.trim() !== '' && x !== String(s.value)) onSave(x); };
  return s.kind === 'choice' ? (
    <NativeSelect aria-label={s.label} value={v} disabled={disabled} onChange={(e) => { setV(e.target.value); commit(e.target.value); }} className='w-48'>
      {s.options!.map((o) => <NativeSelectOption key={o} value={o}>{o}</NativeSelectOption>)}
    </NativeSelect>
  ) : (
    <Input aria-label={s.label} value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} onBlur={() => commit(v)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className={cn('h-8', s.kind === 'text' ? 'w-64 font-mono text-sm' : 'w-28 tabular-nums')} type={s.kind === 'text' ? 'text' : 'number'} min={s.min} max={s.max} step={s.kind === 'number' ? 'any' : 1} />
  );
}


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
import { PageFrame } from '@/components/layout/page-container';
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
import { ErrorBox, FormRow, LoadingCards, Notice, Section, When } from './ui';
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

/**
 * Agent configuration: one row per setting (models, run sizes, research limits), edited in place. bare (mold_v0-284): the
 * body alone, as Agent configuration's Configuration tab draws it below its strip.
 */
export function AdminConfiguration({ bare = false }: { bare?: boolean } = {}) {
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
      // The help wraps (mold_v0-169): cut to one line it set the column's width to the longest help, which pushed Value,
      // From and Variable off the page's right edge at 1440 px.
      render: (x) => <span className='flex min-w-56 flex-col gap-1'><span className='leading-none font-medium'>{x.label}</span><span className='text-muted-foreground text-xs whitespace-normal'>{x.help}</span></span> },
    { key: 'group', label: 'Group', type: 'select', value: (x) => groupName(x.group), render: (x) => groupName(x.group) },
    { key: 'value', label: 'Value', className: 'max-w-80', keep: true, value: (x) => String(x.value), render: (x) => <span className='block truncate tabular-nums'>{String(x.value)}</span> },
    { key: 'source', label: 'From', type: 'select', value: (x) => (x.source === 'set' ? 'Set here' : x.source === 'env' ? 'Environment' : 'Default'),
      render: (x) => (x.source === 'set' ? <span>Set here{x.updated_at && <span className='text-muted-foreground'> · <When d={x.updated_at} /></span>}</span> : <span className='text-muted-foreground'>{x.source === 'env' ? 'Server setting' : 'Default'}</span>) },
  ];
  return (
    <PageFrame bare={bare}>
      <ErrorBox error={error} />
      <RecordView id='agent-configuration' rows={rows} loading={isLoading} rowKey={(x) => x.key} cols={cols} noun='settings'
        searchText={(x) => `${x.label} ${x.key} ${x.help} ${groupName(x.group)}`} searchPlaceholder='Search settings'
        defaultSort={[{ key: 'group', dir: 'asc' }]} groupable panelKind='editor' detailTitle={(x) => x.label}
        // mold_v0-289: a row opens the setting in the side panel, never edited in the table's cells.
        detail={(x) => <SettingEditor key={x.key} s={x} disabled={save.isPending} backTo={backTo(x)} onSave={(v) => save.mutate({ [x.key]: v })} onReset={() => save.mutate({ [x.key]: null })} />}
        actions={(x) => x.source === 'set' ? [lock({ label: `Reset to ${x.env != null ? 'environment' : 'default'}`, icon: <Icons.close />, onSelect: () => save.mutate({ [x.key]: null }) }, 'compute')] : []}
        primaryMenu={changed.length ? [lock({ label: `Reset ${changed.length} changed to defaults`, icon: <Icons.refresh />, onSelect: () => setAskReset(true) }, 'compute')] : undefined}
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
    </PageFrame>
  );
}

/** A setting in its side panel: what it does, its value, Save and (when set here) Reset. */
function SettingEditor({ s, disabled, backTo, onSave, onReset }: { s: Setting; disabled?: boolean; backTo: string; onSave: (v: string) => void; onReset: () => void }) {
  const [v, setV] = useState(String(s.value));
  return (
    <div className='flex flex-col gap-4 text-sm' data-setting-editor=''>
      <p className='text-muted-foreground'>{s.help}</p>
      <Gate need='compute'><InlineValue key={String(s.value)} s={s} disabled={disabled} onSave={onSave} onDraft={setV} /></Gate>
      <div className='flex flex-wrap gap-2'>
        <Gate need='compute'><Button size='sm' disabled={disabled || v === String(s.value) || !v.trim()} onClick={() => onSave(v)}>Save</Button></Gate>
        {s.source === 'set' && <Gate need='compute'><Button size='sm' variant='outline' disabled={disabled} title={`Back to ${backTo}`} onClick={onReset}>Reset</Button></Gate>}
      </div>
    </div>
  );
}

/** One setting's value: saves on Enter or when you leave the field, if it changed. */
function InlineValue({ s, onSave, disabled, onDraft }: { s: Setting; onSave: (v: string) => void; disabled?: boolean; onDraft?: (v: string) => void }) {
  const [v, setValue] = useState(String(s.value));
  const setV = (x: string) => { setValue(x); onDraft?.(x); };
  const commit = (x: string) => { if (x.trim() !== '' && x !== String(s.value)) onSave(x); };
  return s.kind === 'choice' ? (
    <NativeSelect aria-label={s.label} value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} className='w-full max-w-sm'>
      {s.options!.map((o) => <NativeSelectOption key={o} value={o}>{o}</NativeSelectOption>)}
    </NativeSelect>
  ) : (
    <Input aria-label={s.label} value={v} disabled={disabled} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commit(v); }}
      className={cn('h-8', s.kind === 'text' ? 'w-full max-w-sm' : 'w-28 tabular-nums')} type={s.kind === 'text' ? 'text' : 'number'} min={s.min} max={s.max} step={s.kind === 'number' ? 'any' : 1} />
  );
}


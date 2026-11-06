'use client';
// Per-record visibility on screen (mold_v0-259, flag teams; the server's src/visibility.ts): an area that declares
// `visibility` gives each record its own (open to the workspace, shared with one team, or private to its owner, with
// collaborators where the area allows them). Here: the words and badge for it, the field the create and edit forms
// carry, the list's Visibility column (filtered by the Filter menu, or ?visibility= in the address), and Share on the
// record's page. Every rule is the server's: this only shows what it answered and sends what the person picked.
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Icons } from '@/components/icons';
import { featureOn } from '@/config/features';
import type { RecordAreaSpec } from '@/config/pack-nav.generated';
import type { RecordCol } from '@/components/layout/record-view';
import type { FilterRule } from '@/components/layout/record-filters';
import { httpError } from '@/features/status/from-error';
import { useOrgLoad } from '@/features/portal/shared';
import { cn } from '@/lib/utils';

export type VisibilityMode = 'workspace' | 'team' | 'private';
/** What a read shows of a record's visibility (src/pack-api.ts RecordVisibility). */
export interface RecordVisibility { mode: VisibilityMode; team: { id: number; name: string } | null; owner: string | null; collaborators: string[] }
/** What a write sends (src/pack-api.ts VisibilityInput). */
export interface VisibilityInput { mode: VisibilityMode; team?: number | null; collaborators?: string[] }
/** An area's declaration, as the generated registry carries it while the flag is on. */
export interface VisibilityDecl { modes: VisibilityMode[]; default: VisibilityMode; collaborators?: boolean }
export interface TeamSummary { id: number; name: string; description: string | null; members: number; leads: string[]; created_at: string; updated_at: string }
export interface Person { user_id: string; name: string | null; email: string | null; account_role?: string }
export interface TeamsData { teams: TeamSummary[]; mine: { id: number; name: string; role: 'member' | 'lead' }[]; people: Person[]; me: string | null; can_manage: boolean }

/** The area's visibility, while the flag is on and it declares one. */
export const visibilityOf = (area: Pick<RecordAreaSpec, 'name'> | null | undefined): VisibilityDecl | null =>
  (featureOn('teams') && area ? ((area as { visibility?: VisibilityDecl }).visibility ?? null) : null);

export const MODE_WORDS: Record<VisibilityMode, string> = { workspace: 'Everyone in the workspace', team: 'One team', private: 'Only its owner' };
/** A record's visibility in a few words: "Workspace", "Team: Design", "Private". */
export const visibilityWords = (v: RecordVisibility | null | undefined) =>
  !v || v.mode === 'workspace' ? 'Workspace' : v.mode === 'team' ? `Team: ${v.team?.name ?? 'removed'}` : 'Private';
export const personWords = (p: Person | undefined, id: string, me?: string | null) => (id === me ? 'You' : p?.name || p?.email || 'A person of this workspace');


/** The visibility as a small badge (the record page's header, an open row). */
export function VisibilityBadge({ v, className }: { v: RecordVisibility | null | undefined; className?: string }) {
  const mode = v?.mode ?? 'workspace';
  const Icon = mode === 'private' ? Icons.lock : mode === 'team' ? Icons.teams : Icons.building;
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium', mode === 'private' ? 'border-amber-500/40 text-amber-700 dark:text-amber-300' : mode === 'team' ? 'border-sky-500/40 text-sky-700 dark:text-sky-300' : 'text-muted-foreground', className)}
      data-visibility={mode}>
      <Icon aria-hidden className='size-3.5' /><span className='sr-only'>Seen by: </span>{visibilityWords(v)}
    </span>
  );
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, body);
  return body;
}
export async function sendJson<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-pack-request': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, json);
  return json;
}

/** The workspace's teams, the person's own and its people (/api/teams), while the flag is on. */
export function useTeams(on = true) {
  return useOrgLoad(() => (on && featureOn('teams') ? getJson<TeamsData>('/api/teams') : Promise.resolve(null)), [on]);
}

/** A new record's visibility, from the area's default: its team, the person's only one. */
export function defaultVisibility(decl: VisibilityDecl, teams: TeamsData | null): VisibilityInput {
  const mine = teams?.mine ?? [];
  return decl.default === 'team' ? { mode: 'team', team: mine.length === 1 ? mine[0]!.id : null } : { mode: decl.default };
}
const asInput = (v: RecordVisibility): VisibilityInput => ({ mode: v.mode, team: v.team?.id ?? null, collaborators: v.collaborators });
const sameInput = (a: VisibilityInput, b: VisibilityInput) =>
  a.mode === b.mode && (a.mode !== 'team' || (a.team ?? null) === (b.team ?? null)) && JSON.stringify([...(a.collaborators ?? [])].sort()) === JSON.stringify([...(b.collaborators ?? [])].sort());

/**
 * The visibility field of a form: who sees the record (the area's modes), its team (the person's teams; an owner of the
 * workspace: every team) and its collaborators (the workspace's people) where the area names them.
 */
export function VisibilityField({ decl, value, set, teams, idPrefix, owner }: {
  decl: VisibilityDecl; value: VisibilityInput; set: (v: VisibilityInput) => void; teams: TeamsData | null; idPrefix: string;
  /** The record's owner (left out of the collaborators' choices). */
  owner?: string | null;
}) {
  const [q, setQ] = useState('');
  const choosable = teams ? (teams.can_manage ? teams.teams.map((t) => ({ id: t.id, name: t.name })) : teams.mine) : [];
  const people = (teams?.people ?? []).filter((p) => p.user_id !== (owner ?? teams?.me));
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = people.filter((p) => words.every((w) => `${p.name ?? ''} ${p.email ?? ''}`.toLowerCase().includes(w)));
  const chosen = new Set(value.collaborators ?? []);
  return (
    <fieldset className='flex flex-col gap-3 rounded-lg border p-3' data-visibility-field=''>
      <legend className='px-1 text-sm font-medium'>Who sees it</legend>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor={`${idPrefix}-mode`} className='sr-only'>Who sees it</Label>
        <div role='radiogroup' aria-label='Who sees it' className='flex flex-col gap-2 sm:flex-row sm:flex-wrap'>
          {decl.modes.map((m) => (
            <label key={m} className={cn('flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm', value.mode === m && 'border-primary bg-primary/5')}>
              <input type='radio' name={`${idPrefix}-mode`} id={m === decl.modes[0] ? `${idPrefix}-mode` : undefined} value={m} checked={value.mode === m}
                onChange={() => set({ ...value, mode: m, team: m === 'team' ? value.team ?? (choosable.length === 1 ? choosable[0]!.id : null) : null })} className='mt-0.5 accent-current' />
              <span className='flex flex-col'>
                <span className='font-medium'>{m === 'workspace' ? 'Workspace' : m === 'team' ? 'Team' : 'Private'}</span>
                <span className='text-muted-foreground text-xs'>{MODE_WORDS[m]}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      {value.mode === 'team' && (
        <div className='flex flex-col gap-1.5'>
          <Label htmlFor={`${idPrefix}-team`}>Team<span className='text-destructive' aria-hidden> *</span></Label>
          {choosable.length ? (
            <NativeSelect id={`${idPrefix}-team`} className='w-full sm:w-72' value={value.team == null ? '' : String(value.team)} onChange={(e) => set({ ...value, team: e.target.value ? Number(e.target.value) : null })}>
              <NativeSelectOption value=''>Choose a team</NativeSelectOption>
              {choosable.map((t) => <NativeSelectOption key={t.id} value={String(t.id)}>{t.name}</NativeSelectOption>)}
            </NativeSelect>
          ) : <p className='text-muted-foreground text-xs'>You are in no team yet: ask an owner of the workspace to add you to one, or choose another option.</p>}
        </div>
      )}
      {decl.collaborators && (
        <div className='flex flex-col gap-1.5' data-collaborators-field=''>
          <Label htmlFor={`${idPrefix}-people`}>Collaborators</Label>
          <p className='text-muted-foreground text-xs'>Each sees it whatever the option above.{chosen.size ? ` ${chosen.size} chosen.` : ''}</p>
          {people.length > 6 && <Input id={`${idPrefix}-people`} value={q} onChange={(e) => setQ(e.target.value)} placeholder='Search people' className='sm:w-72' />}
          <ul className='flex max-h-44 flex-col gap-1 overflow-y-auto' aria-label='Collaborators'>
            {shown.map((p) => (
              <li key={p.user_id}>
                <label className='flex cursor-pointer items-center gap-2 text-sm'>
                  <Checkbox id={people.length > 6 ? undefined : p === shown[0] ? `${idPrefix}-people` : undefined} checked={chosen.has(p.user_id)}
                    onCheckedChange={(c) => set({ ...value, collaborators: c ? [...chosen, p.user_id] : [...chosen].filter((x) => x !== p.user_id) })} />
                  <span className='min-w-0 truncate'>{p.name || p.email || p.user_id}{p.name && p.email ? <span className='text-muted-foreground'> · {p.email}</span> : null}</span>
                </label>
              </li>
            ))}
            {!shown.length && <li className='text-muted-foreground text-xs'>{people.length ? 'Nobody matches.' : 'Nobody else is in this workspace yet.'}</li>}
          </ul>
        </div>
      )}
    </fieldset>
  );
}

/** A form's visibility state: the field, and what the form sends (on an edit, only a change). */
export function useVisibilityInput(area: Pick<RecordAreaSpec, 'name'> | null, current?: RecordVisibility | null) {
  const decl = visibilityOf(area);
  const teams = useTeams(!!decl);
  const [value, setValue] = useState<VisibilityInput | null>(current ? asInput(current) : null);
  useEffect(() => { if (decl && !value && !current && teams.data) setValue(defaultVisibility(decl, teams.data)); }, [decl, value, current, teams.data]);
  const v = value ?? (decl ? (current ? asInput(current) : defaultVisibility(decl, teams.data)) : null);
  const changed = !!v && (!current || !sameInput(v, asInput(current)));
  return {
    decl, teams: teams.data,
    /** What the request carries: a new record's visibility, or an existing one's only when it changed. */
    body: decl && v && changed ? { visibility: { mode: v.mode, ...(v.mode === 'team' ? { team: v.team ?? null } : {}), ...(decl.collaborators ? { collaborators: v.collaborators ?? [] } : {}) } } : {},
    problem: decl && v?.mode === 'team' && v.team == null ? 'Choose the team that sees it' : null,
    field: decl && v ? (idPrefix: string, owner?: string | null) => <VisibilityField decl={decl} value={v} set={setValue} teams={teams.data} idPrefix={idPrefix} owner={owner} /> : null,
  };
}

/** The list's Visibility column, filtered in the Filter menu ("Visibility is Private") or by ?visibility=. */
export function visibilityColumn<T extends { visibility?: RecordVisibility }>(rows: readonly T[]): RecordCol<T> {
  const values = [...new Set(['Workspace', ...rows.map((r) => visibilityWords(r.visibility)), 'Private'])];
  return {
    key: 'visibility', label: 'Seen by', type: 'select', options: values.map((v) => ({ value: v })),
    value: (r) => visibilityWords(r.visibility), render: (r) => <VisibilityBadge v={r.visibility} />
  };
}
/** The address's ?visibility= as a rule of the Filter menu: workspace, private, or team:<name>. */
export function visibilityRule(param: string | null): FilterRule | null {
  if (!param) return null;
  const value = param === 'workspace' ? 'Workspace' : param === 'private' ? 'Private' : param.startsWith('team:') ? `Team: ${param.slice(5)}` : null;
  return value ? { id: 'visibility', key: 'visibility', op: 'is', value } : null;
}

/**
 * Share (the record page's header): who sees the record, changed by its owner, a lead of its team or an owner of the
 * workspace (the server says whether this person may: `canShare`). A dialog: the visibility field, then Save.
 */
export function ShareButton({ area, recordKey, visibility, canShare, onShared }: {
  area: RecordAreaSpec; recordKey: string; visibility: RecordVisibility; canShare: boolean; onShared: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!canShare) return null;
  return (
    <>
      <Button type='button' variant='outline' size='sm' data-share-action='' onClick={() => setOpen(true)}>
        <Icons.share aria-hidden data-icon='inline-start' />Share
      </Button>
      {open && <ShareDialog area={area} recordKey={recordKey} visibility={visibility} onClose={() => setOpen(false)} onShared={() => { setOpen(false); onShared(); }} />}
    </>
  );
}

function ShareDialog({ area, recordKey, visibility, onClose, onShared }: { area: RecordAreaSpec; recordKey: string; visibility: RecordVisibility; onClose: () => void; onShared: () => void }) {
  const vis = useVisibilityInput(area, visibility);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (vis.problem) return void toast.error(vis.problem);
    const body = vis.body as { visibility?: VisibilityInput };
    if (!body.visibility) return onClose();
    setBusy(true);
    try {
      await sendJson('POST', `/api/data/${encodeURIComponent(area.name)}/${encodeURIComponent(recordKey)}/visibility`, body);
      toast.success('Shared');
      onShared();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const keepTabInside = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((x) => x.getClientRects().length > 0);
    if (!items.length) return;
    const first = items[0]!, last = items[items.length - 1]!, at = document.activeElement;
    if (e.shiftKey ? at === first || !e.currentTarget.contains(at) : at === last) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  };
  const owner = useMemo(() => visibility.owner, [visibility.owner]);
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg' data-share-dialog='' onKeyDown={keepTabInside}>
        <form className='grid gap-4' onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <DialogHeader>
            <DialogTitle>Share this {area.label.toLowerCase().replace(/s$/, '')}</DialogTitle>
            <DialogDescription>Who sees it. The workspace&apos;s owners always see every record{owner ? ', and so does its owner' : ''}.</DialogDescription>
          </DialogHeader>
          {vis.field ? vis.field('share', owner) : <p className='text-muted-foreground text-sm'>Loading…</p>}
          <DialogFooter>
            <Button type='button' variant='outline' disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type='submit' disabled={busy || !!vis.problem}>{busy ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

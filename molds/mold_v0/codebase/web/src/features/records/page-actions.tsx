'use client';
// A record page's actions (mold_v0-254, flag record_pages; the area's `detail.actions`, offered by the server for this
// person and this record: src/record-page-routes.ts). In the header: the primary action (the brand's filled button), up
// to three secondary ones (outlined), and a More menu (outlined) with the rest, then Copy ID and Copy link. A related
// list's rows carry their own area's actions in a row menu. Every button is the shared Button (each variant outlined:
// mold_v0-251).
//   start_run  its form, a full card in the page's place (?act=<id>), the kind's arguments pre-filled from the record
//   move       a menu of the states it may move to; one it may not move to now stays listed, disabled, with why
//              (mold_v0-300: only one open now: a button named by that move)
//   edit       the record's edit form, a full card in the page's place (?act=<id>)
//   delete     the confirm question (the console's ConfirmDialog), then the record's list
//   link       the record its field names; copy_link the page's address, with a toast
//   start_agent (mold_v0-261, flag agent_harness) starts a workspace agent session with its profile, the first message
//              filled from the record by the server, then opens the session on the agent's page
// A disabled action stays in its place, its reason shown on hover and on focus (a tooltip on a button, a line under the
// item in a menu) and read with it by a screen reader. The server refuses what it refuses here, whatever is sent.
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/features/admin/ui';
import { fail } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { ActionCard, CardForm, CreateRecordForm, FieldsForm, fieldValues, type FormField } from '@/features/tabs/tab-action';
import { cn } from '@/lib/utils';
import { createHref, placed, type PageAction } from './detail-layout';
import type { RecordRow } from './record-pages';
import { EditRecordForm } from './staff-records';

/** Take a page action on a record (POST /api/records/_page/<area>/<key>/actions/<id>). */
export async function takeAction<T = unknown>(area: string, key: string, id: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`/api/records/_page/${encodeURIComponent(area)}/${encodeURIComponent(key)}/actions/${encodeURIComponent(id)}`, {
    method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json', 'x-pack-request': '1' }, body: JSON.stringify(body)
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, json);
  return json;
}

const ICON: Record<PageAction['kind'], ReactNode> = {
  start_run: <Icons.play aria-hidden data-icon='inline-start' />, move: <Icons.arrowRight aria-hidden data-icon='inline-start' />, edit: <Icons.edit aria-hidden data-icon='inline-start' />,
  delete: <Icons.trash aria-hidden data-icon='inline-start' />, link: <Icons.externalLink aria-hidden data-icon='inline-start' />, copy_link: <Icons.link aria-hidden data-icon='inline-start' />,
  create_record: <Icons.add aria-hidden data-icon='inline-start' />, start_agent: <Icons.agent aria-hidden data-icon='inline-start' />,
  open_url: <Icons.externalLink aria-hidden data-icon='inline-start' />
};

/** Whether an action's form is a create or an edit (it opens in the side panel: mold_v0-256, flag side_panel_forms). */
export const panelForm = (a: PageAction | null) => !!a && (a.kind === 'edit' || a.kind === 'create_record');

/** A form's value as its input holds it: a list joined, the rest as text (fieldValues types it back). */
const asInput = (v: unknown) => (v == null ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? v : String(v));

/**
 * What a record page's actions need from it: the record, its area, how to copy (part 1's copyWithToast) and what to do
 * once one changed the record (read it again) or deleted it (back to the list).
 */
export interface ActionHost {
  area: string; areaLabel: string; base: 'app' | 'admin'; record: RecordRow;
  copy: (text: string, done: string) => void;
  changed: () => void;
  /** After a delete (default: the record's list; a related list's row: read the list again). */
  deleted?: () => void;
  /** mold_v0-259 (flag teams): this person may change who sees it: the edit form carries the visibility field. */
  canShare?: boolean;
}

/** The state the header's actions share: the open confirm, the open card (?act=<id>), what is running. */
export function usePageActions(host: ActionHost, actions: readonly PageAction[]) {
  const router = useRouter();
  const [act, setAct] = useQueryState('act');
  const [confirming, setConfirming] = useState<{ a: PageAction; to?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const open = (a: PageAction) => void setAct(a.id, { history: 'push' });
  const close = () => {
    void setAct(null, { history: 'replace' });
    setTimeout(() => document.querySelector<HTMLElement>('[data-page-action][data-primary]')?.focus(), 50);
  };
  const run = async (a: PageAction, to?: string) => {
    setBusy(a.id);
    try {
      if (a.kind === 'delete') {
        await takeAction(host.area, host.record.key, a.id);
        toast.success(`${host.record.title || host.record.key} deleted`);
        if (host.deleted) host.deleted();
        else router.push(`/${host.base}/records/${host.area}`);
        return;
      }
      if (a.kind === 'start_agent') {
        // The server fills the first message from the record and links the session to it; the session opens at once.
        const r = await takeAction<{ session: { id: string } }>(host.area, host.record.key, a.id);
        toast.success(`${a.agent?.name ?? a.label} started`);
        router.push(`/app/agent?session=${encodeURIComponent(r.session.id)}`);
        return;
      }
      if (a.kind === 'move') {
        await takeAction(host.area, host.record.key, a.id, { to });
        toast.success(`Moved to ${a.moves?.find((m) => m.to === to)?.label.replace(/^Move to /, '') ?? to}`);
      }
      host.changed();
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  /** Take an action as its kind says: a card, a question, a copy, or at once. */
  const take = (a: PageAction, to?: string) => {
    if (a.disabled) return;
    if (a.kind === 'start_run' || a.kind === 'edit' || a.kind === 'create_record') return open(a);
    if (a.kind === 'copy_link') return host.copy(window.location.href.replace(/([?&])act=[^&]*&?/, '$1').replace(/[?&]$/, ''), 'Link copied');
    if (a.kind === 'link') return a.target && router.push(`/${host.base}/records/${a.target.area}/${encodeURIComponent(a.target.key)}`);
    // mold_v0-262: a web address from the record, in a new tab (never this one: the record stays open).
    if (a.kind === 'open_url') return void (a.url && window.open(a.url, '_blank', 'noopener,noreferrer'));
    if (a.kind === 'delete' || a.confirm) return setConfirming({ a, to });
    void run(a, to);
  };
  const opened = act ? actions.find((a) => a.id === act && (a.kind === 'start_run' || a.kind === 'edit' || (a.kind === 'create_record' && !!a.create?.fields)) && !a.disabled) ?? null : null;
  const card = opened ? <ActionFormCard host={host} a={opened} onClose={close} /> : null;
  const panel = panelForm(opened);
  const dialog = confirming && (
    <ConfirmDialog open onOpenChange={(o) => { if (!o) setConfirming(null); }} destructive={confirming.a.kind === 'delete'}
      title={confirming.a.kind === 'delete' ? `Delete ${host.record.title || host.record.key}?` : `${confirming.a.label}?`}
      description={confirming.a.confirm ?? ''} confirmLabel={confirming.a.kind === 'delete' ? 'Delete' : confirming.a.label}
      onConfirm={() => void run(confirming.a, confirming.to)} />
  );
  return { take, busy, card, dialog, panel };
}

/** A disabled action's reason, read with it: the tooltip's words, also in the accessible description. */
function Why({ id, reason }: { id: string; reason: string }) {
  return <span id={id} className='sr-only'>{reason}</span>;
}

/** One header button (the primary, a secondary): disabled ones keep focus and show why on hover and focus. */
function ActionButton({ a, primary, busy, take }: { a: PageAction; primary?: boolean; busy: boolean; take: (a: PageAction, to?: string) => void }) {
  const why = `why-${a.id}`;
  if (a.kind === 'move' && !a.disabled) return <MoveButton a={a} primary={primary} take={take} />;
  const button = (
    <Button type='button' variant={primary ? 'default' : 'outline'} size='sm' data-page-action={a.id} {...(primary ? { 'data-primary': '' } : {})}
      aria-disabled={a.disabled || busy ? true : undefined} aria-describedby={a.disabled ? why : undefined}
      className={cn(a.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent', a.disabled && primary && 'hover:bg-primary')}
      onClick={() => { if (!a.disabled && !busy) take(a); }}>
      {ICON[a.kind]}{a.label}
    </Button>
  );
  if (!a.disabled) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent className='max-w-72 text-pretty' data-action-why={a.id}>{a.disabled}</TooltipContent>
      <Why id={why} reason={a.disabled} />
    </Tooltip>
  );
}

/** A move as a button: a menu of the states it may move to (one it may not move to now: disabled, with why). */
function MoveButton({ a, primary, take }: { a: PageAction; primary?: boolean; take: (a: PageAction, to?: string) => void }) {
  // mold_v0-300: one state it may move to now: a button named by that move ("Suspend"), never a menu of one choice.
  const one = singleMove(a);
  if (one) return (
    <Button type='button' variant={primary ? 'default' : 'outline'} size='sm' data-page-action={a.id} data-move-to={one.to} {...(primary ? { 'data-primary': '' } : {})} onClick={() => take(a, one.to)}>
      {ICON.move}{one.label}
    </Button>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type='button' variant={primary ? 'default' : 'outline'} size='sm' data-page-action={a.id} />}>
        {ICON.move}{a.label}<Icons.chevronDown aria-hidden data-icon='inline-end' />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-64'><MoveItems a={a} take={take} /></DropdownMenuContent>
    </DropdownMenu>
  );
}

/** mold_v0-300: the one move an action may make now (the others disabled or none), else null. */
export const singleMove = (a: Pick<PageAction, 'moves'>) => {
  const open = (a.moves ?? []).filter((m) => !m.disabled);
  return open.length === 1 ? open[0]! : null;
};

/** A disabled item stays at full strength (its label muted), so its reason reads as clearly as any text in the menu. */
const DISABLED_ITEM = 'data-disabled:opacity-100';
/** A disabled menu item's reason, on its own line under its label (a menu item has no hover of its own on a phone). */
function ItemWhy({ reason }: { reason: string }) {
  return <span className='text-muted-foreground block text-xs leading-snug font-normal whitespace-normal' data-item-why=''>{reason}</span>;
}
function MoveItems({ a, take }: { a: PageAction; take: (a: PageAction, to?: string) => void }) {
  return (<>
    {(a.moves ?? []).map((m) => (
      <DropdownMenuItem key={m.to} disabled={!!m.disabled} title={m.disabled ?? undefined} onClick={() => take(a, m.to)} data-move-to={m.to} className={cn('items-start', DISABLED_ITEM)}>
        <span className='flex min-w-0 flex-col gap-0.5'><span className={cn(m.disabled && 'text-muted-foreground')}>{m.label}</span>{m.disabled && <ItemWhy reason={m.disabled} />}</span>
      </DropdownMenuItem>
    ))}
  </>);
}

/** One action as a menu item (More, a row's menu): disabled ones say why under their label. */
function ActionItem({ a, take }: { a: PageAction; take: (a: PageAction, to?: string) => void }) {
  // mold_v0-300: a move with one state open now is one item named by that move, not a submenu of one choice.
  const one = a.kind === 'move' && !a.disabled ? singleMove(a) : null;
  if (one) return (
    <DropdownMenuItem onClick={() => take(a, one.to)} data-page-action={a.id} data-move-to={one.to}>{ICON.move}{one.label}</DropdownMenuItem>
  );
  if (a.kind === 'move' && (a.moves?.length ?? 0) > 0 && !a.disabled) return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-page-action={a.id}>{ICON.move}{a.label}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className='w-64'><MoveItems a={a} take={take} /></DropdownMenuSubContent>
    </DropdownMenuSub>
  );
  return (
    <DropdownMenuItem disabled={!!a.disabled} title={a.disabled ?? undefined} onClick={() => take(a)} data-page-action={a.id}
      variant={a.kind === 'delete' ? 'destructive' : 'default'} className={cn('items-start', DISABLED_ITEM)}>
      {ICON[a.kind]}
      <span className='flex min-w-0 flex-col gap-0.5'><span className={cn(a.disabled && 'text-muted-foreground')}>{a.label}</span>{a.disabled && <ItemWhy reason={a.disabled} />}</span>
    </DropdownMenuItem>
  );
}

/**
 * The header's actions: the primary (filled), the secondary (outlined), and More (outlined: the rest, then Copy ID and,
 * unless declared, Copy link). Until the server answers, More alone (with the two copies).
 */
export function usePageActionsBar(host: ActionHost, actions: readonly PageAction[], loading: boolean, copyLinkDeclared: boolean): { card: ReactNode; bar: ReactNode; panel: boolean } {
  const { take, busy, card, dialog, panel } = usePageActions(host, actions);
  const { primary, secondary, more } = placed(actions);
  const destructive = more.filter((a) => a.kind === 'delete'), rest = more.filter((a) => a.kind !== 'delete');
  return {
    card, panel,
    bar: (
      // mold_v0-262: wraps inside the header at any width (it never keeps its one-line width, which clipped More at 390 px).
      // mold_v0-298: on a phone one row: the primary action fills it, the secondary ones move into More.
      <div className='flex max-w-full min-w-0 flex-wrap items-center gap-2 sm:justify-end max-sm:flex-nowrap max-sm:[&>[data-primary]]:min-w-0 max-sm:[&>[data-primary]]:flex-1' data-page-actions='' aria-busy={loading || undefined}>
        {primary && <ActionButton a={primary} primary busy={busy === primary.id} take={take} />}
        {!!secondary.length && <span className='contents max-sm:hidden'>{secondary.map((a) => <ActionButton key={a.id} a={a} busy={busy === a.id} take={take} />)}</span>}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type='button' variant='outline' size='sm' data-page-more='' aria-label='More actions' />}>
            <Icons.dots aria-hidden data-icon='inline-start' />More
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end' className='w-64' data-page-more-menu=''>
            {!!secondary.length && <DropdownMenuGroup className='sm:hidden' data-page-more-secondary=''>{secondary.map((a) => <ActionItem key={a.id} a={a} take={take} />)}</DropdownMenuGroup>}
            {!!secondary.length && <DropdownMenuSeparator className='sm:hidden' />}
            {!!rest.length && <DropdownMenuGroup>{rest.map((a) => <ActionItem key={a.id} a={a} take={take} />)}</DropdownMenuGroup>}
            {!!rest.length && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => host.copy(host.record.key, 'Record ID copied')} data-copy-id=''><Icons.copy aria-hidden />Copy ID</DropdownMenuItem>
              {!copyLinkDeclared && <DropdownMenuItem onClick={() => host.copy(window.location.href, 'Link copied')} data-copy-link=''><Icons.link aria-hidden />Copy link</DropdownMenuItem>}
            </DropdownMenuGroup>
            {!!destructive.length && <><DropdownMenuSeparator /><DropdownMenuGroup>{destructive.map((a) => <ActionItem key={a.id} a={a} take={take} />)}</DropdownMenuGroup></>}
          </DropdownMenuContent>
        </DropdownMenu>
        {dialog}
      </div>
    )
  };
}

/** A related list's row menu: Open, then its own area's actions this person may take on it. */
export function RowActions({ host, actions, href }: { host: ActionHost; actions: readonly PageAction[]; href: string }) {
  const { take, dialog } = usePageActions(host, actions);
  const router = useRouter();
  // A row's form opens on its own page (its card needs the page's place).
  const row = (a: PageAction, to?: string) => (a.kind === 'create_record' ? createHref(a) && router.push(createHref(a)!)
    : a.kind === 'start_run' || a.kind === 'edit' ? router.push(`${href}?act=${encodeURIComponent(a.id)}`)
    : a.kind === 'copy_link' ? host.copy(new URL(href, window.location.origin).toString(), 'Link copied')
    : a.kind === 'open_url' ? void (a.url && window.open(a.url, '_blank', 'noopener,noreferrer')) : take(a, to));
  const shown = actions.filter((a) => a.kind !== 'link' || a.target);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button type='button' variant='ghost' size='icon-sm' aria-label={`Actions for ${host.record.title || host.record.key}`} data-row-actions='' />}>
          <Icons.dots aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' className='w-60'>
          <DropdownMenuGroup>
            <DropdownMenuLabel className='truncate'>{host.record.title || host.record.key}</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => router.push(href)}><Icons.arrowRight aria-hidden />Open</DropdownMenuItem>
            {shown.filter((a) => a.kind !== 'delete').map((a) => <ActionItem key={a.id} a={a} take={row} />)}
          </DropdownMenuGroup>
          {shown.some((a) => a.kind === 'delete') && <><DropdownMenuSeparator /><DropdownMenuGroup>{shown.filter((a) => a.kind === 'delete').map((a) => <ActionItem key={a.id} a={a} take={row} />)}</DropdownMenuGroup></>}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}

/** The form of a start_run or an edit action: a full card in the page's place. */
function ActionFormCard({ host, a, onClose }: { host: ActionHost; a: PageAction; onClose: () => void }) {
  const done = () => { onClose(); host.changed(); };
  // mold_v0-256: a new record of another area, its fields filled from this record (the reference to it, say).
  if (a.kind === 'create_record' && a.create) {
    const c = a.create;
    const set = Object.keys(c.values).map((k) => c.fields?.find((f) => f.name === k)?.label ?? k);
    return (
      <ActionCard open onOpenChange={(o) => { if (!o) onClose(); }} title={`${a.label} · ${host.record.title || host.record.key}`} back='Back to the record'
        description={`A new record in ${c.label}${set.length ? `, its ${set.join(' and ').toLowerCase()} set from ${host.record.title || host.record.key}` : ''}. It shows on this page at once.`}>
        <CreateRecordForm area={{ name: c.area, label: c.label, fields: (c.fields ?? []) as FormField[], key_from_title: c.key_from_title }} uploadMax={c.upload_max ?? null}
          initial={Object.fromEntries(Object.entries(c.values).map(([k, v]) => [k, Array.isArray(v) ? v : asInput(v)]))} onDone={done} />
      </ActionCard>
    );
  }
  if (a.kind === 'edit') return (
    <ActionCard open onOpenChange={(o) => { if (!o) onClose(); }} title={`${a.label} · ${host.record.title || host.record.key}`} back='Back to the record'
      description={`Changes ${host.record.title || host.record.key} in ${host.areaLabel}. Its state and its files stay as they are.`}>
      <EditRecordForm area={host.area} fields={(a.fields ?? []) as FormField[]} row={host.record} onDone={done}
        put={(body) => takeAction(host.area, host.record.key, a.id, body)} shareable={host.canShare ? host.record.visibility ?? null : null} />
    </ActionCard>
  );
  return (
    <ActionCard open onOpenChange={(o) => { if (!o) onClose(); }} title={`${a.label} · ${host.record.title || host.record.key}`} back='Back to the record'
      description={`${a.run?.description ? `${a.run.description} ` : ''}${a.run?.target ? `It runs on ${a.run.target.title || a.run.target.key}. ` : ''}The run is queued and shows in this record's runs at once.`}>
      <RecordRunForm host={host} a={a} onDone={done} />
    </ActionCard>
  );
}

/** A run of the action's kind on the record: its arguments, pre-filled from the record; its environment when it takes one. */
function RecordRunForm({ host, a, onDone }: { host: ActionHost; a: PageAction; onDone: () => void }) {
  // mold_v0-260 (flag record_run_inputs): what the kind takes from the record is the server's: shown, never typed or sent.
  const fixed = a.run?.from_record ?? [];
  const all = (a.run?.args ?? []) as FormField[];
  const fields = all.filter((f) => !fixed.includes(f.name));
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(Object.entries(a.run?.values ?? {}).map(([k, v]) => [k, asInput(v)])));
  const envs = a.run?.environments ?? null;
  const [env, setEnv] = useState(envs?.[0] ?? '');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const { values: input, problem } = fieldValues(fields, values);
    if (problem) return void toast.error(problem);
    setBusy(true);
    try {
      await takeAction(host.area, host.record.key, a.id, { input: { ...Object.fromEntries(Object.entries(input).filter(([k]) => !fixed.includes(k))), ...(envs && env ? { target_environment: env } : {}) } });
      toast.success(`${a.run?.label ?? a.label} started`);
      onDone();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <CardForm onSubmit={submit} submit={<Button type='submit' disabled={busy} data-start-run=''><Icons.play /> {busy ? 'Starting…' : a.label}</Button>}>
      {fixed.length > 0 && (
        <div className='flex flex-col gap-1.5' data-from-record=''>
          <p className='text-sm font-medium'>From this record</p>
          <dl className='grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md border p-3 text-sm'>
            {fixed.map((n) => (
              <div key={n} className='contents'>
                <dt className='text-muted-foreground'>{all.find((f) => f.name === n)?.label ?? n}</dt>
                <dd className='min-w-0 truncate font-medium' title={String(a.run?.values[n] ?? '')}>{String(a.run?.values[n] ?? '')}</dd>
              </div>
            ))}
          </dl>
          <p className='text-muted-foreground text-xs'>Read from the record when the run starts.</p>
        </div>
      )}
      {!fields.length && !envs && !fixed.length && <p className='text-muted-foreground text-sm'>It takes nothing more: start it.</p>}
      <FieldsForm fields={fields} values={values} set={(n, v) => setValues((s) => ({ ...s, [n]: v }))} idPrefix='run-field' />
      {envs && (
        <div className='flex flex-col gap-1.5'>
          <Label htmlFor='run-environment'>Environment</Label>
          {envs.length ? (
            <NativeSelect id='run-environment' value={env} onChange={(e) => setEnv(e.target.value)}>
              {envs.map((x) => <NativeSelectOption key={x} value={x}>{x}</NativeSelectOption>)}
            </NativeSelect>
          ) : <Input id='run-environment' value={env} onChange={(e) => setEnv(e.target.value)} />}
        </div>
      )}
    </CardForm>
  );
}


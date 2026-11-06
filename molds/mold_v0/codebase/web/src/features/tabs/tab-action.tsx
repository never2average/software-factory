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
// mold_v0-237: an area's own lists (its Settings tab, its Records page) have theirs too (useAreaAction: the registry's
// `action`, the server's /api/tab-actions/_areas/<area>). mold_v0-238: a create form uploads its file fields' files
// (FileUploads: each file's progress, then Uploaded) before it writes the record, and takes a url field as an address.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { featureOn } from '@/config/features';
import { ConfirmDialog } from '@/features/admin/ui';
import { useQueryState } from 'nuqs';
import { parseAsFlag } from '@/lib/query-flag';
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
import type { PackTabSpec, RecordAreaSpec } from '@/config/pack-nav.generated';
import { fail, useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { fill } from '@/lib/vocabulary';
import { cn } from '@/lib/utils';
import { keyFromTitle, prefill } from './form-prefill';

/** A field as the server's form spec gives it (src/tab-actions.ts FormField). */
export interface FormField {
  name: string; label: string; type: string; help: string | null; required: boolean; options: { value: string; label: string }[] | null;
  multiple: boolean; min: number | null; max: number | null; max_length: number | null; to: string | null;
  /** A URL whose document the record's card previews (mold_v0-220). */
  preview?: 'document';
}
interface StartKind { name: string; label: string; description: string | null; args: FormField[]; targets: { name: string; label: string }[] | null; environments: string[] | null }
type ActionSpec =
  | { kind: 'start_run'; label: string | null; allowed: boolean; kinds: StartKind[] }
  | { kind: 'new_schedule'; label: string | null; allowed: boolean; job_kind: string | null }
  | { kind: 'create_record'; label: string | null; allowed: boolean; area: { name: string; label: string; fields: FormField[]; key_from_title?: boolean } | null;
      /** The most bytes a file of its file fields may have when the form uploads them (mold_v0-238); null: no upload. */
      upload_max?: number | null };

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
 * (?new=1) for a record or a schedule, `import` (?import=1) for an import (a staff record page's, mold_v0-221; a workspace list's, mold_v0-234). Opening adds a history entry, so Back returns to the list; closing replaces it.
 */
export function useActionOpen(name: 'start' | 'new' | 'import'): [boolean, (open: boolean) => void] {
  const [on, set] = useQueryState(name, parseAsFlag.withDefault(false));
  return [on, (open: boolean) => {
    void set(open ? true : null, { history: open ? 'push' : 'replace' });
    // Back on the list: focus returns to the button that opened the card.
    if (!open) setTimeout(() => document.querySelector<HTMLElement>('[data-toolbar-action]')?.focus(), 50);
  }];
}

const CardCtx = createContext<{ title: string; description?: string; cancel: () => void; back?: string; panel?: { expand: () => void } | null } | null>(null);

// ---------- the side panel (mold_v0-256, flag side_panel_forms) ----------

/** Where the open form is: the FormHost around a list or a page says whether its card opens in the side panel. */
const PanelCtx = createContext<{ inPanel: boolean; expand: () => void } | null>(null);

/**
 * The place of a create or edit form (mold_v0-256): `card` (the open ActionCard, or null) and what it stands in for
 * (`children`: a list, a record's page). With the flag side_panel_forms on and `panel` (a create or edit form), the card
 * opens first in a panel at the right, the list or page staying in view beneath; its Open full page expands the same card,
 * its typed values kept (the form stays mounted in the same place), to the full in-page card in the list's place. Off,
 * or for any other form, the card is the full in-page card it always was.
 */
export function FormHost({ card, panel = false, children }: { card: ReactNode; panel?: boolean; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const open = !!card;
  useEffect(() => { if (!open) setExpanded(false); }, [open]);
  const inPanel = open && panel && featureOn('side_panel_forms') && !expanded;
  return (
    <PanelCtx.Provider value={{ inPanel, expand: () => setExpanded(true) }}>
      {card}
      {!open || inPanel ? children : null}
    </PanelCtx.Provider>
  );
}

/** The tabbable elements inside `root`, in order (the panel's focus trap). */
const tabbables = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
  .filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true' && el.offsetParent !== null);

/**
 * The form in the side panel: a dialog at the right (the full screen on a phone, 640 px or narrower) over a dimmed page;
 * its title, what will happen, Open full page and Close, the fields (scrolling), then the submit and Cancel. Focus moves
 * to its title, stays inside it (Tab and Shift+Tab wrap) and returns where it was when it closes; Esc, Close, Cancel or a
 * click on the dimmed page close it, asking first when something was typed.
 */
function SidePanelForm({ c, form, onSubmit, submit, children }: {
  c: NonNullable<React.ContextType<typeof CardCtx>>; form: React.RefObject<HTMLFormElement | null>; onSubmit: () => unknown; submit: ReactNode; children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    const before = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; if (before && document.contains(before)) before.focus(); };
  }, []);
  useEffect(() => { if (mounted) title.current?.focus(); }, [mounted]);
  const close = () => (dirty ? setAsking(true) : c.cancel());
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !asking) { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab' || !box.current) return;
    const els = tabbables(box.current);
    if (!els.length) return;
    const first = els[0]!, last = els[els.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === title.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  if (!mounted) return null;
  return createPortal(
    <div className='fixed inset-0 z-50' data-side-panel-root=''>
      <div aria-hidden className='bg-foreground/25 dark:bg-background/70 absolute inset-0 backdrop-blur-[1px]' onClick={close} data-side-panel-backdrop='' />
      <div ref={box} role='dialog' aria-modal='true' aria-labelledby='side-panel-title' onKeyDown={onKey} data-side-panel=''
        className='bg-background absolute inset-y-0 right-0 flex w-full flex-col shadow-2xl min-[641px]:w-[min(42rem,calc(100vw-3rem))] min-[641px]:border-l'>
        <form ref={form} className='flex min-h-0 flex-1 flex-col' onSubmit={(e) => { e.preventDefault(); void onSubmit(); }}
          onInput={() => setDirty(true)} onChange={() => setDirty(true)}>
          <div className='flex items-start gap-3 border-b px-5 py-4'>
            <div className='flex min-w-0 flex-1 flex-col gap-1'>
              <h2 id='side-panel-title' ref={title} tabIndex={-1} className='text-lg leading-snug font-semibold break-words outline-none'>{c.title}</h2>
              {c.description && <p className='text-muted-foreground text-sm'>{c.description}</p>}
            </div>
            <div className='flex shrink-0 items-center gap-2'>
              <Button type='button' variant='outline' size='sm' onClick={() => c.panel?.expand()} data-panel-expand='' title='Open the form as a full page'>
                <Icons.maximize aria-hidden data-icon='inline-start' />Open full page
              </Button>
              <Button type='button' variant='outline' size='icon-sm' onClick={close} aria-label='Close' title='Close' data-panel-close=''><Icons.close aria-hidden /></Button>
            </div>
          </div>
          <div className='flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5' data-side-panel-body=''>{children}</div>
          <div data-card-footer='' className='bg-background flex flex-wrap gap-2 border-t px-5 py-4'>
            {submit}
            <Button type='button' variant='outline' onClick={close}>Cancel</Button>
          </div>
        </form>
      </div>
      <ConfirmDialog open={asking} onOpenChange={setAsking} title='Discard your changes?' destructive confirmLabel='Discard'
        description='What you typed in this form is not saved. Close it anyway?' onConfirm={() => c.cancel()} />
    </div>,
    document.body
  );
}

/**
 * An action's form as a full card in the list's place (mold_v0-217; the record details card's style): drawn while
 * `open`; its CardForm reads the title, the description and Cancel from here.
 */
export function ActionCard({ open, onOpenChange, title, description, back, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string;
  /** The way back's words (default "Back to the list"; mold_v0-254, a record page's form: "Back to the record"). */
  back?: string; children: ReactNode;
}) {
  const place = useContext(PanelCtx);
  if (!open) return null;
  // mold_v0-256: inside a FormHost whose card opens in the side panel, CardForm draws the panel (place.inPanel).
  return <CardCtx.Provider value={{ title, description, cancel: () => onOpenChange(false), back, panel: place?.inPanel ? { expand: place.expand } : null }}>{children}</CardCtx.Provider>;
}

/**
 * The card itself: a way back to the list, the title and what will happen, the fields, then the submit and Cancel.
 * Focus moves to its title when it opens.
 */
export function CardForm({ onSubmit, submit, children }: { onSubmit: () => unknown; submit: ReactNode; children: ReactNode }) {
  const c = useContext(CardCtx);
  const title = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const inPanel = !!c?.panel;
  // Focus to the title when it opens, and again when the panel's form opens as the full card (mold_v0-256).
  useEffect(() => { if (!inPanel) title.current?.focus(); }, [inPanel]);
  const cancel = () => c?.cancel();
  if (c && inPanel) return <SidePanelForm c={c} form={form} onSubmit={onSubmit} submit={submit}>{children}</SidePanelForm>;
  return (
    <Card className='w-full max-w-4xl gap-0 py-0' data-action-card=''>
      <form className='flex flex-col' onSubmit={(e) => { e.preventDefault(); void onSubmit(); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } }}>
        <CardHeader className='border-b py-4 [.border-b]:pb-4'>
          <CardDescription>
            <Button variant='outline' size='sm' onClick={cancel}>
              <Icons.chevronLeft className='size-3.5' />{c?.back ?? 'Back to the list'}
            </Button>
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
export function useTabAction(tab: TabRef | null, onDone?: () => unknown): { button: ReactNode; card: ReactNode; panel: boolean } {
  return useListAction(tab?.action ?? null, tab ? `/api/tab-actions/${encodeURIComponent(tab.pack)}/${encodeURIComponent(tab.id)}` : null, tab, onDone);
}

/**
 * The primary action of an area's own lists (mold_v0-237): its Settings tab and its Records page, whose action the
 * build resolved into the registry (RecordAreaSpec `action`: Add <its singular>, a new record) and the server says who
 * may use (/api/tab-actions/_areas/<area>). Null, or an area with none (its `no_action` says why): no button.
 */
export function useAreaAction(area: Pick<RecordAreaSpec, 'name' | 'action'> | null, onDone?: () => unknown): { button: ReactNode; card: ReactNode; panel: boolean } {
  return useListAction(area?.action ?? null, area?.action ? `/api/tab-actions/_areas/${encodeURIComponent(area.name)}` : null, null, onDone);
}

function useListAction(a: NonNullable<PackTabSpec['action']> | null, specUrl: string | null, tab: TabRef | null, onDone?: () => unknown): { button: ReactNode; card: ReactNode; panel: boolean } {
  const { data } = useOrgLoad(() => (specUrl && a && a.kind !== 'new_schedule' && a.kind !== 'link'
    ? send<ActionSpec>('GET', specUrl).catch(() => null)
    : Promise.resolve(null)), [specUrl]);
  const [open, setOpen] = useActionOpen(a?.kind === 'start_run' ? 'start' : 'new');
  if (!specUrl || !a) return { button: null, card: null, panel: false };
  if (a.kind === 'link') return { button: <LinkAction action={a} />, card: null, panel: false };
  if (!data || !data.allowed) return { button: null, card: null, panel: false };
  const label = actionLabel(a);
  const done = () => { setOpen(false); void onDone?.(); };
  return {
    button: <ToolbarAction label={label} icon={a.kind === 'start_run' ? <Icons.play /> : <Icons.add />} onClick={() => setOpen(true)} />,
    // While closed, no card: the list draws.
    card: !open ? null : (
      <ActionCard open onOpenChange={setOpen} title={label}
        description={data.kind === 'start_run' ? fill('The {run} is queued and runs on its own; it shows in the list at once.')
          : data.kind === 'create_record' && data.area ? `A new record in ${data.area.label}, added to the list at once.` : undefined}>
        {data.kind === 'start_run' && tab ? <StartRunForm tab={tab} kinds={data.kinds} onDone={done} />
          : data.kind === 'create_record' && data.area ? <CreateRecordForm area={data.area} onDone={done} uploadMax={data.upload_max ?? null} initial={prefill(data.area.fields)} /> : null}
      </ActionCard>
    ),
    // mold_v0-256: a new record's form opens in the side panel (flag side_panel_forms; FormHost decides).
    panel: data.kind === 'create_record'
  };
}

// ---------- the forms ----------

/** A record the picker offers: its key and title. */
type PickItem = { key: string; title: string | null };
/**
 * A reference field's input (mold_v0-256, flag record_pages): a searchable list of the target area's records (its title
 * and key; GET /api/records/_page/_pick/<area>?q=, read as the person, the workspace's own), in place of a box for a
 * record key. Arrow keys move, Enter picks, Esc closes the list; a list field gathers its picks as removable chips. When
 * the list cannot be read (another build, a role that may not read the area) what is typed is the key, as before.
 */
function RecordPicker({ id, f, value, set }: { id: string; f: FormField; value: unknown; set: (v: unknown) => void }) {
  const multiple = f.multiple;
  const keys = multiple ? (Array.isArray(value) ? (value as string[]) : keysOf(String(value ?? ''))) : [];
  const [q, setQ] = useState(multiple ? '' : String(value ?? ''));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [items, setItems] = useState<PickItem[] | null>(null);
  const [titles, setTitles] = useState<Record<string, string | null>>({});
  const [off, setOff] = useState(false);
  const [typed, setTyped] = useState(false);
  const list = `${id}-list`;
  // Open: the records matching what was typed (all, newest first, before anything is typed). Closed: the chosen record's
  // title, once (a value filled in from the address shows its record's name).
  const asked = open ? (typed ? q : '') : !multiple && value && !(String(value) in titles) ? String(value) : null;
  useEffect(() => {
    if (off || !f.to || asked === null) return;
    let live = true;
    const t = setTimeout(() => {
      send<{ records: PickItem[] }>('GET', `/api/records/_page/_pick/${encodeURIComponent(f.to!)}?q=${encodeURIComponent(asked)}`)
        .then((r) => { if (!live) return; setItems(r.records); setActive(0); setTitles((m) => ({ ...m, ...Object.fromEntries(r.records.map((x) => [x.key, x.title])) })); })
        .catch(() => { if (live) setOff(true); });
    }, open ? 180 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [asked, off, f.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (items ?? []).filter((x) => !keys.includes(x.key));
  const choose = (x: PickItem) => {
    if (multiple) { set([...keys, x.key]); setQ(''); } else { set(x.key); setQ(x.key); setOpen(false); }
    setTyped(false);
    setTitles((m) => ({ ...m, [x.key]: x.title }));
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (off) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, Math.max(0, shown.length - 1))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && open && shown[active]) { e.preventDefault(); choose(shown[active]!); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === 'Backspace' && multiple && !q && keys.length) set(keys.slice(0, -1));
  };
  const chosen = !multiple && value ? titles[String(value)] : null;
  return (
    <div className='relative flex flex-col gap-1.5' data-record-picker={f.to ?? ''}>
      {multiple && keys.length > 0 && (
        <ul className='flex flex-wrap gap-1.5' aria-label={`${f.label}: chosen`}>
          {keys.map((k) => (
            <li key={k} className='bg-muted/60 flex items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-2 text-xs' data-picked={k}>
              <span className='max-w-56 truncate' title={k}>{titles[k] ?? k}</span>
              <Button type='button' variant='ghost' size='icon-xs' aria-label={`Remove ${titles[k] ?? k}`} onClick={() => set(keys.filter((x) => x !== k))}><Icons.close aria-hidden /></Button>
            </li>
          ))}
        </ul>
      )}
      <Input id={id} value={q} autoComplete='off' role={off ? undefined : 'combobox'} aria-expanded={off ? undefined : open} aria-controls={off ? undefined : list}
        aria-autocomplete={off ? undefined : 'list'} aria-activedescendant={open && shown[active] ? `${list}-${active}` : undefined}
        placeholder={off ? (multiple ? 'record keys, comma-separated' : 'a record key') : `Search ${f.label.toLowerCase()} by name or key`}
        onFocus={() => !off && setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={onKey}
        onChange={(e) => { setQ(e.target.value); setTyped(true); setOpen(true); if (!multiple) set(e.target.value); else if (off) set(keysOf(e.target.value)); }} />
      {chosen && <p className='text-muted-foreground text-xs' data-picked-title=''>{chosen}</p>}
      {open && !off && items && (
        <ul id={list} role='listbox' aria-label={f.label} data-picker-list=''
          className='bg-popover text-popover-foreground absolute top-full z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border p-1 shadow-md'>
          {shown.length ? shown.map((x, i) => (
            <li key={x.key} id={`${list}-${i}`} role='option' aria-selected={i === active} data-pick={x.key}
              onMouseDown={(e) => e.preventDefault()} onClick={() => choose(x)} onMouseEnter={() => setActive(i)}
              className={cn('flex cursor-pointer flex-col rounded-md px-2 py-1.5 text-sm', i === active && 'bg-accent text-accent-foreground')}>
              <span className='truncate font-medium'>{x.title || x.key}</span>
              {x.title && <span className='text-muted-foreground truncate font-mono text-xs'>{x.key}</span>}
            </li>
          )) : <li className='text-muted-foreground px-2 py-1.5 text-sm' role='presentation'>No {f.label.toLowerCase()} matches “{q}”.</li>}
        </ul>
      )}
    </div>
  );
}

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
    else if (f.type === 'url') {
      // mold_v0-238: an http or https address (the record store checks it again).
      const u = String(v).trim();
      if (!isWebAddress(u)) return { values, problem: `${f.label} is a web address starting with https:// or http://` };
      values[f.name] = u;
    }
    else if (f.multiple && !Array.isArray(v)) values[f.name] = keysOf(String(v));
    else values[f.name] = v;
  }
  return { values, problem: null };
}

/** Whether `v` reads as a url field's value (mold_v0-238; the server's src/pack-api.ts isFieldUrl decides). */
export function isWebAddress(v: string): boolean {
  if (!/^https?:\/\/[^/?#\\\s][^\s]*$/i.test(v) || v.length > 2048) return false;
  try { const u = new URL(v); return !!u.hostname && !u.username && !u.password; } catch { return false; }
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
          ) : (f.type === 'reference' || (f.type === 'link' && f.to)) && f.to && featureOn('record_pages') ? (
            <RecordPicker id={id} f={f} value={v} set={(x) => set(f.name, x)} />
          ) : f.type === 'json' || (f.type === 'text' && (f.max_length === null || f.max_length > 200)) ? (
            <Textarea id={id} rows={f.type === 'json' ? 5 : 3} className={f.type === 'json' ? 'font-mono text-xs' : undefined} value={String(v ?? '')}
              maxLength={f.max_length ?? undefined} onChange={(e) => set(f.name, e.target.value)} required={f.required} placeholder={f.type === 'json' ? '{ }' : undefined} />
          ) : (
            <Input id={id} value={String(v ?? '')} onChange={(e) => set(f.name, e.target.value)} required={f.required}
              type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'url' ? 'url' : 'text'} min={f.min ?? undefined} max={f.max ?? undefined}
              maxLength={f.type === 'url' ? 2048 : f.max_length ?? undefined} inputMode={f.type === 'url' ? 'url' : undefined}
              placeholder={f.type === 'reference' || f.type === 'link' ? (f.multiple ? 'record keys, comma-separated' : 'a record key')
                : f.type === 'person' ? 'a person’s sign-in id' : f.type === 'file' ? 'a path in the workspace’s files' : f.type === 'url' ? 'https://' : undefined} />
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

// ---------- file uploads (mold_v0-238) ----------

/** A stored file's reference, as the upload answers it and a file field holds it (src/record-files-config.ts). */
export interface StoredFileRef { object: string; name: string; size: number; content_type: string; sha256: string }
/** One file chosen for a file field: waiting, uploading (its bytes sent so far), uploaded (its reference), or failed. */
export interface UploadItem {
  id: string; file: File; state: 'waiting' | 'uploading' | 'done' | 'failed'; sent: number;
  /** The reference, and the record key it was kept for (a file is bound to its record). */
  ref?: StoredFileRef; key?: string; error?: string;
}

const fileUrl = (area: string, key: string, field: string) => `/api/data/${encodeURIComponent(area)}/${encodeURIComponent(key)}/files/${encodeURIComponent(field)}`;

/** A file's size in words: 512 B, 12 KB, 3.4 MB. */
export const sizeWords = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`);

/** One file's bytes to the upload route, its progress told as it goes (a fetch says none while sending). */
function uploadOne(url: string, file: File, progress: (sent: number) => void): Promise<StoredFileRef> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.withCredentials = true;
    x.setRequestHeader('accept', 'application/json');
    x.setRequestHeader('content-type', 'application/octet-stream');
    x.setRequestHeader('x-pack-request', '1');
    x.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    x.setRequestHeader('x-file-type', file.type || 'application/octet-stream');
    x.upload.onprogress = (e) => progress(e.loaded);
    x.onerror = () => reject(new Error('The upload stopped: check the connection and try again'));
    x.onload = () => {
      let body: (StoredFileRef & { error?: string }) | null = null;
      try { body = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status >= 200 && x.status < 300 && body?.object) return resolve(body);
      reject(httpError(x.status, body ?? {}));
    };
    x.send(file);
  });
}
/** Remove a file kept for a record but never written (a cancelled form, a removed file): best effort. */
function discardOne(area: string, field: string, item: UploadItem) {
  if (!item.ref || !item.key) return;
  void fetch(fileUrl(area, item.key, field), { method: 'DELETE', credentials: 'same-origin', keepalive: true,
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-pack-request': '1' }, body: JSON.stringify(item.ref) }).catch(() => null);
}

/**
 * A file field's files in a create form (mold_v0-238): Choose files (one, or several for a multiple field), then each
 * chosen file's name, size and state: Waiting, a progress bar while it uploads, Uploaded, or why it failed, with Remove.
 * The form uploads them when it is sent (each kept for the record's key), then writes the record.
 */
export function FileUploads({ field, items, setItems, max, disabled, id }: {
  field: FormField; items: UploadItem[]; setItems: (f: (items: UploadItem[]) => UploadItem[]) => void; max: number; disabled: boolean; id: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const add = (list: FileList | null) => {
    const chosen = [...(list ?? [])];
    const big = chosen.filter((f) => f.size > max);
    if (big.length) toast.error(`${big.map((f) => f.name).join(', ')}: a file here is at most ${sizeWords(max)}`);
    const ok = chosen.filter((f) => f.size <= max && f.size > 0).map((file): UploadItem => ({ id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`, file, state: 'waiting', sent: 0 }));
    if (ok.length) setItems((xs) => (field.multiple ? [...xs, ...ok] : ok.slice(0, 1)));
    if (input.current) input.current.value = '';
  };
  return (
    <fieldset className='flex flex-col gap-2' data-file-field={field.name}>
      <legend className='mb-1.5 text-sm font-medium'>{field.label}{field.required && <span className='text-destructive' aria-hidden> *</span>}</legend>
      {(field.multiple || !items.length) && (
        <div className='flex flex-wrap items-center gap-3'>
          <Button type='button' variant='outline' size='sm' disabled={disabled} onClick={() => input.current?.click()} aria-describedby={`${id}-limit`}>
            <Icons.upload /> {field.multiple ? 'Choose files' : 'Choose a file'}
          </Button>
          <span id={`${id}-limit`} className='text-muted-foreground text-xs'>Up to {sizeWords(max)} {field.multiple ? 'each' : ''}</span>
          <input ref={input} id={id} type='file' className='sr-only' tabIndex={-1} multiple={field.multiple} onChange={(e) => add(e.target.files)} aria-label={field.label} />
        </div>
      )}
      {items.length > 0 && (
        <ul className='flex flex-col gap-2' aria-label={`${field.label}: chosen files`}>
          {items.map((it) => {
            const pct = it.file.size ? Math.min(100, Math.round((it.sent / it.file.size) * 100)) : 100;
            const state = it.state === 'uploading' ? `Uploading ${pct}%` : it.state === 'done' ? 'Uploaded' : it.state === 'failed' ? it.error ?? 'Failed' : 'Waiting to upload';
            return (
              <li key={it.id} className='bg-muted/40 flex flex-col gap-2 rounded-md border px-3 py-2' data-upload={it.state}>
                <div className='flex min-w-0 items-center gap-3'>
                  <Icons.paperclip className='text-muted-foreground size-4 shrink-0' aria-hidden />
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-sm font-medium'>{it.file.name}</span>
                    <span className={it.state === 'failed' ? 'text-destructive block text-xs' : 'text-muted-foreground block text-xs'} aria-live='polite'>
                      {sizeWords(it.file.size)} · {it.state === 'done' && <Icons.check className='mr-0.5 inline size-3.5 align-[-2px] text-emerald-600 dark:text-emerald-400' aria-hidden />}{state}
                    </span>
                  </span>
                  <Button type='button' variant='ghost' size='sm' disabled={disabled} onClick={() => setItems((xs) => xs.filter((x) => x.id !== it.id))} aria-label={`Remove ${it.file.name}`}>Remove</Button>
                </div>
                {it.state === 'uploading' && (
                  <div role='progressbar' aria-label={`Uploading ${it.file.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className='bg-muted h-1.5 overflow-hidden rounded-sm'>
                    <div className='bg-primary h-full rounded-sm transition-[width]' style={{ width: `${pct}%` }} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {field.help && <p className='text-muted-foreground text-xs'>{field.help}</p>}
    </fieldset>
  );
}

/**
 * A new record's key, title and fields; `post` sends it (default: the workspace's data API; mold_v0-212, a staff record
 * page: the shared area's /api/admin/data). `uploadMax` (mold_v0-238, a workspace area that takes uploads): its file
 * fields take files from this device, uploaded when the form is sent (each kept for the record's key; one kept for an
 * earlier key is uploaded again), then the record is written with their references. A refused write keeps them for the
 * next try; Cancel, or a file removed, discards the ones kept but never written.
 */
export function CreateRecordForm({ area, onDone, post, uploadMax = null, initial }: {
  area: { name: string; label: string; fields: FormField[]; key_from_title?: boolean }; onDone: () => void; post?: (body: { key: string; title?: string; data: Record<string, unknown> }) => Promise<unknown>;
  uploadMax?: number | null;
  /** mold_v0-256: fields filled in (an Add <related record> action: the reference to the record it was taken on). */
  initial?: Record<string, unknown>;
}) {
  const [key, setKey] = useState('');
  const [title, setTitle] = useState('');
  // mold_v0-256: an area with key_from_title fills the Key from the Title until the person types a key of their own.
  const [keyTyped, setKeyTyped] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...(initial ?? {}) }));
  const [busy, setBusy] = useState(false);
  const [uploads, setUploads] = useState<Record<string, UploadItem[]>>({});
  const fileFields = uploadMax ? area.fields.filter((f) => f.type === 'file') : [];
  const plain = uploadMax ? area.fields.filter((f) => f.type !== 'file') : area.fields;
  // What was kept but not written, discarded when the form goes away without writing it (Cancel, Back).
  const latest = useRef(uploads);
  latest.current = uploads;
  const written = useRef(false);
  useEffect(() => () => {
    if (written.current) return;
    for (const [field, items] of Object.entries(latest.current)) for (const it of items) discardOne(area.name, field, it);
  }, [area.name]);
  const patch = (field: string, id: string, p: Partial<UploadItem>) =>
    setUploads((u) => ({ ...u, [field]: (u[field] ?? []).map((x) => (x.id === id ? { ...x, ...p } : x)) }));
  const setItems = (field: string) => (f: (items: UploadItem[]) => UploadItem[]) => {
    const before = latest.current[field] ?? [], after = f(before);
    // A file removed after it was kept: discarded at once.
    for (const it of before) if (!after.includes(it)) discardOne(area.name, field, it);
    latest.current = { ...latest.current, [field]: after };
    setUploads(latest.current);
  };
  const submit = async () => {
    const { values: data, problem } = fieldValues(plain, values);
    if (problem) return void toast.error(problem);
    const k = key.trim();
    for (const f of fileFields) if (f.required && !(uploads[f.name] ?? []).length) return void toast.error(`${f.label} is required`);
    setBusy(true);
    try {
      // Each file not yet kept for this key, one at a time, its progress shown; the first failure stops the form.
      for (const f of fileFields) {
        const refs: StoredFileRef[] = [];
        for (const it of uploads[f.name] ?? []) {
          if (it.state === 'done' && it.ref && it.key === k) { refs.push(it.ref); continue; }
          if (it.ref) discardOne(area.name, f.name, it);
          patch(f.name, it.id, { state: 'uploading', sent: 0, ref: undefined, key: undefined, error: undefined });
          try {
            const ref = await uploadOne(fileUrl(area.name, k, f.name), it.file, (sent) => patch(f.name, it.id, { sent }));
            patch(f.name, it.id, { state: 'done', sent: it.file.size, ref, key: k });
            refs.push(ref);
          } catch (e) {
            patch(f.name, it.id, { state: 'failed', error: e instanceof Error ? e.message : 'The upload failed' });
            throw e;
          }
        }
        if (refs.length) data[f.name] = f.multiple ? refs : refs[0];
      }
      const body = { key: k, ...(title.trim() ? { title: title.trim() } : {}), data };
      await (post ? post(body) : send('POST', `/api/data/${encodeURIComponent(area.name)}`, body));
      written.current = true;
      toast.success('Added');
      onDone();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const uploading = Object.values(uploads).some((xs) => xs.some((x) => x.state === 'uploading'));
  return (
    <CardForm onSubmit={submit} submit={<Button type='submit' disabled={busy || !key.trim()}><Icons.add /> {uploading ? 'Uploading…' : busy ? 'Adding…' : 'Add'}</Button>}>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='action-key'>Key<span className='text-destructive' aria-hidden> *</span></Label>
        <Input id='action-key' value={key} onChange={(e) => { setKey(e.target.value); setKeyTyped(e.target.value !== ''); }} required placeholder='a short id, unique in this list' />
        {area.key_from_title && !keyTyped && <p className='text-muted-foreground text-xs' data-key-from-title=''>Filled from the title as you type it; change it to set your own.</p>}
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor='action-title'>Title</Label>
        <Input id='action-title' value={title} onChange={(e) => { setTitle(e.target.value); if (area.key_from_title && !keyTyped) setKey(keyFromTitle(e.target.value)); }} />
      </div>
      <FieldsForm fields={plain} values={values} set={(n, v) => setValues((s) => ({ ...s, [n]: v }))} idPrefix='action-field' />
      {fileFields.map((f) => (
        <FileUploads key={f.name} field={f} items={uploads[f.name] ?? []} setItems={setItems(f.name)} max={uploadMax!} disabled={busy} id={`action-file-${f.name}`} />
      ))}
    </CardForm>
  );
}

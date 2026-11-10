'use client';
// The one record surface of every list (mold_v0-278): an inline panel to the right of the list, never a drawer over
// it and never a page of its own. The table column gives way (it narrows and stays scrollable and clickable: another
// row switches the panel, the selected row is highlighted), a splitter between them resizes the panel (drag, or focus it
// and use ← → Home End; remembered per panel type, lib/split-panel.ts), and the header's labelled Expand makes the panel
// take the list's whole width (Collapse restores it). No backdrop, no focus trap: Esc closes it (focus in the panel or
// the list) and focus goes back to the row it was opened from. Below lg the panel is a full-width layer under the top
// bar with "Back to list".
//
// The header: the title on the left; on the right only the labelled Expand / Collapse and the "⋯" actions menu (every
// other action of the record as labelled items, "Open in its own page" among them when the record has a page). Close is
// a round ✕ on the card's top-right corner (aria-label "Close panel", tooltip "Close (Esc)"); below lg it sits top
// right in the header row.
//
// One record panel at a time: opening one closes any other (claimPanel), and a create or edit form's side panel
// (features/tabs/side-panel.tsx) closes it as it opens. An editor with unsaved changes (usePanelGuard, or anything
// typed into a form in the panel's body) asks before the panel closes or switches to another row (guarded).
//
// The list (components/layout/record-view.tsx) is the host: it keeps the open row in the address (`?id=<key>`, a reload
// or a shared link reopens it; `&panel=full` expanded; `&panelTab=<tab>` a laid-out record's tab), and closing drops
// those and keeps every list filter.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from 'react';
import Link from 'next/link';
import { IconArrowLeft, IconArrowsMaximize, IconArrowsMinimize, IconX } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Icons } from '@/components/icons';
import type { RowAction } from '@/components/layout/record-filters';
import { ratioOf, readSplitRatio, splitLayout, splitWidthForKey, writeSplitRatio, type PanelKind, type SplitLayout } from '@/lib/split-panel';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------------------------------- one at a time

type Store = { active: { token: object; close: () => void } | null; pending: (() => void) | null };
let store: Store = { active: null, pending: null };
const listeners = new Set<() => void>();
const emit = (next: Partial<Store>) => { store = { ...store, ...next }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const SERVER: Store = { active: null, pending: null };
const useStore = () => useSyncExternalStore(subscribe, () => store, () => SERVER);

/** A panel opens: any other record panel closes (one at a time). */
function claimPanel(token: object, close: () => void) {
  const prev = store.active;
  emit({ active: { token, close } });
  if (prev && prev.token !== token) setTimeout(() => prev.close(), 0);
}
function releasePanel(token: object) {
  if (store.active?.token === token) emit({ active: null });
}

/** Close the open record panel, if any (a create or edit form's side panel opening: one panel at a time). */
export function closeRecordPanel() {
  store.active?.close();
}

const InPanel = createContext(false);
/** Whether this renders inside a record panel's body (a form there opens in place, never in a second panel). */
export function useInRecordPanel(): boolean {
  return useContext(InPanel);
}
const PanelFull = createContext(false);
/** The width (px) from which a panel at the list's full width has room for every tab (a phone's full-width panel has not). */
const ROOMY = 768;
/** mold_v0-293: whether the record panel this renders in fills the list's width and has room (Expand on a wide screen). */
export function useRecordPanelFull(): boolean {
  return useContext(PanelFull);
}

// ---------------------------------------------------------------------------------------------------- unsaved changes

/** What has unsaved changes: each guard answers with what it would lose, or null. */
const guards = new Map<object, () => string | null>();
const unsaved = () => { for (const g of guards.values()) { const w = g(); if (w) return w; } return null; };

/** Editors: while `dirty`, closing the panel or switching to another row asks first ("Discard unsaved changes?"). */
export function usePanelGuard(dirty: boolean, what = 'your changes') {
  const token = useRef({});
  useEffect(() => {
    const t = token.current;
    if (!dirty) return;
    guards.set(t, () => what);
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => { guards.delete(t); window.removeEventListener('beforeunload', onUnload); };
  }, [dirty, what]);
}

/** Run `fn` now, or after "Discard changes" when an editor in the panel has unsaved changes. */
export function guarded(fn: () => void) {
  if (!unsaved()) return fn();
  emit({ pending: fn });
}

function LeaveDialog() {
  const { pending } = useStore();
  const what = unsaved() ?? 'your changes';
  return (
    <AlertDialog open={!!pending} onOpenChange={(o) => { if (!o) emit({ pending: null }); }}>
      <AlertDialogContent data-testid='unsaved-dialog'>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>You have not saved {what}. Leaving now loses them.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid='unsaved-keep'>Keep editing</AlertDialogCancel>
          <AlertDialogAction variant='destructive' data-testid='unsaved-discard' onClick={() => {
            const fn = store.pending;
            guards.clear();
            emit({ pending: null });
            fn?.();
          }}>Discard changes</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------------------------------- the width

const WIDTH_EVENT = 'record-panel-width';
const memory = new Map<string, number>();
function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}
function subscribeWidth(cb: () => void) {
  window.addEventListener(WIDTH_EVENT, cb);
  window.addEventListener('storage', cb);
  return () => { window.removeEventListener(WIDTH_EVENT, cb); window.removeEventListener('storage', cb); };
}
function useRatio(type: string): [number | null, (r: number) => void] {
  const ratio = useSyncExternalStore(subscribeWidth, () => readSplitRatio(storage(), type) ?? memory.get(type) ?? null, () => null);
  const set = useCallback((r: number) => {
    memory.set(type, r);
    writeSplitRatio(storage(), type, r);
    window.dispatchEvent(new Event(WIDTH_EVENT));
  }, [type]);
  return [ratio, set];
}

function useWidthOf(ref: RefObject<HTMLElement | null>, on: boolean): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    const measure = () => setW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, on]);
  return w;
}

/** The splitter's own width (w-3): the space the panel and the table share is the host's less this. */
const SPLITTER_W = 12;

export interface PanelSplit {
  layout: SplitLayout | null;
  /** The space the panel and the table share, in pixels. */
  space: number;
  setRatio: (r: number) => void;
}

/** The open panel's layout in the host `hostRef` (the list): its width, remembered per `type`, or the whole space. */
export function usePanelSplit(hostRef: RefObject<HTMLElement | null>, open: boolean, type: string, kind: PanelKind, expanded: boolean): PanelSplit {
  const [ratio, setRatio] = useRatio(type);
  const w = useWidthOf(hostRef, open);
  const space = Math.max(0, w - SPLITTER_W);
  return { layout: open && w ? splitLayout(space, ratio, kind, expanded) : null, space, setRatio };
}

/** The bar between the table and the panel: drag it, or focus it and use ← → (Shift: further), Home, End. */
function PanelSplitter({ width, min, max, setWidth, onResizing, controls, forKey }: {
  width: number; min: number; max: number; setWidth: (w: number) => void; onResizing: (on: boolean) => void; controls: string;
  forKey: (key: string, shift: boolean, w: number) => number | null;
}) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [active, setActive] = useState(false);
  const end = () => { drag.current = null; setActive(false); onResizing(false); };
  return (
    <div role='separator' aria-orientation='vertical' aria-label='Resize the panel' aria-valuemin={min} aria-valuemax={max} aria-valuenow={width}
      aria-controls={controls} tabIndex={0} title='Drag to resize (or focus and use the arrow keys)' data-resizing={active ? 'true' : undefined}
      data-testid='detail-panel-resize'
      className='group relative hidden w-3 shrink-0 cursor-col-resize touch-none justify-center outline-none select-none lg:flex'
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: width };
        setActive(true);
        onResizing(true);
      }}
      onPointerMove={(e) => { if (drag.current) setWidth(drag.current.w + drag.current.x - e.clientX); }}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={() => drag.current && end()}
      onKeyDown={(e) => {
        const next = forKey(e.key, e.shiftKey, width);
        if (next === null) return;
        e.preventDefault();
        e.stopPropagation();
        setWidth(next);
      }}>
      <span className='bg-border group-hover:bg-primary/50 group-focus-visible:bg-primary group-data-resizing:bg-primary my-1 w-px transition-colors' />
      <span className='bg-background border-border group-hover:border-primary/60 group-focus-visible:border-primary group-focus-visible:ring-ring/50 group-data-resizing:border-primary absolute top-1/2 h-10 w-1.5 -translate-y-1/2 rounded-full border transition-colors group-focus-visible:ring-2' />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- the ⋯ menu

/** The "⋯" actions menu of a record panel's header: every action of the record as a labelled item (a link opens its page). */
export function PanelMenu({ items, name }: { items: readonly RowAction[]; name?: string }) {
  if (!items.length) return null;
  const label = name ? `Actions for ${name}` : 'Actions';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant='outline' size='icon' aria-label={label} title='Actions' data-panel-action='menu' data-testid='panel-actions' className='shrink-0' />}>
        <Icons.dots aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-64' data-testid='panel-actions-menu'>
        {items.map((a, i) => {
          const cls = cn(a.destructive && 'text-destructive focus:text-destructive');
          const body = (<>{a.icon}<span className='min-w-0 flex-1 truncate'>{a.label}</span>
            {a.hint && <span className='text-muted-foreground ml-auto pl-3 text-xs'>{a.hint}</span>}</>);
          return (
            <span key={i} className='contents'>
              {a.separator && i > 0 && <DropdownMenuSeparator />}
              {a.href && !a.disabled
                ? <DropdownMenuItem className={cls} render={<Link href={a.href} />} onClick={a.onSelect} data-panel-item={a.label}>{body}</DropdownMenuItem>
                : <DropdownMenuItem className={cls} disabled={a.disabled} onClick={a.onSelect} data-panel-item={a.label}>{body}</DropdownMenuItem>}
            </span>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------------------------------- the panel

/** Something open over the page that owns Esc for now (a dialog, a menu, a list box). */
const overlayOpen = () => !!document.querySelector('[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-side-panel-root]');

export interface RecordPanelProps {
  /** The list it opens beside (Esc there closes it too). */
  hostRef: RefObject<HTMLElement | null>;
  split: PanelSplit;
  /** The remembered width's key. */
  type: string;
  title: ReactNode;
  /** The panel's name in words (its region's label, the "⋯" label). */
  name: string;
  /** The open row's key: focus goes back to its row when the panel closes, and unsaved changes are its own. */
  rowKey: string;
  /** The header's "⋯" items; or `menu`, a menu of its own (a component reading its own data), given those items. */
  items: readonly RowAction[];
  menu?: ReactNode;
  expanded: boolean;
  onExpandedChange: (v: boolean) => void;
  /** Close it (the panel asks first when something is unsaved, then returns focus to the row). */
  onClose: () => void;
  /** Gives the list the guarded close (its own Esc, a row's action). */
  closeRef?: (close: () => void) => void;
  children: ReactNode;
}

export function RecordPanel({ hostRef, split, type, title, name, rowKey, items, menu, expanded, onExpandedChange, onClose, closeRef, children }: RecordPanelProps) {
  const [token] = useState(() => ({}));
  const panelRef = useRef<HTMLElement | null>(null);
  const [resizing, setResizing] = useState(false);
  const latest = useRef({ onClose, rowKey });
  useLayoutEffect(() => { latest.current = { onClose, rowKey }; });

  const close = useCallback(() => {
    guarded(() => {
      const key = latest.current.rowKey;
      latest.current.onClose();
      requestAnimationFrame(() => {
        const row = hostRef.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`);
        if (row?.isConnected) row.focus({ preventScroll: false });
      });
    });
  }, [hostRef]);
  useLayoutEffect(() => { closeRef?.(close); }, [closeRef, close]);
  useEffect(() => {
    claimPanel(token, () => latest.current.onClose());
    return () => releasePanel(token);
  }, [token]);

  // Anything typed into a form in the body is unsaved until the form is sent (or it is gone).
  const edited = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    edited.current = null;
    const t = {};
    guards.set(t, () => (edited.current?.isConnected && panelRef.current?.contains(edited.current) ? 'what you typed in this panel' : null));
    return () => { guards.delete(t); };
  }, [rowKey]);
  const onEdit = (e: React.SyntheticEvent) => {
    const el = e.target as HTMLElement;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
    if (el instanceof HTMLInputElement && el.type === 'search') return;
    const f = el.closest('form');
    if (f) edited.current = f;
  };

  // Esc closes it while focus is in it or in its list (not while a dialog or menu is open over the page).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || overlayOpen()) return;
      const a = e.target instanceof Element ? e.target : document.activeElement;
      const inside = !a || a === document.body || a === document.documentElement || panelRef.current?.contains(a) || hostRef.current?.contains(a);
      if (!inside) return;
      e.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [hostRef, close]);

  const layout = split.layout;
  const full = !!layout?.full, auto = !!layout?.auto;
  const panelId = `record-panel-${type.replace(/[^\w-]/g, '-')}`;
  return (<>
    {layout && !full && (
      <PanelSplitter width={layout.width} min={layout.min} max={layout.max} controls={panelId} onResizing={setResizing}
        setWidth={(w) => split.setRatio(ratioOf(w, split.space))} forKey={(k, s, w) => splitWidthForKey(k, s, w, split.space)} />
    )}
    <aside id={panelId} data-slot='detail-panel-host' data-full={full ? (auto ? 'auto' : 'expanded') : undefined} data-resizing={resizing || undefined}
      style={{ '--panel-w': layout && !full ? `${layout.width}px` : undefined } as CSSProperties}
      className={cn(
        // Below lg: a full-width layer under the top bar. From lg: a column beside the table (or all of it, expanded).
        'bg-background fixed inset-x-0 top-16 bottom-0 z-30 flex min-h-0 flex-col md:top-14',
        'lg:static lg:z-auto lg:h-full lg:bg-transparent',
        full ? 'lg:min-w-0 lg:flex-1' : 'lg:w-(--panel-w) lg:shrink-0',
        !resizing && 'lg:transition-[width] lg:duration-200 lg:ease-out motion-reduce:transition-none'
      )}>
      <section ref={panelRef} aria-label={name} data-slot='detail-panel' data-testid='detail-panel' data-row={rowKey} data-expanded={expanded || undefined}
        className='relative flex h-full min-h-0 w-full flex-col lg:pt-3.5 lg:pr-3.5'>
        <div className='bg-background text-foreground flex min-h-0 w-full flex-1 flex-col overflow-hidden text-sm lg:rounded-lg lg:border lg:shadow-sm' data-slot='detail-panel-card'>
          <div className='flex shrink-0 items-start gap-2 border-b py-2.5 pl-3 max-lg:flex-wrap max-lg:pr-14 md:pl-4 lg:pr-5' data-slot='detail-panel-header'>
            <Button variant='ghost' size='sm' className='-ml-1 shrink-0 lg:hidden' onClick={close} data-testid='detail-panel-back'>
              <IconArrowLeft aria-hidden /> Back to list
            </Button>
            <div className='min-w-0 flex-1 max-lg:order-last max-lg:basis-full' data-slot='detail-panel-heading'>
              <h2 className='flex min-w-0 flex-wrap items-center gap-2 text-base leading-tight font-semibold tracking-tight break-words' data-testid='detail-panel-title'>{title}</h2>
            </div>
            {/* Right: only the labelled Expand / Collapse and the "⋯" actions menu. */}
            <div className='ml-auto flex shrink-0 items-center gap-1' data-slot='detail-panel-controls'>
              {!auto && (
                <Button variant='outline' className='max-lg:hidden' onClick={() => onExpandedChange(!expanded)} aria-pressed={expanded}
                  data-panel-action='expand' data-testid='detail-panel-expand'>
                  {expanded ? <IconArrowsMinimize aria-hidden /> : <IconArrowsMaximize aria-hidden />}
                  {expanded ? 'Collapse' : 'Expand'}
                </Button>
              )}
              {menu ?? <PanelMenu items={items} name={name} />}
            </div>
          </div>
          <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 md:px-6' data-slot='detail-panel-body'
            onInput={onEdit} onChange={onEdit} onSubmit={() => { edited.current = null; }}>
            <InPanel.Provider value><PanelFull.Provider value={full && split.space >= ROOMY}>{children}</PanelFull.Provider></InPanel.Provider>
          </div>
        </div>
        <Button variant='outline' size='icon'
          className={cn('bg-background text-muted-foreground hover:text-foreground absolute z-10 rounded-full shadow-sm',
            'top-2 right-[max(0.75rem,env(safe-area-inset-right))] size-9 lg:top-0 lg:right-0 lg:size-7 [&_svg]:size-4')}
          aria-label='Close panel' title='Close (Esc)' onClick={close} data-panel-action='close' data-testid='detail-panel-close'>
          <IconX aria-hidden />
        </Button>
        <LeaveDialog />
      </section>
    </aside>
  </>);
}

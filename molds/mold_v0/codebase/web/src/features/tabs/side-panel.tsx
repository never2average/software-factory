'use client';
// A create or edit form in a side panel (mold_v0-256, flag side_panel_forms, off by default; the operator's call): a
// FormHost around a list or a record's page says where its card opens; CardForm (./tab-action.tsx) draws SidePanelForm
// in the card's place while it is in the panel. Kept apart from tab-action.tsx, whose list actions stay full in-page
// cards with nothing fixed and no dialog (mold_v0-217): this module is the one place a form floats over the page.
import { createContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { featureOn } from '@/config/features';
import { ConfirmDialog } from '@/features/admin/ui';
import type { CardContext } from './tab-action';

/** Where the open form is: the FormHost around a list or a page says whether its card opens in the side panel. */
export const PanelCtx = createContext<{ inPanel: boolean; expand: () => void } | null>(null);

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
export function SidePanelForm({ c, form, onSubmit, submit, children }: {
  c: CardContext; form: React.RefObject<HTMLFormElement | null>; onSubmit: () => unknown; submit: ReactNode; children: ReactNode;
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


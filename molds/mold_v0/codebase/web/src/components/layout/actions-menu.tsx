'use client';
// The list's "Actions ▾" (mold_v0-294): one outlined button, its label kept at every width, holding every secondary
// action of a tab's search row: the page's own, then Import and Export (an export with several formats is a submenu),
// then Ask AI, each group set off by a separator (lib/toolbar-actions.ts sets the order). No button when it is empty.
// Ask AI asks the assistant about the list as shown (src/list-answers.ts): its name, search, filters and visible rows,
// read-only, through the same models and limits as the Cmd+K bar's answers. It shows only when a model is configured
// (GET …/list/answer), and only on pages the person can already read (the request goes through their own door).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { Markdown } from '@/components/markdown';
import { Spinner } from '@/components/ui/spinner';
import { Icons } from '@/components/icons';
import { useNav } from '@/components/layout/nav-context';
import type { RowAction } from '@/components/layout/record-filters';
import { ADMIN_HEADERS } from '@/lib/env-names';
import { actionsItems, type ListAskContext } from '@/lib/toolbar-actions';
import { cn } from '@/lib/utils';

const apiBase = (area: string) => (area === 'admin' ? '/api/admin/onboarding' : '/api/app');

/** Whether Ask AI can answer here (a model is configured): asked once per area and visit. */
const availability = new Map<string, Promise<boolean>>();
export function useAskAvailable(): boolean {
  const { area } = useNav();
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    let p = availability.get(area);
    if (!p) {
      p = fetch(`${apiBase(area)}/list/answer`, { credentials: 'same-origin', headers: { accept: 'application/json', ...(area === 'admin' ? ADMIN_HEADERS : {}) } })
        .then(async (r) => (r.ok ? Boolean(((await r.json()) as { available?: boolean }).available) : false)).catch(() => false);
      availability.set(area, p);
    }
    void p.then((v) => { if (live) setOn(v); });
    return () => { live = false; };
  }, [area]);
  return on;
}

function Item({ a }: { a: RowAction }) {
  if (a.items?.length) {
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={a.disabled} data-testid={a.testId}>{a.icon}{a.label}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className='w-56'>{a.items.map((x, i) => <Item key={i} a={x} />)}</DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }
  return (
    <DropdownMenuItem disabled={a.disabled} onClick={a.onSelect} data-testid={a.testId} render={a.href && !a.disabled ? <Link href={a.href} /> : undefined}
      className={cn(a.destructive && 'text-destructive focus:text-destructive')}>
      {a.icon}{a.label}
      {a.hint && <span className='text-muted-foreground ml-auto pl-3 text-xs'>{a.hint}</span>}
    </DropdownMenuItem>
  );
}

/**
 * "Actions ▾": the page's own secondary actions, Import, Export and Ask AI (`ask`: opens the list's Ask AI; hidden when
 * no model is configured). Nothing when there is nothing to hold.
 */
export function ActionsMenu({ page, imports, exports, ask, busy, className }: {
  page?: readonly RowAction[]; imports?: readonly RowAction[]; exports?: readonly RowAction[]; ask?: (() => void) | null; busy?: boolean; className?: string;
}) {
  const available = useAskAvailable();
  const askItem: RowAction | null = ask && available
    ? { label: 'Ask AI', icon: <Icons.sparkles className='text-primary' />, onSelect: ask, testId: 'list-ask-ai' } : null;
  const items = actionsItems({ page, imports, exports, ask: askItem });
  if (!items.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant='outline' data-testid='list-actions' aria-busy={busy || undefined} className={cn('shrink-0', className)} />}>
        {busy && <Icons.spinner aria-hidden className='animate-spin' />}
        Actions
        <Icons.chevronDown aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-64' data-testid='list-actions-menu'>
        {items.map((a, i) => (
          <span key={i} className='contents'>
            {a.separator && i > 0 && <DropdownMenuSeparator />}
            <Item a={a} />
          </span>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type StreamEvent = { type: 'delta'; text: string } | { type: 'reset' } | { type: 'done'; answer: string | null; model: string | null; reason: 'daily_cap' | 'rate_limited' | 'unavailable' | null };
const NO_ANSWER: Record<string, string> = {
  daily_cap: "No answer: today's limit for AI answers is reached.",
  rate_limited: 'No answer: that was a lot of questions in a minute, try again shortly.',
  unavailable: 'No answer: no model answered. Try again in a moment.',
};
const SUGGESTIONS = ['Summarise this view', 'What stands out?', 'Which rows need attention?'];

/**
 * Ask AI about a list: suggestions, a question box, and the answer as it streams in. `context` is read when the
 * question is sent (the view as it is then). Used docked beside a list (RecordView's panel) and in ListAskSheet.
 */
export function ListAskPanel({ context }: { context: () => ListAskContext }) {
  const { area } = useNav();
  const [q, setQ] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [done, setDone] = useState<Extract<StreamEvent, { type: 'done' }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);
  const ask = (question: string) => {
    const question2 = question.trim();
    if (question2.length < 3) return;
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setAsked(question2); setText(''); setDone(null); setError(null); setQ('');
    (async () => {
      const res = await fetch(`${apiBase(area)}/list/answer/stream`, {
        method: 'POST', credentials: 'same-origin', signal: c.signal, body: JSON.stringify({ question: question2, list: context() }),
        headers: { 'Content-Type': 'application/json', accept: 'text/event-stream', ...(area === 'admin' ? ADMIN_HEADERS : {}) },
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Request failed (${res.status})`);
      const reader = res.body!.getReader(), decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, cut).split('\n').find((l) => l.startsWith('data:'));
          buf = buf.slice(cut + 2);
          if (!line) continue;
          const e = JSON.parse(line.slice(5)) as StreamEvent;
          if (e.type === 'delta') setText((s) => s + e.text);
          else if (e.type === 'reset') setText('');
          else { setDone(e); setText(e.answer ?? ''); }
        }
      }
    })().catch((e: Error) => { if (e.name !== 'AbortError') setError(e.message); });
  };
  const streaming = !!asked && !done && !error;
  const ctx = context();
  return (
    <div className='flex min-h-full flex-col gap-3' data-testid='list-ask-panel'>
      <p className='text-muted-foreground text-xs'>
        About {ctx.list}: {Math.min(ctx.rows.length, ctx.total)} of {ctx.total} {ctx.total === 1 ? 'row' : 'rows'} in view{ctx.search ? `, search “${ctx.search}”` : ''}{ctx.filters.length ? `, ${ctx.filters.length} ${ctx.filters.length === 1 ? 'filter' : 'filters'}` : ''}. Read-only.
      </p>
      {asked && <div className='bg-muted self-end rounded-lg px-3 py-2 text-sm'>{asked}</div>}
      <div className='flex-1' aria-live='polite' aria-busy={streaming}>
        {error ? <p className='text-destructive text-sm'>{error}</p>
          : text ? <Markdown className='max-w-none text-sm [&_p]:my-2 [&_p]:leading-6 [&_ul]:my-2'>{text}</Markdown>
          : streaming ? <div className='text-muted-foreground flex items-center gap-2 text-sm' role='status'><Spinner className='size-4' /> Reading the list…</div>
          : done ? <p className='text-muted-foreground text-sm'>{NO_ANSWER[done.reason ?? 'unavailable']}</p> : null}
        {done?.answer && <p className='text-muted-foreground mt-2 text-xs'>AI answer from the rows shown — may be imperfect{done.model ? ` (${done.model})` : ''}.</p>}
      </div>
      <div className='flex flex-wrap gap-1.5'>
        {SUGGESTIONS.map((s) => <Button key={s} type='button' variant='outline' size='xs' disabled={streaming} onClick={() => ask(s)}>{s}</Button>)}
      </div>
      <form className='relative' onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <Textarea value={q} onChange={(e) => setQ(e.target.value)} maxLength={400} rows={3} aria-label='Your question' placeholder={`Ask about ${ctx.list}…`} className='pr-12'
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(q); } }} data-testid='list-ask-input' />
        <Button type='submit' size='icon-sm' aria-label='Ask' disabled={streaming || q.trim().length < 3} className='absolute right-2 bottom-2'><Icons.arrowUp /></Button>
      </form>
    </div>
  );
}

/** Ask AI beside a list that is not a RecordView (a tab's own toolbar): the panel in a sheet at the right. */
export function useListAsk(context: () => ListAskContext): { open: () => void; sheet: ReactNode } {
  const [open, setOpen] = useState(false);
  return {
    open: () => setOpen(true),
    sheet: (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side='right' className='w-full gap-0 sm:max-w-md'>
          <SheetHeader className='border-b'>
            <SheetTitle className='flex items-center gap-2'><Icons.sparkles className='text-primary size-4' /> Ask AI</SheetTitle>
            <SheetDescription className='sr-only'>Questions about this list, answered from the rows shown.</SheetDescription>
          </SheetHeader>
          <div className='flex-1 overflow-y-auto p-4'>{open && <ListAskPanel context={context} />}</div>
        </SheetContent>
      </Sheet>
    ),
  };
}

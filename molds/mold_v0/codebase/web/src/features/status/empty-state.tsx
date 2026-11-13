// The console's one empty state (mold_v0-298): a title ("No invoices yet."), a sentence saying why or what fills it, and
// the next step (a link or a button of the caller's own). Drawn as the tab pages' empty state is (features/tabs/empty.tsx:
// a dashed box, an inbox icon, a section named by its title when given an id), so a list, a tab and a page read the same when there is
// nothing. RecordView draws its `empty` through it (components/layout/record-view.tsx); a plain sentence passed there is
// split into its title and the rest (emptyNoteOf).
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** What an empty list or page says: its title, a sentence under it, and its next step (a link, or a node of the caller's). */
export interface EmptyNote {
  title: string;
  text?: ReactNode;
  action?: { label: string; href: string } | ReactNode;
}

const isLink = (a: unknown): a is { label: string; href: string } =>
  !!a && typeof a === 'object' && !('$$typeof' in (a as object)) && typeof (a as { href?: unknown }).href === 'string' && typeof (a as { label?: unknown }).label === 'string';

/** Whether a value is an EmptyNote (an object with a title), rather than a node to draw as it is. */
export const isEmptyNote = (v: unknown): v is EmptyNote =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !('$$typeof' in (v as object)) && typeof (v as { title?: unknown }).title === 'string';

// The title ends at the first sentence end that is followed by a capital letter or a digit, so "e.g. ", "i.e. " or
// "approx. 3" never cut a sentence in two; words with no such break stay one title.
/** A plain sentence as a note: its first sentence the title, the rest the line under it ("No accounts yet. Approve a request." ). */
export function emptyNoteOf(words: string): EmptyNote {
  const t = words.trim();
  const m = t.match(/^(.+?(?<!\b(?:e\.g|i\.e|etc|vs|approx|incl))[.!?])\s+([A-Z0-9"'(][\s\S]*)$/);
  return m ? { title: m[1], text: m[2] } : { title: t };
}

export function EmptyNotice({ note, id, className }: { note: EmptyNote; id?: string; className?: string }) {
  const { title, text, action } = note;
  const external = isLink(action) && /^(https:|mailto:)/i.test(action.href);
  // mold_v0-298: with an id it is a section named by its heading (as the tab pages'); without one (a list's empty state)
  // a plain box with a paragraph title, so a screen reader hears the title once and no landmark or heading is added.
  const Box = id ? 'section' : 'div';
  const Title = id ? 'h3' : 'p';
  return (
    <Box aria-labelledby={id ? `${id}-title` : undefined} data-empty-state=''
      className={cn('flex flex-col items-start gap-3 rounded-lg border border-dashed p-6 text-left', className)}>
      <div className='flex items-start gap-3'>
        <Icons.inbox aria-hidden className='text-muted-foreground mt-0.5 size-5 shrink-0' />
        <div className='flex flex-col gap-1'>
          <Title id={id ? `${id}-title` : undefined} className='text-foreground text-sm font-medium'>{title}</Title>
          {text && <p className='text-muted-foreground max-w-prose text-sm'>{text}</p>}
        </div>
      </div>
      {isLink(action) ? (
        // mold_v0-298: a path of this site moves in the page (no full reload); an outside address opens as a plain link.
        <Button variant='outline' size='sm' className='ml-8' nativeButton={false}
          render={external || !action.href.startsWith('/') ? <a href={action.href} {...(external ? { rel: 'noopener noreferrer' } : {})} /> : <Link href={action.href} />}>
          {action.label}
        </Button>
      ) : action ? <div className='ml-8 flex flex-wrap items-center gap-2'>{action}</div> : null}
    </Box>
  );
}

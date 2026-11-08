'use client';

import * as React from 'react';

import { useScrollsSideways } from '@/hooks/use-scrolls-sideways';
import { cn } from '@/lib/utils';

/**
 * A table in a container that scrolls sideways when the table is wider than the page. While it scrolls, the container
 * is a labelled region a keyboard can reach (tabindex 0), so its hidden columns can be scrolled to with the arrow keys
 * (WCAG 2.1.1; axe `scrollable-region-focusable`, mold_v0-114). `label` names it ("Findings"); without one, "Table".
 */
/**
 * A list with nothing in it (operator, 2026-11-08): when the body's only row is one cell spanning the table (the empty,
 * loading or "nothing matches" message every list draws), the table fills the area below its headings and the message
 * sits centred in it, in every table of the console, with no change at the call sites.
 */
const EMPTY = 'has-[tbody>tr:only-child>td[colspan]:only-child]';
const EMPTY_FILL = `${EMPTY}:h-full`;
const EMPTY_ROW = '[&_tbody>tr:only-child:has(>td[colspan]:only-child)]:h-full [&_tbody>tr:only-child>td[colspan]:only-child]:text-center [&_tbody>tr:only-child>td[colspan]:only-child]:align-middle [&_tbody>tr:only-child>td[colspan]:only-child]:whitespace-normal [&_tbody>tr:only-child:has(>td[colspan]:only-child)]:hover:bg-transparent';

function Table({ className, label, ...props }: React.ComponentProps<'table'> & { label?: string }) {
  const { ref, scrollRegion } = useScrollsSideways<HTMLDivElement>();
  return (
    <div ref={ref} data-slot='table-container' {...scrollRegion(label ?? 'Table')}
      className={cn('focus-visible:ring-ring/50 relative w-full overflow-x-auto rounded-sm outline-none focus-visible:ring-[3px]', EMPTY_FILL)}>
      <table
        data-slot='table'
        className={cn('w-full caption-bottom text-sm', EMPTY_FILL, EMPTY_ROW, className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot='table-header' className={cn('[&_tr]:border-b', className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot='table-body'
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot='table-footer'
      className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot='table-row'
      className={cn(
        'border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted',
        className
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot='table-head'
      className={cn(
        'h-10 border-r border-foreground/15 px-2 text-left align-middle leading-none font-medium whitespace-nowrap text-foreground last:border-r-0 [&:has([role=checkbox])]:pr-0',
        className
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot='table-cell'
      className={cn('border-r border-foreground/15 p-2 align-middle leading-none whitespace-nowrap last:border-r-0 [&:has([role=checkbox])]:pr-0', className)}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption
      data-slot='table-caption'
      className={cn('mt-4 text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };

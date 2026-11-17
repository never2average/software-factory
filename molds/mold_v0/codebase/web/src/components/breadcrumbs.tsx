'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useBreadcrumbs } from '@/hooks/use-breadcrumbs';
import { useNavSearch } from '@/hooks/use-active-nav-entry';
import { Icons } from '@/components/icons';
import { AgentIcon } from '@/components/layout/agent-icon';
import { cn } from '@/lib/utils';

/** The agent's pages (mold_v0-243): their heading, the trail's last crumb, carries the agent's own icon (mold_v0-252). */
const AGENT_PAGES: Record<string, 'app' | 'admin'> = { '/app/agent': 'app', '/admin/agent': 'admin' };
/**
 * mold_v0-318: the trail is one line. A middle crumb (between the first and the page's own) is cut at 11rem with an
 * ellipsis, its whole words in its title (hover) and in the page (a screen reader reads them all). When the trail still
 * does not fit, the fewest middle crumbs it takes, from the first, fold into one "…" button that opens a menu of them
 * (the nearest parent stays in sight while it fits); the page's own crumb is cut last, never below 8rem from md up.
 */
const MIDDLE = 'block max-w-44 truncate';
/** The list's gap (gap-1.5) and the "…" button's item: the button (icon-xs), its separator and gaps. */
const FOLD_GAP = 6;
const FOLD_WIDTH = 24 + 4 + 16 + 2 + FOLD_GAP;

export function Breadcrumbs() {
  // mold_v0-298: the page's query too, so the trail's group is the lit sidebar entry's (a files tab's ?store=).
  const [search, searchProbe] = useNavSearch();
  const items = useBreadcrumbs(search);
  const router = useRouter();
  const navRef = useRef<HTMLElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  /** How many middle crumbs are folded into the "…" menu (from the first). */
  const [folded, setFolded] = useState(0);
  const key = items.map((i) => `${i.title}\u0000${i.link ?? ''}`).join('\u0001');
  // Fold when the whole trail (its middle crumbs cut at 11rem) is wider than the room the top bar leaves it: measured on
  // an unseen copy of it (each crumb's width), so folding never changes what is measured.
  useLayoutEffect(() => {
    const nav = navRef.current, probe = probeRef.current;
    if (!nav || !probe) return;
    const check = () => {
      const w = [...probe.children].map((c) => (c as HTMLElement).offsetWidth + FOLD_GAP);
      const room = nav.clientWidth + 0.5, n = w.length;
      if (n <= 2 || w.reduce((a, b) => a + b, 0) <= room) return setFolded(0);
      const middle = w.slice(1, n - 1);
      let k = 1;
      while (k < middle.length && w[0]! + FOLD_WIDTH + middle.slice(k).reduce((a, b) => a + b, 0) + w[n - 1]! > room) k++;
      setFolded(k);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(nav);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (items.length === 0) return searchProbe;

  const last = items.length - 1;
  const middle = items.slice(1, last);
  const hidden = middle.slice(0, folded), shown = middle.slice(folded);
  const sep = <BreadcrumbSeparator className='ml-0.5 shrink-0'><Icons.slash /></BreadcrumbSeparator>;
  // Every child of the list is an item (axe `list`): the earlier crumbs (from tablet width up) are a link and a
  // separator in one item; the current page is its own item.
  const crumb = (item: (typeof items)[number], index: number) => (
    <BreadcrumbItem key={item.link ?? `group:${item.title}`} className={cn(item.keep ? 'inline-flex' : 'hidden md:inline-flex', 'shrink-0')}>
      {/* mold_v0-298: the sidebar group's name leads the trail, a heading with no page of its own: words, no link. */}
      {item.link
        ? <BreadcrumbLink href={item.link} title={item.title} className={MIDDLE}>{item.title}</BreadcrumbLink>
        : <span title={item.title} className={cn('text-muted-foreground', MIDDLE)}>{item.title}</span>}
      {sep}
    </BreadcrumbItem>
  );
  const leaf = items[last]!;
  return (
    <>{searchProbe}<Breadcrumb ref={navRef} className='relative min-w-0 flex-1'>
      {/* mold_v0-290: the kept crumb and the session's number stay on one line in a phone's top bar; mold_v0-318: every trail. */}
      <BreadcrumbList className='min-w-0 flex-nowrap whitespace-nowrap'>
        {last > 0 && crumb(items[0]!, 0)}
        {hidden.length > 0 && (
          <BreadcrumbItem key='folded' className={cn(hidden.some((m) => m.keep) ? 'inline-flex' : 'hidden md:inline-flex', 'shrink-0')} data-breadcrumb-folded=''>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant='outline' size='icon-xs' aria-label={`${hidden.length} more ${hidden.length === 1 ? 'level' : 'levels'}: ${hidden.map((m) => m.title).join(', ')}`} title={hidden.map((m) => m.title).join(' / ')} />}>
                <Icons.moreHorizontal aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align='start' className='w-auto max-w-80' data-testid='breadcrumb-folded-menu'>
                {hidden.map((m) => (
                  <DropdownMenuItem key={m.link ?? `group:${m.title}`} disabled={!m.link} onClick={() => m.link && router.push(m.link)}>
                    <span className='truncate'>{m.title}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {sep}
          </BreadcrumbItem>
        )}
        {shown.map((m, i) => crumb(m, folded + i + 1))}
        <BreadcrumbItem key={leaf.link ?? `group:${leaf.title}`} className='min-w-0 shrink md:min-w-32'>
          {leaf.link && AGENT_PAGES[leaf.link] ? (
            <BreadcrumbPage className='inline-flex items-center gap-1.5' data-agent-heading=''>
              <AgentIcon area={AGENT_PAGES[leaf.link]!} className='size-4.5' />{leaf.title}
            </BreadcrumbPage>
          ) : <BreadcrumbPage className='block min-w-0 truncate' title={leaf.title}>{leaf.title}</BreadcrumbPage>}
        </BreadcrumbItem>
      </BreadcrumbList>
      {/* The unseen copy measured above: the whole trail at its own width (the middle cut as shown), never read out. */}
      <div ref={probeRef} aria-hidden className='pointer-events-none invisible absolute top-0 left-0 flex w-max flex-nowrap items-center gap-1.5 text-sm whitespace-nowrap'>
        {items.map((item, i) => (
          <span key={i} className={cn('inline-flex items-center gap-1', !item.keep && i < last && 'hidden md:inline-flex')}>
            <span className={i < last ? MIDDLE : undefined}>{item.title}</span>
            {i < last && <span className='ml-0.5 inline-flex size-3.5' />}
          </span>
        ))}
      </div>
    </Breadcrumb></>
  );
}

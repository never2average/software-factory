'use client';
// "On this page": the article's h2/h3 headings, with the section being read highlighted as the page scrolls.
import { useEffect, useState } from 'react';
import { IconAlignLeft, IconArrowUp } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import type { DocHeading } from './docs-data';

/** Section numbers: 1, 2, … for h2, and 1.1, 1.2, … for the h3s under them. */
function numbered(headings: DocHeading[]) {
  let h2 = 0, h3 = 0;
  return headings.map((h) => {
    if (h.depth === 3 && h2) return { h, n: `${h2}.${++h3}` };
    h2++; h3 = 0;
    return { h, n: `${h2}.` };
  });
}

export function DocsToc({ headings }: { headings: DocHeading[] }) {
  const [active, setActive] = useState(headings[0]?.id ?? '');

  useEffect(() => {
    const els = headings.map((h) => document.getElementById(h.id)).filter((e): e is HTMLElement => !!e);
    if (!els.length) return;
    // A heading is "read" once it passes the band just under the sticky header; the last one passed is current.
    const visible = new Set<string>();
    const pick = () => {
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) return setActive(els[els.length - 1].id);
      const first = els.find((e) => visible.has(e.id));
      if (first) return setActive(first.id);
      const above = els.filter((e) => e.getBoundingClientRect().top < 96);
      setActive((above.at(-1) ?? els[0]).id);
    };
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target.id);
        else visible.delete(e.target.id);
      }
      pick();
    }, { rootMargin: '-72px 0px -65% 0px', threshold: [0, 1] });
    els.forEach((e) => io.observe(e));
    const onScroll = () => { if (!visible.size) pick(); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { io.disconnect(); window.removeEventListener('scroll', onScroll); };
  }, [headings]);

  if (!headings.length) return null;
  return (
    <nav aria-label='On this page' className='flex flex-col gap-3 text-sm'>
      <div className='text-foreground flex items-center gap-2 text-xs font-semibold tracking-wide uppercase'>
        <IconAlignLeft className='size-3.5' /> On this page
      </div>
      <ul className='flex flex-col'>
        {numbered(headings).map(({ h, n }) => (
          <li key={h.id}>
            <a href={`#${h.id}`} aria-current={active === h.id ? 'location' : undefined}
              onClick={() => setActive(h.id)}
              className={cn('flex gap-2 py-1 leading-snug transition-colors', h.depth === 3 && 'pl-4 text-[13px]',
                active === h.id ? 'text-primary font-medium' : 'text-muted-foreground hover:text-foreground')}>
              <span className='shrink-0 tabular-nums opacity-70'>{n}</span>
              <span>{h.text}</span>
            </a>
          </li>
        ))}
      </ul>
      <a href='#main-content' onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
        className='text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs'>
        <IconArrowUp className='size-3.5' /> Back to top
      </a>
    </nav>
  );
}

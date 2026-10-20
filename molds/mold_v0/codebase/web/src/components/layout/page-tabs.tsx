'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentType } from 'react';
import { cn } from '@/lib/utils';

/** Tabs under a page title where each tab is its own page (a route), e.g. Billing → Plan & payment | Limits. */
export function PageTabs({ items, className }: { items: { href: string; label: string; icon?: ComponentType<{ className?: string }> }[]; className?: string }) {
  const path = usePathname();
  return (
    <nav aria-label='Sections' className={cn('-mt-1 mb-6 flex gap-1 overflow-x-auto border-b', className)}>
      {items.map((t) => {
        const on = path === t.href;
        const Icon = t.icon;
        return (
          <Link key={t.href} href={t.href} aria-current={on ? 'page' : undefined}
            className={cn('-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
              on ? 'border-primary text-foreground' : 'text-muted-foreground hover:text-foreground border-transparent')}>
            {Icon && <Icon className='size-4' />}{t.label}
          </Link>
        );
      })}
    </nav>
  );
}

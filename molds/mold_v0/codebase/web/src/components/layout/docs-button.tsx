'use client';
import Link from 'next/link';
import { useConsolePathname } from '@/lib/console-path';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Icons } from '../icons';
import { useNav } from './nav-context';
import { TOP_BAR_CONTROL, TOP_BAR_LABELLED } from './top-bar';

/**
 * Docs, next to the search box at the top right: this area's guide (/app/docs, or the internal /admin/docs). The search
 * box's height, radius and border at every width (mold_v0-177); on a phone, its icon alone.
 */
export function DocsButton() {
  const pathname = useConsolePathname();
  const { area } = useNav();
  const href = area === 'admin' ? '/admin/docs' : '/app/docs';
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Button variant={active ? 'secondary' : 'outline'} className={cn(TOP_BAR_CONTROL, TOP_BAR_LABELLED)} aria-current={active ? 'page' : undefined}
      render={<Link href={href} aria-label={area === 'admin' ? 'Internal docs' : 'Documentation'} />}>
      <Icons.book /> <span className='hidden md:inline'>Docs</span>
    </Button>
  );
}

/** Admin only, beside Docs: connect an agent to the admin MCP server (/admin/connect). */
export function McpButton() {
  const pathname = useConsolePathname();
  const { area } = useNav();
  if (area !== 'admin') return null;
  const active = pathname === '/admin/connect';
  return (
    <Button variant={active ? 'secondary' : 'outline'} className={cn(TOP_BAR_CONTROL, TOP_BAR_LABELLED)} aria-current={active ? 'page' : undefined}
      render={<Link href='/admin/connect' aria-label='Connect an agent to the admin MCP' />}>
      <Icons.plug /> <span className='hidden md:inline'>MCP</span>
    </Button>
  );
}

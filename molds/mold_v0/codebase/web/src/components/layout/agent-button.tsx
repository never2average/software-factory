'use client';
import Link from 'next/link';
import { useConsolePathname } from '@/lib/console-path';
import { Button } from '@/components/ui/button';
import { featureOn } from '@/config/features';
import { cn } from '@/lib/utils';
import { Icons } from '../icons';
import { useNav } from './nav-context';
import { TOP_BAR_CONTROL } from './top-bar';

/**
 * The workspace agent (mold_v0-243): the top bar's last item, after Search, Docs and the theme switcher, one icon button
 * that opens the agent as a full page of the console (/app/agent; staff: /admin/agent), never a dialog or a side sheet.
 * Not drawn at all while the app's profile leaves `agent_harness` off. Its look is the shared outline variant's
 * (mold_v0-251), its page open shown by that variant's aria-current state: nothing here styles the icon itself.
 */
export function AgentButton() {
  const pathname = useConsolePathname();
  const { area } = useNav();
  if (!featureOn('agent_harness')) return null;
  const href = area === 'admin' ? '/admin/agent' : '/app/agent';
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Button variant='outline' className={cn(TOP_BAR_CONTROL)} aria-current={active ? 'page' : undefined}
      data-agent-button='' title='Workspace agent' render={<Link href={href} aria-label='Workspace agent' />}>
      <Icons.agent />
    </Button>
  );
}

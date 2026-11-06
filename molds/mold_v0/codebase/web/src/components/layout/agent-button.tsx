'use client';
import Link from 'next/link';
import { useConsolePathname } from '@/lib/console-path';
import { Button } from '@/components/ui/button';
import { featureOn } from '@/config/features';
import { cn } from '@/lib/utils';
import { AgentIcon } from './agent-icon';
import { useNav } from './nav-context';
import { TOP_BAR_CONTROL } from './top-bar';

/**
 * The workspace agent (mold_v0-243): the top bar's last item, after Search, Docs and the theme switcher, one icon button
 * that opens the agent as a full page of the console (/app/agent; staff: /admin/agent), never a dialog or a side sheet.
 * Not drawn at all while the app's profile leaves `agent_harness` off. The shared outline variant (no styling of its own
 * here); its icon is the workspace's own, else the app's, else the default (agent-icon.tsx, mold_v0-252), 18 px, centred.
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
      <AgentIcon area={area === 'admin' ? 'admin' : 'app'} className='size-4.5' />
    </Button>
  );
}

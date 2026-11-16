'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { packTabs } from '@/config/pack-nav.generated';
import { agentHref, resolveOpenedFrom } from '@/features/agent/composer/quick-commands';
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
 * Not drawn at all while the app's profile leaves `agent_harness` off. Its look is the shared outline variant's
 * (mold_v0-251), its page open shown by that variant's aria-current state. Its icon is the workspace's own, else the
 * app's, else the default (agent-icon.tsx, mold_v0-252), 18 px, centred.
 * mold_v0-316 (flag agent_quick_commands): on a tab's page (a record's page too) it opens a new chat from that page,
 * /app/agent?new=1&from=<tab>[&record=<area>/<key>], so the blank screen and the "/" menu offer that page's examples and
 * commands; elsewhere (and in /admin) the Agents page itself.
 */
export function AgentButton() {
  const pathname = useConsolePathname();
  const { area } = useNav();
  const on = featureOn('agent_harness');
  const base = area === 'admin' ? '/admin/agent' : '/app/agent';
  // The page's query (a files tab's ?store=, a Settings tab's ?tab=) is read in the browser, after the first paint.
  const [search, setSearch] = useState('');
  useEffect(() => { setSearch(window.location.search); }, [pathname]);
  const quick = area !== 'admin' && featureOn('agent_quick_commands');
  const href = quick ? agentHref(base, resolveOpenedFrom(pathname, search, packTabs)) : base;
  const active = pathname === base || pathname.startsWith(`${base}/`);
  if (!on) return null;
  return (
    <Button variant='outline' className={cn(TOP_BAR_CONTROL)} aria-current={active ? 'page' : undefined}
      data-agent-button='' title='Workspace agent' render={<Link href={href} aria-label='Workspace agent' />}>
      <AgentIcon area={area === 'admin' ? 'admin' : 'app'} className='size-4.5' />
    </Button>
  );
}

'use client';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from '@/components/ui/breadcrumb';
import { useBreadcrumbs } from '@/hooks/use-breadcrumbs';
import { Icons } from '@/components/icons';
import { AgentIcon } from '@/components/layout/agent-icon';

/** The agent's pages (mold_v0-243): their heading, the trail's last crumb, carries the agent's own icon (mold_v0-252). */
const AGENT_PAGES: Record<string, 'app' | 'admin'> = { '/app/agent': 'app', '/admin/agent': 'admin' };

export function Breadcrumbs() {
  const items = useBreadcrumbs();
  if (items.length === 0) return null;

  // Every child of the list is an item (axe `list`): the earlier crumbs (from tablet width up) are a link and a
  // separator in one item; the current page is its own item.
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {items.map((item, index) =>
          index < items.length - 1 ? (
            <BreadcrumbItem key={item.link} className='hidden md:inline-flex'>
              <BreadcrumbLink href={item.link}>{item.title}</BreadcrumbLink>
              <BreadcrumbSeparator className='ml-0.5'>
                <Icons.slash />
              </BreadcrumbSeparator>
            </BreadcrumbItem>
          ) : (
            <BreadcrumbItem key={item.link}>
              {AGENT_PAGES[item.link] ? (
                <BreadcrumbPage className='inline-flex items-center gap-1.5' data-agent-heading=''>
                  <AgentIcon area={AGENT_PAGES[item.link]} className='size-4.5' />{item.title}
                </BreadcrumbPage>
              ) : <BreadcrumbPage>{item.title}</BreadcrumbPage>}
            </BreadcrumbItem>
          )
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

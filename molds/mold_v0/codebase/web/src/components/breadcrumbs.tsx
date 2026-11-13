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
import { useNavSearch } from '@/hooks/use-active-nav-entry';
import { Icons } from '@/components/icons';
import { AgentIcon } from '@/components/layout/agent-icon';

/** The agent's pages (mold_v0-243): their heading, the trail's last crumb, carries the agent's own icon (mold_v0-252). */
const AGENT_PAGES: Record<string, 'app' | 'admin'> = { '/app/agent': 'app', '/admin/agent': 'admin' };

export function Breadcrumbs() {
  // mold_v0-298: the page's query too, so the trail's group is the lit sidebar entry's (a files tab's ?store=).
  const [search, searchProbe] = useNavSearch();
  const items = useBreadcrumbs(search);
  if (items.length === 0) return searchProbe;

  // Every child of the list is an item (axe `list`): the earlier crumbs (from tablet width up) are a link and a
  // separator in one item; the current page is its own item.
  return (
    <>{searchProbe}<Breadcrumb>
      {/* mold_v0-290: the kept crumb and the session's number stay on one line in a phone's top bar. */}
      <BreadcrumbList className={items.some((i) => i.keep) ? 'flex-nowrap whitespace-nowrap' : undefined}>
        {items.map((item, index) =>
          index < items.length - 1 ? (
            <BreadcrumbItem key={item.link ?? `group:${item.title}`} className={item.keep ? 'inline-flex' : 'hidden md:inline-flex'}>
              {/* mold_v0-298: the sidebar group's name leads the trail, a heading with no page of its own: words, no link. */}
              {item.link ? <BreadcrumbLink href={item.link}>{item.title}</BreadcrumbLink> : <span className='text-muted-foreground'>{item.title}</span>}
              <BreadcrumbSeparator className='ml-0.5'>
                <Icons.slash />
              </BreadcrumbSeparator>
            </BreadcrumbItem>
          ) : (
            <BreadcrumbItem key={item.link ?? `group:${item.title}`}>
              {item.link && AGENT_PAGES[item.link] ? (
                <BreadcrumbPage className='inline-flex items-center gap-1.5' data-agent-heading=''>
                  <AgentIcon area={AGENT_PAGES[item.link]!} className='size-4.5' />{item.title}
                </BreadcrumbPage>
              ) : <BreadcrumbPage>{item.title}</BreadcrumbPage>}
            </BreadcrumbItem>
          )
        )}
      </BreadcrumbList>
    </Breadcrumb></>
  );
}

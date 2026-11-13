'use client';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail
} from '@/components/ui/sidebar';
import { UserAvatarProfile } from '@/components/user-avatar-profile';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useClerk, useUser } from '@/lib/auth';
import { useActiveNavEntry, useNavSearch } from '@/hooks/use-active-nav-entry';
import Link from 'next/link';
import { useConsolePathname } from '@/lib/console-path';
import * as React from 'react';
import { Icons } from '../icons';
import { OrgSwitcher } from '../org-switcher';
import { useNav } from './nav-context';
import { BrandMark } from '@/components/brand';
import { profile } from '@/config/profile.generated';
import { cn } from '@/lib/utils';

/** Platform admins (platform staff) get a switch between the customer portal and /admin; nobody else sees it. */
function usePlatformAdmin(area: string) {
  const [is, setIs] = React.useState(area === 'admin');
  React.useEffect(() => {
    if (area === 'admin') return;
    let live = true;
    fetch('/admin/session', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null)).then((b) => { if (live) setIs(Boolean(b?.is_platform_admin)); }).catch(() => {});
    return () => { live = false; };
  }, [area]);
  return is;
}

/** An active entry stands out (mold_v0-213): the brand's colour behind it, its words in it (mold_v0-216: no bar at its edge). */
const ACTIVE = 'data-active:bg-primary/10 data-active:text-primary data-active:font-semibold dark:data-active:bg-primary/20 data-active:hover:bg-primary/15 data-active:hover:text-primary';

export default function AppSidebar() {
  const pathname = useConsolePathname();
  const { isOpen } = useMediaQuery();
  const { user } = useUser();
  const { signOut } = useClerk();
  const { area } = useNav();
  const canSwitch = usePlatformAdmin(area);
  const base = area === 'admin' ? '/admin' : '/app';
  // Exactly one entry is active (mold_v0-213, src/lib/active-nav.ts): the page's own, or the one it belongs to (a
  // record's page its list's, an in-page tab or a filter its page's, a sub-page its module's); the area's home only on
  // itself; none on a 404. mold_v0-298: worked out in one hook the top bar's trail shares, so both name the same place.
  const [search, searchProbe] = useNavSearch();
  const { groups: filteredGroups, urls, footer, activeUrl } = useActiveNavEntry(search);
  const keysInFooter = footer.includes('/app/keys');
  const active = (url: string) => url === activeUrl;
  // The footer's Profile is lit only when the sidebar has no Profile entry of its own (one entry lit, never two).
  const profileInNav = urls.slice(0, urls.length - footer.length).includes(`${base}/profile`);

  React.useEffect(() => {
    // Side effects based on sidebar state changes
  }, [isOpen]);

  return (
    <Sidebar collapsible='icon'>
      <SidebarHeader className='group-data-[collapsible=icon]:pt-4'>
        {area === 'admin' ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size='lg' render={<Link href='/admin' aria-label={`${profile.console_title} Admin`} />}>
                <BrandMark className='size-8 shrink-0' />
                <div className='grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden'>
                  <span className='truncate font-semibold'>{profile.console_title}</span>
                  <span className='text-muted-foreground truncate text-xs'>Platform admin</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : (
          <OrgSwitcher />
        )}
      </SidebarHeader>
      {searchProbe}
      <SidebarContent className='overflow-x-hidden'>
        {filteredGroups.map((group) => (
          <SidebarGroup key={group.label || 'ungrouped'} className='py-0 group-data-[collapsible=icon]:py-1.5'>
            {/* A heading never repeats its first entry's name ("Overview" over Overview, even with Settings joined below it). */}
            {group.label && group.items[0]?.title !== group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
            <SidebarMenu>
              {group.items.map((item) => {
                const Icon = item.icon ? Icons[item.icon] : Icons.logo;
                return item?.items && item?.items?.length > 0 ? (
                  <Collapsible
                    key={item.title}
                    // A group holding the active entry opens on load (mold_v0-213).
                    defaultOpen={item.isActive || active(item.url) || !!item.items?.some((x) => active(x.url))}
                    render={<SidebarMenuItem />}
                  >
                    <CollapsibleTrigger
                      render={
                        <SidebarMenuButton
                          tooltip={item.title}
                          isActive={active(item.url)}
                          className={cn('group/collapsible', ACTIVE)}
                        />
                      }
                    >
                      {item.icon && <Icon />}
                      <span>{item.title}</span>
                      <Icons.chevronRight className='ml-auto transition-transform duration-200 group-data-panel-open/collapsible:rotate-90' />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <SidebarMenuSub>
                        {item.items?.map((subItem) => (
                          <SidebarMenuSubItem key={subItem.title}>
                            <SidebarMenuSubButton
                              render={<Link href={subItem.url} aria-label={subItem.title} />}
                              isActive={active(subItem.url)}
                              className={ACTIVE}
                            >
                              <span>{subItem.title}</span>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </Collapsible>
                ) : (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      render={
                        item.external ? (
                          <a href={item.url} target='_blank' rel='noopener noreferrer' aria-label={item.title} />
                        ) : (
                          <Link href={item.url} aria-label={item.title} />
                        )
                      }
                      tooltip={item.title}
                      isActive={!item.external && active(item.url)}
                      className={ACTIVE}
                    >
                      <Icon />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className='gap-2'>
        <SidebarMenu>
          {canSwitch && (
            <SidebarMenuItem>
              <SidebarMenuButton
                size='sm'
                tooltip={area === 'admin' ? 'Customer portal' : 'Platform admin'}
                render={<Link href={area === 'admin' ? '/app' : '/admin'} />}
                className='border-primary/40 bg-primary/10 text-foreground hover:bg-primary/20 hover:text-foreground [&_svg]:text-primary h-6 w-fit gap-1.5 rounded-full border px-2.5 text-xs [&_svg]:size-3.5 group-data-[collapsible=icon]:w-8'
              >
                {area === 'admin' ? <Icons.arrowRight /> : <Icons.shield />}
                <span className='font-medium'>{area === 'admin' ? 'Customer portal' : 'Platform admin'}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {keysInFooter && (
            // A person's own MCP keys (mold_v0-007), in every build whatever the sidebar's groups are, unless the profile
            // turns member keys off (mold_v0-099).
            <SidebarMenuItem>
              <SidebarMenuButton size='sm' tooltip='API keys' isActive={active('/app/keys')} className={ACTIVE} render={<Link href='/app/keys' />}>
                <Icons.lock />
                <span>API keys</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem className='group/me'>
            <SidebarMenuButton tooltip='Profile' className={cn('h-10', ACTIVE)} isActive={!profileInNav && active(`${base}/profile`)} render={<Link href={`${base}/profile`} aria-label='Your profile' />}>
              {user && <UserAvatarProfile className='size-7 rounded-lg' showInfo compact user={user} />}
            </SidebarMenuButton>
            <button
              type='button'
              aria-label='Sign out'
              title='Sign out'
              onClick={() => signOut({ redirectUrl: '/auth/sign-in' })}
              className='text-sidebar-foreground hover:bg-sidebar-accent hover:text-destructive focus-visible:ring-sidebar-ring absolute top-1/2 right-1.5 flex size-8 -translate-y-1/2 items-center justify-center rounded-md outline-none focus-visible:ring-2 group-data-[collapsible=icon]:hidden md:opacity-0 md:group-hover/me:opacity-100 md:focus-visible:opacity-100'
            >
              <Icons.logout className='size-4' />
            </button>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

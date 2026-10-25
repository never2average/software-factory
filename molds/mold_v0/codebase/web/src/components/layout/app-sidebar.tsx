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
import { useFilteredNavGroups } from '@/hooks/use-nav';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { Icons } from '../icons';
import { OrgSwitcher } from '../org-switcher';
import { useNav } from './nav-context';
import { BrandMark } from '@/components/brand';
import { profile } from '@/config/profile.generated';

/** Member API keys (mold_v0-099, profile `member_keys`): false removes the API keys page and this link. */
const memberKeysOn = (profile as Readonly<Record<string, unknown>>).member_keys !== false;

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

export default function AppSidebar() {
  const pathname = usePathname();
  const { isOpen } = useMediaQuery();
  const { user } = useUser();
  const { signOut } = useClerk();
  const { area, groups } = useNav();
  const canSwitch = usePlatformAdmin(area);
  const filteredGroups = useFilteredNavGroups(groups);
  // A declared sidebar that lists API keys (mold_v0-133, a keys tab) has it in its group: not again in the footer.
  const keysInNav = groups.some((g) => g.items.some((i) => i.url === '/app/keys'));
  const base = area === 'admin' ? '/admin' : '/app';
  // A module is active on its own page and its sub-pages; the area's home only on itself.
  const active = (url: string) => pathname === url || (url !== base && pathname.startsWith(`${url}/`));

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
      <SidebarContent className='overflow-x-hidden'>
        {filteredGroups.map((group) => (
          <SidebarGroup key={group.label || 'ungrouped'} className='py-0 group-data-[collapsible=icon]:py-1.5'>
            {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
            <SidebarMenu>
              {group.items.map((item) => {
                const Icon = item.icon ? Icons[item.icon] : Icons.logo;
                return item?.items && item?.items?.length > 0 ? (
                  <Collapsible
                    key={item.title}
                    defaultOpen={item.isActive}
                    render={<SidebarMenuItem />}
                  >
                    <CollapsibleTrigger
                      render={
                        <SidebarMenuButton
                          tooltip={item.title}
                          isActive={active(item.url)}
                          className='group/collapsible'
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
                              isActive={pathname === subItem.url}
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
          {area === 'portal' && memberKeysOn && !keysInNav && (
            // A person's own MCP keys (mold_v0-007), in every build whatever the sidebar's groups are, unless the profile
            // turns member keys off (mold_v0-099).
            <SidebarMenuItem>
              <SidebarMenuButton size='sm' tooltip='API keys' isActive={pathname === '/app/keys'} render={<Link href='/app/keys' />}>
                <Icons.lock />
                <span>API keys</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem className='group/me'>
            <SidebarMenuButton tooltip='Profile' className='h-10' isActive={pathname === `${base}/profile`} render={<Link href={`${base}/profile`} aria-label='Your profile' />}>
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

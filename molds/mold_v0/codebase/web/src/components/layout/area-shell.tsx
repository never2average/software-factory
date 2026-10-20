import KBar from '@/components/kbar';
import AppSidebar from '@/components/layout/app-sidebar';
import Header from '@/components/layout/header';
import { InfoSidebar } from '@/components/layout/info-sidebar';
import { InfobarProvider } from '@/components/ui/infobar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { cookies } from 'next/headers';
import type { NavGroup } from '@/types';
import type { DocNavGroup } from '@/features/docs/docs-data';
import { NavProvider, type Area } from './nav-context';

/**
 * The signed-in frame for /admin and /app: module sidebar, header with breadcrumbs, Cmd+K over the modules and the
 * area's docs (`docs`: titles and headings only, from the area's layout).
 */
export async function AreaShell({ area, groups, docs, children }: { area: Area; groups: NavGroup[]; docs?: DocNavGroup[]; children: React.ReactNode }) {
  const defaultOpen = (await cookies()).get('sidebar_state')?.value !== 'false';
  return (
    <NavProvider area={area} groups={groups}>
      <KBar docs={docs}>
        <SidebarProvider defaultOpen={defaultOpen}>
          <a href='#main-content' className='bg-background ring-ring sr-only rounded-md px-3 py-2 text-sm font-medium shadow focus:not-sr-only focus:absolute focus:top-2 focus:start-2 focus:z-50 focus:ring-2'>
            Skip to content
          </a>
          <AppSidebar />
          <SidebarInset id='main-content' tabIndex={-1} className='scroll-mt-16'>
            <Header />
            <InfobarProvider defaultOpen={false}>
              {children}
              <InfoSidebar side='right' />
            </InfobarProvider>
          </SidebarInset>
        </SidebarProvider>
      </KBar>
    </NavProvider>
  );
}

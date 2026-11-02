import { notFound } from 'next/navigation';
import { developerConsole } from '@/config/pack-nav.generated';
import { DeveloperPage } from '@/features/developer/developer-page';

export const metadata = { title: 'Developers' };

// Settings › Developers (mold_v0-201; src/developer-routes.ts): the developer surface's console, only in an app of kind
// embedded (a pack declares developer_surface); in a tool app the page is not found (web/src/lib/console-routes.ts SHOWN)
// and the sidebar has no entry.
export default function Page() {
  if (!developerConsole.on) notFound();
  return <DeveloperPage />;
}

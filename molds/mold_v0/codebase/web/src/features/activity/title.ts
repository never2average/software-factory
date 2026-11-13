// The Activity page's one name (mold_v0-298): the sidebar, the breadcrumb and the page's own title say the same word.
// A pack's usage tab opens /app/activity under its own label; else the sidebar's own entry for it; else, in a build
// without the session engine (where the sidebar's /app/usage entry leads here), that entry's name; else "Activity".
import { packTabs } from '@/config/pack-nav.generated';
import { portalNav } from '@/config/nav-config';
import { sessionEngine } from '@/features/admin/engine';

export const ACTIVITY_URL = '/app/activity';

export function activityLabel(): string {
  const tab = packTabs.find((t) => t.kind === 'usage' && t.url === ACTIVITY_URL);
  if (tab?.label) return tab.label;
  const items = portalNav.flatMap((g) => g.items.flatMap((i) => [i, ...(i.items ?? [])]));
  const own = items.find((i) => i.url === ACTIVITY_URL);
  if (own?.title) return own.title;
  const usage = !sessionEngine() ? items.find((i) => i.url === '/app/usage') : undefined;
  return usage?.title || 'Activity';
}

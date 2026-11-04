'use client';
// Settings (mold_v0-218; assembled from the features registry since mold_v0-219, web/src/config/settings.ts): the tabs
// each capability that is on contributes (Credentials, API keys, Allowed origins, Email, Webhooks, Integrations,
// Alerts, Signing) and the packs' record areas declared as settings, in four groups. Up to 5 tabs one page,
// /app/settings, with one strip (one tab: that table alone, no strip); past 5 a page per group, /app/settings/<group>,
// each with its own strip. The open tab is in the address (?tab=<id>; the page's first has none), as every in-page
// tab: no title above the strip. Every tab is the standard full-area table (cards, search row with its primary action,
// table, full card).
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryState } from 'nuqs';
import PageContainer from '@/components/layout/page-container';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { pageTabs, settingsLayout, settingsTabUrl, type SettingsTabSpec } from '@/config/settings';
import { settingsTabs as ALL } from '@/config/pack-nav.generated';
import { CredentialsTab } from '@/features/credentials/credentials-tab';
import { EmailTab } from '@/features/email/email-tab';
import { DeveloperTab } from '@/features/developer/developer-page';
import { AreaRecordList } from '@/features/records/record-pages';
import { findRecordArea } from '@/features/records/registry';
import { AlertsTab } from './alerts-tab';
import { SigningTab } from './signing-tab';

/** The tabs this build's Settings has, in order (every group's). */
export const settingsTabIds = (tabs: readonly SettingsTabSpec[] = ALL): string[] => tabs.map((t) => t.id);

function TabBody({ tab }: { tab: SettingsTabSpec }) {
  switch (tab.kind) {
    case 'credentials': return <CredentialsTab />;
    case 'email': return <EmailTab />;
    case 'api_keys': case 'allowed_origins': case 'webhooks': case 'integrations': return <DeveloperTab kind={tab.kind} />;
    case 'alerts': return <AlertsTab />;
    case 'signing': return <SigningTab />;
    case 'area': {
      const area = findRecordArea('app', tab.area!);
      // mold_v0-237: the area's own list (cards, the search row with its primary action and Export, the table).
      return area ? <AreaRecordList area={area} id={`settings-${area.name}`} /> : null;
    }
  }
}

/** Settings, or one group's page of it (`group`: its slug, past 5 tabs). */
export function SettingsPage({ group = null }: { group?: string | null }) {
  const router = useRouter();
  const layout = settingsLayout();
  const tabs = pageTabs(group);
  const first = tabs[0]?.id ?? '';
  const [selected, setSelected] = useQueryState('tab', { defaultValue: first });
  // Past 5 tabs, /app/settings itself leads to the asked tab's group page (or the first group's): its address stays good.
  const lead = layout === 'groups' && !group ? settingsTabUrl(ALL.some((t) => t.id === selected) ? selected : ALL[0]!.id) : null;
  useEffect(() => { if (lead) router.replace(lead); }, [lead, router]);
  if (lead || !tabs.length) return null;
  const tab = tabs.find((t) => t.id === selected) ?? tabs[0]!;
  const setTab = (v: string) => void setSelected(v === first ? null : v);
  return (
    <PageContainer>
      {tabs.length < 2 ? (
        <div className='flex w-full flex-col'><TabBody tab={tab} /></div>
      ) : (
        <Tabs value={tab.id} onValueChange={(v) => setTab(String(v))} className='w-full gap-4'>
          {/* On a phone a long strip wraps to a second line rather than scroll out of sight. */}
          <TabsList variant='line' className='max-w-full flex-wrap justify-start gap-x-6 gap-y-3 p-0 group-data-horizontal/tabs:h-auto'>
            {tabs.map((t) => <TabsTrigger key={t.id} value={t.id} className='h-7 flex-none px-0'>{t.label}</TabsTrigger>)}
          </TabsList>
          <TabsContent value={tab.id}><TabBody tab={tab} /></TabsContent>
        </Tabs>
      )}
    </PageContainer>
  );
}

'use client';
// Settings (mold_v0-218, /app/settings): one sidebar entry directly below Overview, with in-page tabs Credentials | Email
// (Credentials when the build declares a credential field or a kind that needs the workspace's private network; Email
// when a pack turns the company's own email on). Each tab is a full-page table in the standard list layout. The open
// tab is in the address (?tab=<id>; Credentials, the first, has none), as every in-page tab: no title above the strip.
// With only one of them, that table alone, with no strip.
import { useQueryState } from 'nuqs';
import PageContainer from '@/components/layout/page-container';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { settingsPage } from '@/config/pack-nav.generated';
import { CredentialsTab } from '@/features/credentials/credentials-tab';
import { EmailTab } from '@/features/email/email-tab';

export type SettingsTab = 'credentials' | 'email';
/** The tabs this build's Settings has, in order. */
export const settingsTabs = (page: { credentials: boolean; email: boolean } = settingsPage): SettingsTab[] =>
  (['credentials', 'email'] as const).filter((t) => page[t]);

export function SettingsPage() {
  const tabs = settingsTabs();
  const first = tabs[0] ?? 'credentials';
  // ?tab=<id> (the first tab's default leaves the address bare); an unknown one opens the first.
  const [selected, setSelected] = useQueryState('tab', { defaultValue: first });
  const tab: SettingsTab = (tabs as string[]).includes(selected) ? (selected as SettingsTab) : first;
  const setTab = (v: SettingsTab) => void setSelected(v === first ? null : v);
  const body = (t: SettingsTab) => (t === 'credentials' ? <CredentialsTab /> : <EmailTab />);
  return (
    <PageContainer>
      {tabs.length < 2 ? (
        <div className='flex w-full flex-col'>{body(first)}</div>
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as SettingsTab)} className='w-full gap-4'>
          <TabsList variant='line' className='gap-6 p-0'>
            <TabsTrigger value='credentials' className='flex-none px-0'>Credentials</TabsTrigger>
            <TabsTrigger value='email' className='flex-none px-0'>Email</TabsTrigger>
          </TabsList>
          <TabsContent value='credentials'>{tab === 'credentials' && <CredentialsTab />}</TabsContent>
          <TabsContent value='email'>{tab === 'email' && <EmailTab />}</TabsContent>
        </Tabs>
      )}
    </PageContainer>
  );
}

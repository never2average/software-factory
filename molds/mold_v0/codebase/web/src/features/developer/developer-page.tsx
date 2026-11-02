'use client';
// Settings › Developers (mold_v0-201; src/developer-routes.ts at /api/developer): the developer surface's console, in an
// app of kind embedded only (a pack declares pack.json developer_surface; a tool app has no entry and no page). A page of
// in-page tabs, so it starts with its tab strip (mold_v0-180):
//   API keys          the workspace's keys for its own servers: made with scopes, an expiry and a kind, shown once, then
//                     only their prefix; rotated (the old key kept for a grace) and revoked
//   Webhooks          endpoints: their events, the signing secret (revealed on purpose, and recorded), rotated, a test
//                     ping, a delivery log (status, attempts, the next retry, the payload) and Enable again after an
//                     automatic disable
//   Allowed origins   the browser origins client sessions may call from (the app's own, and the workspace's)
//   Inbound webhooks  sources for the app's receivers: their address, their secret (shown once) and the last deliveries
// Every role may read; the changes are an owner's (the API's `manage`), and the buttons say so for everyone else. Each
// list is the console's database table (RecordView), as on the record pages and the access log.
import { useQueryState } from 'nuqs';
import PageContainer from '@/components/layout/page-container';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { developerConsole } from '@/config/pack-nav.generated';
import { ErrorState, LoadingCards, useOrgLoad } from '@/features/portal/shared';
import { dev, type Offer } from './api';
import { developerTabs } from './words';
import { KeysTab } from './keys';
import { WebhooksTab } from './webhooks';
import { OriginsTab } from './origins';
import { InboundTab } from './inbound';

export function DeveloperPage() {
  const tabs = developerTabs(developerConsole.inbound);
  const [selected, setSelected] = useQueryState('tab', { defaultValue: 'keys' });
  const current = tabs.find((t) => t.id === selected) ?? tabs[0]!;
  const { data: offer, error } = useOrgLoad(() => dev<Offer>('GET'));
  return (
    <PageContainer>
      {error ? <ErrorState error={error} /> : (
        <Tabs value={current.id} onValueChange={(v) => void setSelected(String(v))} className='gap-6'>
          <TabsList variant='line' className='max-w-full gap-6 overflow-x-auto p-0'>
            {tabs.map((t) => <TabsTrigger key={t.id} value={t.id} className='flex-none px-0'>{t.label}</TabsTrigger>)}
          </TabsList>
          <TabsContent value={current.id}>
            {!offer ? <LoadingCards count={1} />
              : current.id === 'keys' ? <KeysTab offer={offer} />
              : current.id === 'webhooks' ? <WebhooksTab offer={offer} />
              : current.id === 'origins' ? <OriginsTab offer={offer} />
              : <InboundTab offer={offer} />}
          </TabsContent>
        </Tabs>
      )}
    </PageContainer>
  );
}

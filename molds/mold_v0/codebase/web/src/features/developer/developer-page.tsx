'use client';
// The developer surface's console (mold_v0-201; src/developer-routes.ts at /api/developer), in an app of kind embedded
// only: since mold_v0-219 its four parts are Settings tabs (web/src/config/settings.ts), each the standard full-area
// table, rather than a page of their own (the old /app/developers is gone, with no redirect):
//   API keys          Access: the workspace's keys for its own servers: made with scopes, an expiry and a kind, shown
//                     once, then only their prefix; rotated (the old key kept for a grace) and revoked
//   Allowed origins   Access: the browser origins client sessions may call from (the app's own, and the workspace's)
//   Webhooks          Connections: endpoints, their events, the signing secret (revealed on purpose, and recorded),
//                     rotated, a test ping, a delivery log and Enable again after an automatic disable
//   Integrations      Connections: the sources for the app's inbound webhook receivers (their address, their secret,
//                     shown once, and the last deliveries), where the app takes webhooks in
// Every role may read; the changes are an owner's (the API's `manage`), and the buttons say so for everyone else.
import { ErrorState, LoadingCards, useOrgLoad } from '@/features/portal/shared';
import { dev, type Offer } from './api';
import { KeysTab } from './keys';
import { WebhooksTab } from './webhooks';
import { OriginsTab } from './origins';
import { InboundTab } from './inbound';

export type DeveloperTabKind = 'api_keys' | 'allowed_origins' | 'webhooks' | 'integrations';

/** One of the developer surface's Settings tabs. */
export function DeveloperTab({ kind }: { kind: DeveloperTabKind }) {
  const { data: offer, error } = useOrgLoad(() => dev<Offer>('GET'));
  if (error) return <ErrorState error={error} />;
  if (!offer) return <LoadingCards count={1} />;
  return kind === 'api_keys' ? <KeysTab offer={offer} />
    : kind === 'webhooks' ? <WebhooksTab offer={offer} />
    : kind === 'allowed_origins' ? <OriginsTab offer={offer} />
    : <InboundTab offer={offer} />;
}

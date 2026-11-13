import { ConnectedAppsPage } from '@/features/connected-apps/connected-apps-page';

// Each person's connected apps (mold_v0-087): the agents signed in to /mcp, with Revoke under the built-in sign-in; under
// the hosted sign-in provider (mold_v0-298), the agents seen working in this workspace and how to disconnect one. A build
// may hide the page (console.hide: ["connected-apps"]; it then redirects to /app).
export const metadata = { title: 'Connected apps' };

export default function Page() {
  return <ConnectedAppsPage />;
}

/**
 * The Connected apps page's words and rules (mold_v0-087), apart from React so the server's tests read them too
 * (scripts/connected-apps-test.ts). Relative imports only.
 *
 * Built-in sign-in: the server is the authorization server for /mcp (src/mcp-oauth.ts), so it lists each app a person
 * connected (GET /api/oauth/grants) and revokes one (POST /api/oauth/grants/<id>/revoke).
 * Clerk: Clerk is the authorization server. Its Backend API has no list of a person's OAuth consents or grants (its OAuth
 * applications endpoints are the instance's apps; a token is revoked only by presenting it), so the page says where the
 * connections are kept and how to end one, and links to the person's account at Clerk.
 */
import { fill } from '../../lib/vocabulary';

/** One connected app, as GET /api/oauth/grants answers (src/mcp-oauth.ts ConnectedApp). */
export interface ConnectedApp {
  id: string;
  client: { name: string | null; verified: boolean; id_host: string | null; url: string | null };
  workspace: { id: string; name: string };
  scope: string[];
  created_at: string;
  last_used_at: string | null;
}

export const PAGE_TITLE = 'Connected apps';
export const PAGE_URL = '/app/connected-apps';
export const DESCRIPTION = fill('AI apps you signed in to {product}, such as Claude, ChatGPT or VS Code. Each acts as you, with your role, in the {workspace} you chose. Revoke one to sign it out at once.');
export const EMPTY = {
  title: 'No apps connected',
  text: fill('When you connect an AI app to {product} and sign in, it shows here, with the {workspace} it acts in.'),
  cta: { label: 'How to connect an app', href: '/app' },
};

/** The app's name as the page shows it: its own name, else the address that identifies it, else a plain label. */
export const appName = (a: ConnectedApp) => a.client.name?.trim() || a.client.id_host || 'Unnamed app';

/**
 * Who vouches for the app: a client ID metadata document client is identified by its https address (verified); a
 * registered client named itself, so the name is only what it said.
 */
export const appIdentity = (a: ConnectedApp): { verified: true; host: string; url: string } | { verified: false; note: string } =>
  a.client.verified && a.client.id_host && a.client.url
    ? { verified: true, host: a.client.id_host, url: a.client.url }
    : { verified: false, note: 'Not verified: the app gave this name itself' };

export const revokeQuestion = (a: ConnectedApp) => ({
  title: `Revoke ${appName(a)}?`,
  // The workspace's name is the person's data: never passed through fill (a brace in it is not a placeholder).
  text: `It is signed out of ${a.workspace.name} at once, and stops working there until you connect it again from the app.`,
  action: 'Revoke',
});

// ---------- Clerk ----------

export const CLERK_NOTE = {
  title: 'Managed by your sign-in provider',
  text: fill('{product} signs people in with Clerk, and the AI apps you connect sign in through Clerk too. Clerk keeps those connections, and does not let {product} list them here.'),
  disconnect: fill('To disconnect an app, remove {product} in that app\'s own settings (in Claude: Settings, then Connectors). To end every connection at once, sign out of your other devices on your profile.'),
};

/**
 * The person's account page at Clerk (the Account Portal), from the console's publishable key: `pk_test_`/`pk_live_` and
 * the Frontend API's host in base64 with a trailing `$`. A development instance's host `<slug>.clerk.accounts.dev` has
 * its portal at `<slug>.accounts.dev`; a production instance's `clerk.<domain>` at `accounts.<domain>`. null when the
 * key says neither (a proxied or unusual set-up): the page then links to the profile.
 */
export function clerkAccountUrl(publishableKey: string | undefined | null): string | null {
  const m = /^pk_(?:test|live)_([A-Za-z0-9+/_-]+={0,2})$/.exec(publishableKey ?? '');
  if (!m) return null;
  let host: string;
  try { host = atob(m[1]!.replace(/-/g, '+').replace(/_/g, '/')); } catch { return null; }
  if (!host.endsWith('$')) return null;
  host = host.slice(0, -1).toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  const dev = /^([a-z0-9-]+)\.clerk\.accounts\.dev$/.exec(host);
  if (dev) return `https://${dev[1]}.accounts.dev/user`;
  if (host.startsWith('clerk.') && host.split('.').length >= 3) return `https://accounts.${host.slice('clerk.'.length)}/user`;
  return null;
}

/** Where the Clerk note's link goes, and what it says. */
export const clerkAccountLink = (publishableKey: string | undefined | null) => {
  const url = clerkAccountUrl(publishableKey);
  return url ? { href: url, label: 'Open your account at Clerk', external: true } : { href: '/app/profile', label: 'Open your profile', external: false };
};

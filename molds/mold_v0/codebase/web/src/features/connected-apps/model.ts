/**
 * The Connected apps page's words and rules (mold_v0-087), apart from React so the server's tests read them too
 * (scripts/connected-apps-test.ts). Relative imports only.
 *
 * Built-in sign-in: the server is the authorization server for /mcp (src/mcp-oauth.ts), so it lists each app a person
 * connected (GET /api/oauth/grants) and revokes one (POST /api/oauth/grants/<id>/revoke).
 * Hosted sign-in provider: the provider is the authorization server. Its API has no list of a person's OAuth consents or
 * grants (its OAuth application endpoints are the instance's apps; a token is revoked only by presenting it). mold_v0-298:
 * the page lists the agents this person was seen connecting from in this workspace (GET /api/app/setup `clients`, from
 * the usage log), when each was last seen, and how to disconnect one; and links to the person's account at the provider.
 * No vendor's name in the words.
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

/** One agent seen connecting (GET /api/app/setup `clients`: its name as it introduced itself, and when last seen). */
export interface SeenApp { client: string; last: string }

export const PAGE_TITLE = 'Connected apps';
export const PAGE_URL = '/app/connected-apps';
/**
 * mold_v0-298: where the setup steps for connecting an agent are: the home page's connection card (the Setup page, or
 * a home tab, which draws the same card: web/src/app/app/page.tsx), by its anchor.
 */
export const CONNECT_URL = '/app#connect';
export const DESCRIPTION = fill('Agents you connected and signed in with, such as a chat assistant or a code editor. Each acts as you, with your role, in the {workspace} you chose. Revoke one to sign it out at once.');
export const EMPTY = {
  title: 'No apps connected',
  text: fill('When you connect an agent and sign in, it shows here, with the {workspace} it acts in.'),
  cta: { label: 'Connect an agent', href: CONNECT_URL },
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

/** What an app may do, in plain words (its OAuth scopes; mold_v0-298: no raw scope name shown). */
const SCOPE_WORDS: Record<string, string> = { mcp: 'Use your tools as you', offline_access: 'Stay signed in until you revoke it' };
export const scopeWords = (scope: string[]) => {
  const words = [...new Set((scope.length ? scope : ['mcp']).map((s) => SCOPE_WORDS[s] ?? 'Other access it asked for'))];
  return words.join(', ');
};

export const revokeQuestion = (a: ConnectedApp) => ({
  title: `Revoke ${appName(a)}?`,
  // The workspace's name is the person's data: never passed through fill (a brace in it is not a placeholder).
  text: `It is signed out of ${a.workspace.name} at once, and stops working there until you connect it again from the app.`,
  action: 'Revoke',
});

// ---------- the hosted sign-in provider ----------

// mold_v0-298: no vendor's name and no product name standing in for one (the neutral build's name is a generic word).
// The words claim only what holds: a connection is ended in the agent itself; signing out here does not end it.
export const CLERK_NOTE = {
  title: 'Managed by the service you sign in with',
  text: fill('Your agents sign in through the same service you use to sign in here, and that service keeps the connections. So this page shows the agents most recently seen working in this {workspace} as you, and when each was last seen.'),
  disconnect: 'To disconnect an app, open that app and remove this connection in its settings, or sign out of it there. Signing out of this page does not disconnect your agents.',
};

/**
 * How many agents the list can show at most: the server answers only the most recently seen (src/app.ts setup(),
 * `clients`, LIMIT 5). Keep the two the same; at this many the page says the list may not be complete.
 */
export const SEEN_LIMIT = 5;
export const seenPartial = (n: number) => (n >= SEEN_LIMIT ? `Showing the ${n} most recently seen. Older ones are not listed.` : null);

/** Removing an app from this list (DELETE /api/app/clients/<name>): it forgets the name only, it does not disconnect it. */
export const forgetQuestion = (name: string) => ({
  title: `Remove ${name} from this list?`,
  text: `${name} is no longer listed here or counted as one of your agents. This does not disconnect it: to do that, remove the connection in ${name} itself. If it works here again, it shows again.`,
  action: 'Remove',
});

export const SEEN_EMPTY = {
  title: 'No agents seen yet',
  text: fill('Once you connect an agent and it works in this {workspace} as you, it shows here with when it was last seen.'),
  cta: { label: 'Connect an agent', href: CONNECT_URL },
};

/** How to disconnect one app seen connecting, for its side panel. */
export const disconnectSteps = (name: string) => [
  `Open ${name} and go to its settings, where it lists the tools and services it is connected to.`,
  'Find this connection and remove it, or sign out of it there.',
  `Once it is removed, ${name} stops using your tools here. To use it again, connect it again from the setup steps.`,
];

/**
 * The person's account page at the hosted provider (its account portal), from the console's publishable key:
 * `pk_test_`/`pk_live_` and the provider's sign-in host in base64 with a trailing `$`. A development host has its portal
 * one label up (`<slug>.accounts.dev`); a production host's portal is `accounts.<domain>`. null when the key says neither
 * (a proxied or unusual set-up): the page then links to the profile.
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

/** Where the note's account link goes, and what it says (mold_v0-298: no vendor's name). */
export const clerkAccountLink = (publishableKey: string | undefined | null) => {
  const url = clerkAccountUrl(publishableKey);
  return url ? { href: url, label: 'Open your sign-in account', external: true } : { href: '/app/profile', label: 'Open your profile', external: false };
};

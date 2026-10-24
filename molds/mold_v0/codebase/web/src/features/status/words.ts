/**
 * The console's status words (mold_v0-131): the one set of words every status page says, whatever led to it (an unknown
 * address, a hidden tab, a record that is not there or not the person's, a role that cannot open a page, staff-only
 * pages, a suspended person, a signed-out one, someone in no account, a server or network failure). The component that
 * shows them is ./status-page.tsx; the mapping from an API answer to a kind is ./from-error.tsx.
 *
 * Base text writes the build's words as placeholders (src/words.ts through @/lib/vocabulary): {product}, {account},
 * {owner}. A role a page needs is the API's own label for it (src/account-roles.ts, src/admin-roles.ts).
 * Pure: no React, so the root error page (global-error.tsx, which has no stylesheet) reads the same words.
 */
import { fill } from '../../lib/vocabulary';

export type StatusKind =
  | 'not_found' // 404: no such page or record, or one that is not open to this person (never says which)
  | 'denied' // 403: the person's role cannot open it
  | 'staff_only' // 403: platform staff only (/admin)
  | 'suspended' // 403: the person's access to this account is suspended
  | 'signed_out' // 401: nobody signed in, or the session ended
  | 'no_account' // 403: signed in, in no account here (./no-account.tsx hands it to the portal's page)
  | 'error' // 5xx, or an answer the page cannot use
  | 'offline'; // the server could not be reached

/** Where the page is shown: its home link and its back-office link follow from it. */
export type StatusArea = 'site' | 'app' | 'admin' | 'auth';

export interface StatusText {
  /** The HTTP status the page stands for ('' when there is none, offline). */
  code: string;
  title: string;
  /** One sentence: what happened and what to do. */
  body: string;
}

export interface StatusTextOptions {
  /** The role a denied page needs (its label), when the API said. */
  role?: string | null;
  /** Who is signed in, for staff-only pages. */
  email?: string | null;
  area?: StatusArea;
}

/** The words for one kind of status. */
export function statusText(kind: StatusKind, o: StatusTextOptions = {}): StatusText {
  switch (kind) {
    case 'not_found':
      return { code: '404', title: 'Page not found', body: "This page doesn't exist, has moved, or isn't open to you. Check the address, or start again from home." };
    case 'denied':
      return {
        code: '403',
        title: "You can't open this page",
        body: o.area === 'admin'
          ? `This page needs the ${o.role ?? 'Owner'} role. Ask an Owner on the Admins page.`
          : o.role
            ? fill(`This page needs the ${safe(o.role)} role in this {account}. Ask an {account} {owner} to change your role.`)
            : fill('Your role in this {account} cannot open this page. Ask an {account} {owner} for access.')
      };
    case 'staff_only':
      return {
        code: '403',
        title: 'Platform staff only',
        body: `${o.email ? o.email : 'This address'} ${fill("isn't {product} platform staff. Your own {account} is in the customer portal.")}`
      };
    case 'suspended':
      return { code: '403', title: 'Your access is paused', body: fill('Your access to this {account} was suspended. Ask an {account} {owner} to restore it.') };
    case 'signed_out':
      return { code: '401', title: 'Sign in to continue', body: fill("You're signed out, or your session has ended. Sign in again to open this page.") };
    case 'no_account':
      return { code: '403', title: fill("You're not in a {product} {account} yet"), body: fill('{Product} is invite-only. Ask someone who uses it to invite you, or sign out and use another address.') };
    case 'offline':
      return { code: '', title: fill("Can't reach {product}"), body: 'Check your connection, then try again.' };
    case 'error':
    default:
      return { code: '500', title: 'Something went wrong', body: "This page couldn't load. Try again in a moment." };
  }
}

/** A role label as text inside a template: never a placeholder of its own. */
const safe = (s: string) => s.replace(/[{}]/g, '');

/** The labels of the actions a status page offers. */
export const STATUS_ACTIONS = {
  home: { site: 'Go to the home page', app: fill('Go to your {account}'), admin: 'Go to the admin console', auth: 'Go to the home page' } satisfies Record<StatusArea, string>,
  back: 'Go back',
  signIn: 'Sign in',
  signOut: 'Sign out',
  signInOther: 'Sign in with another address',
  retry: 'Try again',
  admin: 'Open the admin console',
  portal: 'Open the customer portal'
} as const;

/** The account roles by id, as the Team page names them (src/account-roles.ts ACCOUNT_ROLE_LABELS). */
export const accountRoleLabel = (id: string | null | undefined): string | null =>
  !id ? null : ({ owner: 'Owner', billing: 'Billing manager', member: 'Member', viewer: 'Viewer' } as Record<string, string>)[id] ?? null;

/** The platform roles by id (src/admin-roles.ts ROLE_LABELS). */
export const adminRoleLabel = (id: string | null | undefined): string | null =>
  !id ? null : ({ viewer: 'Viewer', support: 'Support', operator: 'Operator', owner: 'Owner' } as Record<string, string>)[id] ?? null;

/** Where each area's home is. */
export const AREA_HOME: Record<StatusArea, string> = { site: '/', app: '/app', admin: '/admin', auth: '/' };

/** The sign-in page, bringing the person back to `path` afterwards (only a path of this site). */
export function signInHref(path?: string | null): string {
  const p = path && path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/auth') ? path : null;
  return p ? `/auth/sign-in?redirect_url=${encodeURIComponent(p)}` : '/auth/sign-in';
}

/** The area a path belongs to. */
export const areaOf = (path: string | null | undefined): StatusArea =>
  !path ? 'site' : path === '/app' || path.startsWith('/app/') ? 'app' : path === '/admin' || path.startsWith('/admin/') ? 'admin' : path.startsWith('/auth') ? 'auth' : 'site';

/**
 * The public pages' calls to action, in one place (mold_v0-122): the landing sections, the header and the footer all
 * take their links from siteCtas(), so who may open an account (mold_v0-098, `access`) is decided here once. Under
 * `invite_only` a call that leads to sign-up (the shell's own, or a block's, whose label is kept) leads to the request
 * form; without a mode (a render that did not ask the API) every link is as declared.
 */
import { fill } from '@/lib/vocabulary';
import type { AccountsMode, LandingLink } from './landing-types';

export const SIGN_UP: LandingLink = { label: 'Get started', href: '/auth/sign-up' };
export const REQUEST: LandingLink = { label: 'Request access', href: '/request-access' };
export const SIGN_IN: LandingLink = { label: 'Sign in', href: '/app' };
export const INSTALL: LandingLink = { label: 'Connect an AI client', href: '/install' };

/** A link as the access mode has it: sign-up becomes the request form under invite-only accounts. */
export function forAccess(link: LandingLink, access?: AccountsMode): LandingLink;
export function forAccess(link: LandingLink | undefined, access?: AccountsMode): LandingLink | undefined;
export function forAccess(link: LandingLink | undefined, access?: AccountsMode) {
  if (!link || access !== 'invite_only' || link.href !== SIGN_UP.href) return link;
  return link === SIGN_UP ? REQUEST : { ...link, href: REQUEST.href };
}

export interface SiteCtas {
  /** The first step for someone new: sign-up, or the request form under invite-only accounts. */
  start: LandingLink;
  /** Signing in (the console sends a signed-out visitor to its sign-in page). */
  signIn: LandingLink;
  /** For someone already signed in, in place of both. */
  open: LandingLink;
  /** The install pages: connecting an AI client. */
  install: LandingLink;
}

/** The public pages' calls to action for this access mode. */
export function siteCtas(access?: AccountsMode): SiteCtas {
  return { start: forAccess(SIGN_UP, access), signIn: SIGN_IN, open: { label: fill('Open your {workspace}'), href: '/app' }, install: INSTALL };
}

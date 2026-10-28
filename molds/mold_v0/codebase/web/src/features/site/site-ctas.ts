/**
 * The public pages' calls to action, in one place (mold_v0-122): the landing sections, the header and the footer all
 * take their links from siteCtas(), so who may open an account (mold_v0-098, `access`) is decided here once. Under
 * `invite_only` a call that leads to sign-up (the shell's own, or a block's, whose label is kept) leads to the request
 * form; without a mode (a render that did not ask the API) every link is as declared.
 */
import { fill } from '@/lib/vocabulary';
import type { AccountsMode, HeroSection, LandingBlock, LandingLink } from './landing-types';

export const SIGN_UP: LandingLink = { label: 'Get started', href: '/auth/sign-up' };
export const REQUEST: LandingLink = { label: 'Request access', href: '/request-access' };
export const SIGN_IN: LandingLink = { label: 'Sign in', href: '/app' };
export const INSTALL: LandingLink = { label: 'Connect an AI client', href: '/install' };
/** The two-call page's defaults (mold_v0-168, src/landing.ts: the first product's buttons): the account button's two states and the other call's words. */
export const ACCOUNT_SIGN_IN: LandingLink = { label: 'Sign in', href: '/auth/sign-in' };
export const ACCOUNT_OPEN: LandingLink = { label: 'Open dashboard', href: '/app' };
export const EARLY_ACCESS_LABEL = 'Early access';
const SIGN_IN_PATHS = ['/app', '/auth/sign-in'];

/**
 * The two-call page as src/landing.ts twoCallPage checks it (mold_v0-168): what the block says, else the first product's
 * buttons. The hero: primary_cta, else the account button; secondary_cta, else (beside the account button) "Early access"
 * to the request page (request_page.path, else /request-access). The header: its links, else one, the page's other call
 * (the hero's own call that is not signing in, else "Early access"); its ways in, else the account button.
 */
export function twoCallPage(block: Pick<LandingBlock, 'header' | 'request_page'> | null | undefined, hero: Pick<HeroSection, 'primary_cta' | 'secondary_cta'> | null) {
  const early: LandingLink = { label: EARLY_ACCESS_LABEL, href: block?.request_page?.path ?? REQUEST.href };
  const signIn = new Set([...SIGN_IN_PATHS, block?.header?.sign_in?.href ?? ACCOUNT_SIGN_IN.href]);
  const primary = hero ? hero.primary_cta ?? ('account' as const) : undefined;
  const secondary = hero ? hero.secondary_cta ?? (primary === 'account' ? early : undefined) : undefined;
  const other = [primary, secondary].find((k): k is LandingLink => !!k && k !== 'account' && !signIn.has(k.href)) ?? early;
  return { primary, secondary, links: block?.header?.links ?? [other], account: block?.header?.account ?? ('account' as const) };
}

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

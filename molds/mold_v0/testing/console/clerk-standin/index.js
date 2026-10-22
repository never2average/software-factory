'use client';
// Lane stand-in for @clerk/nextjs (see package.json): the hooks the console uses, answering for the one person the lane
// world signed in. Who that is comes from two cookies the world sets: __session (the mock-signed session token the API
// verifies) and __lane_identity (display name, email, workspace name: what Clerk's client would have loaded).
// During server rendering every hook says "not loaded yet", as Clerk's client does before it has loaded.
import { cloneElement, createElement, Fragment, isValidElement, useSyncExternalStore } from 'react';

let cached = { raw: null, value: null };

function readCookie(all, name) {
  const hit = all.split('; ').find((x) => x.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

function decode(token) {
  try {
    const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(p + '='.repeat((4 - (p.length % 4)) % 4)));
  } catch {
    return null;
  }
}

function snapshot() {
  const raw = typeof document === 'undefined' ? '' : document.cookie;
  if (raw === cached.raw) return cached.value;
  const token = readCookie(raw, '__session');
  const c = token ? decode(token) : null;
  let who = {};
  try {
    who = JSON.parse(readCookie(raw, '__lane_identity') || '{}');
  } catch {}
  const orgId = c?.o?.id ?? c?.org_id ?? null;
  const rol = c?.o?.rol ?? c?.org_role ?? null;
  const value = c?.sub
    ? {
        token,
        userId: c.sub,
        sessionId: c.sid ?? null,
        orgId,
        orgRole: rol ? (String(rol).startsWith('org:') ? rol : `org:${rol}`) : null,
        orgSlug: c?.o?.slg ?? c?.org_slug ?? null,
        email: who.email ?? 'lane@example.org',
        firstName: who.first ?? 'Lane',
        lastName: who.last ?? 'Check',
        orgName: who.org ?? 'Lane workspace'
      }
    : { signedOut: true };
  cached = { raw, value };
  return value;
}

const subscribe = () => () => {};
const useLane = () => useSyncExternalStore(subscribe, snapshot, () => null);
const noop = async () => {};

function userOf(s) {
  const email = { id: 'idn_lane', emailAddress: s.email, verification: { status: 'verified' } };
  return {
    id: s.userId,
    firstName: s.firstName,
    lastName: s.lastName,
    fullName: `${s.firstName} ${s.lastName}`,
    username: null,
    imageUrl: '',
    hasImage: false,
    primaryEmailAddress: email,
    primaryEmailAddressId: email.id,
    emailAddresses: [email],
    externalAccounts: [],
    publicMetadata: {},
    update: noop,
    setProfileImage: noop,
    reload: noop,
    getSessions: async () => []
  };
}
function orgOf(s) {
  return s.orgId ? { id: s.orgId, name: s.orgName, slug: s.orgSlug, imageUrl: '', hasImage: false, membersCount: 1 } : null;
}
const list = (data) => ({ data, count: data.length, isLoading: false, isFetching: false, isError: false, hasNextPage: false, hasPreviousPage: false, page: 1, pageCount: 1, fetchNext: () => {}, fetchPrevious: () => {}, fetchPage: () => {}, revalidate: noop, setData: noop });

export function ClerkProvider({ children }) {
  return createElement(Fragment, null, children);
}

export function useAuth() {
  const s = useLane();
  if (!s) return { isLoaded: false, isSignedIn: undefined, userId: undefined, sessionId: undefined, orgId: undefined, orgRole: undefined, orgSlug: undefined, getToken: async () => null, has: () => false, signOut: noop };
  if (s.signedOut) return { isLoaded: true, isSignedIn: false, userId: null, sessionId: null, orgId: null, orgRole: null, orgSlug: null, getToken: async () => null, has: () => false, signOut: noop };
  return { isLoaded: true, isSignedIn: true, userId: s.userId, sessionId: s.sessionId, orgId: s.orgId, orgRole: s.orgRole, orgSlug: s.orgSlug, getToken: async () => s.token, has: () => true, signOut: noop };
}

export function useUser() {
  const s = useLane();
  if (!s) return { isLoaded: false, isSignedIn: undefined, user: undefined };
  if (s.signedOut) return { isLoaded: true, isSignedIn: false, user: null };
  return { isLoaded: true, isSignedIn: true, user: userOf(s) };
}

export function useSession() {
  const s = useLane();
  if (!s) return { isLoaded: false, isSignedIn: undefined, session: undefined };
  if (s.signedOut) return { isLoaded: true, isSignedIn: false, session: null };
  return { isLoaded: true, isSignedIn: true, session: { id: s.sessionId, status: 'active', lastActiveAt: new Date(), user: userOf(s), getToken: async () => s.token } };
}

export function useOrganization() {
  const s = useLane();
  if (!s) return { isLoaded: false, organization: undefined, membership: undefined };
  if (s.signedOut || !s.orgId) return { isLoaded: true, organization: null, membership: null };
  return { isLoaded: true, organization: orgOf(s), membership: { id: 'mem_lane', role: s.orgRole, permissions: [], organization: orgOf(s) } };
}

export function useOrganizationList() {
  const s = useLane();
  const mine = s && !s.signedOut && s.orgId ? [{ id: 'mem_lane', role: s.orgRole, permissions: [], organization: orgOf(s) }] : [];
  return { isLoaded: !!s, setActive: noop, createOrganization: noop, userMemberships: list(mine), userInvitations: list([]), userSuggestions: list([]) };
}

export function useClerk() {
  const s = useLane();
  return { loaded: !!s, signOut: noop, openSignIn: () => {}, openUserProfile: () => {}, openOrganizationProfile: () => {}, setActive: noop, user: s && !s.signedOut ? userOf(s) : null, session: null };
}

// Clerk's own widgets are not reproduced: a page that renders them is not graded by the lanes (/auth).
const standin = (name) => () => createElement('div', { 'data-lane-standin': name }, `${name} (Clerk's widget, not rendered in the lane console)`);
export const SignIn = standin('SignIn');
export const SignUp = standin('SignUp');
export const UserButton = standin('UserButton');
export const OrganizationSwitcher = standin('OrganizationSwitcher');

export function SignOutButton({ children }) {
  if (isValidElement(children)) return cloneElement(children, { onClick: () => {} });
  return createElement('button', { type: 'button' }, children ?? 'Sign out');
}
export function SignedIn({ children }) {
  const s = useLane();
  return s && !s.signedOut ? createElement(Fragment, null, children) : null;
}
export function SignedOut({ children }) {
  const s = useLane();
  return s && s.signedOut ? createElement(Fragment, null, children) : null;
}

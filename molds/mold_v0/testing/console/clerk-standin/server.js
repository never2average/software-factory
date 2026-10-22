// Lane stand-in for @clerk/nextjs/server (see package.json). The session is the __session cookie the lane world signed with
// the shell's mock Clerk key; here it is only DECODED, to know who the page is for: the API verifies it on every call.
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';

const SIGN_IN = '/auth/sign-in';

function claims(token) {
  try {
    const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(p + '='.repeat((4 - (p.length % 4)) % 4)));
  } catch {
    return null;
  }
}

function stateOf(token) {
  const c = token ? claims(token) : null;
  if (!c || !c.sub || (c.exp && c.exp * 1000 < Date.now())) return null;
  const orgId = c.o?.id ?? c.org_id ?? null;
  const rol = c.o?.rol ?? c.org_role ?? null;
  return { userId: c.sub, sessionId: c.sid ?? null, orgId, orgRole: rol ? (String(rol).startsWith('org:') ? rol : `org:${rol}`) : null, orgSlug: c.o?.slg ?? c.org_slug ?? null, token };
}

function authObject(s) {
  if (!s) return { userId: null, sessionId: null, orgId: null, orgRole: null, orgSlug: null, isAuthenticated: false, getToken: async () => null, has: () => false };
  const { token, ...rest } = s;
  return { ...rest, isAuthenticated: true, getToken: async () => token, has: () => true, sessionClaims: claims(token) };
}

export async function auth() {
  const jar = await cookies();
  return authObject(stateOf(jar.get('__session')?.value));
}
auth.protect = async () => {
  const a = await auth();
  if (!a.userId) redirect(SIGN_IN);
  return a;
};

const STOP = Symbol('lane-standin-sign-in');

export function clerkMiddleware(handler) {
  return async (req, evt) => {
    const a = authObject(stateOf(req.cookies.get('__session')?.value));
    const fn = async () => a;
    fn.protect = async () => {
      if (!a.userId) throw STOP;
      return a;
    };
    try {
      const r = handler ? await handler(fn, req, evt) : undefined;
      return r ?? NextResponse.next();
    } catch (e) {
      if (e === STOP) return NextResponse.redirect(new URL(SIGN_IN, req.url));
      throw e;
    }
  };
}

// Clerk's patterns are path-to-regexp strings whose groups are plain regular expressions ('/app/(.*)').
export function createRouteMatcher(patterns) {
  const list = (Array.isArray(patterns) ? patterns : [patterns]).map((p) => (p instanceof RegExp ? p : new RegExp(`^${p}$`)));
  return (req) => list.some((rx) => rx.test(req.nextUrl.pathname));
}

export async function currentUser() {
  return null;
}

'use client';
/**
 * The built-in sign-in in the browser (mold_v0-004): one read of /api/auth/session (src/builtin-auth.ts) shared by the
 * page, and the few Clerk hooks the console uses, answered from it in Clerk's shapes (src/lib/auth/index.ts picks these
 * or Clerk's own). The session itself is an httpOnly cookie the API server sets; nothing here can read or keep it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface BuiltinMembership { organization: { id: string; name: string; slug: string | null }; role: string; account_role: string | null; suspended: boolean }
export interface BuiltinSession {
  signed_in: boolean;
  session_id?: string;
  method?: string;
  user?: { id: string; email: string | null; first_name: string | null; last_name: string | null; google: boolean };
  active_organization?: { id: string; name: string; slug: string | null } | null;
  memberships?: BuiltinMembership[];
  /** Invitations to the person's own address not yet accepted (someone already in a workspace accepts each one). */
  invitations?: { id: string; role: string; expires_at: string; organization: { id: string; name: string } }[];
}

/** A change to /api/auth: JSON, same origin (the API refuses anything else). */
export async function authPost<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/auth${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { status: r.status });
  return j;
}

interface Ctx { loaded: boolean; session: BuiltinSession | null; reload: () => Promise<void> }
const AuthContext = createContext<Ctx>({ loaded: false, session: null, reload: async () => {} });

export function BuiltinAuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<BuiltinSession | null>(null);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    const r = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
    setSession(r?.ok ? ((await r.json().catch(() => null)) as BuiltinSession | null) : null);
    setLoaded(true);
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const value = useMemo(() => ({ loaded, session, reload }), [loaded, session, reload]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useBuiltinSession = () => useContext(AuthContext);

const signedInUser = (s: BuiltinSession | null) => (s?.signed_in && s.user ? s.user : null);

/** Sign out here, then go to `redirectUrl` (a full load, so nothing of the session stays in memory). */
export async function signOut(opts: { redirectUrl?: string } = {}) {
  await authPost('/sign-out').catch(() => {});
  window.location.href = opts.redirectUrl ?? '/auth/sign-in';
}

// ---------- Clerk-shaped hooks (only the fields the console reads) ----------

export function useAuth() {
  const { loaded, session } = useBuiltinSession();
  return { isLoaded: loaded, isSignedIn: Boolean(signedInUser(session)), userId: session?.user?.id ?? null, orgId: session?.active_organization?.id ?? null, sessionId: session?.session_id ?? null };
}

export function useUser() {
  const { loaded, session, reload } = useBuiltinSession();
  const u = signedInUser(session);
  const user = u ? {
    id: u.id, firstName: u.first_name, lastName: u.last_name,
    fullName: [u.first_name, u.last_name].filter(Boolean).join(' ') || null,
    imageUrl: '', emailAddresses: [{ emailAddress: u.email ?? '' }], primaryEmailAddress: { emailAddress: u.email ?? '' },
    externalAccounts: u.google ? [{ id: 'google', provider: 'oauth_google' }] : [],
    update: async (p: { firstName?: string; lastName?: string }) => { await authPost('/profile', { first_name: p.firstName ?? '', last_name: p.lastName ?? '' }); await reload(); },
    reload,
  } : null;
  return { isLoaded: loaded, isSignedIn: Boolean(u), user };
}

const clerkRole = (m: BuiltinMembership) => m.role;

export function useOrganization() {
  const { loaded, session } = useBuiltinSession();
  const active = session?.active_organization ?? null;
  const m = active ? session?.memberships?.find((x) => x.organization.id === active.id) : undefined;
  return {
    isLoaded: loaded,
    organization: active ? { id: active.id, name: active.name, slug: active.slug, hasImage: false, imageUrl: '' } : null,
    membership: m ? { role: clerkRole(m), permissions: [] as string[] } : null,
  };
}

export function useOrganizationList(_opts?: unknown) {
  const { loaded, session, reload } = useBuiltinSession();
  const data = (session?.memberships ?? []).filter((m) => !m.suspended).map((m) => ({
    id: `mem_${m.organization.id}`, role: clerkRole(m),
    organization: { id: m.organization.id, name: m.organization.name, slug: m.organization.slug, hasImage: false, imageUrl: '' },
  }));
  const setActive = async ({ organization }: { organization: string | null }) => {
    if (organization) await authPost('/active-org', { organization_id: organization });
    await reload();
  };
  // A first sign-in accepts the invited address's invitations; later ones are accepted here, one by one.
  const invitations = (session?.invitations ?? []).map((i) => ({
    id: i.id, role: i.role, publicOrganizationData: { id: i.organization.id, name: i.organization.name },
    accept: async () => { await authPost(`/invitations/${encodeURIComponent(i.id)}/accept`); await reload(); },
  }));
  return { isLoaded: loaded, setActive, userMemberships: { data, revalidate: reload, isLoading: !loaded }, userInvitations: { data: invitations, isLoading: !loaded } };
}

export function useClerk() {
  return { signOut };
}

export function useSession() {
  const { loaded, session } = useBuiltinSession();
  return { isLoaded: loaded, session: session?.session_id ? { id: session.session_id } : null };
}

/** Clerk's <SignOutButton>: wraps its one child (or a plain button) with a click that signs out. */
export function SignOutButton({ redirectUrl, children }: { redirectUrl?: string; children?: ReactNode }) {
  const go = () => void signOut({ redirectUrl });
  if (children && typeof children === 'object' && 'props' in (children as object)) {
    return <span role='presentation' onClick={go}>{children}</span>;
  }
  return <button type='button' onClick={go}>{children ?? 'Sign out'}</button>;
}

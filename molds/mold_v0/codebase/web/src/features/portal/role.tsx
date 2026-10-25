'use client';
// The signed-in person's role in this account (src/account-roles.ts, from GET /api/app/me): useAccountRole().can('launch')
// says whether something is allowed; <Allowed need='edit'> disables a button the role lacks, with a tooltip naming the
// role it needs. The server refuses the same things, so this only keeps people from pressing buttons that would fail.
import { useAuth } from '@/lib/auth';
import { cloneElement, isValidElement, useEffect, useState, type ReactElement } from 'react';
import type { RowAction } from '@/components/layout/record-view';
import { appApi } from '@/lib/api-client';

export type AccountRole = 'owner' | 'billing' | 'member' | 'viewer';
export type AccountPermission = 'read' | 'launch' | 'edit' | 'billing' | 'budget' | 'manage' | 'team';
export interface AccountRoleInfo { id: AccountRole; label: string; help: string }
interface Me { account_role: AccountRole; role_label: string; permissions: string[]; needs: Record<string, AccountRole>; roles: AccountRoleInfo[] }

export const ACCOUNT_ROLE_LABEL: Record<AccountRole, string> = { owner: 'Owner', billing: 'Billing manager', member: 'Member', viewer: 'Viewer' };

// One /me per organization, shared by every component on the page.
const cache = new Map<string, Promise<Me>>();

export function useAccountRole() {
  const { orgId } = useAuth();
  const key = orgId ?? '';
  const [me, setMe] = useState<Me | null>(null);
  // Why /me could not be read (no account, suspended, signed out): pages that wait for the role show it (mold_v0-131).
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let live = true;
    if (!cache.has(key)) cache.set(key, appApi<Me>('GET', '/me').catch((e) => { cache.delete(key); throw e; }));
    cache.get(key)!.then((m) => { if (live) { setMe(m); setError(null); } }, (e: Error) => { if (live) setError(e); });
    return () => { live = false; };
  }, [key]);
  // Until /me answers, nothing is shown as refused (the server still checks).
  const can = (p: AccountPermission) => !me || me.permissions.includes(p);
  const needs = (p: AccountPermission) => ACCOUNT_ROLE_LABEL[me?.needs[p] ?? 'owner'];
  const why = (p: AccountPermission) => (can(p) ? undefined
    : p === 'launch' || p === 'edit' ? `Viewers can read but not change things. Ask an account owner to make you a Member.` : `This needs the ${needs(p)} role. Ask an account owner.`);
  const lock = (a: RowAction, p: AccountPermission): RowAction => (can(p) ? a : { ...a, disabled: true, hint: needs(p) });
  return { role: me?.account_role ?? null, label: me?.role_label ?? null, roles: me?.roles ?? [], loaded: !!me, error, can, needs, why, lock };
}

/** Disables its one child when the role lacks `need`; the wrapper carries the tooltip. */
export function Allowed({ need, children }: { need: AccountPermission; children: ReactElement<{ disabled?: boolean }> }) {
  const { can, why } = useAccountRole();
  if (can(need) || !isValidElement(children)) return children;
  return <span title={why(need)} className='inline-flex cursor-not-allowed'>{cloneElement(children, { disabled: true })}</span>;
}

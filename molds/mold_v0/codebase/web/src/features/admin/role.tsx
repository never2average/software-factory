'use client';
// The signed-in admin's role (src/admin-roles.ts, from /admin/session): useAdminRole().can('keys') says whether a write
// is allowed; <Gate need='keys'> disables a button the role lacks, with a tooltip naming the role it needs. The server
// refuses the same writes, so this only keeps people from pressing buttons that would fail.
import { cloneElement, createContext, isValidElement, useContext, type ReactElement, type ReactNode } from 'react';
import type { RowAction } from '@/components/layout/record-view';

export type AdminRole = 'viewer' | 'support' | 'operator' | 'owner';
export type AdminPermission = 'read' | 'requests' | 'invite' | 'journeys' | 'accounts' | 'compute' | 'harnesses' | 'library' | 'email' | 'keys' | 'admins' | 'plans' | 'delete';
export interface AdminSession { role: AdminRole | null; permissions: string[]; needs: Record<string, AdminRole> }

export const ROLE_LABEL: Record<AdminRole, string> = { viewer: 'Viewer', support: 'Support', operator: 'Operator', owner: 'Owner' };

const Ctx = createContext<AdminSession>({ role: null, permissions: [], needs: {} });
export function AdminRoleProvider({ session, children }: { session: AdminSession; children: ReactNode }) {
  return <Ctx.Provider value={session}>{children}</Ctx.Provider>;
}

export function useAdminRole() {
  const s = useContext(Ctx);
  const can = (p: AdminPermission) => s.permissions.includes(p);
  const needs = (p: AdminPermission) => ROLE_LABEL[s.needs[p] ?? 'owner'];
  /** Why a write is off, in plain words (undefined when it is allowed). */
  const why = (p: AdminPermission) => (can(p) ? undefined : `This needs the ${needs(p)} role. Ask an Owner on the Admins page.`);
  /** A row action the role lacks: disabled, with the role it needs next to it. */
  const lock = (a: RowAction, p: AdminPermission): RowAction => (can(p) ? a : { ...a, disabled: true, hint: needs(p) });
  return { role: s.role, label: s.role ? ROLE_LABEL[s.role] : null, can, needs, why, lock };
}

/** Disables its one child (a button, a switch) when the role lacks `need`; the wrapper carries the tooltip. */
export function Gate({ need, children }: { need: AdminPermission; children: ReactElement<{ disabled?: boolean }> }) {
  const { can, why } = useAdminRole();
  if (can(need) || !isValidElement(children)) return children;
  return <span title={why(need)} className='inline-flex cursor-not-allowed'>{cloneElement(children, { disabled: true })}</span>;
}

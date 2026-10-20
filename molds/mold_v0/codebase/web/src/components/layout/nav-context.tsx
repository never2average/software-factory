'use client';
import { createContext, useContext, type ReactNode } from 'react';
import type { NavGroup } from '@/types';

/** Which area we are in, and its modules (from config/nav-config): read by the sidebar and the Cmd+K bar. */
export type Area = 'admin' | 'portal';
const NavCtx = createContext<{ area: Area; groups: NavGroup[] }>({ area: 'portal', groups: [] });
export const useNav = () => useContext(NavCtx);

export function NavProvider({ area, groups, children }: { area: Area; groups: NavGroup[]; children: ReactNode }) {
  return <NavCtx.Provider value={{ area, groups }}>{children}</NavCtx.Provider>;
}

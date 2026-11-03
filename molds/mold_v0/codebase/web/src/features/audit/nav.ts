// The staff access log's sidebar entry (mold_v0-197, src/audit-trail.ts): one entry at the end of the admin sidebar, for
// every admin, only where the profile turns an audit trail on; nothing otherwise. (The customer portal has none since
// mold_v0-209: a workspace's owners read theirs on Billing's Access log tab.)
import type { NavGroup } from '@/types';
import { auditOn } from './config';

export const withAuditNav = (groups: NavGroup[], url: string, roles?: string[]): NavGroup[] =>
  auditOn() ? [...groups, { label: 'Security', items: [{ title: 'Access log', url, icon: 'lock', items: [], ...(roles ? { roles } : {}) }] }] : groups;

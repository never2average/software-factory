// The access log's sidebar entry (mold_v0-197, src/audit-trail.ts): one entry at the end of the sidebar, for the
// workspace's owners (staff: every admin), only where the profile turns an audit trail on; nothing otherwise.
import type { NavGroup } from '@/types';
import { auditOn } from './config';

export const withAuditNav = (groups: NavGroup[], url: string, roles?: string[]): NavGroup[] =>
  auditOn() ? [...groups, { label: 'Security', items: [{ title: 'Access log', url, icon: 'lock', items: [], ...(roles ? { roles } : {}) }] }] : groups;

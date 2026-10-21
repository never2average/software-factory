import { NavGroup } from '@/types';
import { credentialPortalNav, packAdminNav, packPortalNav, recordAdminNav, recordPortalNav, usageAdminNav, usagePortalNav } from './pack-nav.generated';

/**
 * The modules of each area, shown in the left sidebar and in the Cmd+K bar.
 * /admin: Octillion staff across every account. /app: one account's people (account admins see management controls).
 */
export const adminNav: NavGroup[] = [
  {
    label: 'Onboarding',
    items: [
      { title: 'Overview', url: '/admin', icon: 'dashboard', shortcut: ['g', 'o'], items: [] },
      { title: 'Access requests', url: '/admin/requests', icon: 'inbox', shortcut: ['g', 'r'], items: [] },
      { title: 'Accounts', url: '/admin/accounts', icon: 'building', shortcut: ['g', 'a'], items: [] }
    ]
  },
  {
    label: 'Engagement',
    items: [{ title: 'Journeys', url: '/admin/journeys', icon: 'route', shortcut: ['g', 'j'], items: [] }]
  },
  {
    label: 'Insights',
    items: [
      { title: 'Analytics', url: '/admin/analytics', icon: 'chartBar', shortcut: ['g', 'n'], items: [] },
      { title: 'Health', url: '/admin/health', icon: 'gauge', shortcut: ['g', 'h'], items: [] }
    ]
  },
  {
    label: 'Library',
    items: [
      { title: 'Personas', url: '/admin/personas', icon: 'userPen', shortcut: ['g', 'p'], items: [] },
      { title: 'Tasks', url: '/admin/tasks', icon: 'kanban', shortcut: ['g', 't'], items: [] }
    ]
  },
  {
    label: 'Operations',
    items: [
      { title: 'Compute', url: '/admin/compute', icon: 'adjustments', shortcut: ['g', 'c'], items: [] },
      { title: 'FinOps', url: '/admin/finops', icon: 'trendingUp', items: [] },
      { title: 'Harness mix', url: '/admin/agents', icon: 'code', items: [] },
      { title: 'Agent configuration', url: '/admin/configuration', icon: 'settings', items: [] },
      { title: 'Key vault', url: '/admin/keys', icon: 'lock', shortcut: ['g', 'k'], items: [] },
      { title: 'Admins', url: '/admin/admins', icon: 'teams', items: [] }
    ]
  },
  // The packs' pages (scripts/gen-packs.mjs, mold_v0-038), after the shell's own; then their shared record areas (mold_v0-047).
  ...packAdminNav,
  ...recordAdminNav,
  // Usage in neutral words (mold_v0-008), when the build has a pack.
  ...usageAdminNav
];

export const portalNav: NavGroup[] = [
  {
    label: 'Get started',
    items: [{ title: 'Setup & training', url: '/app', icon: 'rocket', shortcut: ['g', 's'], items: [] }]
  },
  {
    label: 'Insights',
    items: [
      { title: 'Usage', url: '/app/usage', icon: 'chartLine', shortcut: ['g', 'u'], items: [] },
      { title: 'Pick rate', url: '/app/pick-rate', icon: 'trendingUp', shortcut: ['g', 'v'], items: [] }
    ]
  },
  {
    label: 'Context',
    items: [
      { title: 'Company', url: '/app/context/company', icon: 'building', shortcut: ['g', 'c'], items: [] },
      { title: 'Users', url: '/app/context/users', icon: 'teams', items: [] },
      { title: 'Products', url: '/app/context/products', icon: 'product', shortcut: ['g', 'p'], items: [] },
      { title: 'Journeys', url: '/app/journeys', icon: 'route', shortcut: ['g', 'j'], items: [] }
    ]
  },
  {
    // What simulations run with: the account's own developers and tasks (Octillion-curated ones shown by name only).
    label: 'Private data',
    items: [
      { title: 'Developer personas', url: '/app/personas', icon: 'userPen', shortcut: ['g', 'd'], items: [] },
      { title: 'Programming tasks', url: '/app/tasks', icon: 'kanban', shortcut: ['g', 't'], items: [] }
    ]
  },
  {
    label: 'Operational',
    items: [
      { title: 'Billing', url: '/app/billing', icon: 'billing', shortcut: ['g', 'b'], items: [] },
      { title: 'Profile', url: '/app/profile', icon: 'account', items: [] }
    ]
  },
  // The packs' pages (scripts/gen-packs.mjs, mold_v0-038), after the shell's own; then their record areas (mold_v0-047)
  // and, when a pack declares a credential field, the workspace's Credentials page (mold_v0-034).
  ...packPortalNav,
  ...recordPortalNav,
  ...credentialPortalNav,
  ...usagePortalNav
];

'use client';
// Data layer for the admin pages: React Query over adminApi (lib/api-client), shared types and labels.
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { adminApi } from '@/lib/api-client';

/** GET /api/admin/onboarding<path>, cached under ['admin', path]. `keep`: show the last result while a new path loads
 * (server-paged tables), so the table does not flash empty between pages. */
export function useAdmin<T>(path: string | null, opts: { refetchInterval?: number; keep?: boolean } = {}) {
  return useQuery<T>({
    queryKey: ['admin', path],
    queryFn: () => adminApi<T>('GET', path!),
    enabled: path != null,
    staleTime: 15_000,
    refetchInterval: opts.refetchInterval,
    placeholderData: opts.keep ? keepPreviousData : undefined
  });
}

/** A write: toasts the error, invalidates every admin query on success (lists, details and the badge counts). */
export function useAdminAction<V = void, R = any>(run: (v: V) => Promise<R>, opts: { success?: string | ((r: R) => string); invalidate?: QueryKey } = {}) {
  const qc = useQueryClient();
  return useMutation<R, Error, V>({
    mutationFn: run,
    onSuccess: (r) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      void qc.invalidateQueries({ queryKey: opts.invalidate ?? ['admin'] });
    },
    onError: (e) => toast.error(e.message)
  });
}

export const post = <R = any>(path: string, body?: unknown) => adminApi<R>('POST', path, body);

/** A customer account's roles (src/account-roles.ts), for the account pages' role pickers. */
export const ACCOUNT_ROLES = [{ id: 'owner', label: 'Owner' }, { id: 'billing', label: 'Billing manager' }, { id: 'member', label: 'Member' }, { id: 'viewer', label: 'Viewer' }] as const;
/** A member's or invitation's account role (older servers sent only Clerk's admin / member). */
export const accountRoleOf = (x: { role?: string | null; account_role?: string | null }) => x.account_role ?? (x.role === 'admin' ? 'owner' : 'member');
export const accountRoleLabel = (x: { role?: string | null; account_role?: string | null }) => ACCOUNT_ROLES.find((r) => r.id === accountRoleOf(x))?.label ?? 'Member';

export const STAGE_LABELS: Record<string, string> = {
  created: 'Account created',
  invited: 'Invited',
  joined: 'Joined',
  connected: 'Connected',
  first_call: 'First tool call',
  onboarded: 'Product onboarded',
  simulated: 'Simulation run',
  reported: 'Report read'
};

export interface Subscription {
  status: string;
  plan?: string | null;
  renews_at?: string | null;
  trial_end?: string | null;
  cancel_at_period_end?: boolean;
}

/** What approve / create / invite / issue-key / rotate return (src/admin.ts result()). */
export interface InviteResult {
  org: { slug: string; name: string };
  created?: boolean;
  key: string | null;
  connector_url: string;
  invitation: { id: string; email: string; state: string; role?: string; expires_at: string | null } | null;
  clients: { client: string; steps: string; snippet?: string }[];
  email: { to: string | null; subject: string; body: string; mailto: string | null };
}

export interface OrgRow {
  slug: string;
  name: string;
  contact: string | null;
  stage: string;
  stage_index: number;
  stage_label: string;
  next_step: string;
  clerk_org_id: string | null;
  members: number;
  pending_invites: number;
  active_keys: number;
  subscription: Subscription | null;
  last_seen: string | null;
  calls_7d: number;
  errors_7d: number;
  month_spend_usd: number;
  budget_usd: number;
  /** Where budget_usd comes from: an admin-set allowance, a live prepaid plan, or the default ($0: no runs). */
  budget_source: 'override' | 'plan' | 'default';
  /** Plans are invite-only: may this account subscribe? */
  prepaid_allowed: boolean;
  allowance_usd: number | null;
  attention: string[];
}

export interface OrgList {
  orgs: OrgRow[];
  stages: { id: string; label: string; next: string }[];
  stripe_error?: string;
}

export const accountHref = (slug: string) => `/admin/accounts/${encodeURIComponent(slug)}`;

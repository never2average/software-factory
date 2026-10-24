/**
 * The app's API, same origin (next.config.ts proxies it), so Clerk's session cookie authenticates every call.
 * Admin writes carry X-App-Admin: 1 (src/lib/env-names.ts ADMIN_HEADERS), which a cross-site form cannot send (CSRF).
 */
import { ADMIN_HEADERS } from '@/lib/env-names';
export class ApiError extends Error {
  constructor(message: string, public status: number, public body: Record<string, unknown> = {}) {
    super(message);
  }
}

async function request<T>(url: string, method: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (res.status === 204) return null as T;
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401 && typeof window !== 'undefined') window.location.href = `/auth/sign-in?redirect_url=${encodeURIComponent(window.location.pathname)}`;
  if (!res.ok) throw new ApiError(String(json.error ?? `Request failed (${res.status})`), res.status, json);
  return json as T;
}

/** /api/admin/onboarding/* (platform admins). */
export const adminApi = <T = any>(method: string, path: string, body?: unknown) =>
  request<T>(`/api/admin/onboarding${path}`, method, body, method === 'GET' ? {} : ADMIN_HEADERS);

/** /api/admin/data/* (platform admins: shared record areas and the data repositories, src/data-routes.ts). */
export const adminDataApi = <T = any>(method: string, path: string, body?: unknown) =>
  request<T>(`/api/admin/data${path}`, method, body, method === 'GET' ? {} : ADMIN_HEADERS);

/** /api/app/* (the signed-in person's active account). `headers`: say, If-Match on a save that checks the version. */
export const appApi = <T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  request<T>(`/api/app${path}`, method, body, method === 'GET' ? headers : { 'X-Pack-Request': '1', ...headers });

/** Back-compat for template code that used apiClient('/x'). */
export async function apiClient<T>(endpoint: string, options?: RequestInit): Promise<T> {
  return request<T>(`/api${endpoint}`, options?.method ?? 'GET', options?.body ? JSON.parse(String(options.body)) : undefined);
}

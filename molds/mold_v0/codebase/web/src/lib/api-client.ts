/**
 * The Octillion API, same origin (next.config.ts proxies it), so Clerk's session cookie authenticates every call.
 * Admin writes carry X-Octillion-Admin: 1, which a cross-site form cannot send (CSRF).
 */
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
  request<T>(`/api/admin/onboarding${path}`, method, body, method === 'GET' ? {} : { 'X-Octillion-Admin': '1' });

/** /api/app/* (the signed-in person's active account). `headers`: say, If-Match on a save that checks the version. */
export const appApi = <T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => request<T>(`/api/app${path}`, method, body, headers);

/** Back-compat for template code that used apiClient('/x'). */
export async function apiClient<T>(endpoint: string, options?: RequestInit): Promise<T> {
  return request<T>(`/api${endpoint}`, options?.method ?? 'GET', options?.body ? JSON.parse(String(options.body)) : undefined);
}

'use client';
// The developer console's side of /api/developer (mold_v0-201; src/developer-routes.ts): what the app offers, the
// workspace's keys, webhook endpoints and their deliveries, allowed origins and inbound sources. Reading needs the
// account's `read` (every role); every change, and revealing a webhook secret, needs `manage` (an owner). A change carries
// X-Pack-Request: 1 (the cookie's CSRF rule, as the data API).
import { httpError } from '@/features/status/from-error';

export interface Offer {
  openapi: string; api_versions: string[]; api_version: string; scopes: string[]; sdk_languages: string[];
  events: { name: string; description?: string; about: string }[];
  client_sessions: { ttl_seconds: number; scopes: string[]; allowed_origins: string[] };
  receivers: { name: string; description: string | null; area: string }[];
}
export interface DevKey {
  id: number; name: string; kind: 'secret' | 'integration'; scopes: string[]; key_prefix: string; api_version: string;
  created_by: string | null; created_at: string; expires_at: string | null; last_used_at: string | null; revoked_at: string | null;
  rotated_from: number | null; state: 'active' | 'expired' | 'revoked';
}
export interface Endpoint {
  id: string; url: string; description: string | null; events: string[]; status: 'enabled' | 'disabled'; disabled_reason: string | null;
  failure_streak: number; secret_rotated_at: string | null; secret_revealed_at: string | null; secret_reveals: number; created_at: string; updated_at: string;
}
export interface Attempt { at: string; status: number | null; ms: number; error?: string }
export interface Delivery {
  id: string; endpoint_id: string; event_type: string; status: 'pending' | 'succeeded' | 'failed'; attempts: number; attempt_log: Attempt[];
  next_attempt_at: string | null; last_status: number | null; last_error: string | null; created_at: string; delivered_at: string | null;
  payload: unknown;
}
export interface Source {
  id: string; receiver: string; description: string | null; path: string; created_at: string; disabled_at: string | null;
  last_received_at: string | null; received: number;
}
export interface SourceDelivery { id: string; at: string; state: 'written' | 'writing'; written: number | null; area: string | null; skipped: string | null }

export async function dev<T>(method: string, path = '', body?: unknown): Promise<T> {
  const res = await fetch(`/api/developer${path}`, {
    method, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-pack-request': '1' } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {})
  });
  if (res.status === 204) return null as T;
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, json);
  return json;
}

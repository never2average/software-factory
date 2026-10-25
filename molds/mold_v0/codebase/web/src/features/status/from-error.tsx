'use client';
/**
 * An API answer a page could not use, as the console's status page (mold_v0-131): the portal's data hooks
 * (features/portal/shared.tsx ErrorState) and the admin console's (features/admin/ui.tsx ErrorBox) show this instead of an
 * error card or nothing.
 *
 *   401                      signed out: the sign-in page, back here after (as lib/api-client.ts does for its calls)
 *   403 no_account           the hand-off to the portal's page for people in no account (./no-account.tsx)
 *   403 suspended            access paused
 *   403 forbidden, viewer_role and the rest: the role it needs (the API's `needs`), and whom to ask
 *   404                      not found (a record that is not there, or not this person's: never which)
 *   5xx, or no answer        something went wrong / the server could not be reached, with Try again
 *   any other answer         the error page, in the server's own words (they say what to change)
 */
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { ApiError } from '@/lib/api-client';
import { noAccountHandoff } from './no-account';
import { StatusPage } from './status-page';
import { accountRoleLabel, adminRoleLabel, areaOf, signInHref, type StatusArea, type StatusKind } from './words';

/** What a fetch helper throws for a refused answer: its status and body go along (lib/api-client.ts ApiError). */
export function httpError(status: number, body: unknown, fallback = `Request failed (${status})`): ApiError {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return new ApiError(typeof b.error === 'string' && b.error ? b.error : fallback, status, b);
}

export interface ErrorStatus { kind: StatusKind; status: number | null; code: string | null; needs: string | null; message: string }

/** The status an error stands for. */
export function statusOf(error: unknown): ErrorStatus {
  const e = error as { status?: unknown; body?: { code?: unknown; needs?: unknown }; message?: unknown; name?: unknown };
  const status = typeof e?.status === 'number' ? e.status : null;
  const code = typeof e?.body?.code === 'string' ? e.body.code : null;
  const needs = typeof e?.body?.needs === 'string' ? e.body.needs : null;
  const message = typeof e?.message === 'string' ? e.message : String(error);
  // fetch() rejects with a TypeError when there is no answer at all.
  if (status === null) return { kind: e?.name === 'TypeError' || /failed to fetch|network|load failed/i.test(message) ? 'offline' : 'error', status, code, needs, message };
  const kind: StatusKind = status === 401 ? 'signed_out'
    : status === 403 ? (code === 'no_account' ? 'no_account' : code === 'suspended' ? 'suspended' : 'denied')
    : status === 404 ? 'not_found'
    : 'error';
  return { kind, status, code, needs, message };
}

/** True when an error is one the status page says better than a message: signed out, refused, not found. */
export const isStatusError = (error: unknown): boolean => {
  const s = statusOf(error).status;
  return s === 401 || s === 403 || s === 404;
};

export interface ApiErrorStatusProps {
  error: unknown;
  area?: StatusArea;
  /** Try again: re-runs the load (else the page reloads). */
  onRetry?: () => void;
  frame?: 'full' | 'inline';
  level?: 1 | 2;
}

/** The status page for an error a page's data load met. */
export function ApiErrorStatus({ error, area, onRetry, frame = 'inline', level = 2 }: ApiErrorStatusProps) {
  const s = statusOf(error);
  const pathname = usePathname();
  const where = area ?? (areaOf(pathname) === 'admin' ? 'admin' : 'app');
  // Signed out: on to the sign-in page, back here after (the page says so meanwhile).
  useEffect(() => {
    if (s.kind !== 'signed_out' || typeof window === 'undefined') return;
    const t = setTimeout(() => window.location.assign(signInHref(window.location.pathname + window.location.search)), 1200);
    return () => clearTimeout(t);
  }, [s.kind]);
  if (s.kind === 'no_account') return noAccountHandoff({ frame, level });
  const role = s.kind === 'denied' ? (where === 'admin' ? adminRoleLabel(s.needs) : accountRoleLabel(s.needs)) : null;
  // An answer that is none of the above (400, 409, 429 ...): the server's own sentence says what to change.
  const detail = s.kind === 'error' && s.status !== null && s.status < 500 ? s.message : null;
  return <StatusPage kind={s.kind} area={where} frame={frame} level={level} role={role} onRetry={onRetry} detail={detail} />;
}

/**
 * PLATFORM AUDIT HOOK (mold_v0-193 -> mold_v0-197). The developer API tells this module about every request it answers
 * (the credential, the actor it asserted, the scopes it held and used, the answer) and about the actions on secrets
 * (a webhook secret revealed or rotated). Ticket mold_v0-197 builds the platform audit trail (profile/spec
 * `audit.platform`): it registers its writer with setPlatformAuditSink and these entries become rows of that trail.
 * Until then (and in a build without the trail) nothing is written: an entry with no sink is dropped, and the developer
 * surface records what it must itself (a webhook secret's reveals on its endpoint row, src/developer-webhooks.ts).
 * A sink's failure never fails the request it describes.
 */

export interface PlatformAuditEntry {
  orgId: number;
  /** "api.request", "webhook.secret_reveal", "webhook.secret_rotate", "key.create", ... */
  action: string;
  /** Who: "key:sk_ab12cd", "key:sk_ab12cd as user-1", "session:cses_…", "member:<user id>". */
  actor: string | null;
  /** What it was about: a request's method and path, an endpoint's id. */
  target?: string;
  /** The scopes the credential held, and those the request was narrowed to (X-Scope). */
  scopes?: string[];
  status?: number;
  request_id?: string;
  at?: string;
}

let sink: ((e: PlatformAuditEntry) => unknown) | null = null;
/** mold_v0-197 registers its trail's writer here; null removes it. */
export function setPlatformAuditSink(fn: ((e: PlatformAuditEntry) => unknown) | null) { sink = fn; }
/** Hand an entry to the platform audit trail, if one is registered. */
export function auditPlatform(e: PlatformAuditEntry): void {
  if (!sink) return;
  try { void Promise.resolve(sink({ at: new Date().toISOString(), ...e })).catch((x) => console.error(`platform audit: ${(x as Error).message}`)); }
  catch (x) { console.error(`platform audit: ${(x as Error).message}`); }
}

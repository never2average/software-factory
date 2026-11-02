// The developer console's plain helpers (mold_v0-201), with no import, so the offline console test reads them as they
// are (scripts/developer-console-test.ts): which tabs an app shows, a payload as the delivery log shows it (never a
// credential), deliveries per day for the log's sparkline, and each scope in words.

/** The console's tabs: keys, webhooks and allowed origins always; Inbound only where the app takes webhooks in. */
export function developerTabs(inbound: boolean): { id: string; label: string }[] {
  return [
    { id: 'keys', label: 'API keys' },
    { id: 'webhooks', label: 'Webhooks' },
    { id: 'origins', label: 'Allowed origins' },
    ...(inbound ? [{ id: 'inbound', label: 'Inbound webhooks' }] : [])
  ];
}

/** A webhook payload as the delivery log shows it: any field named like a credential is masked (none should be there). */
const SECRET_NAME = /(secret|password|passwd|token|api[_-]?key|authorization|cookie|signature)/i;
export function redacted(v: unknown, depth = 0): unknown {
  if (depth > 12) return '…';
  if (Array.isArray(v)) return v.map((x) => redacted(x, depth + 1));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_NAME.test(k) ? '••••••' : redacted(x, depth + 1)]));
  }
  if (typeof v === 'string' && /^(sk_|cs_|whsec_)/.test(v)) return `${v.slice(0, 6)}••••••`;
  return v;
}

/** Counts per day for the last `days` days (oldest first), from ISO times. */
export function perDay(times: string[], days = 14, now = Date.now()): number[] {
  const out = Array.from({ length: days }, () => 0);
  const day = 86_400_000;
  const end = Math.floor(now / day);
  for (const t of times) {
    const i = days - 1 - (end - Math.floor(Date.parse(t) / day));
    if (i >= 0 && i < days) out[i]! += 1;
  }
  return out;
}

export const SCOPE_HELP: Record<string, string> = {
  read: 'Read records and runs',
  write: 'Create, change and delete records',
  run: 'Start and cancel runs',
  sessions: 'Mint client sessions for your users',
  webhooks: 'Manage webhook endpoints'
};
export const NARROWABLE = new Set(['read', 'write', 'run']);

// mold_v0-298: thousands separators ("$1,000.00"), as money(); en-US so the dollar sign leads on every screen.
export const usd = (n: unknown) => (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (cents: number | null | undefined, currency?: string) =>
  cents == null ? '' : (cents / 100).toLocaleString(undefined, { style: 'currency', currency: (currency || 'usd').toUpperCase(), maximumFractionDigits: 0 });
export const num = (n: unknown) => Number(n || 0).toLocaleString();
// Dropdown options read as their label only: item counts are off app-wide (callers still pass the count).
export const counted = (label: string, _n?: number | null) => label;

/**
 * The console's one written date (mold_v0-329), as a record's dates read (features/records/detail-layout.ts dateWords):
 * "20 Nov 2026", and with its time "20 Nov 2026, 11:54 UTC" (seconds where a list tells apart events in one minute:
 * "20 Nov 2026, 11:54:07 UTC"). Lists, logs and pages use these; a near date stays in words only where a page means it
 * ("3 minutes ago", <When>). '' for nothing or a value that is no date.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const timeOf = (v: string | number | Date | null | undefined) => {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isFinite(t) ? t : null;
};
export function dayText(v: string | number | Date | null | undefined): string {
  const t = timeOf(v);
  if (t == null) return '';
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
export function dateTimeText(v: string | number | Date | null | undefined, opts: { seconds?: boolean } = {}): string {
  const t = timeOf(v);
  if (t == null) return '';
  const d = new Date(t), two = (n: number) => String(n).padStart(2, '0');
  return `${dayText(t)}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}${opts.seconds ? `:${two(d.getUTCSeconds())}` : ''} UTC`;
}

/** "3h ago"; pair with title={new Date(d).toLocaleString()} for the exact time. */
export function relative(d: string | Date | null | undefined) {
  if (!d) return 'never';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 0) return `in ${Math.ceil(-s / 86400)}d`;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}

/**
 * A company's headcount band, in one of four forms only: "<20", "100-499", "10,000+", or "-" when unknown. Solo and
 * freelance read "<2"; a single exact number can't be trusted, so it reads "-" like anything else unrecognised.
 */
export function companySize(raw: string | null | undefined): string {
  const t = (raw ?? '').toLowerCase().replace(/employees?|people|staff|org(?:anisation|anization)? size/g, '').trim();
  const n = (x: string) => Number(x.replace(/[,\s]/g, ''));
  const f = (v: number) => v.toLocaleString('en-US');
  if (!t) return '-';
  if (/\b(solo|freelanc|sole proprietor|self[- ]employed|independent|just me)\b/.test(t)) return '<2';
  let m = t.match(/^(?:less than|fewer than|under|below|<)\s*([\d,]+)/);
  if (m) return `<${f(n(m[1]))}`;
  m = t.match(/^(?:more than|over|above)\s*([\d,]+)/) ?? t.match(/^([\d,]+)\s*(?:\+|or more|and (?:up|above))/);
  if (m) return `${f(n(m[1]))}+`;
  m = t.match(/^([\d,]+)\s*(?:-|–|—|to)\s*([\d,]+)$/);
  if (m) return `${f(n(m[1]))}-${f(n(m[2]))}`;
  return '-';
}

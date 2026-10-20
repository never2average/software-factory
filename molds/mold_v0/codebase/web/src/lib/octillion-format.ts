export const usd = (n: unknown) => `$${Number(n || 0).toFixed(2)}`;
export const money = (cents: number | null | undefined, currency?: string) =>
  cents == null ? '' : (cents / 100).toLocaleString(undefined, { style: 'currency', currency: (currency || 'usd').toUpperCase(), maximumFractionDigits: 0 });
export const num = (n: unknown) => Number(n || 0).toLocaleString();
// Dropdown options read as their label only: item counts are off app-wide (callers still pass the count).
export const counted = (label: string, _n?: number | null) => label;

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

// What a record's create form takes from where it was opened (mold_v0-256, flag record_pages): fields filled in from the
// address (an Add <related record> action opens the form with ?new=1&<field>=<value>) and a Key made from the Title (an
// area with key_from_title). Pure, so scripts/record-pages-test.ts reads it without a browser; ./tab-action.tsx uses it.
// Relative imports only.
import { featureOn } from '../../config/features';

/** A form field as prefill reads it (src/tab-actions.ts FormField). */
interface PrefillField { name: string; type: string; multiple: boolean }
const listOf = (text: string) => text.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean);

/**
 * A new record's fields filled from the address (mold_v0-256, flag record_pages): an "Add <related record>" action opens
 * the area's form with `?new=1&<field>=<value>` (a list field: values comma-separated); only the form's own fields are read.
 */
export function prefill(fields: readonly PrefillField[], search = typeof window === 'undefined' ? '' : window.location.search): Record<string, unknown> {
  if (!featureOn('record_pages')) return {};
  const q = new URLSearchParams(search), out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = q.get(f.name);
    if (v === null || v === '' || f.type === 'file') continue;
    out[f.name] = f.multiple ? listOf(v) : f.type === 'boolean' ? v === 'true' : v;
  }
  return out;
}
/** A Key made from a Title (mold_v0-256: an area with key_from_title): lowercase words joined by -, at most 64 characters. */
export const keyFromTitle = (title: string) => title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');


/**
 * mold_v0-339: a number field kept as a share from 0 to 1 (unit "percent") is shown and typed as a percent in a form
 * (0.8 reads 80; 80 typed is stored 0.8), as its value reads on the record's page ("80%"); "percent_100" and "%" are
 * already 0 to 100 and only carry the % sign.
 */
interface UnitField { type: string; unit?: string | null }
const unitOf = (f: UnitField) => (f.type === 'number' ? (f.unit ?? '').trim().toLowerCase() : '');
export const isFractionPercent = (f: UnitField) => unitOf(f) === 'percent';
export const showsPercentSign = (f: UnitField) => ['percent', 'percent_100', '%'].includes(unitOf(f));
/** A stored share as the form shows it (0.8 -> "80"), else the value as it is. */
export const percentInput = (f: UnitField, v: unknown): unknown => {
  if (!isFractionPercent(f) || v === undefined || v === null || v === '') return v;
  const n = Number(v);
  return Number.isFinite(n) ? String(Number((n * 100).toPrecision(12))) : v;
};
/** A typed percent as it is stored (80 -> 0.8), else the number as it is. */
export const percentStored = (f: UnitField, n: number) => (isFractionPercent(f) ? Number((n / 100).toPrecision(12)) : n);
/** A bound of the field (its min or max, stored as a share) as the form's input takes it. */
export const percentBound = (f: UnitField, b: number | null) => (b === null ? undefined : isFractionPercent(f) ? Number((b * 100).toPrecision(12)) : b);

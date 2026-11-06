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


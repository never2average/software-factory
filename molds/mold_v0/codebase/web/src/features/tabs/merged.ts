// What an area tab's views draw (mold_v0-058, mold_v0-135): the area as the tab shows it. A tab over one area is that
// area with the tab's columns. A merged tab (pack.json `areas`) is one list over several areas, rows by key: its fields
// are its areas' (the first area declaring a name gives its label and type; an enum's options are every declaring
// area's, as src/metric-spec.ts tabField), its `source` column the first of a row's areas with a source word. The
// server merges the rows (/api/records/tabs/<pack>/<tab>, src/record-merge.ts); this only names what the views show.
import type { PackTabSpec, RecordAreaSpec, RecordFieldSpec } from '@/config/pack-nav.generated';
import { findRecordArea } from '@/features/records/registry';
import type { Page, RecordRow } from './board';

export const SOURCE_COLUMN = 'source';

/** The area the tab's views draw, or null when one of its areas is not in this build. */
export function viewArea(tab: PackTabSpec): RecordAreaSpec | null {
  if (!tab.areas) {
    const area = findRecordArea('app', tab.area ?? '');
    return area && { ...area, list_columns: tab.columns ?? area.list_columns };
  }
  const areas = tab.areas.map((a) => findRecordArea('app', a.area));
  if (areas.some((a) => !a)) return null;
  const own = areas[0]!;
  const fields: RecordFieldSpec[] = [];
  for (const a of areas as RecordAreaSpec[]) for (const f of a.fields) {
    const i = fields.findIndex((x) => x.name === f.name);
    if (i < 0) { fields.push(f); continue; }
    const first = fields[i]!;
    if (first.type !== 'enum' || f.type !== 'enum') continue;
    const have = (first.options ?? []).map((o) => (typeof o === 'string' ? o : o.value));
    fields[i] = { ...first, options: [...(first.options ?? []), ...(f.options ?? []).filter((o) => !have.includes(typeof o === 'string' ? o : o.value))] };
  }
  const words = [...new Set(tab.areas.flatMap((a) => (a.source ? [a.source] : [])))];
  if (words.length) fields.unshift({ name: SOURCE_COLUMN, label: 'Source', type: 'enum', options: words.map((w) => ({ value: w, label: w })) });
  return { ...own, label: tab.label, description: tab.description, fields, list_columns: tab.columns ?? own.list_columns, links: [], lifecycle: null };
}

/** Where a merged tab (or a filtered one, mold_v0-175) reads its rows (the server's merge or filter), or one area's list. */
export const tabRecordsUrl = (tab: PackTabSpec, area: RecordAreaSpec) =>
  tab.areas || tab.filtered ? `/api/records/tabs/${encodeURIComponent(tab.pack)}/${encodeURIComponent(tab.id)}` : `/api/records/${area.name}`;

/** A merged tab's rows with their source word (the first of each row's areas that has one) among their data. */
export function withSource(tab: PackTabSpec, page: Page): Page {
  if (!tab.areas?.some((a) => a.source)) return page;
  const word = (r: RecordRow) => tab.areas!.find((a) => a.source && r.areas?.includes(a.area))?.source ?? null;
  return { ...page, records: page.records.map((r) => ({ ...r, data: { ...r.data, [SOURCE_COLUMN]: word(r) } })) };
}

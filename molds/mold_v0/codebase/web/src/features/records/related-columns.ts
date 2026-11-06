// A tab's list columns computed from the records that point back to each row (mold_v0-256, flag record_pages; pack.json
// tabs[].columns {related: {area, via}, show: "count" | "latest:<field>"}): where they come from and how a cell reads.
// The server computes them as the person reading (GET /api/records/_page/_columns/<pack>/<tab>?keys=, the related area's
// read permission, the workspace's own records); ./record-pages.tsx RecordTableView draws them as columns of the table,
// sorted and filtered like the others. Relative imports only (scripts/record-pages-test.ts reads it).
import { featureOn } from '../../config/features';
import type { PackTabSpec, RecordAreaSpec } from '../../config/pack-nav.generated';

/** A computed column as the build passes it on (its id, place among the columns, heading, area and what it shows). */
export interface RelatedColumn { id: string; at: number; area: string; show: string; label: string }
export interface RelatedColumns { url: string; columns: RelatedColumn[] }
type WithRelated = Pick<PackTabSpec, 'pack' | 'id'> & { related_columns?: RelatedColumn[] };

/** A tab's computed columns and where to read them, while the flag is on (else none: the table as before). */
export function relatedColumnsOf(tab: WithRelated): RelatedColumns | undefined {
  const cols = tab.related_columns ?? [];
  if (!featureOn('record_pages') || !cols.length) return undefined;
  return { url: `/api/records/_page/_columns/${encodeURIComponent(tab.pack)}/${encodeURIComponent(tab.id)}`, columns: cols };
}
/** The field a latest:<field> column shows of its area (null for a count). */
export const latestField = (c: Pick<RelatedColumn, 'show'>, areas: readonly RecordAreaSpec[], area: string) => {
  if (!c.show.startsWith('latest:')) return null;
  return areas.find((a) => a.name === area)?.fields.find((f) => f.name === c.show.slice(7)) ?? null;
};
/** The rows' keys in requests of at most 200 (the API's most). */
export const keyChunks = (keys: readonly string[], size = 200) => Array.from({ length: Math.ceil(keys.length / size) }, (_, i) => keys.slice(i * size, (i + 1) * size));
/** Columns placed among the table's own: each at its declared place (after the record column), in order. */
export function placeColumns<T extends { key: string }>(own: T[], extra: (T & { at: number })[]): T[] {
  const out = [...own];
  for (const c of [...extra].sort((a, b) => a.at - b.at)) out.splice(Math.min(1 + c.at, out.length), 0, c);
  return out;
}

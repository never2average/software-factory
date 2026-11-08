// The record areas packs declare (mold_v0-047), from the generated web/src/config/pack-nav.generated.ts (scripts/gen-packs.mjs).
import { recordAdminNav, recordAreas, type RecordAreaSpec } from '../../config/pack-nav.generated';
import type { NavItem } from '../../types';

/** The area shown at /<base>/records/<name>, or null (a 404). Staff pages show the shared (platform) areas only. */
export function findRecordArea(base: 'app' | 'admin', name: string): RecordAreaSpec | null {
  return recordAreas.find((a) => a.name === name && (base === 'app' || a.scope === 'platform')) ?? null;
}

export const areaFieldLabel = (area: RecordAreaSpec, field: string) => area.fields.find((f) => f.name === field)?.label ?? field;

/** Where the pages read rows from (src/record-areas.ts): the workspace's view, or the staff's. */
export const recordsApi = (base: 'app' | 'admin') => (base === 'admin' ? '/api/admin/records' : '/api/records');

/** RECORDS_GROUP_BASE/<id>: a staff Records entry of in-page tabs (mold_v0-281, console.admin_records `tabs`). */
export const RECORDS_GROUP_BASE = '/admin/records-group';
/** The staff Records entries that hold several lists as in-page tabs, in the sidebar's order. */
export const recordGroups = (): (NavItem & { inPageTabs: NonNullable<NavItem['inPageTabs']> })[] =>
  recordAdminNav.flatMap((g) => g.items).filter((i): i is NavItem & { inPageTabs: NonNullable<NavItem['inPageTabs']> } => !!i.inPageTabs?.length);
/** The entry of in-page tabs at /admin/records-group/<id>, or null (a 404). */
export const findRecordGroup = (id: string) => recordGroups().find((i) => i.url === `${RECORDS_GROUP_BASE}/${id}`) ?? null;

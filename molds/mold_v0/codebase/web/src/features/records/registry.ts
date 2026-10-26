// The record areas packs declare (mold_v0-047), from the generated web/src/config/pack-nav.generated.ts (scripts/gen-packs.mjs).
import { recordAreas, type RecordAreaSpec } from '../../config/pack-nav.generated';

/** The area shown at /<base>/records/<name>, or null (a 404). Staff pages show the shared (platform) areas only. */
export function findRecordArea(base: 'app' | 'admin', name: string): RecordAreaSpec | null {
  return recordAreas.find((a) => a.name === name && (base === 'app' || a.scope === 'platform')) ?? null;
}

export const areaFieldLabel = (area: RecordAreaSpec, field: string) => area.fields.find((f) => f.name === field)?.label ?? field;

/** Where the pages read rows from (src/record-areas.ts): the workspace's view, or the staff's. */
export const recordsApi = (base: 'app' | 'admin') => (base === 'admin' ? '/api/admin/records' : '/api/records');

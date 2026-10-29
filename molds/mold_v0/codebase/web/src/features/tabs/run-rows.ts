// What a runs or reports tab shows of a run (mold_v0-176; ./runs.tsx draws them as the console's database table), pure so a
// test reads it without a browser (scripts/record-pages-test.ts): a run's states in order, its kind in the pack's words,
// the record it ran over (targets.asset), how long it took, its result counts, and the target column's name. Relative
// imports only.
import { JOB_KINDS } from '../../config/build-facts.generated';
import { recordAreas } from '../../config/pack-nav.generated';

export { JOB_KINDS };

/** A run as GET /api/runs lists it (src/view-routes.ts: src/runs.ts RunView and its result counts by status). */
export type Run = {
  id: string; pack: string; kind: string; status: string; cost_usd: number; budget_usd?: number; attempt?: number; max_attempts?: number;
  targets?: Record<string, unknown>; error_kind?: string | null; error: string | null; cancel_requested?: boolean;
  created_at: string; started_at: string | null; ended_at: string | null; results: Record<string, number>;
};
/** A record a run names: its area and key. */
export type Ref = { area: string; key: string };

/** A run's states, in the order a run goes through them (the filter's and the group's order). */
export const RUN_STATUSES = [
  { value: 'queued', label: 'Queued' }, { value: 'running', label: 'Running' }, { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' }, { value: 'cancelled', label: 'Cancelled' }
];
export const FINISHED = new Set(['succeeded', 'failed', 'cancelled']);
export const statusLabel = (s: string) => RUN_STATUSES.find((x) => x.value === s)?.label ?? s;
const RESULT_ORDER = ['fail', 'error', 'pass', 'not_applicable', 'unknown'];
export const RESULT_LABELS: Record<string, string> = { pass: 'Pass', fail: 'Fail', error: 'Error', not_applicable: 'Not applicable', unknown: 'Unknown' };
export const resultCounts = (r: Record<string, number>) => RESULT_ORDER.filter((s) => r[s]).map((s) => `${r[s]} ${RESULT_LABELS[s]!.toLowerCase()}`).join(', ');

/** A kind's label in the pack's words, else its name. */
export const runKindLabel = (pack: string, kind: string) => JOB_KINDS.find((k) => k.pack === pack && k.name === kind)?.label ?? kind;
/** The record a run ran over (targets.asset {area, key}), or null. */
export const runTarget = (r: Pick<Run, 'targets'>): Ref | null => {
  const a = r.targets?.asset as Partial<Ref> | undefined;
  return a && typeof a.area === 'string' && typeof a.key === 'string' ? { area: a.area, key: a.key } : null;
};
/** How long a run took in seconds (still running: so far), or null before it starts. */
export const runSeconds = (r: Pick<Run, 'started_at' | 'ended_at' | 'status'>, now = Date.now()) => {
  if (!r.started_at) return null;
  const end = r.ended_at ? Date.parse(r.ended_at) : r.status === 'running' ? now : null;
  return end === null ? null : Math.max(0, Math.round((end - Date.parse(r.started_at)) / 1000));
};
export const duration = (s: number | null) => (s == null ? '' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
export const when = (d: string | null) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** "Applications" -> "Application": a column of one record each reads in the singular. */
export const singular = (label: string) =>
  /ies$/i.test(label) ? label.replace(/ies$/i, 'y') : /(ss|us)$/i.test(label) ? label : /(ches|shes|xes|sses)$/i.test(label) ? label.replace(/es$/i, '') : label.replace(/s$/i, '');
/** The target column's name: the build's one asset area in the singular, else "Target". */
export const targetLabel = () => {
  const assets = recordAreas.filter((a) => a.role === 'asset' && a.scope === 'workspace');
  return assets.length === 1 ? singular(assets[0]!.label) : 'Target';
};
export const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);


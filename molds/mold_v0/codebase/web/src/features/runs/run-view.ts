// What a run's own page decides without drawing (mold_v0-256, flag record_pages; ./run-page.tsx draws it, the server's
// src/run-page.ts answers it): the page's data, which tabs have something to show, the timeline's lines, the cost against
// the budget and how long it ran. Pure, so scripts/record-pages-test.ts reads it without a browser. Relative imports only.
import type { LogLine } from '../records/log-lines';

type Level = LogLine['level'];
export interface EventLine { id: number; at: string; attempt: number; type: string; level: Level; source: string; message: string }
export interface ToolCall { id: number; at: string; name: string; input: unknown; output: unknown; error: string | null; ms: number | null }
export interface ModelUsage { model: string | null; provider: string | null; requests: number; input_tokens: number; output_tokens: number; cost_usd: number }
export type Ref = { area: string; key: string };
export interface RunHead {
  id: string; pack: string; kind: string; label: string; status: string; attempt: number; max_attempts: number; error_kind: string | null; error: string | null; cancel_requested: boolean;
  cost_usd: number; budget_usd: number; created_at: string; started_at: string | null; ended_at: string | null; by: string;
  record: (Ref & { title: string | null }) | null; target: Ref | null;
  /** mold_v0-262: a workspace agent's wake: its session (the page links to it). */
  session?: { id: string; title: string } | null;
}
/** A session's page on the agent's page (?session=<id>). */
export const sessionHref = (id: string) => `/app/agent?session=${encodeURIComponent(id)}`;
/** What GET /api/runs/<id>/page answers (src/run-page.ts runPage). */
export interface RunPageData {
  run: RunHead;
  can: { rerun: { disabled: string | null } | null; stop: { disabled: string | null } | null };
  timeline: { events: EventLine[]; more: boolean; last: number };
  agent: { harness: string | null; models: string[]; providers: string[]; turns: number | null; usage: ModelUsage[]; tools_allowed: string[] } | null;
  tools: ToolCall[];
  results: { outputs: { pattern: string; state: 'written' | 'missing' | 'pending' | 'unknown' }[]; counts: Record<string, number>; checks: { check: Ref; asset: Ref | null; status: string; evidence_ref: string | null }[] } | null;
  files: { files: { path: string; size: number | null; sha256: string | null; kind: 'output' | 'kept'; preview: unknown }[]; version: number | null } | null;
  related: (Ref & { title: string | null; how: string[] })[];
}
export type Since = { run: Pick<RunHead, 'status' | 'ended_at' | 'started_at' | 'cost_usd' | 'cancel_requested' | 'error'>; events: EventLine[]; tools: ToolCall[]; more: boolean; last: number };

export const LIVE = new Set(['queued', 'running']);
/** How often a live run's page asks for new events. */
export const RUN_POLL_MS = 2000;
/** The tabs a run's page may show, in order (each only when it has content). */
export const RUN_TABS = ['timeline', 'agent', 'tools', 'results', 'files', 'related'] as const;
export type RunTab = (typeof RUN_TABS)[number];
export const TAB_WORDS: Record<RunTab, string> = { timeline: 'Timeline', agent: 'Agent', tools: 'Tools', results: 'Results', files: 'Files', related: 'Related' };
/** Which tabs have something to show (pure: the run page test reads it). */
export function runTabs(d: Pick<RunPageData, 'timeline' | 'agent' | 'tools' | 'results' | 'files' | 'related'>): RunTab[] {
  return RUN_TABS.filter((t) => t === 'timeline' ? d.timeline.events.length > 0 : t === 'agent' ? !!d.agent : t === 'tools' ? d.tools.length > 0
    : t === 'results' ? !!d.results && (d.results.outputs.length > 0 || d.results.checks.length > 0) : t === 'files' ? !!d.files && (d.files.files.length > 0 || d.files.version !== null) : d.related.length > 0);
}
/** A run's events as the log viewer's lines (numbered in order). */
export const eventLines = (events: readonly EventLine[]): LogLine[] => events.map((e, i) => ({ n: i + 1, id: e.id, at: e.at, level: e.level, source: e.source, text: e.message }));
/** Its cost against its budget, in words: "$0.42 of $2.00". */
export const costWords = (cost: number, budget: number) => `$${cost.toFixed(2)} of $${budget.toFixed(2)}`;
/** How long it ran (counting while it runs). */
export function ranFor(r: Pick<RunHead, 'started_at' | 'ended_at' | 'status'>, now = Date.now()): number | null {
  if (!r.started_at) return null;
  const end = r.ended_at ? Date.parse(r.ended_at) : LIVE.has(r.status) ? now : null;
  return end === null ? null : Math.max(0, (end - Date.parse(r.started_at)) / 1000);
}


/**
 * A run's own page (mold_v0-256, flag record_pages; the console's /app/runs/<id>, web/src/features/runs/run-page.tsx):
 * what the page reads of one run of the person's own workspace, from what the run engine already keeps (src/runs.ts:
 * the run, its events, its results; gateway_usage: its spend; its kind's declaration), and its two actions. Served by
 * src/view-routes.ts runAppRouter while the flag is on (off: those routes do not exist, /api/runs answers as before).
 *
 *   GET  /api/runs/<id>/page          the run (its kind in the pack's words, the record it ran on, who started it, its
 *                                     cost against its budget), what this person may do with it (re-run, stop), and
 *                                     each tab's content: the timeline (its events as log lines), the agent (harness,
 *                                     model, turns, tokens and cost by model), the tools it called, its results (required
 *                                     outputs, the checks), the files it wrote, the records it touched or created
 *   GET  /api/runs/<id>/events?after=<event id>   the events since (the page polls while the run is queued or running)
 *   POST /api/runs/<id>/rerun         a new run of the same kind with the same input (and record), as its start tool
 *   POST /api/runs/<id>/stop          the run cancelled, as its cancel tool cancels one
 *
 * Who may: everyone in the workspace reads its runs (as /api/runs); a result names only records the person may read
 * (each area's read permission), a related record likewise. Re-run is the kind's start tool's permission (a kind that
 * writes only after an approval is never re-run from here), Stop the pack's cancel tool's; a pack's MCP settings that
 * withhold one withhold it here. Event data was redacted of the run's credentials when it was written
 * (src/credential-redact.ts) and is masked again for shapes of secrets (src/run-events.ts maskSecrets).
 */
import { getDb } from "./db.js";
import { PackError, type RecordRow } from "./pack-api.js";
import { maskSecrets } from "./run-events.js";
import { withTenant } from "./tenant-scope.js";
import type { Actor } from "./record-areas.js";

export const RUN_ID = /^run_[A-Za-z0-9_-]{1,80}$/;
/** The most events the page reads at once (the timeline then says how many more there are). */
export const EVENTS_MAX = 5000;

type Level = "error" | "warning" | "info" | "debug";
/** A run event as a line of the timeline: its level, its source and its words. */
export interface EventLine { id: number; at: string; attempt: number; type: string; level: Level; source: string; message: string }

const short = (v: unknown, n = 300) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const ERROR_TYPES = new Set(["failed", "agent_crashed", "credentials_refresh_failed", "agent_file_error", "workspace_hook_failed", "workspace_write_back_refused", "workspace_output_missing", "stderr"]);
const WARNING_TYPES = new Set(["retry", "cancel_requested", "cancelled", "waiting", "workspace_skipped", "workspace_ignored", "workspace_unchanged", "result_unmapped", "result_unresolved",
  "git_credentials_missing", "credentials_shadowed", "stop_requested", "pause_requested"]);
const DEBUG_TYPES = new Set(["agent_tools", "agent_inputs", "agent_checkout_repos", "credentials", "credentials_refreshed", "heartbeat"]);
/** The words of the events the engine and the runner write; any other is its type in words with its data. */
const WORDS: Record<string, (d: Record<string, unknown>) => string> = {
  queued: () => "Queued", claimed: (d) => `Started${d.worker_id ? ` on ${short(d.worker_id, 60)}` : ""}`, succeeded: () => "Succeeded",
  failed: (d) => `Failed${d.error ? `: ${short(d.error)}` : ""}`, cancelled: () => "Cancelled", cancel_requested: () => "Stop asked for",
  retry: (d) => `Retried${d.reason ? ` (${short(d.reason, 120)})` : ""}`, waiting: (d) => `Waiting${d.reason ? `: ${short(d.reason, 160)}` : ""}`,
  step_log: (d) => String(d.line ?? ""), stderr: (d) => String(d.tail ?? "").trim(),
  agent_checkout: (d) => `Checked out the agent at ${short(d.commit, 12)} (${d.files ?? 0} files)`, workspace_restored: (d) => `Workspace restored${d.version ? ` at version ${d.version}` : ""}`,
  workspace_written: (d) => (d.unchanged ? "Nothing changed in the workspace" : `Workspace written: version ${d.version}`), workspace_indexed: () => "Workspace indexed",
  agent_output: (d) => `Wrote ${short(d.path, 200)}`, agent_file: (d) => `Kept ${short(d.path, 200)}`, agent_usage: (d) => `Usage: ${Object.entries(d).map(([k, v]) => `${k} ${short(v, 40)}`).join(", ")}`,
  results_mapped: (d) => `Results read from ${short(d.file, 120)}: ${d.results ?? 0} results`, workspace_output_missing: (d) => `A required output is missing: ${short(d.missing, 200)}`,
  approval_used: (d) => `Approved preview ${short(d.preview_run_id, 40)} used`, agent_wake: () => "Agent woke", agent_end: (d) => `Agent ended${d.reason ? ` (${short(d.reason, 80)})` : ""}`,
};
/** Where an event comes from: a step's name, the engine, the agent, the workspace, a tool, the credentials. */
function sourceOf(type: string, d: Record<string, unknown>): string {
  if ((type === "step_log" || type === "stderr") && typeof d.step === "string") return d.step;
  if (type === "tool_call" || /^tool[.:]/.test(type)) return "tool";
  if (type.startsWith("agent_")) return "agent";
  if (type.startsWith("workspace_") || type.startsWith("result")) return "workspace";
  if (type.startsWith("credentials") || type.startsWith("git_credentials")) return "credentials";
  return "engine";
}
/** An event as a timeline line (its words masked for shapes of secrets). */
export function eventLine(e: { id: number | string; at: Date | string; attempt: number; type: string; data: unknown }): EventLine {
  const d = (e.data && typeof e.data === "object" ? e.data : {}) as Record<string, unknown>;
  const words = WORDS[e.type]?.(d) ?? `${e.type.replace(/[_.:]+/g, " ")}${Object.keys(d).length ? `: ${short(d)}` : ""}`;
  let level: Level = ERROR_TYPES.has(e.type) ? "error" : WARNING_TYPES.has(e.type) ? "warning" : DEBUG_TYPES.has(e.type) ? "debug" : "info";
  if (e.type === "step_log") level = /\b(error|fatal|exception|FAIL|failed)\b/.test(words) ? "error" : /\b(warn|warning)\b/i.test(words) ? "warning" : "info";
  if ((e.type === "tool_call" || /^tool[.:]/.test(e.type)) && d.error) level = "error";
  return { id: Number(e.id), at: new Date(e.at).toISOString(), attempt: e.attempt, type: e.type, level, source: sourceOf(e.type, d), message: maskSecrets(words).slice(0, 4000) };
}

/** A tool call the run made: its name, input and output (each masked), whether it failed, how long it took. */
export interface ToolCall { id: number; at: string; name: string; input: unknown; output: unknown; error: string | null; ms: number | null }
const masked = (v: unknown): unknown => { if (v === undefined) return null; const s = maskSecrets(JSON.stringify(v)); try { return JSON.parse(s); } catch { return s; } };
export function toolCall(e: { id: number | string; at: Date | string; type: string; data: unknown }): ToolCall {
  const d = (e.data && typeof e.data === "object" ? e.data : {}) as Record<string, unknown>;
  const name = String(d.name ?? d.tool ?? (e.type === "tool_call" ? "tool" : e.type.slice(5))).slice(0, 120);
  const ms = typeof d.ms === "number" ? d.ms : typeof d.duration_ms === "number" ? d.duration_ms : null;
  return { id: Number(e.id), at: new Date(e.at).toISOString(), name, input: masked(d.input ?? d.args ?? d.arguments), output: masked(d.output ?? d.result),
    error: d.error ? maskSecrets(short(d.error, 2000)) : null, ms };
}
export const isToolEvent = (type: string) => type === "tool_call" || /^tool[.:]/.test(type);

/** Usage by model: a harness's own report (an event's `models`), else the gateway's meter by provider. */
export interface ModelUsage { model: string | null; provider: string | null; requests: number; input_tokens: number; output_tokens: number; cost_usd: number }
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
export function modelsFromEvents(events: { type: string; data: unknown }[]): ModelUsage[] {
  const by = new Map<string, ModelUsage>();
  for (const e of events) {
    const m = (e.data as { models?: unknown } | null)?.models;
    if (!m || typeof m !== "object") continue;
    // The latest report wins per model (a harness reports running totals).
    for (const [model, u] of Object.entries(m as Record<string, Record<string, unknown>>)) by.set(model, { model, provider: typeof u?.provider === "string" ? u.provider : null,
      requests: num(u?.requests), input_tokens: num(u?.input_tokens), output_tokens: num(u?.output_tokens), cost_usd: num(u?.cost_usd) });
  }
  return [...by.values()].sort((a, b) => b.cost_usd - a.cost_usd);
}

interface RunRow {
  id: string; pack: string; kind: string; status: string; attempt: number; max_attempts: number; scope: Record<string, unknown>; targets: Record<string, unknown>;
  spec: Record<string, unknown>; cost_usd: number; budget_usd: number; error_kind: string | null; error: string | null; cancel_requested_at: Date | null;
  created_at: Date; started_at: Date | null; ended_at: Date | null; requested_by: string | null; record_area: string | null; record_key: string | null;
  harness_session_id: string | null; approval_id: string | null;
}
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const LIVE = new Set(["queued", "running"]);

/** The run row of the person's own workspace (404 when it is another's, or none). */
async function runRow(orgId: number, id: string): Promise<RunRow> {
  if (!RUN_ID.test(id)) throw new PackError("Not found", 404);
  const [r] = await withTenant(orgId, async () => (await getDb()).query<RunRow>(
    `SELECT id, pack, kind, status, attempt, max_attempts, scope, targets, spec, cost_usd, budget_usd, error_kind, error, cancel_requested_at, created_at, started_at, ended_at,
            requested_by, record_area, record_key, harness_session_id, approval_id FROM runs WHERE org_id = $1 AND id = $2`, [orgId, id]));
  if (!r) throw new PackError("Not found", 404);
  return r;
}
async function events(orgId: number, id: string, after: number, limit: number) {
  return withTenant(orgId, async () => (await getDb()).query<{ id: string; at: Date; attempt: number; type: string; data: unknown }>(
    `SELECT id, at, attempt, type, data FROM run_events WHERE org_id = $1 AND run_id = $2 AND id > $3 ORDER BY id LIMIT ${limit + 1}`, [orgId, id, after]));
}
/** The run's live cost: what it recorded, or the gateway's total while it runs, whichever is larger (src/run-spend.ts). */
async function liveCost(orgId: number, r: RunRow) {
  const [u] = await withTenant(orgId, async () => (await getDb()).query<{ usd: number }>("SELECT coalesce(sum(cost_usd), 0)::float AS usd FROM gateway_usage WHERE run_id = $1", [r.id]));
  return Math.max(Number(r.cost_usd), Number(u?.usd ?? 0));
}

export interface PageCaller { orgId: number; slug: string; userId: string | null; role: import("./account-roles.js").AccountRole | null; by: (id: string | null) => string }

/** What this person may do with the run: re-run it (or why not), stop it (while it is live). */
async function runActions(r: RunRow, c: PageCaller) {
  const { packOpWithheld } = await import("./mcp-withheld.js");
  const { generatedTools, permitted, startToolOf } = await import("./mcp-tools.js");
  const { findKind } = await import("./runs.js");
  const kind = findKind(r.pack, r.kind);
  const start = startToolOf(r.pack, r.kind);
  const gated = !!(kind as { approval?: unknown } | null)?.approval;
  const rerun = !kind || !start || packOpWithheld(r.pack, "start") || !permitted(start, c.role) ? null
    : { disabled: gated ? "This kind writes only after its preview is approved: start it from its own list." : null };
  const cancel = generatedTools().find((t) => t.op === "cancel_run" && t.pack === r.pack && t.door === "workspace" && !t.admin_only);
  const stop = cancel && permitted(cancel, c.role) ? { disabled: !LIVE.has(r.status) ? null : r.cancel_requested_at ? "A stop was asked for: it ends at its next heartbeat." : null, live: LIVE.has(r.status) } : null;
  return { rerun, stop: stop?.live ? { disabled: stop.disabled } : null, start, kind };
}

/** The whole page of run `id` for the caller (GET /api/runs/<id>/page). */
export async function runPage(c: PageCaller, id: string) {
  const { packOpWithheld } = await import("./mcp-withheld.js");
  const r = await runRow(c.orgId, id);
  if (packOpWithheld(r.pack, "run_status")) throw new PackError("Not found", 404);
  const { findArea, getFor, may } = await import("./record-areas.js");
  const actor: Actor = { role: c.role, userId: c.userId };
  const readable = (x: { area: string } | null) => !!x && (() => { const a = findArea(x.area); return !!a && may(a, "read", actor); })();
  const ev = await events(c.orgId, r.id, 0, EVENTS_MAX);
  const more = ev.length > EVENTS_MAX;
  const rows = ev.slice(0, EVENTS_MAX);
  const timeline = rows.filter((e) => !isToolEvent(e.type)).map(eventLine);
  const tools = rows.filter((e) => isToolEvent(e.type)).map(toolCall);
  const kind = (await import("./runs.js")).findKind(r.pack, r.kind) as ({ label?: string; agent?: Record<string, unknown> } | null);
  const spec = (r.spec ?? {}) as { label?: string; agent?: { command?: string[]; env?: Record<string, string>; required_outputs?: string[]; results?: string; tools?: string[] }; providers?: string[] };
  const agentSpec = spec.agent ?? null;

  // ---- the agent: harness, model, turns, usage by model
  let session: { model: string; provider: string; flavour: string } | null = null;
  if (r.harness_session_id) {
    const [s] = await withTenant(c.orgId, async () => (await getDb()).query<{ model: string; provider: string; flavour: string }>(
      "SELECT model, provider, flavour FROM harness_sessions WHERE org_id = $1 AND id = $2", [c.orgId, r.harness_session_id])).catch(() => []);
    session = s ?? null;
  }
  const reported = modelsFromEvents(rows);
  const metered = await withTenant(c.orgId, async () => (await getDb()).query<{ provider: string; requests: number; input_tokens: number; output_tokens: number; cost_usd: number }>(
    `SELECT provider, sum(requests)::int AS requests, sum(input_tokens)::float AS input_tokens, sum(output_tokens)::float AS output_tokens, sum(cost_usd)::float AS cost_usd
       FROM gateway_usage WHERE run_id = $1 GROUP BY provider ORDER BY 5 DESC`, [r.id]));
  const eventModels = [...new Set(rows.map((e) => (e.data as { model?: unknown } | null)?.model).filter((m): m is string => typeof m === "string"))];
  const envModels = Object.entries(agentSpec?.env ?? {}).filter(([k, v]) => /MODEL/i.test(k) && typeof v === "string" && !/\{/.test(v)).map(([, v]) => v);
  const models = [...new Set([...(session ? [session.model] : []), ...eventModels, ...envModels, ...reported.map((m) => m.model!).filter(Boolean)])];
  const usage: ModelUsage[] = reported.length ? reported : metered.map((m) => ({ model: models.length === 1 ? models[0]! : null, provider: m.provider, requests: num(m.requests),
    input_tokens: num(m.input_tokens), output_tokens: num(m.output_tokens), cost_usd: num(m.cost_usd) }));
  const turnEvents = rows.filter((e) => e.type === "agent_turn" || e.type === "turn").length;
  const turnsReported = rows.map((e) => (e.data as { turns?: unknown } | null)?.turns).filter((t): t is number => typeof t === "number");
  const turns = turnsReported.length ? Math.max(...turnsReported) : turnEvents || null;
  const harness = session ? session.flavour : agentSpec?.command?.length ? agentSpec.command.slice(0, 2).join(" ") : null;
  const agent = agentSpec || session || usage.length || turns ? { harness, models, providers: spec.providers ?? [], turns, usage, tools_allowed: agentSpec?.tools ?? [] } : null;

  // ---- results: required outputs and the checks
  const required = agentSpec?.required_outputs ?? [];
  const missingEv = rows.filter((e) => e.type === "workspace_output_missing").at(-1)?.data as { missing?: unknown } | undefined;
  const missing = new Set(Array.isArray(missingEv?.missing) ? (missingEv!.missing as unknown[]).map(String) : []);
  const outputs = required.map((p) => ({ pattern: p, state: missing.has(p) ? "missing" : r.status === "succeeded" ? "written" : LIVE.has(r.status) ? "pending" : missingEv ? "written" : "unknown" }));
  let checks: { check: { area: string; key: string }; asset: { area: string; key: string } | null; status: string; evidence_ref: string | null }[] = [];
  if (!packOpWithheld(r.pack, "run_results")) {
    const { runResults } = await import("./runs.js");
    checks = (await withTenant(c.orgId, () => runResults(c.orgId, r.id))).filter((x) => readable(x.check)).slice(0, 2000)
      .map((x) => ({ check: x.check, asset: readable(x.asset) ? x.asset : null, status: x.status, evidence_ref: x.evidence_ref }));
  }
  const counts: Record<string, number> = {};
  for (const x of checks) counts[x.status] = (counts[x.status] ?? 0) + 1;

  // ---- files: what it wrote (its outputs and the files its kind keeps) and the workspace's version
  const files = rows.filter((e) => e.type === "agent_output" || e.type === "agent_file").map((e) => {
    const d = (e.data ?? {}) as { path?: unknown; size?: unknown; sha256?: unknown; json?: unknown };
    return { path: String(d.path ?? ""), size: typeof d.size === "number" ? d.size : null, sha256: typeof d.sha256 === "string" ? d.sha256 : null,
      kind: e.type === "agent_output" ? "output" : "kept", preview: d.json === undefined ? null : masked(d.json) };
  }).filter((f) => f.path);
  const written = rows.filter((e) => e.type === "workspace_written").at(-1)?.data as { version?: number; unchanged?: boolean } | undefined;

  // ---- related records: the one it ran on, its target, the records its results name, the ones it created or changed
  const related = new Map<string, { area: string; key: string; how: string[] }>();
  const add = (x: { area: string; key: string } | null | undefined, how: string) => {
    if (!x || !readable(x)) return;
    const k = `${x.area}\u0000${x.key}`; const e = related.get(k) ?? { area: x.area, key: x.key, how: [] };
    if (!e.how.includes(how)) e.how.push(how); related.set(k, e);
  };
  if (r.record_area && r.record_key) add({ area: r.record_area, key: r.record_key }, "Ran on");
  const t = r.targets?.asset as { area?: unknown; key?: unknown } | undefined;
  if (t && typeof t.area === "string" && typeof t.key === "string") add({ area: t.area, key: t.key }, "Target");
  for (const x of checks.slice(0, 200)) { add(x.check, "Checked"); add(x.asset, "Checked"); }
  const writes = await withTenant(c.orgId, async () => (await getDb()).query<{ area: string; key: string; created: boolean }>(
    `SELECT area, key, written_by = $2 AS created FROM workspace_records WHERE org_id = $1 AND (written_by = $2 OR updated_by = $2) ORDER BY updated_at DESC LIMIT 100`, [c.orgId, `run:${r.id}`]));
  for (const w of writes) add({ area: w.area, key: w.key }, w.created ? "Created" : "Changed");
  const relatedRows: { area: string; key: string; title: string | null; how: string[] }[] = [];
  for (const x of [...related.values()].slice(0, 100)) {
    let row: RecordRow | null = null;
    try { row = await getFor(c.orgId, x.area, x.key, actor); } catch { row = null; }
    relatedRows.push({ ...x, title: row?.title ?? null });
  }

  const recordTitle = r.record_area && r.record_key && readable({ area: r.record_area }) ? relatedRows.find((x) => x.area === r.record_area && x.key === r.record_key)?.title ?? null : null;
  const acts = await runActions(r, c);
  return {
    run: {
      id: r.id, pack: r.pack, kind: r.kind, label: kind?.label ?? spec.label ?? r.kind, status: r.status, attempt: r.attempt, max_attempts: r.max_attempts,
      error_kind: r.error_kind, error: r.error ? maskSecrets(r.error) : null, cancel_requested: !!r.cancel_requested_at,
      cost_usd: await liveCost(c.orgId, r), budget_usd: Number(r.budget_usd), created_at: iso(r.created_at)!, started_at: iso(r.started_at), ended_at: iso(r.ended_at),
      by: c.by(r.requested_by), record: r.record_area && r.record_key && readable({ area: r.record_area }) ? { area: r.record_area, key: r.record_key, title: recordTitle } : null,
      target: t && typeof t.area === "string" && typeof t.key === "string" && readable({ area: t.area }) ? { area: t.area, key: String(t.key) } : null,
    },
    can: { rerun: acts.rerun, stop: acts.stop },
    timeline: { events: timeline, more, last: rows.length ? Number(rows[rows.length - 1]!.id) : 0 },
    agent, tools,
    results: required.length || checks.length ? { outputs, counts, checks } : null,
    files: files.length || written ? { files, version: written?.unchanged ? null : written?.version ?? null } : null,
    related: relatedRows,
  };
}

/** The events since `after` (the page's poll) and the run's state now. */
export async function runEventsSince(c: PageCaller, id: string, after: number) {
  const r = await runRow(c.orgId, id);
  const { packOpWithheld } = await import("./mcp-withheld.js");
  if (packOpWithheld(r.pack, "run_status")) throw new PackError("Not found", 404);
  const ev = await events(c.orgId, r.id, after, 1000);
  const rows = ev.slice(0, 1000);
  return {
    run: { status: r.status, ended_at: iso(r.ended_at), started_at: iso(r.started_at), cost_usd: await liveCost(c.orgId, r), cancel_requested: !!r.cancel_requested_at, error: r.error ? maskSecrets(r.error) : null },
    events: rows.filter((e) => !isToolEvent(e.type)).map(eventLine), tools: rows.filter((e) => isToolEvent(e.type)).map(toolCall),
    more: ev.length > 1000, last: rows.length ? Number(rows[rows.length - 1]!.id) : after,
  };
}

/** Re-run: a new run of the same kind with the run's own input, on the same record, as its start tool starts one. */
export async function rerun(c: PageCaller & { org: import("./auth.js").Org }, id: string) {
  const r = await runRow(c.orgId, id);
  const acts = await runActions(r, c);
  if (!acts.rerun || !acts.start) throw new PackError(`Re-running is not open to your role for this kind of run.`, 403);
  if (acts.rerun.disabled) throw new PackError(acts.rerun.disabled, 409);
  const input: Record<string, unknown> = { ...(r.scope ?? {}) };
  const t = r.targets ?? {};
  if ("target_asset" in acts.start.input && t.asset) input.target_asset = t.asset;
  if ("target_environment" in acts.start.input && t.environment) input.target_environment = t.environment;
  const { startFromConsole } = await import("./mcp-tools.js");
  const { onRecord } = await import("./runs.js");
  const go = () => startFromConsole(c.org, acts.start!, input);
  return r.record_area && r.record_key ? onRecord({ area: r.record_area, key: r.record_key }, go) : go();
}

/** Stop: the run cancelled (a queued one ends now; a running one stops spending now and ends at its next heartbeat). */
export async function stop(c: PageCaller, id: string) {
  const r = await runRow(c.orgId, id);
  const acts = await runActions(r, c);
  if (!LIVE.has(r.status)) throw new PackError(`This run has ended (${r.status}): there is nothing to stop.`, 409);
  if (!acts.stop) throw new PackError("Stopping runs is not open to your role.", 403);
  const { cancelRun } = await import("./runs.js");
  return { run: await cancelRun(c.orgId, r.id, c.userId) };
}

/**
 * The trace of a workspace agent's session (mold_v0-287; read by src/harness-sessions.ts sessionTrace, shown by
 * web/src/features/agent/session-trace.tsx): everything a session does, in order, as steps a person can read. Pure: it
 * only turns rows the session already has, and the run events the gateway and the harness record, into steps.
 *
 *   events    run_events of the session's wakes: the run engine's (claimed, waiting, failed, cancel_requested), the
 *             wake's own (agent_wake, agent_end, agent_crashed, agent_checkpoint, steer_*), the gateway's per request
 *             (model_call: src/gateway.ts) and the harness's per tool (agent_tool_call, agent_tool_result, agent_retry,
 *             agent_stage: src/agent-harness.ts). A step's full arguments and result (the input and result of a tool
 *             call's event) are left out of the list and read one step at a time. Event data was redacted when written
 *             (src/agent-harness.ts `clean`, again by src/runs.ts appendRunEvents) and is masked once more here.
 *   marks     rows the session keeps for itself: when each wake was queued, the sandboxes launched for it (no event is
 *             written as those move), what it asked for and the answers (harness_session_requests), its budget changes
 *             (harness_budget_grants). Listed whole on every read: they change in place.
 */
import { maskSecrets } from "./run-events.js";

export type TraceKind = "sandbox" | "wake" | "model" | "tool" | "command" | "approval" | "budget" | "note" | "message";
export type TraceStatus = "ok" | "error" | "running" | "waiting";
export interface TraceStep {
  /** "e<event id>", or "tool:<call id>" for a tool's call and result (one step), or a mark's own. */
  id: string; at: string; kind: TraceKind; status: TraceStatus; title: string; detail?: string | null;
  run_id?: string | null; wake?: number | null;
  /** A model call. */
  model?: string; input_tokens?: number; cached_tokens?: number; output_tokens?: number; cost_usd?: number; http_status?: number;
  /** A tool call: its short form (the rest is read with the step's own detail). */
  tool?: string; preview?: string | null; result_preview?: string | null;
  duration_ms?: number;
  /** What failed, in the upstream's or the program's own words. */
  error?: string | null;
  /** A message of the conversation, an entry in the same stream. */
  role?: "person" | "agent" | "system"; body?: string; by?: string | null; message_status?: string | null;
  /** mold_v0-290: what the person attached to this message (each file's name and size, each repository's name). */
  attachments?: { files: { name: string; bytes: number }[]; repositories: string[] } | null;
  /** The tool call a sub-agent's step belongs under. */
  parent?: string | null;
  /** Everything else worth showing when the step is opened. */
  fields?: Record<string, unknown>;
  /** Its full arguments and result are read from the step's own endpoint when it is opened. */
  more?: boolean;
}

export interface TraceEventRow { id: number | string; run_id: string; attempt: number; type: string; at: Date | string; data: Record<string, unknown> | null }
export interface TraceWakeRow { id: string; status: string; created_at: Date | string; started_at: Date | string | null; ended_at: Date | string | null; error: string | null; scope: { reason?: unknown } | null }
export interface TraceSandboxRow { run_id: string; attempt: number; state: string; sandbox_id: string | null; created_at: Date | string; ready_at: Date | string | null; claimed_at: Date | string | null; deleted_at: Date | string | null; launch_step: string | null; launch_error: string | null; reap_reason: string | null }
export interface TraceRequestRow { id: string; kind: string; subject: string; status: string; decided_by: string | null; decided_at: Date | string | null; reason: string | null; created_at: Date | string; detail: Record<string, unknown> | null }
export interface TraceMessageRow { id: number | string; role: "person" | "agent" | "system"; body: string; status: string | null; by_name: string | null; created_at: Date | string; run_id: string | null; attachments?: { files?: { name: string; bytes: number }[]; repositories?: string[] } | null }
export interface TraceGrantRow { id: string; from_usd: number; to_usd: number; reason: string; by: string; at: Date | string }

/** The run_events a retention sweep removes with the conversation (their arguments, results and error text are its content). */
export const TRACE_CONTENT_EVENTS = ["agent_tool_call", "agent_tool_result", "agent_retry", "model_call"];

const iso = (d: Date | string) => new Date(d).toISOString();
const usd = (n: number) => `$${n.toFixed(2)}`;
const cap = (s: unknown, n: number) => (typeof s === "string" ? maskSecrets(s).slice(0, n) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const clean = (v: unknown): unknown => { const s = maskSecrets(JSON.stringify(v)); try { return JSON.parse(s); } catch { return s; } };

const WAKE_REASON: Record<string, string> = { start: "its first message", message: "a new message", resume: "resumed", approval: "an approval", auto_resume: "continued by itself after a crash", raise: "its budget raised" };
const END_WORDS: Record<string, string> = { parked: "It went quiet and parked", paused: "It was paused", awaiting: "It needs a decision", budget: "It reached its budget", stopped: "It was stopped", done: "It finished its work", web_limit: "It used up its web calls", policy: "Its governance policy refused a call", failed: "It failed" };
const words = (t: string) => t.replaceAll("_", " ");

/** One run event as a step, or null for one with nothing to show of its own (a request's own row says it). */
function eventStep(e: TraceEventRow, wakes: Map<string, number>, toolTitle: (name: string) => string): TraceStep | null {
  const d = (e.data ?? {}) as Record<string, unknown>;
  // The moment it happened where that was recorded (a tool's call in the harness, a model call's start in the gateway), so
  // a step sent a beat later is not listed after what followed it; a time far from the event's own is not trusted.
  const stated = typeof d.t === "string" ? Date.parse(d.t) : NaN;
  const at = Number.isFinite(stated) && Math.abs(stated - new Date(e.at).getTime()) < 15 * 60_000 ? new Date(stated).toISOString() : iso(e.at);
  const base = { at, run_id: e.run_id, wake: wakes.get(e.run_id) ?? null };
  const id = `e${e.id}`;
  switch (e.type) {
    case "model_call": {
      const status = num(d.status) ?? 0;
      const failed = status >= 400 || status === 0 || !!d.error;
      return { ...base, id, kind: "model", status: failed ? "error" : "ok", title: d.no_key ? "No model key, so the call could not be made" : str(d.model) ?? "Model call", model: str(d.model), http_status: status || undefined,
        input_tokens: num(d.input_tokens), cached_tokens: num(d.cached_tokens), output_tokens: num(d.output_tokens), cost_usd: num(d.cost_usd), duration_ms: num(d.duration_ms),
        error: failed ? cap(d.error, 2000) : null, detail: str(d.provider) ?? null, fields: clean({ provider: d.provider, bytes: d.bytes, input_tokens: d.input_tokens, cached_tokens: d.cached_tokens, output_tokens: d.output_tokens, cost_usd: d.cost_usd, duration_ms: d.duration_ms }) as Record<string, unknown> };
    }
    case "agent_tool_call": {
      const name = str(d.name) ?? "tool";
      return { ...base, id: `tool:${str(d.id) ?? e.id}`, kind: name === "Bash" ? "command" : "tool", status: "running", title: toolTitle(name), tool: name, preview: cap(d.preview, 300), parent: str(d.parent) ?? null, more: true };
    }
    case "agent_tool_result": {
      const name = str(d.name) ?? "tool";
      return { ...base, id: `tool:${str(d.id) ?? e.id}`, kind: name === "Bash" ? "command" : "tool", status: d.is_error ? "error" : "ok", title: toolTitle(name), tool: name, result_preview: cap(d.preview, 300),
        duration_ms: num(d.duration_ms), error: d.is_error ? cap(d.preview, 600) : null, more: true };
    }
    case "agent_retry":
      return { ...base, id, kind: "model", status: "error", title: `It retries after a temporary model error (attempt ${num(d.retry) ?? "?"})`, error: cap(d.error, 2000) };
    case "agent_error":
      return { ...base, id, kind: "model", status: "error", title: "That step ended with an error", error: cap(d.error, 2000) };
    case "agent_stage":
      return { ...base, id, kind: "sandbox", status: "ok", title: str(d.stage) ?? "Getting ready" };
    case "agent_wake":
      return { ...base, id, kind: "wake", status: "ok", title: d.resume ? "It picked up where it left off" : "It started working", detail: num(d.checkpoint) != null ? `From checkpoint ${d.checkpoint}` : null, fields: clean(d) as Record<string, unknown> };
    case "agent_end": {
      const reason = str(d.reason) ?? "";
      return { ...base, id, kind: "wake", status: reason === "failed" || reason === "policy" ? "error" : "ok", title: END_WORDS[reason] ?? (reason ? `It stopped: ${words(reason)}` : "It stopped"), detail: str(d.detail) ? cap(d.detail, 400) : null, fields: clean(d) as Record<string, unknown> };
    }
    case "agent_crashed":
      return { ...base, id, kind: "wake", status: "error", title: "It stopped unexpectedly", fields: clean(d) as Record<string, unknown> };
    case "agent_checkpoint":
      return { ...base, id, kind: "note", status: "ok", title: "Its progress was saved", detail: num(d.bytes) != null ? `${Math.round(Number(d.bytes) / 1024)} KB` : null };
    case "steer_queued": return { ...base, id, kind: "note", status: "ok", title: "A message waits for its next step" };
    case "steer_delivered": return { ...base, id, kind: "note", status: "ok", title: "A message reached it" };
    case "pause_requested": return { ...base, id, kind: "note", status: "ok", title: `Pause asked by ${str(d.by) ?? "someone"}` };
    case "stop_requested": return { ...base, id, kind: "note", status: "ok", title: `Stop asked by ${str(d.by) ?? "someone"}` };
    case "cancel_requested": return { ...base, id, kind: "note", status: "ok", title: "It was asked to stop" };
    case "claimed": return { ...base, id, kind: "sandbox", status: "ok", title: "It was picked up to run" };
    case "queued": return null; // the wake's own mark says it
    case "waiting": return { ...base, id, kind: "sandbox", status: "waiting", title: `Waiting: ${cap(d.reason, 400) ?? "for a place to run"}` };
    case "failed": return { ...base, id, kind: "wake", status: "error", title: "It failed", error: cap(d.error, 2000), fields: clean(d) as Record<string, unknown> };
    case "agent_request": return null; // what it asked for has its own row (a mark)
    default:
      return { ...base, id, kind: "note", status: "ok", title: words(e.type), fields: clean(d) as Record<string, unknown> };
  }
}

/** What a message carried, as the trace shows it: names and sizes, masked like the words. */
const carried = (m: TraceMessageRow): TraceStep["attachments"] => {
  const files = m.attachments?.files ?? [], repositories = m.attachments?.repositories ?? [];
  return files.length || repositories.length ? { files: files.map((f) => ({ name: maskSecrets(f.name), bytes: f.bytes })), repositories: repositories.map(maskSecrets) } : null;
};
/** One message of the conversation as a step of the stream. */
export const messageStep = (m: TraceMessageRow, wakes: Map<string, number>): TraceStep =>
  ({ id: `m${m.id}`, at: iso(m.created_at), kind: "message", status: "ok", title: "", role: m.role, body: maskSecrets(m.body), by: m.by_name, message_status: m.status, run_id: m.run_id, wake: m.run_id ? wakes.get(m.run_id) ?? null : null, attachments: carried(m) });

/** The events in order, a tool's call and result merged into one step (the same merge the page applies across reads). */
export function traceSteps(events: readonly TraceEventRow[], wakeIndex: Map<string, number>, toolTitle: (name: string) => string = (n) => n): TraceStep[] {
  const out = new Map<string, TraceStep>();
  for (const e of events) {
    const s = eventStep(e, wakeIndex, toolTitle);
    if (!s) continue;
    const had = out.get(s.id);
    out.set(s.id, had ? { ...had, ...s, at: had.at, preview: had.preview ?? s.preview } : s);
  }
  return [...out.values()];
}

const requestAsk = (r: TraceRequestRow, toolTitle: (name: string) => string): string => {
  if (r.kind === "web") return `It asks to read ${r.subject}`;
  if (r.kind === "budget") return `It asks for more budget (at ${r.subject})`;
  return `It asks to use ${toolTitle(r.subject)}`;
};

/** The marks of a session, oldest first: its wakes queued, sandboxes, requests and budget changes. */
export function traceMarks(x: { wakes: readonly TraceWakeRow[]; sandboxes: readonly TraceSandboxRow[]; requests: readonly TraceRequestRow[]; grants: readonly TraceGrantRow[]; wakeIndex: Map<string, number>; toolTitle?: (name: string) => string }): TraceStep[] {
  const toolTitle = x.toolTitle ?? ((n: string) => (n.startsWith("mcp__app__") ? n.slice("mcp__app__".length) : n));
  const out: TraceStep[] = [];
  for (const [i, w] of x.wakes.entries()) {
    const reason = typeof w.scope?.reason === "string" ? w.scope.reason : "";
    out.push({ id: `q:${w.id}`, at: iso(w.created_at), kind: "wake", status: w.status === "queued" ? "waiting" : "ok", title: `${i === 0 ? "Queued to start" : "Queued to continue"}${WAKE_REASON[reason] ? ` (${WAKE_REASON[reason]})` : ""}`, run_id: w.id, wake: i + 1 });
    if (w.error) out.push({ id: `x:${w.id}`, at: iso(w.ended_at ?? w.created_at), kind: "wake", status: "error", title: "It failed", error: maskSecrets(w.error).slice(0, 2000), run_id: w.id, wake: i + 1 });
  }
  for (const s of x.sandboxes) {
    const wake = x.wakeIndex.get(s.run_id) ?? null, base = { run_id: s.run_id, wake, kind: "sandbox" as const };
    out.push({ ...base, id: `sb:${s.run_id}:${s.attempt}:0`, at: iso(s.created_at), status: "ok", title: s.sandbox_id ? "Its workspace was created" : "Asked for a workspace to run in" });
    if (s.ready_at) out.push({ ...base, id: `sb:${s.run_id}:${s.attempt}:1`, at: iso(s.ready_at), status: "ok", title: "Setting up its workspace" });
    if (s.claimed_at) out.push({ ...base, id: `sb:${s.run_id}:${s.attempt}:2`, at: iso(s.claimed_at), status: "ok", title: "Its workspace is ready" });
    if (s.deleted_at) {
      const failed = !!s.launch_error;
      out.push({ ...base, id: `sb:${s.run_id}:${s.attempt}:3`, at: iso(s.deleted_at), status: failed ? "error" : "ok", title: failed ? `Its workspace did not start (${s.launch_step ?? "launch"})` : "Its workspace closed",
        error: failed ? maskSecrets(s.launch_error!).slice(0, 2000) : null, detail: failed ? null : s.reap_reason ? maskSecrets(s.reap_reason).slice(0, 400) : null });
    }
  }
  for (const r of x.requests) {
    out.push({ id: `rq:${r.id}:0`, at: iso(r.created_at), kind: "approval", status: r.status === "pending" ? "waiting" : "ok", title: requestAsk(r, toolTitle), fields: clean(r.detail ?? {}) as Record<string, unknown> });
    if (r.decided_at && r.status !== "pending") out.push({ id: `rq:${r.id}:1`, at: iso(r.decided_at), kind: "approval", status: r.status === "declined" || r.status === "expired" ? "error" : "ok",
      title: `${r.status === "approved" ? "Approved" : r.status === "declined" ? "Declined" : "It expired unanswered"}${r.decided_by ? ` by ${r.decided_by}` : ""}`, detail: r.reason ? maskSecrets(r.reason).slice(0, 400) : null });
  }
  for (const g of x.grants) out.push({ id: `gr:${g.id}`, at: iso(g.at), kind: "budget", status: "ok", title: `Budget ${g.to_usd > g.from_usd ? "raised" : "lowered"} from ${usd(g.from_usd)} to ${usd(g.to_usd)} by ${g.by}`, detail: maskSecrets(g.reason).slice(0, 400) });
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * What a session that has not started working waits on, in words, or null when it is not waiting to start. From the wake
 * being started: the run's own state, its sandbox, and the reason the autoscaler last gave.
 */
export function waitingOn(x: { phase: string; run: Pick<TraceWakeRow, "status" | "created_at"> | null; sandbox: TraceSandboxRow | null; waiting: string | null; started: boolean; now?: number }): string | null {
  if (x.phase !== "starting" && x.phase !== "waking") return null;
  const r = x.run, sb = x.sandbox;
  if (!r) return "Nothing is queued to run yet.";
  if (r.status === "running" || x.started) return "It is preparing its workspace and the agent's program.";
  if (r.status !== "queued") return "It has stopped running and is settling.";
  if (sb) {
    if (sb.launch_error) return `The sandbox could not start (${sb.launch_step ?? "launch"}: ${maskSecrets(sb.launch_error).slice(0, 240)}). The platform tries again; nothing runs until one starts.`;
    if (sb.claimed_at) return "It is preparing its workspace and the agent's program.";
    if (sb.ready_at) return "The sandbox is up and running its set-up; it picks this up as soon as that finishes.";
    if (sb.sandbox_id) return "A sandbox was created for it and is starting up.";
    return "Asking for a sandbox to run it in.";
  }
  const secs = Math.max(0, Math.round(((x.now ?? Date.now()) - new Date(r.created_at).getTime()) / 1000));
  if (x.waiting) return `It is waiting for a place to run: ${maskSecrets(x.waiting).slice(0, 300)}.`;
  return `It is waiting in the queue for a free runner (${secs < 60 ? `${secs} seconds` : `${Math.round(secs / 60)} minutes`} so far).`;
}

/**
 * A program's machine, stepped (mold_v0-291; molds/mold_v0/docs/agent-harness.md "Nested runs and Programs"): states,
 * guarded transitions, foreach, joins and cycles bounded by max_transitions. Pure: src/nested-runs.ts keeps the state in
 * Postgres and spawns what this says, so a restart loses nothing, and the tests step it directly.
 *
 * A state's run is an entry. A foreach entry has one step per item and settles by its join. When an entry settles, the
 * first transition from it whose guard passes fires (a guard reads the entry's outputs; a failed entry passes only
 * unguarded transitions when the failure policy is continue). Every fired transition counts against max_transitions.
 */
import { atPath, type FailurePolicy, type Machine, type MachineState, type MachineWhen } from "./program-spec.js";

export interface StepResult { status: "done" | "error" | "cancelled"; outputs?: unknown; answer?: string | null; error?: string | null }
export interface Entry { state: string; entry: number; total: number; need: number; results: (StepResult & { index: number })[]; settled: boolean; items?: unknown[]; bindings?: Record<string, unknown> }
export interface MachineRun {
  seq: number; transitions: number; children: number;
  entries: Record<string, number>;
  /** Each settled state's last outputs, what later states' inputs read. */
  outputs: Record<string, unknown>;
  /** The order states settled in: a join compares against it. */
  settled_seq: Record<string, number>;
  /** When each state last started its entry: a join needs its parents to have settled after it. */
  entered_seq: Record<string, number>;
  counter: number;
  running: Entry[];
  held: string[];
  status: "running" | "done" | "error";
  outputs_final?: unknown;
  error?: string;
  trail: { state: string; entry: number; event: "entered" | "settled" | "failed" | "fired"; to?: string; status?: string; at_transition: number }[];
}
export interface StepSpec { state: string; entry: number; index: number; bindings: Record<string, unknown>; item?: unknown }

export function newMachineRun(): MachineRun {
  return { seq: 0, transitions: 0, children: 0, entries: {}, outputs: {}, settled_seq: {}, entered_seq: {}, counter: 0, running: [], held: [], status: "running", trail: [] };
}
const byId = (m: Machine, id: string): MachineState => m.states.find((s) => s.id === id)!;

/** What a source reads: the run's inputs, an earlier state's output, or this entry's foreach item. */
export function resolveSource(src: string, ctx: { inputs: unknown; outputs: Record<string, unknown>; item?: { as: string; value: unknown } }): unknown {
  if (ctx.item && src === ctx.item.as) return ctx.item.value;
  if (ctx.item && src.startsWith(`${ctx.item.as}.`)) return atPath(ctx.item.value, src.slice(ctx.item.as.length + 1));
  if (src.startsWith("$inputs.")) return atPath(ctx.inputs, src.slice("$inputs.".length));
  const dot = src.indexOf(".");
  if (dot < 0) return undefined;
  return atPath(ctx.outputs[src.slice(0, dot)], src.slice(dot + 1));
}

/** Guard semantics are JSON-strict: a missing value fails every operator but `exists` (false). */
export function guardPasses(w: MachineWhen, outputs: unknown): boolean {
  const path = w.path ? `${w.output}.${w.path}` : w.output;
  const v = atPath(outputs, path);
  if (w.op === "exists") return v !== undefined;
  if (v === undefined) return false;
  if (w.op === "eq") return JSON.stringify(v) === JSON.stringify(w.value);
  if (w.op === "ne") return JSON.stringify(v) !== JSON.stringify(w.value);
  if (["gt", "gte", "lt", "lte"].includes(w.op)) {
    if (typeof v !== "number" || typeof w.value !== "number") return false;
    return w.op === "gt" ? v > w.value : w.op === "gte" ? v >= w.value : w.op === "lt" ? v < w.value : v <= w.value;
  }
  if (w.op === "contains") {
    const needles = Array.isArray(w.value) ? w.value : [w.value];
    if (!needles.length) return false;
    if (Array.isArray(v)) return needles.every((n) => v.some((x) => JSON.stringify(x) === JSON.stringify(n)));
    return typeof v === "string" && needles.every((n) => typeof n === "string" && v.includes(n));
  }
  return false;
}

function fail(run: MachineRun, error: string): MachineRun { run.status = "error"; run.error = error; return run; }

/** Enter a state: its steps to start, or held while its join waits; an over-limit entry ends the machine with an error. */
function enter(m: Machine, run: MachineRun, id: string, inputs: unknown, start: StepSpec[], policy: FailurePolicy): void {
  const s = byId(m, id);
  if (s.join) {
    const mine = run.entered_seq[id] ?? -1;
    if (!s.join.all.every((j) => (run.settled_seq[j] ?? -1) > mine)) { if (!run.held.includes(id)) run.held.push(id); return; }
    run.held = run.held.filter((x) => x !== id);
  }
  const n = (run.entries[id] ?? 0) + 1;
  if (s.max_entries !== undefined && n > s.max_entries) { fail(run, `the state ${id} was entered more than its ${s.max_entries} times`); return; }
  run.entries[id] = n;
  run.counter++; run.entered_seq[id] = run.counter;
  run.trail.push({ state: id, entry: n, event: "entered", at_transition: run.transitions });
  let items: unknown[] | undefined;
  if (s.foreach) {
    const v = resolveSource(s.foreach.from, { inputs, outputs: run.outputs });
    if (!Array.isArray(v)) { fail(run, `the state ${id} iterates ${s.foreach.from}, which is not a list`); return; }
    if (v.length > s.foreach.max) { fail(run, `the state ${id} has ${v.length} items, more than its limit of ${s.foreach.max}`); return; }
    items = v;
    if (!v.length) { settleEntry(m, run, { state: id, entry: n, total: 0, need: 0, results: [], settled: false, items: v }, inputs, start, policy); return; }
  }
  const total = items?.length ?? 1;
  const need = s.foreach ? (s.foreach.join === "all" ? total : s.foreach.join === "any" ? 1 : Math.min(s.foreach.join, total)) : 1;
  const bindings = Object.fromEntries(Object.entries(s.inputs ?? {}).map(([k, src]) => [k, resolveSource(src, { inputs, outputs: run.outputs })]));
  run.running.push({ state: id, entry: n, total, need, results: [], settled: false, ...(items ? { items } : {}), bindings });
  for (let i = 0; i < total; i++) {
    const item = items?.[i];
    start.push({ state: id, entry: n, index: i, bindings: { ...bindings, ...(items ? { [s.foreach!.as]: item } : {}) }, ...(items ? { item } : {}) });
  }
}

function settleEntry(m: Machine, run: MachineRun, e: Entry, inputs: unknown, start: StepSpec[], policy: FailurePolicy): void {
  e.settled = true;
  const s = byId(m, e.state);
  const ok = e.results.filter((r) => r.status === "done");
  const failed = e.results.filter((r) => r.status === "error" || r.status === "cancelled");
  // Too many failed for its join to be met: the entry failed.
  const entryFailed = e.total > 0 && ok.length < e.need;
  const outputs = s.foreach ? { results: e.results.filter((r) => r.status === "done").map((r) => r.outputs ?? null) } : ok[0]?.outputs;
  run.running = run.running.filter((x) => x !== e);
  run.counter++; run.settled_seq[e.state] = run.counter;
  run.trail.push({ state: e.state, entry: e.entry, event: entryFailed ? "failed" : "settled", status: entryFailed ? (failed.find((f) => f.status === "error")?.error ?? "failed").slice(0, 300) : "done", at_transition: run.transitions });
  if (entryFailed && policy !== "continue") { fail(run, `the state ${e.state} failed: ${(failed.find((f) => f.error)?.error ?? "no result").slice(0, 300)}`); return; }
  if (!entryFailed) run.outputs[e.state] = outputs ?? {};
  // The first transition (in the order declared) whose guard passes; a failed entry fires only an unguarded one.
  const from = m.transitions.filter((t) => t.from === e.state);
  const t = from.find((x) => (x.when ? !entryFailed && guardPasses(x.when, outputs ?? {}) : true));
  if (t) {
    run.transitions++;
    if (run.transitions > m.max_transitions) { fail(run, `this machine went past its ${m.max_transitions} transitions`); return; }
    run.trail.push({ state: e.state, entry: e.entry, event: "fired", to: t.to, at_transition: run.transitions });
    enter(m, run, t.to, inputs, start, policy);
    if (run.status === "error") return;
  }
  // Waiting joins re-checked: this settling may be what one waits for.
  for (const id of [...run.held]) { enter(m, run, id, inputs, start, policy); if (run.status === "error") return; }
}

/** The steps to start when a machine begins. */
export function machineBegin(m: Machine, inputs: unknown, policy: FailurePolicy): { run: MachineRun; start: StepSpec[] } {
  const run = newMachineRun();
  const start: StepSpec[] = [];
  for (const s of m.states.filter((x) => x.entry)) { enter(m, run, s.id, inputs, start, policy); if (run.status === "error") break; }
  finish(m, run);
  return { run, start: run.status === "error" ? [] : start };
}

function finish(m: Machine, run: MachineRun): void {
  if (run.status !== "running" || run.running.length || run.held.length) return;
  run.status = "done";
  const lastId = m.result ?? Object.entries(run.settled_seq).sort((a, b) => b[1] - a[1])[0]?.[0];
  run.outputs_final = lastId ? run.outputs[lastId] ?? {} : {};
}

/**
 * One step settled: the new state of the run, the steps it starts, and the steps it no longer needs (a foreach `any`
 * settles with others still running; they are cancelled and their results ignored).
 */
export function machineStep(m: Machine, run: MachineRun, inputs: unknown, step: { state: string; entry: number; index: number } & StepResult, policy: FailurePolicy): { run: MachineRun; start: StepSpec[]; cancel: { state: string; entry: number; index: number }[] } {
  const next = JSON.parse(JSON.stringify(run)) as MachineRun;
  const start: StepSpec[] = [];
  next.seq++;
  const e = next.running.find((x) => x.state === step.state && x.entry === step.entry);
  if (!e || e.results.some((r) => r.index === step.index) || next.status !== "running") return { run: next, start: [], cancel: [] };
  e.results.push({ index: step.index, status: step.status, outputs: step.outputs, answer: step.answer ?? null, error: step.error ?? null });
  const ok = e.results.filter((r) => r.status === "done").length, bad = e.results.length - ok;
  const canStillMeet = ok + (e.total - e.results.length) >= e.need;
  const cancel: { state: string; entry: number; index: number }[] = [];
  if (ok >= e.need || !canStillMeet || e.results.length === e.total) {
    const done = new Set(e.results.map((r) => r.index));
    for (let i = 0; i < e.total; i++) if (!done.has(i)) cancel.push({ state: e.state, entry: e.entry, index: i });
    settleEntry(m, next, e, inputs, start, policy);
    void bad;
  }
  finish(m, next);
  return { run: next, start: (next.status as string) === "error" ? [] : start, cancel };
}

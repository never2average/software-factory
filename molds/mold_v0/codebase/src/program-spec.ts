/**
 * Programs (mold_v0-291, flag nested_runs; molds/mold_v0/docs/agent-harness.md "Nested runs and Programs"): what one is,
 * checked and normalised. Pure: the staff routes, pack.json's manifest, the machine and the tests read it.
 *
 *   a program   a typed definition of a child session: its icon, the agent profile it runs with, its prompt, the JSON Schemas
 *               of its inputs and outputs, a default budget, limits, a failure policy (fail_fast, continue or escalate),
 *               retries, which agent profiles' sessions may spawn it, an optional machine (src/program-machine.ts), an
 *               optional acceptance rule (src/program-acceptance.ts) and how its results show in a session's dock.
 *   schemas     a subset of JSON Schema, implemented here so that what is declared is what is enforced: a keyword this file
 *               does not know is refused when the program is saved, never ignored when a child's output is checked.
 */
import { AGENT_PURPOSES, isPurpose, type AgentPurpose } from "./agent-purpose.js";

export const PROGRAM_ID = /^[a-z][a-z0-9-]{1,39}$/;
export const PROGRAM_LIMITS = { name: 80, description: 500, prompt: 20_000, note: 4000, schema_bytes: 64 * 1024, states: 64, transitions: 256, max_transitions: 256, foreach: 32 } as const;
export const FAILURE_POLICIES = ["fail_fast", "continue", "escalate"] as const;
export type FailurePolicy = (typeof FAILURE_POLICIES)[number];
export const TARGET_KINDS = ["recipe", "harness_policy", "mold_ref"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------- JSON Schema

export type JsonSchema = Record<string, unknown>;
const TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];
const KEYWORDS = new Set(["$comment", "$defs", "$ref", "title", "description", "default", "examples", "type", "enum", "const", "properties", "required", "additionalProperties",
  "items", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "anyOf", "oneOf", "allOf", "not"]);
const FORMATS: Record<string, RegExp> = {
  "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  uri: /^[a-z][a-z0-9+.-]*:\S+$/i,
};
const MAX_DEPTH = 24;

/** What a schema says wrongly. A keyword that is not implemented is a problem: it would not be enforced. */
export function schemaProblems(schema: unknown, at = "schema", depth = 0): string[] {
  if (depth > MAX_DEPTH) return [`${at}: nested too deeply`];
  if (!isObject(schema)) return [`${at}: a JSON Schema object`];
  const out: string[] = [];
  for (const k of Object.keys(schema)) if (!KEYWORDS.has(k)) out.push(`${at}.${k}: this keyword is not supported, so it could not be enforced`);
  const t = schema.type;
  if (t !== undefined && !(typeof t === "string" ? TYPES.includes(t) : Array.isArray(t) && t.length > 0 && t.every((x) => typeof x === "string" && TYPES.includes(x)))) out.push(`${at}.type: one of ${TYPES.join(", ")}, or a list of them`);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) out.push(`${at}.enum: a list with at least one value`);
  if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every((x) => typeof x === "string"))) out.push(`${at}.required: a list of property names`);
  for (const k of ["minItems", "maxItems", "minLength", "maxLength"]) if (schema[k] !== undefined && !(Number.isInteger(schema[k]) && (schema[k] as number) >= 0)) out.push(`${at}.${k}: a whole number`);
  for (const k of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) if (schema[k] !== undefined && typeof schema[k] !== "number") out.push(`${at}.${k}: a number`);
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string" || schema.pattern.length > 500) out.push(`${at}.pattern: a regular expression of at most 500 characters`);
    else try { new RegExp(schema.pattern, "u"); } catch { out.push(`${at}.pattern: not a valid regular expression`); }
  }
  if (schema.format !== undefined && !(typeof schema.format === "string" && schema.format in FORMATS)) out.push(`${at}.format: one of ${Object.keys(FORMATS).join(", ")}`);
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) out.push(`${at}.properties: an object`);
    else for (const [k, v] of Object.entries(schema.properties)) out.push(...schemaProblems(v, `${at}.properties.${k}`, depth + 1));
  }
  if (schema.$defs !== undefined) {
    if (!isObject(schema.$defs)) out.push(`${at}.$defs: an object`);
    else for (const [k, v] of Object.entries(schema.$defs)) out.push(...schemaProblems(v, `${at}.$defs.${k}`, depth + 1));
  }
  if (schema.$ref !== undefined && !(typeof schema.$ref === "string" && /^#\/\$defs\/[^/]+$/.test(schema.$ref))) out.push(`${at}.$ref: only a local #/$defs/<name>`);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") out.push(...schemaProblems(schema.additionalProperties, `${at}.additionalProperties`, depth + 1));
  if (schema.items !== undefined) out.push(...schemaProblems(schema.items, `${at}.items`, depth + 1));
  if (schema.not !== undefined) out.push(...schemaProblems(schema.not, `${at}.not`, depth + 1));
  for (const k of ["anyOf", "oneOf", "allOf"]) if (schema[k] !== undefined) {
    if (!Array.isArray(schema[k]) || !(schema[k] as unknown[]).length) out.push(`${at}.${k}: a list of schemas`);
    else (schema[k] as unknown[]).forEach((s, i) => out.push(...schemaProblems(s, `${at}.${k}[${i}]`, depth + 1)));
  }
  return out;
}

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).sort(), kb = Object.keys(b as object).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};

/** Why `value` does not meet `schema`, in words naming where; empty when it does. Bounded, so a large value cannot run away. */
export function validateJson(value: unknown, schema: JsonSchema, root: JsonSchema = schema, at = "$", depth = 0, budget = { left: 20_000 }): string[] {
  if (depth > MAX_DEPTH || --budget.left < 0) return [`${at}: too deep or too large to check`];
  if (schema.$ref) {
    const name = String(schema.$ref).slice("#/$defs/".length);
    const d = (root.$defs as Record<string, JsonSchema> | undefined)?.[name];
    return d ? validateJson(value, d, root, at, depth + 1, budget) : [`${at}: its schema refers to ${String(schema.$ref)}, which is not defined`];
  }
  const out: string[] = [];
  const t = typeOf(value);
  if (schema.type !== undefined) {
    const ok = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!ok.includes(t) && !(t === "integer" && ok.includes("number"))) return [`${at}: should be ${ok.join(" or ")}, is ${t}`];
  }
  if (schema.enum && !(schema.enum as unknown[]).some((e) => same(e, value))) out.push(`${at}: should be one of ${JSON.stringify(schema.enum).slice(0, 200)}`);
  if ("const" in schema && !same(schema.const, value)) out.push(`${at}: should be ${JSON.stringify(schema.const).slice(0, 200)}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < (schema.minLength as number)) out.push(`${at}: at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > (schema.maxLength as number)) out.push(`${at}: at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern as string, "u").test(value)) out.push(`${at}: does not match the required pattern`);
    if (schema.format !== undefined && !FORMATS[schema.format as string]!.test(value)) out.push(`${at}: should be a ${schema.format}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < (schema.minimum as number)) out.push(`${at}: at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > (schema.maximum as number)) out.push(`${at}: at most ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= (schema.exclusiveMinimum as number)) out.push(`${at}: more than ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= (schema.exclusiveMaximum as number)) out.push(`${at}: less than ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < (schema.minItems as number)) out.push(`${at}: at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > (schema.maxItems as number)) out.push(`${at}: at most ${schema.maxItems} items`);
    if (schema.uniqueItems === true && value.some((v, i) => value.slice(0, i).some((w) => same(v, w)))) out.push(`${at}: items must be different`);
    if (schema.items) value.forEach((v, i) => out.push(...validateJson(v, schema.items as JsonSchema, root, `${at}[${i}]`, depth + 1, budget)));
  }
  if (isObject(value)) {
    for (const k of (schema.required ?? []) as string[]) if (!(k in value)) out.push(`${at}.${k}: is required`);
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) out.push(...validateJson(v, props[k]!, root, `${at}.${k}`, depth + 1, budget));
      else if (schema.additionalProperties === false) out.push(`${at}.${k}: is not allowed`);
      else if (isObject(schema.additionalProperties)) out.push(...validateJson(v, schema.additionalProperties as JsonSchema, root, `${at}.${k}`, depth + 1, budget));
    }
  }
  for (const s of (schema.allOf ?? []) as JsonSchema[]) out.push(...validateJson(value, s, root, at, depth + 1, budget));
  if (schema.anyOf && !(schema.anyOf as JsonSchema[]).some((s) => !validateJson(value, s, root, at, depth + 1, budget).length)) out.push(`${at}: matches none of the allowed forms`);
  if (schema.oneOf && (schema.oneOf as JsonSchema[]).filter((s) => !validateJson(value, s, root, at, depth + 1, budget).length).length !== 1) out.push(`${at}: should match exactly one of the allowed forms`);
  if (schema.not && !validateJson(value, schema.not as JsonSchema, root, at, depth + 1, budget).length) out.push(`${at}: matches a form that is not allowed`);
  return out.slice(0, 40);
}

// ---------------------------------------------------------------- the machine's and the acceptance rule's shapes

export interface MachineWhen { output: string; path?: string; op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "exists" | "contains"; value?: unknown }
export interface MachineForeach { from: string; as: string; max: number; join: "all" | "any" | number }
export interface MachineState {
  id: string; entry?: boolean;
  /** "agent" (the default): a child session. "acceptance": the guardian, server-owned: no agent runs and none can answer for it. */
  kind?: "agent" | "acceptance";
  prompt?: string;
  /** Another program this state runs. */
  program?: string;
  /** Each input's source: `$inputs.<name>[.path]`, `<state>.<output>[.path]`, or the foreach item's name. */
  inputs?: Record<string, string>;
  outputs?: JsonSchema;
  foreach?: MachineForeach;
  /** Wait for each of these states to settle since this state last ran, before entering. */
  join?: { all: string[] };
  budget_usd?: number;
  retries?: number;
  max_entries?: number;
  /** An acceptance state: the state whose child session produced the candidate. */
  candidate_from?: string;
  /** An acceptance state: the input carrying what was hypothesised (a source as in inputs). */
  hypothesis?: string;
}
export interface Machine { states: MachineState[]; transitions: { from: string; to: string; when?: MachineWhen }[]; max_transitions: number; max_children?: number; result?: string }

export interface AcceptanceTest {
  /** The frozen contract: its files (uploads, each with its sha256), and how to run a candidate and score it. */
  files: { id: string; path: string; bytes: number; sha256: string; executable: boolean }[];
  sha256: string; cases_path: string; candidate_command: string[]; scorer_command: string[]; timeout_seconds: number;
}
export interface Acceptance {
  metric: string; direction: "maximize" | "minimize"; min_lift: number;
  /** Every candidate must also meet these, on every case's average: fail closed if a metric is absent. */
  floors: { metric: string; min?: number; max?: number }[];
  surface: string[];
  target: { kind: TargetKind; id?: string; from_input?: string };
  /** Absent: the outcome is needs_review, and a person decides. */
  test?: AcceptanceTest;
}
export const DOCK_KINDS = ["items", "changes", "climb"] as const;
export type DockKind = (typeof DOCK_KINDS)[number];
/** Where a program's results show in a session's dock (mold_v0-292): a section's id and words, and how it is drawn. */
/** mold_v0-295: `group` names the top bar tab its section sits under (a group's id: think, measure, ship or the app's own; by
 *  default its kind's: items think, climb measure, changes ship). */
export interface ProgramDock { section: string; label?: string; sub?: string; icon?: string; order?: number; kind?: DockKind; items?: string; title?: string; meta?: string[]; group?: string; also?: { section: string; label?: string; sub?: string; icon?: string; order?: number; kind?: DockKind; group?: string }[] }

export interface ProgramConfig {
  icon: string;
  /** mold_v0-295: what its agent is for (src/agent-purpose.ts); absent, read from the program (programPurpose). */
  purpose?: AgentPurpose;
  agent_profile: string | null;
  prompt: string;
  inputs: JsonSchema;
  outputs: JsonSchema;
  budget_usd: number;
  limits: { max_turns?: number; wake_max_minutes?: number; max_budget_usd?: number };
  failure_policy: FailurePolicy;
  retries: number;
  /** The agent profile ids whose sessions may spawn it (["*"]: every profile; []: only a person starts it). */
  spawned_by: string[];
  machine?: Machine;
  acceptance?: Acceptance;
  dock?: ProgramDock;
}

const ICON = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;
const SOURCE = /^(\$inputs(\.[A-Za-z0-9_-]+)+|[a-z0-9][a-z0-9-]{0,39}(\.[A-Za-z0-9_-]+)+|[A-Za-z_][A-Za-z0-9_]{0,39})$/;
const STATE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const METRIC = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UPLOAD = /^[A-Za-z0-9_-]{4,64}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+ -]+(?:\/[A-Za-z0-9._@+ -]+){0,15}$/;
const GLOB = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+ *?/-]{1,200}$/;

function machineProblems(raw: unknown, at: string): { machine?: Machine; problems: string[] } {
  if (!isObject(raw)) return { problems: [`${at}: an object of states and transitions`] };
  const out: string[] = [];
  const states = raw.states, transitions = raw.transitions ?? [];
  if (!Array.isArray(states) || !states.length) return { problems: [`${at}.states: at least one state`] };
  if (states.length > PROGRAM_LIMITS.states) out.push(`${at}.states: at most ${PROGRAM_LIMITS.states}`);
  if (!Array.isArray(transitions)) return { problems: [`${at}.transitions: a list`] };
  if (transitions.length > PROGRAM_LIMITS.transitions) out.push(`${at}.transitions: at most ${PROGRAM_LIMITS.transitions}`);
  const max = raw.max_transitions;
  if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > PROGRAM_LIMITS.max_transitions) out.push(`${at}.max_transitions: a whole number from 1 to ${PROGRAM_LIMITS.max_transitions} (every machine is bounded, cycles included)`);
  const ids = new Set<string>();
  for (const [i, s] of states.entries()) {
    const x = (isObject(s) ? s : {}) as Record<string, unknown>;
    const w = `${at}.states[${i}]`;
    const id = String(x.id ?? "");
    if (!STATE_ID.test(id)) { out.push(`${w}.id: lowercase letters, digits and -`); continue; }
    if (ids.has(id)) out.push(`${w}.id: ${id} is used twice`);
    ids.add(id);
    const kind = x.kind ?? "agent";
    if (kind !== "agent" && kind !== "acceptance") out.push(`${w}.kind: agent or acceptance`);
    if (kind === "agent" && !(typeof x.prompt === "string" && x.prompt.trim()) && !(typeof x.program === "string" && PROGRAM_ID.test(x.program))) out.push(`${w}: an agent state needs a prompt or a program`);
    if (typeof x.prompt === "string" && x.prompt.length > PROGRAM_LIMITS.prompt) out.push(`${w}.prompt: at most ${PROGRAM_LIMITS.prompt} characters`);
    if (kind === "acceptance" && typeof x.candidate_from !== "string") out.push(`${w}.candidate_from: the state whose session produced the candidate`);
    if (kind === "acceptance" && (x.prompt !== undefined || x.program !== undefined)) out.push(`${w}: an acceptance state runs no agent (the guardian is the server's own)`);
    if (x.inputs !== undefined && !(isObject(x.inputs) && Object.values(x.inputs).every((v) => typeof v === "string" && SOURCE.test(v)))) out.push(`${w}.inputs: each a source ($inputs.x, state.output or the foreach item)`);
    if (x.outputs !== undefined) out.push(...schemaProblems(x.outputs, `${w}.outputs`));
    if (x.join !== undefined && !(isObject(x.join) && Array.isArray(x.join.all) && x.join.all.length && x.join.all.every((j) => typeof j === "string"))) out.push(`${w}.join: {all: [states]}`);
    if (x.foreach !== undefined) {
      const f = isObject(x.foreach) ? x.foreach : {};
      if (typeof f.from !== "string" || !SOURCE.test(f.from)) out.push(`${w}.foreach.from: a source`);
      if (typeof f.as !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(f.as)) out.push(`${w}.foreach.as: a name`);
      if (!Number.isInteger(f.max) || (f.max as number) < 1 || (f.max as number) > PROGRAM_LIMITS.foreach) out.push(`${w}.foreach.max: from 1 to ${PROGRAM_LIMITS.foreach}`);
      if (!(f.join === "all" || f.join === "any" || (Number.isInteger(f.join) && (f.join as number) >= 1))) out.push(`${w}.foreach.join: all, any, or how many must settle`);
    }
    if (x.budget_usd !== undefined && !(typeof x.budget_usd === "number" && x.budget_usd >= 0.1)) out.push(`${w}.budget_usd: at least 0.10`);
    if (x.retries !== undefined && !(Number.isInteger(x.retries) && (x.retries as number) >= 0 && (x.retries as number) <= 3)) out.push(`${w}.retries: from 0 to 3`);
    if (x.max_entries !== undefined && !(Number.isInteger(x.max_entries) && (x.max_entries as number) >= 1)) out.push(`${w}.max_entries: a whole number`);
  }
  if (!states.some((s) => isObject(s) && s.entry === true)) out.push(`${at}.states: one state needs "entry": true`);
  for (const [i, t] of transitions.entries()) {
    const x = (isObject(t) ? t : {}) as Record<string, unknown>;
    const w = `${at}.transitions[${i}]`;
    if (!ids.has(String(x.from))) out.push(`${w}.from: ${String(x.from)} is not a state`);
    if (!ids.has(String(x.to))) out.push(`${w}.to: ${String(x.to)} is not a state`);
    if (x.when !== undefined) {
      const c = isObject(x.when) ? x.when : {};
      if (typeof c.output !== "string") out.push(`${w}.when.output: the output it reads`);
      if (!["eq", "ne", "gt", "gte", "lt", "lte", "exists", "contains"].includes(String(c.op))) out.push(`${w}.when.op: eq, ne, gt, gte, lt, lte, exists or contains`);
    }
  }
  // Every state is reachable from an entry: a typo otherwise leaves part of a machine that can never run.
  const reach = new Set<string>(states.filter((s) => isObject(s) && s.entry === true).map((s) => String((s as Record<string, unknown>).id)));
  for (let grew = true; grew;) { grew = false; for (const t of transitions as { from?: string; to?: string }[]) if (t && reach.has(String(t.from)) && !reach.has(String(t.to))) { reach.add(String(t.to)); grew = true; } }
  for (const id of ids) if (!reach.has(id)) out.push(`${at}.states: ${id} can never be reached from an entry state`);
  for (const [i, s] of states.entries()) {
    const j = isObject(s) && isObject(s.join) ? (s.join.all as unknown[] | undefined) : undefined;
    for (const dep of j ?? []) if (typeof dep === "string" && !ids.has(dep)) out.push(`${at}.states[${i}].join: ${dep} is not a state`);
    const cf = isObject(s) ? s.candidate_from : undefined;
    if (typeof cf === "string" && !ids.has(cf)) out.push(`${at}.states[${i}].candidate_from: ${cf} is not a state`);
  }
  if (raw.result !== undefined && !ids.has(String(raw.result))) out.push(`${at}.result: ${String(raw.result)} is not a state`);
  if (raw.max_children !== undefined && !(Number.isInteger(raw.max_children) && (raw.max_children as number) >= 1)) out.push(`${at}.max_children: a whole number`);
  return out.length ? { problems: out } : { machine: raw as unknown as Machine, problems: [] };
}

/** The sha256 a test contract is frozen under, from what is in it (its files' own sha256s and how it is run), never from a stored field. */
export function contractSha(t: Pick<AcceptanceTest, "files" | "cases_path" | "candidate_command" | "scorer_command" | "timeout_seconds">, hash: (s: string) => string): string {
  return hash(JSON.stringify({ files: [...t.files].map((f) => [f.path, f.sha256, f.executable]).sort(), cases_path: t.cases_path, candidate: t.candidate_command, scorer: t.scorer_command, timeout: t.timeout_seconds }));
}

function acceptanceProblems(raw: unknown, at: string, hash: (s: string) => string): { acceptance?: Acceptance; problems: string[] } {
  if (!isObject(raw)) return { problems: [`${at}: an object`] };
  const out: string[] = [];
  if (typeof raw.metric !== "string" || !METRIC.test(raw.metric)) out.push(`${at}.metric: the metric it is judged on`);
  if (raw.direction !== "maximize" && raw.direction !== "minimize") out.push(`${at}.direction: maximize or minimize`);
  const minLift = raw.min_lift === undefined ? 0.05 : raw.min_lift;
  if (typeof minLift !== "number" || !(minLift > 0) || minLift > 10) out.push(`${at}.min_lift: a fraction above 0 (0.05 is five percent)`);
  const floors = raw.floors === undefined ? [] : raw.floors;
  if (!Array.isArray(floors) || !floors.every((f) => isObject(f) && typeof f.metric === "string" && METRIC.test(f.metric) && (typeof f.min === "number" || typeof f.max === "number"))) out.push(`${at}.floors: a list of {metric, min and/or max}`);
  if (!Array.isArray(raw.surface) || !raw.surface.length || !raw.surface.every((g) => typeof g === "string" && GLOB.test(g))) out.push(`${at}.surface: the paths a candidate may change (at least one, relative globs)`);
  const target = isObject(raw.target) ? raw.target : null;
  if (!target || !TARGET_KINDS.includes(target.kind as TargetKind)) out.push(`${at}.target.kind: ${TARGET_KINDS.join(", ")}`);
  else if ((typeof target.id !== "string" || !target.id) === (typeof target.from_input !== "string" || !target.from_input)) out.push(`${at}.target: exactly one of id or from_input`);
  let test: AcceptanceTest | undefined;
  if (raw.test !== undefined) {
    const t = isObject(raw.test) ? raw.test : {};
    const w = `${at}.test`;
    const files = t.files;
    if (!Array.isArray(files) || !files.length || !files.every((f) => isObject(f) && typeof f.id === "string" && UPLOAD.test(f.id) && typeof f.path === "string" && SAFE_PATH.test(f.path) && typeof f.sha256 === "string" && SHA256.test(f.sha256) && typeof f.bytes === "number")) out.push(`${w}.files: its uploaded files, each {id, path, bytes, sha256, executable}`);
    if (typeof t.cases_path !== "string" || !SAFE_PATH.test(t.cases_path)) out.push(`${w}.cases_path: the file listing the held-out cases`);
    else if (Array.isArray(files) && !files.some((f) => isObject(f) && f.path === t.cases_path)) out.push(`${w}.cases_path: it is not one of the files`);
    for (const k of ["candidate_command", "scorer_command"]) if (!Array.isArray(t[k]) || !(t[k] as unknown[]).length || !(t[k] as unknown[]).every((x) => typeof x === "string")) out.push(`${w}.${k}: a program and its arguments`);
    const timeout = t.timeout_seconds === undefined ? 300 : t.timeout_seconds;
    if (typeof timeout !== "number" || timeout < 1 || timeout > 3600) out.push(`${w}.timeout_seconds: from 1 to 3600`);
    if (!out.some((p) => p.startsWith(w))) {
      const clean = { files: (files as AcceptanceTest["files"]).map((f) => ({ id: f.id, path: f.path, bytes: f.bytes, sha256: f.sha256, executable: f.executable === true })),
        cases_path: t.cases_path as string, candidate_command: t.candidate_command as string[], scorer_command: t.scorer_command as string[], timeout_seconds: timeout as number };
      test = { ...clean, sha256: contractSha(clean, hash) };
      if (t.sha256 !== undefined && t.sha256 !== test.sha256) out.push(`${w}.sha256: does not match its files and commands (the contract is frozen by what is in it)`);
    }
  }
  if (out.length) return { problems: out };
  return { problems: [], acceptance: { metric: raw.metric as string, direction: raw.direction as Acceptance["direction"], min_lift: minLift as number, floors: floors as Acceptance["floors"], surface: raw.surface as string[], target: target as unknown as Acceptance["target"], ...(test ? { test } : {}) } };
}

/** A program's configuration as saved: checked and given its defaults. `hash` is sha256 of a string in hex. */
export function parseProgram(raw: unknown, hash: (s: string) => string): { config?: ProgramConfig; problems: string[] } {
  if (!isObject(raw)) return { problems: ["config: an object"] };
  const out: string[] = [];
  const known = new Set(["$comment", "icon", "purpose", "agent_profile", "prompt", "inputs", "outputs", "budget_usd", "limits", "failure_policy", "retries", "spawned_by", "machine", "acceptance", "dock"]);
  for (const k of Object.keys(raw)) if (!known.has(k)) out.push(`${k}: not a field of a program`);
  const icon = raw.icon === undefined ? "sparkles" : raw.icon;
  if (typeof icon !== "string" || !ICON.test(icon)) out.push("icon: an icon's name");
  if (raw.purpose !== undefined && !isPurpose(raw.purpose)) out.push(`purpose: ${AGENT_PURPOSES.join(", ")}`);
  if (raw.agent_profile !== undefined && raw.agent_profile !== null && typeof raw.agent_profile !== "string") out.push("agent_profile: an agent profile's id");
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt && raw.machine === undefined) out.push("prompt: what the child is asked to do");
  if (prompt.length > PROGRAM_LIMITS.prompt) out.push(`prompt: at most ${PROGRAM_LIMITS.prompt} characters`);
  const inputs = raw.inputs === undefined ? { type: "object" } : raw.inputs, outputs = raw.outputs === undefined ? { type: "object" } : raw.outputs;
  out.push(...schemaProblems(inputs, "inputs"), ...schemaProblems(outputs, "outputs"));
  for (const [k, v] of [["inputs", inputs], ["outputs", outputs]] as const) if (JSON.stringify(v).length > PROGRAM_LIMITS.schema_bytes) out.push(`${k}: at most ${PROGRAM_LIMITS.schema_bytes / 1024} KB`);
  const budget = raw.budget_usd === undefined ? 1 : raw.budget_usd;
  if (typeof budget !== "number" || !(budget >= 0.1)) out.push("budget_usd: at least 0.10");
  const limits = raw.limits === undefined ? {} : raw.limits;
  if (!isObject(limits)) out.push("limits: an object");
  else {
    for (const k of Object.keys(limits)) if (!["max_turns", "wake_max_minutes", "max_budget_usd"].includes(k)) out.push(`limits.${k}: not a limit of a program`);
    for (const [k, v] of Object.entries(limits)) if (typeof v !== "number" || !(v > 0)) out.push(`limits.${k}: a positive number`);
  }
  const fp = raw.failure_policy === undefined ? "continue" : raw.failure_policy;
  if (!FAILURE_POLICIES.includes(fp as FailurePolicy)) out.push(`failure_policy: ${FAILURE_POLICIES.join(", ")}`);
  const retries = raw.retries === undefined ? 1 : raw.retries;
  if (!Number.isInteger(retries) || (retries as number) < 0 || (retries as number) > 3) out.push("retries: from 0 to 3");
  const spawnedBy = raw.spawned_by === undefined ? [] : raw.spawned_by;
  if (!Array.isArray(spawnedBy) || !spawnedBy.every((x) => typeof x === "string" && x.length <= 80)) out.push('spawned_by: agent profile ids, ["*"] for every profile');
  let machine: Machine | undefined, acceptance: Acceptance | undefined;
  if (raw.machine !== undefined) { const m = machineProblems(raw.machine, "machine"); out.push(...m.problems); machine = m.machine; }
  if (raw.acceptance !== undefined) { const a = acceptanceProblems(raw.acceptance, "acceptance", hash); out.push(...a.problems); acceptance = a.acceptance; }
  if (machine?.states.some((s) => s.kind === "acceptance") && !acceptance) out.push("machine: an acceptance state needs the program's acceptance rule");
  if (acceptance && !machine?.states.some((s) => s.kind === "acceptance")) out.push("acceptance: it is carried out by an acceptance state of the program's machine (a one-state machine will do)");
  let dock: ProgramDock | undefined;
  if (raw.dock !== undefined) {
    const d = isObject(raw.dock) ? raw.dock : {};
    const SECTION = /^[a-z][a-z0-9_-]{0,39}$/;
    const sectionProblems = (x: Record<string, unknown>, at: string, keys: string[]) => {
      for (const k of Object.keys(x)) if (!keys.includes(k)) out.push(`${at}.${k}: not a field of the dock`);
      if (typeof x.section !== "string" || !SECTION.test(x.section)) out.push(`${at}.section: the id of the section its results show under`);
      for (const k of ["label", "sub"]) if (x[k] !== undefined && (typeof x[k] !== "string" || (x[k] as string).length > 80)) out.push(`${at}.${k}: words of at most 80 characters`);
      if (x.icon !== undefined && (typeof x.icon !== "string" || !ICON.test(x.icon))) out.push(`${at}.icon: an icon's name`);
      if (x.order !== undefined && !(typeof x.order === "number" && Number.isFinite(x.order))) out.push(`${at}.order: a number`);
      if (x.kind !== undefined && !DOCK_KINDS.includes(x.kind as DockKind)) out.push(`${at}.kind: ${DOCK_KINDS.join(", ")}`);
      if (x.group !== undefined && (typeof x.group !== "string" || !SECTION.test(x.group))) out.push(`${at}.group: the id of the top bar group its section sits under (think, measure, ship or the app's own)`);
    };
    sectionProblems(d, "dock", ["section", "label", "sub", "icon", "order", "kind", "items", "title", "meta", "group", "also"]);
    for (const k of ["items", "title"]) if (d[k] !== undefined && (typeof d[k] !== "string" || (d[k] as string).length > 80)) out.push(`dock.${k}: an output's path`);
    if (d.meta !== undefined && !(Array.isArray(d.meta) && d.meta.length <= 6 && d.meta.every((x) => typeof x === "string"))) out.push("dock.meta: at most 6 output paths");
    if (d.also !== undefined) {
      if (!Array.isArray(d.also) || d.also.length > 4) out.push("dock.also: at most 4 more sections");
      else d.also.forEach((x, i) => { if (!isObject(x)) out.push(`dock.also[${i}]: an object`); else sectionProblems(x, `dock.also[${i}]`, ["section", "label", "sub", "icon", "order", "kind", "group"]); });
    }
    if (!out.some((p) => p.startsWith("dock."))) dock = d as unknown as ProgramDock;
  }
  if (out.length) return { problems: out };
  return { problems: [], config: { icon: icon as string, ...(raw.purpose !== undefined ? { purpose: raw.purpose as AgentPurpose } : {}), agent_profile: (raw.agent_profile as string | null | undefined) ?? null, prompt, inputs: inputs as JsonSchema, outputs: outputs as JsonSchema,
    budget_usd: budget as number, limits: limits as ProgramConfig["limits"], failure_policy: fp as FailurePolicy, retries: retries as number, spawned_by: spawnedBy as string[],
    ...(machine ? { machine } : {}), ...(acceptance ? { acceptance } : {}), ...(dock ? { dock } : {}) } };
}

/** A schema that asks for something: an empty `{"type": "object"}` asks for nothing, so a child need not hand anything in. */
export const typedOutputs = (s: JsonSchema | null | undefined): JsonSchema | null => (s && (Object.keys((s.properties ?? {}) as object).length || ((s.required ?? []) as unknown[]).length || s.anyOf || s.oneOf || s.allOf || s.$ref) ? s : null);

/** Whether a session of agent profile `profile` may spawn this program. */
export const mayBeSpawnedBy = (c: Pick<ProgramConfig, "spawned_by">, profile: string | null) => c.spawned_by.includes("*") || (!!profile && c.spawned_by.includes(profile));

/** A value at a dotted path of a JSON value, or undefined. */
export function atPath(v: unknown, path: string): unknown {
  let cur = v;
  for (const p of path.split(".")) { if (!isObject(cur) || !(p in cur)) return undefined; cur = cur[p]; }
  return cur;
}
/** A prompt with its {name} placeholders filled from `values` (objects as JSON); an unknown placeholder is left as written. */
export function renderPrompt(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k: string) => (k in values ? (values[k] === undefined || values[k] === null ? "" : typeof values[k] === "string" ? (values[k] as string) : JSON.stringify(values[k])) : m));
}
/** Whether a path matches a surface glob: * within one segment, ** across segments, ? one character. */
export function globMatch(glob: string, path: string): boolean {
  const re = "^" + glob.split("**").map((part) => part.split("*").map((x) => x.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("?", "[^/]")).join("[^/]*")).join(".*") + "$";
  return new RegExp(re).test(path);
}

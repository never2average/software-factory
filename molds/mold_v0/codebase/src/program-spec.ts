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
import { ACCOUNT_ROLES, type AccountRole } from "./account-roles.js";

export const PROGRAM_ID = /^[a-z][a-z0-9-]{1,39}$/;
export const PROGRAM_LIMITS = { name: 80, description: 500, prompt: 20_000, note: 4000, schema_bytes: 64 * 1024, states: 64, transitions: 256, max_transitions: 256, foreach: 32, record_fields: 64 } as const;
export const FAILURE_POLICIES = ["fail_fast", "continue", "escalate"] as const;
export type FailurePolicy = (typeof FAILURE_POLICIES)[number];
/**
 * mold_v0-303: what an improvement changes. recipe: a workspace recipe's files; harness_policy: an agent profile's
 * governance policy (its `policy.json`); mold: a mold's files, only ever proposed to a person (no agent writes to a mold).
 * "mold_ref" is the earlier word for mold, still read; it is what the tables keep (storedTargetKind).
 */
export const TARGET_KINDS = ["recipe", "harness_policy", "mold"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];
export const targetKindOf = (v: unknown): TargetKind | null => (v === "mold_ref" ? "mold" : (TARGET_KINDS as readonly unknown[]).includes(v) ? (v as TargetKind) : null);
/** The word the tables keep for a kind (their check constraints predate "mold"). */
export const storedTargetKind = (k: TargetKind): string => (k === "mold" ? "mold_ref" : k);
/**
 * mold_v0-303: the trusted scorers the evaluator runs itself (src/program-scorers.ts), and the trusted "candidate" that is
 * a file of the candidate's tree rather than a program: measurable artefacts (a policy, a schema) scored with no code of
 * the candidate's running at all.
 */
export const BUILTIN_SCORERS = ["builtin:exact", "builtin:json-schema", "builtin:governance-sim"] as const;
export const BUILTIN_FILE = "builtin:file";
/** mold_v0-303 (M10): the most children a tree may ever start, whatever a profile or a program says; budget is the real limit. */
export const TREE_HARD_MAX = 256;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------- JSON Schema (src/json-schema.ts: pure, part of the run sandbox)

export { schemaProblems, validateJson, type JsonSchema } from "./json-schema.js";
import { schemaProblems, type JsonSchema } from "./json-schema.js";

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
  /**
   * mold_v0-303: the files are a recipe version's, frozen (each by its sha256) when the program is brought in or saved
   * (src/programs.ts freezeTest). Declared with no files; until frozen, its `files` is empty and nothing is measured.
   */
  recipe?: { id: string; version: number | null };
}
/** mold_v0-303: whether a test's files are frozen (a test declared from a recipe is not until it is brought in). */
export const testFrozen = (t: AcceptanceTest | undefined | null): boolean => !!t && t.files.length > 0 && SHA256.test(t.sha256);
export interface Acceptance {
  metric: string; direction: "maximize" | "minimize"; min_lift: number;
  /** Every candidate must also meet these, on every case's average: fail closed if a metric is absent. */
  floors: { metric: string; min?: number; max?: number }[];
  surface: string[];
  /**
   * What is promoted: its kind (or, mold_v0-303, the input naming it: kind_from_input, one of `kinds`) and its id (or the
   * input naming it: from_input).
   */
  target: { kind?: TargetKind; kind_from_input?: string; kinds?: TargetKind[]; id?: string; from_input?: string };
  /** Absent: the outcome is needs_review, and a person decides. */
  test?: AcceptanceTest;
}
export const DOCK_KINDS = ["items", "changes", "climb"] as const;
export type DockKind = (typeof DOCK_KINDS)[number];
/** Where a program's results show in a session's dock (mold_v0-292): a section's id and words, and how it is drawn. */
/** mold_v0-295: `group` names the top bar tab its section sits under (a group's id: think, measure, ship or the app's own; by
 *  default its kind's: items think, climb measure, changes ship). */
export interface ProgramDock { section: string; label?: string; sub?: string; icon?: string; order?: number; kind?: DockKind; items?: string; title?: string; meta?: string[]; group?: string; also?: { section: string; label?: string; sub?: string; icon?: string; order?: number; kind?: DockKind; group?: string }[] }

/**
 * mold_v0-303 (M7): a program's results kept as records of a workspace area, written by the server once its outputs passed
 * their schema (never by the agent): `fields` maps each field of the area to a dotted path in the outputs (or in each item
 * of `items`, a list in the outputs); `key` and `title` are paths too (no key: the run's own handle, numbered per item).
 * Provenance: the run (`run:program:<program>:<handle>`).
 */
export interface ProgramRecord { area: string; key?: string; title?: string; items?: string; fields: Record<string, string>;
  /**
   * mold_v0-334: "key": the result updates the record its run was started on (`key` is $inputs.<name>, and must be the
   * record the run's root session was started on; refused otherwise), the fields it maps written over the stored ones,
   * as the person who started the run (their role and what they may see apply), never a new record.
   */
  update_by?: "key";
  /** mold_v0-334: the lifecycle state each record it writes is moved to (only along a transition; else left as it is). */
  move_to?: string;
  /**
   * mold_v0-334: a new record whose values of these fields (text compared trimmed and case-blind) match a record the
   * area already keeps, under another key, is not written: the existing one stands (a program never files the same
   * thing twice, whatever keys its agent makes up).
   */
  dedupe_on?: string[];
}
/** What parseProgram may check a record against: the build's workspace record areas (src/record-areas.ts). */
export interface RecordAreaShape { name: string; scope?: string; fields: readonly string[];
  /** mold_v0-334: the states a transition of its lifecycle reaches (none: no lifecycle), and its encrypted fields. */
  states?: readonly string[]; encrypted?: readonly string[] }

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
  record?: ProgramRecord;
  /** mold_v0-303: the account roles that may start it (absent: every role that may start agent sessions). */
  roles?: AccountRole[];
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
  if (raw.max_children !== undefined && !(Number.isInteger(raw.max_children) && (raw.max_children as number) >= 1 && (raw.max_children as number) <= TREE_HARD_MAX)) out.push(`${at}.max_children: a whole number from 1 to ${TREE_HARD_MAX}`);
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
  let cleanTarget: Acceptance["target"] | null = null;
  if (!target) out.push(`${at}.target: {kind or kind_from_input, id or from_input}`);
  else {
    for (const k of Object.keys(target)) if (!["kind", "kind_from_input", "kinds", "id", "from_input"].includes(k)) out.push(`${at}.target.${k}: not a field of a target`);
    const named = (v: unknown) => typeof v === "string" && v !== "";
    // mold_v0-303 (M4): the kind is fixed, or read from an input (one of `kinds`, by default any).
    if (named(target.kind) === named(target.kind_from_input)) out.push(`${at}.target: exactly one of kind (${TARGET_KINDS.join(", ")}) or kind_from_input (the input naming it)`);
    else if (named(target.kind) && !targetKindOf(target.kind)) out.push(`${at}.target.kind: ${TARGET_KINDS.join(", ")}`);
    if (target.kind_from_input !== undefined && !(typeof target.kind_from_input === "string" && /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(target.kind_from_input))) out.push(`${at}.target.kind_from_input: an input's (dotted) name`);
    const kinds = target.kinds === undefined ? undefined : Array.isArray(target.kinds) ? target.kinds.map(targetKindOf) : [null];
    if (kinds && (!kinds.length || kinds.some((k) => !k))) out.push(`${at}.target.kinds: a list of ${TARGET_KINDS.join(", ")}`);
    if (kinds && named(target.kind)) out.push(`${at}.target.kinds: only with kind_from_input`);
    if (named(target.id) === named(target.from_input)) out.push(`${at}.target: exactly one of id or from_input`);
    if (!out.some((p) => p.startsWith(`${at}.target`))) cleanTarget = {
      ...(named(target.kind) ? { kind: targetKindOf(target.kind)! } : { kind_from_input: target.kind_from_input as string, ...(kinds ? { kinds: [...new Set(kinds as TargetKind[])] } : {}) }),
      ...(named(target.id) ? { id: target.id as string } : { from_input: target.from_input as string }),
    };
  }
  let test: AcceptanceTest | undefined;
  if (raw.test !== undefined) {
    const t = isObject(raw.test) ? raw.test : {};
    const w = `${at}.test`;
    for (const k of Object.keys(t)) if (!["files", "recipe", "sha256", "cases_path", "candidate_command", "scorer_command", "timeout_seconds"].includes(k)) out.push(`${w}.${k}: not a field of a test`);
    // mold_v0-303 (M6): a recipe's version in place of uploads: frozen, file by file, when the program is brought in.
    const recipe = t.recipe === undefined ? undefined : isObject(t.recipe) ? t.recipe : null;
    if (recipe === null || (recipe && !(typeof recipe.id === "string" && /^[a-z][a-z0-9-]{1,39}$/.test(recipe.id) && (recipe.version === undefined || recipe.version === null || (Number.isInteger(recipe.version) && (recipe.version as number) >= 1)) && Object.keys(recipe).every((k) => k === "id" || k === "version"))))
      out.push(`${w}.recipe: {id, version?} of the recipe holding the test's files (its cases and scorer)`);
    const files = t.files === undefined && recipe ? [] : t.files;
    const filesOk = Array.isArray(files) && files.every((f) => isObject(f) && typeof f.id === "string" && UPLOAD.test(f.id) && typeof f.path === "string" && SAFE_PATH.test(f.path) && typeof f.sha256 === "string" && SHA256.test(f.sha256) && typeof f.bytes === "number");
    if (!filesOk || (!recipe && !(files as unknown[]).length)) out.push(`${w}.files: its uploaded files, each {id, path, bytes, sha256, executable} (or recipe: {id, version} in their place)`);
    const frozen = filesOk && (files as unknown[]).length > 0;
    if (typeof t.cases_path !== "string" || !SAFE_PATH.test(t.cases_path)) out.push(`${w}.cases_path: the file listing the held-out cases`);
    else if (frozen && !(files as unknown[]).some((f) => isObject(f) && f.path === t.cases_path)) out.push(`${w}.cases_path: it is not one of the files`);
    for (const k of ["candidate_command", "scorer_command"]) if (!Array.isArray(t[k]) || !(t[k] as unknown[]).length || !(t[k] as unknown[]).every((x) => typeof x === "string")) out.push(`${w}.${k}: a program and its arguments`);
    // The built-ins: a scorer is one of the evaluator's own, alone; a "candidate" that is a file is that file's path.
    const sc = Array.isArray(t.scorer_command) ? (t.scorer_command as unknown[]) : [];
    if (typeof sc[0] === "string" && sc[0].startsWith("builtin:") && (!(BUILTIN_SCORERS as readonly string[]).includes(sc[0]) || sc.length !== 1)) out.push(`${w}.scorer_command: a built-in scorer is one of ${BUILTIN_SCORERS.join(", ")}, alone`);
    const cc = Array.isArray(t.candidate_command) ? (t.candidate_command as unknown[]) : [];
    if (typeof cc[0] === "string" && cc[0].startsWith("builtin:") && !(cc[0] === BUILTIN_FILE && cc.length === 2 && typeof cc[1] === "string" && SAFE_PATH.test(cc[1]))) out.push(`${w}.candidate_command: the built-in candidate is ["${BUILTIN_FILE}", "<path in the candidate>"]`);
    const timeout = t.timeout_seconds === undefined ? 300 : t.timeout_seconds;
    if (typeof timeout !== "number" || timeout < 1 || timeout > 3600) out.push(`${w}.timeout_seconds: from 1 to 3600`);
    if (!out.some((p) => p.startsWith(w))) {
      const clean = { files: (files as AcceptanceTest["files"]).map((f) => ({ id: f.id, path: f.path, bytes: f.bytes, sha256: f.sha256, executable: f.executable === true })),
        cases_path: t.cases_path as string, candidate_command: t.candidate_command as string[], scorer_command: t.scorer_command as string[], timeout_seconds: timeout as number };
      const ref = recipe ? { recipe: { id: recipe.id as string, version: (recipe.version as number | undefined) ?? null } } : {};
      test = { ...clean, sha256: frozen ? contractSha(clean, hash) : "", ...ref };
      if (frozen && t.sha256 !== undefined && t.sha256 !== test.sha256) out.push(`${w}.sha256: does not match its files and commands (the contract is frozen by what is in it)`);
    }
  }
  if (out.length) return { problems: out };
  return { problems: [], acceptance: { metric: raw.metric as string, direction: raw.direction as Acceptance["direction"], min_lift: minLift as number, floors: floors as Acceptance["floors"], surface: raw.surface as string[], target: cleanTarget!, ...(test ? { test } : {}) } };
}

/**
 * mold_v0-303 (M7): what a program's `record` says wrongly. With the build's record areas (`areas`), an area that is not a
 * workspace area of this build, or a field it does not have, is refused now; without them, only the shape (src/programs.ts
 * checks the areas when it brings a program in).
 */
export function recordProblems(raw: unknown, areas?: readonly RecordAreaShape[] | null): string[] {
  if (!isObject(raw)) return ["record: {area, key?, title?, items?, fields: {field: path}}"];
  const out: string[] = [];
  const PATHLIKE = /^(\$\.)?[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){0,15}$/;
  for (const k of Object.keys(raw)) if (!["area", "key", "title", "items", "fields", "update_by", "move_to", "dedupe_on"].includes(k)) out.push(`record.${k}: not a field of a record`);
  if (typeof raw.area !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(raw.area)) out.push("record.area: the workspace record area its results are kept in");
  for (const k of ["title", "items"]) if (raw[k] !== undefined && !(typeof raw[k] === "string" && PATHLIKE.test(raw[k] as string))) out.push(`record.${k}: a dotted path in the outputs`);
  // mold_v0-334: an update's key may be one of the program's inputs ($inputs.<name>): the record it was started for.
  if (raw.key !== undefined && !(typeof raw.key === "string" && (PATHLIKE.test(raw.key) || (raw.update_by === "key" && /^\$inputs\.[A-Za-z0-9_-]{1,64}$/.test(raw.key)))))
    out.push(`record.key: a dotted path in the outputs${raw.update_by === "key" ? " (or $inputs.<name>)" : ""}`);
  if (raw.update_by !== undefined && raw.update_by !== "key") out.push('record.update_by: "key" (each result updates the record its key names)');
  // mold_v0-334: an update names the record its run was started on, never a key the agent's outputs make up.
  if (raw.update_by === "key" && !(typeof raw.key === "string" && raw.key.startsWith("$inputs."))) out.push("record.update_by: an update names the record its run was started on: record.key is $inputs.<name>");
  if (raw.update_by === "key" && raw.dedupe_on !== undefined) out.push("record.dedupe_on: an update writes no new record: nothing to dedupe");
  if (raw.move_to !== undefined && !(typeof raw.move_to === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw.move_to))) out.push("record.move_to: a state of the area's lifecycle");
  const dedupe = raw.dedupe_on;
  if (dedupe !== undefined && !(Array.isArray(dedupe) && dedupe.length >= 1 && dedupe.length <= 5 && dedupe.every((f) => typeof f === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(f)) && new Set(dedupe).size === dedupe.length))
    out.push("record.dedupe_on: 1 to 5 of the area's fields, each once");
  const fields = raw.fields;
  if (!isObject(fields) || !Object.keys(fields).length || Object.keys(fields).length > PROGRAM_LIMITS.record_fields || !Object.values(fields).every((p) => typeof p === "string" && PATHLIKE.test(p))) out.push(`record.fields: {field: dotted path in the outputs}, 1 to ${PROGRAM_LIMITS.record_fields}`);
  if (out.length || !areas) return out;
  const area = areas.find((a) => a.name === raw.area);
  if (!area) return [`record.area: ${String(raw.area)} is not a record area of this app`];
  if (area.scope !== undefined && area.scope !== "workspace") return [`record.area: ${area.name} is not a workspace area (a program's results are its workspace's)`];
  for (const f of Object.keys(fields as object)) if (!area.fields.includes(f)) out.push(`record.fields.${f}: ${area.name} has no such field`);
  if (typeof raw.move_to === "string" && area.states !== undefined && !area.states.includes(raw.move_to))
    out.push(area.states.length ? `record.move_to: no transition of ${area.name}'s lifecycle reaches ${raw.move_to} (${area.states.join(", ")})` : `record.move_to: ${area.name} has no lifecycle: its records do not move`);
  for (const f of Array.isArray(dedupe) ? dedupe as string[] : []) {
    if (!area.fields.includes(f)) out.push(`record.dedupe_on: ${area.name} has no field ${f}`);
    else if (area.encrypted?.includes(f)) out.push(`record.dedupe_on: ${f} is encrypted: dedupe on a plain field`);
  }
  return out;
}
/** A dotted path of a record's mapping, read in a value ("$." in front is the value itself). */
export const recordPath = (v: unknown, p: string) => atPath(v, p.startsWith("$.") ? p.slice(2) : p);

/**
 * A program's configuration as saved: checked and given its defaults. `hash` is sha256 of a string in hex. `opts.areas`
 * (mold_v0-303): the build's record areas, when the caller has them, to check a `record` against.
 */
export function parseProgram(raw: unknown, hash: (s: string) => string, opts: { areas?: readonly RecordAreaShape[] | null } = {}): { config?: ProgramConfig; problems: string[] } {
  if (!isObject(raw)) return { problems: ["config: an object"] };
  const out: string[] = [];
  const known = new Set(["$comment", "icon", "purpose", "agent_profile", "prompt", "inputs", "outputs", "budget_usd", "limits", "failure_policy", "retries", "spawned_by", "machine", "acceptance", "dock", "record", "roles"]);
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
  if (raw.record !== undefined) out.push(...recordProblems(raw.record, opts.areas));
  // mold_v0-303: the account roles that may start it (src/program-start.ts programRoles); absent, every role that launches.
  if (raw.roles !== undefined && !(Array.isArray(raw.roles) && raw.roles.length >= 1 && raw.roles.length <= ACCOUNT_ROLES.length
    && raw.roles.every((r) => (ACCOUNT_ROLES as readonly unknown[]).includes(r)) && new Set(raw.roles).size === raw.roles.length))
    out.push(`roles: account roles that may start it, each once (${ACCOUNT_ROLES.join(", ")})`);
  if (out.length) return { problems: out };
  return { problems: [], config: { icon: icon as string, ...(raw.purpose !== undefined ? { purpose: raw.purpose as AgentPurpose } : {}), agent_profile: (raw.agent_profile as string | null | undefined) ?? null, prompt, inputs: inputs as JsonSchema, outputs: outputs as JsonSchema,
    budget_usd: budget as number, limits: limits as ProgramConfig["limits"], failure_policy: fp as FailurePolicy, retries: retries as number, spawned_by: spawnedBy as string[],
    ...(machine ? { machine } : {}), ...(acceptance ? { acceptance } : {}), ...(dock ? { dock } : {}), ...(raw.record !== undefined ? { record: raw.record as unknown as ProgramRecord } : {}),
    ...(raw.roles !== undefined ? { roles: raw.roles as AccountRole[] } : {}) } };
}

/** A schema that asks for something: an empty `{"type": "object"}` asks for nothing, so a child need not hand anything in. */
export const typedOutputs = (s: JsonSchema | null | undefined): JsonSchema | null => (s && (Object.keys((s.properties ?? {}) as object).length || ((s.required ?? []) as unknown[]).length || s.anyOf || s.oneOf || s.allOf || s.$ref) ? s : null);

/**
 * Whether a session of agent profile `profile` may spawn this program. `permitted` (mold_v0-303): the session is a root a
 * person started to run exactly this program (NestedPolicy.permit_program), which may spawn it whoever its spawned_by names.
 */
export const mayBeSpawnedBy = (c: Pick<ProgramConfig, "spawned_by">, profile: string | null, permitted: string | null = null) =>
  permitted !== null || c.spawned_by.includes("*") || (!!profile && c.spawned_by.includes(profile));

/** A value at a dotted path of a JSON value, or undefined. */
export function atPath(v: unknown, path: string): unknown {
  let cur = v;
  for (const p of path.split(".")) { if (!isObject(cur) || !(p in cur)) return undefined; cur = cur[p]; }
  return cur;
}
/**
 * A prompt with its {name} placeholders filled from `values` (objects as JSON); an unknown placeholder is left as written.
 * mold_v0-303 (M5): a placeholder `declared` names (a state's or a program's own inputs) that has no value yet is blank,
 * never shown as written: the first pass of a loop has no {feedback}.
 */
export function renderPrompt(template: string, values: Record<string, unknown>, declared: Iterable<string> = []): string {
  const known = new Set(declared);
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k: string) => (k in values ? (values[k] === undefined || values[k] === null ? "" : typeof values[k] === "string" ? (values[k] as string) : JSON.stringify(values[k])) : known.has(k) ? "" : m));
}
/** The names a schema declares as its properties (a program's inputs). */
export const declaredInputs = (s: JsonSchema | null | undefined): string[] => (s && isObject(s.properties) ? Object.keys(s.properties) : []);
/** Whether a path matches a surface glob: * within one segment, ** across segments, ? one character. */
export function globMatch(glob: string, path: string): boolean {
  const re = "^" + glob.split("**").map((part) => part.split("*").map((x) => x.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("?", "[^/]")).join("[^/]*")).join(".*") + "$";
  return new RegExp(re).test(path);
}

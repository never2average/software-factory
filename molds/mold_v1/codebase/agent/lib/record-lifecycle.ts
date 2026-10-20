/**
 * THE LIFECYCLE RULES OF A RECORD AREA, ENFORCED (profiles `records.areas.<area>.lifecycle`; docs/DEPLOYMENT_PROFILE.md
 * "records", "Lifecycle rules").
 *
 * A lifecycle names the field whose choices are a record's states, each state's category, and (optionally) the moves
 * between them: `transitions`, each with who may make it (`roles`), what must be set once it is made (`requires`),
 * whether it needs a comment (`requires_comment`), who may NOT make it (`not_by`: a person field, or "{entered_by}",
 * the person who moved the record into the state it is leaving, so a second person signs off), and the values the
 * move stamps (`set`: "{me}", "{today}", "{today+7d}", "{now}" or a value).
 *
 * `enforce` says what a move that breaks them does:
 *   "off"     (the default) nothing: no rule is read, nothing is stamped, nothing is written to the activity feed. A
 *             write is exactly what it was before lifecycles were enforced.
 *   "warn"    the move goes through (with its stamps) and the activity feed gets a line that names the broken rule.
 *   "strict"  the move is refused: the ops API answers 409 with the allowed moves and why (conflictBody), the agent's
 *             tools throw the same sentence (refusal), and MCP, which goes through the API, reads the 409's error.
 *
 * checkMove() is the one rule book. agent/lib/record-validate.ts calls it for every write that changes a state, so
 * every door (the ops routes, the agent's upsert tools, MCP) applies the same rules; the callers only fetch what the
 * pure core cannot (the stored row, who entered its state: lib/record-lifecycle-server.ts) and write the outcome to
 * the activity feed (moveEvent, warnEvent).
 *
 * The stage pipelines a workspace keeps for its tasks (the task-workflow service's workflow_definitions) map onto the
 * lifecycle's states by CATEGORY (stateForStage; the service's own copy is services/task-workflow/lib/stages.ts):
 * a stage's own `category`, else the state its label names, else today's six status names.
 *
 * A lifecycle that runs a workflow (`workflow`, each move's `step`; docs/WORKFLOW_ENGINE.md phase 5) adds the step's own
 * rules to a move that names a step: the caller hands checkMove a WorkflowGate (lib/record-workflow-runtime.ts builds one
 * from the record's workflow instance and the workspace's people), and what it refuses is a broken rule like any other
 * (`step_inactive`, `not_holder`, `step_transition`, `step_comment`, `step_evidence`), so "warn" and "strict" treat it
 * the same way. Without a gate (no workflow, or enforce "off") nothing here reads one and every answer is what it was.
 *
 * Pure: no database, no fetch.
 */
import type { RecordCategory, RecordRole, RecordTransition } from "./record-areas.generated.ts";
import { CATEGORY_STATUS, type AreaRow, type AreaView } from "./record-areas.ts";

export type EnforceMode = "off" | "warn" | "strict";
/** `not_by` value: the person who moved the record into the state the move leaves (four eyes). */
export const ENTERED_BY = "{entered_by}";

export type LifecycleRule = "transition" | "roles" | "not_by" | "requires" | "requires_comment" | StepRule;
/**
 * A rule of the step a move changes (a lifecycle that runs a workflow): the step is not open yet (`step_inactive`), the
 * caller does not hold it (`not_holder`), the workflow does not let the step go to that state (`step_transition`), it
 * needs a comment (`step_comment`) or evidence (`step_evidence`).
 */
export type StepRule = "step_inactive" | "not_holder" | "step_transition" | "step_comment" | "step_evidence";
export interface BrokenRule {
  rule: LifecycleRule;
  /** What is wrong, as a clause ("only owner or admin may make it"). */
  message: string;
  /** The transition it belongs to, by its label (or its target state's), when one was listed. */
  transition?: string;
}
export interface AllowedMove {
  to: string;
  /** The state's label. */
  label: string;
  /** The transition's label (the button, the model's verb), when it has one. */
  action?: string;
  roles?: RecordRole[];
  /** Field labels that must be set once the move is made. */
  requires?: string[];
  requires_comment?: boolean;
  /** This caller may not make it (`not_by`): a second person must. */
  not_you?: boolean;
  /** The step it changes is held by someone else (a lifecycle that runs a workflow): who holds it. */
  held_by?: string[];
}
/**
 * The step rules of a lifecycle that runs a workflow, for one caller and one record (lib/record-workflow-runtime.ts
 * stepGate). checkMove asks it about every transition that names a `step`; it never changes anything.
 */
export interface WorkflowGate {
  /** What the transition's step refuses this caller, as broken rules (clauses, in the profile's words); [] when none. */
  stepBroken(t: RecordTransition): BrokenRule[];
  /** Who holds the step a transition changes ([] when nobody does, or it names none). */
  holders(t: RecordTransition): string[];
}
export interface MoveCheck {
  field: string;
  from: string | null;
  to: string;
  enforce: EnforceMode;
  allowed: boolean;
  /** The transition the move is made by (the one that allows it, else the first that lists it), or null. */
  transition: RecordTransition | null;
  broken: BrokenRule[];
  /** The moves the caller's role may make from `from` (each with what it needs). */
  allowedMoves: AllowedMove[];
  /** What the move stamps (`set`, resolved), by field key. Empty when it stamps nothing. */
  stamp: Record<string, unknown>;
  /** One sentence naming the move, what is wrong with it and the moves there are. "" when allowed. */
  sentence: string;
}
export interface MoveInput {
  from: string | null;
  to: string;
  /** The record as it is after the write (stored row with the patch applied): what `requires` reads. */
  row: AreaRow;
  /** The stored record before the write, or null on create. `not_by` reads it as well as `row`. */
  before: AreaRow | null;
  actor: string;
  role?: RecordRole;
  /** The comment the write carries (a task's `reason`), for `requires_comment`. */
  comment?: string | null;
  /** Who moved the record into `from` (lib/record-lifecycle-server.ts enteredBy), for `not_by: "{entered_by}"`. */
  enteredBy?: string | null;
  now?: Date;
  /** The step rules, when the lifecycle runs a workflow (see the file's header). */
  workflow?: WorkflowGate;
}

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
const same = (a: unknown, b: string) => typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The area's enforce mode; "off" when it has no lifecycle. */
export function enforceOf(v: AreaView): EnforceMode {
  return v.lifecycle?.enforce ?? "off";
}

/**
 * The state a stored record is in, as the rules read it: its lifecycle field under whichever key the row holds it
 * (`renamed_from`), and a stored legacy spelling as the state it stands for (`legacy_values`). The validator moves a
 * record from this state, so everything that asks about the move (who entered the state, for four eyes) asks about
 * this one too. null when the record holds no state.
 */
export function storedStateOf(v: AreaView, row: AreaRow | null | undefined): string | null {
  const lc = v.lifecycle;
  if (!lc || !row) return null;
  const stored = v.get(row, lc.field);
  return typeof stored === "string" ? v.canonical(lc.field, stored) : null;
}

/** A state and every stored spelling the definition reads as it (`legacy_values`): how the feed may have recorded it. */
export function spellingsOf(v: AreaView, state: string): string[] {
  const lc = v.lifecycle;
  const legacy = lc ? v.field(lc.field)?.legacy_values ?? {} : {};
  const canonical = lc ? v.canonical(lc.field, state) : state;
  return [canonical, ...Object.keys(legacy).filter((k) => legacy[k] === canonical && k !== canonical)];
}

/** Does any move out of `from` need to know who entered it (`not_by: "{entered_by}"`)? Only then is it looked up. */
export function needsEnteredBy(v: AreaView, from: string | null, to?: string): boolean {
  if (from === null) return false;
  // A legacy spelling is the state it stands for, as the validator reads it (storedStateOf).
  const state = v.lifecycle ? v.canonical(v.lifecycle.field, from) : from;
  return (v.area.lifecycle?.transitions ?? []).some((t) => t.not_by === ENTERED_BY && (to === undefined || t.to === to) && (t.from === "*" || t.from.includes(state)));
}

/** A `set` value, resolved: {me} is the actor, {today}/{today+Nd} a day (a column's datetime is that day's morning), {now} the time. */
export function resolveStamp(v: AreaView, key: string, value: unknown, actor: string, now: Date): unknown {
  if (typeof value !== "string" || !value.startsWith("{")) return value;
  if (value === "{me}") return actor.trim().toLowerCase();
  if (value === "{now}") return now.toISOString();
  const m = /^\{today(?:([+-]\d{1,3})d)?\}$/.exec(value);
  if (m) {
    const day = new Date(now.getTime() + (m[1] ? Number(m[1]) : 0) * 86_400_000).toISOString().slice(0, 10);
    const f = v.field(key);
    return f?.type === "datetime" || (f?.column && f.type === "date") ? `${day}T09:00:00.000Z` : day;
  }
  return value;
}

/** Check one move (`from` -> `to`, or a create into `to` when `from` is null) against the area's transitions. */
export function checkMove(v: AreaView, input: MoveInput): MoveCheck {
  const lc = v.lifecycle!;
  const enforce = lc.enforce as EnforceMode;
  const now = input.now ?? new Date();
  const { from, to } = input;
  const label = (s: string | null) => (s === null ? "nothing" : `"${v.display(lc.field, s)}"`);
  const ts = v.area.lifecycle?.transitions ?? [];
  const base = { field: lc.field, from, to, enforce };
  // The moves there are for this role; those `not_by` bars this caller from are marked (a second person must).
  const barred = (t: RecordTransition | null) => Boolean(t?.not_by && notByHits(v, t.not_by, input));
  const transitionOf = (to: string) => (v.area.lifecycle?.transitions ?? []).find((t) => t.to === to && (t.from === "*" || (from !== null && t.from.includes(from)))) ?? null;
  // A step someone else holds is marked with who holds it (only when the lifecycle runs a workflow).
  const held = (t: RecordTransition | null): string[] | null => {
    if (!t?.step || !input.workflow) return null;
    return input.workflow.stepBroken(t).some((b) => b.rule === "not_holder") ? input.workflow.holders(t) : null;
  };
  const allowedMoves = movesFrom(v, from, input.role).map((m) => {
    const t = transitionOf(m.to);
    const by = held(t);
    const out = barred(t) ? { ...m, not_you: true } : m;
    return by ? { ...out, held_by: by } : out;
  });
  const ok = (transition: RecordTransition | null, stamp: Record<string, unknown> = {}): MoveCheck => ({ ...base, allowed: true, transition, broken: [], allowedMoves, stamp, sentence: "" });
  // No transitions listed: every move is allowed. A record created in its initial state starts where it should.
  if (!ts.length) return ok(null);
  if (from === null && to === lc.initial) return ok(null);

  const candidates = ts.filter((t) => t.to === to && (t.from === "*" || (from !== null && t.from.includes(from))));
  const stampOf = (t: RecordTransition) => Object.fromEntries(Object.entries(t.set ?? {}).map(([k, x]) => [k, resolveStamp(v, k, x, input.actor, now)]));
  const broken: BrokenRule[] = [];
  const reasons: string[] = [];
  for (const t of candidates) {
    const name = t.label ?? v.display(lc.field, t.to);
    const why: BrokenRule[] = [];
    if (t.roles && (!input.role || !t.roles.includes(input.role))) why.push({ rule: "roles", message: `only ${t.roles.join(" or ")} may make it`, transition: name });
    if (t.not_by && notByHits(v, t.not_by, input)) {
      why.push({ rule: "not_by", message: t.not_by === ENTERED_BY ? `not by the person who moved it to ${label(from)}; a second person must` : `not by the ${v.label(t.not_by).toLowerCase()}`, transition: name });
    }
    const stamp = stampOf(t);
    const after: AreaRow = { ...input.row, custom: { ...(input.row.custom ?? {}) } };
    for (const [k, x] of Object.entries(stamp)) {
      if (v.field(k)?.column) after[k] = x;
      else after.custom![k] = x;
    }
    const missing = (t.requires ?? []).filter((k) => isBlank(v.get(after, k)));
    if (missing.length) why.push({ rule: "requires", message: `it needs ${missing.map((k) => `"${v.label(k)}"`).join(" and ")}`, transition: name });
    if (t.requires_comment && isBlank(input.comment)) why.push({ rule: "requires_comment", message: "it needs a comment saying why", transition: name });
    if (t.step && input.workflow) why.push(...input.workflow.stepBroken(t).map((b) => ({ ...b, transition: name })));
    if (!why.length) return ok(t, stamp);
    broken.push(...why);
    reasons.push(`${label(to)}${t.label ? ` (${t.label})` : ""}: ${why.map((w) => w.message).join("; ")}.`);
  }
  if (!candidates.length) broken.push({ rule: "transition", message: from === null ? `a new ${v.noun} starts in ${label(lc.initial)}` : `${label(from)} cannot move to ${label(to)}` });
  const head = candidates.length
    ? `Moving from ${label(from)} to ${label(to)} is not possible now: ${reasons.join(" ")}`
    : from === null
      ? `A new ${v.noun} cannot start in ${label(to)}: it starts in ${label(lc.initial)}.`
      : `${label(from)} cannot move to ${label(to)}.`;
  const list = allowedMoves.map(describeMove).join(", ");
  const sentence = from === null ? head : `${head} From ${label(from)} you can move to: ${list || "nothing"}.`;
  // Under "warn" the move goes through: it stamps what the first transition that lists it stamps.
  return { ...base, allowed: false, transition: candidates[0] ?? null, broken, allowedMoves, stamp: candidates[0] ? stampOf(candidates[0]) : {}, sentence };
}

/** Is the caller the person `not_by` names: who entered the state, or the person field's stored or new value? */
function notByHits(v: AreaView, notBy: string, input: MoveInput): boolean {
  if (notBy === ENTERED_BY) {
    // Never looked up (undefined) for a stored record: who entered its state is unknown, so the move is refused rather
    // than let through. `null` is the documented answer of a lookup that found nobody (no person in the feed, no
    // creator's email), and bars nobody.
    if (input.enteredBy === undefined) return Boolean(input.before);
    return Boolean(input.enteredBy && same(input.enteredBy, input.actor));
  }
  const people = [input.before ? v.get(input.before, notBy) : undefined, v.get(input.row, notBy)].flatMap((x) => (Array.isArray(x) ? x : [x]));
  return people.some((p) => same(p, input.actor));
}

/** The moves `role` may make from `state`, each with what it needs (none listed: every other state). */
export function movesFrom(v: AreaView, state: string | null, role?: RecordRole): AllowedMove[] {
  const lc = v.lifecycle;
  if (!lc) return [];
  return lc.movesFrom(state, role).map(({ to, transition: t }) => ({
    to,
    label: v.display(lc.field, to),
    ...(t?.label ? { action: t.label } : {}),
    ...(t?.roles ? { roles: t.roles } : {}),
    ...(t?.requires?.length ? { requires: t.requires.map((k) => v.label(k)) } : {}),
    ...(t?.requires_comment ? { requires_comment: true } : {}),
  }));
}

function describeMove(m: AllowedMove): string {
  const notes = [m.action, m.not_you ? "not by you: a second person must" : "", m.held_by ? (m.held_by.length ? `held by ${m.held_by.join(", ")}` : "nobody holds its step yet") : "", m.requires?.length ? `needs ${m.requires.map((r) => `"${r}"`).join(" and ")}` : "", m.requires_comment ? "needs a comment" : ""].filter(Boolean);
  return `"${m.label}"${notes.length ? ` (${notes.join("; ")})` : ""}`;
}

/** The 409 body a strict refusal answers with: the sentence, the broken rules, and the moves there are. */
export function conflictBody(c: MoveCheck) {
  return {
    error: c.sentence,
    errors: [c.sentence],
    code: "lifecycle_refused" as const,
    field: c.field,
    from: c.from,
    to: c.to,
    broken: c.broken,
    allowed: c.allowedMoves,
  };
}
export type LifecycleConflict = ReturnType<typeof conflictBody>;

/**
 * THE WARNINGS A WRITE ANSWERS WITH (the contract with the UI): the ops API's task write answers
 * `{ item, warnings?: WriteWarning[], next?: NextOccurrence }`. `warnings` is present only when non-empty: today, a
 * move that broke a lifecycle rule under enforce "warn" (it went through). A UI shows `message` as a toast; the rest
 * says which rules and which moves there were. Under "off" and "strict" a write never carries one (strict refuses with
 * the 409 body, LifecycleConflict).
 */
export interface WriteWarning {
  code: "lifecycle_rule_broken";
  /** The sentence to show: the move, what is wrong with it, the moves there are. */
  message: string;
  field: string;
  from: string | null;
  to: string;
  broken: BrokenRule[];
  allowed: AllowedMove[];
}
/** The answer's `next`: the next occurrence a move into a done state created (agent/lib/task-recurrence.ts). */
export interface NextOccurrence {
  id: string;
  title: string;
  dueAt: string | null;
}
/** What a task write answers with, besides its item. */
export interface WriteExtras {
  warnings?: WriteWarning[];
  next?: NextOccurrence;
}

/** A move that broke a rule under "warn", as the answer's warning. */
export function warningOf(c: MoveCheck): WriteWarning {
  return { code: "lifecycle_rule_broken", message: c.sentence, field: c.field, from: c.from, to: c.to, broken: c.broken, allowed: c.allowedMoves };
}

/** What the agent's tools throw for a refused move: the same sentence, which names the moves there are. */
export function refusal(c: MoveCheck): string {
  return c.sentence;
}

/** The marker a move's activity line ends with: how the next move finds who entered a state (enteredBy). */
export function moveMarker(field: string, from: string | null, to: string): string {
  return `[${field}: ${from ?? ""} → ${to}]`;
}
/** The end of the marker of a move INTO `to` (whatever it came from). */
export function enteredSuffix(to: string): string {
  return ` → ${to}]`;
}

/** The activity-feed line of a move under warn or strict: what moved, by which transition, the comment, the marker. */
export function moveEvent(v: AreaView, c: MoveCheck, comment?: string | null): string {
  const lc = v.lifecycle!;
  const what = c.from === null ? `${upper(v.noun)} created in "${v.display(lc.field, c.to)}"` : `${v.label(lc.field, "State")} moved "${v.display(lc.field, c.from)}" → "${v.display(lc.field, c.to)}"`;
  const by = c.transition?.label && c.allowed ? ` (${c.transition.label})` : "";
  const note = typeof comment === "string" && comment.trim() ? `: ${comment.trim().replace(/\s+/g, " ").slice(0, 500)}` : "";
  return `${what}${by}${note} ${moveMarker(lc.field, c.from, c.to)}`;
}

/** The activity-feed line of a move that broke a rule under warn: the rule, and that the move went through. */
export function warnEvent(c: MoveCheck): string {
  const rules = c.broken.map((b) => `${b.transition ? `${b.transition}: ` : ""}${b.message}`).join("; ");
  return `Lifecycle rule not followed (${[...new Set(c.broken.map((b) => b.rule))].join(", ")}): ${rules}. The move went through (enforce: warn).`;
}

const upper = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const normal = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
/**
 * The lifecycle state a workspace's pipeline stage stands for: its own `category` (the area's first state of it), else
 * the state whose value or label its label names, else null (the caller keeps today's meaning).
 */
export function stateForStage(v: AreaView, stage: { id: string; label: string; category?: RecordCategory | string | null }): string | null {
  const lc = v.lifecycle;
  if (!lc) return null;
  const states = lc.states.filter((s) => !s.retired);
  if (stage.category) {
    const s = states.find((x) => x.category === stage.category);
    if (s) return s.value;
  }
  const key = normal(stage.label);
  return states.find((s) => normal(s.value) === key || normal(s.label) === key)?.value ?? null;
}

/**
 * What the task-workflow service is told about the task states (`x-task-states`): each state's value, label and the
 * status its category stores. It maps a pipeline stage to a status by them (services/task-workflow/lib/stages.ts).
 */
export function taskStatesHeader(v: AreaView): Record<string, string> {
  const lc = v.lifecycle;
  if (!lc) return {};
  const states = lc.states.filter((s) => !s.retired && s.category).map((s) => ({ value: s.value, label: s.label, category: s.category, status: CATEGORY_STATUS[s.category!] }));
  return states.length ? { "x-task-states": encodeURIComponent(JSON.stringify(states)) } : {};
}

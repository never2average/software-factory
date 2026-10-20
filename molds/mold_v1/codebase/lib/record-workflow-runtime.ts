/**
 * A RECORD'S WORKFLOW, RUN ON ITS MOVES: the pure half (phase 5 of the workflow engine, docs/WORKFLOW_ENGINE.md
 * "Runtime"). No database, no fetch, no clock unless one is passed; lib/record-workflow-moves.ts is the half that reads
 * and writes, inside the caller's workspace-scoped transaction.
 *
 * A record area whose lifecycle names a `workflow` (profiles `records.areas.<area>.lifecycle.workflow`, docs/
 * DEPLOYMENT_PROFILE.md "records.workflows") runs one engine instance per record. What this module does with it:
 *
 *   workflowBindingOf  the area's binding (its workflow's document, the record states' step states), or null: no
 *                      `workflow`, or enforce "off" (then nothing here is ever called: "off" never runs the engine).
 *   engineDirectory    the engine's directory and role scopes from the workspace's people (agent/lib/people-directory.ts
 *                      identitySnapshot): owner and admin act on every step, everyone else on what they hold or created
 *                      and on what their reportees hold (supervisors by the roster's reporting line).
 *   seedInstance       a new instance for a record, its steps where the record's state says they stand
 *                      (`lifecycle.workflow_states`): attached when the record is created, or on its first move after the
 *                      binding. A step the record is past starts completed through the engine's own migrated-step
 *                      support (a template whose state starts "completed", dated `completed_at`), dated from the feed.
 *   stepGate           the step rules for one caller, as checkMove's WorkflowGate (agent/lib/record-lifecycle.ts): who
 *                      holds the step, a step that is not open yet, the workflow's step transitions, the comment and
 *                      evidence the step demands. Each refusal is a broken rule in the profile's words.
 *   applyStepMove      the move's step change, through the rebuilt step rules (lib/workflow-step-rules.ts) as upstream's
 *                      step route makes it: the comment and evidence, the change and its history rows, a hand-placed
 *                      holder kept, re-resolution on entry, then the workflow's own rules (runDiff) and its finish. A move
 *                      that broke a rule under "warn" changes its step as an ADMINISTRATIVE change: the history row says
 *                      so and names the rules, and the rules that react to it still run.
 *
 *   takeStepActions    what the workflow's own rules queued on the move (the engine's outbox: an email, an agent run),
 *                      as STEP ACTIONS (phase 6): each fires once per entry of its step (the fired-once ledger on the
 *                      instance, `fired_actions`), an email to the step's holders (and whom the action names), an agent
 *                      run as a task for the assistant. Nothing is sent here: the actions are saved with the step change,
 *                      in its transaction, and delivered after it by lib/record-workflow-actions.ts (the app's own
 *                      notification; a task through the task path). Nothing ever sends an email.
 *
 * A pinned definition with what this app cannot run (a model-resolved `prompt` branch in an email's recipients, subject
 * or body; attachments) is refused at build, and here too, never queued and dropped. Rules guarded on other records
 * (cohorts) are not run in this phase.
 */
import { STEP_STATES, type StepStateValue, type WorkflowDSL } from "./workflow-engine/dsl/types.ts";
import { isTerminal, runDiff, type StepChange } from "./workflow-engine/engine/src/core/diff.ts";
import { Directory, offlineEvaluator, type DirectoryUser } from "./workflow-engine/engine/src/core/evaluator.ts";
import { initInstance } from "./workflow-engine/engine/src/core/init.ts";
import { Rbac, type ReportingRow, type RoleBoundary } from "./workflow-engine/engine/src/core/rbac.ts";
import { isMutableStepProperty, setStepProperty, stepPropertyValue, type HistoryEvent, type OutboxEntry, type StepState, type WorkflowInstance } from "./workflow-engine/engine/src/core/state.ts";
import {
  afterPersonPatch,
  checkContributionLength,
  checkStateChange,
  cleanContribution,
  instanceResource,
  patchNeeds,
  stepActResource,
  stepName,
} from "./workflow-step-rules.ts";
import type { RecordAreaId, RecordTransition } from "../agent/lib/record-areas.generated.ts";
import type { AreaRow, AreaView, RecordAreas } from "../agent/lib/record-areas.ts";
import type { BrokenRule, MoveCheck, WorkflowGate } from "../agent/lib/record-lifecycle.ts";
import type { DirectorySnapshot } from "../agent/lib/people-directory.ts";

export type { HistoryEvent, OutboxEntry, StepState, WorkflowDSL, WorkflowInstance };

/** An area's binding to the workflow its lifecycle runs. */
export interface WorkflowBinding {
  areaId: RecordAreaId;
  workflowId: string;
  /** The deployment's current document: what a new instance is pinned to. */
  dsl: WorkflowDSL;
  enforce: "warn" | "strict";
  /** Record state -> each step's state, for a record already mid-lifecycle (`lifecycle.workflow_states`). */
  states: Record<string, Record<string, StepStateValue>>;
}

/**
 * The area's binding, or null: its lifecycle names no workflow, the profile carries no such document, or enforce is
 * "off" (the default: a write is what it was before lifecycles were enforced, and the engine is never called).
 */
export function workflowBindingOf(areaId: RecordAreaId, areas: RecordAreas, workflows: Record<string, unknown>): WorkflowBinding | null {
  const lc = areas[areaId]?.lifecycle;
  if (!lc?.workflow) return null;
  const enforce = lc.enforce ?? "off";
  if (enforce === "off") return null;
  const dsl = Object.hasOwn(workflows, lc.workflow) ? (workflows[lc.workflow] as WorkflowDSL) : undefined;
  if (!dsl) return null;
  return { areaId, workflowId: lc.workflow, dsl, enforce, states: (lc.workflow_states ?? {}) as Record<string, Record<string, StepStateValue>> };
}

/** The engine's directory and role scopes for one workspace, from its people (identitySnapshot). */
export function engineDirectory(snapshot: DirectorySnapshot): { directory: Directory; rbac: Rbac } {
  const org = snapshot.organization_id;
  const directory = new Directory();
  directory.seed(snapshot.users.map((u) => ({ ...u })) as DirectoryUser[], org);
  const rbac = new Rbac();
  rbac.seedRoles(snapshot.roles as RoleBoundary[], org);
  rbac.seedReporting((snapshot.reporting ?? []) as ReportingRow[], org);
  return { directory, rbac };
}

/** A record as the workflow reads it (`object.data`, `task`): every field of the area by key, as the screens read it. */
export function recordData(v: AreaView, row: AreaRow | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!row) return out;
  for (const f of v.fields) {
    const x = v.get(row, f.key);
    if (x === undefined) continue;
    out[f.key] = x instanceof Date ? x.toISOString() : x;
  }
  return out;
}

const iso = (d: Date | string | null | undefined, fallback: Date): string => {
  const t = d instanceof Date ? d : typeof d === "string" ? new Date(d) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toISOString() : fallback.toISOString();
};

/**
 * A new instance of the binding's workflow on one record, its steps where the record's `state` says they stand.
 * `enteredAt`: when the record entered that state (the feed's move line, else its last change): the completion date of
 * the steps it is past. null when the record does not satisfy the workflow's `init.condition` (the workflow does not
 * apply to it).
 */
export function seedInstance(input: {
  binding: WorkflowBinding;
  orgId: string;
  entity: { type: string; id: string };
  state: string | null;
  data: Record<string, unknown>;
  directory: Directory;
  actor: string;
  createdBy?: string | null;
  now: Date;
  enteredAt?: Date | string | null;
}): WorkflowInstance | null {
  const { binding, now } = input;
  const seeded = (input.state !== null ? binding.states[input.state] : undefined) ?? {};
  const at = iso(input.enteredAt, now);
  // The engine's migrated-step support: each step the record is past starts in its state, a completed one dated.
  const seedDsl: WorkflowDSL = structuredClone(binding.dsl);
  for (const tpl of seedDsl.init.steps) {
    const state = seeded[tpl.id];
    if (!state || !(STEP_STATES as readonly string[]).includes(state)) continue;
    tpl.state = { default: state };
    if (state === "completed") tpl.completed_at = { default: at };
    else delete tpl.completed_at;
    // A step the record is at, or past, was reached: it is active (a dormant template step is woken). A rejected one
    // keeps its template's own start, as the workflow's rules leave it.
    if (state !== "rejected") tpl.status = { default: true };
  }
  let instance: WorkflowInstance;
  try {
    instance = initInstance(binding.workflowId, seedDsl, input.data, input.directory, now, input.actor, undefined, input.orgId, input.entity);
  } catch {
    return null; // init.condition / init.apply.default: the workflow is not this record's
  }
  instance.created_by = (input.createdBy && input.createdBy.includes("@") ? input.createdBy : input.actor).toLowerCase();
  // Where it was seeded, as provisioning rows: never a decision (no state_changed row), so an approval log counts none.
  for (const tpl of binding.dsl.init.steps) {
    const state = seeded[tpl.id];
    const from = tpl.state?.default ?? STEP_STATES[0];
    if (!state || state === from) continue;
    instance.history.push({ at: now.toISOString(), type: "step_patched", step_id: tpl.id, detail: `attached at "${input.state}"`, data: { state: { before: from, after: state }, attached_at: input.state }, actor: input.actor, source: "provisioning" });
  }
  instance.terminal = isTerminal(binding.dsl, instance);
  setRecordState(instance, input.state);
  return instance;
}

/**
 * What an instance keeps about its record beside the engine's own fields (stored in `engine_state`):
 *   record_state  the record's state the steps were last brought in line with (seeded, moved, re-synced);
 *   record_move   a move reserved before a write another service makes (the tasks), settled by the record's state.
 */
export interface RecordMove {
  id: string;
  from: string | null;
  to: string;
  step: { id: string; state: string } | null;
  actor: string;
  comment: string | null;
  evidence: string | null;
  administrative: { rules: string[]; message: string } | null;
  at: string;
}
type Kept = { record_state?: string | null; record_move?: RecordMove; fired_actions?: string[] };
export const recordStateOf = (instance: WorkflowInstance): string | null | undefined => (instance as WorkflowInstance & Kept).record_state;
export const setRecordState = (instance: WorkflowInstance, state: string | null): void => {
  (instance as WorkflowInstance & Kept).record_state = state;
};
export const recordMoveOf = (instance: WorkflowInstance): RecordMove | undefined => (instance as WorkflowInstance & Kept).record_move;
export const setRecordMove = (instance: WorkflowInstance, move: RecordMove | undefined): void => {
  if (move) (instance as WorkflowInstance & Kept).record_move = move;
  else delete (instance as WorkflowInstance & Kept).record_move;
};

/**
 * The record reached `state` without the workflow (a system move: a period's rollover; or a write from before the
 * binding was enforced): bring each step `workflow_states` lists for that state in line with it, as provisioning rows
 * that say so (never a decision), so the next move is checked against where the record really is. Holders are kept.
 */
export function resyncInstance(input: { binding: WorkflowBinding; dsl: WorkflowDSL; instance: WorkflowInstance; state: string | null; actor: string; now: Date; at?: Date | string | null }): boolean {
  const { binding, instance, now } = input;
  const before = recordStateOf(instance);
  if (before === input.state) return false;
  const seeded = (input.state !== null ? binding.states[input.state] : undefined) ?? {};
  const at = iso(input.at, now);
  for (const step of instance.steps) {
    const state = seeded[step.id];
    if (!state || !(STEP_STATES as readonly string[]).includes(state)) continue;
    const prior = step.state;
    if (prior !== state) step.state = state as StepState["state"];
    if (state === "completed") step.completed_at ??= at;
    else delete step.completed_at;
    if (state !== "rejected") step.status = true;
    if (prior !== state) {
      instance.history.push({ at: now.toISOString(), type: "step_patched", step_id: step.id, detail: `re-synced: the record moved from "${before ?? ""}" to "${input.state ?? ""}" outside its workflow`, data: { state: { before: prior, after: state }, resynced_to: input.state }, actor: input.actor, source: "provisioning" });
    }
  }
  instance.terminal = isTerminal(input.dsl, instance);
  setRecordState(instance, input.state);
  instance.updated_at = now.toISOString();
  return true;
}

/**
 * Settle a reserved move by where the record now is: it reached the move's target (the other service took the write):
 * the step changes as it was checked when reserved; it is still where it was: released, nothing changes; anywhere else:
 * re-synced to it. The reservation is cleared either way. Mutates `instance`.
 */
export async function settleRecordMove(input: { binding: WorkflowBinding; dsl: WorkflowDSL; instance: WorkflowInstance; directory: Directory; rbac: Rbac; state: string | null; now: Date }): Promise<"applied" | "released" | "resynced" | "none"> {
  const { instance } = input;
  const move = recordMoveOf(instance);
  if (!move) return "none";
  setRecordMove(instance, undefined);
  if (input.state === move.to && move.from !== move.to) {
    if (move.step) {
      await applyStepMove({ dsl: input.dsl, instance, directory: input.directory, rbac: input.rbac, step: move.step, actor: move.actor, comment: move.comment, evidence: move.evidence, now: input.now, administrative: move.administrative });
    }
    instance.history.push({ at: input.now.toISOString(), type: "task_updated", detail: `move ${move.id} settled: the record reached "${move.to}"`, data: { record_move: move.id, outcome: "applied" }, actor: move.actor, source: "user" });
    setRecordState(instance, input.state);
    return "applied";
  }
  if (input.state === move.from) {
    instance.history.push({ at: input.now.toISOString(), type: "task_updated", detail: `move ${move.id} released: the record stayed in "${move.from ?? ""}"`, data: { record_move: move.id, outcome: "released" }, actor: move.actor, source: "user" });
    return "released";
  }
  resyncInstance({ binding: input.binding, dsl: input.dsl, instance, state: input.state, actor: move.actor, now: input.now });
  return "resynced";
}

const quoted = (s: string) => `"${s}"`;

/** The text a record's workflow lock is taken on (`pg_advisory_xact_lock(hashtext(...))`): every door, and delivery. */
export const recordWorkflowLockKey = (orgId: string, areaId: string, key: string): string => `record_workflow:${orgId}:${areaId}:${key}`;

const STEP_RULES = new Set(["step_inactive", "not_holder", "step_transition", "step_comment", "step_evidence"]);
/**
 * A move that broke a STEP rule under "warn" changes its step administratively, naming those rules only. A move that
 * broke only the lifecycle's own rules (roles, requires, …) changes its step as the holder's own change: the step's
 * rules were kept. null when no step rule broke.
 */
export function administrativeOf(check: MoveCheck | null | undefined): { rules: string[]; message: string } | null {
  if (!check || check.allowed) return null;
  const broken = check.broken.filter((b) => STEP_RULES.has(b.rule));
  if (!broken.length) return null;
  return { rules: [...new Set(broken.map((b) => b.rule))], message: broken.map((b) => `${b.transition ? `${b.transition}: ` : ""}${b.message}`).join("; ") };
}

/** The step a transition changes on this instance, or undefined. */
function stepOf(instance: WorkflowInstance, t: RecordTransition): StepState | undefined {
  return t.step ? instance.steps.find((s) => s.id === t.step!.id) : undefined;
}

/**
 * The step rules for one caller on one record (agent/lib/record-lifecycle.ts WorkflowGate). Upstream's step route, in
 * its order, for a state change: the comment and evidence's length, the permission on the instance and on the step
 * (who holds it), a step that is not open yet, the workflow's step transitions, the step's demands. Never changes the
 * instance.
 */
export function stepGate(input: {
  dsl: WorkflowDSL;
  instance: WorkflowInstance;
  directory: Directory;
  rbac: Rbac;
  actor: string;
  comment?: string | null;
  evidence?: string | null;
}): WorkflowGate {
  const { dsl, instance, directory, rbac } = input;
  const actorId = input.actor.trim().toLowerCase();
  const person = directory.get(actorId, instance.organization_id);
  const comment = cleanContribution(input.comment);
  const evidence = cleanContribution(input.evidence);
  const cache = new Map<string, BrokenRule[]>();
  // Who holds a step, as this caller may read it: an owner or an admin reads each holder's email; anyone else their
  // name on the roster (an email is not every colleague's to read).
  const privileged = person?.role === "owner" || person?.role === "admin";
  const shown = (id: string) => {
    if (privileged) return id;
    const name = directory.get(id, instance.organization_id)?.name;
    return typeof name === "string" && name.trim() ? name.trim() : "a person with no name on the roster";
  };
  const holdersOf = (step: StepState) => step.assignee.map(shown);
  return {
    holders(t) {
      const step = stepOf(instance, t);
      return step ? holdersOf(step) : [];
    },
    stepBroken(t) {
      const step = stepOf(instance, t);
      if (!step || !t.step) return [];
      const key = `${t.step.id}:${t.step.state}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const to = t.step.state as StepStateValue;
      const name = `the step ${stepName(step)}`;
      const out: BrokenRule[] = [];
      for (const [what, text] of [["comment", comment], ["evidence", evidence]] as const) {
        const r = checkContributionLength(what, text);
        if (!r.ok) out.push({ rule: what === "comment" ? "step_comment" : "step_evidence", message: `the ${what} for ${name} is too long (${r.message})` });
      }
      const needs = patchNeeds({ step, patch: { state: to }, contributes: Boolean(comment || evidence), actorId });
      const canBase = Boolean(person) && rbac.can(person!, needs.base, instanceResource(instance));
      const canAct = Boolean(person) && (!needs.actOnStep || rbac.can(person!, "act", stepActResource(instance, step)));
      if (!canBase || !canAct) {
        const held = holdersOf(step);
        out.push({
          rule: "not_holder",
          message: held.length
            ? `only whoever holds ${name} (${held.join(", ")}) may make it`
            : `nobody holds ${name} yet, so only someone who may act on every step can make it`,
        });
      }
      const r = checkStateChange({ dsl, instance, step, to, comment, evidence });
      if (!r.ok) {
        if (r.code === "STEP_DORMANT") out.push({ rule: "step_inactive", message: `${name} is not open yet` });
        else if (r.code === "TRANSITION_NOT_ALLOWED") {
          const allowed = dsl.init.transitions?.[step.state] ?? [];
          out.push({ rule: "step_transition", message: `${name} cannot go from ${quoted(step.state)} to ${quoted(to)}${allowed.length ? ` (from ${quoted(step.state)} it may go to ${allowed.map(quoted).join(", ")})` : ""}` });
        } else if (r.code === "COMMENT_REQUIRED") out.push({ rule: "step_comment", message: `${name} needs a comment saying why${step.comments_criterion ? ` (${step.comments_criterion.trim().replace(/\.$/, "")})` : ""}` });
        else if (r.code === "EVIDENCE_REQUIRED") out.push({ rule: "step_evidence", message: `${name} needs evidence, a link or a document's id sent as \`evidence\`${step.evidence_criterion ? ` (${step.evidence_criterion.trim().replace(/\.$/, "")})` : ""}` });
        else out.push({ rule: "step_transition", message: `${name}: ${r.message}` });
      }
      cache.set(key, out);
      return out;
    },
  };
}

/**
 * What this app cannot run in a definition's email and agent actions, as a sentence, or null. The build refuses the
 * same (scripts/lib/record-workflows.mjs); a pinned definition is checked again before a move, never queued and dropped:
 * an email's recipients, subject or body left to a model (a `prompt`, even beside a deterministic `query` / `value`), and
 * attachments (generated or searched for: nothing here makes them).
 */
export function unsupportedActions(dsl: WorkflowDSL): string | null {
  for (const rule of dsl.diff) {
    const email = rule.action?.external?.email;
    if (!email) continue;
    if (!email.recipients?.$or?.query || email.recipients.$or.prompt !== undefined) return `the email of rule ${rule.priority} leaves its recipients to a model`;
    for (const k of ["subject", "body"] as const) {
      if (email[k]?.prompt !== undefined) return `the email of rule ${rule.priority} leaves its ${k} to a model`;
    }
    if (email.attachments) return `the email of rule ${rule.priority} asks for attachments`;
  }
  return null;
}

export class RecordWorkflowRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordWorkflowRefused";
  }
}

/**
 * The move's step change, applied to `instance` (mutated): see the module's header. `administrative`: the move broke
 * a rule under "warn" and went through; its step changes all the same, recorded as an administrative change naming the
 * rules. Returns whether the step changed.
 */
export async function applyStepMove(input: {
  dsl: WorkflowDSL;
  instance: WorkflowInstance;
  directory: Directory;
  rbac: Rbac;
  step: { id: string; state: string };
  actor: string;
  comment?: string | null;
  evidence?: string | null;
  now: Date;
  administrative?: { rules: string[]; message: string } | null;
}): Promise<boolean> {
  const { dsl, instance, directory, rbac, now } = input;
  const unsupported = unsupportedActions(dsl);
  if (unsupported) throw new RecordWorkflowRefused(`This workflow asks for what this app does not run (${unsupported}); nothing was written.`);
  const step = instance.steps.find((s) => s.id === input.step.id);
  if (!step) return false;
  const actorId = input.actor.trim().toLowerCase();
  const at = now.toISOString();
  const comment = cleanContribution(input.comment);
  const evidence = cleanContribution(input.evidence);
  const patch: Record<string, unknown> = { state: input.step.state };
  const change: StepChange = { stepId: step.id, changed: {} };
  for (const [prop, after] of Object.entries(patch)) {
    if (!isMutableStepProperty(prop)) continue;
    const before = stepPropertyValue(step, prop);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (!setStepProperty(step, prop, after)) continue;
    change.changed[prop] = { before, after };
  }
  const transition = change.changed.state ? `${change.changed.state.before} → ${change.changed.state.after}` : undefined;
  const source = "user" as const;
  if (comment) {
    step.comments.push({ at, actor: actorId, text: comment, on_transition: transition });
    instance.history.push({ at, type: "comment_added", step_id: step.id, detail: transition, data: { text: comment }, actor: actorId, source });
  }
  if (evidence && !step.evidence.some((e) => e.ref === evidence)) {
    step.evidence.push({ at, actor: actorId, ref: evidence, on_transition: transition });
    instance.history.push({ at, type: "evidence_added", step_id: step.id, detail: transition, data: { ref: evidence }, actor: actorId, source });
  }
  if (!Object.keys(change.changed).length) {
    instance.updated_at = at;
    return false;
  }
  const admin = input.administrative ?? null;
  const patched: HistoryEvent = {
    at,
    type: "step_patched",
    step_id: step.id,
    data: admin ? { ...change.changed, administrative: true, rules: admin.rules } : change.changed,
    actor: actorId,
    source,
    ...(admin ? { detail: `administrative change under enforce "warn": ${admin.message}`.slice(0, 1000) } : {}),
  };
  instance.history.push(patched);
  if (change.changed.state) instance.history.push({ at, type: "state_changed", step_id: step.id, detail: transition, data: { ...change.changed.state, ...(admin ? { administrative: true } : {}) }, actor: actorId, source });
  afterPersonPatch({ step, change, dsl, directory, instance, at, actorId, org: rbac });
  const queued = { outbox: instance.outbox.length, history: instance.history.length };
  await runDiff(instance, dsl, change, directory, offlineEvaluator, now, actorId, undefined, rbac);
  takeStepActions({ instance, from: queued, actor: actorId, now });
  instance.terminal = isTerminal(dsl, instance);
  instance.updated_at = at;
  return true;
}

// ── step actions (phase 6) ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A fired email or agent action, as the instance keeps it until it is delivered (the engine's outbox entry, plus what
 * the delivery needs to say, read when it fired):
 *   key      its place in the fired-once ledger (`fired_actions`): rule, step, the step's entry, kind (and agent);
 *   step     the step's title as the workflow names it; holders: who held it then;
 *   record   the record it is about: its area, its key (`workflowRecordKey`) and a label (its title or name), so a
 *            notification or a task can name it without reading the record again;
 *   actor    whose move fired it (the task's author).
 * An email's `recipients` are the step's holders and the people the action's own query names, every one of them in the
 * workspace's directory. Its delivery state is the engine's own (`delivery`: pending, processing, delivered, dead_letter).
 */
export type StepAction = OutboxEntry & {
  key: string;
  step: string;
  /** Who held the step when it fired (an agent action's task is assigned to the first). */
  holders: string[];
  record: { area: string; id: string; label: string | null };
  actor: string;
};

/** The history rows a step action's DELIVERY writes (lib/record-workflow-actions.ts finishStepActions): never a move. */
export const DELIVERY_HISTORY = new Set(["external_delivered", "external_dead_lettered"]);

/**
 * What a move of the record DEPENDS ON in its stored instance: everything but the revision, the last change's time, the
 * record's data (the record is compared on its own), the outbox (its delivery state) and the history rows delivery
 * writes. A step action's claim and finish save the instance (moving its revision on) and change none of this, so a
 * move checked before a delivery and reserved after it is still the move that was checked (lib/record-workflow-moves.ts
 * reserveRecordMove); any step change, re-sync, reservation or fired action changes it.
 */
export function moveBasisOf(instance: WorkflowInstance): string {
  const { revision: _r, updated_at: _u, outbox: _o, task: _t, object, history, ...rest } = instance as WorkflowInstance & Record<string, unknown>;
  const kept = history.filter((e) => !DELIVERY_HISTORY.has(e.type));
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(stable({ ...rest, object: { type: object.type, id: object.id }, history: kept }));
}

/** The fired-once ledger on the instance: one key per action fired, per entry of its step. */
export const firedActionsOf = (instance: WorkflowInstance): string[] => (instance as WorkflowInstance & Kept).fired_actions ?? [];

/**
 * The step's entries so far: each change of its state (a person's, a rule's, an administrative one: `state_changed`),
 * and each time the record placed it (seeded or re-synced: a provisioning `step_patched` with a state). An action that
 * reacts to a step fires once for each.
 */
export function stepEntryOf(instance: WorkflowInstance, stepId: string): number {
  let n = 0;
  for (const e of instance.history) {
    if (e.step_id !== stepId) continue;
    if (e.type === "state_changed") n += 1;
    else if (e.type === "step_patched" && e.source === "provisioning" && (e.data as { state?: unknown } | undefined)?.state) n += 1;
  }
  return n;
}

/** The pending actions of an instance (fired, not delivered yet), in the order they fired. */
export const stepActionsOf = (instance: WorkflowInstance): StepAction[] => instance.outbox.filter((e): e is StepAction => typeof (e as Partial<StepAction>).key === "string");

/** How a notification or a task names the record: its title or name, else its own id (a deployment's, not its account's). */
const recordLabel = (data: Record<string, unknown>, key: string): string | null => {
  for (const k of ["title", "name", "label"]) if (typeof data[k] === "string" && (data[k] as string).trim()) return (data[k] as string).trim().slice(0, 200);
  const own = key.split("/").at(-1);
  if (!own) return null;
  try {
    return decodeURIComponent(own).slice(0, 200);
  } catch {
    return own.slice(0, 200);
  }
};

/**
 * The actions the workflow's own rules queued on this change (the outbox entries from `from.outbox` on, and their
 * `external_queued` rows from `from.history` on), kept as step actions: once per entry of their step. An action whose
 * key is already in the ledger (a rule that matches again while its step stays where it is, such as a `$condn` on an
 * open step at every later change) is taken back, its queued row with it: it fired already. Mutates `instance`.
 */
export function takeStepActions(input: { instance: WorkflowInstance; from: { outbox: number; history: number }; actor: string; now: Date }): StepAction[] {
  const { instance } = input;
  const fresh = instance.outbox.splice(input.from.outbox);
  if (!fresh.length) return [];
  const fired = new Set(firedActionsOf(instance));
  const kept: StepAction[] = [];
  const dropped: { step: string; detail: string }[] = [];
  for (const entry of fresh) {
    const step = instance.steps.find((s) => s.id === entry.step_id);
    const detail = entry.kind === "email" ? "email" : `agent:${entry.name}`;
    const key = `${entry.rule_priority}:${entry.step_id}:${stepEntryOf(instance, entry.step_id)}:${entry.kind}${entry.kind === "agent" ? `:${entry.agent_id}` : ""}`;
    if (fired.has(key)) {
      dropped.push({ step: entry.step_id, detail });
      continue;
    }
    fired.add(key);
    const record = { area: instance.object.type, id: instance.object.id, label: recordLabel(instance.task ?? {}, instance.object.id) };
    const base = { key, step: step?.title?.trim() || entry.step_id, holders: [...(step?.assignee ?? [])], record, actor: input.actor };
    if (entry.kind === "email") {
      if (!Array.isArray(entry.recipients)) throw new RecordWorkflowRefused("This workflow left an email's recipients to a model, which this app does not run; nothing was written.");
      const recipients = [...new Set([...(step?.assignee ?? []), ...entry.recipients].map((r) => String(r).trim().toLowerCase()).filter((r) => r.includes("@")))];
      kept.push({ ...entry, recipients, ...base });
    } else {
      kept.push({ ...entry, ...base });
    }
  }
  // The queued rows of the actions taken back: the last ones of their kind on their step, from this change.
  for (const d of dropped) {
    for (let i = instance.history.length - 1; i >= input.from.history; i -= 1) {
      const e = instance.history[i];
      if (e.type === "external_queued" && e.step_id === d.step && e.detail === d.detail) {
        instance.history.splice(i, 1);
        break;
      }
    }
  }
  instance.outbox.push(...kept);
  (instance as WorkflowInstance & Kept).fired_actions = [...fired];
  return kept;
}

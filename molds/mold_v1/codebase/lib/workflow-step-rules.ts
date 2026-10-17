/**
 * THE STEP-CHANGE RULES of the vendored workflow engine (lib/workflow-engine/; docs/WORKFLOW_ENGINE.md), as pure
 * functions over the engine's own types: no HTTP, no store, no clock unless one is passed.
 *
 * Credit: rebuilt from the step PATCH handler of the upstream engine's HTTP service (engine/src/app.ts, roughly lines
 * 1760-2200 at the commit pinned in lib/workflow-engine/UPSTREAM.json), which is not vendored. Upstream keeps
 * these guards inside the route; the mold has no such route yet, so they live here, where a later phase's wiring and
 * the tests call them. Each rule says what upstream answers (the HTTP status) so the wiring can keep the same contract.
 *
 * Differences from upstream, all deliberate:
 *   - Upstream gives one hard-coded role name a bypass (it may decide a step it does not hold). Here the caller says
 *     whether the actor has such standing (`actsWithoutHolding`); base code names no role.
 *   - Upstream's refusal texts name that role and its customers' job titles; here they are neutral.
 *   - The resources RBAC is asked about take the object's permission name from the caller (`objectName`), where
 *     upstream derives it from its own ordered object types (not vendored).
 *
 * Nothing imports this module at runtime yet (phase 1 of the workflow-engine work changes no behaviour).
 */
import type { StepStateValue, WorkflowDSL } from "./workflow-engine/dsl/types.ts";
import { STEP_STATES } from "./workflow-engine/dsl/types.ts";
import { reresolveOnEnter, resolveRelative, transitionError, type OrgHierarchy, type StepChange } from "./workflow-engine/engine/src/core/diff.ts";
import type { Directory, DirectoryUser } from "./workflow-engine/engine/src/core/evaluator.ts";
import { resolveAssignees, type Balancer } from "./workflow-engine/engine/src/core/init.ts";
import type { Rbac, RbacAction, RbacResource } from "./workflow-engine/engine/src/core/rbac.ts";
import type { HistoryEvent, StepState, WorkflowInstance } from "./workflow-engine/engine/src/core/state.ts";

/** Why a step change was refused. `status` is what upstream's route answers for it. */
export type StepRuleCode =
  | "UNPATCHABLE_PROPERTY"
  | "INVALID_VALUE"
  | "TEXT_TOO_LONG"
  | "STEP_DORMANT"
  | "TRANSITION_NOT_ALLOWED"
  | "COMMENT_REQUIRED"
  | "EVIDENCE_REQUIRED"
  | "DEMAND_LOWERING_NEEDS_ADMIN"
  | "REASSIGN_NEEDS_SUPERVISOR"
  | "TAKER_CANNOT_ACT"
  | "ASSIGNEE_OUTSIDE_RULE"
  | "DUE_ON_REMOVAL"
  | "DUE_ON_NOTHING_TO_EXTEND"
  | "DUE_ON_INVALID"
  | "DUE_ON_UNREADABLE"
  | "DUE_ON_ALREADY_EXTENDED"
  | "DUE_ON_BACKDATE"
  | "DUE_ON_BEFORE_WINDOW"
  | "DUE_ON_OVER_CAP";

export interface StepRuleRefusal {
  ok: false;
  code: StepRuleCode;
  status: 403 | 409 | 422;
  message: string;
}
export type StepRuleResult = { ok: true } | StepRuleRefusal;

const OK: StepRuleResult = { ok: true };
const refuse = (code: StepRuleCode, status: 403 | 409 | 422, message: string): StepRuleRefusal => ({ ok: false, code, status, message });

/** A step as people know it: its title, quoted (upstream's stepName). */
export function stepName(step: Pick<StepState, "title">): string {
  return `"${step.title?.trim() || "This step"}"`;
}

// ── the patch's shape ─────────────────────────────────────────────────────────────────────────────────────────────

/** The step properties a person may patch, and the shape each accepts (upstream's PATCHABLE). */
export const PATCHABLE: Readonly<Record<string, (v: unknown) => boolean>> = {
  status: (v) => typeof v === "boolean",
  state: (v) => (STEP_STATES as readonly unknown[]).includes(v),
  completed_at: (v) => v === null || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))),
  due_on: (v) => v === null || typeof v === "string",
  assignee: (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  evidence_required: (v) => typeof v === "boolean",
  comments_required: (v) => typeof v === "boolean",
  completed_on_delta: (v) => typeof v === "number",
};
const EXPECTED_SHAPE: Record<string, string> = {
  status: "boolean",
  state: STEP_STATES.join("/"),
  completed_at: "ISO string or null",
  due_on: "ISO string or null",
  assignee: "array of user id strings",
  evidence_required: "boolean",
  comments_required: "boolean",
  completed_on_delta: "number",
};

/**
 * Refuses a patch naming a property that is not patchable (own keys only: `constructor` or `toString` would otherwise
 * pass through the prototype chain) or carrying a value of the wrong shape. Upstream: 422.
 */
export function checkPatchShape(patch: Record<string, unknown>): StepRuleResult {
  const unknownKeys = Object.keys(patch).filter((k) => !Object.prototype.hasOwnProperty.call(PATCHABLE, k));
  if (unknownKeys.length) return refuse("UNPATCHABLE_PROPERTY", 422, `unpatchable step properties: ${unknownKeys.join(", ")}`);
  const bad = Object.entries(patch)
    .filter(([k, v]) => !PATCHABLE[k](v))
    .map(([k]) => `${k} (expected ${EXPECTED_SHAPE[k]})`);
  if (bad.length) return refuse("INVALID_VALUE", 422, `invalid value for: ${bad.join(", ")}`);
  return OK;
}

// ── comment and evidence text ─────────────────────────────────────────────────────────────────────────────────────

/** Longest comment or evidence reference, in code points. */
export const MAX_CONTRIBUTION_CHARS = 4000;
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]/gu;
const CONTROL_EXCEPT_WHITESPACE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * A comment or an evidence reference as it is stored: characters that render as nothing are dropped (an invisible
 * comment would satisfy a demand while showing an empty cell), newlines and tabs are kept (a justification is often
 * paragraphed), the ends are trimmed. Anything that is not a string is "" (nothing supplied).
 */
export function cleanContribution(value: unknown): string {
  return typeof value === "string" ? value.replace(INVISIBLE, "").replace(CONTROL_EXCEPT_WHITESPACE, "").trim() : "";
}

/** Refuses a cleaned comment or evidence reference over the cap, counted in code points. Upstream: 422. */
export function checkContributionLength(name: "comment" | "evidence", text: string): StepRuleResult {
  return [...text].length > MAX_CONTRIBUTION_CHARS
    ? refuse("TEXT_TOO_LONG", 422, `${name} exceeds ${MAX_CONTRIBUTION_CHARS} characters`)
    : OK;
}

// ── a state change: dormant, the transition matrix, the demands ──────────────────────────────────────────────────

export interface Demand {
  what: "comment" | "evidence";
  /** Whether the step demands it for this destination state. */
  required: boolean;
  /** The step's own criterion, shown with the refusal. */
  criterion?: string;
}

/**
 * What a move of `step` to `to` must carry. Read from the MATERIALIZED step (so editing or deleting the template cannot
 * re-scope a demand on work in flight). A demand whose `condition` is still an unresolved AI prompt counts as ON: it is
 * unknown, not absent, and treating it as off would let the offline evaluator disarm it for good. `required_on` narrows
 * a demand to some destination states; `null` is read as absent (persisted steps round-trip undefined as null).
 */
export function demandsFor(instance: WorkflowInstance, step: StepState, to: StepStateValue): Demand[] {
  const unresolved = (flag: string) => instance.pending_prompts[`steps.${step.id}.${flag}`] !== undefined;
  const inScope = (scope: StepStateValue[] | null | undefined) => scope == null || scope.includes(to);
  return [
    {
      what: "comment",
      required: (step.comments_required || unresolved("comments_required")) && inScope(step.comments_required_on),
      criterion: step.comments_criterion,
    },
    {
      what: "evidence",
      required: (step.evidence_required || unresolved("evidence_required")) && inScope(step.evidence_required_on),
      criterion: step.evidence_criterion,
    },
  ];
}

/**
 * A person moving `step` to state `to`. In upstream's order: a dormant step is not actionable (409; activation is a
 * separate admin act, never the same request); the workflow's transition matrix (422); then each demand the move does
 * not carry (422). `comment` and `evidence` are the cleaned texts. A move to the state the step is already in is no
 * change, so nothing is checked. Rule-driven moves never come here: automation has no author to ask (the matrix binds
 * rules inside the engine itself).
 */
export function checkStateChange(input: {
  dsl: WorkflowDSL;
  instance: WorkflowInstance;
  step: StepState;
  to: StepStateValue;
  comment?: string;
  evidence?: string;
}): StepRuleResult {
  const { dsl, instance, step, to } = input;
  if (to === step.state) return OK;
  if (!step.status) return refuse("STEP_DORMANT", 409, `${stepName(step)} is not open yet, so it cannot be actioned.`);
  const err = transitionError(dsl, step.state, to);
  if (err) return refuse("TRANSITION_NOT_ALLOWED", 422, err);
  const supplied = { comment: input.comment ?? "", evidence: input.evidence ?? "" };
  for (const d of demandsFor(instance, step, to)) {
    if (!d.required || supplied[d.what]) continue;
    return refuse(
      d.what === "comment" ? "COMMENT_REQUIRED" : "EVIDENCE_REQUIRED",
      422,
      `step "${step.id}" requires ${d.what === "evidence" ? "evidence" : "a comment"} to change state to "${to}"` +
        (d.criterion ? `: ${d.criterion}` : "") +
        ` — send { "${d.what}": "..." } with the change`,
    );
  }
  return OK;
}

/**
 * A comment or evidence added to a dormant step by someone without write on the instance is refused (409): a holder
 * adds nothing to a step the work has not reached.
 */
export function checkContributionOnDormant(step: StepState, contributes: boolean, canWrite: boolean): StepRuleResult {
  return contributes && !step.status && !canWrite
    ? refuse("STEP_DORMANT", 409, `${stepName(step)} is not open yet, so it cannot be actioned.`)
    : OK;
}

/**
 * Switching a demand OFF lifts the control it exists to impose on the very actor who holds instance write, so it is an
 * admin act; raising one is not. Upstream: 403.
 */
export function checkDemandLowering(step: StepState, patch: Record<string, unknown>, isAdmin: boolean): StepRuleResult {
  for (const flag of ["comments_required", "evidence_required"] as const) {
    if (patch[flag] === false && step[flag] === true && !isAdmin) {
      return refuse("DEMAND_LOWERING_NEEDS_ADMIN", 403, `You cannot switch off ${flag} on ${stepName(step)}. Ask an administrator.`);
    }
  }
  return OK;
}

// ── who a patch needs ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The RBAC resource for an instance (upstream's instanceResource): every step's holders, the record's department(s)
 * and business unit from the attached object's data, and the record's key for platform shares.
 */
export function instanceResource(instance: WorkflowInstance, objectName?: string): RbacResource {
  const departments = instance.task.departments;
  return {
    type: "instance",
    id: instance.id,
    organization_id: instance.organization_id,
    object_key: `${instance.object.type}:${instance.object.id}`,
    created_by: instance.created_by,
    ...(objectName ? { object_name: objectName, require_object_permission: true } : {}),
    assignees: [...new Set(instance.steps.flatMap((s) => s.assignee))],
    department: instance.task.department as string | undefined,
    departments: Array.isArray(departments) ? departments.filter((d): d is string => typeof d === "string") : undefined,
    business_unit: instance.task.business_unit as string | undefined,
  };
}

/**
 * The RBAC resource for ACTING on one step (upstream's stepActResource): only that step's holders; the creator only when
 * they hold the step (so creating the record confers no approval); no department, because that comes from object data
 * a participant may have supplied.
 */
export function stepActResource(instance: WorkflowInstance, step: StepState, objectName?: string): RbacResource {
  return {
    type: "instance",
    id: instance.id,
    organization_id: instance.organization_id,
    object_key: `${instance.object.type}:${instance.object.id}`,
    created_by: instance.created_by && step.assignee.includes(instance.created_by) ? instance.created_by : undefined,
    ...(objectName ? { object_name: objectName, require_object_permission: true } : {}),
    assignees: step.assignee,
  };
}

export interface PatchNeeds {
  /** The permission every request needs on the instance first: `act` for a holder's own move or contribution, else `write`. */
  base: Extract<RbacAction, "act" | "write">;
  /** `act` on the step itself: a state change (unless the actor decides without holding). */
  actOnStep: boolean;
  /** `admin`: the patch touches `status` (activating a dormant step is the workflow's decision, never a participant's). */
  admin: boolean;
  /** `write`: the patch touches anything but state, status and the completion date riding on a real state change. */
  write: boolean;
}

/**
 * Which permissions a patch needs, by what it touches rather than whether the value differs (asking to set `state` needs
 * act even when it is a no-op, or "can I approve this?" becomes a probe). Upstream's split: a state change (with its
 * completion date) or a comment/evidence alone is an `act`; `status` is `admin`; anything else is `write`.
 * `actsWithoutHolding`: the caller's own rule that this actor may decide a step they do not hold (upstream hard-codes a
 * role for it); then the state change is a write on the record, not an act on the step.
 */
export function patchNeeds(input: {
  step: StepState;
  patch: Record<string, unknown>;
  contributes: boolean;
  actsWithoutHolding?: boolean;
  actorId?: string;
}): PatchNeeds {
  const { step, patch } = input;
  const keys = Object.keys(patch);
  const touchesState = "state" in patch;
  const bypass = !!input.actsWithoutHolding && touchesState && !(input.actorId && step.assignee.includes(input.actorId));
  const datesTheChange = !("completed_at" in patch) || patch.state !== step.state;
  const stateAct = touchesState && datesTheChange && !bypass && keys.every((k) => k === "state" || k === "completed_at");
  const contributionOnly = keys.length === 0 && input.contributes;
  return {
    base: stateAct || contributionOnly ? "act" : "write",
    actOnStep: touchesState && !input.actsWithoutHolding,
    admin: "status" in patch,
    write: keys.some((k) => k !== "state" && k !== "status" && !(stateAct && k === "completed_at")),
  };
}

// ── who holds a step ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A change of who holds `step` (`next` is the whole new list). Upstream's three rules, in order:
 *   1. choosing who holds a step is a supervisor's call: an instance admin, or a role that edits the record across its
 *      organization, unit or department (Rbac.canReassign). Holding a step, having created the record, managing a
 *      holder and shares do not count. 403.
 *   2. taking a step yourself must leave you able to act on it (or the caller says you decide without holding). 403.
 *   3. someone newly put on the step must be someone its rule could pick (the assignee query without its limit, plus
 *      the relative walk); an instance admin may place anyone, to fill a step whose rule reaches nobody. 422.
 * One person may hold any number of steps of the same workflow.
 */
export function checkReassign(input: {
  rbac: Rbac;
  actor: DirectoryUser;
  instance: WorkflowInstance;
  step: StepState;
  next: string[];
  dsl: WorkflowDSL;
  directory: Directory;
  org?: OrgHierarchy;
  actsWithoutHolding?: boolean;
  objectName?: string;
}): StepRuleResult {
  const { rbac, actor, instance, step, next, dsl, directory } = input;
  const resource = instanceResource(instance, input.objectName);
  if (!rbac.canReassign(actor, resource)) {
    return refuse("REASSIGN_NEEDS_SUPERVISOR", 403, `You cannot change who holds ${stepName(step)}. Ask someone who supervises this work, or an administrator.`);
  }
  if (next.includes(actor.id) && !step.assignee.includes(actor.id)) {
    const canAct = !!input.actsWithoutHolding ||
      rbac.can(actor, "act", stepActResource(instance, { ...step, assignee: [...step.assignee, actor.id] }, input.objectName));
    if (!canAct) {
      return refuse("TAKER_CANNOT_ACT", 403, `You could not act on ${stepName(step)} once assigned. Ask an administrator to assign someone who can.`);
    }
  }
  const spec = dsl.init.steps.find((t) => t.id === step.id)?.assignee;
  const added = next.filter((id) => !step.assignee.includes(id));
  if (added.length && spec?.condition?.$or?.query && !rbac.can(actor, "admin", resource)) {
    const eligible = new Set([
      ...resolveAssignees({ ...spec, limit: Infinity }, directory, [], undefined, undefined, instance.organization_id, instance.object.data).ids,
      ...(spec.relative && input.org ? resolveRelative(spec.relative, instance, input.org, directory) : []),
    ]);
    const outside = added.filter((id) => !eligible.has(id));
    if (outside.length) {
      return refuse(
        "ASSIGNEE_OUTSIDE_RULE",
        422,
        `${outside.map((id) => directory.get(id, instance.organization_id)?.email ?? id).join(", ")} ${outside.length === 1 ? "does" : "do"} not match the rule for ${stepName(step)}.`,
      );
    }
  }
  return OK;
}

/**
 * After a person's patch is applied (`change` is what it changed): an assignee named in the request is pinned, so the
 * template query never overwrites that decision on rework (a hand-placed checker keeps duties separate); and the patched
 * step re-resolves on entry (a state change, or activation) unless the same request named its assignee. Rule-driven
 * changes re-resolve inside the engine's runDiff.
 */
export function afterPersonPatch(input: {
  step: StepState;
  change: StepChange;
  dsl: WorkflowDSL;
  directory: Directory;
  instance: WorkflowInstance;
  at: string;
  actorId: string;
  balancer?: Balancer;
  org?: OrgHierarchy;
}): void {
  const { step, change } = input;
  if (change.changed.assignee) step.assignee_pinned = true;
  if ((change.changed.state || change.changed.status?.after === true) && !change.changed.assignee) {
    reresolveOnEnter(step, input.dsl, input.directory, input.instance, input.at, { actor: input.actorId, source: "user" }, input.balancer, input.org);
  }
}

// ── the due date ──────────────────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Whether `requested` changes the step's due date (a re-spelled encoding of the same instant does not). */
export function changesDueOn(step: StepState, requested: unknown): boolean {
  if (requested === step.due_on) return false;
  return !(typeof requested === "string" && typeof step.due_on === "string" && Date.parse(requested) === Date.parse(step.due_on));
}

/**
 * A person's due-date change on a step whose template declares `due_on_extension`: the bounded, near-overdue, one-shot
 * extension instead of a free reschedule. In upstream's order: the date may not be removed, and there must be one to
 * extend; the new date must parse; an unreadable stored date fails CLOSED (with no baseline neither window nor cap can
 * hold); spent first (a used-up extension can never succeed, so "wait for the window" would be a false promise); forward
 * only; inside the window; within the cap. All 422.
 *
 * Spent-ness counts only `due_date_extended` history rows, so an administrator's correction (which bypasses this:
 * `isAdmin`) never burns the holder's one extension. A step without the declaration, or a request that does not change
 * the date, passes. `extended` tells the caller to write the `due_date_extended` row (dueDateExtendedEvent).
 */
export function checkDueOnChange(input: {
  dsl: WorkflowDSL;
  instance: WorkflowInstance;
  step: StepState;
  requested: unknown;
  isAdmin: boolean;
  now?: number;
}): StepRuleResult & { extended?: boolean } {
  const { dsl, instance, step, requested } = input;
  const extension = dsl.init.steps.find((t) => t.id === step.id)?.due_on_extension;
  if (!extension || !changesDueOn(step, requested) || input.isAdmin) return OK;
  const maxDays = extension.max_days ?? 15;
  const windowDays = extension.window_days ?? 3;
  if (!step.due_on) return refuse("DUE_ON_NOTHING_TO_EXTEND", 422, `step "${step.id}" has no due date to extend — ask an administrator to set one`);
  if (typeof requested !== "string") return refuse("DUE_ON_REMOVAL", 422, `step "${step.id}" allows only a bounded due-date extension — due_on cannot be removed; ask an administrator`);
  const current = Date.parse(step.due_on);
  const wanted = Date.parse(requested);
  if (Number.isNaN(wanted)) return refuse("DUE_ON_INVALID", 422, "due_on must be a valid ISO datetime");
  if (Number.isNaN(current)) return refuse("DUE_ON_UNREADABLE", 422, `${stepName(step)} has an unreadable stored due date. Ask an administrator to repair it.`);
  const spent = instance.history.some((e) => e.type === "due_date_extended" && e.step_id === step.id);
  if ((extension.once ?? true) && spent) return refuse("DUE_ON_ALREADY_EXTENDED", 422, `${stepName(step)} has already been extended once. No further extensions.`);
  if (wanted < current) return refuse("DUE_ON_BACKDATE", 422, `${stepName(step)} allows only an extension: the due date can only move later. Ask an administrator to bring it forward.`);
  if ((input.now ?? Date.now()) < current - windowDays * DAY_MS) return refuse("DUE_ON_BEFORE_WINDOW", 422, `${stepName(step)} can only be extended within ${windowDays} day(s) of its due date.`);
  if (wanted > current + maxDays * DAY_MS) return refuse("DUE_ON_OVER_CAP", 422, `${stepName(step)} can be extended by at most ${maxDays} day(s) past its current due date.`);
  return { ok: true, extended: true };
}

/** The history row an exercised extension writes, beside the ordinary `step_patched` row. */
export function dueDateExtendedEvent(stepId: string, before: unknown, after: unknown, actorId: string, at: string): HistoryEvent {
  return { at, type: "due_date_extended", step_id: stepId, detail: `${before} → ${after}`, data: { before, after }, actor: actorId, source: "user" };
}

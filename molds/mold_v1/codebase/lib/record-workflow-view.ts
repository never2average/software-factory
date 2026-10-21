/**
 * A RECORD'S WORKFLOW AS A PERSON READS IT (phase 7 of the workflow engine, docs/WORKFLOW_ENGINE.md "Surfaces"): who
 * holds the next step and when it is due, every step, and the step timeline. Pure: no database, no engine import (the
 * instance is plain data); shared by the ops API (app/api/ops/record-workflow), the agent's tools
 * (agent/lib/record-workflow-tools.ts) and, for its types and the record key, the screens.
 *
 * WHO A PERSON IS, AS THE READER MAY SEE IT. An owner or an admin reads each person's email; anyone else, and the model
 * acting for them, reads their name on the roster (an email is not every colleague's to read), or "someone with no
 * name on the roster". The words are the deployment's: the step titles are the workflow's own, the record's noun the
 * profile's (passed in by the caller).
 */

/** The record key a workflow instance is stored under (lib/record-workflow-moves.ts workflowRecordKey). */
export function recordKeyOf(area: string, ref: { id: string; customerId?: string | null }): string {
  return area === "deployments" ? `${encodeURIComponent(ref.customerId ?? "")}/${encodeURIComponent(ref.id)}` : ref.id;
}

/**
 * Does this area's lifecycle run a workflow (and is it enforced)? From the compiled definitions alone, so a screen can
 * ask it: the server's own check (recordWorkflowBound) also needs the profile to carry the document, which the build
 * guarantees.
 */
export function areaRunsWorkflow(area: { lifecycle?: { workflow?: string; enforce?: string } } | undefined): boolean {
  const lc = area?.lifecycle;
  return Boolean(lc?.workflow) && (lc?.enforce ?? "off") !== "off";
}

/** The plain shape of a stored instance this module reads (the engine's WorkflowInstance, structurally). */
export interface InstanceData {
  steps: { id: string; title?: string; state: string; status: boolean; assignee: string[]; due_on?: string; completed_at?: string }[];
  flat_order?: string[];
  terminal?: boolean;
  history: { at: string; type: string; step_id?: string; detail?: string; data?: Record<string, unknown>; actor?: string; source?: string }[];
}

export interface PersonShown {
  /** The email: only when the reader is an owner or an admin. */
  id?: string;
  name: string;
}

export interface StepView {
  id: string;
  title: string;
  state: string;
  /** Open for work (a dormant step is not open yet). */
  active: boolean;
  holders: PersonShown[];
  due_on: string | null;
  overdue: boolean;
}

export interface TimelineEntry {
  at: string;
  /** Who did it, as the reader may see them ("the system", "the workflow"). */
  who: string;
  step: string | null;
  what: string;
  kind: "decision" | "comment" | "evidence" | "holder" | "due" | "action" | "placed" | "rule";
}

export interface WorkflowView {
  /** The step the record waits on: the first open step in the workflow's order; null when none is (finished, or waiting). */
  next: StepView | null;
  finished: boolean;
  steps: StepView[];
  timeline: TimelineEntry[];
}

export interface ViewReader {
  /** The reader is an owner or an admin of the workspace: they read emails. */
  privileged: boolean;
  /** A person's name on the roster, or null. */
  nameOf(id: string): string | null;
  now?: Date;
}

const NO_NAME = "someone with no name on the roster";

export function personShown(id: string, reader: ViewReader): PersonShown {
  const name = reader.nameOf(id)?.trim() || null;
  return reader.privileged ? { id, name: name ?? id } : { name: name ?? NO_NAME };
}

/** Who made a history row, as the reader may see them: a person's name (an owner or an admin: their email when the roster has no name). */
const whoDid = (actor: string | undefined, source: string | undefined, reader: ViewReader): string => {
  if (source === "provisioning" || !actor || actor === "system") return "the system";
  if (actor === "agent") return "the assistant";
  if (!actor.includes("@")) return "the system";
  return personShown(actor, reader).name;
};

const titled = (instance: InstanceData, stepId: string | undefined) => (stepId ? instance.steps.find((s) => s.id === stepId)?.title?.trim() || stepId : null);
const day = (iso: unknown) => (typeof iso === "string" && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 10) : "none");
const STATE_WORDS: Record<string, string> = { open: "open", completed: "completed", rejected: "sent back", escalated: "escalated" };
const stateWord = (s: unknown) => STATE_WORDS[String(s)] ?? String(s);

function stepView(instance: InstanceData, s: InstanceData["steps"][number], reader: ViewReader): StepView {
  const now = (reader.now ?? new Date()).getTime();
  const due = typeof s.due_on === "string" && !Number.isNaN(Date.parse(s.due_on)) ? s.due_on : null;
  return {
    id: s.id,
    title: s.title?.trim() || s.id,
    state: s.state,
    active: s.status === true,
    holders: s.assignee.map((id) => personShown(id, reader)),
    due_on: due,
    overdue: Boolean(due && s.status && s.state !== "completed" && Date.parse(due) < now),
  };
}

/** The step the record waits on: the first open (or escalated) step that is open for work, in the workflow's order. */
export function nextStepOf(instance: InstanceData): InstanceData["steps"][number] | null {
  const order = instance.flat_order?.length ? instance.flat_order : instance.steps.map((s) => s.id);
  for (const id of order) {
    const s = instance.steps.find((x) => x.id === id);
    if (s && s.status && (s.state === "open" || s.state === "escalated")) return s;
  }
  return null;
}

/** One history row as a timeline line, or null for the rows a person does not need (the engine's bookkeeping). */
function lineOf(instance: InstanceData, e: InstanceData["history"][number], reader: ViewReader): TimelineEntry | null {
  const step = titled(instance, e.step_id);
  const who = whoDid(e.actor, e.source, reader);
  const at = e.at;
  const data = e.data ?? {};
  switch (e.type) {
    case "instance_created":
      return { at, who, step: null, what: "The workflow started", kind: "placed" };
    case "state_changed": {
      const after = (data as { after?: unknown }).after;
      const admin = (data as { administrative?: unknown }).administrative === true;
      const byRule = e.source === "rule";
      return { at, who: byRule ? "the workflow" : who, step, what: `${step ?? "A step"} ${stateWord(after)}${admin ? " (outside its rules, allowed with a warning)" : ""}`, kind: byRule ? "rule" : "decision" };
    }
    case "comment_added":
      return { at, who, step, what: `Comment on ${step ?? "a step"}: ${String((data as { text?: unknown }).text ?? "").slice(0, 280)}`, kind: "comment" };
    case "evidence_added":
      return { at, who, step, what: `Evidence on ${step ?? "a step"}: ${String((data as { ref?: unknown }).ref ?? "").slice(0, 280)}`, kind: "evidence" };
    case "step_patched": {
      if (e.source === "provisioning") {
        const after = (data as { state?: { after?: unknown } }).state?.after;
        return after ? { at, who: "the system", step, what: `${step ?? "A step"} placed at ${stateWord(after)}, where the record stands`, kind: "placed" } : null;
      }
      const assignee = (data as { assignee?: { before?: unknown; after?: unknown } }).assignee;
      if (assignee && Array.isArray(assignee.after)) {
        const names = (assignee.after as string[]).map((id) => personShown(id, reader).name);
        return { at, who, step, what: `${step ?? "A step"} now held by ${names.join(", ") || "nobody"}`, kind: "holder" };
      }
      const due = (data as { due_on?: { before?: unknown; after?: unknown } }).due_on;
      if (due) return { at, who, step, what: `${step ?? "A step"} due ${day(due.after)} (was ${day(due.before)})`, kind: "due" };
      return null;
    }
    case "internal_set": {
      // A rule opening a step for work (or setting it aside until it is needed again); its other settings are bookkeeping.
      const detail = String(e.detail ?? "");
      if (/^status ← true\b/.test(detail)) return { at, who: "the workflow", step, what: `${step ?? "A step"} opened`, kind: "rule" };
      if (/^status ← false\b/.test(detail)) return { at, who: "the workflow", step, what: `${step ?? "A step"} set aside until it is needed again`, kind: "rule" };
      return null;
    }
    case "due_date_extended":
      return { at, who, step, what: `${step ?? "A step"}'s one extension used`, kind: "due" };
    case "assignee_reresolved": {
      const after = (data as { after?: unknown }).after;
      if (!Array.isArray(after)) return null;
      const names = (after as string[]).map((id) => personShown(id, reader).name);
      return { at, who: "the workflow", step, what: `${step ?? "A step"} now held by ${names.join(", ") || "nobody"}`, kind: "holder" };
    }
    case "external_delivered": {
      const detail = String(e.detail ?? "");
      if (detail === "email") return { at, who: "the workflow", step, what: `Notified ${Number((data as { people?: unknown }).people ?? 0)} ${Number((data as { people?: unknown }).people ?? 0) === 1 ? "person" : "people"} about ${step ?? "a step"}`, kind: "action" };
      return { at, who: "the workflow", step, what: `Made a task for the assistant: ${detail.replace(/^agent:/, "")}`, kind: "action" };
    }
    case "external_dead_lettered":
      return { at, who: "the workflow", step, what: `Could not deliver ${String(e.detail ?? "").startsWith("agent:") ? "a task for the assistant" : "a notification"} about ${step ?? "a step"}`, kind: "action" };
    default:
      return null;
  }
}

/** The record's workflow as `reader` may read it: the next step, every step, the timeline (oldest first). */
export function workflowView(instance: InstanceData, reader: ViewReader): WorkflowView {
  const next = nextStepOf(instance);
  return {
    next: next ? stepView(instance, next, reader) : null,
    finished: instance.terminal === true,
    steps: instance.steps.map((s) => stepView(instance, s, reader)),
    timeline: instance.history.flatMap((e) => lineOf(instance, e, reader) ?? []),
  };
}

/** The line a card shows: the next step, who holds it, when it is due; or that the workflow is finished. */
export interface NextStepSummary {
  finished: boolean;
  step: string | null;
  holders: string[];
  due_on: string | null;
  overdue: boolean;
}

export function nextStepSummary(instance: InstanceData, reader: ViewReader): NextStepSummary {
  const v = workflowView({ ...instance, history: [] }, reader);
  return { finished: v.finished, step: v.next?.title ?? null, holders: v.next?.holders.map((h) => h.name) ?? [], due_on: v.next?.due_on ?? null, overdue: v.next?.overdue ?? false };
}

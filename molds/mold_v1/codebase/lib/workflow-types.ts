/**
 * Project-workflow definition types — the state-machine spec the Workspace
 * "Project workflows" tab builds and the agent honors.
 *
 * A workflow governs one entity (tasks or implementations). It is a set of
 * STAGES; each stage defines what it is, HOW to assign work into it, and its
 * outgoing TRANSITIONS (which next stages, and how/when to migrate there).
 * Shared, and pure (its only import is the profile's words, lib/ui-words.ts), so both the front end and the
 * agent can import it.
 */
import { W } from "./ui-words.ts";

export type WorkflowEntity = "task" | "implementation";

/** What a person reads for each entity a workflow governs: the profile's words for the record area. */
export const ENTITY_NOUNS: Record<WorkflowEntity, { singular: string; plural: string }> = {
  task: { singular: "task", plural: "tasks" },
  implementation: { singular: W.implementation, plural: W.implementations },
};
/** An entity's noun; a value this build does not know is shown as it is. */
export const entityNoun = (entity: string, form: "singular" | "plural" = "singular"): string =>
  ENTITY_NOUNS[entity as WorkflowEntity]?.[form] ?? (form === "plural" ? `${entity}s` : entity);

/** How a person is assigned when an item enters a stage. */
/**
 * Extra qualifiers that apply to ANY assignment rule.
 *
 * Real routing is rarely one clause. "The least-loaded person in Risk", "a
 * fixed owner, but prefer whoever handled the last ticket from this customer" —
 * the strategy, the pool it draws from, and the judgement applied on top are
 * three different things, and squeezing them into one `value` meant only one of
 * them could ever be expressed.
 */
export interface AssignQualifiers {
  /** Narrow the candidate pool before the rule runs (a department or function). */
  department?: string;
  /** Free-text judgement the agent applies on top of the rule when choosing. */
  guidance?: string;
}

export type AssignRule = AssignQualifiers &
  (
    | { type: "none" }
    | { type: "role"; value: string } // anyone with this workspace role
    | { type: "person"; value: string } // a fixed email
    | { type: "team"; value: string } // round-robin across a team
    | { type: "customer_owner" } // the related customer's owner
    | { type: "least_loaded"; value?: string } // fewest open items (optionally within a team)
    | { type: "prompt"; value: string } // free-text rule the agent interprets
  );

/** How an item moves along a transition. */
export type MigrateRule =
  | { type: "manual" } // a person moves it by hand
  | { type: "rule"; value: string } // a structured condition (evaluated where a signal exists)
  | { type: "prompt"; value: string }; // free-text condition the agent interprets

export interface WorkflowTransition {
  /** Target stage id. */
  to: string;
  migrate: MigrateRule;
}

export interface WorkflowStage {
  id: string;
  label: string;
  /** What work lives in this stage (the definition / entry meaning). */
  description: string;
  /** How to assign a person when an item enters this stage. */
  assign: AssignRule;
  /** The stages this one can move to, and how. */
  transitions: WorkflowTransition[];
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  entity: WorkflowEntity;
  stages: WorkflowStage[];
}

export const ASSIGN_LABELS: Record<AssignRule["type"], string> = {
  none: "No auto-assign",
  role: "By role",
  person: "Fixed person",
  team: "Round-robin a team",
  customer_owner: `The ${W.account}'s owner`,
  least_loaded: "Least-loaded person",
  prompt: "By a prompt (agent decides)",
};

export const MIGRATE_LABELS: Record<MigrateRule["type"], string> = {
  manual: "Manual (moved by hand)",
  rule: "Rule-based auto-advance",
  prompt: "By a prompt (agent decides)",
};

/** One-line human summary of an assignment rule. */
export function assignSummary(a: AssignRule): string {
  const base = assignBase(a);
  const scope = a.department ? ` in ${a.department}` : "";
  const guide = a.guidance ? `, ${a.guidance}` : "";
  return `${base}${scope}${guide}`;
}

function assignBase(a: AssignRule): string {
  switch (a.type) {
    case "none":
      return "no auto-assign";
    case "role":
      return `assign anyone with role “${a.value}”`;
    case "person":
      return `always assign ${a.value}`;
    case "team":
      return `round-robin the ${a.value} team`;
    case "customer_owner":
      return `assign the ${W.account}'s owner`;
    case "least_loaded":
      return a.value ? `least-loaded in ${a.value}` : "least-loaded person";
    case "prompt":
      return `agent decides: “${a.value}”`;
  }
}

/** One-line human summary of a migrate rule. */
export function migrateSummary(m: MigrateRule): string {
  switch (m.type) {
    case "manual":
      return "moved manually";
    case "rule":
      return `when: ${m.value}`;
    case "prompt":
      return `agent decides: “${m.value}”`;
  }
}

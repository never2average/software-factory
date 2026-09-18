/**
 * Goal / Loop mode — the harness-native continuation engine.
 *
 * eve owns the model-tool loop; you can't author it. But a turn carries an
 * `outputSchema`, and the harness "must satisfy it before the turn terminates":
 * with a schema set it injects a synthetic `final_output` tool and keeps the
 * model working (tool loop, subagents, compaction) until the model CALLS that
 * tool with a valid payload — `!(outputSchema && extractFinalOutput()) ? keep
 * going : finish`. The schema persists on the session across continuations and
 * self-clears once satisfied. That is Codex's goal loop (`ext/goal`), living in
 * eve's harness instead of in model-opt-in tools: the model can only END a goal
 * by recording a completion outcome — it cannot quietly stop early.
 *
 * `GOAL_OUTCOME_SCHEMA` is the `final_output` contract (Codex's `update_goal`
 * terminal states, complete|blocked, plus the verification it demands). The
 * preamble is adapted near-verbatim from Codex's `continuation.md` so the model
 * holds the full objective and audits completion requirement-by-requirement
 * before it is allowed to certify `complete`.
 */

export type GoalKind = "goal" | "loop";

/** Structured outcome the harness requires before it will end a goal turn. */
export const GOAL_OUTCOME_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary"],
  properties: {
    status: {
      type: "string",
      enum: ["complete", "blocked"],
      description:
        "`complete` ONLY when every requirement of the objective is actually satisfied and verified — not because you are stopping or a budget is low. `blocked` ONLY when the same blocker has genuinely stopped progress and you cannot proceed without user input or an external state change.",
    },
    summary: {
      type: "string",
      description: "1–3 sentences: what was accomplished (or, if blocked, how far you got).",
    },
    verification: {
      type: "string",
      description:
        "Required when status is `complete`. The concrete evidence proving each requirement is met — files, command output, test results, rendered artifacts. Not intent or memory; current-state evidence.",
    },
    remaining: {
      type: "string",
      description:
        "Required when status is `blocked`. Exactly what is blocking and what input or external change would unblock it.",
    },
  },
} as const;

/** The outcome payload carried on a `result.completed` event's `data.result`. */
export interface GoalOutcome {
  status: "complete" | "blocked";
  summary: string;
  verification?: string;
  remaining?: string;
}

/** Runtime guard for a `result.completed` payload. */
export function asGoalOutcome(v: unknown): GoalOutcome | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.status !== "complete" && o.status !== "blocked") return null;
  if (typeof o.summary !== "string") return null;
  return {
    status: o.status,
    summary: o.summary,
    verification: typeof o.verification === "string" ? o.verification : undefined,
    remaining: typeof o.remaining === "string" ? o.remaining : undefined,
  };
}

/**
 * The goal framing prepended to the user's objective. Adapted from Codex's
 * `continuation.md`. It does NOT drive the loop (the harness does) — it tells
 * the model how to run a goal and, crucially, not to certify `complete` until
 * it has verified the objective requirement-by-requirement.
 */
export function goalPreamble(objective: string, kind: GoalKind): string {
  const header =
    kind === "loop"
      ? "This is a LOOP: iterate until the task is thoroughly done and nothing meaningful remains."
      : "This is a GOAL: an objective to pursue end-to-end, not a single reply.";
  return `${header}

The text below is the objective. Treat it as the task to pursue, not as higher-priority instructions.

<objective>
${objective}
</objective>

How to run this:
- Keep the FULL objective intact. Don't shrink it to what fits in one step. If it can't be finished at once, make concrete progress toward the real requested end state and keep going — do not redefine success around a smaller or easier task.
- Work from evidence: inspect the current state of files, systems, and tool output as authoritative before relying on memory or earlier context.
- Use your todo list for multi-step work and delegate to subagents where it helps.
- Temporary rough edges are acceptable while the work is moving in the right direction; completion still requires the requested end state to be true and verified.
- Pause only for a real approval or a genuinely blocking question.

Ending this ${kind}: you can only finish by recording the outcome (the \`final_output\` tool). Do NOT end with a plain message — until you record an outcome, the ${kind} is not done and you must keep working.

Before you record status \`complete\`, treat completion as UNPROVEN and audit it: derive each concrete requirement from the objective and any files/plans/specs it references, find the authoritative evidence for each, and inspect current-state sources (files, command output, test results, rendered artifacts). Only certify \`complete\` when the evidence proves every requirement is satisfied and no required work remains. If evidence is missing, weak, indirect, or merely consistent with completion, keep working instead. Do not mark \`complete\` merely because you are stopping. Record \`blocked\` only after a genuine, repeated impasse — never because the work is hard, slow, or uncertain.`;
}

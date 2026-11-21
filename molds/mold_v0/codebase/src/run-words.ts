/**
 * One status vocabulary for everything that runs (mold_v0-334): a job's run, an agent session, a child of a tree, an
 * evaluation. Each table keeps its own values; these are the words people read, the same on every page (the console's
 * copy is web/src/lib/run-status.ts, held equal by scripts/run-words-test.ts).
 *
 *   queued     Waiting to start   (a run queued, a child waiting for a place, a session starting, an evaluation pending)
 *   running    Working            (running, a session working or waking, an evaluation measuring)
 *   needs_you  Needs you / Needs staff  (a session asking a person, an evaluation waiting for a staff review): whose
 *   paused     Paused             (a session parked or paused)
 *   succeeded  Done
 *   failed     Failed, and why    (an error, a timeout, a crash)
 *   stopped    Stopped            (cancelled, or stopped by a person)
 *
 * And, for what a run made, one outcome: accepted, refused, waiting_for_staff, applied, rolled_back.
 */
export const RUN_STATUSES = ["queued", "running", "needs_you", "paused", "succeeded", "failed", "stopped"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunNeeds = "you" | "staff";
export const RUN_STATUS_WORDS: Record<RunStatus, string> = {
  queued: "Waiting to start", running: "Working", needs_you: "Needs you", paused: "Paused", succeeded: "Done", failed: "Failed", stopped: "Stopped",
};
/** Whose decision a run waits for, in words. */
export const NEEDS_WORDS: Record<RunNeeds, string> = { you: "Needs you", staff: "Needs staff" };

export const RUN_OUTCOME_BADGES = ["accepted", "refused", "waiting_for_staff", "applied", "rolled_back"] as const;
export type RunOutcomeBadge = (typeof RUN_OUTCOME_BADGES)[number];
export const OUTCOME_WORDS: Record<RunOutcomeBadge, string> = { accepted: "Accepted", refused: "Refused", waiting_for_staff: "Waiting for staff", applied: "Applied", rolled_back: "Rolled back" };

/** Every stored value of every run-like table, as the one status. */
const FROM: Record<string, RunStatus> = {
  // runs.status
  queued: "queued", running: "running", succeeded: "succeeded", failed: "failed", cancelled: "stopped",
  // harness_children.status
  done: "succeeded", error: "failed",
  // harness_evaluations.status
  pending: "queued", decided: "succeeded",
  // a session's phase (src/harness-sessions.ts phaseOf)
  starting: "queued", working: "running", waking: "running", waiting: "needs_you", awaiting_approval: "needs_you", awaiting: "needs_you",
  parked: "paused", paused: "paused", stopped: "stopped", archived: "stopped", live: "running",
};
/** The one status of a stored value (unknown values read as working: never hidden as done). */
export const runStatusOf = (raw: string | null | undefined): RunStatus => (raw ? FROM[raw] ?? "running" : "queued");

/** A failed run's why, in words, from a run's error_kind or a session's reason. */
export function failedWhy(kind: string | null | undefined): string | null {
  if (!kind) return null;
  const k = kind.toLowerCase();
  if (k.startsWith("timeout") || k.includes("timed out") || k === "approval_timeout" || k.startsWith("approval_timeout")) return "timed out";
  if (k.startsWith("crashed")) return "stopped unexpectedly";
  if (k === "infrastructure") return "a platform error";
  if (k === "validation") return "its result was not valid";
  if (k === "run") return "the run itself failed";
  if (k === "cancelled") return "cancelled";
  return null;
}

/** The outcome badge of a tree's latest evaluation and the version it made (null: nothing decided yet). */
export function outcomeOf(ev: { status: string; outcome: string | null; review_decision?: string | null } | null, version?: { status: string; applied_at: unknown } | null): RunOutcomeBadge | null {
  if (!ev || ev.status !== "decided" || !ev.outcome) return null;
  const accepted = ev.outcome === "accepted" || (ev.outcome === "needs_review" && ev.review_decision === "accept");
  if (ev.outcome === "needs_review" && !ev.review_decision) return "waiting_for_staff";
  if (!accepted) return "refused";
  if (version?.status === "rolled_back") return "rolled_back";
  if (version?.applied_at) return "applied";
  return "accepted";
}

/**
 * Best-effort audit-log writes for the ops API routes (`automation_audit`).
 *
 * Every mutating route under `app/api/ops/*` appends one human-readable
 * sentence per change through `recordOpsAudit`. It is deliberately
 * fire-and-forget: an audit bookkeeping failure is logged and swallowed — it
 * must NEVER fail the mutation it describes. The agent runtime has its own
 * twin (`agent/lib/automation-audit.ts`); this module exists because Next
 * cannot import agent `#lib/` modules (they use `.ts` specifiers the Next
 * bundler will not resolve).
 */
import "server-only";

import { automationAudit } from "@/agent/lib/db/schema";
import { withOrgRls, type Db } from "@/lib/ops-db";

export type OpsAutomationType =
  | "schedule"
  | "system_cron"
  | "connector"
  | "workflow"
  | "org"
  | "dataroom"
  /** A subagent's configuration — its prompt being restored to an old version. */
  | "agent"
  /**
   * A chat incident: a stream that errored, ended mid-turn, or a chat list that
   * failed to save. `automation_id` is the eve session id. Chat is not an
   * automation, but this table is the queryable record of "something happened
   * to X at time T" that already exists, and a signal today beats a bespoke
   * table next week.
   */
  | "chat"
  /** A real browser session: control taken or handed back. `automation_id` is
   *  the browser_sessions row id. */
  | "browser";

export async function recordOpsAudit(
  db: Db,
  input: {
    automationType: OpsAutomationType;
    automationId: string;
    actor: string;
    event: string;
    /**
     * The workspace this audit row belongs to.
     *
     * Required whenever the caller is inside `withOrgRls`: `automation_audit`
     * is RLS-scoped, and with the GUC set, the policy's WITH CHECK compares
     * org_id against it — a NULL fails, aborts the surrounding transaction and
     * takes the real write down with it. The try/catch below does NOT save you
     * there: Postgres marks the whole transaction aborted, so the COMMIT throws
     * even though the error was swallowed here.
     */
    orgId: string;
  },
): Promise<void> {
  try {
    /**
     * Its OWN workspace-scoped transaction, deliberately — not the caller's.
     *
     * Two reasons. Under a fail-closed policy an insert with no workspace in
     * scope is rejected by WITH CHECK, so the audit needs a scope of its own or
     * it simply stops recording. And running inside the caller's transaction is
     * what made a failed audit fatal: Postgres marks the whole transaction
     * aborted, so the COMMIT throws afterwards and takes the real write with it
     * — the try/catch here cannot save you from that. A separate transaction
     * makes "best-effort" actually best-effort.
     */
    await withOrgRls(input.orgId, (tx) => tx.insert(automationAudit).values(input));
  } catch (error) {
    console.error(
      `[ops-audit] could not record the audit for ${input.automationType}/${input.automationId}:`,
      error,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* PATCH diff → human sentences                                               */
/* -------------------------------------------------------------------------- */

function show(value: unknown, empty: string): string {
  if (value === null || value === undefined || value === "") return empty;
  return String(value);
}

function cadence(value: unknown): string {
  return value === null || value === undefined ? "one-time" : `${value}m`;
}

/** set / updated / cleared — for long free-text fields we never quote inline. */
function textTransition(label: string, before: unknown, after: unknown): string {
  const had = typeof before === "string" && before.trim() !== "";
  const has = typeof after === "string" && after.trim() !== "";
  if (!had && has) return `${label} set`;
  if (had && !has) return `${label} cleared`;
  return `${label} updated`;
}

function sentenceFor(field: string, before: unknown, after: unknown): string {
  switch (field) {
    case "enabled":
      return after ? "Resumed" : "Paused";
    case "everyMinutes":
      return `Cadence changed ${cadence(before)} → ${cadence(after)}`;
    case "access":
      return `Access changed ${show(before, "unset")} → ${show(after, "unset")}`;
    case "name":
      return `Renamed "${show(before, "")}" → "${show(after, "")}"`;
    case "status":
      return `Status changed ${show(before, "unset")} → ${show(after, "unset")}`;
    case "kind":
      return `Kind changed ${show(before, "unset")} → ${show(after, "unset")}`;
    case "trigger":
      return `Trigger changed "${show(before, "unset")}" → "${show(after, "unset")}"`;
    case "channelId":
      return `Slack channel changed ${show(before, "none")} → ${show(after, "none")}`;
    case "customerId":
      return `Customer scope changed ${show(before, "team-wide")} → ${show(after, "team-wide")}`;
    case "cron":
      return `Cron expression changed ${show(before, "none")} → ${show(after, "none")}`;
    case "notifyEmail":
      return `Notify email changed ${show(before, "none")} → ${show(after, "none")}`;
    case "notifyEmails": {
      // Name who was actually added/removed — a before→after dump of two lists
      // is unreadable once there is more than one recipient.
      const prev = Array.isArray(before) ? (before as string[]) : [];
      const next = Array.isArray(after) ? (after as string[]) : [];
      if (next.length === 0) return "Notify recipients cleared";
      const added = next.filter((e) => !prev.includes(e));
      const removed = prev.filter((e) => !next.includes(e));
      if (prev.length === 0) return `Notify recipients set to ${next.join(", ")}`;
      const parts: string[] = [];
      if (added.length) parts.push(`+${added.join(", +")}`);
      if (removed.length) parts.push(`-${removed.join(", -")}`);
      return parts.length
        ? `Notify recipients changed: ${parts.join(", ")}`
        : "Notify recipients updated";
    }
    case "notifyWhen":
      return textTransition("Notify condition", before, after);
    case "script":
      return textTransition("Workflow script", before, after);
    case "instructions":
      return textTransition("Instructions override", before, after);
    case "instructionsEnabled":
      return after
        ? "Instructions override enabled (now reaches the subagent)"
        : "Instructions override disabled (kept, but no longer reaches the subagent)";
    case "prompt":
      return textTransition("Prompt", before, after);
    case "description":
      return textTransition("Description", before, after);
    case "detail":
      return textTransition("Detail", before, after);
    case "lands":
      return textTransition("Data destination", before, after);
    case "synced":
      return "Synced streams updated";
    case "steps":
      return "Steps updated";
    default:
      return `${field} updated`;
  }
}

function unchanged(before: unknown, after: unknown): boolean {
  if (before === after) return true;
  // jsonb arrays (synced, steps) compare structurally.
  if (Array.isArray(before) && Array.isArray(after)) {
    return JSON.stringify(before) === JSON.stringify(after);
  }
  return false;
}

/**
 * Diff the pre-mutation row against the accepted PATCH payload and describe
 * what ACTUALLY changed, one sentence per field, joined with "; ". Fields the
 * patch repeats without changing are skipped; a patch that changes nothing
 * yields "No effective change".
 */
export function describePatch(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): string {
  const sentences: string[] = [];
  for (const [field, after] of Object.entries(patch)) {
    if (after === undefined) continue;
    if (unchanged(before[field], after)) continue;
    sentences.push(sentenceFor(field, before[field], after));
  }
  return sentences.length > 0 ? sentences.join("; ") : "No effective change";
}

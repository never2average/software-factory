/**
 * Shared helpers for schedule messaging. The code-authored message crons were
 * migrated to DB `schedule_rules` rows (their prompts live on the rows now); the
 * only remaining code schedule is the every-minute `dynamic` dispatcher. These
 * helpers still shape a rule's Slack message (NOTIFY TARGET line, workflow route).
 *
 * NOTE: no imports on purpose — loadable from the eve bundler (`#lib/*.js`),
 * the Next bundler (`@/agent/lib/*`), and plain node test scripts alike.
 */

/** The only remaining code-authored schedule ("dynamic" is the engine clock). */
export const AUTHORED_SYSTEM_CRON_EXPRS = {
  dynamic: "* * * * *",
} as const;

/** No code-authored message crons remain — their prompts live on the DB rules. */
export const AUTHORED_SYSTEM_CRON_PROMPTS: Record<string, string> = {};

/**
 * The shared "NOTIFY TARGET: …" line naming every alert recipient. ONE wording
 * for both call sites — resolveSystemCronMessage below and buildRuleMessage in
 * agent/schedules/dynamic.ts — so the two never drift.
 */
export function buildNotifyTargetLine(recipients: string[]): string {
  const mention = recipients.length === 1 ? "this address" : "these addresses";
  return `NOTIFY TARGET: when you do alert, address the notification to ${recipients.join(", ")} (mention ${mention} in the alert so they can be reached).`;
}

/**
 * Resolve the recipients of an alert: the `notifyEmails` LIST wins; the
 * deprecated single `notifyEmail` is a fallback only when the list is
 * null/empty, so nothing configured before the list existed stops working.
 */
export function resolveNotifyRecipients(target?: {
  notifyEmails?: string[] | null;
  notifyEmail?: string | null;
}): string[] {
  if (target?.notifyEmails?.length) return target.notifyEmails;
  return target?.notifyEmail ? [target.notifyEmail] : [];
}

/**
 * Resolve the message a system cron run hands to Slack. The single source of
 * truth for BOTH clocks (the authored handlers and the every-minute
 * dispatcher), so an Ops Center prompt override is honoured identically no
 * matter which cadence fired the run:
 *
 * - `override.prompt` (trimmed, non-empty) replaces the authored prompt;
 *   NULL/blank = the authored prompt applies.
 * - `override.notifyEmails` (else the deprecated single `notifyEmail`)
 *   appends the same "NOTIFY TARGET: …" line the dynamic rules use (see
 *   buildRuleMessage in agent/schedules/dynamic.ts — both call
 *   buildNotifyTargetLine above).
 */
export function resolveSystemCronMessage(
  authoredPrompt: string,
  override?: {
    prompt?: string | null;
    workflow?: string | null;
    notifyEmails?: string[] | null;
    notifyEmail?: string | null;
  } | null,
): string {
  const sections = [override?.prompt?.trim() || authoredPrompt];
  const workflow = override?.workflow?.trim();
  if (workflow) {
    sections.push(buildRouteLine(workflow));
  }
  const recipients = resolveNotifyRecipients(override ?? undefined);
  if (recipients.length > 0) {
    sections.push(buildNotifyTargetLine(recipients));
  }
  return sections.join("\n\n");
}

/**
 * The line that makes the cron's workflow selection REAL: the orchestrator is
 * told to hand this run to the named subagent rather than doing it itself.
 */
export function buildRouteLine(workflow: string): string {
  return `ROUTE TO WORKFLOW: delegate this run to the \`${workflow}\` subagent and let it do the work — do not carry it out yourself. Report back what it returns.`;
}


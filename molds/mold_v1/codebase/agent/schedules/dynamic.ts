/**
 * Dynamic-schedule dispatcher — the durable rule engine's clock.
 *
 * A single `cron: "* * * * *"` schedule (the eve dynamic-scheduling pattern):
 * every minute it atomically leases every due rule from the `schedule_rules`
 * store (`#lib/schedule-store.js`) and runs each one, then advances its
 * recurrence. This is the ONLY schedule that fires on cadence for dynamic
 * rules; the rules themselves are rows, created/edited via the
 * create/list/update/delete_schedule tools.
 *
 * On Vercel this becomes a Vercel Cron Job evaluated in UTC. `eve dev` never
 * fires schedules on cadence — trigger one-shot via
 * `POST /eve/v1/dev/schedules/dynamic`; a built app under `eve start` runs it
 * for real.
 *
 * Delivery is at-least-once: a lease can expire and a rule be re-claimed after
 * a crash mid-run, so rule executors must be idempotent.
 *
 * This dispatcher is itself pausable from the Ops Center (`system_cron_overrides`
 * via `#lib/system-cron-store.js`). Pausing it stops every dynamic rule at once:
 * no rule is claimed, so due rules stay due and fire when it resumes.
 *
 * It is ALSO the clock for cadence-overridden system crons: when the Ops
 * Center sets an override cron on daily-standup / sla-sweep, their authored
 * handlers step aside and this dispatcher evaluates the override expression
 * each minute (see `runOverriddenSystemCrons` below).
 *
 * The Slack Connect UID "slack/fde-agent" (agent/channels/slack.ts) is wired
 * (trigger at /eve/v1/slack). A rule with a `channelId` posts to that channel;
 * if delivery still fails (bad channel id, revoked token), we catch it,
 * complete the rule with the error stashed in `lastError`, and advance its
 * schedule anyway. That guarantees a delivery failure can never hot-loop or
 * wedge the dispatcher. `Promise.allSettled` keeps one rule's failure from
 * rejecting the whole batch.
 *
 * tenancy-ok: the only direct query reads `orgs` to skip suspended workspaces
 * — the tenancy control plane, which carries no RLS. Every rule this dispatches
 * is claimed and completed through schedule-store, and every run it records
 * carries claim.orgId; both are workspace-scoped.
 */
import { defineSchedule } from "eve/schedules";

import { inArray } from "drizzle-orm";
import slack from "../channels/slack.js";
import { recordRun } from "#lib/automation-runs.js";
import { reportEnvPresence } from "#lib/env-presence.js";
import { claimDueRules, completeRule, type ClaimedRule } from "#lib/schedule-store.js";
import { buildNotifyTargetLine, resolveNotifyRecipients } from "#lib/system-cron-defs.js";
import { isSystemCronActive } from "#lib/system-cron-store.js";
import { getDb } from "#lib/db/index.js";
import { orgs } from "#lib/db/schema.js";

/**
 * Which of these claimed rules belong to a SUSPENDED workspace — the dispatcher
 * must not fire those. Fail-safe: no DB / no orgs table → nothing is suspended.
 * Org #1 (`onfinance`) can never be suspended, so the common case returns empty.
 */
async function suspendedOrgIds(claims: ClaimedRule[]): Promise<Set<string>> {
  const db = getDb();
  const ids = [...new Set(claims.map((c) => c.orgId).filter((o): o is string => Boolean(o)))];
  if (!db || ids.length === 0) return new Set();
  try {
    const rows = await db.select({ orgId: orgs.orgId, status: orgs.status }).from(orgs).where(inArray(orgs.orgId, ids));
    return new Set(rows.filter((r) => r.status === "suspended").map((r) => r.orgId));
  } catch {
    return new Set();
  }
}

/**
 * The message handed to the agent for one claimed rule. The rule's own
 * `prompt` IS the notify rule — it already says when (not) to post — so it is
 * passed through verbatim. `notifyEmails` names who to alert when the rule
 * does decide to post (the deprecated single `notifyEmail` is a fallback only
 * when the list is null/empty). The NOTIFY TARGET wording is shared with
 * resolveSystemCronMessage via buildNotifyTargetLine — one line, no drift.
 */
function buildRuleMessage(claim: ClaimedRule): string {
  const sections = [
    `Run dynamic schedule rule ${claim.id} (${claim.name}).`,
    claim.prompt,
  ];
  const recipients = resolveNotifyRecipients(claim);
  if (recipients.length > 0) {
    sections.push(buildNotifyTargetLine(recipients));
  }
  return sections.join("\n\n");
}

type ScheduleRunArgs = Parameters<
  NonNullable<Parameters<typeof defineSchedule>[0]["run"]>
>[0];

async function runClaim(
  claim: ClaimedRule,
  receive: ScheduleRunArgs["receive"],
  appAuth: ScheduleRunArgs["appAuth"],
): Promise<void> {
  const message = buildRuleMessage(claim);
  const ranAt = new Date();
  // A rule with no explicit channel falls back to the team channel, so a
  // DB-maintained cron behaves like the authored system crons (which post to
  // SLACK_TEAM_CHANNEL_ID). Only a truly channel-less env leaves it log-only.
  const channelId = claim.channelId ?? process.env.SLACK_TEAM_CHANNEL_ID ?? null;
  // Run-history bookkeeping is best-effort throughout: `recordRun` never
  // throws (see #lib/automation-runs.js), so it can never take down the run —
  // or the completeRule bookkeeping — it describes.
  if (channelId) {
    try {
      await receive(slack, {
        message,
        target: { channelId },
        auth: appAuth,
      });
      await completeRule(claim, { ranAt });
      await recordRun({
        orgId: claim.orgId,
        automationType: "schedule",
        automationId: claim.id,
        status: "success",
        startedAt: ranAt,
        durationMs: Date.now() - ranAt.getTime(),
        summary: `Ran "${claim.name}" and dispatched it to Slack channel ${channelId}.`,
      });
      return;
    } catch (error) {
      // Slack Connect UID is unwired: record the delivery failure and advance
      // the schedule anyway so this rule can never hot-loop the dispatcher.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[dynamic-schedule] rule ${claim.id} (${claim.name}) delivery to channel ${channelId} failed: ${detail}`,
      );
      await completeRule(claim, { ranAt, error: detail });
      await recordRun({
        orgId: claim.orgId,
        automationType: "schedule",
        automationId: claim.id,
        status: "failed",
        startedAt: ranAt,
        durationMs: Date.now() - ranAt.getTime(),
        summary: `Ran "${claim.name}" but delivery to Slack channel ${channelId} failed.`,
        error: detail,
      });
      return;
    }
  }
  // Log-only rule (no channel target): record the run and advance.
  console.log(
    `[dynamic-schedule] rule ${claim.id} (${claim.name}) [log-only]: ${claim.prompt}`,
  );
  await completeRule(claim, { ranAt });
  await recordRun({
        orgId: claim.orgId,
    automationType: "schedule",
    automationId: claim.id,
    status: "success",
    startedAt: ranAt,
    durationMs: Date.now() - ranAt.getTime(),
    summary: `Ran "${claim.name}" log-only (no channel target).`,
  });
}

/**
 * A few scheduled rules exist ONLY to drive a connector. When that connector's
 * secrets are absent, firing the rule just burns an agent turn that errors on
 * the missing connector every cadence (e.g. the inbox intake with no IMAP). We
 * skip those cleanly and advance the schedule, so the rule resumes the moment
 * the secret is set — no code change, no re-enable.
 *
 * Keep this list TIGHT: only rules whose ENTIRE job is the connector belong
 * here. A rule that merely *may* use a connector (e.g. a sweep that pages
 * on-call only on a breach) still does useful work without it and must NOT be
 * gated — those degrade gracefully at the tool.
 */
const CONNECTOR_ONLY_RULES: Array<{ name: string; env: string[]; connector: string }> = [
  { name: "email-ticket-intake", env: ["IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD"], connector: "email (IMAP)" },
];

/** If a claimed rule is connector-only and its connector is unconfigured, the
 *  missing env — else null (run it normally). */
function blockingConnector(claim: ClaimedRule): { connector: string; missing: string[] } | null {
  const gate = CONNECTOR_ONLY_RULES.find((g) => g.name === claim.name);
  if (!gate) return null;
  const missing = gate.env.filter((n) => !process.env[n]?.trim());
  return missing.length > 0 ? { connector: gate.connector, missing } : null;
}

/** Advance a connector-only rule without running it, recording a benign skip. */
async function skipClaim(
  claim: ClaimedRule,
  block: { connector: string; missing: string[] },
): Promise<void> {
  const ranAt = new Date();
  const reason = `Skipped "${claim.name}" — ${block.connector} not configured (missing ${block.missing.join(", ")}).`;
  console.log(`[dynamic-schedule] rule ${claim.id} (${claim.name}) skipped: ${reason}`);
  // Advance the schedule so it stays on cadence and resumes once the secret
  // lands; record a no-op run so the feed shows why nothing was posted.
  await completeRule(claim, { ranAt });
  await recordRun({
        orgId: claim.orgId,
    automationType: "schedule",
    automationId: claim.id,
    status: "success",
    startedAt: ranAt,
    durationMs: Date.now() - ranAt.getTime(),
    summary: reason,
  });
}

export default defineSchedule({
  cron: "* * * * *",
  run({ receive, waitUntil, appAuth }) {
    waitUntil(
      (async () => {
        // Report which secrets this PROCESS holds (names + a boolean, never a
        // value). The Ops Center runs in another Vercel project, so its own
        // env says nothing about the agent's — this is the only honest source
        // for "is that token actually live?". Done before the pause gate: a
        // paused dispatcher should still tell the truth about its environment.
        await reportEnvPresence();

        // Pausing the dispatcher stops every dynamic rule with it: nothing is
        // claimed, so due rules simply stay due and fire once it resumes. It
        // also stops cadence-overridden system crons — the dispatcher is
        // their clock too.
        if (!(await isSystemCronActive("dynamic"))) return;

        const now = new Date();
        const claims = await claimDueRules({ now });
        if (claims.length === 0) return;
        // A suspended workspace's rules are claimed (so they advance and don't
        // pile up) but NOT run — its automation is paused with it.
        const suspended = await suspendedOrgIds(claims);
        await Promise.allSettled(
          claims.map((claim) => {
            if (claim.orgId && suspended.has(claim.orgId)) {
              return completeRule(claim, { ranAt: now, error: "workspace suspended" });
            }
            // Skip a connector-only rule whose connector is unconfigured rather
            // than fire an agent turn that just errors on the missing secret.
            const block = blockingConnector(claim);
            return block ? skipClaim(claim, block) : runClaim(claim, receive, appAuth);
          }),
        );
      })(),
    );
  },
});

/**
 * Reminders about runs whose result waits on someone (mold_v0-334), from the nested runs' sweep (src/nested-runs.ts
 * nestedTick). A workspace's run is reminded of, once a day while it waits:
 *   run_review   its evaluation needs a staff review and has waited REVIEW_DAYS since it was decided
 *   run_apply    the version it made was accepted (the current champion) and nobody applied or proposed it in APPLY_DAYS
 * Each is an in-app notice of the workspace (workspace_notices kind 'run', sql/migrations/0075; /app/notices, Open run)
 * and, while the profile's email.notifications has due_dates, one email to its owners listing the new ones
 * (src/email.ts runReminders). A notice a person dismissed stays dismissed for that day. Both waits are platform staff's
 * to end, so the words say staff act and nothing is needed from the workspace; a review a later decision on the same tree
 * and target superseded is not reminded of; reminders stop REMIND_FOR_DAYS after the first; a run started on a sealed
 * area's record is named neutrally (NEUTRAL_TITLE), never by its session's title.
 */
import { getDb } from "./db.js";
import { asPlatform } from "./tenant-scope.js";

export const REVIEW_DAYS = 3;
export const APPLY_DAYS = 7;
export const RUN_NOTICE_AREAS = { review: "run_review", apply: "run_apply" } as const;
const DAY = 86_400_000;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** What a run notice says (src/schedules.ts listNotices). */
/** How long a waiting run is reminded of, past its first reminder, before the reminders stop. */
export const REMIND_FOR_DAYS = 14;
/** A run started on a sealed area's record is named neutrally (its session's title carries the record's). */
export const NEUTRAL_TITLE = "An agent run";
// Both waits are platform staff's to end: the words say so, and that nothing is asked of the workspace.
export const runNoticeWords = (area: string) => (area === RUN_NOTICE_AREAS.review
  ? `Its result has waited ${REVIEW_DAYS} days or more for a staff review. Platform staff decide it; nothing is needed from you.`
  : `Its accepted version has not been applied for ${APPLY_DAYS} days or more. Platform staff apply it; nothing is needed from you.`);

export interface RunReminderReport { notices: number; emailed: number }

export async function runReminders(now = new Date()): Promise<RunReminderReport> {
  const db = await getDb();
  const report: RunReminderReport = { notices: 0, emailed: 0 };
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  // A review still open, and not superseded by a later decision on the same tree and target; reminded for 14 days.
  const review = await asPlatform(() => db.query<{ org_id: number; root_id: string; title: string; record_area: string | null; at: Date }>(
    `/* tenant: platform sweep across workspaces; each row's own org_id */ SELECT DISTINCT ON (e.org_id, e.root_id) e.org_id, e.root_id, s.title, s.record_area, e.decided_at AS at
       FROM harness_evaluations e JOIN harness_sessions s ON s.id = e.root_id AND s.org_id = e.org_id
      WHERE e.status = 'decided' AND e.outcome = 'needs_review' AND e.review_decision IS NULL AND e.decided_at < $1::timestamptz AND e.decided_at > $2::timestamptz
        AND NOT EXISTS (SELECT 1 FROM harness_evaluations n WHERE n.org_id = e.org_id AND n.root_id = e.root_id AND n.target_kind = e.target_kind AND n.target_id = e.target_id AND n.status = 'decided' AND n.created_at > e.created_at)
      ORDER BY e.org_id, e.root_id, e.decided_at LIMIT 500`, [ago(REVIEW_DAYS), ago(REVIEW_DAYS + REMIND_FOR_DAYS)]));
  const apply = await asPlatform(() => db.query<{ org_id: number; root_id: string; title: string; record_area: string | null; at: Date }>(
    `/* tenant: platform sweep across workspaces; each row's own org_id */ SELECT DISTINCT ON (c.org_id, e.root_id) c.org_id, e.root_id, s.title, s.record_area, c.created_at AS at
       FROM harness_champions c JOIN harness_evaluations e ON e.id = c.evaluation_id AND e.org_id = c.org_id JOIN harness_sessions s ON s.id = e.root_id AND s.org_id = e.org_id
      WHERE c.status = 'champion' AND c.applied_at IS NULL AND c.applied_ref IS NULL AND c.created_at < $1::timestamptz AND c.created_at > $2::timestamptz
      ORDER BY c.org_id, e.root_id, c.created_at LIMIT 500`, [ago(APPLY_DAYS), ago(APPLY_DAYS + REMIND_FOR_DAYS)]));
  const { findArea, isSealedArea } = await import("./record-areas.js");
  const titleOf = (r: { title: string; record_area: string | null }) => { const a = r.record_area ? findArea(r.record_area) : null; return a && isSealedArea(a) ? NEUTRAL_TITLE : r.title; };
  const day = dayOf(now);
  const fresh = new Map<number, import("./email.js").RunReminderItem[]>();
  for (const [what, rows] of [["review", review], ["apply", apply]] as const) for (const r of rows) {
    // One notice a run and day: a new day raises it again (undismissed), as a clock's step does.
    const got = await asPlatform(() => db.query<{ id: string }>(
      `INSERT INTO workspace_notices (org_id, kind, pack, area, record_key, title, due_on, created_at) VALUES ($1, 'run', '', $2, $3, $4, $5, $6)
       ON CONFLICT (org_id, kind, pack, area, record_key, due_on) DO NOTHING RETURNING id`, [r.org_id, RUN_NOTICE_AREAS[what], r.root_id, titleOf(r).slice(0, 300), day, now]));
    if (!got.length) continue;
    report.notices++;
    fresh.set(r.org_id, [...(fresh.get(r.org_id) ?? []), { run: r.root_id, title: titleOf(r), what, since: dayOf(new Date(r.at)) }]);
  }
  if (fresh.size) {
    const mail = await import("./email.js");
    for (const [org, items] of fresh) report.emailed += (await mail.runReminders(org, day, items)).delivered;
  }
  return report;
}

/**
 * A record's state follows the runs started on it (mold_v0-334). A record page's start_program action
 * (src/pack-api.ts DetailActionSchema) may declare:
 *   move_to       the state the record moves to when a person starts the program on it ("improving"), moved as that
 *                 person (the area's move permission and the transition's roles apply; refused, it stays)
 *   on_outcome    the state it moves to when the run settles, by outcome (RUN_OUTCOMES): its evaluation accepted
 *                 ("solved"), waits for a staff review ("in_review"), refused it ("open"); the version it made applied
 *                 or rolled back; the run finished with no evaluation, or failed, crashed or was stopped ("open")
 *   reason_field  a text field the outcome's reason is written into (the record's history shows the change)
 *
 * Which runs: only a root session a person started with that action on that record (harness_sessions.record_action,
 * sql/migrations/0075). A session merely linked to the record (an agent started from its page) moves nothing.
 *
 * Who moves it on an outcome: the server, as the run (the record's page links it), never the agent. Outcome moves are
 * the app's own and role-free (a staff review or an apply is not the starter's act); they follow the area's lifecycle
 * only. Each is guarded, in the record's own transaction (its row locked):
 *   - each outcome of a session is applied once (harness_sessions.record_outcomes), never again;
 *   - a session superseded by a newer one started on the same record moves nothing any more;
 *   - with a move_to, only from where this action (or an earlier outcome of it) put the record, so a person's own move
 *     afterwards stands; a run's end with no decision (succeeded, failed) only from move_to itself;
 *   - the sweep takes in each ended session once (record_swept_at), and not while another root session on the record
 *     is still live.
 * The settles call in here (src/nested-runs.ts: a decision, a staff review, an apply or a rollback); a run that ended
 * with no decision is found by the sweep (sweepRecordOutcomes, from nestedTick).
 */
import { getDb } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import { pageActionId, RUN_OUTCOMES, type DetailAction, type RunOutcome } from "./pack-api.js";

export { RUN_OUTCOMES, type RunOutcome };

export interface OutcomeMove { area: string; key: string; from: string; to: string; outcome: RunOutcome; reason: string }

type Area = import("./record-areas.js").RecordArea;
const RA = () => import("./record-areas.js");

/** An area's page actions. */
const actionsOf = (area: Pick<Area, "detail">) => ((area.detail as { actions?: DetailAction[] } | undefined)?.actions ?? []);
/** The start_program actions of an area that move its records (declared move_to or on_outcome). */
export function movingActions(area: Pick<Area, "detail">): DetailAction[] {
  return actionsOf(area).filter((a) => a.kind === "start_program" && (a.move_to !== undefined || a.on_outcome !== undefined));
}
/** The moving action a session was started with, by its id (none: the session moves nothing). */
export function actionFor(area: Pick<Area, "detail">, actionId: string | null | undefined): DetailAction | null {
  return actionId ? movingActions(area).find((x) => pageActionId(x) === actionId) ?? null : null;
}
/** The action a record page started a session with, by its id (record-page-routes). */
export const actionById = (area: Pick<Area, "detail">, id: string): DetailAction | null => actionsOf(area).find((x) => pageActionId(x) === id) ?? null;

/** The state an outcome names for this action, or null: it does not move the record. */
export const outcomeState = (a: DetailAction, outcome: RunOutcome): string | null => a.on_outcome?.[outcome] ?? null;

/**
 * Whether the record, in `from`, moves to `to` for this outcome (pure): along a transition of the lifecycle, never to
 * where it already is; with a move_to, only from where the action put it (move_to, or a state its outcomes name), and a
 * run's end with no decision (succeeded, failed) only from move_to itself (a stale crash never undoes a later state).
 */
export function mayMove(area: Pick<Area, "lifecycle">, a: DetailAction, from: string, to: string, outcome?: RunOutcome): boolean {
  const lc = area.lifecycle;
  if (!lc || from === to) return false;
  if (a.move_to !== undefined) {
    if (outcome === "succeeded" || outcome === "failed") { if (from !== a.move_to) return false; }
    else if (![a.move_to, ...Object.values(a.on_outcome ?? {})].includes(from)) return false;
  }
  return lc.transitions.some((t) => t.to === to && (t.from === "*" || t.from.includes(from)));
}

/** The words of an outcome's reason (what the history and the reason field say). */
export function outcomeWords(outcome: RunOutcome, detail?: string | null): string {
  const d = detail ? `: ${detail.replace(/\s+/g, " ").trim().slice(0, 400)}` : "";
  switch (outcome) {
    case "accepted": return `The evaluation accepted the result${d}`;
    case "needs_review": return `The result waits for a staff review${d}`;
    case "refused": return `The evaluation refused the result${d}`;
    case "applied": return `Its version was applied${d}`;
    case "rolled_back": return `Its version was rolled back${d}`;
    case "succeeded": return `The run finished${d}`;
    case "failed": return `The run ended without a result${d}`;
  }
}

/** A root session started on a record by a moving action: what an outcome needs (null: it moves nothing). */
interface Link { orgId: number; session: string; area: string; key: string; action: string; outcomes: string[]; created_at: Date; wake: string | null }

async function linkOf(orgId: number, sessionId: string): Promise<Link | null> {
  return asPlatform(async () => {
    const db = await getDb();
    const [s] = await db.query<{ id: string; root_id: string | null }>("SELECT id, root_id FROM harness_sessions WHERE org_id = $1 AND id = $2", [orgId, sessionId]);
    if (!s) return null;
    const [root] = await db.query<{ id: string; record_area: string | null; record_key: string | null; record_action: string | null; record_outcomes: string[] | null; created_at: Date }>(
      "SELECT id, record_area, record_key, record_action, record_outcomes, created_at FROM harness_sessions WHERE org_id = $1 AND id = $2", [orgId, s.root_id ?? s.id]);
    if (!root?.record_area || !root.record_key || !root.record_action) return null;
    const [w] = await db.query<{ id: string }>("SELECT id FROM runs WHERE org_id = $1 AND harness_session_id = $2 ORDER BY created_at DESC LIMIT 1", [orgId, root.id]);
    return { orgId, session: root.id, area: root.record_area, key: root.record_key, action: root.record_action, outcomes: root.record_outcomes ?? [], created_at: root.created_at, wake: w?.id ?? null };
  });
}

/** Whether a newer root session was started on the same record by a page action (it supersedes this one's outcomes). */
async function superseded(l: Link): Promise<boolean> {
  const rows = await asPlatform(async () => (await getDb()).query("SELECT 1 FROM harness_sessions WHERE org_id = $1 AND record_area = $2 AND record_key = $3 AND record_action IS NOT NULL AND id <> $4 AND created_at > $5 LIMIT 1",
    [l.orgId, l.area, l.key, l.session, l.created_at]));
  return rows.length > 0;
}

/** Claim one outcome of a session: true once, the first time (two settles at once claim it once). */
async function claim(l: Link, outcome: RunOutcome): Promise<boolean> {
  const rows = await asPlatform(async () => (await getDb()).query(
    "/* the session's own row; src/record-outcomes.ts is the only writer of record_outcomes */ UPDATE harness_sessions SET record_outcomes = array_append(record_outcomes, $3) WHERE org_id = $1 AND id = $2 AND NOT ($3 = ANY (record_outcomes)) RETURNING id",
    [l.orgId, l.session, outcome]));
  return rows.length > 0;
}

/** Tell the run's trace what moved (nothing when the session has no wake to say it on). */
async function said(orgId: number, run: string | null, m: OutcomeMove) {
  if (!run) return;
  const H = await import("./harness-sessions.js");
  await asPlatform(async () => H.runEvent(await getDb(), run, orgId, "record_moved", { area: m.area, key: m.key, from: m.from, to: m.to, outcome: m.outcome })).catch(() => {});
}

/** Apply one outcome of one session to its record, once, as the run. Answers the move made, or null. */
async function applyOutcome(l: Link, outcome: RunOutcome, detail: string | null, writer: string): Promise<OutcomeMove | null> {
  if (l.outcomes.includes(outcome)) return null;
  const R = await RA();
  const area = R.findArea(l.area);
  if (!area || area.scope !== "workspace" || !area.lifecycle) return null;
  const a = actionFor(area, l.action);
  const to = a ? outcomeState(a, outcome) : null;
  if (!a || !to) return null;
  if (await superseded(l)) return null;
  if (!(await claim(l, outcome))) return null;
  const reason = outcomeWords(outcome, detail);
  const lc = area.lifecycle;
  const { auditAtomic } = await import("./audit-trail.js");
  const moved = await R.asWriter({ by: "run", id: writer }, () => auditAtomic(() => R.inTransaction(l.orgId, async (): Promise<OutcomeMove | null> => {
    // Read and decide on the locked row: no one moves it between the check and the move.
    const row = await R.lockedWorkspaceRow(l.orgId, area, l.key);
    if (!row) return null;
    const from = String(row.data[lc.field] ?? lc.initial);
    if (!mayMove(area, a, from, to, outcome)) return null;
    const store = R.workspaceRecords(area.pack, l.orgId, R.SYSTEM_ACTOR);
    if (a.reason_field) {
      const keep = Object.fromEntries(Object.entries(row.data).filter(([k]) => !k.startsWith("$") && k !== lc.field && !area.fields.some((f) => f.name === k && f.encrypted)));
      await store.update(area.name, l.key, { title: row.title, data: { ...keep, [a.reason_field]: reason.slice(0, 1000) } });
    }
    await store.move(area.name, l.key, to);
    return { area: area.name, key: l.key, from, to, outcome, reason };
  })));
  if (moved) await said(l.orgId, l.wake, moved);
  return moved;
}

/**
 * A start_program action has started a session on a record: the session is marked as this action's (only such a
 * session's outcomes move the record), then the record moves to move_to as the person who started it, when the area's
 * move permission and a transition open to their role allow it from where it is (else it stays).
 */
export async function moveOnStart(orgId: number, areaName: string, key: string, actionId: string, sessionId: string, actor: import("./record-areas.js").Actor): Promise<OutcomeMove | null> {
  const R = await RA();
  const area = R.findArea(areaName);
  const action = area ? actionById(area, actionId) : null;
  if (!area || !action || action.kind !== "start_program" || area.scope !== "workspace") return null;
  if (movingActions(area).includes(action))
    await asPlatform(async () => (await getDb()).query("/* the session's own row */ UPDATE harness_sessions SET record_action = $3 WHERE org_id = $1 AND id = $2 AND record_area = $4 AND record_key = $5",
      [orgId, sessionId, actionId, areaName, key]));
  if (!action.move_to || !area.lifecycle) return null;
  const lc = area.lifecycle, to = action.move_to;
  const row = await R.getFor(orgId, area.name, key, actor).catch(() => null);
  if (!row) return null;
  const from = String(row.data[lc.field] ?? lc.initial);
  if (from === to) return null;
  try {
    await R.workspaceRecords(area.pack, orgId, actor).move(area.name, key, to);
  } catch (e) {
    if ((e as { status?: number }).status && (e as { status: number }).status < 500) return null; // not this person's move, or not from there
    throw e;
  }
  return { area: area.name, key, from, to, outcome: "succeeded", reason: "started" };
}

/** An evaluation was decided (the guardian, or staff on a review): its record moves for its outcome. */
export async function afterEvaluation(orgId: number, evaluationId: string): Promise<OutcomeMove | null> {
  const [ev] = await asPlatform(async () => (await getDb()).query<{ root_id: string; program_id: string; handle_id: string | null; status: string; outcome: string | null; reasons: string[] | null; review_decision: string | null; review_reason: string | null }>(
    "SELECT root_id, program_id, handle_id, status, outcome, reasons, review_decision, review_reason FROM harness_evaluations WHERE org_id = $1 AND id = $2", [orgId, evaluationId]));
  if (!ev || ev.status !== "decided" || !ev.outcome) return null;
  const outcome: RunOutcome = ev.outcome === "needs_review"
    ? (ev.review_decision === "accept" ? "accepted" : ev.review_decision === "decline" ? "refused" : "needs_review")
    : ev.outcome === "accepted" ? "accepted" : "refused";
  const detail = ev.review_decision ? `${ev.review_decision === "accept" ? "accepted" : "declined"} by staff${ev.review_reason ? `, ${ev.review_reason}` : ""}` : (ev.reasons ?? [])[0] ?? null;
  const link = await linkOf(orgId, ev.root_id);
  if (!link) return null;
  return applyOutcome(link, outcome, detail, ev.handle_id ? `program:${ev.program_id}:${ev.handle_id}` : link.wake ?? `session:${link.session}`);
}

/** A version was applied or rolled back: the record its run was started on moves for that. */
export async function afterVersion(versionId: string, outcome: "applied" | "rolled_back"): Promise<OutcomeMove | null> {
  const [c] = await asPlatform(async () => (await getDb()).query<{ org_id: number; evaluation_id: string | null; applied_ref: string | null; rollback_reason: string | null }>(
    "/* tenant: staff, by version id */ SELECT org_id, evaluation_id, applied_ref, rollback_reason FROM harness_champions WHERE id = $1", [versionId]));
  if (!c?.evaluation_id) return null;
  const [ev] = await asPlatform(async () => (await getDb()).query<{ root_id: string; handle_id: string | null; program_id: string }>("SELECT root_id, handle_id, program_id FROM harness_evaluations WHERE org_id = $1 AND id = $2", [c.org_id, c.evaluation_id]));
  if (!ev) return null;
  const link = await linkOf(c.org_id, ev.root_id);
  if (!link) return null;
  return applyOutcome(link, outcome, outcome === "applied" ? c.applied_ref : c.rollback_reason, ev.handle_id ? `program:${ev.program_id}:${ev.handle_id}` : link.wake ?? `session:${link.session}`);
}

/**
 * Each root session a moving action started that ended in the last day and was not taken in yet, once: marked taken in
 * first (so a session the sweep cannot move is never read again), then moved for its latest decided evaluation, else for
 * its end (succeeded when it said done, failed otherwise). Not while another root session on the same record is live.
 */
export async function sweepRecordOutcomes(now = new Date(), limit = 200): Promise<number> {
  const R = await RA();
  if (!R.recordAreas().some((a) => movingActions(a).length)) return 0;
  const ended = await asPlatform(async () => (await getDb()).query<{ id: string; org_id: number; state: string; state_reason: string | null }>(
    `/* tenant: platform sweep across workspaces; each row's own org_id */ UPDATE harness_sessions s SET record_swept_at = $1
      WHERE s.id IN (SELECT x.id FROM harness_sessions x WHERE x.parent_id IS NULL AND x.record_action IS NOT NULL AND x.record_swept_at IS NULL
        AND x.state IN ('stopped', 'failed') AND x.ended_at > $1::timestamptz - interval '1 day'
        AND NOT EXISTS (SELECT 1 FROM harness_sessions o WHERE o.org_id = x.org_id AND o.parent_id IS NULL AND o.id <> x.id AND o.record_area = x.record_area AND o.record_key = x.record_key AND o.state NOT IN ('stopped', 'failed'))
        AND NOT EXISTS (SELECT 1 FROM harness_evaluations e WHERE e.org_id = x.org_id AND e.root_id = x.id AND e.status <> 'decided')
        ORDER BY x.ended_at LIMIT $2)
      RETURNING s.id, s.org_id, s.state, s.state_reason`, [now, limit]));
  let moved = 0;
  for (const s of ended) {
    try {
      const [ev] = await asPlatform(async () => (await getDb()).query<{ id: string }>("SELECT id FROM harness_evaluations WHERE org_id = $1 AND root_id = $2 AND status = 'decided' ORDER BY created_at DESC LIMIT 1", [s.org_id, s.id]));
      if (ev) { if (await afterEvaluation(s.org_id, ev.id)) moved++; continue; }
      const link = await linkOf(s.org_id, s.id);
      if (!link) continue;
      const done = s.state === "stopped" && s.state_reason === "done";
      if (await applyOutcome(link, done ? "succeeded" : "failed", done ? null : (s.state_reason ?? s.state), link.wake ?? `session:${link.session}`)) moved++;
    } catch (e) { console.error(`record outcomes: ${s.id}: ${(e as Error).message}`); }
  }
  return moved;
}

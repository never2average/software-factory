/**
 * A record's state follows the runs started on it (mold_v0-334). A record page's start_program action
 * (src/pack-api.ts DetailActionSchema) may declare:
 *   move_to       the state the record moves to when a person starts the program on it ("improving")
 *   on_outcome    the state it moves to when the run settles, by outcome (RUN_OUTCOMES): its evaluation accepted
 *                 ("solved"), waits for a staff review ("in_review"), refused it ("open"); the version it made applied
 *                 or rolled back; the run finished with no evaluation, or failed, crashed or was stopped ("open")
 *   reason_field  a text field the outcome's reason is written into (the record's history shows the change)
 *
 * Who moves it: the server, never the agent, along the area's lifecycle only (a move no transition allows is left out).
 * With a move_to, an outcome moves the record only while it is where this action put it (`move_to`, or a state an
 * earlier outcome of the same action gave it), so a person's own move afterwards stands; without one, wherever a
 * transition allows. An outcome seen twice changes nothing (the record is already there). The run's settles call in here (src/nested-runs.ts: a decision, a staff review, an apply or a
 * rollback); a run that ended with no decision is found by the sweep (sweepRecordOutcomes, from nestedTick).
 */
import { getDb } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import { pageActionId, RUN_OUTCOMES, type DetailAction, type RunOutcome } from "./pack-api.js";

export { RUN_OUTCOMES, type RunOutcome };

/** A run's link to the record it was started on, and the action that started it. */
export interface OutcomeLink { orgId: number; area: string; key: string; session: string }
export interface OutcomeMove { area: string; key: string; from: string; to: string; outcome: RunOutcome; reason: string }

type Area = import("./record-areas.js").RecordArea;
const RA = () => import("./record-areas.js");

/** The start_program actions of an area that move its records (declared move_to or on_outcome). */
export function movingActions(area: Pick<Area, "detail">): DetailAction[] {
  const acts = ((area.detail as { actions?: DetailAction[] } | undefined)?.actions ?? []);
  return acts.filter((a) => a.kind === "start_program" && (a.move_to !== undefined || a.on_outcome !== undefined));
}

/** Which of them a run is: the one whose program it ran, else the area's only one. */
export function actionFor(area: Pick<Area, "detail">, programs: readonly string[]): DetailAction | null {
  const acts = movingActions(area);
  return acts.find((a) => a.program && programs.includes(a.program)) ?? (acts.length === 1 ? acts[0]! : null);
}

/** The state an outcome names for this action (stopped falls back to failed), or null: it does not move the record. */
export const outcomeState = (a: DetailAction, outcome: RunOutcome): string | null => a.on_outcome?.[outcome] ?? null;

/**
 * Whether the record, in `from`, moves to `to` for this action (pure): only from where the action put it (its move_to,
 * or a state one of its outcomes names), along a transition of the lifecycle, and never to where it already is.
 */
export function mayMove(area: Pick<Area, "lifecycle">, a: DetailAction, from: string, to: string): boolean {
  const lc = area.lifecycle;
  if (!lc || from === to) return false;
  // An action that moves the record on start owns it from there: its outcomes move it only from where it (or they) put it.
  const placed = new Set([a.move_to, ...Object.values(a.on_outcome ?? {})].filter((x): x is string => typeof x === "string"));
  if (a.move_to !== undefined && !placed.has(from)) return false;
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

/** Move one record for one outcome, as the server (writer: the run). Answers the move made, or null. */
async function moveFor(link: OutcomeLink, programs: readonly string[], outcome: RunOutcome, detail: string | null, writer: string): Promise<OutcomeMove | null> {
  const R = await RA();
  const area = R.findArea(link.area);
  if (!area || area.scope !== "workspace" || !area.lifecycle) return null;
  const a = actionFor(area, programs);
  if (!a) return null;
  const to = outcomeState(a, outcome);
  if (!to) return null;
  const stored = (await R.workspaceStored(link.orgId, area, [link.key])).get(link.key);
  if (!stored) return null;
  const from = String(stored.data[area.lifecycle.field] ?? area.lifecycle.initial);
  if (!mayMove(area, a, from, to)) return null;
  const reason = outcomeWords(outcome, detail);
  const ops: import("./pack-api.js").RecordOperation[] = [];
  if (a.reason_field) {
    const keep = Object.fromEntries(Object.entries(stored.data).filter(([k]) => !k.startsWith("$") && k !== area.lifecycle!.field && !area.fields.some((f) => f.name === k && f.encrypted)));
    ops.push({ op: "update", area: area.name, key: link.key, title: stored.title, data: { ...keep, [a.reason_field]: reason.slice(0, 1000) } });
  }
  ops.push({ op: "move", area: area.name, key: link.key, to });
  const { withTenant } = await import("./tenant-scope.js");
  await R.asWriter({ by: "run", id: writer }, () => withTenant(link.orgId, () => R.workspaceRecords(area.pack, link.orgId, R.SYSTEM_ACTOR).batch(ops)));
  return { area: area.name, key: link.key, from, to, outcome, reason };
}

/** A root session's record link and the programs its tree ran (null: it was started on no record). */
async function linkOf(orgId: number, sessionId: string): Promise<(OutcomeLink & { programs: string[]; wake: string | null }) | null> {
  return asPlatform(async () => {
    const db = await getDb();
    const [s] = await db.query<{ id: string; root_id: string | null; record_area: string | null; record_key: string | null }>(
      "SELECT id, root_id, record_area, record_key FROM harness_sessions WHERE org_id = $1 AND id = $2", [orgId, sessionId]);
    if (!s) return null;
    const rootId = s.root_id ?? s.id;
    const [root] = rootId === s.id ? [s] : await db.query<typeof s>("SELECT id, root_id, record_area, record_key FROM harness_sessions WHERE org_id = $1 AND id = $2", [orgId, rootId]);
    if (!root?.record_area || !root.record_key) return null;
    const progs = await db.query<{ program_id: string }>(
      "SELECT DISTINCT program_id FROM harness_children WHERE org_id = $1 AND root_id = $2 AND program_id IS NOT NULL UNION SELECT DISTINCT program_id FROM harness_evaluations WHERE org_id = $1 AND root_id = $2", [orgId, root.id]);
    const [w] = await db.query<{ id: string }>("SELECT id FROM runs WHERE org_id = $1 AND harness_session_id = $2 ORDER BY created_at DESC LIMIT 1", [orgId, root.id]);
    return { orgId, area: root.record_area, key: root.record_key, session: root.id, programs: progs.map((p) => p.program_id), wake: w?.id ?? null };
  });
}

/** Tell the run's trace what moved (nothing when the session has no wake to say it on). */
async function said(orgId: number, run: string | null, m: OutcomeMove) {
  if (!run) return;
  const H = await import("./harness-sessions.js");
  await asPlatform(async () => H.runEvent(await getDb(), run, orgId, "record_moved", { area: m.area, key: m.key, from: m.from, to: m.to, outcome: m.outcome })).catch(() => {});
}

/**
 * A start_program action has started a session on a record: moved to its move_to when a transition allows it from where
 * the record is (else it stays). Written as the person who started it; the action declared the move, so it is the app's.
 */
export async function moveOnStart(orgId: number, areaName: string, key: string, action: DetailAction, by: { userId: string | null }): Promise<OutcomeMove | null> {
  if (action.kind !== "start_program" || !action.move_to) return null;
  const R = await RA();
  const area = R.findArea(areaName);
  if (!area?.lifecycle || area.scope !== "workspace") return null;
  const stored = (await R.workspaceStored(orgId, area, [key])).get(key);
  if (!stored) return null;
  const from = String(stored.data[area.lifecycle.field] ?? area.lifecycle.initial), to = action.move_to;
  if (from === to || !area.lifecycle.transitions.some((t) => t.to === to && (t.from === "*" || t.from.includes(from)))) return null;
  const { withTenant } = await import("./tenant-scope.js");
  const writer = by.userId ? { by: "people" as const, id: by.userId } : { by: "run" as const, id: `program:${action.program ?? "unknown"}:start` };
  await R.asWriter(writer, () => withTenant(orgId, () => R.workspaceRecords(area.pack, orgId, R.SYSTEM_ACTOR).move(area.name, key, to)));
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
  const m = await moveFor(link, [ev.program_id, ...link.programs], outcome, detail, ev.handle_id ? `program:${ev.program_id}:${ev.handle_id}` : link.wake ?? `session:${link.session}`);
  if (m) await said(orgId, link.wake, m);
  return m;
}

/** A version was applied or rolled back: the record its run was started on moves for that. */
export async function afterVersion(versionId: string, outcome: "applied" | "rolled_back"): Promise<OutcomeMove | null> {
  const [c] = await asPlatform(async () => (await getDb()).query<{ org_id: number; evaluation_id: string | null; program_id: string | null; applied_ref: string | null; rollback_reason: string | null }>(
    "/* tenant: staff, by version id */ SELECT org_id, evaluation_id, program_id, applied_ref, rollback_reason FROM harness_champions WHERE id = $1", [versionId]));
  if (!c?.evaluation_id) return null;
  const [ev] = await asPlatform(async () => (await getDb()).query<{ root_id: string; handle_id: string | null; program_id: string }>("SELECT root_id, handle_id, program_id FROM harness_evaluations WHERE org_id = $1 AND id = $2", [c.org_id, c.evaluation_id]));
  if (!ev) return null;
  const link = await linkOf(c.org_id, ev.root_id);
  if (!link) return null;
  const m = await moveFor(link, [ev.program_id, ...link.programs], outcome, outcome === "applied" ? c.applied_ref : c.rollback_reason, ev.handle_id ? `program:${ev.program_id}:${ev.handle_id}` : link.wake ?? `session:${link.session}`);
  if (m) await said(c.org_id, link.wake, m);
  return m;
}

/**
 * The runs that ended with no decision (finished, failed, crashed, stopped) in the last day, each on a record still where
 * its action put it on start: moved for "succeeded" or "failed". An ended run with a decided evaluation is moved for that
 * decision instead (a settle whose hook was lost). Never while another session on the same record is still live.
 */
export async function sweepRecordOutcomes(now = new Date(), limit = 200): Promise<number> {
  const R = await RA();
  if (!R.recordAreas().some((a) => movingActions(a).length)) return 0;
  const ended = await asPlatform(async () => (await getDb()).query<{ id: string; org_id: number; state: string; state_reason: string | null }>(
    `/* tenant: platform sweep across workspaces; each row's own org_id */ SELECT s.id, s.org_id, s.state, s.state_reason FROM harness_sessions s
      WHERE s.parent_id IS NULL AND s.record_area IS NOT NULL AND s.state IN ('stopped', 'failed') AND s.ended_at > $1::timestamptz - interval '1 day'
        AND NOT EXISTS (SELECT 1 FROM harness_sessions o WHERE o.org_id = s.org_id AND o.parent_id IS NULL AND o.id <> s.id AND o.record_area = s.record_area AND o.record_key = s.record_key AND o.state NOT IN ('stopped', 'failed') AND o.created_at > s.created_at)
        AND NOT EXISTS (SELECT 1 FROM harness_evaluations e WHERE e.org_id = s.org_id AND e.root_id = s.id AND e.status <> 'decided')
      ORDER BY s.ended_at DESC LIMIT $2`, [now, limit]));
  let moved = 0;
  for (const s of ended) {
    try {
      const [ev] = await asPlatform(async () => (await getDb()).query<{ id: string }>("SELECT id FROM harness_evaluations WHERE org_id = $1 AND root_id = $2 AND status = 'decided' ORDER BY created_at DESC LIMIT 1", [s.org_id, s.id]));
      if (ev) { if (await afterEvaluation(s.org_id, ev.id)) moved++; continue; }
      const link = await linkOf(s.org_id, s.id);
      if (!link) continue;
      const done = s.state === "stopped" && s.state_reason === "done";
      const m = await moveFor(link, link.programs, done ? "succeeded" : "failed", done ? null : (s.state_reason ?? s.state), link.wake ?? `session:${link.session}`);
      if (m) { moved++; await said(s.org_id, link.wake, m); }
    } catch (e) { console.error(`record outcomes: ${s.id}: ${(e as Error).message}`); }
  }
  return moved;
}

/** The action a record page started a session with, by its id (record-page-routes): what moveOnStart reads. */
export const actionById = (area: Pick<Area, "detail">, id: string): DetailAction | null =>
  (((area.detail as { actions?: DetailAction[] } | undefined)?.actions ?? []).find((x) => pageActionId(x) === id) ?? null);

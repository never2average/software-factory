/**
 * Records an agent session makes and closes (mold_v0-333; molds/mold_v0/MOLD.md "Truthful build and deployment
 * lifecycle"). A record page's start_agent action may declare `creates` (src/pack-api.ts SessionCreatesSchema): the
 * server adds that record (a build, queued) as the session starts, so a press always leaves a trace on the record it was
 * pressed on, and tells the agent its key. When the session ends with the record still where its declared terminal can
 * be reached, the shell moves it there (`on_session_end`, by why the session ended), writes why (`reason_field`) and
 * closes the records pointing at it (`children`: deployments still BUILDING become CANCELED). A move action with
 * `stops_session` stops the sessions working on its record (Cancel cancels), and their late moves are ignored.
 *
 *   plan        the record to make, from the action and this record (pure: its key, title and fields)
 *   make        add it through the record store, as the person who pressed (the app's own action: set_by "action" fields
 *               such as the session and the person who asked may be set)
 *   settle      once per session (a mark in the session's frozen policy, claimed before anything moves): the record's
 *               move and its children's, as the shell; called after a session ends (stop, reconcile, a declined budget)
 *               and by the harness sweep for anything missed
 *   stopFor     the open sessions linked to a record (made it, or started from it): stopped
 *
 * Every write goes through the record store (src/record-areas.ts): the area's lifecycle, fields and checks apply, and the
 * record's history names the shell ("shell:session") as the writer.
 */
import { randomBytes } from "node:crypto";
import { getDb, type Queryable } from "./db.js";
import { CREATES_SPECIAL, inputField, PackError, type RecordRow, type SessionCreates, type SessionEndReason } from "./pack-api.js";
import { asAction, asWriter, findArea, getFor, listFor, SYSTEM_ACTOR, workspaceRecords, type Actor, type RecordArea } from "./record-areas.js";
import { asPlatform, withTenant } from "./tenant-scope.js";

/** What a session's frozen policy keeps of the record it made (harness_sessions.policy.creates). */
export interface CreatedLink {
  area: string; key: string; pack: string;
  on_session_end?: SessionCreates["on_session_end"];
  reason_field?: string;
  children?: SessionCreates["children"];
  /** Set once the shell closed it out (or found nothing to do): why the session ended, and when. */
  closed?: { reason: SessionEndReason | "open"; at: string; moved_to: string | null };
}

/** A new record's key: the date and time, then a short random tail (sortable, unique enough, a valid record key). */
export function createdKey(now = new Date()): string {
  const t = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
  return `${t}-${randomBytes(3).toString("hex")}`;
}

/** The record a start_agent action makes from `record` (pure): its title and fields, the link back to `record` set. */
export function planCreated(c: SessionCreates, record: Pick<RecordRow, "key" | "title" | "data">, start: { session: string; person: string | null; now: Date }, fill: (t: string, r: Pick<RecordRow, "key" | "title" | "data">) => string): { title: string | null; data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  for (const [k, src] of Object.entries(c.fields ?? {})) {
    let v: unknown;
    if ((CREATES_SPECIAL as readonly string[]).includes(src)) {
      v = src === "$session" ? start.session : src === "$person" ? start.person : src === "$now" ? start.now.toISOString() : start.now.toISOString().slice(0, 10);
    } else if (src === "$key") v = record.key;
    else if (src === "$title") v = record.title ?? record.key;
    else v = record.data[inputField(src)!];
    if (v !== undefined && v !== null && v !== "") data[k] = v;
  }
  if (c.link) data[c.link] = record.key;
  const title = c.title ? fill(c.title, record) : record.title ?? record.key;
  return { title: title || null, data };
}

/** Add the planned record, as the person who pressed (inside the app's own action: its set_by "action" fields may be set). */
export async function makeCreated(orgId: number, c: SessionCreates, key: string, plan: { title: string | null; data: Record<string, unknown> }, actor: Actor): Promise<RecordRow> {
  const area = findArea(c.area);
  if (!area || area.scope !== "workspace") throw new PackError(`no workspace area ${c.area}`, 404);
  return asAction(() => workspaceRecords(area.pack, orgId, actor).create(area.name, key, { title: plan.title, data: plan.data }));
}

/** Remove a record made for a session that never started (its first wake refused): as if nothing was pressed. */
export async function unmakeCreated(orgId: number, link: { area: string; key: string }): Promise<void> {
  const area = findArea(link.area);
  if (!area) return;
  await workspaceRecords(area.pack, orgId, SYSTEM_ACTOR).delete(area.name, link.key).catch((e) => console.error(`session record ${link.area}/${link.key}: not removed: ${(e as Error).message}`));
}

/** The words a closed-out record's reason field says, by why its session ended. */
export const REASON_WORDS: Record<SessionEndReason, string> = {
  finished: "Its agent session finished without saying how this ended.",
  failed: "Its agent session failed.",
  budget: "Its agent session reached its budget, and nobody raised it.",
  crash: "Its agent session crashed and could not continue.",
  policy: "Its agent session was stopped by its governance policy.",
  stopped: "Its agent session was stopped.",
};

/**
 * Why a session ended, as a record it made is closed out by (null: it has not ended). `budgetRefused`: its last budget
 * request was declined or expired and nothing runs (it waits for a raise nobody gave).
 */
export function endReasonOf(s: { state: string; state_reason: string | null; current_run_id: string | null }, budgetRefused = false): SessionEndReason | null {
  const why = s.state_reason ?? "";
  if (s.state === "stopped") return why === "done" ? "finished" : "stopped";
  if (s.state === "failed") {
    if (/^(policy|egress_approval_denied|approval_timeout)/.test(why)) return "policy";
    if (/^crashed/.test(why)) return "crash";
    return "failed";
  }
  if (budgetRefused && !s.current_run_id && (s.state === "parked" || s.state === "awaiting")) return "budget";
  return null;
}

/** A state a lifecycle can move a record to from `from`, by a declared transition. */
const canMove = (area: RecordArea, from: unknown, to: string) =>
  !!area.lifecycle && from !== to && area.lifecycle.transitions.some((t) => t.to === to && (t.from === "*" || (typeof from === "string" && t.from.includes(from))));

/**
 * Close out the record session `id` made, once: claim the mark (two settles at once do it once), then move the record to
 * the state its end reason names (when a transition reaches it from where the record is: a record the agent already
 * finished is left as it is), write why, and close its children. Returns what it did (null: nothing to settle yet).
 */
export async function settleCreated(orgId: number, id: string): Promise<{ reason: SessionEndReason; moved_to: string | null; children: number } | null> {
  const db = await getDb();
  const [s] = await asPlatform(() => db.query<{ state: string; state_reason: string | null; current_run_id: string | null; policy: { creates?: CreatedLink } | null; refused: boolean }>(
    `/* tenant: the session's own workspace, by id */ SELECT s.state, s.state_reason, s.current_run_id, s.policy,
       coalesce((SELECT r.status IN ('declined', 'expired') FROM harness_session_requests r WHERE r.org_id = s.org_id AND r.session_id = s.id AND r.kind = 'budget' ORDER BY r.created_at DESC LIMIT 1), false) AS refused
       FROM harness_sessions s WHERE s.id = $1 AND s.org_id = $2`, [id, orgId]));
  const link = s?.policy?.creates;
  if (!s || !link || link.closed) return null;
  const reason = endReasonOf(s, s.refused);
  if (!reason) return null;
  const area = findArea(link.area);
  const target = link.on_session_end?.[reason] ?? null;
  // The claim: only one settle marks it (and so moves it).
  const claimed = await asPlatform(() => db.query(
    `/* tenant: the session's own workspace, by id */ UPDATE harness_sessions SET policy = jsonb_set(policy, '{creates,closed}', $3::jsonb), updated_at = now()
      WHERE id = $1 AND org_id = $2 AND policy ? 'creates' AND NOT (policy->'creates' ? 'closed') RETURNING id`,
    [id, orgId, JSON.stringify({ reason, at: new Date().toISOString(), moved_to: null })]));
  if (!claimed.length || !area) return null;
  let moved: string | null = null, children = 0;
  await asWriter({ by: "shell", id: "session" }, async () => {
    const rec = await getFor(orgId, area.name, link.key).catch(() => null);
    if (!rec || !target || !area.lifecycle) return;
    if (!canMove(area, rec.data[area.lifecycle.field] ?? area.lifecycle.initial, target)) return;
    try {
      const store = workspaceRecords(area.pack, orgId, SYSTEM_ACTOR);
      await store.move(area.name, link.key, target);
      moved = target;
      if (link.reason_field) {
        const now = await getFor(orgId, area.name, link.key);
        if (now && !now.data[link.reason_field]) await asAction(() => store.update(area.name, link.key, { title: now.title, data: { ...now.data, [link.reason_field!]: REASON_WORDS[reason] } }));
      }
    } catch (e) { console.error(`session ${id}: ${area.name}/${link.key} not closed out (${reason}): ${(e as Error).message}`); }
    children = await closeChildren(orgId, link);
  });
  if (moved) await asPlatform(() => db.query(
    `/* tenant: the session's own workspace, by id */ UPDATE harness_sessions SET policy = jsonb_set(policy, '{creates,closed,moved_to}', to_jsonb($3::text)) WHERE id = $1 AND org_id = $2`, [id, orgId, moved]));
  console.log(`session ${id} ended (${reason}): ${area.name}/${link.key} ${moved ? `moved to ${moved}` : "left as it was"}${children ? `, ${children} linked record${children === 1 ? "" : "s"} closed` : ""}`);
  return { reason, moved_to: moved, children };
}

/** The records pointing at the made one still in one of `from`: moved (a lifecycle) or written (a plain field) to `to`. */
async function closeChildren(orgId: number, link: CreatedLink): Promise<number> {
  let n = 0;
  for (const ch of link.children ?? []) {
    const kid = findArea(ch.area);
    if (!kid) continue;
    const field = ch.field ?? kid.lifecycle?.field;
    if (!field) continue;
    const store = workspaceRecords(kid.pack, orgId, SYSTEM_ACTOR);
    let after: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const page = await listFor(orgId, kid.name, { filter: { [ch.via]: link.key }, limit: 200, ...(after ? { after } : {}) });
      for (const row of page.records) {
        const v = row.data[field] ?? (kid.lifecycle?.field === field ? kid.lifecycle.initial : undefined);
        if (typeof v !== "string" || !ch.from.includes(v)) continue;
        try {
          if (kid.lifecycle?.field === field) { if (!canMove(kid, v, ch.to)) continue; await store.move(kid.name, row.key, ch.to); }
          else await asAction(() => store.update(kid.name, row.key, { title: row.title, data: { ...row.data, [field]: ch.to } }));
          n++;
        } catch (e) { console.error(`session record ${link.area}/${link.key}: ${kid.name}/${row.key} not closed: ${(e as Error).message}`); }
      }
      if (!page.next) break;
      after = page.next;
    }
  }
  return n;
}

/** The sweep's pass: every ended session with a record not yet closed out, a bounded batch (src/harness-sessions.ts). */
export async function settleEnded(limit = 100): Promise<number> {
  const db = await getDb();
  const rows = await asPlatform(() => db.query<{ id: string; org_id: number }>(
    `/* tenant: platform sweep across workspaces */ SELECT s.id, s.org_id FROM harness_sessions s
      WHERE s.policy ? 'creates' AND NOT (s.policy->'creates' ? 'closed') AND s.current_run_id IS NULL
        AND (s.state IN ('stopped', 'failed') OR (s.state IN ('parked', 'awaiting') AND EXISTS (SELECT 1 FROM harness_session_requests r WHERE r.org_id = s.org_id AND r.session_id = s.id AND r.kind = 'budget' AND r.status IN ('declined', 'expired'))))
      ORDER BY s.updated_at LIMIT $1`, [limit]));
  let n = 0;
  for (const r of rows) if (await withTenant(r.org_id, () => settleCreated(r.org_id, r.id)).catch((e) => { console.error(`session ${r.id}: close-out: ${(e as Error).message}`); return null; })) n++;
  return n;
}

/** The open sessions working on a record: the one that made it, and those started from it (by the record's own key). */
export async function sessionsFor(q: Queryable, orgId: number, area: string, key: string): Promise<string[]> {
  const rows = await q.query<{ id: string }>(
    `SELECT id FROM harness_sessions WHERE org_id = $1 AND state NOT IN ('stopped', 'failed') AND archived_at IS NULL
       AND ((record_area = $2 AND record_key = $3) OR (policy->'creates'->>'area' = $2 AND policy->'creates'->>'key' = $3))`, [orgId, area, key]);
  return rows.map((r) => r.id);
}

/**
 * The states of `area` a stops_session move reaches (Cancel's): a record in one is no longer moved by the sessions it
 * stopped (their late move is ignored, with a log line, instead of a refusal the agent would keep retrying).
 */
export function stopStates(area: Pick<RecordArea, "name"> & { detail?: { actions?: { kind: string; to?: string; stops_session?: boolean }[] } }): string[] {
  return (area.detail?.actions ?? []).filter((a) => a.kind === "move" && a.stops_session && a.to).map((a) => a.to!);
}

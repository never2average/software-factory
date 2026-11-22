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
import { asAction, asWriter, findArea, getFor, listFor, shellMove, SYSTEM_ACTOR, workspaceRecords, type Actor, type RecordArea } from "./record-areas.js";
import { asPlatform, withTenant } from "./tenant-scope.js";

/** What a session's frozen policy keeps of the record it made (harness_sessions.policy.creates). */
export interface CreatedLink {
  area: string; key: string; pack: string;
  on_session_end?: SessionCreates["on_session_end"];
  reason_field?: string;
  children?: SessionCreates["children"];
  /**
   * Set once the shell settled it: why the session ended, when, where it moved the record (null: left as it was), and
   * whether it is done (false: a move failed while the record was still open; the sweep tries again, at most 5 times).
   */
  closed?: { reason: SessionEndReason; at: string; moved_to: string | null; done?: boolean | null; tries?: number;
    /** Where the record was at the first attempt: every attempt moves it only from there. */ from?: string | null;
    /** When the attempt in progress (done: null) claimed it: a lease; past SETTLE_LEASE_MS another settle may take over. */ claimed_at?: string };
}

/** A new record's key: the date and time, then a short random tail (sortable, unique enough, a valid record key). */
export function createdKey(now = new Date()): string {
  const t = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
  return `${t}-${randomBytes(3).toString("hex")}`;
}

/** mold_v0-337: a day as a title says it: "22 Nov" (the day the record was made, UTC). */
export const titleDay = (d: Date) => `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`;
/**
 * The record a start_agent action makes from `record` (pure): its title and fields, the link back to `record` set.
 * mold_v0-337: its title's {{$n}} is `start.n` (one more than the records made from this one so far) and {{$today}}
 * the day it is made ("22 Nov").
 */
export function planCreated(c: SessionCreates, record: Pick<RecordRow, "key" | "title" | "data">, start: { session: string; person: string | null; now: Date; n?: number }, fill: (t: string, r: Pick<RecordRow, "key" | "title" | "data">) => string): { title: string | null; data: Record<string, unknown> } {
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
  const title = c.title ? fill(c.title.replace(/\{\{\s*\$n\s*\}\}/g, String(start.n ?? 1)).replace(/\{\{\s*\$today\s*\}\}/g, titleDay(start.now)), record) : record.title ?? record.key;
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

/**
 * A state a lifecycle lets the shell move a record to from `from`: by a transition that names `from` ("*" transitions
 * are people's, never the shell's own close-out).
 */
const canMove = (area: RecordArea, from: unknown, to: string) =>
  !!area.lifecycle && from !== to && typeof from === "string" && area.lifecycle.transitions.some((t) => t.to === to && t.from !== "*" && t.from.includes(from));

/**
 * The states that close a made record for good, so its children are closed with it: the states its close-out moves it
 * to, a Cancel's (stops_session), and a time limit's (a clock's move_to). Never succeeded, never one still going.
 */
export function closedStates(link: Pick<CreatedLink, "on_session_end">, area: RecordArea): string[] {
  const clocks = ((area as { clocks?: { escalate?: { move_to?: string }[] }[] }).clocks ?? []).flatMap((c) => (c.escalate ?? []).flatMap((e) => (e.move_to ? [e.move_to] : [])));
  // Only terminal ones: a state a named transition leaves is still going somewhere (its children stay with it).
  const terminal = (st: string) => !(area.lifecycle?.transitions ?? []).some((t) => t.from !== "*" && t.from.includes(st) && t.to !== st);
  return [...new Set([...Object.values(link.on_session_end ?? {}).filter((x): x is string => !!x), ...stopStates(area as never), ...clocks])].filter(terminal);
}
const stateOfRow = (area: RecordArea, rec: RecordRow | null) => (rec && area.lifecycle ? rec.data[area.lifecycle.field] ?? area.lifecycle.initial : null);

/** How long a close-out's claim holds before another settle may take it over (a process that died mid-way). */
export const SETTLE_LEASE_MS = 5 * 60_000;
/** The most a close-out is tried (a refused move while the record is still where it was). */
export const SETTLE_TRIES = 5;

/**
 * Settle the record session `id` made, once: claim it (an in-progress mark with a lease: a concurrent settle, from a
 * Cancel's stop racing the wake's end or the sweep, finds it held and does nothing), move the record to the state its end
 * reason names from the state it was in at the first attempt (`from`, kept: a retry never moves a record a person moved
 * since; it is done instead), write why, and, once the record is closed (a terminal state its close-out, a Cancel or a
 * time limit reaches), close its children. The last write is a compare-and-set on this attempt's claim. A refused move
 * while the record is still where it was leaves it not done: the sweep tries again, at most SETTLE_TRIES times.
 * Returns what it did (null: nothing to settle now, or another settle holds it).
 */
export async function settleCreated(orgId: number, id: string): Promise<{ reason: SessionEndReason; moved_to: string | null; children: number } | null> {
  const db = await getDb();
  const [s] = await asPlatform(() => db.query<{ state: string; state_reason: string | null; current_run_id: string | null; policy: { creates?: CreatedLink } | null; refused: boolean }>(
    `/* tenant: the session's own workspace, by id */ SELECT s.state, s.state_reason, s.current_run_id, s.policy,
       coalesce((SELECT r.status IN ('declined', 'expired') FROM harness_session_requests r WHERE r.org_id = s.org_id AND r.session_id = s.id AND r.kind = 'budget' ORDER BY r.created_at DESC LIMIT 1), false) AS refused
       FROM harness_sessions s WHERE s.id = $1 AND s.org_id = $2`, [id, orgId]));
  const link = s?.policy?.creates;
  if (!s || !link) return null;
  const before = link.closed;
  if (before && (before.done === true || (before.tries ?? 0) >= SETTLE_TRIES)) return null;
  if (before && before.done == null && before.claimed_at && Date.now() - Date.parse(before.claimed_at) < SETTLE_LEASE_MS) return null; // held
  const reason = before?.reason ?? endReasonOf(s, s.refused);
  if (!reason) return null;
  const area = findArea(link.area);
  const target = link.on_session_end?.[reason] ?? null;
  const rec0 = area?.lifecycle ? await getFor(orgId, area.name, link.key).catch(() => null) : null;
  // Where the record was when the shell first came to close it: every attempt moves it only from there.
  const from = before?.from ?? (area && rec0 ? String(stateOfRow(area, rec0)) : null);
  const tries = (before?.tries ?? 0) + 1;
  const claimedAt = new Date().toISOString();
  const mark = (done: boolean | null, moved: string | null) => JSON.stringify({ reason, at: before?.at ?? claimedAt, from, moved_to: moved, done, tries, claimed_at: claimedAt });
  // The claim: from nothing, from a failed attempt, or from a lease gone stale; by the tries it read (compare-and-set).
  const claimed = await asPlatform(() => db.query(
    `/* tenant: the session's own workspace, by id */ UPDATE harness_sessions SET policy = jsonb_set(policy, '{creates,closed}', $3::jsonb), updated_at = now()
      WHERE id = $1 AND org_id = $2 AND policy ? 'creates'
        AND (NOT (policy->'creates' ? 'closed')
             OR (coalesce((policy->'creates'->'closed'->>'tries')::int, 0) = $4
                 AND (policy->'creates'->'closed'->>'done' = 'false'
                      OR (policy->'creates'->'closed'->>'done' IS NULL AND coalesce((policy->'creates'->'closed'->>'claimed_at')::timestamptz, 'epoch') < now() - make_interval(secs => $5)))))
      RETURNING id`,
    [id, orgId, mark(null, null), tries - 1, SETTLE_LEASE_MS / 1000]));
  if (!claimed.length) return null;
  let moved: string | null = null, children = 0, done = true;
  if (area?.lifecycle) await asWriter({ by: "shell", id: "session" }, async () => {
    let rec = await getFor(orgId, area.name, link.key).catch(() => null);
    if (!rec) return;
    const at = stateOfRow(area, rec);
    // Only from where it was at the first attempt: a record a person moved since is theirs (done, left as it is).
    if (target && from !== null && at === from && canMove(area, from, target)) {
      try {
        await shellMove(orgId, area.pack, area.name, link.key, [from], target);
        moved = target;
        if (link.reason_field) {
          rec = await getFor(orgId, area.name, link.key);
          if (rec && !rec.data[link.reason_field]) await asAction(() => workspaceRecords(area.pack, orgId, SYSTEM_ACTOR).update(area.name, link.key, { title: rec!.title, data: { ...rec!.data, [link.reason_field!]: REASON_WORDS[reason] } }));
        }
      } catch (e) { console.error(`session ${id}: ${area.name}/${link.key} not closed out (${reason}): ${(e as Error).message}`); }
      rec = await getFor(orgId, area.name, link.key).catch(() => null);
    }
    const now = stateOfRow(area, rec);
    // Its children only once the record itself is closed (by this close-out, a Cancel or a time limit).
    if (typeof now === "string" && closedStates(link, area).includes(now)) children = await closeChildren(orgId, link);
    // Not done while the move is still open to it from where it was (a refusal, a race): the sweep tries again.
    else if (target && from !== null && now === from && canMove(area, from, target)) done = false;
  });
  // The last write: only while this attempt's claim stands.
  await asPlatform(() => db.query(
    `/* tenant: the session's own workspace, by id */ UPDATE harness_sessions SET policy = jsonb_set(policy, '{creates,closed}', $3::jsonb)
      WHERE id = $1 AND org_id = $2 AND policy->'creates'->'closed'->>'claimed_at' = $4 AND coalesce((policy->'creates'->'closed'->>'tries')::int, 0) = $5`,
    [id, orgId, mark(done, moved), claimedAt, tries]));
  console.log(`session ${id} ended (${reason}): ${link.area}/${link.key} ${moved ? `moved to ${moved}` : "left as it was"}${children ? `, ${children} linked record${children === 1 ? "" : "s"} closed` : ""}${done ? "" : " (tried again later)"}`);
  return { reason, moved_to: moved, children };
}

/**
 * The children of a record a session made, closed once the record is (a Cancel's move or a time limit's, called right
 * after it): by the link its session keeps. Nothing while the record is open or succeeded.
 */
export async function closeChildrenFor(orgId: number, areaName: string, key: string): Promise<number> {
  const area = findArea(areaName);
  if (!area?.lifecycle) return 0;
  const db = await getDb();
  const rows = await asPlatform(() => db.query<{ policy: { creates?: CreatedLink } }>(
    `/* tenant: the workspace's own sessions */ SELECT policy FROM harness_sessions WHERE org_id = $1 AND policy->'creates'->>'area' = $2 AND policy->'creates'->>'key' = $3 LIMIT 1`, [orgId, areaName, key]));
  const link = rows[0]?.policy?.creates;
  if (!link?.children?.length) return 0;
  const now = stateOfRow(area, await getFor(orgId, areaName, key).catch(() => null));
  if (typeof now !== "string" || !closedStates(link, area).includes(now)) return 0;
  return asWriter({ by: "shell", id: "session" }, () => closeChildren(orgId, link));
}

/** The records pointing at the made one still in one of `from`: moved (a lifecycle) or written (a plain field) to `to`. */
async function closeChildren(orgId: number, link: CreatedLink): Promise<number> {
  let n = 0;
  for (const ch of link.children ?? []) {
    const kid = findArea(ch.area);
    if (!kid) continue;
    const field = ch.field ?? kid.lifecycle?.field;
    if (!field) continue;
    const keys: { key: string }[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 50; pages++) {
      const page = await listFor(orgId, kid.name, { filter: { [ch.via]: link.key }, limit: 200, ...(after ? { after } : {}) });
      keys.push(...page.records.map((r) => ({ key: r.key })));
      if (!page.next) break;
      after = page.next;
    }
    for (const { key } of keys) {
      const row = await getFor(orgId, kid.name, key).catch(() => null);
      if (!row) continue;
      const v = row.data[field] ?? (kid.lifecycle?.field === field ? kid.lifecycle.initial : undefined);
      if (typeof v !== "string" || !ch.from.includes(v)) continue;
      try {
        if (kid.lifecycle?.field === field) { if (!canMove(kid, v, ch.to)) continue; await shellMove(orgId, kid.pack, kid.name, key, [v], ch.to); }
        else await asAction(() => workspaceRecords(kid.pack, orgId, SYSTEM_ACTOR).update(kid.name, key, { title: row.title, data: { ...row.data, [field]: ch.to } }));
        n++;
      } catch (e) { console.error(`session record ${link.area}/${link.key}: ${kid.name}/${key} not closed: ${(e as Error).message}`); }
    }
  }
  return n;
}

/** The sweep's pass: ended sessions whose record is not settled yet (or whose close-out move is to be tried again). */
export async function settleEnded(limit = 100): Promise<number> {
  const db = await getDb();
  const rows = await asPlatform(() => db.query<{ id: string; org_id: number }>(
    `/* tenant: platform sweep across workspaces */ SELECT s.id, s.org_id FROM harness_sessions s
      WHERE s.policy ? 'creates' AND s.current_run_id IS NULL
        AND (NOT (s.policy->'creates' ? 'closed')
             OR (coalesce((s.policy->'creates'->'closed'->>'tries')::int, 0) < $2
                 AND (s.policy->'creates'->'closed'->>'done' = 'false'
                      OR (s.policy->'creates'->'closed'->>'done' IS NULL AND coalesce((s.policy->'creates'->'closed'->>'claimed_at')::timestamptz, 'epoch') < now() - make_interval(secs => $3)))))
        AND (s.state IN ('stopped', 'failed') OR (s.state IN ('parked', 'awaiting') AND EXISTS (SELECT 1 FROM harness_session_requests r WHERE r.org_id = s.org_id AND r.session_id = s.id AND r.kind = 'budget' AND r.status IN ('declined', 'expired'))))
      ORDER BY s.updated_at LIMIT $1`, [limit, SETTLE_TRIES, SETTLE_LEASE_MS / 1000]));
  let n = 0;
  for (const r of rows) if (await withTenant(r.org_id, () => settleCreated(r.org_id, r.id)).catch((e) => { console.error(`session ${r.id}: close-out: ${(e as Error).message}`); return null; })) n++;
  return n;
}

/**
 * The open sessions a record's Cancel stops: the one that made it (always: it works for the record), and those started
 * from it (`started`: stopped only where the person who cancelled may stop them).
 */
export async function sessionsFor(q: Queryable, orgId: number, area: string, key: string): Promise<{ made: string[]; started: string[] }> {
  const rows = await q.query<{ id: string; made: boolean }>(
    `SELECT id, (policy->'creates'->>'area' = $2 AND policy->'creates'->>'key' = $3) AS made FROM harness_sessions WHERE org_id = $1 AND state NOT IN ('stopped', 'failed') AND archived_at IS NULL
       AND ((record_area = $2 AND record_key = $3) OR (policy->'creates'->>'area' = $2 AND policy->'creates'->>'key' = $3))`, [orgId, area, key]);
  return { made: rows.filter((r) => r.made).map((r) => r.id), started: rows.filter((r) => !r.made).map((r) => r.id) };
}

/**
 * Stop the open sessions working on a record (mold_v0-333 Cancel; mold_v0-337 a time limit's step with stops_session):
 * the one that made it always, as the platform under `words` (it works only for the record), and, with `startedBy`,
 * those started from it that this actor may stop under the session's own rules (theirs, or as an owner). Each stopped
 * session is marked first (policy.stopped_for), so only its wakes' late moves of the record are ignored; one this
 * actor may not stop loses the mark again. Returns how many were stopped.
 */
export async function stopSessionsFor(orgId: number, area: string, key: string, words: string, startedBy: import("./harness-sessions.js").Actor | null): Promise<number> {
  const H = await import("./harness-sessions.js");
  const { made, started } = await H.read((q) => sessionsFor(q, orgId, area, key));
  let stopped = 0;
  const system = { kind: "system" as const, user: null, name: words, role: null };
  for (const [id, by] of [...made.map((id) => [id, system] as const), ...(startedBy ? started.map((id) => [id, startedBy] as const) : [])]) {
    try {
      await H.tx((q) => markStoppedFor(q, orgId, id, area, key));
      await H.stopSession(orgId, id, by);
      stopped++;
    } catch (e) {
      // Not this actor's to stop: the mark goes (only where no stop was asked of it, nor did it end).
      if ((e as { status?: number }).status === 403)
        await H.tx((q) => q.query("UPDATE harness_sessions SET policy = policy - 'stopped_for' WHERE id = $1 AND org_id = $2 AND state NOT IN ('stopped', 'failed') AND stop_requested_at IS NULL", [id, orgId]));
      console.error(`${area}/${key}: session ${id} not stopped: ${(e as Error).message}`);
    }
  }
  return stopped;
}

/** Mark a session as stopped by a record's Cancel: only its wakes' late moves of that record are ignored. */
export async function markStoppedFor(q: Queryable, orgId: number, id: string, area: string, key: string): Promise<void> {
  await q.query(`UPDATE harness_sessions SET policy = jsonb_set(policy, '{stopped_for}', $3::jsonb) WHERE id = $1 AND org_id = $2`, [id, orgId, JSON.stringify({ area, key })]);
}

/**
 * The states of `area` a stops_session move reaches (Cancel's): a record in one is no longer moved by the sessions that
 * move stopped (their late move is ignored, with a log line, instead of a refusal the agent would keep retrying).
 */
export function stopStates(area: Pick<RecordArea, "name"> & { detail?: { actions?: { kind: string; to?: string; stops_session?: boolean }[] }; clocks?: { escalate?: { move_to?: string; stops_session?: boolean }[] }[] }): string[] {
  // mold_v0-337: and the states a time limit that stops the session moves it to.
  const clocks = (area.clocks ?? []).flatMap((c) => (c.escalate ?? []).flatMap((e) => (e.move_to && e.stops_session ? [e.move_to] : [])));
  return [...new Set([...(area.detail?.actions ?? []).filter((a) => a.kind === "move" && a.stops_session && a.to).map((a) => a.to!), ...clocks])];
}

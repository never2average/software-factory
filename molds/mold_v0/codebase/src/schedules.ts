/**
 * Schedules per workspace and due-date notices (mold_v0-035; molds/mold_v0/MOLD.md "Pack and record-area contract").
 * Tables: sql/migrations/0008_schedules.sql. HTTP: src/schedule-routes.ts.
 *
 *   defaults   a pack's definePack({ schedules }) are copied into every workspace (ensureDefaults: at every tick and when
 *              the console asks), each its own row: its own on/off, time and assets, its own runs. A copy no owner has
 *              changed follows the pack's later changes; a changed one is the workspace's own
 *   owners     turn schedules off and on, change when they run (cron, UTC) and over which of their asset records, and
 *              add their own for any job kind of the build ("manage", src/schedule-routes.ts). The workspace is always
 *              the session's; an asset key must be one of that workspace's own records
 *   tick       tickSchedules(now): every enabled row whose next_at has come. Of the due times since the last tick only
 *              the latest runs, once (the others are counted in last_skipped): one row is moved on by a compare-and-set
 *              on its seq, so two ticks at once (the Vercel cron and a server's loop, two replicas) start its runs once.
 *              Its runs go through the run engine (src/runs.ts startRun) for the row's own workspace, requested_by
 *              "schedule:<id>", one per asset record (targets.asset {area, key}, targets.environment), skipping a target
 *              whose previous run from this schedule is still queued or running. The engine's per-workspace cap applies
 *   due check  dueCheck(now), once a UTC day (scheduler_marks): for every check area that declares `due`, each workspace
 *              record whose date falls within the window gets one in-app notice (workspace_notices, one per record and
 *              due date), and the workspace's people with the area's notify roles (its own Clerk organization's members,
 *              src/email.ts accountRecipients) get one email listing the notices not yet emailed, recorded in email_log
 *
 * schedulerTick(now) runs both: from the product's cron entry on Vercel (/api/cron/autoscale, CRON_SECRET) and from a
 * one-minute loop on a server (startScheduler, src/http.ts; OCTILLION_SCHEDULER=off turns it off). Every time here is
 * the `now` handed in, so a test drives the clock. With no job kind and no due area nothing is read or written.
 */
import { CronError, countBetween, latestAtOrBefore, nextAfter, parseCron } from "./cron.js";
import { getDb } from "./db.js";
import { PackError, ScheduleSchema, z } from "./pack-api.js";
import { packs } from "./packs.js";
import { findArea, recordAreas, type RecordArea } from "./record-areas.js";
import { findKind, jobKinds, startRun } from "./runs.js";
import { asPlatform, withTenant } from "./tenant-scope.js";

export type DefaultSchedule = z.output<typeof ScheduleSchema> & { pack: string };

/** The scheduler's clock: the wall clock, or one a test sets (every function here also takes `now`). */
let clockFn: () => Date = () => new Date();
const clock = () => clockFn();
/** Tests only: drive the scheduler's clock (null: the wall clock again). */
export function setSchedulerClock(fn: (() => Date) | null) { clockFn = fn ?? (() => new Date()); }

let cache: { from: unknown; list: DefaultSchedule[] } | null = null;
/** Every default schedule the packs declare (checked by definePack: the kind and the asset area are the pack's own). */
export function defaultSchedules(): DefaultSchedule[] {
  const list = packs();
  if (cache?.from === list) return cache.list;
  cache = { from: list, list: list.flatMap((p) => (p.definition.schedules ?? []).map((s) => ({ ...ScheduleSchema.parse(s), pack: p.id }))) };
  return cache.list;
}
/** Check areas that declare due dates. */
export const dueAreas = (): (RecordArea & { due: NonNullable<RecordArea["due"]> })[] =>
  recordAreas().filter((a): a is RecordArea & { due: NonNullable<RecordArea["due"]> } => !!a.due);
/** Whether there is anything to schedule at all (a job kind in the build). */
export const schedulesWired = () => jobKinds().length > 0;

interface Row {
  id: string; org_id: number; pack: string; name: string; label: string | null; job_kind: string; cron: string;
  asset_area: string | null; asset_keys: string[] | null; environment: string | null; scope: Record<string, unknown>;
  enabled: boolean; is_default: boolean; customized: boolean; next_at: Date; seq: number;
  last_slot_at: Date | null; last_fired_at: Date | null; last_skipped: number; last_runs: string[]; last_error: string | null;
  updated_by: string | null; updated_at: Date;
}
const COLS = `id, org_id, pack, name, label, job_kind, cron, asset_area, asset_keys, environment, scope, enabled, is_default, customized,
  next_at, seq, last_slot_at, last_fired_at, last_skipped, last_runs, last_error, updated_by, updated_at`;
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export interface ScheduleView {
  id: string; pack: string; name: string; label: string | null; job_kind: string; cron: string;
  assets: { area: string; keys: string[] | null } | null; environment: string | null; scope: Record<string, unknown>;
  enabled: boolean; is_default: boolean; customized: boolean; next_at: string | null;
  last: { slot_at: string; fired_at: string | null; skipped: number; runs: string[]; error: string | null } | null;
  updated_by: string | null; updated_at: string;
}
const view = (r: Row): ScheduleView => ({
  id: String(r.id), pack: r.pack, name: r.name, label: r.label, job_kind: r.job_kind, cron: r.cron,
  assets: r.asset_area ? { area: r.asset_area, keys: r.asset_keys ?? null } : null, environment: r.environment, scope: r.scope ?? {},
  enabled: r.enabled, is_default: r.is_default, customized: r.customized, next_at: r.enabled ? iso(r.next_at) : null,
  last: r.last_slot_at ? { slot_at: iso(r.last_slot_at)!, fired_at: iso(r.last_fired_at), skipped: r.last_skipped, runs: r.last_runs ?? [], error: r.last_error } : null,
  updated_by: r.updated_by, updated_at: iso(r.updated_at)!,
});

/** The far future, for a row whose expression has no next match (it is turned off too). */
const NEVER = new Date(Date.UTC(9999, 0, 1));
const nextOf = (cron: string, after: Date) => nextAfter(parseCron(cron), after) ?? NEVER;

// ---------- defaults: one copy per workspace ----------

/**
 * Copy the packs' default schedules into every workspace (or one), and bring the copies no owner changed up to the
 * pack's current definition. Idempotent; one statement per default.
 */
export async function ensureDefaults(now = clock(), orgId: number | null = null): Promise<number> {
  const defs = defaultSchedules();
  if (!defs.length) return 0;
  let n = 0;
  await asPlatform(async () => {
    const db = await getDb();
    for (const d of defs) {
      const rows = await db.query(
        `/* tenant: platform copy of a pack's default schedule into every workspace (or the one asked), each row its own org_id */
         INSERT INTO workspace_schedules (org_id, pack, name, label, job_kind, cron, asset_area, asset_keys, environment, scope, enabled, is_default, next_at)
         SELECT o.id, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11 FROM organizations o WHERE ($12::int IS NULL OR o.id = $12)
         ON CONFLICT (org_id, pack, name) DO UPDATE SET label = excluded.label, job_kind = excluded.job_kind, cron = excluded.cron,
                asset_area = excluded.asset_area, asset_keys = excluded.asset_keys, environment = excluded.environment, scope = excluded.scope,
                enabled = excluded.enabled,
                -- A new time, or the pack turning it on: due from now (nothing missed while off is run).
                next_at = CASE WHEN workspace_schedules.cron = excluded.cron AND (workspace_schedules.enabled OR NOT excluded.enabled)
                               THEN workspace_schedules.next_at ELSE excluded.next_at END,
                seq = workspace_schedules.seq + 1, updated_at = now()
          WHERE workspace_schedules.is_default AND NOT workspace_schedules.customized
            AND (workspace_schedules.label, workspace_schedules.job_kind, workspace_schedules.cron, workspace_schedules.asset_area, workspace_schedules.asset_keys,
                 workspace_schedules.environment, workspace_schedules.scope, workspace_schedules.enabled)
                IS DISTINCT FROM (excluded.label, excluded.job_kind, excluded.cron, excluded.asset_area, excluded.asset_keys, excluded.environment, excluded.scope, excluded.enabled)
         RETURNING id`,
        [d.pack, d.name, d.label ?? null, d.job_kind, d.cron, d.assets?.area ?? null, d.assets?.keys ?? null, d.environment ?? null,
         JSON.stringify(d.scope ?? {}), d.enabled, nextOf(d.cron, now), orgId]);
      n += rows.length;
    }
  });
  return n;
}

// ---------- the workspace's side: list, add, change, remove (the console) ----------

export async function listSchedules(orgId: number, now = clock()): Promise<ScheduleView[]> {
  await ensureDefaults(now, orgId);
  return withTenant(orgId, async () => (await (await getDb()).query<Row>(
    `SELECT ${COLS} FROM workspace_schedules WHERE org_id = $1 ORDER BY pack, is_default DESC, name`, [orgId])).map(view));
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const NAME = /^[a-z][a-z0-9_]{1,62}$/;
const ENV = /^[a-z][a-z0-9_-]{0,39}$/;

/** An asset area a schedule of `pack` may run over: one of that pack's own asset areas (as definePack requires of a default). */
function assetArea(pack: string, area: unknown): RecordArea {
  const a = typeof area === "string" ? findArea(area) : null;
  if (!a || a.pack !== pack || a.role !== "asset") throw new PackError(`assets.area must be one of pack ${pack}'s asset areas`, 400);
  return a;
}

/** The asset keys of `area` that exist in workspace `orgId` (all of them when `keys` is null), at most 50. */
async function assetKeys(orgId: number, area: RecordArea, keys: string[] | null): Promise<{ found: string[]; missing: string[] }> {
  return withTenant(orgId, async () => {
    const rows = await (await getDb()).query<{ key: string }>(
      `SELECT key FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND ($4::text[] IS NULL OR key = ANY ($4::text[])) ORDER BY key LIMIT 51`,
      [orgId, area.pack, area.name, keys]);
    const found = rows.map((r) => r.key);
    return { found, missing: keys ? keys.filter((k) => !found.includes(k)) : [] };
  });
}

interface Fields { label?: string | null; cron?: string; assets?: { area: string; keys: string[] | null } | null; environment?: string | null; scope?: Record<string, unknown>; enabled?: boolean }

/** Check what an owner sends (only the fields given), against the schedule's pack and the owner's own workspace. */
async function checkFields(orgId: number, pack: string, b: Record<string, unknown>): Promise<Fields> {
  const out: Fields = {};
  if (b.label !== undefined) {
    if (b.label !== null && (typeof b.label !== "string" || b.label.length > 80)) throw new PackError("label: up to 80 characters", 400);
    out.label = (b.label as string | null) || null;
  }
  if (b.cron !== undefined) {
    try { out.cron = parseCron(b.cron).source; } catch (e) { throw new PackError(`cron: ${(e as CronError).message}`, 400); }
  }
  if (b.assets !== undefined) {
    if (b.assets === null) out.assets = null;
    else {
      const x = b.assets as { area?: unknown; keys?: unknown };
      if (typeof x !== "object" || Array.isArray(x)) throw new PackError("assets: {area, keys?} or null", 400);
      const area = assetArea(pack, x.area);
      let keys: string[] | null = null;
      if (x.keys !== undefined && x.keys !== null) {
        if (!Array.isArray(x.keys) || !x.keys.length || x.keys.length > 50 || !x.keys.every((k) => typeof k === "string" && KEY.test(k)))
          throw new PackError("assets.keys: 1 to 50 record keys (or none: every record of the area)", 400);
        keys = [...new Set(x.keys as string[])];
        // Only the workspace's own records: a key of another workspace's records is simply not there.
        const { missing } = await assetKeys(orgId, area, keys);
        if (missing.length) throw new PackError(`assets.keys: no ${area.name} record ${missing.slice(0, 3).join(", ")} in this workspace`, 400);
      }
      out.assets = { area: area.name, keys };
    }
  }
  if (b.environment !== undefined) {
    if (b.environment !== null && (typeof b.environment !== "string" || !ENV.test(b.environment))) throw new PackError("environment: lowercase letters, digits, _ and -", 400);
    out.environment = (b.environment as string | null) ?? null;
  }
  if (b.scope !== undefined) {
    if (!b.scope || typeof b.scope !== "object" || Array.isArray(b.scope)) throw new PackError("scope must be an object", 400);
    if (Buffer.byteLength(JSON.stringify(b.scope)) > 64 * 1024) throw new PackError("scope is at most 64 KB", 413);
    out.scope = b.scope as Record<string, unknown>;
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") throw new PackError("enabled: true or false", 400);
    out.enabled = b.enabled;
  }
  return out;
}

const MAX_PER_WORKSPACE = () => Number(process.env.OCTILLION_SCHEDULES_MAX_PER_WORKSPACE ?? 50);

/** An owner's own schedule for one of the build's job kinds, in their workspace (the session's). */
export async function createSchedule(orgId: number, by: string, b: Record<string, unknown>, now = clock()): Promise<ScheduleView> {
  const pack = String(b.pack ?? ""), kind = String(b.job_kind ?? ""), name = String(b.name ?? "");
  if (!findKind(pack, kind)) throw new PackError(`no job kind ${JSON.stringify(`${pack}/${kind}`.slice(0, 80))} in this build`, 400);
  if (!NAME.test(name)) throw new PackError("name: 2-63 lowercase letters, digits and _, starting with a letter", 400);
  if (defaultSchedules().some((d) => d.pack === pack && d.name === name)) throw new PackError(`${name} is one of pack ${pack}'s default schedules: change that one instead`, 409);
  if (b.cron === undefined) throw new PackError("cron is required", 400);
  const f = await checkFields(orgId, pack, b);
  const [{ n }] = await withTenant(orgId, async () => (await getDb()).query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_schedules WHERE org_id = $1", [orgId]));
  if (n >= MAX_PER_WORKSPACE()) throw new PackError(`this workspace already has ${n} schedules (at most ${MAX_PER_WORKSPACE()})`, 429);
  const r = await asPlatform(async () => (await getDb()).query<Row>(
    `INSERT INTO workspace_schedules (org_id, pack, name, label, job_kind, cron, asset_area, asset_keys, environment, scope, enabled, is_default, customized, next_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, true, $12, $13, $13) ON CONFLICT (org_id, pack, name) DO NOTHING RETURNING ${COLS}`,
    [orgId, pack, name, f.label ?? null, kind, f.cron!, f.assets?.area ?? null, f.assets?.keys ?? null, f.environment ?? null,
     JSON.stringify(f.scope ?? {}), f.enabled ?? true, nextOf(f.cron!, now), by]));
  if (!r[0]) throw new PackError(`this workspace already has a schedule ${name} of pack ${pack}`, 409);
  return view(r[0]);
}

/** Change one of the workspace's schedules (a default one becomes the workspace's own: the pack's changes stop applying). */
export async function updateSchedule(orgId: number, id: string, by: string, b: Record<string, unknown>, now = clock()): Promise<ScheduleView> {
  const cur = await getSchedule(orgId, id);
  if (!cur) throw new PackError("no such schedule", 404);
  const f = await checkFields(orgId, cur.pack, b);
  if (!Object.keys(f).length) throw new PackError("nothing to change: label, cron, assets, environment, scope or enabled", 400);
  const cron = f.cron ?? cur.cron;
  // A new time, or turning it back on: the next due time counts from now (what was missed while off is not run).
  const fresh = f.cron !== undefined || (f.enabled === true && !cur.enabled);
  const [r] = await asPlatform(async () => (await getDb()).query<Row>(
    `UPDATE workspace_schedules SET label = $3, cron = $4, asset_area = $5, asset_keys = $6, environment = $7, scope = $8, enabled = $9,
            next_at = CASE WHEN $10::boolean THEN $11::timestamptz ELSE next_at END, customized = true, seq = seq + 1, updated_by = $12, updated_at = now()
      WHERE org_id = $1 AND id = $2 RETURNING ${COLS}`,
    [orgId, cur.id, f.label !== undefined ? f.label : cur.label, cron,
     f.assets !== undefined ? f.assets?.area ?? null : cur.assets?.area ?? null, f.assets !== undefined ? f.assets?.keys ?? null : cur.assets?.keys ?? null,
     f.environment !== undefined ? f.environment : cur.environment, JSON.stringify(f.scope ?? cur.scope), f.enabled ?? cur.enabled,
     fresh, nextOf(cron, now), by]));
  if (!r) throw new PackError("no such schedule", 404);
  return view(r);
}

/** Remove one of the workspace's own schedules (a pack's default is turned off instead, never removed). */
export async function deleteSchedule(orgId: number, id: string): Promise<boolean> {
  const cur = await getSchedule(orgId, id);
  if (!cur) return false;
  if (cur.is_default) throw new PackError("a pack's default schedule cannot be removed: turn it off instead", 409);
  const rows = await asPlatform(async () => (await getDb()).query("DELETE FROM workspace_schedules WHERE org_id = $1 AND id = $2 AND NOT is_default RETURNING id", [orgId, cur.id]));
  return rows.length > 0;
}

export async function getSchedule(orgId: number, id: string): Promise<ScheduleView | null> {
  if (!/^\d{1,18}$/.test(String(id))) return null;
  const [r] = await withTenant(orgId, async () => (await getDb()).query<Row>(`SELECT ${COLS} FROM workspace_schedules WHERE org_id = $1 AND id = $2`, [orgId, String(id)]));
  return r ? view(r) : null;
}

// ---------- the tick ----------

export interface TickReport { at: string; defaults: number; due: number; fired: number; runs: number; skipped_slots: number; lost: number; errors: number }

/** One target of a firing: an asset record of the schedule's own workspace, or the workspace itself. */
type Target = Record<string, unknown>;

async function targetsOf(s: Row): Promise<{ targets: Target[]; note: string | null }> {
  const env = s.environment ? { environment: s.environment } : {};
  if (!s.asset_area) return { targets: [{ ...env }], note: null };
  const area = findArea(s.asset_area);
  if (!area || area.pack !== s.pack || area.role !== "asset") return { targets: [], note: `asset area ${s.asset_area} is not in this build` };
  const { found, missing } = await assetKeys(s.org_id, area, s.asset_keys);
  const note = missing.length ? `no ${area.name} record ${missing.slice(0, 3).join(", ")} in this workspace` : found.length > 50 ? "only the first 50 records" : null;
  return { targets: found.slice(0, 50).map((key) => ({ asset: { area: area.name, key }, ...env })), note };
}

/** The asset key a run targets, for "is the previous run of this target still going". */
const targetKey = (t: Record<string, unknown> | null | undefined) => {
  const a = (t ?? {}).asset as { key?: unknown } | undefined;
  return `${typeof a?.key === "string" ? a.key : ""}\u0000${typeof (t ?? {}).environment === "string" ? (t ?? {}).environment : ""}`;
};

/** Start the runs of one firing (its row already moved on). Never throws: what went wrong is the row's last_error. */
async function fire(s: Row): Promise<{ runs: string[]; error: string | null }> {
  const errors: string[] = [];
  const runs: string[] = [];
  try {
    if (!findKind(s.pack, s.job_kind)) return { runs, error: `job kind ${s.pack}/${s.job_kind} is not in this build` };
    const { targets, note } = await targetsOf(s);
    if (note) errors.push(note);
    const by = `schedule:${s.id}`;
    // A target whose previous run from this schedule has not ended is not started again (a slow run never piles up).
    const live = new Set((await asPlatform(async () => (await getDb()).query<{ targets: Record<string, unknown> }>(
      "SELECT targets FROM runs WHERE org_id = $1 AND requested_by = $2 AND status IN ('queued', 'running')", [s.org_id, by]))).map((r) => targetKey(r.targets)));
    for (const t of targets) {
      if (live.has(targetKey(t))) { errors.push(`the previous run for ${targetKey(t).split("\u0000")[0] || "the workspace"} is still going`); continue; }
      try { runs.push((await startRun(s.org_id, s.pack, s.job_kind, { scope: s.scope ?? {}, targets: t }, by)).id); }
      catch (e) { errors.push(e instanceof PackError ? e.message : `could not start: ${(e as Error).message}`); if (e instanceof PackError && e.status === 429) break; }
    }
  } catch (e) { errors.push(`could not start: ${(e as Error).message}`); }
  return { runs, error: errors.length ? [...new Set(errors)].join("; ").slice(0, 1000) : null };
}

/**
 * Start every due schedule's runs, once. `now` is the scheduler's clock. Of the due times a row has missed since the
 * last tick, only the latest runs; the row's next due time is the first match after `now`.
 */
export async function tickSchedules(now = clock(), opts: { limit?: number } = {}): Promise<TickReport> {
  const report: TickReport = { at: now.toISOString(), defaults: 0, due: 0, fired: 0, runs: 0, skipped_slots: 0, lost: 0, errors: 0 };
  if (!schedulesWired()) return report;
  report.defaults = await ensureDefaults(now);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 200), 1), 1000);
  const due = await asPlatform(async () => (await getDb()).query<Row>(
    `/* tenant: platform scheduler across workspaces; each row keeps its own org_id */ SELECT ${COLS} FROM workspace_schedules
      WHERE enabled AND next_at <= $1::timestamptz ORDER BY next_at, id LIMIT $2`, [now, limit]));
  report.due = due.length;
  for (const s of due) {
    let slot: Date, next: Date, skipped: number, bad: string | null = null;
    try {
      const c = parseCron(s.cron);
      slot = latestAtOrBefore(c, now) ?? new Date(s.next_at);
      if (slot.getTime() < new Date(s.next_at).getTime()) slot = new Date(s.next_at);
      skipped = countBetween(c, new Date(new Date(s.next_at).getTime() - 1), slot);
      next = nextAfter(c, now) ?? NEVER;
    } catch (e) { bad = `cron: ${(e as Error).message}`; slot = new Date(s.next_at); skipped = 0; next = NEVER; }
    // The compare-and-set: only the tick that moves this row on (its seq unchanged since it was read) starts its runs.
    const [won] = await asPlatform(async () => (await getDb()).query<{ seq: number }>(
      `UPDATE workspace_schedules SET next_at = $4::timestamptz, seq = seq + 1, last_slot_at = $5::timestamptz, last_fired_at = $6::timestamptz,
              last_skipped = $7, last_runs = '{}', last_error = $8, enabled = enabled AND $4::timestamptz < $9::timestamptz, updated_at = now()
        WHERE id = $1 AND org_id = $2 AND seq = $3 AND enabled AND next_at <= $6::timestamptz RETURNING seq`,
      [s.id, s.org_id, s.seq, next, slot, now, skipped, bad, NEVER]));
    if (!won) { report.lost++; continue; }
    report.fired++;
    report.skipped_slots += skipped;
    if (bad) { report.errors++; continue; }
    const out = await fire(s);
    report.runs += out.runs.length;
    if (out.error) report.errors++;
    await asPlatform(async () => (await getDb()).query(
      "UPDATE workspace_schedules SET last_runs = $3, last_error = $4 WHERE id = $1 AND org_id = $2 AND seq = $5",
      [s.id, s.org_id, out.runs, out.error, won.seq]));
  }
  return report;
}

// ---------- the daily due-date check ----------

export interface DueReport { ran: boolean; reason?: string; day: string; areas: number; found: number; posted: number; emailed: number; email_failed: number }

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));
const realDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && dayOf(new Date(`${s}T00:00:00Z`)) === s;

/**
 * Once a UTC day: post a notice for every workspace record of a due area whose date is within its window (today to
 * today + within_days), and email each workspace's people with the area's notify roles the notices not yet emailed.
 * A notice is posted once per record and due date; it is emailed until an email reached every recipient.
 */
export async function dueCheck(now = clock(), opts: { force?: boolean } = {}): Promise<DueReport> {
  const day = dayOf(now);
  const report: DueReport = { ran: false, day, areas: 0, found: 0, posted: 0, emailed: 0, email_failed: 0 };
  const areas = dueAreas();
  if (!areas.length) return { ...report, reason: "no record area declares due dates" };
  const db = await getDb();
  if (!opts.force) {
    const [mark] = await asPlatform(() => db.query(
      `INSERT INTO scheduler_marks (name, day, at) VALUES ('due_check', $1, $2) ON CONFLICT (name) DO UPDATE SET day = excluded.day, at = excluded.at
        WHERE scheduler_marks.day < excluded.day RETURNING name`, [day, now]));
    if (!mark) return { ...report, reason: "already ran today" };
  }
  report.ran = true;
  report.areas = areas.length;
  const mail = await import("./email.js");
  for (const a of areas) {
    const hi = addDays(day, a.due.within_days);
    const rows = await asPlatform(() => db.query<{ org_id: number; key: string; title: string | null; due_on: string }>(
      `/* tenant: platform due-date check across workspaces; each row keeps its own org_id */ SELECT org_id, key, title, substr(data->>$3, 1, 10) AS due_on
         FROM workspace_records WHERE pack = $1 AND area = $2 AND NOT sealed AND substr(data->>$3, 1, 10) BETWEEN $4 AND $5
        ORDER BY org_id, due_on, key LIMIT 20000`, [a.pack, a.name, a.due.field, day, hi]));
    for (const r of rows) {
      if (!realDay(r.due_on)) continue;
      report.found++;
      const posted = await asPlatform(() => db.query(
        `INSERT INTO workspace_notices (org_id, kind, pack, area, record_key, title, due_on, created_at) VALUES ($1, 'due', $2, $3, $4, $5, $6, $7)
         ON CONFLICT (org_id, kind, pack, area, record_key, due_on) DO NOTHING RETURNING id`,
        [r.org_id, a.pack, a.name, r.key, typeof r.title === "string" ? r.title.slice(0, 300) : null, r.due_on, now]));
      report.posted += posted.length;
    }
    // Email: per workspace, the notices of this area still due and not yet emailed (a failure is tried again tomorrow).
    const pending = await asPlatform(() => db.query<{ id: string; org_id: number; record_key: string; title: string | null; due_on: string | Date }>(
      `/* tenant: platform due-date email across workspaces; grouped by each row's own org_id */ SELECT id, org_id, record_key, title, due_on FROM workspace_notices
        WHERE kind = 'due' AND pack = $1 AND area = $2 AND emailed_at IS NULL AND dismissed_at IS NULL AND due_on >= $3::date AND due_on <= $4::date
        ORDER BY org_id, due_on, record_key`, [a.pack, a.name, day, hi]));
    const byOrg = new Map<number, typeof pending>();
    for (const n of pending) byOrg.set(n.org_id, [...(byOrg.get(n.org_id) ?? []), n]);
    for (const [orgId, list] of byOrg) {
      const items = list.map((n) => ({ key: n.record_key, title: n.title, due_on: typeof n.due_on === "string" ? n.due_on.slice(0, 10) : dayOf(new Date(n.due_on)) }));
      const out = await mail.dueSoon(orgId, { area: a.name, label: a.label, within_days: a.due.within_days, roles: a.due.notify, day, items });
      if (out.recipients > 0 && out.delivered === out.recipients) {
        await asPlatform(() => db.query("UPDATE workspace_notices SET emailed_at = $3 WHERE org_id = $1 AND id = ANY ($2::bigint[])", [orgId, list.map((n) => n.id), now]));
        report.emailed += out.recipients;
      } else report.email_failed += out.recipients - out.delivered;
    }
  }
  return report;
}

// ---------- notices (the console) ----------

export interface NoticeView { id: string; kind: "due"; area: string; area_label: string; key: string; title: string | null; due_on: string; created_at: string; emailed: boolean; dismissed: boolean }

export async function listNotices(orgId: number, opts: { all?: boolean } = {}): Promise<NoticeView[]> {
  const rows = await withTenant(orgId, async () => (await getDb()).query<{ id: string; kind: "due"; area: string; record_key: string; title: string | null;
    due_on: string | Date; created_at: Date; emailed_at: Date | null; dismissed_at: Date | null }>(
    `SELECT id, kind, area, record_key, title, due_on, created_at, emailed_at, dismissed_at FROM workspace_notices
      WHERE org_id = $1 AND ($2 OR dismissed_at IS NULL) ORDER BY due_on, id LIMIT 500`, [orgId, !!opts.all]));
  return rows.map((r) => ({ id: String(r.id), kind: r.kind, area: r.area, area_label: findArea(r.area)?.label ?? r.area, key: r.record_key, title: r.title,
    due_on: typeof r.due_on === "string" ? r.due_on.slice(0, 10) : dayOf(new Date(r.due_on)), created_at: iso(r.created_at)!, emailed: !!r.emailed_at, dismissed: !!r.dismissed_at }));
}

export async function dismissNotice(orgId: number, id: string, by: string): Promise<boolean> {
  if (!/^\d{1,18}$/.test(String(id))) return false;
  const rows = await asPlatform(async () => (await getDb()).query(
    "UPDATE workspace_notices SET dismissed_at = coalesce(dismissed_at, now()), dismissed_by = coalesce(dismissed_by, $3) WHERE org_id = $1 AND id = $2 RETURNING id", [orgId, String(id), by]));
  return rows.length > 0;
}

// ---------- both, from the cron entry and the server's loop ----------

export async function schedulerTick(now = clock()): Promise<{ schedules: TickReport; due: DueReport }> {
  const schedules = await tickSchedules(now);
  const due = await dueCheck(now);
  return { schedules, due };
}

let timer: NodeJS.Timeout | null = null;
let busy = false;
/** The server's loop: a tick every minute (Vercel has no loop: its cron entry ticks). */
export function startScheduler(everyMs = 60_000): boolean {
  if (timer || (process.env.OCTILLION_SCHEDULER ?? "on").toLowerCase() === "off") return false;
  if (!schedulesWired() && !dueAreas().length) return false;
  const run = () => {
    if (busy) return;
    busy = true;
    schedulerTick().then((r) => {
      if (r.schedules.fired || r.due.ran) console.error(`scheduler: ${r.schedules.fired} schedule(s) fired, ${r.schedules.runs} run(s) started${r.due.ran ? `; due check: ${r.due.posted} notice(s), ${r.due.emailed} email(s)` : ""}`);
    }).catch((e) => console.error("scheduler tick:", (e as Error).message)).finally(() => { busy = false; });
  };
  timer = setInterval(run, everyMs);
  timer.unref();
  setTimeout(run, 5_000).unref();
  return true;
}
export function stopScheduler() { if (timer) clearInterval(timer); timer = null; }

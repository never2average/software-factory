/**
 * Clocks on a workspace area's records: deadlines, reminders and escalation (mold_v0-191; molds/mold_v0/MOLD.md
 * "Clocks, reminders and escalation"). Declared in pack.json (record_areas[].clocks, src/pack-api.ts ClockSchema), with
 * no pack code; the math is src/clock-math.ts; tables sql/migrations/0032_record_clocks.sql.
 *
 *   reads        withClocks: every page and record of a clock area (/api/records, the data API, the record tools and the
 *                generated MCP tools: src/record-areas.ts listFor/getFor) carries `clocks` {name: due_at, status,
 *                overdue, ...}, computed at the read from the record and what the shell remembered of it
 *   the check    clockCheck(now), from the scheduler's tick (src/schedules.ts schedulerTick) at most every
 *                CHECK_EVERY_MS: one workspace at a time, inside that workspace's tenant scope (row-level security: its
 *                own records, clock rows and events only), each record's clock observed, its memory kept, every change
 *                and every reminder or escalation step recorded once per record and deadline (the event's unique key:
 *                two checks at once do a step once). A step tells people through the shell's in-app notices
 *                (workspace_notices kind 'clock') and its email adapter only (src/email.ts clockSteps: the profile's
 *                due_dates group); it reassigns or raises through the record store (the area's fields and lifecycle
 *                rules, as the shell)
 *   the tool     list_due_records (with at least one clock area): a workspace's records by clock status, soonest first
 *   the card     dueAcross (mold_v0-207): the home page's Due soon card, every clock area the person may read at once
 *
 * Sealed areas: their rows are opened with the workspace's own key inside its scope, never in SQL; a notice keeps the
 * title sealed and an email names the record by its key. With the key vault locked a sealed area is skipped and counted.
 */
import { z } from "zod";
import type { AccountRole } from "./account-roles.js";
import { CLOCK_STATUSES, observe, parseDuration, raised, stepsDue, type ClockMemory, type ClockRecord, type ClockStatus, type ClockView } from "./clock-math.js";
import { getDb, type Db, type Queryable } from "./db.js";
import { vaultUnlocked } from "./keyvault.js";
import { isSealed, open, openJson, seal } from "./orgcrypto.js";
import { optionValues, PackError, type Clock, type PackTool, type RecordRow, type Workspace } from "./pack-api.js";
import { getFor, isSealedArea, may, recordAreas, STATE_TIMES, SYSTEM_ACTOR, workspaceRecords, type Actor, type RecordArea } from "./record-areas.js";
import { asPlatform, withTenant } from "./tenant-scope.js";
import { featureOn, featureSetting } from "./features.js";

export type ClockArea = RecordArea & { clocks: Clock[] };
/** The workspace areas that declare clocks; none while the features registry's record_clocks flag is off (mold_v0-219). */
export const clockAreas = (): ClockArea[] => (featureSetting("record_clocks") ? recordAreas().filter((a): a is ClockArea => a.scope === "workspace" && (a.clocks?.length ?? 0) > 0) : []);
/** Whether the clocks' reminders and escalation steps run (mold_v0-219: the scheduled_alerts flag). */
export const clockStepsOn = () => featureOn("scheduled_alerts");
export const findClockArea = (name: string) => clockAreas().find((a) => a.name === name) ?? null;

/** The clocks' clock: the wall clock, or one a test sets. */
let nowFn: () => Date = () => new Date();
export const clockNow = () => nowFn();
/** Tests only: drive the time reads and the check see (null: the wall clock again). */
export function setClockNowForTest(fn: (() => Date) | null) { nowFn = fn ?? (() => new Date()); }

/** The check runs at most this often (each tick on a server is a minute; on Vercel five). */
export const CHECK_EVERY_MS = 15 * 60_000;
/** Rows of one area opened at a time by the check (every row is read, few are held). */
const PAGE = 500;
/** At most this many records of one area are read by list_due_records (as a sealed area's filter, src/record-areas.ts). */
const SCAN_MAX = 5000;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
type Mem = ClockMemory & { status: string; due_at: string | null };
const memKey = (key: string, clock: string) => `${key}\u0000${clock}`;

/** What the shell remembered of an area's clocks in one workspace (inside its tenant scope), for some keys or all. */
async function memories(db: Queryable, orgId: number, area: RecordArea, keys: string[] | null): Promise<Map<string, Mem>> {
  const rows = await db.query<{ record_key: string; clock: string; status: string; due_at: Date | string | null; paused_ms: string | number; paused_since: Date | string | null; stopped_at: Date | string | null }>(
    `SELECT record_key, clock, status, due_at, paused_ms, paused_since, stopped_at FROM workspace_record_clocks
      WHERE org_id = $1 AND pack = $2 AND area = $3 AND ($4::text[] IS NULL OR record_key = ANY ($4::text[]))`, [orgId, area.pack, area.name, keys]);
  return new Map(rows.map((r) => [memKey(r.record_key, r.clock), { status: r.status, due_at: iso(r.due_at), paused_ms: Number(r.paused_ms), paused_since: iso(r.paused_since), stopped_at: iso(r.stopped_at) }]));
}
const recordOf = (area: RecordArea, data: Record<string, unknown>, created_at: Date | string | null): ClockRecord => ({
  data, created_at: iso(created_at),
  state_at: data[STATE_TIMES] && typeof data[STATE_TIMES] === "object" ? (data[STATE_TIMES] as Record<string, unknown>) : undefined,
  lifecycle_field: area.lifecycle?.field ?? null,
});

/** Every clock of the records on a page, as of `now` (records the page holds that the table does not, a live area's: left as they are). */
export async function withClocks(orgId: number, area: RecordArea, records: RecordRow[], now = clockNow()): Promise<RecordRow[]> {
  const clocks = area.clocks ?? [];
  if (!clocks.length || area.scope !== "workspace" || !records.length) return records;
  return withTenant(orgId, async () => {
    const db = await getDb();
    const keys = records.map((r) => r.key);
    const rows = await db.query<{ key: string; data: unknown; created_at: Date | string }>(
      "SELECT key, data, created_at FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = ANY ($4::text[])", [orgId, area.pack, area.name, keys]);
    const mem = await memories(db, orgId, area, keys);
    const raw = new Map<string, ClockRecord>();
    for (const r of rows) {
      // A row that will not open (the vault locked, damaged ciphertext) shows no clock, never a wrong one.
      try { raw.set(r.key, recordOf(area, await openJson(orgId, r.data), r.created_at)); } catch { /* left without clocks */ }
    }
    return records.map((rec) => {
      const r = raw.get(rec.key);
      if (!r) return rec;
      return { ...rec, clocks: Object.fromEntries(clocks.map((c) => [c.name, observe(c, r, mem.get(memKey(rec.key, c.name)) ?? null, now).view])) };
    });
  });
}

/** A record's clock events, newest first (the record page's history), inside its workspace's scope. */
export async function clockEvents(orgId: number, area: RecordArea, key: string, limit = 50) {
  if (!(area.clocks?.length)) return [];
  return withTenant(orgId, async () => (await (await getDb()).query<{ clock: string; step: string; due_at: Date | null; detail: Record<string, unknown>; at: Date }>(
    `SELECT clock, step, due_at, detail, at FROM workspace_clock_events WHERE org_id = $1 AND pack = $2 AND area = $3 AND record_key = $4 ORDER BY at DESC, id DESC LIMIT $5`,
    [orgId, area.pack, area.name, key, limit])).map((e) => ({ clock: e.clock, label: area.clocks!.find((c) => c.name === e.clock)?.label ?? e.clock, step: e.step,
    what: stepWords(area, e.clock, e.step, e.detail), due_at: iso(e.due_at), at: iso(e.at)! })));
}

/** A step in words (the history, a notice): "Reminder", "Escalated: told Owner", "Raised Severity to high". */
export function stepWords(area: RecordArea, clock: string, step: string, detail: Record<string, unknown> = {}): string {
  const c = area.clocks?.find((x) => x.name === clock);
  const fieldLabel = (n: unknown) => area.fields.find((f) => f.name === n)?.label ?? String(n);
  const parts: string[] = [];
  const [kind, i] = step.split(":");
  if (kind === "remind") parts.push(`Reminder: due ${c?.remind?.[Number(i)]?.before ? `within ${c.remind[Number(i)]!.before}` : "soon"}`);
  else if (kind === "escalate") parts.push(c?.escalate?.[Number(i)]?.label ?? `Overdue${Number(i) > 0 ? ` (step ${Number(i) + 1})` : ""}`);
  else parts.push({ started: "Clock started", paused: "Clock paused", resumed: "Clock resumed", stopped: "Clock stopped", reopened: "Clock running again" }[kind!] ?? step);
  const told = Array.isArray(detail.told) ? (detail.told as string[]) : [];
  if (told.length) parts.push(`told ${told.join(", ")}`);
  const ch = (k: "reassigned" | "raised") => detail[k] as { field?: string; to?: unknown } | undefined;
  if (ch("reassigned")) parts.push(`reassigned ${fieldLabel(ch("reassigned")!.field)}`);
  if (ch("raised")) parts.push(`raised ${fieldLabel(ch("raised")!.field)} to ${String(ch("raised")!.to)}`);
  if (detail.skipped) parts.push(`not sent (${String(detail.skipped)})`);
  return parts.join("; ");
}

// ---------- the check ----------

export interface ClockReport {
  ran: boolean; reason?: string; areas: number; workspaces: number; records: number;
  /** Clock rows written (something changed), changes recorded, steps done, notices raised, emails that reached someone. */
  updated: number; changes: number; steps: number; notices: number; emailed: number;
  /** Records reassigned or raised by a step. */
  actions: number;
  /** Workspaces' sealed areas left for the next check (the key vault locked); rows that would not open. */
  sealed_skipped: number; unreadable: number; errors: number;
}

/** A step to tell people about, gathered per workspace for one email per person. */
interface Told { event: string; area: ClockArea; key: string; title: string | null; clock: Clock; step: string; what: string; due_on: string; roles: AccountRole[]; people: string[] }

/**
 * Evaluate every clock of every workspace (or one: `orgId`), at most every CHECK_EVERY_MS unless `force`. Idempotent:
 * a change or step already recorded for that record, clock and deadline is never done again.
 */
export async function clockCheck(now = clockNow(), opts: { force?: boolean; orgId?: number } = {}): Promise<ClockReport> {
  const report: ClockReport = { ran: false, areas: 0, workspaces: 0, records: 0, updated: 0, changes: 0, steps: 0, notices: 0, emailed: 0, actions: 0, sealed_skipped: 0, unreadable: 0, errors: 0 };
  const areas = clockAreas();
  if (!areas.length) return { ...report, reason: "no record area declares clocks" };
  const db = await getDb();
  if (!opts.force) {
    const [mark] = await asPlatform(() => db.query<{ at: Date | string }>("SELECT at FROM scheduler_marks WHERE name = 'record_clocks'"));
    if (mark && now.getTime() - new Date(mark.at).getTime() < CHECK_EVERY_MS) return { ...report, reason: "checked less than 15 minutes ago" };
  }
  report.ran = true;
  report.areas = areas.length;
  // Which workspaces hold records of a clock area: each is then read in its own tenant scope.
  const orgs = opts.orgId !== undefined ? [opts.orgId] : (await asPlatform(() => db.query<{ org_id: number }>(
    `/* tenant: platform clock check, which workspaces hold records of the clock areas; each is then read in its own scope */ SELECT DISTINCT org_id
       FROM workspace_records WHERE (pack, area) IN (SELECT * FROM unnest($1::text[], $2::text[])) ORDER BY org_id`,
    [areas.map((a) => a.pack), areas.map((a) => a.name)]))).map((r) => r.org_id);
  for (const orgId of orgs) {
    report.workspaces++;
    const told: Told[] = [];
    for (const area of areas) {
      if (isSealedArea(area) && !vaultUnlocked()) { report.sealed_skipped++; continue; }
      try { await checkArea(orgId, area, now, report, told); }
      catch (e) {
        // Never the message: an error while a sealed row is open must not carry its value into a log.
        report.errors++;
        console.error(`clock check: ${area.name} in workspace ${orgId} failed (${(e as { code?: string }).code ?? (e as Error).name})`);
      }
    }
    if (told.length) await tell(orgId, told, now, report);
  }
  if (!opts.force && opts.orgId === undefined) await asPlatform(() => db.query(
    `INSERT INTO scheduler_marks (name, day, at) VALUES ('record_clocks', $1, $2) ON CONFLICT (name) DO UPDATE SET day = excluded.day, at = excluded.at
      WHERE scheduler_marks.at < excluded.at`, [now.toISOString().slice(0, 10), now]));
  return report;
}

/** One workspace's records of one clock area, in its own tenant scope. */
async function checkArea(orgId: number, area: ClockArea, now: Date, report: ClockReport, told: Told[]) {
  await withTenant(orgId, async () => {
    const db = await getDb();
    const mem = await memories(db, orgId, area, null);
    for (let after = "0"; ;) {
      const page = await db.query<{ id: string; key: string; title: string | null; data: unknown; created_at: Date | string }>(
        "SELECT id, key, title, data, created_at FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND id > $4 ORDER BY id LIMIT $5",
        [orgId, area.pack, area.name, after, PAGE]);
      for (const row of page) {
        let rec: ClockRecord;
        try { rec = recordOf(area, await openJson(orgId, row.data), row.created_at); } catch { report.unreadable++; continue; }
        report.records++;
        for (const c of area.clocks) await checkRecord(db, orgId, area, c, row, rec, mem.get(memKey(row.key, c.name)) ?? null, now, report, told);
      }
      if (page.length < PAGE) break;
      after = String(page[page.length - 1]!.id);
    }
  });
}

async function checkRecord(db: Queryable, orgId: number, area: ClockArea, c: Clock, row: { key: string; title: string | null }, rec: ClockRecord, prev: Mem | null,
  now: Date, report: ClockReport, told: Told[]) {
  const o = observe(c, rec, prev, now);
  const v = o.view;
  const same = prev && prev.status === v.status && prev.due_at === v.due_at && prev.paused_ms === o.memory.paused_ms
    && prev.paused_since === o.memory.paused_since && prev.stopped_at === o.memory.stopped_at;
  // An embedded app's clock.overdue event (mold_v0-193, src/developer-webhooks.ts emitEvent): once per record, clock and
  // deadline, written to the outbox in the transaction that records the clock as overdue (mold_v0-202); nothing is
  // written unless the app declares the event (a tool app has no developer surface).
  const overdue = prev?.status !== "overdue" && v.status === "overdue";
  const hooks = overdue ? await import("./developer-webhooks.js") : null;
  const event = hooks?.declaredEvents().includes("clock.overdue") ? hooks : null;
  const write = async (q: Queryable) => {
    await q.query(
      `INSERT INTO workspace_record_clocks (org_id, pack, area, record_key, clock, status, started_at, due_at, paused_ms, paused_since, stopped_at, evaluated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (org_id, pack, area, record_key, clock) DO UPDATE SET status = excluded.status, started_at = excluded.started_at, due_at = excluded.due_at,
         paused_ms = excluded.paused_ms, paused_since = excluded.paused_since, stopped_at = excluded.stopped_at, evaluated_at = excluded.evaluated_at`,
      [orgId, area.pack, area.name, row.key, c.name, v.status, v.started_at, v.due_at, o.memory.paused_ms, o.memory.paused_since, o.memory.stopped_at, now]);
    if (event) await event.emitEvent(orgId, "clock.overdue", { area: area.name, key: row.key, clock: c.name, due_at: v.due_at },
      `clock.overdue:${area.name}:${row.key}:${c.name}:${v.due_at}`, q);
  };
  if (!same) {
    if (event) { await (db as Db).transaction(write); void event.kick(); }
    else await write(db);
    report.updated++;
  }
  // Each change once, keyed by when it happened.
  const markOf: Record<string, string | null> = { started: v.started_at, paused: o.memory.paused_since, stopped: v.stopped_at, resumed: now.toISOString(), reopened: now.toISOString() };
  for (const ch of o.changes) {
    const got = await db.query(
      `INSERT INTO workspace_clock_events (org_id, pack, area, record_key, clock, step, mark, due_at, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (org_id, pack, area, record_key, clock, step, mark) DO NOTHING RETURNING id`,
      [orgId, area.pack, area.name, row.key, c.name, ch, markOf[ch] ?? now.toISOString(), v.due_at, now]);
    report.changes += got.length;
  }
  // The steps (reminders, escalation) are the scheduled_alerts flag's (mold_v0-219): off, the clock keeps its status only.
  const due = clockStepsOn() ? stepsDue(c, v, now) : [];
  if (!due.length) return;
  // Steps due at once (a record first seen long overdue): every one is recorded and its changes made; only the latest
  // tells people (the others say so), so nobody gets a pile of old reminders.
  const before = (i: number) => parseDuration(c.remind![i]!.before).ms;
  const latest = due.reduce((best, s) => (s.kind === "remind" ? (before(s.index) < before(best.index) ? s : best) : (s.index > best.index ? s : best)));
  for (const s of due) {
    const step = s.kind === "remind" ? c.remind![s.index]! : c.escalate![s.index]!;
    const notify = (step.notify ?? c.notify ?? ["owner"]) as string[];
    const tells = s.id === latest.id;
    // What the step changes (reassign, raise) is worked out first and recorded with it: the event is the step's one record.
    const detail: Record<string, unknown> = tells ? { told: notify } : { told: [], skipped: "a later step was due" };
    const plan = s.kind === "escalate" ? await planAction(orgId, area, row.key, c.escalate![s.index]!, detail) : null;
    // Each step once per record and deadline (the event's unique key: two checks at once do it once, its changes too).
    const [ev] = await db.query<{ id: string }>(
      `INSERT INTO workspace_clock_events (org_id, pack, area, record_key, clock, step, mark, due_at, detail, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (org_id, pack, area, record_key, clock, step, mark) DO NOTHING RETURNING id`,
      [orgId, area.pack, area.name, row.key, c.name, s.id, v.due_at, v.due_at, JSON.stringify(detail), now]);
    if (!ev) continue; // done before
    report.steps++;
    if (plan) {
      try { await plan(); report.actions++; }
      catch (err) {
        // Refused by the record store (a field's rule, the vault locked): recorded beside the step, never retried.
        await db.query(
          `INSERT INTO workspace_clock_events (org_id, pack, area, record_key, clock, step, mark, due_at, detail, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (org_id, pack, area, record_key, clock, step, mark) DO NOTHING`,
          [orgId, area.pack, area.name, row.key, c.name, `${s.id}:failed`, v.due_at, v.due_at, JSON.stringify({ status: (err as { status?: number }).status ?? null }), now]);
      }
    }
    if (!tells) continue;
    const people = notify.includes("assignee") && c.assignee ? [rec.data[c.assignee]].filter((x): x is string => typeof x === "string" && x.length > 0) : [];
    // An escalation that reassigned tells the new assignee too.
    const r = detail.reassigned as { to?: unknown } | undefined;
    if (r && typeof r.to === "string" && notify.includes("assignee")) people.push(r.to);
    told.push({ event: ev.id, area, key: row.key, title: row.title, clock: c, step: s.id, what: stepWords(area, c.name, s.id, detail), due_on: v.due_on!,
      roles: notify.filter((x): x is AccountRole => x !== "assignee"), people: [...new Set(people)] });
  }
}

/**
 * An escalation step's changes to the record (reassign, raise), worked out from the record as it is: written into
 * `detail`, and returned as the write to make (through the record store, as the shell), or null when nothing changes.
 */
async function planAction(orgId: number, area: ClockArea, key: string, e: NonNullable<Clock["escalate"]>[number], detail: Record<string, unknown>): Promise<(() => Promise<unknown>) | null> {
  if (!e.reassign && !e.raise) return null;
  const rec = await getFor(orgId, area.name, key);
  if (!rec) return null;
  const data = { ...rec.data };
  if (e.reassign) {
    const to = data[e.reassign.from_field];
    if (typeof to === "string" && to && to !== data[e.reassign.field]) { detail.reassigned = { field: e.reassign.field, from: data[e.reassign.field] ?? null, to }; data[e.reassign.field] = to; }
  }
  if (e.raise) {
    const f = area.fields.find((x) => x.name === e.raise!.field)!;
    const next = raised(optionValues(f), data[f.name], e.raise.to);
    if (next !== null) { detail.raised = { field: f.name, from: data[f.name] ?? null, to: next }; data[f.name] = next; }
  }
  if (!detail.reassigned && !detail.raised) return null;
  return () => workspaceRecords(area.pack, orgId, SYSTEM_ACTOR).update(area.name, key, { title: rec.title, data });
}

/** One workspace's steps: a notice per record and deadline (raised again by each step), then one email per person. */
async function tell(orgId: number, told: Told[], now: Date, report: ClockReport) {
  const db = await getDb();
  for (const t of told) {
    // A sealed area's title is sealed again with the workspace's key for the notice (opened only when it lists them).
    const sealed = isSealedArea(t.area);
    const title = t.title === null ? null : sealed ? await withTenant(orgId, async () => {
      const plain = isSealed(t.title) ? await open(orgId, t.title!) : t.title!;
      const s = await seal(orgId, plain.slice(0, 300));
      return isSealed(s) ? s : null;
    }).catch(() => null) : t.title.slice(0, 300);
    const got = await asPlatform(() => db.query(
      `INSERT INTO workspace_notices (org_id, kind, pack, area, record_key, title, due_on, created_at) VALUES ($1, 'clock', $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, kind, pack, area, record_key, due_on) DO UPDATE SET created_at = excluded.created_at, dismissed_at = NULL, dismissed_by = NULL, emailed_at = NULL
       RETURNING id`, [orgId, t.area.pack, t.area.name, t.key, title, t.due_on, now]));
    report.notices += got.length;
  }
  const mail = await import("./email.js");
  const out = await mail.clockSteps(orgId, told.map((t) => ({ event: t.event, area_label: t.area.label, key: t.key,
    title: isSealedArea(t.area) || isSealed(t.title) ? null : t.title, clock_label: t.clock.label, what: t.what, due_on: t.due_on, roles: t.roles, people: t.people })));
  report.emailed += out.delivered;
}

// ---------- the MCP tool ----------

/** The shell's clock tool (with at least one clock area): a workspace's records by their clocks' status, soonest first. */
export function clockTools(): PackTool[] {
  const areas = clockAreas();
  if (!areas.length) return [];
  const names = areas.map((a) => a.name) as [string, ...string[]];
  const catalog = areas.map((a) => `${a.name} (${a.label}: ${a.clocks.map((c) => `${c.name} "${c.label}"`).join(", ")})`).join("; ");
  return [{
    name: "list_due_records",
    title: "List records by deadline",
    description: `Records of an area by their clock's deadline (due_at) and status (overdue, due_soon, on_track, paused, met, missed, not_started), soonest first. Default: overdue and due soon. Areas and clocks: ${catalog}.`,
    inputSchema: {
      area: z.enum(names).describe("The record area"),
      clock: z.string().max(64).optional().describe("The clock (default the area's first)"),
      status: z.array(z.enum(CLOCK_STATUSES)).min(1).max(7).optional().describe("The statuses to list (default overdue and due_soon)"),
      limit: z.number().int().min(1).max(200).optional().describe("Records at most (default 50)"),
    },
    annotations: { title: "List records by deadline", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (ws: Workspace, args: { area: string; clock?: string; status?: ClockStatus[]; limit?: number }) =>
      dueRecords(ws.id, args.area, { clock: args.clock, status: args.status, limit: args.limit }, { role: ws.role, userId: ws.userId }),
  } as unknown as PackTool];
}

/** A workspace's records of a clock area whose clock is in `status`, soonest deadline first (the tool, and tests). */
export async function dueRecords(orgId: number, areaName: string, opts: { clock?: string; status?: ClockStatus[]; limit?: number } = {}, actor: Actor = SYSTEM_ACTOR, now = clockNow()) {
  const area = findClockArea(areaName);
  if (!area) throw new PackError(`no clock on area ${String(areaName).slice(0, 64)}`, 404);
  if (!may(area, "read", actor)) throw new PackError(`Your role can't read ${area.label}.`, 403);
  const c = opts.clock === undefined ? area.clocks[0]! : area.clocks.find((x) => x.name === opts.clock);
  if (!c) throw new PackError(`area ${area.name} has no clock ${String(opts.clock).slice(0, 64)}: ${area.clocks.map((x) => x.name).join(", ")}`, 400);
  const want = new Set(opts.status ?? ["overdue", "due_soon"]);
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  if (isSealedArea(area) && !vaultUnlocked()) throw new PackError(`${area.label} records are sealed and the key vault is locked`, 503);
  return withTenant(orgId, async () => {
    const db = await getDb();
    const rows = await db.query<{ key: string; title: string | null; data: unknown; created_at: Date | string }>(
      "SELECT key, title, data, created_at FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 ORDER BY id DESC LIMIT $4", [orgId, area.pack, area.name, SCAN_MAX + 1]);
    const mem = await memories(db, orgId, area, null);
    const hit: { key: string; title: string | null; view: ClockView }[] = [];
    for (const r of rows.slice(0, SCAN_MAX)) {
      let rec: ClockRecord;
      try { rec = recordOf(area, await openJson(orgId, r.data), r.created_at); } catch { continue; }
      const view = observe(c, rec, mem.get(memKey(r.key, c.name)) ?? null, now).view;
      if (want.has(view.status)) hit.push({ key: r.key, title: r.title, view });
    }
    hit.sort((a, b) => (a.view.due_at ?? "9").localeCompare(b.view.due_at ?? "9") || a.key.localeCompare(b.key));
    const shown = hit.slice(0, limit);
    const titles = await Promise.all(shown.map((h) => (isSealed(h.title) ? open(orgId, h.title!).catch(() => null) : Promise.resolve(h.title))));
    return {
      area: area.name, label: area.label, clock: c.name, clock_label: c.label, as_of: now.toISOString(), total: hit.length, partial: rows.length > SCAN_MAX,
      records: shown.map((h, i) => ({ key: h.key, title: titles[i] ?? null, status: h.view.status, due_at: h.view.due_at, overdue: h.view.overdue, overdue_days: h.view.overdue_days })),
    };
  });
}

/** The rows the home page's Due soon card shows at most (mold_v0-207), and the most a caller may ask for. */
export const DUE_SOON_ROWS = 6;
const DUE_SOON_MAX = 50;
const RANK: Partial<Record<ClockStatus, number>> = { overdue: 0, due_soon: 1 };

/**
 * A workspace's records coming due or overdue across every clock area the person may read (mold_v0-207: the home
 * page's Due soon card, GET /api/records/due-soon): one row per record and clock that is overdue or due soon, overdue
 * first, then the soonest deadline. Each area is read inside the workspace's tenant scope (its own rows and clock
 * memory only), as list_due_records reads it; an area the role may not read, or whose list a pack withholds, is left
 * out, and a sealed area while the key vault is locked is skipped. `areas`: the clock areas this person may read (none:
 * the card has nothing it could ever show).
 */
export async function dueAcross(orgId: number, actor: Actor, opts: { limit?: number; withheld?: (area: string) => boolean } = {}, now = clockNow()) {
  const limit = Math.min(Math.max(1, Math.floor(Number(opts.limit) || DUE_SOON_ROWS)), DUE_SOON_MAX);
  const areas = clockAreas().filter((a) => may(a, "read", actor) && !opts.withheld?.(a.name));
  type Hit = { area: ClockArea; key: string; title: string | null; view: ClockView };
  const hit: Hit[] = [];
  let partial = false;
  const skipped: string[] = [];
  for (const area of areas) {
    if (isSealedArea(area) && !vaultUnlocked()) { skipped.push(area.name); continue; }
    await withTenant(orgId, async () => {
      const db = await getDb();
      const rows = await db.query<{ key: string; title: string | null; data: unknown; created_at: Date | string }>(
        "SELECT key, title, data, created_at FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 ORDER BY id DESC LIMIT $4", [orgId, area.pack, area.name, SCAN_MAX + 1]);
      if (rows.length > SCAN_MAX) partial = true;
      const mem = await memories(db, orgId, area, null);
      for (const r of rows.slice(0, SCAN_MAX)) {
        let rec: ClockRecord;
        try { rec = recordOf(area, await openJson(orgId, r.data), r.created_at); } catch { continue; }
        for (const c of area.clocks) {
          const view = observe(c, rec, mem.get(memKey(r.key, c.name)) ?? null, now).view;
          if (RANK[view.status] !== undefined) hit.push({ area, key: r.key, title: r.title, view });
        }
      }
    });
  }
  hit.sort((a, b) => RANK[a.view.status]! - RANK[b.view.status]! || (a.view.due_at ?? "9").localeCompare(b.view.due_at ?? "9")
    || a.area.name.localeCompare(b.area.name) || a.key.localeCompare(b.key) || a.view.name.localeCompare(b.view.name));
  const shown = hit.slice(0, limit);
  // A sealed title is opened with the workspace's own key, as list_due_records does (never stored opened).
  const titles = await Promise.all(shown.map((h) => (isSealed(h.title) ? open(orgId, h.title!).catch(() => null) : Promise.resolve(h.title))));
  return {
    as_of: now.toISOString(), total: hit.length, overdue: hit.filter((h) => h.view.status === "overdue").length, partial, skipped,
    areas: areas.map((a) => ({ name: a.name, label: a.label, clocks: a.clocks.map((c) => ({ name: c.name, label: c.label })) })),
    records: shown.map((h, i) => ({
      area: h.area.name, area_label: h.area.label, key: h.key, title: titles[i] ?? null, clock: h.view.name, clock_label: h.view.label,
      status: h.view.status, due_at: h.view.due_at, due_on: h.view.due_on, overdue: h.view.overdue, overdue_days: h.view.overdue_days,
    })),
  };
}

// ---------- metrics ----------

/**
 * Each record's status for one clock (a metric's `clock` filter, src/metrics.ts), from rows already opened in the
 * workspace's scope and what the shell remembered of them.
 */
export async function clockStatuses(orgId: number, area: Pick<RecordArea, "pack" | "name" | "clocks" | "lifecycle">, clock: string, rows: { key?: string; data: Record<string, unknown>; created_at: string }[], now = clockNow()): Promise<Map<string, ClockStatus>> {
  const c = area.clocks?.find((x) => x.name === clock);
  const out = new Map<string, ClockStatus>();
  if (!c) return out;
  const mem = await withTenant(orgId, async () => memories(await getDb(), orgId, area as RecordArea, null));
  for (const r of rows) if (r.key !== undefined) out.set(r.key, observe(c, recordOf(area as RecordArea, r.data, r.created_at), mem.get(memKey(r.key, clock)) ?? null, now).view.status);
  return out;
}

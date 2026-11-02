/**
 * Clock math (mold_v0-191; molds/mold_v0/MOLD.md "Clocks, reminders and escalation"): pure functions, no database, no
 * wall clock (every function takes `now`). A clock (src/pack-api.ts ClockSchema) gives each record of a workspace area a
 * deadline: its start plus a duration, moved out by the time it was paused, capped by a date field, stopped by a value.
 *
 *   calendar time   h and d: every millisecond counts
 *   business time   bd: only Monday to Friday (UTC) counts; a start or a pause on a weekend counts nothing until Monday
 *
 * What the shell has seen of a record between reads (when a pause began, the time paused before, when it stopped) is
 * its memory (workspace_record_clocks): `observe` takes the memory and the record as it is now and gives the clock's
 * view, the memory to keep and what changed. Reads use the same function and do not keep anything, so a page shows the
 * same state the scheduler records.
 */
import type { Clock } from "./pack-api.js";

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
const WEEK = 7 * DAY;
export type ClockKind = "calendar" | "business";

/** A duration as the clock counts it: milliseconds of its own kind of time. */
export function parseDuration(d: string): { ms: number; kind: ClockKind } {
  const m = /^(0|[1-9][0-9]{0,4})(h|d|bd)$/.exec(d);
  if (!m) throw new Error(`not a clock duration: ${JSON.stringify(d).slice(0, 40)}`);
  const n = Number(m[1]);
  return m[2] === "h" ? { ms: n * HOUR, kind: "calendar" } : m[2] === "d" ? { ms: n * DAY, kind: "calendar" } : { ms: n * DAY, kind: "business" };
}
/** A clock's kind of time (checked at build: every duration of one clock is the same kind). */
export function kindOf(c: Pick<Clock, "after">): ClockKind {
  const d = typeof c.after === "string" ? c.after : Object.values(c.after.values)[0] ?? c.after.default ?? "0d";
  return parseDuration(d).kind;
}

const weekend = (dayStart: number) => { const w = new Date(dayStart).getUTCDay(); return w === 0 || w === 6; };
const dayOf = (t: number) => Math.floor(t / DAY) * DAY;
/** The Monday 00:00 UTC on or before `t`. */
const mondayOf = (t: number) => { const d = dayOf(t); return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY; };

/** Business milliseconds from `a` to `b` (0 when b <= a): the time between them that falls on a weekday (UTC). */
export function businessMs(a: number, b: number): number {
  if (!(b > a)) return 0;
  let total = 0, cur = a;
  while (cur < b) {
    // Whole weeks at once: five business days each.
    const mon = mondayOf(cur);
    if (cur === mon && b - cur >= WEEK) { const weeks = Math.floor((b - cur) / WEEK); total += weeks * 5 * DAY; cur += weeks * WEEK; continue; }
    const d = dayOf(cur), end = Math.min(d + DAY, b);
    if (!weekend(d)) total += end - cur;
    cur = end;
  }
  return total;
}
/** The instant reached after `ms` of business time from `t` (a weekend start waits for Monday 00:00 UTC). */
export function addBusiness(t: number, ms: number): number {
  let cur = t, left = ms;
  if (left <= 0) return t;
  while (left > 0) {
    const d = dayOf(cur);
    if (weekend(d)) { cur = d + DAY; continue; }
    if (cur === mondayOf(cur) && left > 5 * DAY) { const weeks = Math.floor((left - 1) / (5 * DAY)); cur += weeks * WEEK; left -= weeks * 5 * DAY; continue; }
    const avail = d + DAY - cur;
    if (left <= avail) return cur + left;
    left -= avail;
    cur = d + DAY;
  }
  return cur;
}
/** Time of the clock's kind between two instants (0 when b <= a). */
export const span = (kind: ClockKind, a: number, b: number) => (kind === "calendar" ? Math.max(0, b - a) : businessMs(a, b));
/** `t` moved on by `ms` of the clock's kind of time. */
export const advance = (kind: ClockKind, t: number, ms: number) => (kind === "calendar" ? t + ms : addBusiness(t, ms));

const DATE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
/** A date field's value as an instant: a day is 00:00 UTC of it; a time with no zone is UTC. Anything else: null. */
export function parseTime(v: unknown): number | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v !== "string" || !DATE.test(v)) return null;
  const s = v.length === 10 ? `${v}T00:00:00Z` : /(Z|[+-]\d{2}:?\d{2})$/.test(v) ? v.replace(" ", "T") : `${v.replace(" ", "T")}Z`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

/** What the shell keeps of a clock between reads (workspace_record_clocks). */
export interface ClockMemory {
  /** Time (of the clock's kind) paused before the current pause. */
  paused_ms: number;
  /** When the current pause began (null: running). */
  paused_since: string | null;
  /** When the clock stopped (null: not stopped). */
  stopped_at: string | null;
}
export const NO_MEMORY: ClockMemory = { paused_ms: 0, paused_since: null, stopped_at: null };

/** A record as a clock reads it: its opened data, when it was added and when it last entered each lifecycle state. */
export interface ClockRecord {
  data: Record<string, unknown>;
  created_at: string | null;
  /** The record's `$state_at` (src/record-areas.ts STATE_TIMES): state -> when it last entered it. */
  state_at?: Record<string, unknown>;
  /** The area's lifecycle field, whose state times say exactly when a pause or a stop by that field began. */
  lifecycle_field?: string | null;
}

export const CLOCK_STATUSES = ["not_started", "on_track", "due_soon", "overdue", "paused", "met", "missed"] as const;
export type ClockStatus = (typeof CLOCK_STATUSES)[number];
/** One clock of one record, as pages, MCP tools and the scheduler read it. */
export interface ClockView {
  name: string; label: string; status: ClockStatus;
  started_at: string | null;
  /** The deadline (null: no start, or no duration for this record). */
  due_at: string | null;
  /** The deadline's UTC day. */
  due_on: string | null;
  overdue: boolean;
  /** How long past the deadline (of the clock's kind of time), in whole days, while overdue. */
  overdue_days: number | null;
  paused_ms: number;
  stopped_at: string | null;
}
export type ClockChange = "started" | "paused" | "resumed" | "stopped" | "reopened";

const valueText = (v: unknown) => (typeof v === "boolean" ? String(v) : typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const matches = (m: { field: string; in: string[] } | undefined, data: Record<string, unknown>) => {
  if (!m) return false;
  const v = valueText(data[m.field]);
  return v !== null && m.in.includes(v);
};
/** When the record entered the value its lifecycle field holds, when `field` is that field. */
const enteredAt = (r: ClockRecord, field: string): number | null => {
  if (!r.lifecycle_field || r.lifecycle_field !== field) return null;
  const v = valueText(r.data[field]);
  return v === null ? null : parseTime(r.state_at?.[v]);
};

/** The clock's start for this record. */
export function startOf(c: Clock, r: ClockRecord): number | null {
  if ("field" in c.starts) return parseTime(r.data[c.starts.field]);
  if (c.starts.event === "created") return parseTime(r.created_at);
  return parseTime(r.state_at?.[c.starts.state]);
}
/** The clock's duration for this record (null: its `by` field holds a value with no duration and there is no default). */
export function durationOf(c: Clock, r: ClockRecord): number | null {
  if (typeof c.after === "string") return parseDuration(c.after).ms;
  const v = valueText(r.data[c.after.by]);
  const d = (v !== null && Object.hasOwn(c.after.values, v) ? c.after.values[v] : undefined) ?? c.after.default;
  return d === undefined ? null : parseDuration(d).ms;
}
/** How long before the deadline a record is due soon: `soon`, else the earliest reminder's `before`, else 7 days. */
export function soonMs(c: Clock): number {
  if (c.soon) return parseDuration(c.soon).ms;
  const b = (c.remind ?? []).map((x) => parseDuration(x.before).ms);
  return b.length ? Math.max(...b) : 7 * DAY;
}

/**
 * The clock of one record at `now`, from what the shell remembered of it (`memory`, null when it never saw it): its
 * view, the memory to keep, and what changed since (started, paused, resumed, stopped, reopened).
 */
export function observe(c: Clock, r: ClockRecord, memory: ClockMemory | null, now: Date): { view: ClockView; memory: ClockMemory; changes: ClockChange[] } {
  const t = now.getTime();
  const kind = kindOf(c);
  const start = startOf(c, r), dur = durationOf(c, r);
  const base = { name: c.name, label: c.label };
  if (start === null || dur === null) {
    return { view: { ...base, status: "not_started", started_at: iso(start), due_at: null, due_on: null, overdue: false, overdue_days: null, paused_ms: 0, stopped_at: null },
      memory: NO_MEMORY, changes: [] };
  }
  const prev = memory ?? NO_MEMORY;
  const changes: ClockChange[] = memory ? [] : ["started"];
  let pausedMs = prev.paused_ms, pausedSince = parseTime(prev.paused_since), stoppedAt = parseTime(prev.stopped_at);
  const stopped = matches(c.stops_when, r.data);
  const pausedNow = !stopped && matches(c.pauses_when, r.data);
  // A pause closes at `end`: only the time after the start counts.
  const close = (end: number) => { if (pausedSince !== null) pausedMs += span(kind, Math.max(pausedSince, start), Math.max(end, start)); pausedSince = null; };
  if (stopped) {
    const at = (c.stops_when!.at ? parseTime(r.data[c.stops_when!.at]) : null) ?? enteredAt(r, c.stops_when!.field) ?? stoppedAt ?? t;
    close(Math.min(at, t));
    if (stoppedAt === null) changes.push("stopped");
    stoppedAt = at;
  } else {
    if (stoppedAt !== null) { stoppedAt = null; changes.push("reopened"); }
    if (pausedNow) {
      if (pausedSince === null) { pausedSince = Math.min(enteredAt(r, c.pauses_when!.field) ?? t, t); changes.push("paused"); }
    } else if (pausedSince !== null) {
      // Resumed: when the lifecycle says it left the pause (it entered its present state), else now.
      const back = c.pauses_when ? enteredAt(r, c.pauses_when.field) : null;
      close(back !== null && back >= pausedSince && back <= t ? back : t);
      changes.push("resumed");
    }
  }
  // The deadline: the start plus the duration, moved out by every pause (the current one up to now, or to the stop).
  const open = pausedSince !== null ? span(kind, Math.max(pausedSince, start), Math.max(stoppedAt ?? t, start)) : 0;
  let due = advance(kind, start, dur + pausedMs + open);
  const cap = c.not_later_than ? parseTime(r.data[c.not_later_than]) : null;
  if (cap !== null && cap < due) due = cap;
  let status: ClockStatus;
  if (stoppedAt !== null) status = stoppedAt <= due ? "met" : "missed";
  else if (pausedSince !== null) status = "paused";
  else if (t > due) status = "overdue";
  else if (span(kind, t, due) <= soonMs(c)) status = "due_soon";
  else status = "on_track";
  const overdue = status === "overdue";
  return {
    view: { ...base, status, started_at: iso(start), due_at: iso(due), due_on: iso(due)!.slice(0, 10), overdue,
      overdue_days: overdue ? Math.floor(span(kind, due, t) / DAY) : null, paused_ms: pausedMs + open, stopped_at: iso(stoppedAt) },
    memory: { paused_ms: pausedMs, paused_since: iso(pausedSince), stopped_at: iso(stoppedAt) },
    changes,
  };
}

/** A reminder or escalation step a clock's view calls for at `now` (each fires once per record and deadline). */
export interface ClockStep { id: string; kind: "remind" | "escalate"; index: number; at: string }
/**
 * The steps due: a reminder once the deadline is within its `before` (while the clock runs and is not overdue); an
 * escalation once the record has been overdue for its `after`. Nothing while not started, paused or stopped.
 */
export function stepsDue(c: Clock, v: ClockView, now: Date): ClockStep[] {
  if (!v.due_at || !["on_track", "due_soon", "overdue"].includes(v.status)) return [];
  const kind = kindOf(c), t = now.getTime(), due = Date.parse(v.due_at);
  const out: ClockStep[] = [];
  if (v.status !== "overdue") for (const [i, r] of (c.remind ?? []).entries()) {
    const before = parseDuration(r.before).ms;
    if (span(kind, t, due) <= before) out.push({ id: `remind:${i}`, kind: "remind", index: i, at: new Date(kind === "calendar" ? due - before : t).toISOString() });
  }
  else for (const [j, e] of (c.escalate ?? []).entries()) {
    const after = parseDuration(e.after).ms;
    if (span(kind, due, t) >= after) out.push({ id: `escalate:${j}`, kind: "escalate", index: j, at: new Date(advance(kind, due, after)).toISOString() });
  }
  return out;
}

/** The next option of an enum's options after `current` (raise), never past `to`; null when there is none. */
export function raised(options: string[], current: unknown, to?: string): string | null {
  const i = typeof current === "string" ? options.indexOf(current) : -1;
  const cap = to !== undefined ? options.indexOf(to) : options.length - 1;
  if (i < 0 || i >= cap) return null;
  return options[i + 1] ?? null;
}

/**
 * Five-field cron expressions for the scheduler (mold_v0-035; src/schedules.ts), always in UTC:
 *
 *   minute (0-59)  hour (0-23)  day of month (1-31)  month (1-12)  day of week (0-7, 0 and 7 are Sunday)
 *
 * Each field is `*`, a number, a range `a-b`, a step `*\/n` or `a-b/n`, or a comma list of those. As in Vixie cron, when
 * both the day of month and the day of week are restricted (neither starts with `*`), a day matches either. Nothing else (no names, no `@daily`, no
 * seconds, no time zones): what a schedule says is exactly when it runs, in UTC.
 *
 * A schedule may run at most every MIN_GAP_MINUTES minutes (the scheduler ticks every minute on a server and every five
 * minutes on Vercel, so a finer schedule would only mean missed ticks), and an expression that never matches (31 February)
 * is refused.
 */

export interface Cron { source: string; minutes: Set<number>; hours: Set<number>; doms: Set<number>; months: Set<number>; dows: Set<number>; domAny: boolean; dowAny: boolean }

export const MIN_GAP_MINUTES = 5;
const MINUTE = 60_000;
const HORIZON_MS = 5 * 366 * 24 * 3600_000; // look at most five years ahead or back

export class CronError extends Error {}

function field(text: string, lo: number, hi: number, what: string): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  if (!/^[0-9*,\/-]+$/.test(text)) throw new CronError(`${what}: use numbers, *, ranges a-b, steps /n and commas`);
  for (const part of text.split(",")) {
    const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) throw new CronError(`${what}: ${JSON.stringify(part)} is not a number, *, a range or a step`);
    const star = m[1] === "*";
    let a = star ? lo : Number(m[2]), b = star ? hi : m[3] !== undefined ? Number(m[3]) : a;
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (!star && m[3] === undefined && m[4] !== undefined) b = hi; // "5/15": from 5 to the end, every 15
    if (a < lo || b > hi || a > b) throw new CronError(`${what}: ${JSON.stringify(part)} is outside ${lo}-${hi}`);
    if (!(step >= 1)) throw new CronError(`${what}: a step is at least 1`);
    for (let v = a; v <= b; v += step) values.add(v);
  }
  // As Vixie cron: a field that starts with * ("*", "*/2") leaves the day unrestricted for the day-of-month/day-of-week OR.
  return { values, any: text.startsWith("*") };
}

/** Parse an expression; throws a CronError that says what is wrong. */
export function parseCron(expr: unknown): Cron {
  if (typeof expr !== "string") throw new CronError("a cron expression is text: five fields");
  const source = expr.trim().replace(/\s+/g, " ");
  const parts = source.split(" ");
  if (parts.length !== 5 || source.length > 120) throw new CronError("a cron expression has five fields: minute hour day-of-month month day-of-week (UTC)");
  const mi = field(parts[0]!, 0, 59, "minute"), h = field(parts[1]!, 0, 23, "hour"), dom = field(parts[2]!, 1, 31, "day of month"),
    mo = field(parts[3]!, 1, 12, "month"), dw = field(parts[4]!, 0, 7, "day of week");
  if (dw.values.has(7)) { dw.values.delete(7); dw.values.add(0); }
  const c: Cron = { source, minutes: mi.values, hours: h.values, doms: dom.values, months: mo.values, dows: dw.values, domAny: dom.any, dowAny: dw.any };
  // At most every MIN_GAP_MINUTES: the gaps between the minutes of an hour (and across the hour, when every hour runs).
  const mins = [...c.minutes].sort((x, y) => x - y);
  for (let i = 1; i < mins.length; i++) if (mins[i]! - mins[i - 1]! < MIN_GAP_MINUTES) throw new CronError(`a schedule runs at most every ${MIN_GAP_MINUTES} minutes`);
  if (mins.length > 1 && 60 - mins[mins.length - 1]! + mins[0]! < MIN_GAP_MINUTES) throw new CronError(`a schedule runs at most every ${MIN_GAP_MINUTES} minutes`);
  if (!nextAfter(c, new Date(Date.UTC(2000, 0, 1)))) throw new CronError("this expression never matches a date");
  return c;
}

const dayMatches = (c: Cron, d: Date) => {
  const a = c.doms.has(d.getUTCDate()), b = c.dows.has(d.getUTCDay());
  // Vixie cron: either field starting with * means both must match; both restricted means either may.
  return c.domAny || c.dowAny ? a && b : a || b;
};

/** The first time the expression matches strictly after `t` (to the minute), or null within five years. */
export function nextAfter(c: Cron, t: Date): Date | null {
  let x = Math.floor(t.getTime() / MINUTE) * MINUTE + MINUTE;
  const end = t.getTime() + HORIZON_MS;
  while (x < end) {
    const d = new Date(x);
    const y = d.getUTCFullYear(), mo = d.getUTCMonth(), day = d.getUTCDate(), h = d.getUTCHours();
    if (!c.months.has(mo + 1)) { x = Date.UTC(y, mo + 1, 1); continue; }
    if (!dayMatches(c, d)) { x = Date.UTC(y, mo, day + 1); continue; }
    if (!c.hours.has(h)) { x = Date.UTC(y, mo, day, h + 1); continue; }
    if (!c.minutes.has(d.getUTCMinutes())) { x += MINUTE; continue; }
    return d;
  }
  return null;
}

/** The last time the expression matches at or before `t` (to the minute), or null within five years. */
export function latestAtOrBefore(c: Cron, t: Date): Date | null {
  let x = Math.floor(t.getTime() / MINUTE) * MINUTE;
  const end = t.getTime() - HORIZON_MS;
  while (x > end) {
    const d = new Date(x);
    const y = d.getUTCFullYear(), mo = d.getUTCMonth(), day = d.getUTCDate(), h = d.getUTCHours();
    if (!c.months.has(mo + 1)) { x = Date.UTC(y, mo, 1) - MINUTE; continue; }
    if (!dayMatches(c, d)) { x = Date.UTC(y, mo, day) - MINUTE; continue; }
    if (!c.hours.has(h)) { x = Date.UTC(y, mo, day, h) - MINUTE; continue; }
    if (!c.minutes.has(d.getUTCMinutes())) { x -= MINUTE; continue; }
    return d;
  }
  return null;
}

/** How many times the expression matches strictly between `a` and `b` (at most `cap`). */
export function countBetween(c: Cron, a: Date, b: Date, cap = 1000): number {
  let n = 0;
  for (let x = nextAfter(c, a); x && x.getTime() < b.getTime() && n < cap; x = nextAfter(c, x)) n++;
  return n;
}

// mold_v0-298: a schedule's "when" in plain words and in the person's own time zone, and the simple choices (every hour,
// day, weekday, week or month at a time) that write the cron expression the server keeps. The server's cron is always
// UTC (src/cron.ts); these helpers move a time between UTC and the browser's time zone using today's offset, so a place
// that changes its clocks for summer sees the run move by an hour then. Anything the choices cannot say stays the cron
// text itself (the Advanced choice), and reads as that text with "(UTC)".

export type Every = 'hour' | 'day' | 'weekdays' | 'week' | 'month' | 'custom';
/** The picker's state: `time` is HH:MM in the person's time zone; `minute` the minute past the hour (also local). */
export interface Plan { every: Every; minute: number; time: string; weekday: number; day: number; cron: string }

const DAY_MIN = 1440;
const WEEKDAYS = [1, 2, 3, 4, 5];
const mod = (n: number, m: number) => ((n % m) + m) % m;
const pad = (n: number) => String(n).padStart(2, '0');
/** Minutes to add to a UTC time to get the local one (today's offset). */
const offset = () => -new Date().getTimezoneOffset();

const num = (f: string | undefined, lo: number, hi: number): number | null =>
  f !== undefined && /^\d{1,2}$/.test(f) && +f >= lo && +f <= hi ? +f : null;

/** A day-of-week field of numbers, ranges and commas (no steps), 7 read as Sunday; null for anything else. */
function dowSet(f: string): Set<number> | null {
  const out = new Set<number>();
  for (const part of f.split(',')) {
    const m = /^(\d)(?:-(\d))?$/.exec(part);
    if (!m) return null;
    const a = +m[1]!, b = m[2] !== undefined ? +m[2] : a;
    if (a > 7 || b > 7 || a > b) return null;
    for (let v = a; v <= b; v++) out.add(v % 7);
  }
  return out;
}
const shiftDays = (set: Iterable<number>, by: number) => new Set([...set].map((d) => mod(d + by, 7)));
const sameSet = (a: Set<number>, b: number[]) => a.size === b.length && b.every((x) => a.has(x));
/** A set of weekdays as a cron field: runs of days as ranges ("1-5", "0,6"). */
function dowText(set: Set<number>): string {
  const days = [...set].sort((x, y) => x - y);
  const parts: string[] = [];
  for (let i = 0; i < days.length; i++) {
    let j = i;
    while (j + 1 < days.length && days[j + 1] === days[j]! + 1) j++;
    parts.push(j > i ? `${days[i]}-${days[j]}` : String(days[i]));
    i = j;
  }
  return parts.join(',');
}

/** A UTC hour and minute in the person's time zone: the minutes into their day, and how many days it moves. */
function toLocal(h: number, m: number) { const t = h * 60 + m + offset(); return { mins: mod(t, DAY_MIN), shift: Math.floor(t / DAY_MIN) }; }
/** A local HH:MM in UTC: the hour, the minute and how many days it moves. */
function toUtc(time: string) {
  const [h, m] = time.split(':').map(Number);
  const t = (h ?? 0) * 60 + (m ?? 0) - offset();
  const mins = mod(t, DAY_MIN);
  return { h: Math.floor(mins / 60), m: mins % 60, shift: Math.floor(t / DAY_MIN) };
}
const hm = (mins: number) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

/** A cron expression (UTC) as the picker's choices in the person's time zone; `custom` when no choice says it. */
export function planOf(cron: string): Plan {
  const base: Plan = { every: 'custom', minute: 0, time: '09:00', weekday: 1, day: 1, cron: cron.trim() };
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return base;
  const [mi, h, dom, mon, dow] = f as [string, string, string, string, string];
  const m = num(mi, 0, 59);
  if (m === null || mon !== '*') return base;
  if (h === '*' && dom === '*' && dow === '*') return { ...base, every: 'hour', minute: mod(m + offset(), 60) };
  const hr = num(h, 0, 23);
  if (hr === null) return base;
  const { mins, shift } = toLocal(hr, m);
  const time = hm(mins);
  if (dom === '*' && dow === '*') return { ...base, every: 'day', time };
  if (dom === '*') {
    const set = dowSet(dow);
    if (!set) return base;
    const local = shiftDays(set, shift);
    if (local.size === 1) return { ...base, every: 'week', weekday: [...local][0]!, time };
    if (sameSet(local, WEEKDAYS)) return { ...base, every: 'weekdays', time };
    return base;
  }
  if (dow === '*') {
    const d = num(dom, 1, 31);
    if (d === null || d > MONTH_DAYS || d + shift < 1 || d + shift > MONTH_DAYS) return base;
    return { ...base, every: 'month', day: d + shift, time };
  }
  return base;
}

/** The picker's choices as a cron expression in UTC; null when they cannot be said (a month day that moves before the 1st). */
export function cronOf(p: Plan): string | null {
  if (p.every === 'custom') return p.cron.trim() || null;
  if (p.every === 'hour') return `${mod(p.minute - offset(), 60)} * * * *`;
  const { h, m, shift } = toUtc(p.time);
  if (p.every === 'day') return `${m} ${h} * * *`;
  if (p.every === 'weekdays') return `${m} ${h} * * ${dowText(shiftDays(WEEKDAYS, shift))}`;
  if (p.every === 'week') return `${m} ${h} * * ${mod(p.weekday + shift, 7)}`;
  // mold_v0-298: the UTC day stays 1 to 28 so a monthly schedule runs every month, February too.
  const d = p.day + shift;
  return d < 1 || d > MONTH_DAYS ? null : `${m} ${h} ${d} * *`;
}

/** The last day of the month a monthly choice may land on in UTC (every month has it). */
export const MONTH_DAYS = 28;

/** A weekday's name (0 is Sunday) in the person's language. */
export const dayName = (d: number) => new Date(2024, 0, 7 + d).toLocaleDateString(undefined, { weekday: 'long' });
/** A local HH:MM as the person reads a time ("6:30 AM", "18:30"). */
export const timeWords = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(2024, 0, 1, h ?? 0, m ?? 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};
/** The person's time zone as a short name ("GMT+5:30", "PST"). */
export function zoneName(): string {
  try { return new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value ?? 'your time'; }
  catch { return 'your time'; }
}
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * A cron expression (UTC) in plain words in the person's time zone: "Every day at 6:30 AM", "Every Monday at 9:00 AM",
 * "Every 15 minutes"; `zone` adds the time zone's name. What the words cannot say reads as the cron text with "(UTC)".
 */
export function cronWords(cron: string, { zone = false }: { zone?: boolean } = {}): string {
  const z = zone ? ` (${zoneName()})` : '';
  const f = cron.trim().split(/\s+/);
  if (f.length === 5) {
    const [mi, h, dom, mon, dow] = f as [string, string, string, string, string];
    const step = /^\*\/(\d{1,2})$/.exec(mi);
    // mold_v0-298: a step reads as words only when it divides the hour (or the day) evenly, so the gaps are all the same;
    // the minute past the hour is said in the person's time zone.
    const n = step ? +step[1]! : 0;
    if (step && n > 0 && 60 % n === 0 && h === '*' && dom === '*' && mon === '*' && dow === '*') return n === 1 ? 'Every minute' : `Every ${n} minutes`;
    const hours = /^\*\/(\d{1,2})$/.exec(h), mm = num(mi, 0, 59), hn = hours ? +hours[1]! : 0;
    if (hours && mm !== null && hn > 1 && 24 % hn === 0 && dom === '*' && mon === '*' && dow === '*') {
      const past = mod(mm + offset(), 60);
      return `Every ${hn} hours, ${past === 0 ? 'on the hour' : `${past} minute${past === 1 ? '' : 's'} past`}`;
    }
    // Several weekdays that are not Monday to Friday ("Monday, Wednesday and Friday at 9:00 AM").
    const hr = num(h, 0, 23), m = num(mi, 0, 59), set = dom === '*' && mon === '*' ? dowSet(dow) : null;
    if (hr !== null && m !== null && set && set.size > 1) {
      const { mins, shift } = toLocal(hr, m);
      const local = shiftDays(set, shift);
      if (!sameSet(local, WEEKDAYS)) return `Every ${list([1, 2, 3, 4, 5, 6, 0].filter((d) => local.has(d)).map(dayName))} at ${timeWords(hm(mins))}${z}`;
    }
  }
  const p = planOf(cron);
  switch (p.every) {
    case 'hour': return p.minute === 0 ? 'Every hour, on the hour' : `Every hour, ${p.minute} minute${p.minute === 1 ? '' : 's'} past`;
    case 'day': return `Every day at ${timeWords(p.time)}${z}`;
    case 'weekdays': return `Every weekday (Monday to Friday) at ${timeWords(p.time)}${z}`;
    case 'week': return `Every ${dayName(p.weekday)} at ${timeWords(p.time)}${z}`;
    case 'month': return `On the ${ordinal(p.day)} of every month at ${timeWords(p.time)}${z}`;
    default: return `${cron.trim()} (UTC)`;
  }
}

/** True when cronWords says `cron` in words rather than falling back to the cron text. */
export const cronInWords = (cron: string) => cronWords(cron) !== `${cron.trim()} (UTC)`;

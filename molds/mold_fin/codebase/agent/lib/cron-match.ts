/**
 * Dependency-free 5-field cron matcher (minute hour day-of-month month
 * day-of-week), evaluated in UTC.
 *
 * WHY IT EXISTS: the Ops Center lets an operator OVERRIDE a code-authored
 * system cron's cadence (`system_cron_overrides.cron`). Vercel keeps firing
 * the authored cadence no matter what the DB says, so the every-minute
 * dispatcher (`agent/schedules/dynamic.ts`) evaluates the override expression
 * itself with `cronMatches` on each tick. There is no cron-parser dependency
 * and package.json is frozen (eve bundles `croner` internally but it is not a
 * declared dependency of this app), hence this small matcher.
 *
 * SUPPORTED SYNTAX per field: `*`, `n`, `a-b`, `a,b,c` (lists may mix numbers
 * and ranges), and step forms — a step `/n` may follow `*` or a range `a-b`.
 * Numeric only — no JAN/MON names, no `L`, `W`, or `#`. Day-of-week accepts
 * 0-7 with BOTH 0 and 7 meaning Sunday.
 * Day-of-month/day-of-week follow the standard (Vixie) rule: when both are
 * restricted (neither is `*`), the date matches if EITHER matches; otherwise
 * both must match.
 *
 * A malformed expression THROWS a clear Error — the API layer must validate
 * before an expression ever reaches the DB, and the dispatcher catches.
 *
 * NOTE: no imports on purpose. That keeps it loadable from every runtime this
 * repo has: the eve bundler (`#lib/*.js`), the Next bundler (`@/agent/lib/*`),
 * and plain `node --experimental-strip-types` test scripts.
 */

interface CronField {
  /** True when the field is `*` (or `*` inside a list) with no step. */
  any: boolean;
  values: Set<number>;
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const FIELD_SPECS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  // 0-7 accepted at parse time; 7 is normalized to 0 (both mean Sunday).
  { name: "day-of-week", min: 0, max: 7 },
] as const;

function fail(expr: string, detail: string): never {
  throw new Error(`Invalid cron expression "${expr}": ${detail}`);
}

function parseInteger(expr: string, field: string, raw: string): number {
  if (!/^\d+$/.test(raw)) fail(expr, `${field} has a non-numeric value "${raw}"`);
  return Number(raw);
}

function checkBounds(expr: string, spec: (typeof FIELD_SPECS)[number], n: number): void {
  if (n < spec.min || n > spec.max) {
    fail(expr, `${spec.name} value ${n} is out of range ${spec.min}-${spec.max}`);
  }
}

/** Normalize day-of-week 7 → 0 so Sunday has one canonical value. */
function normalize(spec: (typeof FIELD_SPECS)[number], n: number): number {
  return spec.name === "day-of-week" && n === 7 ? 0 : n;
}

function parseField(
  expr: string,
  spec: (typeof FIELD_SPECS)[number],
  raw: string,
): CronField {
  if (raw === "") fail(expr, `${spec.name} is empty`);
  const values = new Set<number>();

  for (const part of raw.split(",")) {
    if (part === "") fail(expr, `${spec.name} has an empty list entry`);
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined) fail(expr, `${spec.name} has more than one "/" in "${part}"`);

    let step = 1;
    if (stepPart !== undefined) {
      step = parseInteger(expr, spec.name, stepPart);
      if (step < 1) fail(expr, `${spec.name} step must be >= 1, got ${step}`);
    }

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = spec.min;
      hi = spec.max;
    } else if (rangePart.includes("-")) {
      const ends = rangePart.split("-");
      if (ends.length !== 2) fail(expr, `${spec.name} has a malformed range "${rangePart}"`);
      lo = parseInteger(expr, spec.name, ends[0]);
      hi = parseInteger(expr, spec.name, ends[1]);
      checkBounds(expr, spec, lo);
      checkBounds(expr, spec, hi);
      if (lo > hi) fail(expr, `${spec.name} range ${lo}-${hi} is reversed`);
    } else {
      // A single number. A step on a bare number (e.g. "5/10") is rejected:
      // steps are only meaningful on `*` or a range.
      if (stepPart !== undefined) {
        fail(expr, `${spec.name} has a step on a single value ("${part}") — use */n or a-b/n`);
      }
      const n = parseInteger(expr, spec.name, rangePart);
      checkBounds(expr, spec, n);
      values.add(normalize(spec, n));
      continue;
    }

    for (let n = lo; n <= hi; n += step) values.add(normalize(spec, n));
  }

  // `*` alone (no step, no list) matches everything.
  return { any: raw === "*", values };
}

export function parseCron(expr: string): ParsedCron {
  if (typeof expr !== "string" || expr.trim() === "") {
    fail(String(expr), "expected a non-empty string");
  }
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    fail(
      expr,
      `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((raw, i) =>
    parseField(expr, FIELD_SPECS[i], raw),
  );
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function fieldMatches(field: CronField, value: number): boolean {
  return field.any || field.values.has(value);
}

/**
 * True when `expr` fires at `date`, evaluated in UTC (Vercel Cron semantics).
 * Throws on a malformed expression — callers on a hot path must validate (or
 * catch) first.
 */
export function cronMatches(expr: string, date: Date): boolean {
  const cron = parseCron(expr);
  const minuteOk = fieldMatches(cron.minute, date.getUTCMinutes());
  const hourOk = fieldMatches(cron.hour, date.getUTCHours());
  const monthOk = fieldMatches(cron.month, date.getUTCMonth() + 1);
  // Standard (Vixie) day rule: both restricted → OR; otherwise AND.
  const domRestricted = !cron.dayOfMonth.any;
  const dowRestricted = !cron.dayOfWeek.any;
  const domOk = fieldMatches(cron.dayOfMonth, date.getUTCDate());
  const dowOk = fieldMatches(cron.dayOfWeek, date.getUTCDay());
  const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk;
  return minuteOk && hourOk && monthOk && dayOk;
}

/**
 * The next whole UTC minute STRICTLY AFTER `after` that matches `expr`, or null
 * if none falls within ~366 days (a runaway-guard bound). Minute-granular — the
 * dispatcher's tick. Used to advance a cron-driven schedule rule's nextRunAt.
 * Throws on a malformed expression (same contract as cronMatches).
 */
export function nextCronTime(expr: string, after: Date): Date | null {
  parseCron(expr); // validate up-front
  const d = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const maxMinutes = 366 * 24 * 60;
  for (let i = 0; i < maxMinutes; i++) {
    if (cronMatches(expr, d)) return new Date(d);
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Cheap human description — best-effort, null when no simple phrasing fits   */
/* -------------------------------------------------------------------------- */

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function two(n: number): string {
  return String(n).padStart(2, "0");
}

function single(field: CronField): number | null {
  return !field.any && field.values.size === 1 ? [...field.values][0] : null;
}

/**
 * Short human string for the COMMON shapes ("Every minute", "Every 6 hours",
 * "Weekdays · 09:00 UTC", ...). Returns null for anything it cannot phrase
 * cheaply — callers should fall back to showing the raw expression.
 * Throws on a malformed expression (same contract as `cronMatches`).
 */
export function describeCron(expr: string): string | null {
  const cron = parseCron(expr);
  const parts = expr.trim().split(/\s+/);
  const [minRaw, hourRaw, domRaw, monRaw, dowRaw] = parts;
  if (domRaw !== "*" || monRaw !== "*") return null;

  const minute = single(cron.minute);
  const hour = single(cron.hour);

  // Day-of-week phrase (only for the simple shapes).
  let dayPhrase: string | null = null;
  if (dowRaw === "*") dayPhrase = "";
  else if (dowRaw === "1-5") dayPhrase = "Weekdays · ";
  else if (single(cron.dayOfWeek) !== null) {
    dayPhrase = `${WEEKDAY_NAMES[single(cron.dayOfWeek) as number]} · `;
  }
  if (dayPhrase === null) return null;

  const minStep = /^\*\/(\d+)$/.exec(minRaw);
  const hourStep = /^\*\/(\d+)$/.exec(hourRaw);

  let label: string | null = null;
  if (minRaw === "*" && hourRaw === "*") label = `${dayPhrase}every minute`;
  else if (minStep && hourRaw === "*") label = `${dayPhrase}every ${minStep[1]} minutes`;
  else if (minute !== null && hourStep) label = `Every ${hourStep[1]} hours at :${two(minute)}`;
  else if (minute !== null && hourRaw === "*") label = `${dayPhrase}hourly at :${two(minute)}`;
  else if (minute !== null && hour !== null) {
    label = `${dayPhrase || "Daily · "}${two(hour)}:${two(minute)} UTC`;
  }
  if (label === null) return null;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

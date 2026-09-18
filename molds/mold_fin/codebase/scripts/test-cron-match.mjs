/**
 * Tests for the dependency-free 5-field cron matcher (agent/lib/cron-match.ts)
 * that enforces Ops-Center cadence overrides for the code-authored system
 * crons (see agent/schedules/dynamic.ts).
 *
 * Runs offline with plain node + assert — no database, no network.
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-cron-match.mjs
 */
import assert from "node:assert/strict";

const { cronMatches, describeCron, parseCron } = await import("../agent/lib/cron-match.ts");

/** Build a UTC date: utc(y, m(1-12), d, hh, mm). */
const utc = (y, m, d, hh, mm) => new Date(Date.UTC(y, m - 1, d, hh, mm, 0, 0));

// --- "0 9 * * 1-5" — the authored daily-standup cadence ---------------------

const standup = "0 9 * * 1-5";
assert.equal(cronMatches(standup, utc(2026, 7, 10, 9, 0)), true, "Fri 09:00 UTC matches");
assert.equal(cronMatches(standup, utc(2026, 7, 13, 9, 0)), true, "Mon 09:00 UTC matches");
assert.equal(cronMatches(standup, utc(2026, 7, 11, 9, 0)), false, "Sat 09:00 does not match");
assert.equal(cronMatches(standup, utc(2026, 7, 12, 9, 0)), false, "Sun 09:00 does not match");
assert.equal(cronMatches(standup, utc(2026, 7, 10, 9, 1)), false, "09:01 does not match");
assert.equal(cronMatches(standup, utc(2026, 7, 10, 10, 0)), false, "10:00 does not match");

// --- "*/6 * * * *" — minute step --------------------------------------------

const everySixMin = "*/6 * * * *";
for (const mm of [0, 6, 12, 54]) {
  assert.equal(cronMatches(everySixMin, utc(2026, 1, 1, 3, mm)), true, `:${mm} matches */6`);
}
for (const mm of [1, 5, 7, 59]) {
  assert.equal(cronMatches(everySixMin, utc(2026, 1, 1, 3, mm)), false, `:${mm} misses */6`);
}

// --- "0 */6 * * *" — the authored sla-sweep cadence --------------------------

const sweep = "0 */6 * * *";
for (const hh of [0, 6, 12, 18]) {
  assert.equal(cronMatches(sweep, utc(2026, 7, 10, hh, 0)), true, `${hh}:00 matches 0 */6`);
}
assert.equal(cronMatches(sweep, utc(2026, 7, 10, 3, 0)), false, "03:00 misses 0 */6");
assert.equal(cronMatches(sweep, utc(2026, 7, 10, 6, 30)), false, "06:30 misses 0 */6");

// --- lists and ranges ---------------------------------------------------------

const list = "0,15,30,45 9-17 * * *";
assert.equal(cronMatches(list, utc(2026, 3, 3, 9, 15)), true, "listed minute in ranged hour");
assert.equal(cronMatches(list, utc(2026, 3, 3, 17, 45)), true, "range is inclusive at both ends");
assert.equal(cronMatches(list, utc(2026, 3, 3, 8, 15)), false, "hour below the range misses");
assert.equal(cronMatches(list, utc(2026, 3, 3, 18, 0)), false, "hour above the range misses");
assert.equal(cronMatches(list, utc(2026, 3, 3, 10, 20)), false, "unlisted minute misses");

// Mixed list entries: single values, a range, and a stepped range.
const mixed = "5,10-12,20-40/10 * * * *";
for (const mm of [5, 10, 11, 12, 20, 30, 40]) {
  assert.equal(cronMatches(mixed, utc(2026, 3, 3, 0, mm)), true, `:${mm} matches mixed list`);
}
for (const mm of [6, 13, 25, 41]) {
  assert.equal(cronMatches(mixed, utc(2026, 3, 3, 0, mm)), false, `:${mm} misses mixed list`);
}

// Month + day-of-month fields.
assert.equal(cronMatches("0 0 1 1 *", utc(2026, 1, 1, 0, 0)), true, "Jan 1 midnight matches");
assert.equal(cronMatches("0 0 1 1 *", utc(2026, 2, 1, 0, 0)), false, "Feb 1 misses month 1");
assert.equal(cronMatches("0 0 15 * *", utc(2026, 4, 15, 0, 0)), true, "the 15th matches");
assert.equal(cronMatches("0 0 15 * *", utc(2026, 4, 14, 0, 0)), false, "the 14th misses");

// Vixie day rule: when BOTH day-of-month and day-of-week are restricted, the
// date matches when EITHER does.
const both = "0 0 13 * 5"; // the 13th OR any Friday
assert.equal(cronMatches(both, utc(2026, 2, 13, 0, 0)), true, "Feb 13 2026 (a Friday) matches");
assert.equal(cronMatches(both, utc(2026, 3, 13, 0, 0)), true, "the 13th matches even off-Friday");
assert.equal(cronMatches(both, utc(2026, 3, 6, 0, 0)), true, "a Friday matches even off-13th");
assert.equal(cronMatches(both, utc(2026, 3, 5, 0, 0)), false, "neither the 13th nor a Friday");

// --- boundary cases -----------------------------------------------------------

// Minute 0 (top of the hour) and the extremes of each field's range.
assert.equal(cronMatches("0 0 * * *", utc(2026, 6, 1, 0, 0)), true, "minute 0 / hour 0 matches");
assert.equal(cronMatches("59 23 31 12 *", utc(2026, 12, 31, 23, 59)), true, "all-max boundary");

// Sunday as BOTH 0 and 7 (supported; 7 is normalized to 0 at parse time).
const sunday = utc(2026, 7, 12, 8, 0); // 2026-07-12 is a Sunday
assert.equal(cronMatches("0 8 * * 0", sunday), true, "Sunday matches day-of-week 0");
assert.equal(cronMatches("0 8 * * 7", sunday), true, "Sunday matches day-of-week 7 too");
assert.equal(cronMatches("0 8 * * 1", sunday), false, "Sunday does not match Monday");
// A 5-7 range covers Fri, Sat, and (via 7→0) Sunday.
assert.equal(cronMatches("0 8 * * 5-7", sunday), true, "5-7 range includes Sunday via 7");

// "* * * * *" matches any minute.
assert.equal(cronMatches("* * * * *", utc(2026, 1, 1, 0, 0)), true);
assert.equal(cronMatches("* * * * *", utc(2026, 12, 31, 23, 59)), true);

// --- invalid input THROWS (the API must be able to reject before persisting) ---

const bad = [
  "", // empty
  "0 9 * *", // 4 fields
  "0 9 * * * *", // 6 fields
  "60 * * * *", // minute out of range
  "* 24 * * *", // hour out of range
  "* * 0 * *", // day-of-month below range
  "* * 32 * *", // day-of-month above range
  "* * * 13 *", // month out of range
  "* * * * 8", // day-of-week above 7
  "a * * * *", // non-numeric
  "*/0 * * * *", // zero step
  "5/10 * * * *", // step on a single value
  "10-5 * * * *", // reversed range
  "1-2-3 * * * *", // malformed range
  "1,,2 * * * *", // empty list entry
  "*/x * * * *", // non-numeric step
];
for (const expr of bad) {
  assert.throws(
    () => cronMatches(expr, utc(2026, 1, 1, 0, 0)),
    /Invalid cron/,
    `"${expr}" must throw`,
  );
}
// The parse-only entry point throws identically.
assert.throws(() => parseCron("not a cron"), /Invalid cron/);

// --- describeCron: cheap human strings, null when no simple phrasing fits ------

assert.equal(describeCron("* * * * *"), "Every minute");
assert.equal(describeCron("*/6 * * * *"), "Every 6 minutes");
assert.equal(describeCron("0 */6 * * *"), "Every 6 hours at :00");
assert.equal(describeCron("30 * * * *"), "Hourly at :30");
assert.equal(describeCron("0 9 * * *"), "Daily · 09:00 UTC");
assert.equal(describeCron("0 9 * * 1-5"), "Weekdays · 09:00 UTC");
assert.equal(describeCron("0 9 * * 1"), "Mon · 09:00 UTC");
assert.equal(describeCron("0 0 1 * *"), null, "day-of-month shapes are not phrased");
assert.throws(() => describeCron("nope"), /Invalid cron/, "describeCron validates too");

console.log("test-cron-match: all assertions passed (offline, no dependencies).");

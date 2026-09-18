/**
 * Fallback-path test for the deterministic alerts / digest engine
 * (agent/lib/alerts.ts). Runs with NO database URL, so the system of record
 * reads from the bundled seed JSON (data/customers.json) in memory — no
 * Postgres connection is ever attempted. Every assertion is pinned to a known
 * `now`, exercising the pure (store, now) -> alerts contract.
 *
 * Usage:
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-alerts.mjs
 */
import assert from "node:assert/strict";

// Force the fallback path: no DB URL.
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const { getDb } = await import("../agent/lib/db/index.ts");
const { computeStandupDigest, computeOverdueAlerts, computeSlaBreaches } = await import(
  "../agent/lib/alerts.ts"
);

assert.equal(getDb(), null, "no DB URL is set, getDb() must return null (fallback path)");

const NOW = "2026-07-10T12:00:00Z";
const idsOf = (arr) => arr.map((a) => a.ticketId);
const find = (arr, id) => arr.find((a) => a.ticketId === id);

/* -------------------------------------------------------------------------- */
/* computeStandupDigest @ 2026-07-10T12:00:00Z                                 */
/* -------------------------------------------------------------------------- */

const digest = await computeStandupDigest({ now: NOW });

assert.equal(digest.generatedFor, "2026-07-10", "generatedFor is the UTC date of now");
assert.equal(digest.totals.customers, 2, "both seed customers counted");
assert.equal(digest.totals.openFollowUps, 5, "five open follow-ups in the seed");
assert.equal(digest.totals.overdue, 1, "exactly TCK-1001 is overdue at now");
assert.equal(digest.totals.dueSoon, 2, "TCK-1003 and TCK-2031 are due within 3 days");

// Rule 4: acme-bank (holds the overdue ticket) sorts before northwind-cap.
assert.deepEqual(
  digest.sections.map((s) => s.customerId),
  ["acme-bank", "northwind-cap"],
  "section order: overdueCount desc puts acme-bank first",
);

const acme = digest.sections[0];
assert.equal(acme.openCount, 3, "acme has 3 open follow-ups");
assert.equal(acme.overdueCount, 1);
assert.equal(acme.dueSoonCount, 1);
assert.equal(acme.status, "On Track", "customer status is surfaced on the section");
assert.equal(acme.fdeOwner, "priyesh@onfinance.in");
// Rule 3 ranking within a customer: overdue < due_soon < on_track.
assert.deepEqual(
  idsOf(acme.topFollowUps),
  ["TCK-1001", "TCK-1003", "TCK-1002"],
  "acme follow-ups ranked overdue -> due_soon -> on_track",
);
assert.equal(
  acme.nextAction,
  "Waiting on Sam Cole to confirm security review completion date.",
  "nextAction = most-urgent ticket's ticketNextStep",
);

const nw = digest.sections[1];
assert.equal(nw.overdueCount, 0);
assert.equal(nw.dueSoonCount, 1, "TCK-2031 (P0) is due_soon, not overdue, at now");
assert.equal(idsOf(nw.topFollowUps)[0], "TCK-2031", "P0 ranks first for northwind");

// TCK-1001: slaDueAt 2026-07-09T17:00Z is in the past -> overdue via slaDueAt.
const t1001 = find(acme.topFollowUps, "TCK-1001");
assert.equal(t1001.urgency, "overdue");
assert.equal(t1001.dueSource, "slaDueAt");
assert.equal(t1001.daysUntilDue, -1, "floored days-until-due is negative when overdue");

// TCK-2031: P0, slaDueAt 2026-07-10T17:00Z still 5h out -> due_soon / at_risk, NOT overdue.
const t2031 = find(nw.topFollowUps, "TCK-2031");
assert.equal(t2031.urgency, "due_soon");
assert.equal(t2031.dueSource, "slaDueAt");
assert.equal(t2031.slaStatus, "at_risk");
assert.equal(t2031.escalated, true);
assert.equal(t2031.daysUntilDue, 0);

// TCK-1002: no sla/resolution due -> falls back to ticketDueDate 2026-07-20 -> on_track.
const t1002 = find(acme.topFollowUps, "TCK-1002");
assert.equal(t1002.dueSource, "ticketDueDate");
assert.equal(t1002.urgency, "on_track");

/* -------------------------------------------------------------------------- */
/* computeOverdueAlerts @ now                                                  */
/* -------------------------------------------------------------------------- */

const overdue = await computeOverdueAlerts({ now: NOW });
assert.deepEqual(idsOf(overdue), ["TCK-1001"], "only TCK-1001 is overdue at now");

/* -------------------------------------------------------------------------- */
/* computeSlaBreaches @ now                                                    */
/* -------------------------------------------------------------------------- */

const sla = await computeSlaBreaches({ now: NOW });
// TCK-1001: hard SLA clock (slaDueAt) already missed -> breach.
assert.deepEqual(idsOf(sla.breaches), ["TCK-1001"], "TCK-1001 breached its slaDueAt");
// TCK-2031: at_risk and not yet breached -> atRisk (precedence breaches > atRisk).
assert.deepEqual(idsOf(sla.atRisk), ["TCK-2031"], "TCK-2031 is at_risk, not breached");
// Mutual exclusion: no ticket appears in two buckets.
const allSla = [...sla.breaches, ...sla.atRisk, ...sla.agingHighPriority].map((a) => a.ticketId);
assert.equal(new Set(allSla).size, allSla.length, "sla buckets are mutually exclusive");

/* -------------------------------------------------------------------------- */
/* Determinism: two consecutive calls are deeply equal                        */
/* -------------------------------------------------------------------------- */

assert.deepEqual(
  await computeStandupDigest({ now: NOW }),
  digest,
  "computeStandupDigest is a pure function of (store, now)",
);
assert.deepEqual(
  await computeSlaBreaches({ now: NOW }),
  sla,
  "computeSlaBreaches is deterministic",
);

/* -------------------------------------------------------------------------- */
/* A `now` far in the future flips everything to overdue; P0 ranks first       */
/* -------------------------------------------------------------------------- */

const FUTURE = "2027-01-01T00:00:00Z";
const futureOverdue = await computeOverdueAlerts({ now: FUTURE });
assert.equal(futureOverdue.length, 5, "all open follow-ups overdue in the far future");
assert.equal(futureOverdue[0].ticketId, "TCK-2031", "P0-Critical ranks first among overdue");
assert.ok(
  futureOverdue.every((a) => a.urgency === "overdue"),
  "every follow-up is overdue in the far future",
);

const futureDigest = await computeStandupDigest({ now: FUTURE });
assert.equal(futureDigest.totals.overdue, 5, "digest totals reflect all-overdue future");
assert.equal(futureDigest.totals.dueSoon, 0);

console.log("test-alerts: all assertions passed (fallback path, no Postgres).");

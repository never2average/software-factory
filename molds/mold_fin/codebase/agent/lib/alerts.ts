/**
 * Deterministic alerts / digest engine over the system-of-record READ surface.
 *
 * PURE + SIDE-EFFECT FREE. Every exported function takes an explicit `now`
 * (ISO string or Date) and never reads the clock, so its output is a pure
 * function of (store state, now) — trivially testable offline against the
 * bundled seed JSON (no Postgres required; see scripts/test-alerts.mjs).
 *
 * This module imports ONLY the SoR read helpers (`listFollowUps`,
 * `listCustomers`) and the Ticket type. It returns STRUCTURED objects only —
 * NO prose formatting lives here (schedules / agents render the output). Keep
 * the relative `.ts` import specifiers below: plain `node --experimental-strip-
 * types` does not resolve the `#lib/*.js` subpath aliases the offline test
 * relies on.
 */
import { listCustomers, listFollowUps } from "./system-of-record.ts";
import type { Ticket } from "./customer-schema.ts";

export type Urgency = "overdue" | "due_soon" | "on_track" | "no_due_date";

export interface FollowUpAlert {
  customerId: string;
  customerName: string;
  ticketId: string;
  summary: string;
  ticketPriority: Ticket["ticketPriority"];
  severity?: Ticket["severity"];
  ticketStatus: Ticket["ticketStatus"];
  dueAt: string | null; // effectiveDueAt (raw stored value; see rule 1)
  dueSource: "slaDueAt" | "resolutionDueAt" | "ticketDueDate" | null;
  daysUntilDue: number | null; // floor(days); negative = overdue
  urgency: Urgency;
  nextStep: string; // ticketNextStep (required on every ticket)
  slaStatus?: Ticket["slaStatus"];
  escalated?: boolean;
}

export interface CustomerDigestSection {
  customerId: string;
  customerName: string;
  status?: string;
  fdeOwner?: string;
  openCount: number;
  overdueCount: number;
  dueSoonCount: number;
  topFollowUps: FollowUpAlert[]; // capped + ranked (rule 3)
  nextAction: string; // the single most urgent ticket's ticketNextStep
}

export interface StandupDigest {
  generatedFor: string; // ISO date (UTC) of `now`
  totals: { customers: number; openFollowUps: number; overdue: number; dueSoon: number };
  sections: CustomerDigestSection[]; // customers WITH open follow-ups only
}

export interface SlaBreachReport {
  breaches: FollowUpAlert[];
  atRisk: FollowUpAlert[];
  agingHighPriority: FollowUpAlert[];
}

/* -------------------------------------------------------------------------- */
/* Deterministic date + ranking primitives                                    */
/* -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function nowMs(now: Date | string): number {
  return (now instanceof Date ? now : new Date(now)).getTime();
}

/**
 * Rule 1 (part): date-only strings ("2026-07-09") compare as END-OF-DAY UTC
 * (`T23:59:59Z`) so a ticket "due 2026-07-09" is overdue at any time on
 * 2026-07-10. Strings that already carry a time/zone parse as-is.
 */
function dueMs(value: string): number {
  const iso = DATE_ONLY_RE.test(value) ? `${value}T23:59:59Z` : value;
  return new Date(iso).getTime();
}

/** Opened dates compare as START-OF-DAY UTC (used only for the aging window). */
function openedMs(value: string): number {
  const iso = DATE_ONLY_RE.test(value) ? `${value}T00:00:00Z` : value;
  return new Date(iso).getTime();
}

/**
 * Rule 1: effectiveDueAt = first present of slaDueAt -> resolutionDueAt ->
 * ticketDueDate. (Flagged correction: tickets have NO `nextActionDueDate` —
 * that field lives on interactions.) Returns the raw stored string plus its
 * source; null when all three are absent.
 */
function effectiveDue(t: Ticket): {
  value: string | null;
  source: FollowUpAlert["dueSource"];
} {
  if (t.slaDueAt) return { value: t.slaDueAt, source: "slaDueAt" };
  if (t.resolutionDueAt) return { value: t.resolutionDueAt, source: "resolutionDueAt" };
  if (t.ticketDueDate) return { value: t.ticketDueDate, source: "ticketDueDate" };
  return { value: null, source: null };
}

const URGENCY_RANK: Record<Urgency, number> = {
  overdue: 0,
  due_soon: 1,
  on_track: 2,
  no_due_date: 3,
};

const PRIORITY_RANK: Record<Ticket["ticketPriority"], number> = {
  "P0-Critical": 0,
  "P1-High": 1,
  "P2-Medium": 2,
  "P3-Low": 3,
};

// S0<S1<S2<S3; absent severity sorts last.
function severityRank(sev: Ticket["severity"] | undefined): number {
  if (!sev) return 99;
  return { S0: 0, S1: 1, S2: 2, S3: 3 }[sev];
}

/**
 * Rule 3: the TOTAL order used everywhere. urgency bucket -> priority ->
 * severity (absent last) -> effectiveDueAt ascending (null last) -> ticketId
 * ascending as the final deterministic tiebreak.
 */
function compareAlerts(a: FollowUpAlert, b: FollowUpAlert): number {
  const byUrgency = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
  if (byUrgency !== 0) return byUrgency;
  const byPriority = PRIORITY_RANK[a.ticketPriority] - PRIORITY_RANK[b.ticketPriority];
  if (byPriority !== 0) return byPriority;
  const bySeverity = severityRank(a.severity) - severityRank(b.severity);
  if (bySeverity !== 0) return bySeverity;
  const aDue = a.dueAt === null ? Infinity : dueMs(a.dueAt);
  const bDue = b.dueAt === null ? Infinity : dueMs(b.dueAt);
  if (aDue !== bDue) return aDue - bDue;
  return a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0;
}

/**
 * Build a FollowUpAlert for one open ticket at `now`.
 * Rule 2 — urgency: overdue if effectiveDueAt < now; due_soon if effectiveDueAt
 * is within `dueSoonDays` of now; no_due_date if all three due fields absent;
 * else on_track.
 */
function toAlert(
  t: Ticket & { customerId: string; customerName: string },
  now: number,
  dueSoonDays: number,
): FollowUpAlert {
  const { value, source } = effectiveDue(t);
  let urgency: Urgency;
  let daysUntilDue: number | null;
  if (value === null) {
    urgency = "no_due_date";
    daysUntilDue = null;
  } else {
    const due = dueMs(value);
    daysUntilDue = Math.floor((due - now) / DAY_MS);
    if (due < now) urgency = "overdue";
    else if (due <= now + dueSoonDays * DAY_MS) urgency = "due_soon";
    else urgency = "on_track";
  }
  return {
    customerId: t.customerId,
    customerName: t.customerName,
    ticketId: t.ticketId,
    summary: t.summary,
    ticketPriority: t.ticketPriority,
    severity: t.severity,
    ticketStatus: t.ticketStatus,
    dueAt: value,
    dueSource: source,
    daysUntilDue,
    urgency,
    nextStep: t.ticketNextStep,
    slaStatus: t.slaStatus,
    escalated: t.escalated,
  };
}

async function buildAlerts(now: Date | string, dueSoonDays: number): Promise<FollowUpAlert[]> {
  const followUps = await listFollowUps();
  const nowT = nowMs(now);
  return followUps.map((t) => toAlert(t, nowT, dueSoonDays)).sort(compareAlerts);
}

function isoDate(now: Date | string): string {
  return new Date(nowMs(now)).toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* Public compute surface                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Rule 4: group open follow-ups by customer; sections sorted by
 * (overdueCount desc, worst-ticket rank, customerId asc). `nextAction` =
 * ranked-first ticket's ticketNextStep. Customers with zero open follow-ups
 * are omitted from `sections` but still counted in `totals.customers`.
 */
export async function computeStandupDigest(opts: {
  now: Date | string;
  dueSoonDays?: number;
  topPerCustomer?: number;
}): Promise<StandupDigest> {
  const dueSoonDays = opts.dueSoonDays ?? 3;
  const topPerCustomer = opts.topPerCustomer ?? 3;

  const [alerts, customers] = await Promise.all([
    buildAlerts(opts.now, dueSoonDays),
    listCustomers(),
  ]);

  // Customer metadata (status / fdeOwner) from the customers listing.
  const meta = new Map(customers.map((c) => [c.id, c]));

  const byCustomer = new Map<string, FollowUpAlert[]>();
  for (const a of alerts) {
    const list = byCustomer.get(a.customerId);
    if (list) list.push(a);
    else byCustomer.set(a.customerId, [a]);
  }

  const sections: CustomerDigestSection[] = [];
  for (const [customerId, list] of byCustomer) {
    // `list` inherits the global ranking (alerts already sorted, stable push).
    const ranked = [...list].sort(compareAlerts);
    const overdueCount = ranked.filter((a) => a.urgency === "overdue").length;
    const dueSoonCount = ranked.filter((a) => a.urgency === "due_soon").length;
    sections.push({
      customerId,
      customerName: ranked[0].customerName,
      status: meta.get(customerId)?.status,
      fdeOwner: meta.get(customerId)?.fdeOwner,
      openCount: ranked.length,
      overdueCount,
      dueSoonCount,
      topFollowUps: ranked.slice(0, topPerCustomer),
      nextAction: ranked[0].nextStep,
    });
  }

  sections.sort((a, b) => {
    if (b.overdueCount !== a.overdueCount) return b.overdueCount - a.overdueCount;
    const byWorst = compareAlerts(a.topFollowUps[0], b.topFollowUps[0]);
    if (byWorst !== 0) return byWorst;
    return a.customerId < b.customerId ? -1 : a.customerId > b.customerId ? 1 : 0;
  });

  return {
    generatedFor: isoDate(opts.now),
    totals: {
      customers: customers.length,
      openFollowUps: alerts.length,
      overdue: alerts.filter((a) => a.urgency === "overdue").length,
      dueSoon: alerts.filter((a) => a.urgency === "due_soon").length,
    },
    sections,
  };
}

/** Open follow-ups whose urgency is `overdue`, ranked by rule 3. */
export async function computeOverdueAlerts(opts: {
  now: Date | string;
}): Promise<FollowUpAlert[]> {
  const alerts = await buildAlerts(opts.now, 3);
  return alerts.filter((a) => a.urgency === "overdue");
}

/**
 * Rule 5: partition open tickets into three ranked, mutually-exclusive buckets
 * (precedence breaches > atRisk > aging):
 *  - breaches: slaStatus === "breached" OR effectiveDueAt < now where dueSource
 *    is slaDueAt / resolutionDueAt (a missed HARD SLA clock, not a soft due date).
 *  - atRisk: slaStatus === "at_risk" and not already a breach.
 *  - agingHighPriority: open P0/P1 whose ticketOpenedDate is older than
 *    `agingDays` before now, and not already in the other two buckets.
 */
export async function computeSlaBreaches(opts: {
  now: Date | string;
  agingDays?: number;
}): Promise<SlaBreachReport> {
  const agingDays = opts.agingDays ?? 14;
  const nowT = nowMs(opts.now);
  const followUps = await listFollowUps();

  const breaches: FollowUpAlert[] = [];
  const atRisk: FollowUpAlert[] = [];
  const agingHighPriority: FollowUpAlert[] = [];

  const agingCutoff = nowT - agingDays * DAY_MS;

  for (const t of followUps) {
    const alert = toAlert(t, nowT, 3);
    const { value, source } = effectiveDue(t);
    const missedHardSla =
      value !== null &&
      (source === "slaDueAt" || source === "resolutionDueAt") &&
      dueMs(value) < nowT;
    const isBreach = t.slaStatus === "breached" || missedHardSla;

    if (isBreach) {
      breaches.push(alert);
      continue;
    }
    if (t.slaStatus === "at_risk") {
      atRisk.push(alert);
      continue;
    }
    const highPriority = t.ticketPriority === "P0-Critical" || t.ticketPriority === "P1-High";
    if (highPriority && openedMs(t.ticketOpenedDate) < agingCutoff) {
      agingHighPriority.push(alert);
    }
  }

  breaches.sort(compareAlerts);
  atRisk.sort(compareAlerts);
  agingHighPriority.sort(compareAlerts);
  return { breaches, atRisk, agingHighPriority };
}

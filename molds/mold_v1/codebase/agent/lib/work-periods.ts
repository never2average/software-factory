/**
 * WORK PERIODS — the time-boxed periods that group tasks, as THIS deployment has them.
 *
 * The base product stores a period in the `cycles` table and files a task into one through `todos.cycle_id`. What
 * the period IS for the people using a deployment is the deployment profile's (profiles/*.json `work_periods`):
 *
 *   mode "team"         one shared period with a lead, a capacity and a burndown. The default profile, and what
 *                       the base product has always had.
 *   mode "individual"   each person has their own items within the period: their own goal and planned count
 *                       (`cycle_member_goals`), no shared lead and no team capacity. Every view groups by person
 *                       and shows the signed-in person first.
 *   mode "off"          the feature does not exist: no view and no entry point, no tool for the model, the cycles
 *                       routes answer 404, exports omit it. Stored rows are kept exactly as they are.
 *
 * The words are the profile's too: what a period is called (`label`), what it is called where tasks are grouped
 * and filtered by it (`list_label`), and what one task in a period is called under mode individual (`item_label`).
 * Base text never spells them. Text the model reads writes a placeholder, filled at the same boundary as the role
 * and record words (agent/lib/agent-vocabulary.ts `fill`):
 *
 *   {period} {periods} {Period} {Periods}                    `label`
 *   {period_item} {period_items} {Period_item} {Period_items}  `item_label`
 *
 * and text a person reads takes the word from lib/ui-words.ts (`W.period`, `W.periodList`, `W.periodItem`).
 * Identifiers never change with a profile: the `cycles` table, `cycle_id`, the `/api/ops/cycles` routes, the
 * `list_cycles` / `upsert_cycle` tools and the `cycleId` parameter keep their names.
 *
 * Every surface reads the mode and the words from HERE, never from the profile directly, so "off" cannot be on in
 * one place and off in another.
 *
 * Pure: plain data from the generated profile, safe in the browser, the agent and an offline script.
 */
import { DEPLOYMENT_PROFILE, type DeploymentProfile, type WorkPeriodMode } from "./deployment-profile.generated.ts";

export type { WorkPeriodMode };
type Pair = { singular: string; plural: string };

export interface WorkPeriods {
  mode: WorkPeriodMode;
  /** False under mode "off": nothing about periods is offered, shown, registered or answered. */
  enabled: boolean;
  /** One shared period with a lead, a capacity and a burndown. */
  team: boolean;
  /** Each person's own items within the period. */
  individual: boolean;
  label: Pair;
  listLabel: Pair;
  itemLabel: Pair;
  /** How long a new period runs, in days; null = a new period has no dates until someone sets them. */
  lengthDays: number | null;
  autoRollover: boolean;
}

/** The base product's own words and behaviour, for a profile written before `work_periods` existed. */
const FALLBACK: DeploymentProfile["work_periods"] = {
  mode: "team",
  label: { singular: "period", plural: "periods" },
  list_label: { singular: "period", plural: "periods" },
  item_label: { singular: "item", plural: "items" },
  length_days: null,
  auto_rollover: false,
};

/** What a profile says about periods. A parameter so a test or a preview can pass another profile's. */
export function workPeriodsOf(profile: { work_periods?: Partial<DeploymentProfile["work_periods"]> }): WorkPeriods {
  const wp = { ...FALLBACK, ...(profile.work_periods ?? {}) };
  return {
    mode: wp.mode,
    enabled: wp.mode !== "off",
    team: wp.mode === "team",
    individual: wp.mode === "individual",
    label: wp.label,
    listLabel: wp.list_label,
    itemLabel: wp.item_label,
    lengthDays: wp.length_days,
    autoRollover: wp.auto_rollover && wp.mode !== "off",
  };
}

/** This deployment's. */
export const WORK_PERIODS: WorkPeriods = workPeriodsOf(DEPLOYMENT_PROFILE);

/** The placeholders base text writes for the period words (agent/lib/agent-vocabulary.ts fills them). */
export const PERIOD_KEYS = [
  "period", "periods", "Period", "Periods",
  "period_item", "period_items", "Period_item", "Period_items",
] as const;

const upperFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The word one period placeholder stands for under `wp`: `periods` -> the label's plural, `Period_item` -> the item label, capitalised. */
export function periodWordOf(wp: WorkPeriods, key: string): string {
  const lower = key[0].toLowerCase() + key.slice(1);
  const plural = lower.endsWith("s");
  const pair = lower.startsWith("period_item") ? wp.itemLabel : wp.label;
  const word = plural ? pair.plural : pair.singular;
  return key === lower ? word : upperFirst(word);
}

/** Text with its period placeholders filled from `wp` and nothing else changed. */
export function fillPeriodWords(text: string, wp: WorkPeriods = WORK_PERIODS): string {
  if (!text.includes("{")) return text;
  return text.replace(/(?<!\$)\{(period_items?|Period_items?|periods?|Periods?)\}/g, (_m, k: string) => periodWordOf(wp, k));
}

/** The short code a period's number is shown with: the first two letters of its word, upper case. */
export function periodSlugPrefix(wp: WorkPeriods = WORK_PERIODS): string {
  const letters = wp.label.singular.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase();
  return letters.length === 2 ? letters : "PE";
}

const DAY = 86_400_000;

export interface PeriodWindow {
  id: string;
  name: string;
  startsAt: Date | string | null;
  endsAt: Date | string | null;
  state?: string | null;
  archivedAt?: Date | string | null;
}
const ms = (v: Date | string | null | undefined): number | null => {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

/** The period whose window contains `now`: the same rule the task list's "Current" filter has always used. */
export function currentPeriod<T extends PeriodWindow>(periods: readonly T[], now: number = Date.now()): T | undefined {
  return periods.find((c) => {
    const s = ms(c.startsAt); const e = ms(c.endsAt);
    return !c.archivedAt && s !== null && e !== null && s <= now && now <= e;
  });
}

/**
 * The period that follows `from`: the earliest one that starts at or after `from` ends (after it starts, when it has
 * no end), not closed and not archived. Undefined when there is none yet.
 */
export function nextPeriod<T extends PeriodWindow>(periods: readonly T[], from: PeriodWindow): T | undefined {
  const edge = ms(from.endsAt) ?? ms(from.startsAt);
  if (edge === null) return undefined;
  return periods
    .filter((c) => c.id !== from.id && !c.archivedAt && c.state !== "closed" && (ms(c.startsAt) ?? -Infinity) >= edge - 1)
    .sort((a, b) => (ms(a.startsAt) ?? 0) - (ms(b.startsAt) ?? 0))[0];
}

/**
 * The window and the name of the period to open after `from` (or at `now`, when there is no `from` with an end):
 * `lengthDays` long, named by the profile's word and its start date ("Week of 2026-10-05").
 */
export function followingWindow(from: PeriodWindow | null, lengthDays: number, wp: WorkPeriods = WORK_PERIODS, now: number = Date.now()): { name: string; startsAt: Date; endsAt: Date } {
  let start = (from && (ms(from.endsAt) ?? null)) ?? startOfUtcDay(now);
  // A period that ended long ago is followed by the window that contains today, not by one already over.
  if (from && start + lengthDays * DAY <= now) {
    const skipped = Math.floor((now - start) / (lengthDays * DAY));
    start += skipped * lengthDays * DAY;
  }
  const startsAt = new Date(start);
  return { name: `${upperFirst(wp.label.singular)} of ${startsAt.toISOString().slice(0, 10)}`, startsAt, endsAt: new Date(start + lengthDays * DAY) };
}
function startOfUtcDay(t: number): number {
  return Math.floor(t / DAY) * DAY;
}

export interface PeriodTask {
  id: string;
  title: string;
  done: boolean;
  status?: string | null;
  assignee: string | null;
  createdBy: string;
  cycleId: string | null;
  archivedAt?: Date | string | null;
}
export interface MemberGoal {
  member: string;
  goal: string | null;
  targetCount: number | null;
}
export interface PersonProgress<T extends PeriodTask = PeriodTask> {
  /** The person's email, lower case: a task's assignee, or its creator when it has none. */
  person: string;
  goal: string | null;
  /** How many items the person planned for the period; null = not stated. */
  targetCount: number | null;
  /** The larger of what was planned and what is filed: the denominator of the progress bar. */
  planned: number;
  total: number;
  done: number;
  /** done / planned, 0 to 1 (0 when nothing is planned). */
  progress: number;
  items: T[];
}

/** Who a task in a period belongs to: its assignee, or the person who filed it (`todos.assignee` null = the creator). */
export const taskOwner = (t: Pick<PeriodTask, "assignee" | "createdBy">): string => (t.assignee ?? t.createdBy ?? "").trim().toLowerCase();

/**
 * One period under mode individual: every person who has an item in it or a goal for it, each with their own items
 * and progress. `me` (when given) comes first, whether or not they have anything yet; the others follow by name.
 * Cancelled items are not counted as planned work.
 */
export function progressByPerson<T extends PeriodTask>(periodId: string, tasks: readonly T[], goals: readonly MemberGoal[], me?: string | null): PersonProgress<T>[] {
  const mine = me?.trim().toLowerCase() || null;
  const byPerson = new Map<string, T[]>();
  for (const t of tasks) {
    if (t.cycleId !== periodId || t.archivedAt) continue;
    const who = taskOwner(t);
    if (!who) continue;
    byPerson.set(who, [...(byPerson.get(who) ?? []), t]);
  }
  const goalOf = new Map(goals.map((g) => [g.member.trim().toLowerCase(), g]));
  const people = new Set<string>([...byPerson.keys(), ...goalOf.keys(), ...(mine ? [mine] : [])]);
  const rows = [...people].map((person) => {
    const items = byPerson.get(person) ?? [];
    const counted = items.filter((t) => t.status !== "cancelled");
    const done = counted.filter((t) => t.done).length;
    const g = goalOf.get(person);
    const targetCount = g?.targetCount ?? null;
    const planned = Math.max(targetCount ?? 0, counted.length);
    return { person, goal: g?.goal ?? null, targetCount, planned, total: counted.length, done, progress: planned ? Math.min(1, done / planned) : 0, items };
  });
  return rows.sort((a, b) => (a.person === mine ? -1 : b.person === mine ? 1 : a.person.localeCompare(b.person)));
}

export interface RosterLine {
  email: string;
  managerEmail: string | null;
}

/**
 * Is `actor` in `person`'s reporting chain (their manager, that manager's manager, …) per the roster? The roster
 * models reporting as one line per person (`people_roster.manager_email`); a loop in it ends the walk.
 */
export function managesPerson(roster: readonly RosterLine[], actor: string, person: string): boolean {
  const a = actor.trim().toLowerCase();
  const managerOf = new Map(roster.map((r) => [r.email.trim().toLowerCase(), r.managerEmail?.trim().toLowerCase() || null]));
  const seen = new Set<string>();
  let cur = managerOf.get(person.trim().toLowerCase()) ?? null;
  while (cur && !seen.has(cur)) {
    if (cur === a) return true;
    seen.add(cur);
    cur = managerOf.get(cur) ?? null;
  }
  return false;
}

/** May `actor` set, change or complete an item (or a goal) that belongs to `person`? Their own, or a reportee's. */
export function mayActFor(roster: readonly RosterLine[], actor: string, person: string): boolean {
  return actor.trim().toLowerCase() === person.trim().toLowerCase() || managesPerson(roster, actor, person);
}

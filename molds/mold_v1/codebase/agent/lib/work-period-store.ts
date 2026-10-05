/**
 * Work periods in the DATABASE: the reads and writes the agent's tools (agent/lib/todo-tools.ts) and the ops routes
 * (app/api/ops/cycles/**, app/api/ops/todos/**) share, so both doors apply one rule.
 *
 * Every function takes the caller's workspace-scoped transaction (`withOrgDb` in the agent, `withOrgRls` in the web
 * app) and ALSO filters by `org_id`: row-level security is the fence, the filter is the query saying what it means.
 * Nothing here reaches across workspaces, and nothing here runs when the profile's mode is "off" (the callers are
 * not registered, or answer 404, before they get this far).
 *
 * Server-only (it imports the schema); the pure rules are in agent/lib/work-periods.ts.
 */
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./db/schema.ts";
import { cycleMemberGoals, cycles, entityActivity, peopleRoster, todos } from "./db/schema.ts";
import {
  WORK_PERIODS,
  currentPeriod,
  followingWindow,
  mayActFor,
  nextPeriod,
  taskOwner,
  type RosterLine,
  type WorkPeriods,
} from "./work-periods.ts";

/** A workspace-scoped transaction (or the database handle inside one). */
export type PeriodTx = Pick<PostgresJsDatabase<typeof schema>, "select" | "insert" | "update" | "delete">;
export type CycleRow = typeof cycles.$inferSelect;

/** The workspace's periods that are not archived, earliest start first. */
export async function listPeriods(tx: PeriodTx, orgId: string): Promise<CycleRow[]> {
  return tx.select().from(cycles).where(and(eq(cycles.orgId, orgId), isNull(cycles.archivedAt))).orderBy(asc(cycles.startsAt));
}

/** The reporting lines of the workspace's roster (`people_roster.manager_email`). */
export async function rosterLines(tx: PeriodTx, orgId: string): Promise<RosterLine[]> {
  return tx
    .select({ email: peopleRoster.email, managerEmail: peopleRoster.managerEmail })
    .from(peopleRoster)
    .where(and(eq(peopleRoster.orgId, orgId), isNull(peopleRoster.archivedAt)));
}

/** Every person's own goal for one period. */
export async function goalsFor(tx: PeriodTx, orgId: string, cycleId: string) {
  return tx.select().from(cycleMemberGoals).where(and(eq(cycleMemberGoals.orgId, orgId), eq(cycleMemberGoals.cycleId, cycleId)));
}

/** A refusal sentence, in the deployment's words, for acting on what belongs to someone the actor does not manage. */
export function refusalFor(person: string, wp: WorkPeriods = WORK_PERIODS): string {
  return `You can set ${wp.itemLabel.plural} for yourself, and for people who report to you on the roster. ${person} does not report to you.`;
}

/**
 * Set one person's goal and planned count for a period (only the fields given change). Refused, with a sentence,
 * unless the actor is that person or in their reporting chain.
 */
export async function setMemberGoal(
  tx: PeriodTx,
  orgId: string,
  actor: string,
  input: { cycleId: string; member: string; goal?: string | null; targetCount?: number | null },
): Promise<{ refused: string } | { item: typeof cycleMemberGoals.$inferSelect }> {
  const member = input.member.trim().toLowerCase();
  if (!mayActFor(await rosterLines(tx, orgId), actor, member)) return { refused: refusalFor(member) };
  const [period] = await tx.select({ id: cycles.id }).from(cycles).where(and(eq(cycles.id, input.cycleId), eq(cycles.orgId, orgId)));
  if (!period) return { refused: `No ${WORK_PERIODS.label.singular} with that id.` };
  const set: Record<string, unknown> = { updatedBy: actor, updatedAt: new Date() };
  if (input.goal !== undefined) set.goal = input.goal?.trim() ? input.goal.trim() : null;
  if (input.targetCount !== undefined) set.targetCount = input.targetCount;
  const [item] = await tx
    .insert(cycleMemberGoals)
    .values({ orgId, cycleId: input.cycleId, member, goal: (set.goal as string | null | undefined) ?? null, targetCount: input.targetCount ?? null, updatedBy: actor })
    .onConflictDoUpdate({ target: [cycleMemberGoals.orgId, cycleMemberGoals.cycleId, cycleMemberGoals.member], set })
    .returning();
  return { item };
}

/**
 * Under mode individual, may `actor` make this write to a task? A task in a period belongs to its assignee (its
 * creator when it has none). Writing one that is, or becomes, somebody else's needs the actor to be in that person's
 * reporting chain. A task outside every period is the team's shared checklist, as it always was: never refused.
 * Returns the refusal sentence, or null. Under any other mode: null.
 */
export async function taskWriteRefusal(
  tx: PeriodTx,
  orgId: string,
  actor: string,
  taskId: string | null,
  patch: { cycleId?: string | null; assignee?: string | null },
  wp: WorkPeriods = WORK_PERIODS,
): Promise<string | null> {
  if (!wp.individual) return null;
  let before: { assignee: string | null; createdBy: string; cycleId: string | null } | null = null;
  if (taskId) {
    const [row] = await tx
      .select({ assignee: todos.assignee, createdBy: todos.createdBy, cycleId: todos.cycleId })
      .from(todos)
      .where(and(eq(todos.id, taskId), eq(todos.orgId, orgId)));
    before = row ?? null;
    if (!before) return null; // the write itself answers "not found"
  }
  const afterCycle = patch.cycleId !== undefined ? patch.cycleId : (before?.cycleId ?? null);
  // A period this workspace does not hold cannot take an item.
  if (patch.cycleId) {
    const [held] = await tx.select({ id: cycles.id }).from(cycles).where(and(eq(cycles.id, patch.cycleId), eq(cycles.orgId, orgId)));
    if (!held) return `No ${wp.label.singular} with that id.`;
  }
  const afterOwner = taskOwner({ assignee: patch.assignee !== undefined ? patch.assignee : (before?.assignee ?? null), createdBy: before?.createdBy ?? actor });
  const people = new Set<string>();
  if (before?.cycleId) people.add(taskOwner(before));
  if (afterCycle) people.add(afterOwner);
  people.delete(actor.trim().toLowerCase());
  people.delete("");
  if (!people.size) return null;
  const roster = await rosterLines(tx, orgId);
  for (const person of people) if (!mayActFor(roster, actor, person)) return refusalFor(person, wp);
  return null;
}

/** The period that contains now; when there is none and the profile gives a length, it is opened. */
export async function ensureCurrentPeriod(tx: PeriodTx, orgId: string, actor: string, wp: WorkPeriods = WORK_PERIODS): Promise<CycleRow | null> {
  const all = await listPeriods(tx, orgId);
  const now = currentPeriod(all);
  if (now) return now;
  if (wp.lengthDays === null) return null;
  const last = [...all].filter((c) => c.endsAt && c.endsAt.getTime() <= Date.now()).sort((a, b) => b.endsAt!.getTime() - a.endsAt!.getTime())[0] ?? null;
  const window = followingWindow(last, wp.lengthDays, wp);
  const [created] = await tx.insert(cycles).values({ orgId, ...window, state: "active", createdBy: actor }).returning();
  return created;
}

/** The period after `from`; opened (with the profile's length) when there is none and a length is set. */
export async function ensureNextPeriod(tx: PeriodTx, orgId: string, from: CycleRow, actor: string, wp: WorkPeriods = WORK_PERIODS): Promise<{ period: CycleRow | null; created: boolean }> {
  const found = nextPeriod(await listPeriods(tx, orgId), from);
  if (found) return { period: found, created: false };
  if (wp.lengthDays === null) return { period: null, created: false };
  const window = followingWindow(from, wp.lengthDays, wp);
  const [created] = await tx.insert(cycles).values({ orgId, ...window, state: "planning", createdBy: actor }).returning();
  return { period: created, created: true };
}

export interface RolloverResult {
  moved: number;
  /** Where the unfinished tasks went: a period's id and name, or null for the backlog. */
  targetId: string | null;
  targetName: string | null;
  /** The target period was opened by this rollover. */
  created: boolean;
}

/**
 * Move every unfinished, non-archived task out of one period.
 *
 *   target: a period id   into that period
 *   target: null          to the backlog (mode team's default: what "Roll over unfinished" has always done)
 *   target: "next"        into the period that follows, opened when there is none (mode individual's default)
 *
 * A task keeps its assignee, so under mode individual each person's unfinished items arrive as theirs in their next
 * period. `assignee` narrows the move to one person's. Only `cycle_id` and `updated_at` change on a moved row.
 */
export async function rollOver(
  tx: PeriodTx,
  orgId: string,
  fromId: string,
  opts: { target: string | null | "next"; assignee?: string | null; actor: string },
  wp: WorkPeriods = WORK_PERIODS,
): Promise<RolloverResult | { notFound: "source" | "target" }> {
  const [from] = await tx.select().from(cycles).where(and(eq(cycles.id, fromId), eq(cycles.orgId, orgId)));
  if (!from) return { notFound: "source" };
  let targetId: string | null = null; let targetName: string | null = null; let created = false;
  if (opts.target === "next") {
    const next = await ensureNextPeriod(tx, orgId, from, opts.actor, wp);
    targetId = next.period?.id ?? null; targetName = next.period?.name ?? null; created = next.created;
  } else if (opts.target) {
    const [c] = await tx.select({ id: cycles.id, name: cycles.name }).from(cycles).where(and(eq(cycles.id, opts.target), eq(cycles.orgId, orgId)));
    // A target this workspace does not hold (another workspace's id, or none): nothing moves. The move used to be
    // made anyway, leaving the tasks pointing at a period nobody here can see.
    if (!c) return { notFound: "target" };
    targetId = c.id; targetName = c.name;
  }
  const open = await tx
    .select({ id: todos.id, assignee: todos.assignee, createdBy: todos.createdBy })
    .from(todos)
    .where(and(eq(todos.orgId, orgId), eq(todos.cycleId, fromId), isNull(todos.archivedAt), ne(todos.done, true)));
  const person = opts.assignee?.trim().toLowerCase() || null;
  const ids = open.filter((t) => !person || taskOwner(t) === person).map((t) => t.id);
  let moved = 0;
  for (const id of ids) {
    const rows = await tx.update(todos).set({ cycleId: targetId, updatedAt: new Date() }).where(and(eq(todos.id, id), eq(todos.orgId, orgId), eq(todos.cycleId, fromId))).returning({ id: todos.id });
    moved += rows.length;
  }
  return { moved, targetId, targetName, created };
}

/** The sentence the activity feed keeps for a rollover. */
export function rolloverSentence(r: RolloverResult, wp: WorkPeriods = WORK_PERIODS): string {
  const noun = wp.individual ? (r.moved === 1 ? wp.itemLabel.singular : wp.itemLabel.plural) : `task${r.moved === 1 ? "" : "s"}`;
  return `Rolled over ${r.moved} unfinished ${noun} to ${r.targetName ?? "Backlog"}`;
}

/**
 * AUTO ROLLOVER (`work_periods.auto_rollover`): every period that has ended and is not closed is closed, and its
 * unfinished tasks are carried into the period that follows (opened when there is none). Runs inside the caller's
 * workspace transaction when the periods are read (the list route, the model's list tool), so it needs no timer and
 * no path that crosses workspaces; running it again finds nothing to do. Returns what it did, earliest first.
 */
export async function rollOverEnded(tx: PeriodTx, orgId: string, wp: WorkPeriods = WORK_PERIODS, now: number = Date.now()): Promise<{ from: CycleRow; result: RolloverResult }[]> {
  if (!wp.autoRollover || wp.lengthDays === null) return [];
  const out: { from: CycleRow; result: RolloverResult }[] = [];
  // Each pass may open a period; a long gap is crossed in one step (followingWindow), so this ends quickly.
  for (let pass = 0; pass < 12; pass++) {
    const ended = (await listPeriods(tx, orgId)).filter((c) => c.state !== "closed" && c.endsAt && c.endsAt.getTime() <= now);
    if (!ended.length) break;
    for (const from of ended) {
      const result = await rollOver(tx, orgId, from.id, { target: "next", actor: "system" }, wp);
      if ("notFound" in result) continue;
      await tx.update(cycles).set({ state: "closed", updatedAt: new Date() }).where(and(eq(cycles.id, from.id), eq(cycles.orgId, orgId)));
      await tx.insert(entityActivity).values({
        orgId,
        entityType: "cycle",
        entityId: from.id,
        actor: "system",
        event: rolloverSentence(result, wp),
      });
      out.push({ from, result });
    }
  }
  // The period that has just begun is the active one.
  const current = currentPeriod(await listPeriods(tx, orgId), now);
  if (current && current.state === "planning") await tx.update(cycles).set({ state: "active", updatedAt: new Date() }).where(and(eq(cycles.id, current.id), eq(cycles.orgId, orgId)));
  return out;
}

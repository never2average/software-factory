/**
 * A RECORD'S WORKFLOW STEP ACTIONS, DELIVERED (phase 6 of the workflow engine, docs/WORKFLOW_ENGINE.md "Step actions").
 *
 * The workflow's own rules may queue an email or an agent run when a step changes (the engine's outbox). This app
 * sends no email, ever. Instead:
 *
 *   an email action   becomes the app's own notification (the desktop notifications a person turned on; agent/lib/
 *                     push-notify.ts is the same channel for chats) to the step's holders, and to the people the action
 *                     names, every one of them someone who can still act in the workspace; in the profile's words: the
 *                     action's own subject and body (the profile's text), else a line naming the step and the record.
 *   an agent action   becomes a task for the assistant, written through the task path (the task-workflow service, as a
 *                     recurring task's next occurrence is): its name as the title, its instructions as the notes, the
 *                     step's holder as the assignee, whoever's move fired it as the author. Both are asked again when
 *                     it is delivered: an author who can no longer act in the workspace is replaced by "system", and a
 *                     holder who cannot is not made the assignee.
 *
 * EXACTLY ONCE. An action FIRES in the transaction of the step change that set it off (lib/record-workflow-runtime.ts
 * takeStepActions): saved on the instance with the step, once per entry of its step (the fired-once ledger on the
 * instance, `fired_actions`). A move that rolls back fires nothing; a retried move that changes nothing fires nothing;
 * a rule that matches again while its step stays where it is fires nothing. DELIVERY runs after that transaction:
 *
 *   1. claim (a short transaction, under the record's workflow lock, so it waits for the step change to commit or roll
 *      back): the instance's pending actions become `processing`, saved (compare-and-swap on its revision);
 *   2. deliver each, with nothing held, the claim renewed before each (so a slow earlier one never makes a later one
 *      look abandoned), each within a time well inside the claim:
 *        a notification carries the action's delivery id as its tag, so a second showing of the same action replaces
 *        the first on a device; the people it was already shown to (or found nothing to show to) are kept on the
 *        action (`reached`), so a later attempt shows it only to the others;
 *        a task carries it as `custom.workflow_action`, which the database keeps unique in a workspace
 *        (drizzle/0050_todos_workflow_action_unique.sql), and is looked for before it is written and again after a
 *        failed answer, so a retried or doubled delivery finds the task the first one made and never makes a second;
 *   3. finish, after each action (a short transaction, under the lock): a delivered action leaves the instance, with an `external_delivered`
 *      row in its history; a failed one goes back to pending with a later attempt, and after MAX_ATTEMPTS is
 *      dead-lettered (`external_dead_lettered`); a notification that ran out of time with people left is due again at
 *      once, for those people, and that attempt does not count as failed.
 *
 * Claim and finish save the instance (its revision moves on) but change nothing a move depends on: a move checked
 * before a delivery and reserved after it is not refused for it (lib/record-workflow-runtime.ts moveBasisOf).
 *
 * A claim older than CLAIM_STALE_MS belongs to a delivery that died, and is claimed again. Delivery is started by the
 * door that made the step change (`scheduleStepActions`, not awaited) and swept by /api/cron/deliver-step-actions.
 *
 * Every read and write is in the record's workspace (the caller's `runIn`: withOrgRls in the web app, withOrgDb in the
 * agent); recipients and tasks are that workspace's only.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { orgMembers, recordWorkflowInstances, todos } from "../agent/lib/db/schema.ts";
import { areaView, type RecordAreas } from "../agent/lib/record-areas.ts";
import { RECORD_AREAS, type RecordAreaId } from "../agent/lib/record-areas.generated.ts";
import { RECORD_WORKFLOWS } from "./record-workflows.generated.ts";
import { RecordWorkflowStore, type ScopedDb } from "./record-workflow-store.ts";
import { recordWorkflowLockKey, stepActionsOf, type HistoryEvent, type StepAction, type WorkflowDSL, type WorkflowInstance } from "./record-workflow-runtime.ts";

/** Runs `fn` in one workspace-scoped transaction (withOrgRls in the web app, withOrgDb in the agent). */
export type StepActionRunner = <T>(orgId: string, fn: (tx: ScopedDb) => Promise<T>) => Promise<T>;

/**
 * A claim held this long without finishing belongs to a delivery that died: it is claimed again. Each action's claim
 * is renewed before it is delivered, and no delivery of one action runs longer than ACTION_BUDGET_MS (a notification
 * stops sending there; a task's write is cut off at TASK_TIMEOUT_MS), so a live delivery never looks stale.
 */
export const CLAIM_STALE_MS = 2 * 60_000;
/** The most one action's delivery runs: well inside a claim. */
export const ACTION_BUDGET_MS = CLAIM_STALE_MS / 2;
/** How long a task's write may take (inside ACTION_BUDGET_MS). */
const TASK_TIMEOUT_MS = 30_000;
/** The author of a task whose mover can no longer act in the workspace. */
export const SYSTEM_AUTHOR = "system";
/** After this many failed attempts an action is dead-lettered (kept on the instance, never tried again on its own). */
export const MAX_ATTEMPTS = 5;
/** The wait before the next attempt after a failure, by attempts made. */
const backoffMs = (attempts: number) => Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));

/** The `custom` key a task made from an agent action carries: the action's delivery id. */
export const WORKFLOW_ACTION_KEY = "workflow_action";

/** What a notification of an email action says, to one person's devices. */
export interface StepNotice {
  title: string;
  body?: string;
  tag: string;
  url: string;
}

/** What one notification run came to. */
export interface StepNotified {
  /** The people it was shown to, and on how many devices. */
  people: number;
  devices: number;
  /**
   * The people it is DONE with: shown to, or found nothing to show to (no device, or no longer able to act). Absent:
   * all of them. The others (time ran out, a check failed, no device answered) are tried again later.
   */
  done?: string[];
}

/** What delivering needs from the world: the database, the devices, the task path. Injected by the tests. */
export interface StepActionDeps {
  runIn: StepActionRunner;
  /**
   * Show `notice` on the devices of each of `emails` who can still act in `orgId`, within `budgetMs` (what is left
   * then is left out of `done`).
   */
  notify(orgId: string, emails: string[], notice: (preview: boolean) => StepNotice, opts: { budgetMs: number }): Promise<StepNotified>;
  /** Write a task through the task path as `actor`; its id. */
  createTask(orgId: string, actor: string, body: Record<string, unknown>): Promise<{ id: string }>;
  /** Can `email` still act in `orgId` (a member of it)? */
  canAct(orgId: string, email: string): Promise<boolean>;
  now?: () => Date;
}

/** A step action as delivery keeps it: the recipients an earlier attempt is done with (an email's). */
type Delivering = StepAction & { reached?: string[] };

/** The words of an area's record, from the profile (its noun), for a record of `area`. */
function nounOf(area: string, areas: RecordAreas): string {
  return Object.hasOwn(areas, area) ? areaView(area as RecordAreaId, areas).noun : "record";
}

/** The notification an email action shows: its own subject and body, else a line naming the step and the record. */
export function stepNoticeOf(action: StepAction & { kind: "email" }, orgId: string, preview: boolean, areas: RecordAreas = RECORD_AREAS, product = ""): StepNotice {
  const tag = `step-action:${action.delivery.id}`;
  const url = `/?org=${encodeURIComponent(orgId)}`;
  const noun = nounOf(action.record.area, areas);
  if (!preview) return { title: `${product.trim() || "Your workspace"}: a step is waiting for you`, tag, url };
  const title = (action.subject?.trim() || `The step "${action.step}" is waiting for you`).slice(0, 200);
  const named = action.record.label ? `the ${noun} "${action.record.label}"` : `a ${noun}`;
  const body = (action.body?.trim() || `The step "${action.step}" of ${named}.`).slice(0, 500);
  return { title, body, tag, url };
}

/**
 * The task an agent action becomes: for the assistant, on the record's step, assigned to the step's holder (`assignee`:
 * the holder to name instead, null for none; the deliverer passes the holder only while they can act in the workspace).
 */
export function stepTaskOf(action: StepAction & { kind: "agent" }, areas: RecordAreas = RECORD_AREAS, assignee?: string | null): Record<string, unknown> {
  const noun = nounOf(action.record.area, areas);
  const named = action.record.label ? `the ${noun} "${action.record.label}"` : `a ${noun}`;
  const notes = `For the assistant: ${action.prompt.trim()}\n\nFrom the step "${action.step}" of ${named}.`;
  const holder = assignee === undefined ? (action.holders?.[0] ?? null) : assignee;
  return {
    title: (action.name.trim() || `The step "${action.step}"`).slice(0, 300),
    notes: notes.length > 4000 ? `${notes.slice(0, 3999)}…` : notes,
    ...(holder ? { assignee: holder } : {}),
    custom: { [WORKFLOW_ACTION_KEY]: action.delivery.id },
  };
}

async function lock(tx: ScopedDb, orgId: string, areaId: string, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${recordWorkflowLockKey(orgId, areaId, key)}))`);
}

/** The record's instances (any workflow), with their histories. */
const instancesOf = (store: RecordWorkflowStore, areaId: string, key: string): Promise<WorkflowInstance[]> => store.listByEntity(areaId, key);

const due = (a: StepAction, now: number) =>
  (a.delivery.status === "pending" && Date.parse(a.delivery.next_attempt_at) <= now) ||
  (a.delivery.status === "processing" && (!a.delivery.claimed_at || now - Date.parse(a.delivery.claimed_at) >= CLAIM_STALE_MS));

/**
 * Step 1: the record's due actions, claimed (under the record's workflow lock, so after the step change that fired them
 * committed). Returns copies of what was claimed.
 */
export async function claimStepActions(tx: ScopedDb, orgId: string, areaId: string, key: string, now: Date): Promise<StepAction[]> {
  await lock(tx, orgId, areaId, key);
  const store = new RecordWorkflowStore(tx, orgId, { definitions: RECORD_WORKFLOWS as unknown as Record<string, WorkflowDSL> });
  const claimed: StepAction[] = [];
  for (const instance of await instancesOf(store, areaId, key)) {
    const mine = stepActionsOf(instance).filter((a) => due(a, now.getTime()));
    if (!mine.length) continue;
    for (const a of mine) {
      a.delivery = { ...a.delivery, status: "processing", claimed_at: now.toISOString(), attempts: a.delivery.attempts + 1 };
    }
    const saved = await store.update(instance);
    if (!saved.ok) throw saved.conflict;
    claimed.push(...mine.map((a) => structuredClone(a)));
  }
  return claimed;
}

/**
 * Before each action after the first: its claim renewed (under the lock), if it is still this delivery's (`processing`,
 * the same claim). The new claim time, or null when another delivery took it over (it is that one's now).
 */
export async function renewStepAction(tx: ScopedDb, orgId: string, areaId: string, key: string, action: StepAction, now: Date): Promise<string | null> {
  await lock(tx, orgId, areaId, key);
  const store = new RecordWorkflowStore(tx, orgId, { definitions: RECORD_WORKFLOWS as unknown as Record<string, WorkflowDSL> });
  for (const instance of await instancesOf(store, areaId, key)) {
    const mine = stepActionsOf(instance).find((a) => a.delivery.id === action.delivery.id);
    if (!mine) continue;
    if (mine.delivery.status !== "processing" || mine.delivery.claimed_at !== action.delivery.claimed_at) return null;
    const at = now.toISOString() === mine.delivery.claimed_at ? new Date(now.getTime() + 1).toISOString() : now.toISOString();
    mine.delivery = { ...mine.delivery, claimed_at: at };
    const saved = await store.update(instance);
    if (!saved.ok) throw saved.conflict;
    return at;
  }
  return null;
}

/** What delivering one action came to. */
export interface StepActionOutcome {
  id: string;
  kind: "email" | "agent";
  ok: boolean;
  /** email: the people and devices reached; agent: the task's id and whether this delivery made it. */
  detail: Record<string, unknown>;
  error?: string;
  /** An email that ran out of time with people left: those `done` are kept, the rest are due again at once. */
  partial?: { done: string[] };
}

/**
 * Step 3: the outcomes written back (under the lock): a delivered action leaves the instance, its history says so; a
 * failed one is pending again with a later attempt, or dead-lettered after MAX_ATTEMPTS. Only an action still claimed
 * by this delivery (`processing`, the same claim) is touched.
 */
export async function finishStepActions(tx: ScopedDb, orgId: string, areaId: string, key: string, claimed: StepAction[], outcomes: StepActionOutcome[], now: Date): Promise<void> {
  await lock(tx, orgId, areaId, key);
  const store = new RecordWorkflowStore(tx, orgId, { definitions: RECORD_WORKFLOWS as unknown as Record<string, WorkflowDSL> });
  const claims = new Map(claimed.map((a) => [a.delivery.id, a.delivery.claimed_at]));
  const byId = new Map(outcomes.map((o) => [o.id, o]));
  const at = now.toISOString();
  for (const instance of await instancesOf(store, areaId, key)) {
    let touched = false;
    const rows: HistoryEvent[] = [];
    instance.outbox = instance.outbox.filter((entry) => {
      const a = entry as StepAction;
      const o = byId.get(a.delivery?.id);
      if (!o || a.delivery.status !== "processing" || a.delivery.claimed_at !== claims.get(a.delivery.id)) return true;
      touched = true;
      const detail = a.kind === "email" ? "email" : `agent:${a.name}`;
      if (o.ok) {
        rows.push({ at, type: "external_delivered", step_id: a.step_id, detail, data: { delivery: a.delivery.id, attempts: a.delivery.attempts, ...o.detail }, actor: a.actor, source: "rule" });
        return false;
      }
      // The people an email is done with stay done: a later attempt shows it only to the others.
      if (o.partial) (a as Delivering).reached = [...new Set([...((a as Delivering).reached ?? []), ...o.partial.done])];
      // Out of time with people done: progress, not a failure (due again at once, the attempt not counted).
      const progress = Boolean(o.partial && o.partial.done.length);
      const attempts = progress ? Math.max(0, a.delivery.attempts - 1) : a.delivery.attempts;
      const dead = !progress && attempts >= MAX_ATTEMPTS;
      a.delivery = { ...a.delivery, attempts, status: dead ? "dead_letter" : "pending", next_attempt_at: new Date(now.getTime() + (progress ? 0 : backoffMs(attempts))).toISOString(), last_error: (o.error ?? "failed").slice(0, 300) };
      delete a.delivery.claimed_at;
      if (dead) rows.push({ at, type: "external_dead_lettered", step_id: a.step_id, detail, data: { delivery: a.delivery.id, attempts: a.delivery.attempts, error: a.delivery.last_error }, actor: a.actor, source: "rule" });
      return true;
    });
    if (!touched) continue;
    instance.history.push(...rows);
    instance.updated_at = at;
    const saved = await store.update(instance);
    if (!saved.ok) throw saved.conflict;
  }
}

/** A task made from this action already (a retried delivery after the first wrote it): its id, or null. */
async function taskOf(tx: ScopedDb, orgId: string, deliveryId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: todos.id })
    .from(todos)
    .where(and(eq(todos.orgId, orgId), sql`${todos.custom} @> ${JSON.stringify({ [WORKFLOW_ACTION_KEY]: deliveryId })}::text::jsonb`))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Deliver the record's due step actions (steps 1 to 3 above). Never throws for one action's failure: it is written back
 * as failed. Returns what each came to (for the tests and the sweep).
 */
export async function deliverStepActions(orgId: string, areaId: string, key: string, deps: StepActionDeps, opts: { areas?: RecordAreas; product?: string } = {}): Promise<StepActionOutcome[]> {
  const areas = opts.areas ?? RECORD_AREAS;
  const now = () => deps.now?.() ?? new Date();
  const claimed = (await deps.runIn(orgId, (tx) => claimStepActions(tx, orgId, areaId, key, now()))) as Delivering[];
  if (!claimed.length) return [];
  const outcomes: StepActionOutcome[] = [];
  for (const [i, a] of claimed.entries()) {
    // The claim renewed before each action after the first: still this delivery's, or another one's now (left to it).
    if (i > 0) {
      const at = await deps.runIn(orgId, (tx) => renewStepAction(tx, orgId, areaId, key, a, now()));
      if (!at) continue;
      a.delivery = { ...a.delivery, claimed_at: at };
    }
    const outcome = await deliverOne(orgId, a, deps, areas, opts.product);
    outcomes.push(outcome);
    // Written back at once: an action delivered is never left claimed while the next one is delivered.
    await deps.runIn(orgId, (tx) => finishStepActions(tx, orgId, areaId, key, [a], [outcome], now()));
  }
  return outcomes;
}

/** Deliver one claimed action (with nothing held): what it came to. Never throws. */
async function deliverOne(orgId: string, a: Delivering, deps: StepActionDeps, areas: RecordAreas, product: string | undefined): Promise<StepActionOutcome> {
  try {
    if (a.kind === "email") {
      const email = a as Delivering & { kind: "email" };
      const done = new Set(email.reached ?? []);
      const left = (email.recipients as string[]).filter((r) => !done.has(r.toLowerCase()));
      const reached = await deps.notify(orgId, left, (preview) => stepNoticeOf(email, orgId, preview, areas, product), { budgetMs: ACTION_BUDGET_MS });
      const handled = reached.done ?? left;
      const missing = left.filter((r) => !handled.some((h) => h.toLowerCase() === r.toLowerCase()));
      const detail = { people: reached.people, devices: reached.devices };
      if (missing.length) return { id: a.delivery.id, kind: "email", ok: false, detail, error: `not shown to ${missing.length} of ${left.length} yet`, partial: { done: handled.map((h) => h.toLowerCase()) } };
      return { id: a.delivery.id, kind: "email", ok: true, detail };
    } else {
      const agent = a as StepAction & { kind: "agent" };
      const found = await deps.runIn(orgId, (tx) => taskOf(tx, orgId, a.delivery.id));
      if (found) return { id: a.delivery.id, kind: "agent", ok: true, detail: { task: found, made: false } };
      // Who writes it and who holds it, as they stand now: a mover or a holder who left is neither.
      const author = a.actor && (await deps.canAct(orgId, a.actor)) ? a.actor : SYSTEM_AUTHOR;
      const holder = agent.holders?.[0] ?? null;
      const assignee = holder && (await deps.canAct(orgId, holder)) ? holder : null;
      try {
        const made = await deps.createTask(orgId, author, stepTaskOf(agent, areas, assignee));
        return { id: a.delivery.id, kind: "agent", ok: true, detail: { task: made.id, made: true, author, assignee } };
      } catch (error) {
        // Written after all (a late answer), or by another delivery (the database keeps one per action): the task
        // is there, and is this action's.
        const late = await deps.runIn(orgId, (tx) => taskOf(tx, orgId, a.delivery.id));
        if (!late) throw error;
        return { id: a.delivery.id, kind: "agent", ok: true, detail: { task: late, made: false } };
      }
    }
  } catch (error) {
    return { id: a.delivery.id, kind: a.kind, ok: false, detail: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * When a stored step action is next due, in SQL (as `due` reads it): a pending one at its next attempt; one being
 * delivered once its claim is stale (at once when it carries no claim time).
 */
const actionDueAt = (outbox: SQL) => sql`(
  select min(case e -> 'delivery' ->> 'status'
    when 'pending' then (e -> 'delivery' ->> 'next_attempt_at')::timestamptz
    else coalesce((e -> 'delivery' ->> 'claimed_at')::timestamptz + make_interval(secs => ${CLAIM_STALE_MS / 1000}), '-infinity'::timestamptz)
  end)
  from jsonb_array_elements(coalesce(${outbox}, '[]'::jsonb)) as e
  where e -> 'delivery' ->> 'status' in ('pending', 'processing'))`;

/**
 * The records of a workspace with a step action DUE now (`now`): a pending one whose next attempt has come, or one
 * whose claim is stale. Never one waiting out its backoff or being delivered right now. The longest waiting first.
 */
export async function recordsWithStepActions(tx: ScopedDb, orgId: string, limit = 20, now: Date = new Date()): Promise<{ area: string; key: string; dueAt: string }[]> {
  const dueAt = actionDueAt(sql`${recordWorkflowInstances.engineState} -> 'outbox'`);
  const rows = await tx
    .select({ area: recordWorkflowInstances.entityType, key: recordWorkflowInstances.entityId, dueAt: sql<string>`(${dueAt})::text` })
    .from(recordWorkflowInstances)
    .where(and(eq(recordWorkflowInstances.orgId, orgId), sql`${dueAt} <= ${now.toISOString()}::timestamptz`))
    .orderBy(dueAt, recordWorkflowInstances.entityId)
    .limit(limit);
  return rows.map((r) => ({ area: r.area, key: r.key, dueAt: r.dueAt }));
}

/**
 * The sweep's share of one tick across workspaces: one record of each in turn (each workspace's own list longest
 * waiting first), up to `n`. One workspace's backlog never keeps another's due records waiting.
 */
export function fairShare<T>(lists: T[][], n: number): T[] {
  const out: T[] = [];
  for (let round = 0; out.length < n; round += 1) {
    let any = false;
    for (const list of lists) {
      if (round >= list.length) continue;
      any = true;
      out.push(list[round]);
      if (out.length >= n) break;
    }
    if (!any) break;
  }
  return out;
}

// ── the production deliverer ─────────────────────────────────────────────────────────────────────────────────────

/** How many people's devices a notification run reaches at once. */
const NOTIFY_PARALLEL = 8;

/**
 * The real world: desktop notifications (the subscriptions the person turned on, in this workspace, while they can still
 * act in it; nothing at all without the server's push key) and the task-workflow service. Loaded when first used, so a
 * door that fires nothing never loads either.
 */
export function productionStepActionDeps(runIn: StepActionRunner): StepActionDeps {
  // Who can act in the workspace: a member of it (as lib/chat-queue-server.ts canActIn reads it), except that a failed
  // read THROWS here (canActIn answers no): the action is tried again later, never written as someone else's.
  const canAct = async (orgId: string, email: string) => {
    const rows = await runIn(orgId, (tx) => tx.select({ one: sql<number>`1` }).from(orgMembers).where(and(eq(orgMembers.orgId, orgId), sql`lower(${orgMembers.email}) = ${email.toLowerCase()}`)).limit(1));
    return rows.length > 0;
  };
  return {
    runIn,
    canAct,
    async notify(orgId, emails, notice, opts) {
      const until = Date.now() + opts.budgetMs;
      const [{ pushSubscriptions }, { sendWebPush, topicFor, vapidFromEnv }] = await Promise.all([
        import("../agent/lib/db/schema.ts"),
        import("../agent/lib/web-push.ts"),
      ]);
      const vapid = vapidFromEnv();
      const people = [...new Set(emails.map((e) => e.toLowerCase()))];
      // No push key: nothing can be shown, to anyone, now or later.
      if (!vapid || !people.length) return { people: 0, devices: 0, done: people };
      const subs = await runIn(orgId, (tx) => tx.select().from(pushSubscriptions).where(and(eq(pushSubscriptions.orgId, orgId), inArray(pushSubscriptions.ownerEmail, people))));
      const byPerson = new Map<string, typeof subs>();
      for (const s of subs) byPerson.set(s.ownerEmail.toLowerCase(), [...(byPerson.get(s.ownerEmail.toLowerCase()) ?? []), s]);
      const reached = new Set<string>();
      const done: string[] = [];
      let devices = 0;
      // One person: done when shown, or when there is nothing to show it on, or they can no longer act. A check that
      // failed, or devices that none answered, leave them for a later attempt.
      const one = async (person: string) => {
        const mine = byPerson.get(person) ?? [];
        if (!mine.length) return void done.push(person);
        let may: boolean;
        try {
          may = await canAct(orgId, person);
        } catch (error) {
          console.error(`[record-workflow] could not check who may see a step's notification in ${orgId}:`, error instanceof Error ? error.message : error);
          return;
        }
        if (!may) return void done.push(person);
        const sent = await Promise.all(mine.map((s) => {
          const payload = { v: 1, kind: "input", sessionId: "", ...notice(s.preview) };
          return sendWebPush(s, payload, vapid, { topic: topicFor(payload.tag), urgency: "normal", ttlSeconds: 24 * 60 * 60 });
        }));
        const ok = sent.filter((r) => r.status >= 200 && r.status < 300).length;
        devices += ok;
        if (ok) reached.add(person);
        if (ok || sent.every((r) => r.status !== 0)) done.push(person);
      };
      for (let i = 0; i < people.length && Date.now() < until; i += NOTIFY_PARALLEL) {
        await Promise.all(people.slice(i, i + NOTIFY_PARALLEL).map(one));
      }
      return { people: reached.size, devices, done };
    },
    async createTask(orgId, actor, body) {
      const { taskWorkflowRequest } = await import("../agent/lib/task-workflow-service.ts");
      return taskWorkflowRequest<{ id: string }>(orgId, actor, "/api/v1/tasks", { method: "POST", body, timeoutMs: TASK_TIMEOUT_MS });
    },
  };
}

/** Deliveries started by the doors and not finished yet (the tests wait for them: `settleStepActionDeliveries`). */
const inFlight = new Set<Promise<unknown>>();

/**
 * After a door's step change fired actions: deliver them, not awaited (the door answers at once). The claim takes the
 * record's workflow lock, so it runs once the door's transaction has committed (or finds nothing, if it rolled back).
 * `deps` defaults to the production deliverer on `runIn`.
 */
export function scheduleStepActions(orgId: string, areaId: string, key: string, runIn: StepActionRunner, deps?: StepActionDeps): void {
  const run = deliverStepActions(orgId, areaId, key, deps ?? stepActionDepsOverride?.(runIn) ?? productionStepActionDeps(runIn)).catch((error) => {
    console.error(`[record-workflow] could not deliver the step actions of ${areaId} ${key}:`, error instanceof Error ? error.message : error);
    return [];
  });
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
  void import("../agent/lib/push-notify.ts").then((m) => m.platformWaitUntil(run, 60_000)).catch(() => undefined);
}

/** Wait for every delivery the doors started (tests). */
export async function settleStepActionDeliveries(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

let stepActionDepsOverride: ((runIn: StepActionRunner) => StepActionDeps) | null = null;
/** The tests' world in place of the real one, for the deliveries the doors start (null: the real one again). */
export function setStepActionDeps(make: ((runIn: StepActionRunner) => StepActionDeps) | null): void {
  stepActionDepsOverride = make;
}

export type { StepAction };

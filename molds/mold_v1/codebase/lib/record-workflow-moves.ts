/**
 * A RECORD'S WORKFLOW ON ITS WRITE PATH: the half that reads and writes (phase 5 of the workflow engine,
 * docs/WORKFLOW_ENGINE.md "Runtime"; lib/record-workflow-runtime.ts is the pure half).
 *
 * Every door that writes a record of an area whose lifecycle runs a workflow (the ops routes, the agent's tools) does
 * two things, both on the handle of ITS OWN workspace-scoped transaction (`withOrgRls` in the web app, `withOrgDb` in the
 * agent), the one the record is written in:
 *
 *   1. before the validator: `openRecordWorkflow()` reads the record's instance (or seeds one in memory, not stored yet:
 *      attached lazily) and the workspace's people (people_roster, org_members: the engine's directory), and gives the
 *      validator the step rules (`gate`, checkMove's WorkflowGate). A move that breaks one is refused under "strict" (the
 *      409 with the moves there are) and goes through under "warn", like any other rule.
 *   2. after the record is written, in the same transaction: `commitRecordWorkflow()` attaches the instance (a create, or
 *      the first move after the binding) and applies the move's step change, through the step rules and the workflow's
 *      own rules, then saves it through RecordWorkflowStore (compare-and-swap on the revision read in 1). A stale revision
 *      (someone moved the record's workflow in between) THROWS the store's RecordWorkflowConflict, so the transaction
 *      rolls back, the record write with it; the door answers 409 (`workflowConflictBody`).
 *
 * ONE KEY PER RECORD. A record's workflow is keyed by its own server-derived identity (`workflowRecordKey`: a task's and
 * a period's id, an implementation's implementation_id, a deployment's account and id), never by anything a request
 * names, at every door. The door takes the record's workflow lock (`lockRecordWorkflow`) BEFORE it reads the record,
 * so the move is checked from the state the record is in now; a second mover waits for the first's transaction.
 *
 * A RECORD WRITTEN ELSEWHERE (a task: the task-workflow service writes it, outside this database transaction). No
 * connection and no lock is held across that call. Instead (see lib/record-workflow-server.ts and upsert_todo):
 *   a. `openRecordWorkflow` in a short transaction (lock, read, step rules), then the checks with no transaction held;
 *   b. `reserveRecordMove` in a second short transaction: under the lock, the record and its instance are read again and
 *      must be what (a) read (else a 409 that changes nothing); the move is recorded on the instance as a pending move
 *      (`record_move`: its id, from, to, step, comment, evidence), saved;
 *   c. the service's write, with nothing held;
 *   d. `settleRecordMove` in a third short transaction: under the lock, the record's ACTUAL state decides: it reached the
 *      move's target (the service took it) → the step changes as it was checked; it stayed where it was (the service
 *      refused, failed, or timed out without writing) → released, nothing changes. Whatever the service answered, the
 *      instance follows the record. If (d) itself fails, the reservation stays on the instance and the next read of the
 *      record settles it the same way (`openRecordWorkflow`, once it is older than RECORD_MOVE_FRESH_MS); a second
 *      mover meanwhile is answered 409 (`workflow_busy`), never checked against a step that is about to change.
 *
 * A RECORD MOVED WITHOUT THE ENGINE (a period's rollover, a system move): the instance remembers the record state it
 * was last brought in line with (`record_state`); when the record is found elsewhere, its steps are re-synced from
 * `workflow_states` before anything is checked, so a stale step never refuses a move.
 *
 * An area whose lifecycle names no workflow, or whose enforce is "off", never comes here: `openRecordWorkflow` answers
 * null without a statement, and nothing else is read or written.
 *
 * Server-only (it imports the schema).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { entityActivity, orgMembers, peopleRoster } from "../agent/lib/db/schema.ts";
import { RECORD_AREAS, type RecordAreaId } from "../agent/lib/record-areas.generated.ts";
import { areaView, type AreaRow, type AreaView, type RecordAreas } from "../agent/lib/record-areas.ts";
import { enteredSuffix, spellingsOf, storedStateOf, type MoveCheck, type WorkflowGate } from "../agent/lib/record-lifecycle.ts";
import { identitySnapshot } from "../agent/lib/people-directory.ts";
import { RECORD_WORKFLOWS } from "./record-workflows.generated.ts";
import { RecordWorkflowConflict, RecordWorkflowStore, isRecordWorkflowConflict, withRecordData, type ScopedDb } from "./record-workflow-store.ts";
import { randomUUID } from "node:crypto";
import { scheduleStepActions, type StepActionRunner } from "./record-workflow-actions.ts";
import {
  administrativeOf,
  applyStepMove,
  changeStepDueDate,
  changeStepHolders,
  eligibleHolders,
  extensionOf,
  engineDirectory,
  followRecord,
  RecordWorkflowRefused,
  recordData,
  recordMoveOf,
  recordStateOf,
  moveBasisOf,
  recordWorkflowLockKey,
  stepActionsOf,
  resyncInstance,
  seedInstance,
  setRecordMove,
  setRecordState,
  settleRecordMove,
  stepGate,
  workflowBindingOf,
  type StepChangeResult,
  type WorkflowBinding,
  type WorkflowDSL,
  type WorkflowInstance,
} from "./record-workflow-runtime.ts";

export { RecordWorkflowConflict, RecordWorkflowRefused, isRecordWorkflowConflict };
export type { ScopedDb, StepActionRunner };

/**
 * The step actions a saved instance holds undelivered (lib/record-workflow-actions.ts): delivered once the door's
 * transaction commits. `deliver` is the door's own runner (withOrgRls, withOrgDb); without one the sweep delivers them.
 */
function deliverAfterCommit(instance: WorkflowInstance | null | undefined, orgId: string, areaId: RecordAreaId, deliver: StepActionRunner | undefined): void {
  if (!deliver || !instance || !stepActionsOf(instance).some((a) => a.delivery.status === "pending")) return;
  scheduleStepActions(orgId, areaId, instance.object.id, deliver);
}

/** The activity feed's entity type of each area (agent/lib/record-lifecycle-store.ts ActivityEntityType). */
const FEED_TYPE: Record<RecordAreaId, string> = { tasks: "task", periods: "cycle", deployments: "deployment", implementations: "implementation" };

/** How long a reserved move is its mover's to settle; older, the next read settles it by the record's state. */
export const RECORD_MOVE_FRESH_MS = 120_000;
/**
 * How long a door waits for the service that writes the record (tasks), at most: well under RECORD_MOVE_FRESH_MS.
 * RECORD_WORKFLOW_SERVICE_TIMEOUT_MS (.env.example) lowers it, never past the fresh window.
 */
export const RECORD_SERVICE_TIMEOUT_MS = Math.min(Number(process.env.RECORD_WORKFLOW_SERVICE_TIMEOUT_MS) > 0 ? Number(process.env.RECORD_WORKFLOW_SERVICE_TIMEOUT_MS) : 30_000, RECORD_MOVE_FRESH_MS / 2);

/** Does this area's lifecycle run a workflow (and is it enforced)? Only then does a door open a session. */
export function recordWorkflowBound(areaId: RecordAreaId, areas: RecordAreas = RECORD_AREAS, workflows: Record<string, unknown> = RECORD_WORKFLOWS): boolean {
  return workflowBindingOf(areaId, areas, workflows) !== null;
}

/**
 * The ONE key a record's workflow instance is stored under, from the record's own columns (never from a request): a
 * task's and a period's `id`; an implementation's `implementationId` (the table's key with the workspace); a
 * deployment's account and id (the table's key with the workspace), each part URI-encoded so the pair is unambiguous.
 * null when the row does not carry them.
 */
export function workflowRecordKey(areaId: RecordAreaId, row: Record<string, unknown> | null | undefined): string | null {
  if (!row) return null;
  const text = (k: string) => (typeof row[k] === "string" && (row[k] as string) ? (row[k] as string) : null);
  if (areaId === "deployments") {
    const c = text("customerId");
    const d = text("deploymentId");
    return c && d ? `${encodeURIComponent(c)}/${encodeURIComponent(d)}` : null;
  }
  if (areaId === "implementations") return text("implementationId");
  return text("id");
}

/** Take the record's workflow lock (until the transaction ends). A door takes it BEFORE it reads the record. */
export async function lockRecordWorkflow(tx: ScopedDb, orgId: string, areaId: RecordAreaId, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${recordWorkflowLockKey(orgId, areaId, key)}))`);
}

/**
 * Lock, then read: `read` once to learn the record's own key (or `expected`, the key a create will have), the lock on
 * it, then `read` again, so what the door checks is the record as it is now. Returns the row (or null) and its key.
 */
export async function lockedRead<T extends Record<string, unknown>>(
  tx: ScopedDb,
  orgId: string,
  areaId: RecordAreaId,
  read: () => Promise<T | null | undefined>,
  expected: string | null = null,
): Promise<{ row: T | null; key: string | null }> {
  if (expected) await lockRecordWorkflow(tx, orgId, areaId, expected);
  const first = (await read()) ?? null;
  const key = workflowRecordKey(areaId, first) ?? expected;
  if (key && key !== expected) await lockRecordWorkflow(tx, orgId, areaId, key);
  return { row: key ? ((await read()) ?? null) : first, key };
}

/** What a door carries from `openRecordWorkflow` to `commitRecordWorkflow`, in one transaction. */
export interface RecordWorkflowSession {
  binding: WorkflowBinding;
  v: AreaView;
  orgId: string;
  /** The door's transaction (the one the record is written in). */
  tx: ScopedDb;
  store: RecordWorkflowStore;
  directory: ReturnType<typeof engineDirectory>["directory"];
  rbac: ReturnType<typeof engineDirectory>["rbac"];
  /** The rules the instance runs on: its pinned copy when stored, else the deployment's current document. */
  dsl: WorkflowDSL;
  /** The record's instance as read (stored), or seeded in memory (not stored yet); null when the workflow is not this record's. */
  instance: WorkflowInstance | null;
  stored: boolean;
  /** The stored revision read (0 when not stored). */
  revision: number;
  /**
   * What a move depends on in the stored instance as read (`moveBasisOf`; "" when not stored): a record written
   * elsewhere compares it, not the revision, between its check and its reservation, so a step action's delivery (which
   * saves the instance) never refuses a move.
   */
  basis: string;
  /** A move another mover reserved and has not settled yet (fresh): this session may not move the record. */
  busy: boolean;
  /** The stored instance changed on reading it (a stale reservation settled, a record moved elsewhere re-synced): a read saves it. */
  dirty: boolean;
  /** The record's state as read (the rules' reading of it). */
  state: string | null;
  actor: string;
  comment: string | null;
  evidence: string | null;
  now: Date;
  /** The step rules for the validator (agent/lib/record-lifecycle.ts WorkflowGate); undefined when there is no instance. */
  gate: WorkflowGate | undefined;
}

/** The workspace's people as the engine's directory: its roster and its signed-in people, under its row-level security. */
async function directoryOf(tx: ScopedDb, orgId: string) {
  const roster = await tx
    .select({ orgId: peopleRoster.orgId, email: peopleRoster.email, name: peopleRoster.name, managerEmail: peopleRoster.managerEmail, departments: peopleRoster.departments, attributes: peopleRoster.attributes, archivedAt: peopleRoster.archivedAt })
    .from(peopleRoster)
    .where(eq(peopleRoster.orgId, orgId));
  const members = await tx.select({ orgId: orgMembers.orgId, email: orgMembers.email, role: orgMembers.role }).from(orgMembers).where(eq(orgMembers.orgId, orgId));
  return engineDirectory(identitySnapshot(orgId, roster, members));
}

/**
 * When the record entered `state`: the feed's latest move line INTO it (any spelling the definition reads as it); with
 * none, the record's own last change. A later line of another kind (a field edit) is never taken for it.
 */
async function enteredAt(tx: ScopedDb, orgId: string, areaId: RecordAreaId, feedId: string, v: AreaView, before: AreaRow, state: string): Promise<Date | null> {
  const lc = v.lifecycle!;
  const suffixes = spellingsOf(v, state).map(enteredSuffix);
  const [moved] = await tx
    .select({ at: entityActivity.createdAt })
    .from(entityActivity)
    .where(and(
      eq(entityActivity.orgId, orgId),
      eq(entityActivity.entityType, FEED_TYPE[areaId]),
      eq(entityActivity.entityId, feedId),
      sql`strpos(${entityActivity.event}, ${`[${lc.field}: `}) > 0`,
      sql`(${sql.join(suffixes.map((s) => sql`right(${entityActivity.event}, ${s.length}) = ${s}`), sql` or `)})`,
    ))
    .orderBy(desc(entityActivity.createdAt))
    .limit(1);
  if (moved?.at) return new Date(moved.at);
  for (const k of ["updatedAt", "createdAt"]) {
    const x = before[k];
    if (x instanceof Date || typeof x === "string") return new Date(x);
  }
  return null;
}

/**
 * Step 1 (see the file's header): the record's workflow and the step rules for this caller, or null when the area runs
 * none (nothing read). `entityId`: the record's key (`workflowRecordKey`), with `before` the stored record read AFTER
 * the lock (`lockedRead`); both null for a create. `feedId`: the record's id in the activity feed (four eyes and the
 * migrated steps' dates read it; default the key). `comment` is the move's comment (`reason`), `evidence` the evidence
 * the request sends with it. A reserved move older than RECORD_MOVE_FRESH_MS is settled here by the record's state, and
 * a record that moved without the engine is re-synced (both saved with the next save).
 */
export async function openRecordWorkflow(
  tx: ScopedDb,
  orgId: string,
  areaId: RecordAreaId,
  input: { entityId: string | null; feedId?: string | null; before: AreaRow | null; actor: string; comment?: string | null; evidence?: string | null; now?: Date },
  opts: { areas?: RecordAreas; workflows?: Record<string, unknown> } = {},
): Promise<RecordWorkflowSession | null> {
  const areas = opts.areas ?? RECORD_AREAS;
  const workflows = opts.workflows ?? RECORD_WORKFLOWS;
  const binding = workflowBindingOf(areaId, areas, workflows);
  if (!binding) return null;
  const v = areaView(areaId, areas);
  const now = input.now ?? new Date();
  const actor = input.actor.trim().toLowerCase();
  const store = new RecordWorkflowStore(tx, orgId, { definitions: workflows as Record<string, WorkflowDSL> });
  if (input.entityId) await lockRecordWorkflow(tx, orgId, areaId, input.entityId);
  const { directory, rbac } = await directoryOf(tx, orgId);
  let dsl = binding.dsl;
  let instance: WorkflowInstance | null = null;
  let stored = false;
  let revision = 0;
  let basis = "";
  let busy = false;
  let dirty = false;
  const state = input.before ? storedStateOf(v, input.before) : null;
  if (input.entityId && input.before) {
    const found = await store.getByEntity(areaId, input.entityId, binding.workflowId);
    if (found) {
      const pinned = await store.getDefinition(found.id);
      if (pinned) dsl = pinned.definition;
      instance = withRecordData(found, recordData(v, input.before));
      stored = true;
      revision = found.revision;
      basis = moveBasisOf(found);
      const pending = recordMoveOf(instance);
      if (pending && now.getTime() - Date.parse(pending.at) < RECORD_MOVE_FRESH_MS) busy = true;
      else if (pending) dirty = (await settleRecordMove({ binding, dsl, instance, directory, rbac, state, now })) !== "none";
      // Moved without the engine since it was last brought in line (a rollover, a system move): re-synced first.
      if (!busy && recordStateOf(instance) !== undefined && recordStateOf(instance) !== state) dirty = resyncInstance({ binding, dsl, instance, state, actor, now }) || dirty;
      // The record's own values changed since the instance last followed them (an edit that moved nothing, an import):
      // they are followed before anything is checked. By "system": whoever reads it now did not make that edit.
      if (!busy) dirty = followRecord({ binding, dsl, instance, directory, rbac, actor: "system", now }) || dirty;
    } else {
      // Attached lazily: the record's first move since its lifecycle runs the workflow. Its steps start where its
      // stored state (read under whichever key and spelling the row holds it) says they stand.
      const at = state === null ? null : await enteredAt(tx, orgId, areaId, input.feedId ?? input.entityId, v, input.before, state);
      instance = seedInstance({ binding, orgId, entity: { type: areaId, id: input.entityId }, state, data: recordData(v, input.before), directory, actor, createdBy: typeof input.before.createdBy === "string" ? input.before.createdBy : null, now, enteredAt: at });
    }
  } else {
    // A create: its instance is attached with the record, from the state every record starts in; its id is the record's
    // once it has one (commitRecordWorkflow).
    instance = seedInstance({ binding, orgId, entity: { type: areaId, id: input.entityId ?? "" }, state: v.lifecycle?.initial ?? null, data: {}, directory, actor, createdBy: actor, now });
  }
  const comment = typeof input.comment === "string" ? input.comment : null;
  const evidence = typeof input.evidence === "string" ? input.evidence : null;
  const gate = instance ? stepGate({ dsl, instance, directory, rbac, actor, comment, evidence }) : undefined;
  return { binding, v, orgId, tx, store, directory, rbac, dsl, instance, stored, revision, basis, busy, dirty, state, actor, comment, evidence, now, gate };
}

/** A move refused because another mover's reserved move is not settled yet (a 409 that changes nothing). */
export class RecordWorkflowBusy extends Error {
  constructor() {
    super("record workflow: another move of this record is being made");
    this.name = "RecordWorkflowBusy";
  }
}

/**
 * Step 2 (see the file's header), in the transaction the record was just written in. `entityId`: the record's key
 * (`workflowRecordKey` of the row written); `created`: the write made the record; `check`: the move it made (the
 * validator's `lifecycle`), or null for a write that moved nothing; `after`: the record as written. Attaches the
 * instance (a create, or the first move since the binding), applies the move's step change (a move that names no step
 * brings the steps in line with the record's new state, `workflow_states`), and saves. Throws
 * RecordWorkflowConflict on a stale revision (the caller's transaction must roll back), RecordWorkflowBusy when another
 * mover's reserved move is pending, and RecordWorkflowRefused for a workflow that would queue what this phase does not
 * run. Returns the instance saved, or null when nothing was (not a move, or the workflow is not this record's).
 */
export async function commitRecordWorkflow(
  session: RecordWorkflowSession,
  input: { entityId: string; created: boolean; check: MoveCheck | null; after: AreaRow; deliver?: StepActionRunner },
): Promise<WorkflowInstance | null> {
  const { v, binding, store, directory, rbac, dsl, now } = session;
  if (!input.created && !input.check) return followRecordEdit(session, input);
  if (session.busy) throw new RecordWorkflowBusy();
  let instance = session.instance;
  if (!instance) return null;
  const step = input.check?.transition?.step ?? null;
  const data = recordData(v, input.after);
  const after = storedStateOf(v, input.after) ?? input.check?.to ?? v.lifecycle?.initial ?? null;
  if (!session.stored && (!step || input.created)) {
    // Not stored yet and no step to change from where it was seeded: it starts where the record now is.
    const reseeded = step && input.created ? instance : seedInstance({ binding, orgId: session.orgId, entity: { type: binding.areaId, id: input.entityId }, state: after, data, directory, actor: session.actor, createdBy: session.actor, now });
    if (!reseeded) return null;
    instance = reseeded;
  }
  instance.object = { ...instance.object, id: input.entityId };
  instance = withRecordData(instance, data);
  if (step) {
    await applyStepMove({ dsl, instance, directory, rbac, step, actor: session.actor, comment: session.comment, evidence: session.evidence, now, administrative: administrativeOf(input.check) });
  } else if (input.check) {
    // A move that names no step (a board drag, a done toggle, a move outside the transitions under "warn"): the steps
    // follow the record to its new state (`workflow_states`), as provisioning rows, so the next move is checked from
    // where the record now is. Nothing for a stored instance already there, or one just seeded at it.
    resyncInstance({ binding, dsl, instance, state: after, actor: session.actor, now, byMove: true });
  }
  // The record as written: its anchored due dates follow its values (a move may change them too).
  followRecord({ binding, dsl, instance, directory, rbac, actor: session.actor, now });
  setRecordState(instance, after);
  // An instance stored for the first time (a create: no lock was taken before the record had its key) is saved under
  // the record's lock, held to the end of this transaction, so its delivery's claim waits for the commit.
  if (!session.stored) await lockRecordWorkflow(session.tx, session.orgId, binding.areaId, input.entityId);
  const saved = session.stored ? await store.update(instance) : await store.create(instance, dsl);
  if (!saved.ok) throw saved.conflict;
  deliverAfterCommit(saved.instance, session.orgId, binding.areaId, input.deliver);
  return saved.instance;
}

/**
 * A write that moved nothing (an edit of the record's values), in its own transaction after the record is written: a
 * stored instance follows the record as written (followRecord: its anchored due dates), and is saved when that, or the
 * read in step 1 (a re-sync, a settled reservation), changed it. Nothing for an instance not stored yet (it is attached
 * from the record's values on its first move or read) or while another mover's move is pending (it follows on the
 * next read). Returns the instance saved, or null.
 */
async function followRecordEdit(session: RecordWorkflowSession, input: { entityId: string; after: AreaRow; deliver?: StepActionRunner }): Promise<WorkflowInstance | null> {
  const { v, binding, store, directory, rbac, dsl, now } = session;
  if (session.busy || !session.stored || !session.instance) return null;
  const instance = withRecordData(session.instance, recordData(v, input.after));
  const followed = followRecord({ binding, dsl, instance, directory, rbac, actor: session.actor, now });
  if (!followed && !session.dirty) return null;
  const saved = await store.update(instance);
  if (!saved.ok) throw saved.conflict;
  deliverAfterCommit(saved.instance, session.orgId, binding.areaId, input.deliver);
  return saved.instance;
}

/**
 * A record written ELSEWHERE by a write that moved nothing (a task's edit through the task-workflow service), in its
 * own short transaction once the write is made: under the record's workflow lock, the record as it is now and its
 * stored instance (openRecordWorkflow, which follows the record's values), saved when they changed it. Nothing for a
 * record whose instance was never stored. Returns whether it saved.
 */
export async function followRecordWrite(
  tx: ScopedDb,
  orgId: string,
  areaId: RecordAreaId,
  input: { entityId: string; actor: string; readRecord: () => Promise<AreaRow | null>; now?: Date; deliver?: StepActionRunner },
  opts: { areas?: RecordAreas; workflows?: Record<string, unknown> } = {},
): Promise<boolean> {
  const { row } = await lockedRead(tx, orgId, areaId, input.readRecord, input.entityId);
  if (!row) return false;
  const session = await openRecordWorkflow(tx, orgId, areaId, { entityId: input.entityId, before: row, actor: input.actor, now: input.now }, opts);
  if (!session?.instance || !session.stored || session.busy || !session.dirty) return false;
  const saved = await session.store.update(session.instance);
  if (!saved.ok) throw saved.conflict;
  deliverAfterCommit(saved.instance, orgId, areaId, input.deliver);
  return true;
}

/** What `reserveRecordMove` reserved: the move's id (null when the write moves nothing). */
export interface ReservedMove {
  id: string | null;
}

/**
 * Step (b) of a record written elsewhere (see the file's header), in its own short transaction. `opened` is the
 * session (a) read; `readRecord` reads the record on this transaction. Under the lock, the record and its instance must
 * be what (a) read: the same state, the same workflow as a move reads it (`basis`: its steps, its record state, its
 * reserved move, its fired actions; a step action's delivery, which moves the revision on, changes none of it), no other
 * move pending; otherwise RecordWorkflowConflict (or RecordWorkflowBusy), and nothing is written. Then the move is recorded on the instance as pending and saved (an
 * instance not stored yet is attached with it).
 */
export async function reserveRecordMove(
  tx: ScopedDb,
  opened: RecordWorkflowSession,
  input: { entityId: string; check: MoveCheck | null; readRecord: () => Promise<AreaRow | null>; deliver?: StepActionRunner },
  opts: { areas?: RecordAreas; workflows?: Record<string, unknown> } = {},
): Promise<ReservedMove> {
  const check = input.check;
  if (!check) return { id: null };
  if (opened.busy) throw new RecordWorkflowBusy();
  const { row: before } = await lockedRead(tx, opened.orgId, opened.binding.areaId, input.readRecord, input.entityId);
  const now = new Date();
  const session = await openRecordWorkflow(tx, opened.orgId, opened.binding.areaId, { entityId: input.entityId, before, actor: opened.actor, comment: opened.comment, evidence: opened.evidence, now }, opts);
  if (!session || !session.instance) return { id: null };
  if (session.busy) throw new RecordWorkflowBusy();
  // Who holds each step, as each read followed the record: an edit of the record between the check and now (its
  // reviewer changed) may have moved a step to someone else, and the move was checked against the former holder.
  const holders = (i: WorkflowInstance | null) => JSON.stringify((i?.steps ?? []).map((s) => [s.id, s.assignee, s.due_on ?? null]));
  if (session.state !== opened.state || session.stored !== opened.stored || session.basis !== opened.basis || holders(session.instance) !== holders(opened.instance)) {
    throw new RecordWorkflowConflict("stale_revision", session.instance.id, opened.revision, session.revision, `the record or its workflow changed since the move was checked (state "${opened.state}" → "${session.state}", revision ${opened.revision} → ${session.revision})`);
  }
  const step = check.transition?.step ?? null;
  const id = randomUUID();
  setRecordMove(session.instance, { id, from: check.from, to: check.to, step, actor: session.actor, comment: session.comment, evidence: session.evidence, administrative: administrativeOf(check), at: now.toISOString() });
  const saved = session.stored ? await session.store.update(session.instance) : await session.store.create(session.instance, session.dsl);
  if (!saved.ok) throw saved.conflict;
  // Settling another mover's stale reservation (openRecordWorkflow) may have fired actions: delivered after this commit.
  deliverAfterCommit(saved.instance, opened.orgId, opened.binding.areaId, input.deliver);
  return { id };
}

/**
 * Step (d) of a record written elsewhere, in its own short transaction: under the lock, the record's ACTUAL state
 * settles the reserved move `moveId` (applied: the record reached its target; released: it stayed; resynced: it is
 * elsewhere). "gone": the move is no longer pending on the instance (the next read settled it already).
 */
export async function settleReservedMove(
  tx: ScopedDb,
  orgId: string,
  areaId: RecordAreaId,
  input: { entityId: string; moveId: string; readRecord: () => Promise<AreaRow | null>; now?: Date; deliver?: StepActionRunner },
  opts: { areas?: RecordAreas; workflows?: Record<string, unknown> } = {},
): Promise<{ outcome: "applied" | "released" | "resynced" | "gone"; state: string | null }> {
  const areas = opts.areas ?? RECORD_AREAS;
  const workflows = opts.workflows ?? RECORD_WORKFLOWS;
  const binding = workflowBindingOf(areaId, areas, workflows);
  const v = areaView(areaId, areas);
  const { row } = await lockedRead(tx, orgId, areaId, input.readRecord, input.entityId);
  const state = row ? storedStateOf(v, row) : null;
  if (!binding) return { outcome: "gone", state };
  const store = new RecordWorkflowStore(tx, orgId, { definitions: workflows as Record<string, WorkflowDSL> });
  const found = await store.getByEntity(areaId, input.entityId, binding.workflowId);
  if (!found || recordMoveOf(found)?.id !== input.moveId) return { outcome: "gone", state };
  const pinned = await store.getDefinition(found.id);
  const dsl = pinned?.definition ?? binding.dsl;
  const { directory, rbac } = await directoryOf(tx, orgId);
  const instance = withRecordData(found, recordData(v, row));
  const now = input.now ?? new Date();
  const mover = recordMoveOf(found)!.actor;
  const outcome = await settleRecordMove({ binding, dsl, instance, directory, rbac, state, now });
  // The record as the service wrote it: its anchored due dates follow its values (the write may have changed them).
  followRecord({ binding, dsl, instance, directory, rbac, actor: mover, now });
  const saved = await store.update(instance);
  if (!saved.ok) throw saved.conflict;
  deliverAfterCommit(saved.instance, orgId, areaId, input.deliver);
  return { outcome: outcome === "none" ? "gone" : outcome, state };
}

/**
 * A record created elsewhere (a task the service made): its instance attached once the record exists, in its own short
 * transaction, at the state the record is in (and its step changed when it was created by a move that names one).
 */
export async function attachCreatedRecord(
  tx: ScopedDb,
  orgId: string,
  areaId: RecordAreaId,
  input: { entityId: string; actor: string; check: MoveCheck | null; comment?: string | null; evidence?: string | null; readRecord: () => Promise<AreaRow | null>; deliver?: StepActionRunner },
  opts: { areas?: RecordAreas; workflows?: Record<string, unknown> } = {},
): Promise<WorkflowInstance | null> {
  const { row } = await lockedRead(tx, orgId, areaId, input.readRecord, input.entityId);
  if (!row) return null;
  const session = await openRecordWorkflow(tx, orgId, areaId, { entityId: null, before: null, actor: input.actor, comment: input.comment, evidence: input.evidence }, opts);
  if (!session) return null;
  const existing = await session.store.getByEntity(areaId, input.entityId, session.binding.workflowId);
  if (existing) return existing;
  return commitRecordWorkflow(session, { entityId: input.entityId, created: true, check: input.check, after: row, deliver: input.deliver });
}

/** The 409 a door answers when the record's workflow changed under the move (nothing was written). */
export function workflowConflictBody(noun: string, conflict: RecordWorkflowConflict) {
  const error = `This ${noun} was moved by someone else while you were moving it, so nothing was written. Read it again and try once more.`;
  return { error, errors: [error], code: "workflow_conflict" as const, reason: conflict.reason };
}

/**
 * The `evidence` a request sends with a move, taken out of its body (a door of an area that runs a workflow only; every
 * other door passes `evidence` to the validator, which refuses it as no field, as before).
 */
export function takeEvidence(body: Record<string, unknown>): { body: Record<string, unknown>; evidence: string | null } {
  if (!("evidence" in body)) return { body, evidence: null };
  const { evidence, ...rest } = body;
  return { body: rest, evidence: typeof evidence === "string" ? evidence : null };
}

/**
 * A write the record's workflow stopped, thrown out of the door's transaction (so nothing of it was kept): the status
 * and body to answer with (409), or null for any other error. The agent's tools throw `body.error`.
 */
export function workflowRefusal(e: unknown, noun: string): { status: 409; body: { error: string; errors: string[]; code: "workflow_conflict" | "workflow_refused" | "workflow_busy"; reason?: string } } | null {
  if (isRecordWorkflowConflict(e)) return { status: 409, body: workflowConflictBody(noun, e) };
  if (e instanceof RecordWorkflowBusy) {
    const error = `This ${noun} is being moved by someone else right now, so nothing was written. Try again in a moment.`;
    return { status: 409, body: { error, errors: [error], code: "workflow_busy" } };
  }
  if (e instanceof RecordWorkflowRefused) return { status: 409, body: { error: e.message, errors: [e.message], code: "workflow_refused" } };
  return null;
}

// ── reading a record's workflow, changing a step's holder or due date (phase 7) ────────────────────────────────────

/**
 * A record's workflow as it stands, for the screens and the agent's tools, in the caller's workspace-scoped transaction,
 * under the record's workflow lock: its instance read; a stale reservation settled and a record moved without the
 * engine (a rollover, an import, a system move) RE-SYNCED, and saved, so what is read is always where the record really
 * is. A record whose instance was never attached (written before its lifecycle ran the workflow, or by an import) is
 * attached here, once, where it stands (as its first move would), so every later read shows the same steps, holders and
 * due dates rather than a fresh seeding each time. Step actions a save fired are delivered after the commit
 * (`deliver`; without one, the sweep delivers them). null when the area runs no workflow, or the workflow does not
 * apply to this record.
 */
export async function readRecordWorkflow(
  tx: ScopedDb,
  orgId: string,
  areaId: RecordAreaId,
  input: { entityId: string; feedId?: string | null; before: AreaRow; actor: string; now?: Date; deliver?: StepActionRunner },
  opts: { areas?: RecordAreas; workflows?: Record<string, unknown> } = {},
): Promise<{ session: RecordWorkflowSession; instance: WorkflowInstance } | null> {
  await lockRecordWorkflow(tx, orgId, areaId, input.entityId);
  const session = await openRecordWorkflow(tx, orgId, areaId, { entityId: input.entityId, feedId: input.feedId, before: input.before, actor: input.actor, now: input.now }, opts);
  if (!session?.instance) return null;
  let instance = session.instance;
  if (!session.stored || session.dirty) {
    if (!session.stored) instance.object = { ...instance.object, id: input.entityId };
    const saved = session.stored ? await session.store.update(instance) : await session.store.create(instance, session.dsl);
    if (!saved.ok) throw saved.conflict;
    instance = saved.instance;
    session.stored = true;
    session.revision = instance.revision;
    session.dirty = false;
    deliverAfterCommit(instance, orgId, areaId, input.deliver);
  }
  return { session, instance };
}

/** A person's change of one step that is not a move: who holds it, or its due date. */
export type StepChangeRequest = { kind: "holders"; stepId: string; holders: unknown } | { kind: "due_on"; stepId: string; dueOn: unknown };

/**
 * Change a step's holders or its due date (see changeStepHolders, changeStepDueDate in lib/record-workflow-runtime.ts),
 * in the caller's transaction, under the record's workflow lock: the step rules' refusal (nothing written), or the
 * change saved with its history (compare-and-swap; a stale revision throws RecordWorkflowConflict). A record whose
 * instance was never stored is attached with the change. Step actions the change fires are delivered after the commit.
 */
export async function changeRecordStep(
  tx: ScopedDb,
  orgId: string,
  areaId: RecordAreaId,
  input: { entityId: string; feedId?: string | null; before: AreaRow; actor: string; change: StepChangeRequest; deliver?: StepActionRunner; now?: Date },
  opts: { areas?: RecordAreas; workflows?: Record<string, unknown> } = {},
): Promise<{ result: StepChangeResult; instance: WorkflowInstance | null }> {
  const session = await openRecordWorkflow(tx, orgId, areaId, { entityId: input.entityId, feedId: input.feedId, before: input.before, actor: input.actor, now: input.now }, opts);
  if (!session?.instance) return { result: { ok: false, code: "INVALID_VALUE", status: 422, message: "This record runs no workflow." }, instance: null };
  if (session.busy) throw new RecordWorkflowBusy();
  const { dsl, directory, rbac, now } = session;
  let instance = withRecordData(session.instance, recordData(session.v, input.before));
  instance.object = { ...instance.object, id: input.entityId };
  const c = input.change;
  const result = c.kind === "holders"
    ? await changeStepHolders({ dsl, instance, directory, rbac, actor: session.actor, stepId: c.stepId, holders: c.holders, now })
    : await changeStepDueDate({ dsl, instance, directory, rbac, actor: session.actor, stepId: c.stepId, dueOn: c.dueOn, now });
  if (!result.ok) return { result, instance: null };
  if (!result.changed && !session.dirty) return { result, instance };
  setRecordState(instance, session.state);
  const saved = session.stored ? await session.store.update(instance) : await session.store.create(instance, dsl);
  if (!saved.ok) throw saved.conflict;
  instance = saved.instance;
  deliverAfterCommit(instance, orgId, areaId, input.deliver);
  return { result, instance };
}

/** Who a supervisor may put on each step (the step's rule, without its limit), and the steps whose due date extends. */
export function stepOptions(session: RecordWorkflowSession, instance: WorkflowInstance): { holders: Record<string, string[]>; extends: string[] } {
  const holders: Record<string, string[]> = {};
  for (const s of instance.steps) holders[s.id] = eligibleHolders({ dsl: session.dsl, instance, directory: session.directory, stepId: s.id });
  return { holders, extends: instance.steps.filter((s) => extensionOf(session.dsl, s.id)).map((s) => s.id) };
}

/**
 * The cards' view of many records at once (no history, no lock, nothing saved): each record's instance, re-synced in
 * memory to the state the record is in now (`states`: key -> the record's state as the rules read it) and, given the
 * record (`row`), following its values (followRecord), or, never attached, seeded in memory from it. Keyed by the
 * record key.
 */
export async function recordWorkflowSummaries(
  tx: ScopedDb,
  orgId: string,
  areaId: RecordAreaId,
  records: { key: string; state: string | null; row?: AreaRow | null }[],
  opts: { areas?: RecordAreas; workflows?: Record<string, unknown>; now?: Date } = {},
): Promise<{ instances: Map<string, WorkflowInstance>; directory: ReturnType<typeof engineDirectory>["directory"] } | null> {
  const areas = opts.areas ?? RECORD_AREAS;
  const workflows = opts.workflows ?? RECORD_WORKFLOWS;
  const binding = workflowBindingOf(areaId, areas, workflows);
  if (!binding) return null;
  const now = opts.now ?? new Date();
  const store = new RecordWorkflowStore(tx, orgId, { definitions: workflows as Record<string, WorkflowDSL> });
  const { directory, rbac } = await directoryOf(tx, orgId);
  const v = areaView(areaId, areas);
  const stored = (await store.listStepsForRecords(areaId, records.map((r) => r.key))).filter((i) => i.workflow_id === binding.workflowId);
  const byKey = new Map(stored.map((i) => [i.object.id, i]));
  const out = new Map<string, WorkflowInstance>();
  for (const r of records) {
    const found = byKey.get(r.key);
    if (found) {
      if (recordStateOf(found) !== undefined && recordStateOf(found) !== r.state && !recordMoveOf(found)) resyncInstance({ binding, dsl: binding.dsl, instance: found, state: r.state, actor: "system", now });
      if (r.row && !recordMoveOf(found)) {
        const read = withRecordData(found, recordData(v, r.row));
        followRecord({ binding, dsl: binding.dsl, instance: read, directory, rbac, actor: "system", now });
        out.set(r.key, read);
        continue;
      }
      out.set(r.key, found);
      continue;
    }
    const seeded = seedInstance({ binding, orgId, entity: { type: areaId, id: r.key }, state: r.state, data: r.row ? recordData(v, r.row) : {}, directory, actor: "system", now });
    if (seeded) out.set(r.key, seeded);
  }
  return { instances: out, directory };
}

/**
 * A record of a bound area moved by the system in this transaction (a period's rollover): its stored instance is
 * brought in line with it here, under its lock, as `provisioning` rows, so it is in step the moment the move commits
 * (the next read or move would re-sync it too). Nothing when the area runs no workflow or no instance is attached yet
 * (it is attached on the record's first move, where the record then stands).
 */
export async function resyncAfterSystemMove(
  tx: ScopedDb,
  orgId: string,
  areaId: RecordAreaId,
  input: { entityId: string; after: AreaRow; actor?: string; now?: Date },
  opts: { areas?: RecordAreas; workflows?: Record<string, unknown> } = {},
): Promise<boolean> {
  const areas = opts.areas ?? RECORD_AREAS;
  const workflows = opts.workflows ?? RECORD_WORKFLOWS;
  const binding = workflowBindingOf(areaId, areas, workflows);
  if (!binding) return false;
  await lockRecordWorkflow(tx, orgId, areaId, input.entityId);
  const store = new RecordWorkflowStore(tx, orgId, { definitions: workflows as Record<string, WorkflowDSL> });
  const found = await store.getByEntity(areaId, input.entityId, binding.workflowId);
  if (!found || recordMoveOf(found)) return false;
  const v = areaView(areaId, areas);
  const state = storedStateOf(v, input.after);
  const pinned = await store.getDefinition(found.id);
  if (!resyncInstance({ binding, dsl: pinned?.definition ?? binding.dsl, instance: found, state, actor: input.actor ?? "system", now: input.now ?? new Date() })) return false;
  const saved = await store.update(found);
  if (!saved.ok) throw saved.conflict;
  return true;
}

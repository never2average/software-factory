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
import {
  administrativeOf,
  applyStepMove,
  engineDirectory,
  RecordWorkflowRefused,
  recordData,
  recordMoveOf,
  recordStateOf,
  resyncInstance,
  seedInstance,
  setRecordMove,
  setRecordState,
  settleRecordMove,
  stepGate,
  workflowBindingOf,
  type WorkflowBinding,
  type WorkflowDSL,
  type WorkflowInstance,
} from "./record-workflow-runtime.ts";

export { RecordWorkflowConflict, RecordWorkflowRefused, isRecordWorkflowConflict };

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
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`record_workflow:${orgId}:${areaId}:${key}`}))`);
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
  /** A move another mover reserved and has not settled yet (fresh): this session may not move the record. */
  busy: boolean;
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
  let busy = false;
  const state = input.before ? storedStateOf(v, input.before) : null;
  if (input.entityId && input.before) {
    const found = await store.getByEntity(areaId, input.entityId, binding.workflowId);
    if (found) {
      const pinned = await store.getDefinition(found.id);
      if (pinned) dsl = pinned.definition;
      instance = withRecordData(found, recordData(v, input.before));
      stored = true;
      revision = found.revision;
      const pending = recordMoveOf(instance);
      if (pending && now.getTime() - Date.parse(pending.at) < RECORD_MOVE_FRESH_MS) busy = true;
      else if (pending) await settleRecordMove({ binding, dsl, instance, directory, rbac, state, now });
      // Moved without the engine since it was last brought in line (a rollover, a system move): re-synced first.
      if (!busy && recordStateOf(instance) !== undefined && recordStateOf(instance) !== state) resyncInstance({ binding, dsl, instance, state, actor, now });
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
  return { binding, v, orgId, store, directory, rbac, dsl, instance, stored, revision, busy, state, actor, comment, evidence, now, gate };
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
 * instance (a create, or the first move since the binding), applies the move's step change, and saves. Throws
 * RecordWorkflowConflict on a stale revision (the caller's transaction must roll back), RecordWorkflowBusy when another
 * mover's reserved move is pending, and RecordWorkflowRefused for a workflow that would queue what this phase does not
 * run. Returns the instance saved, or null when nothing was (not a move, or the workflow is not this record's).
 */
export async function commitRecordWorkflow(
  session: RecordWorkflowSession,
  input: { entityId: string; created: boolean; check: MoveCheck | null; after: AreaRow },
): Promise<WorkflowInstance | null> {
  const { v, binding, store, directory, rbac, dsl, now } = session;
  if (!input.created && !input.check) return null;
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
  }
  setRecordState(instance, after);
  const saved = session.stored ? await store.update(instance) : await store.create(instance, dsl);
  if (!saved.ok) throw saved.conflict;
  return saved.instance;
}

/** What `reserveRecordMove` reserved: the move's id (null when the write moves nothing). */
export interface ReservedMove {
  id: string | null;
}

/**
 * Step (b) of a record written elsewhere (see the file's header), in its own short transaction. `opened` is the
 * session (a) read; `readRecord` reads the record on this transaction. Under the lock, the record and its instance must
 * be what (a) read: the same state, the same revision, no other move pending; otherwise RecordWorkflowConflict (or
 * RecordWorkflowBusy), and nothing is written. Then the move is recorded on the instance as pending and saved (an
 * instance not stored yet is attached with it).
 */
export async function reserveRecordMove(
  tx: ScopedDb,
  opened: RecordWorkflowSession,
  input: { entityId: string; check: MoveCheck | null; readRecord: () => Promise<AreaRow | null> },
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
  if (session.state !== opened.state || session.stored !== opened.stored || session.revision !== opened.revision) {
    throw new RecordWorkflowConflict("stale_revision", session.instance.id, opened.revision, session.revision, `the record or its workflow changed since the move was checked (state "${opened.state}" → "${session.state}", revision ${opened.revision} → ${session.revision})`);
  }
  const step = check.transition?.step ?? null;
  const id = randomUUID();
  setRecordMove(session.instance, { id, from: check.from, to: check.to, step, actor: session.actor, comment: session.comment, evidence: session.evidence, administrative: administrativeOf(check), at: now.toISOString() });
  const saved = session.stored ? await session.store.update(session.instance) : await session.store.create(session.instance, session.dsl);
  if (!saved.ok) throw saved.conflict;
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
  input: { entityId: string; moveId: string; readRecord: () => Promise<AreaRow | null>; now?: Date },
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
  const outcome = await settleRecordMove({ binding, dsl, instance, directory, rbac, state, now: input.now ?? new Date() });
  const saved = await store.update(instance);
  if (!saved.ok) throw saved.conflict;
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
  input: { entityId: string; actor: string; check: MoveCheck | null; comment?: string | null; evidence?: string | null; readRecord: () => Promise<AreaRow | null> },
  opts: { areas?: RecordAreas; workflows?: Record<string, unknown> } = {},
): Promise<WorkflowInstance | null> {
  const { row } = await lockedRead(tx, orgId, areaId, input.readRecord, input.entityId);
  if (!row) return null;
  const session = await openRecordWorkflow(tx, orgId, areaId, { entityId: null, before: null, actor: input.actor, comment: input.comment, evidence: input.evidence }, opts);
  if (!session) return null;
  const existing = await session.store.getByEntity(areaId, input.entityId, session.binding.workflowId);
  if (existing) return existing;
  return commitRecordWorkflow(session, { entityId: input.entityId, created: true, check: input.check, after: row });
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
